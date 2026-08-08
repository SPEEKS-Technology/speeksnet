import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];

// Stores overseen by a Multi-Store Manager. Mirrors MULTISTORE_MANAGER_STORES in speeks.js.
const MULTISTORE_MANAGER_STORES = ["BAL", "MPL"];
// The MSM splits time across their stores and isn't really listing, so they don't
// count as a full person (±20) on either store's ladder — instead each store they
// cover gets this flat boost. NOTE: this only affects the SUGGESTED number now.
// Once the DM types a goal, their figure is the whole goal, boost included.
const MSM_TARGET_BOOST = 15;

// Suggested weekly target: +/-20 per person, anchored at 4 people = 190.
// (2->150, 3->170, 4->190, 5->210, 6->230), floored at 150.
//
// This used to BE the goal. It is now only the prefill the DM sees the first time
// a store has never had a week set — they set the real number by hand every Monday.
// Nothing raises or lowers a target automatically any more.
function baseForSize(size: number) { return Math.max(150, 110 + 20 * size); }

// Today's calendar date in STORE time, not UTC. The edge runtime is UTC, so a
// naive new Date() rolls the day over at 7pm Central and would start the new
// goal week on Sunday evening. Same class of bug as the checklist midnight reset.
function centralToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

// The Monday that starts the week containing a YYYY-MM-DD date.
// Sunday maps BACK to the Monday just gone, matching the KPI week (ends Sunday).
function mondayOf(ds: string): string {
  const d = new Date(ds + "T00:00:00Z");
  const back = (d.getUTCDay() + 6) % 7; // Mon->0, Tue->1 ... Sun->6
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().split("T")[0];
}

// Monday that starts the NEXT week. Added staff take effect here so a mid-week
// hire's training days aren't counted against the goal.
function nextMonday(ds: string): string {
  const d = new Date(ds + "T00:00:00Z");
  const add = ((8 - d.getUTCDay()) % 7) || 7; // strictly-future Monday
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().split("T")[0];
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const url = new URL(req.url);
  const todayStr = centralToday();
  const thisMonday = mondayOf(todayStr);

  // Live roster COUNT for a store (excludes CEO / District Manager / Multi-Store
  // Manager — the MSM contributes via the flat MSM_TARGET_BOOST instead).
  async function rosterCount(store: string) {
    const { data } = await supabase.from("users").select("role").eq("store", store);
    // 'store' is the shop-floor board account — a TV, not a head. Counted here it
    // would add a person to team_size and move the suggested target by a full
    // ±20 listings (see baseForSize). Mirrors storeRosterSize/userInStore.
    const excl = new Set(["ceo", "district manager", "multi-store manager", "store"]);
    return (data || []).filter((u: any) => !excl.has(String(u.role || "").toLowerCase().trim())).length;
  }

  async function msmBoost(store: string) {
    if (!MULTISTORE_MANAGER_STORES.includes(store)) return 0;
    const { data } = await supabase.from("users").select("role").ilike("role", "multi-store manager");
    return (data || []).length ? MSM_TARGET_BOOST : 0;
  }

  // Completed-week listing totals for a store (sum of listed_count), oldest -> newest.
  async function weeklyTotals(store: string) {
    const { data } = await supabase
      .from("kpi_entries")
      .select("period_end_date, listed_count")
      .eq("store", store)
      .eq("period_type", "weekly")
      .lt("period_end_date", todayStr);
    const byWeek: Record<string, number> = {};
    (data || []).forEach((r: any) => {
      const w = r.period_end_date;
      byWeek[w] = (byWeek[w] || 0) + (Number(r.listed_count) || 0);
    });
    return Object.keys(byWeek).sort().map((w) => ({ week: w, total: byWeek[w] }));
  }

  // Every hand-set goal for a store, newest first.
  async function goalRows(store: string) {
    const { data } = await supabase
      .from("listing_goal_weeks")
      .select("week_start, target, set_by, set_at")
      .eq("store", store)
      .order("week_start", { ascending: false });
    return data || [];
  }

  async function getRow(store: string) {
    const { data } = await supabase.from("store_targets").select("*").eq("store", store).maybeSingle();
    if (data) return data;
    const size = await rosterCount(store);
    const base = baseForSize(size) + (await msmBoost(store));
    const row = {
      store, base_target: base, current_target: base, hit_streak: 0, miss_streak: 0,
      flag_status: "none", last_eval_week: null, team_size: size, pending_size: null, pending_effective: null,
    };
    await supabase.from("store_targets").insert(row);
    return row;
  }

  // Settle team-size changes (asymmetric timing) and keep the suggested ladder in
  // step with the roster. The performance ratchet that used to live here is GONE:
  // it fought the DM's typed number and produced the review/lower/raise prompts
  // that are no longer wanted.
  async function evaluate(store: string) {
    const row: any = await getRow(store);
    const weeks = await weeklyTotals(store);
    const goals = await goalRows(store);
    let { base_target, team_size, pending_size, pending_effective } = row;
    let changed = false;

    const liveSize = await rosterCount(store);
    const boost = await msmBoost(store);
    if (team_size == null) { team_size = liveSize; changed = true; }

    // (1) Promote a previously-deferred addition once its effective week arrived.
    if (pending_effective != null && todayStr >= pending_effective) {
      team_size = pending_size;
      pending_size = null; pending_effective = null;
      changed = true;
    }

    // (2) React to a roster change vs the current EFFECTIVE size.
    if (liveSize < team_size) {
      team_size = liveSize;                                   // someone left: shrink now
      pending_size = null; pending_effective = null;
      changed = true;
    } else if (liveSize > team_size) {
      if (pending_size !== liveSize) {                        // someone added: defer a week
        pending_size = liveSize;
        pending_effective = nextMonday(todayStr);
        changed = true;
      }
    } else if (pending_size != null) {
      pending_size = null; pending_effective = null;          // roster bounced back
      changed = true;
    }

    // (3) Keep the suggestion in step with the effective team size.
    const newBase = baseForSize(team_size) + boost;
    if (newBase !== base_target) { base_target = newBase; changed = true; }

    if (changed) {
      await supabase.from("store_targets").update({
        base_target, current_target: base_target, team_size, pending_size, pending_effective,
        flag_status: "none", hit_streak: 0, miss_streak: 0,
        updated_at: new Date().toISOString(),
      }).eq("store", store);
    }

    // (4) Resolve THIS week's goal. Explicitly set for this week wins; otherwise
    //     the most recent earlier week carries forward (a missed Monday must not
    //     reset a store to the ladder); otherwise the ladder suggestion.
    const exact = goals.find((g: any) => g.week_start === thisMonday);
    const carried = exact ? null : goals.find((g: any) => g.week_start < thisMonday);
    const target = exact ? exact.target : (carried ? carried.target : base_target);

    // (5) Attach the goal that was in force in each completed week, so the
    //     green/red history can't be re-coloured by changing this week's number.
    //     period_end_date is the Sunday; its Monday is six days earlier.
    const byWeekStart: Record<string, number> = {};
    goals.forEach((g: any) => { byWeekStart[g.week_start] = g.target; });
    const sortedStarts = Object.keys(byWeekStart).sort();
    const targetForWeekEnd = (endSunday: string) => {
      const start = mondayOf(endSunday);
      if (byWeekStart[start] != null) return byWeekStart[start];
      let prior: number | null = null;
      for (const s of sortedStarts) { if (s < start) prior = byWeekStart[s]; else break; }
      return prior != null ? prior : base_target;
    };

    return {
      store,
      target,
      base: base_target,                 // ladder suggestion / prefill
      suggested: base_target,
      manual: !!exact,                   // was THIS week set by hand
      carried: !exact && !!carried,      // running on a previous week's number
      weekStart: thisMonday,
      setBy: exact ? exact.set_by : (carried ? carried.set_by : null),
      setAt: exact ? exact.set_at : (carried ? carried.set_at : null),
      weeks: weeks.slice(-4).map((w) => ({ ...w, target: targetForWeekEnd(w.week) })),
      size: team_size,
      pending: pending_size != null ? { size: pending_size, effective: pending_effective } : null,
      flag: "none",                      // kept so a stale cached client can't paint a flag
    };
  }

  if (req.method === "GET") {
    const store = url.searchParams.get("store")?.toUpperCase();
    const list = store ? [store] : STORES;
    const out = [];
    for (const s of list) out.push(await evaluate(s));
    return json(store ? out[0] : out);
  }

  if (req.method === "POST") {
    // DM sets a week's listing goal. Body: { store, target, week_start?, name? }
    let body: any;
    try { body = JSON.parse(await req.text()); } catch { return json({ error: "Invalid JSON" }, 400); }

    const store = String(body.store || "").toUpperCase();
    if (!STORES.includes(store)) return json({ error: "Unknown store" }, 400);

    const target = Number(body.target);
    if (!Number.isFinite(target) || target < 0 || target > 2000) {
      return json({ error: "Target must be a whole number between 0 and 2000" }, 400);
    }

    const weekStart = body.week_start ? mondayOf(String(body.week_start)) : thisMonday;

    const { error } = await supabase.from("listing_goal_weeks").upsert({
      store, week_start: weekStart, target: Math.round(target),
      set_by: body.name || null, set_at: new Date().toISOString(),
    }, { onConflict: "store,week_start" });
    if (error) return json({ error: error.message }, 500);

    return json(await evaluate(store));
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
});
