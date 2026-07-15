import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const STEP = 10;       // performance ratchet step
const HITS_UP = 2;     // consecutive weeks at/above target to RAISE
const MISS_FLAG = 2;   // consecutive weeks below target to FLAG for DM review

// Stores overseen by a Multi-Store Manager. Mirrors MULTISTORE_MANAGER_STORES in speeks.js.
const MULTISTORE_MANAGER_STORES = ["BAL", "MPL"];
// The MSM splits time across their stores and isn't really listing, so they don't
// count as a full person (±20) on ANY store's ladder — instead each store they
// cover gets this flat listings boost, reflecting what they do pitch in.
const MSM_TARGET_BOOST = 15;

// Incremental weekly target: +/-20 per person, anchored at 4 people = 190.
// (2->150, 3->170, 4->190, 5->210, 6->230). Floor at 150 so data gaps can't
// produce an absurd target. Matches ListingGoalsEngine.weeklyTarget on the frontend.
// NOTE: the MSM boost is added ON TOP of this (see msmBoost), not baked into it —
// per-person daily goals derive from the unboosted ladder so regular listers
// don't absorb the MSM's share.
function baseForSize(size: number) { return Math.max(150, 110 + 20 * size); }

// Monday that starts the NEXT week relative to a YYYY-MM-DD date (UTC).
// Added staff take effect here so mid-week training isn't counted against the goal.
function nextMonday(ds: string): string {
  const d = new Date(ds + "T00:00:00Z");
  const dow = d.getUTCDay();                 // 0 Sun .. 6 Sat
  const add = ((8 - dow) % 7) || 7;          // strictly-future Monday
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
  const todayStr = new Date().toISOString().split("T")[0]; // week ends Sunday; completed = period_end_date < today

  // Live roster COUNT for a store (excludes CEO / District Manager / Multi-Store
  // Manager — the MSM contributes via the flat MSM_TARGET_BOOST instead).
  async function rosterCount(store: string) {
    const { data } = await supabase.from("users").select("role").eq("store", store);
    const excl = new Set(["ceo", "district manager", "multi-store manager"]);
    return (data || []).filter((u: any) => !excl.has(String(u.role || "").toLowerCase().trim())).length;
  }

  // Flat boost for stores covered by a Multi-Store Manager. Applies only while
  // an MSM actually exists in users, so it self-removes if the role goes away.
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

  // Lazily, on every read: settle team-size changes (asymmetric timing), re-base the
  // goal ladder, then ratchet over newly-completed weeks. Persist if anything moved.
  async function evaluate(store: string) {
    const row: any = await getRow(store);
    const weeks = await weeklyTotals(store);
    let {
      current_target, hit_streak, miss_streak, flag_status, base_target, last_eval_week,
      team_size, pending_size, pending_effective,
    } = row;
    let changed = false;

    const liveSize = await rosterCount(store);
    const boost = await msmBoost(store);
    if (team_size == null) { team_size = liveSize; changed = true; } // first run after migration

    // (1) Promote a previously-deferred addition once its effective week has arrived.
    if (pending_effective != null && todayStr >= pending_effective) {
      team_size = pending_size;
      pending_size = null; pending_effective = null;
      changed = true;
    }

    // (2) React to a roster change vs the current EFFECTIVE size.
    if (liveSize < team_size) {
      // Someone left -> shrink the goal immediately (mid-week), cancel any pending raise.
      team_size = liveSize;
      pending_size = null; pending_effective = null;
      changed = true;
    } else if (liveSize > team_size) {
      // Someone added -> defer the higher goal to the start of next week (training week).
      if (pending_size !== liveSize) {
        pending_size = liveSize;
        pending_effective = nextMonday(todayStr);
        changed = true;
      }
    } else if (pending_size != null) {
      // Roster returned to the effective size before the raise landed -> cancel it.
      pending_size = null; pending_effective = null;
      changed = true;
    }

    // (3) Re-base the ladder to the effective team size (+ the MSM boost where one
    //     covers this store); carry earned ratchet steps.
    const newBase = baseForSize(team_size) + boost;
    if (newBase !== base_target) {
      const earned = Math.max(0, current_target - base_target);
      base_target = newBase;
      current_target = newBase + earned;
      changed = true;
    }

    // (4) Weekly performance ratchet over any newly-completed weeks.
    if (last_eval_week == null) {
      const latest = weeks.length ? weeks[weeks.length - 1].week : null;
      if (latest !== last_eval_week) { last_eval_week = latest; changed = true; }
    } else {
      const newWeeks = weeks.filter((w) => w.week > last_eval_week);
      for (const w of newWeeks) {
        if (w.total >= current_target) {
          hit_streak++; miss_streak = 0;
          if (hit_streak >= HITS_UP) { current_target += STEP; hit_streak = 0; }
        } else {
          miss_streak++; hit_streak = 0;
          if (miss_streak >= MISS_FLAG) flag_status = "flagged";
        }
        last_eval_week = w.week;
        changed = true;
      }
    }

    if (changed) {
      await supabase.from("store_targets").update({
        current_target, hit_streak, miss_streak, flag_status, base_target, last_eval_week,
        team_size, pending_size, pending_effective,
        updated_at: new Date().toISOString(),
      }).eq("store", store);
    }

    return {
      store, target: current_target, base: base_target, flag: flag_status,
      weeks: weeks.slice(-4), size: team_size,
      pending: pending_size != null ? { size: pending_size, effective: pending_effective } : null,
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
    // DM action on a flagged store. Body: { store, action: 'lower' | 'keep' }
    let body: any;
    try { body = JSON.parse(await req.text()); } catch { return json({ error: "Invalid JSON" }, 400); }
    const store = (body.store || "").toUpperCase();
    const action = body.action;
    if (!store || (action !== "lower" && action !== "keep")) {
      return json({ error: "Missing store/action" }, 400);
    }
    const row: any = await getRow(store);
    let current_target = row.current_target;
    if (action === "lower") current_target = Math.max(row.base_target, current_target - STEP);
    await supabase.from("store_targets").update({
      current_target, flag_status: "resolved", miss_streak: 0,
      updated_at: new Date().toISOString(),
    }).eq("store", store);
    return json({ store, target: current_target, flag: "resolved" });
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
});
