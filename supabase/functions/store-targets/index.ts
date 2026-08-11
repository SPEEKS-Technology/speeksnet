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

// A floater belongs to a MARKET, not a store — he can be claimed by any store in
// his home store's market on any given day.
const MARKETS: Record<string, string[]> = {
  KC: ["OVL", "LEE", "WSP"],
  STL: ["MPL", "BAL"],
};
function marketOf(store: string): string[] {
  for (const m of Object.keys(MARKETS)) if (MARKETS[m].includes(store)) return MARKETS[m];
  return [store];
}

// Roles that are not a pair of hands on the shop floor. 'store' is the board
// account — a TV, not a head; counting it would hand a store a phantom person's
// worth of capacity. Mirrors storeRosterSize/userInStore in speeks.js.
const NON_STAFF_ROLES = new Set(["ceo", "district manager", "store"]);

// ---------------------------------------------------------------------------
// CAPACITY MODEL
// ---------------------------------------------------------------------------
// Replaces the headcount ladder (baseForSize: ±20/person anchored at 4 = 190,
// floored at 150) and the flat +15 MSM boost. Both are gone.
//
// A person's listing output is their SCHEDULED HOURS × the RATE of the seat they
// are in. The seats are wildly different — the person on the buy counter is
// interrupted by every customer who walks in, a protected lister is not — so
// headcount alone says nothing, which is exactly why the ladder never fit: WSP
// has the most hours of any store and among the lowest output, MPL the fewest
// and the highest, yet the ladder handed them near-identical numbers.
//
// Every constant lives in listing_config, one row each, with its reasoning in
// the note column. There is deliberately no admin UI (user, 2026-08-10).
//
// Seats are filled in priority order, because the counter is a FIXED COST that
// comes out of the store's hours before anyone lists a thing:
//   Buyer 1  covers open hours, always
//   Buyer 2  covers open hours, once B1 is covered
//   Listers  everything left over
// That ordering is what makes capacity superlinear in staffing: the 5th person's
// hours are worth 6× the 1st's, because they land in a lister seat rather than
// on the counter. It is the main thing the ladder's flat ±20 got wrong.
type Cfg = Record<string, number>;

const CFG_FALLBACK: Cfg = {
  rate_buyer_1: 0.5, rate_buyer_2: 1.0, rate_lister: 3.0, rate_new_hire: 1.0,
  new_hire_weeks: 2, hours_full_time: 40, hours_part_time: 20, hours_floater: 25,
  days_off_full_time: 1, goal_factor: 0.75, open_days: 6, hours_per_day: 8,
  saturday_factor: 0.5, customer_time_source: 0,
};

function weeklyHoursFor(u: any, cfg: Cfg): number {
  // A floater is neither: he is guaranteed a minimum and lands wherever the
  // market needs him, so he carries his own hours figure.
  if (u.can_float) return cfg.hours_floater;
  return String(u.employment_type || "full_time") === "part_time"
    ? cfg.hours_part_time
    : cfg.hours_full_time;
}

// Is this person still inside the new-hire ramp for the week starting weekStart?
// hire_date NULL = no ramp. That is the safe default: it means a missing hire
// date over-states capacity slightly rather than silently suppressing a real
// person's goal, and it is visible in the breakdown.
function isNewHire(u: any, weekStart: string, cfg: Cfg): boolean {
  if (!u.hire_date) return false;
  const end = new Date(u.hire_date + "T00:00:00Z");
  end.setUTCDate(end.getUTCDate() + cfg.new_hire_weeks * 7);
  return new Date(weekStart + "T00:00:00Z") < end;
}

// The whole week's arithmetic, from a roster to a number.
//
// Saturday is a real open day but produces about half a weekday's listings —
// shorter, and the busiest buy day — so hours are discounted by saturday_factor
// once, at the store level, rather than being tracked per shift.
function capacityFrom(roster: any[], weekStart: string, cfg: Cfg) {
  const weekdays = cfg.open_days - 1;
  const effDays = weekdays + cfg.saturday_factor;      // 5.5 of 6 open days
  const dayFactor = effDays / cfg.open_days;           // 0.9167
  const seatWeek = cfg.hours_per_day * effDays;        // 44h — one seat, all week

  const people = roster.map((u: any) => {
    const hours = weeklyHoursFor(u, cfg);
    return {
      name: u.name,
      role: u.role,
      hours,
      employment: u.can_float ? "floater" : (u.employment_type || "full_time"),
      newHire: isNewHire(u, weekStart, cfg),
      floater: !!u.can_float,
      homeStore: u.store,
    };
  });

  const totalHours = people.reduce((s, p) => s + p.hours, 0);
  const newHireHours = people.filter((p) => p.newHire).reduce((s, p) => s + p.hours, 0);

  const effHours = totalHours * dayFactor;
  const b1 = Math.min(effHours, seatWeek);
  const b2 = Math.min(effHours - b1, seatWeek);
  const listerHours = Math.max(0, effHours - b1 - b2);

  // A new hire's share of the LISTER hours earns the new-hire rate. Only the
  // lister share: a new hire on the counter is already priced by the low buyer
  // rates, and docking them again would double-count. Apportioned by their share
  // of the store's hours because seats rotate — nobody is the lister all week.
  const nhLister = totalHours > 0 ? listerHours * (newHireHours / totalHours) : 0;

  const capacity =
    b1 * cfg.rate_buyer_1 +
    b2 * cfg.rate_buyer_2 +
    (listerHours - nhLister) * cfg.rate_lister +
    nhLister * cfg.rate_new_hire;

  return {
    people,
    totalHours,
    seats: {
      buyer1: round1(b1), buyer2: round1(b2),
      lister: round1(listerHours - nhLister), newHire: round1(nhLister),
    },
    capacity: Math.round(capacity),
    goal: Math.round(capacity * cfg.goal_factor),
  };
}

function round1(n: number) { return Math.round(n * 10) / 10; }

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

  let _cfg: Cfg | null = null;
  async function config(): Promise<Cfg> {
    if (_cfg) return _cfg;
    const { data } = await supabase.from("listing_config").select("key, value");
    const c: Cfg = { ...CFG_FALLBACK };
    (data || []).forEach((r: any) => { c[r.key] = Number(r.value); });
    _cfg = c;
    return c;
  }

  // Everyone whose hours belong to this store's week.
  //
  // A Multi-Store Manager appears in BOTH of the stores they cover, at part-time
  // hours each — which is the literal truth of how their week is split, and is
  // what retired the old MSM_TARGET_BOOST special case. A floater is counted at
  // his HOME store here: Monday's goal has to be frozen before anyone knows where
  // he will actually be, and the end-of-week adjusted goal corrects for it.
  async function rosterFor(store: string) {
    const { data } = await supabase
      .from("users")
      .select("name, role, store, employment_type, can_float, hire_date");
    return (data || []).filter((u: any) => {
      const role = String(u.role || "").toLowerCase().trim();
      if (NON_STAFF_ROLES.has(role)) return false;
      if (role === "multi-store manager") return MULTISTORE_MANAGER_STORES.includes(store);
      return String(u.store || "").toUpperCase() === store;
    });
  }

  async function capacityFor(store: string, weekStart: string) {
    const cfg = await config();
    return capacityFrom(await rosterFor(store), weekStart, cfg);
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

  async function getRow(store: string, suggested: number) {
    const { data } = await supabase.from("store_targets").select("*").eq("store", store).maybeSingle();
    if (data) return data;
    const row = {
      store, base_target: suggested, current_target: suggested, hit_streak: 0, miss_streak: 0,
      flag_status: "none", last_eval_week: null, team_size: 0, pending_size: null, pending_effective: null,
    };
    await supabase.from("store_targets").insert(row);
    return row;
  }

  // Resolve a store's goal for this week.
  //
  // The performance ratchet is GONE (it fought the DM's typed number), and as of
  // the capacity model so is the deferred-team-size machinery: pending_size held
  // an addition back a week so a new hire's training days weren't counted against
  // the goal, but the new-hire RAMP does that job properly — two weeks at the
  // new-hire rate, rather than one week of pretending the person doesn't exist
  // followed by a jump to full rate. pending_size/pending_effective are left in
  // the table but no longer written; nothing reads them.
  async function evaluate(store: string) {
    const cfg = await config();
    const cap = await capacityFor(store, thisMonday);
    const row: any = await getRow(store, cap.goal);
    const weeks = await weeklyTotals(store);
    const goals = await goalRows(store);

    const teamSize = cap.people.length;
    if (row.base_target !== cap.goal || row.team_size !== teamSize) {
      await supabase.from("store_targets").update({
        base_target: cap.goal, current_target: cap.goal, team_size: teamSize,
        pending_size: null, pending_effective: null,
        flag_status: "none", hit_streak: 0, miss_streak: 0,
        updated_at: new Date().toISOString(),
      }).eq("store", store);
    }

    // Explicitly set for this week wins; otherwise the most recent earlier week
    // carries forward (a missed Monday must not reset a store to the suggestion);
    // otherwise the capacity suggestion.
    const exact = goals.find((g: any) => g.week_start === thisMonday);
    const carried = exact ? null : goals.find((g: any) => g.week_start < thisMonday);
    const target = exact ? exact.target : (carried ? carried.target : cap.goal);

    // Attach the goal that was in force in each completed week, so the green/red
    // history can't be re-coloured by changing this week's number.
    // period_end_date is the Sunday; its Monday is six days earlier.
    const byWeekStart: Record<string, number> = {};
    goals.forEach((g: any) => { byWeekStart[g.week_start] = g.target; });
    const sortedStarts = Object.keys(byWeekStart).sort();
    const targetForWeekEnd = (endSunday: string) => {
      const start = mondayOf(endSunday);
      if (byWeekStart[start] != null) return byWeekStart[start];
      let prior: number | null = null;
      for (const s of sortedStarts) { if (s < start) prior = byWeekStart[s]; else break; }
      return prior != null ? prior : cap.goal;
    };

    return {
      store,
      target,
      base: cap.goal,                    // capacity suggestion / prefill
      suggested: cap.goal,
      capacity: cap.capacity,            // the ceiling the goal is a fraction of
      hours: cap.totalHours,
      // The frontend computes each person's DAILY goal itself (hours × seat rate)
      // so the widget stays instant when a manager taps a role dot. It needs the
      // rates to do that, and they are shipped here rather than mirrored in
      // speeks.js — a duplicated constant is exactly how the old baseForSize
      // ladder drifted out of step with its server twin.
      cfg: {
        hours_per_day: cfg.hours_per_day,
        rate_buyer_1: cfg.rate_buyer_1,
        rate_buyer_2: cfg.rate_buyer_2,
        rate_lister: cfg.rate_lister,
        rate_new_hire: cfg.rate_new_hire,
        saturday_factor: cfg.saturday_factor,
        goal_factor: cfg.goal_factor,
        // Not used in the goal maths — these label the schedule dropdown and the
        // ramp tooltip in User Permissions, so those read the real numbers
        // instead of hard-coding 40 / 20 / 25 / 2 weeks.
        hours_full_time: cfg.hours_full_time,
        hours_part_time: cfg.hours_part_time,
        hours_floater: cfg.hours_floater,
        new_hire_weeks: cfg.new_hire_weeks,
      },
      // Who is inside the new-hire ramp this week, so their lister days score at
      // the new-hire rate. Names, because that is what listing_goals keys on.
      newHires: cap.people.filter((p) => p.newHire).map((p) => p.name),
      manual: !!exact,                   // was THIS week set by hand
      carried: !exact && !!carried,      // running on a previous week's number
      weekStart: thisMonday,
      setBy: exact ? exact.set_by : (carried ? carried.set_by : null),
      setAt: exact ? exact.set_at : (carried ? carried.set_at : null),
      weeks: weeks.slice(-4).map((w) => ({ ...w, target: targetForWeekEnd(w.week) })),
      size: teamSize,
      pending: null,                     // retired — see evaluate()'s note
      flag: "none",                      // kept so a stale cached client can't paint a flag
    };
  }

  // Full breakdown for one store-week, including — for a week that has already
  // been staffed — what the team SHOULD have hit given how it actually ran.
  //
  // planned  = goal_factor × capacity of the roster, frozen Monday morning.
  // adjusted = the sum of the per-person daily goals actually assigned that week.
  //            Off days, callouts and no-shows fall out of this automatically,
  //            because an OFF person carries no goal and an unstaffed seat was
  //            never assigned. This is the honest "what should you have hit".
  // efficiency = real listed_count ÷ adjusted. Above 1.0 means the team beat the
  //            capacity it actually had, which is the only fair reading of a week
  //            that lost two people to a callout.
  async function breakdown(store: string, weekStart: string) {
    const cfg = await config();
    const cap = await capacityFor(store, weekStart);

    const weekEnd = new Date(weekStart + "T00:00:00Z");
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    const endStr = weekEnd.toISOString().split("T")[0];

    const { data: assigned } = await supabase
      .from("listing_goals")
      .select("date, employee, role, goal, result")
      .eq("store", store)
      .gte("date", weekStart)
      .lte("date", endStr);

    const rows = assigned || [];
    const adjusted = rows.reduce((s: number, r: any) => s + (Number(r.goal) || 0), 0);
    const offDays = rows.filter((r: any) => String(r.role || "").toUpperCase() === "OFF").length;

    // Actual output is the manager-filed weekly KPI, not the daily result boxes:
    // the KPI is the number that already drives every other scoreboard, and the
    // daily boxes are frequently left blank.
    const { data: kpi } = await supabase
      .from("kpi_entries")
      .select("listed_count")
      .eq("store", store)
      .eq("period_type", "weekly")
      .eq("period_end_date", endStr);
    const actual = (kpi || []).reduce((s: number, r: any) => s + (Number(r.listed_count) || 0), 0);

    // Per-person, per-day goal — the number the widget shows. Deliberately NOT
    // back-derived from the weekly total the way the old engine's largest-
    // remainder allocation was: it is just hours × the rate of today's seat, so a
    // manager can check it in their head, and the gap between the daily goals and
    // the frozen weekly goal is real information about how the week was staffed.
    const dayRate: Record<string, number> = {
      B1: cfg.rate_buyer_1, B2: cfg.rate_buyer_2,
    };
    const perDay = (role: string, isSat: boolean, newHire: boolean) => {
      const r = String(role || "").toUpperCase();
      if (!r || r === "-" || r === "OFF") return 0;
      const rate = dayRate[r] != null
        ? dayRate[r]
        : (newHire ? cfg.rate_new_hire : cfg.rate_lister);   // L1, L2, L3 …
      return Math.round(cfg.hours_per_day * rate * (isSat ? cfg.saturday_factor : 1) * cfg.goal_factor);
    };

    return {
      store, weekStart, weekEnd: endStr,
      config: cfg,
      people: cap.people,
      hours: cap.totalHours,
      seats: cap.seats,
      capacity: cap.capacity,
      planned: cap.goal,
      adjusted,
      assignedDays: rows.length,
      offDays,
      actual,
      efficiency: adjusted > 0 ? Math.round((actual / adjusted) * 100) / 100 : null,
      sampleGoals: {
        weekday: { B1: perDay("B1", false, false), B2: perDay("B2", false, false), L: perDay("L1", false, false), newHireLister: perDay("L1", false, true) },
        saturday: { B1: perDay("B1", true, false), B2: perDay("B2", true, false), L: perDay("L1", true, false), newHireLister: perDay("L1", true, true) },
      },
    };
  }

  // Floaters a store may use on a given day, each with whoever currently has him.
  //
  // A floater shows up in EVERY roster in his market. He is greyed out — not
  // hidden — once another store claims him, because a manager who can't see where
  // he went will just ask, and the answer is the point.
  async function floatersFor(store: string, dateStr: string) {
    const market = marketOf(store);
    const { data: users } = await supabase
      .from("users")
      .select("name, store, role")
      .eq("can_float", true);
    const mine = (users || []).filter((u: any) =>
      market.includes(String(u.store || "").toUpperCase())
    );
    if (!mine.length) return [];

    const { data: claims } = await supabase
      .from("listing_floater_claims")
      .select("employee, store, claimed_by, claimed_at")
      .eq("date", dateStr)
      .in("employee", mine.map((u: any) => u.name));

    const byName: Record<string, any> = {};
    (claims || []).forEach((c: any) => { byName[c.employee] = c; });

    return mine.map((u: any) => {
      const c = byName[u.name];
      return {
        name: u.name,
        role: u.role,
        homeStore: String(u.store || "").toUpperCase(),
        claimedBy: c ? c.store : null,
        claimedByName: c ? c.claimed_by : null,
        // What the widget keys off: available to ME, or spoken for elsewhere.
        available: !c || c.store === store,
        mine: !!c && c.store === store,
      };
    });
  }

  if (req.method === "GET") {
    const action = url.searchParams.get("action");
    const store = url.searchParams.get("store")?.toUpperCase();

    if (action === "floaters") {
      if (!store || !STORES.includes(store)) return json({ error: "Unknown store" }, 400);
      const dateStr = url.searchParams.get("date") || todayStr;
      return json(await floatersFor(store, dateStr));
    }

    if (action === "capacity") {
      const week = url.searchParams.get("week")
        ? mondayOf(String(url.searchParams.get("week")))
        : thisMonday;
      const list = store ? [store] : STORES;
      const out = [];
      for (const s of list) out.push(await breakdown(s, week));
      return json(store ? out[0] : out);
    }

    const list = store ? [store] : STORES;
    const out = [];
    for (const s of list) out.push(await evaluate(s));
    return json(store ? out[0] : out);
  }

  if (req.method === "POST") {
    let body: any;
    try { body = JSON.parse(await req.text()); } catch { return json({ error: "Invalid JSON" }, 400); }

    // ---- DM sets the stretch factor ----------------------------------------
    // goal_factor is the ONE dial on the model: what fraction of a roster's
    // ceiling the week's goal is. It replaced the per-store number the DM used
    // to type, because typing a store's goal by hand fought the whole point of
    // deriving it from staffing.
    //
    // Saving it RE-FREEZES the current week for every store at the new number.
    // Without that it would change nothing visible: listing_goal_weeks holds a
    // row per store per week and that row wins over the computed suggestion, so
    // the stores would keep running last Monday's figure. Past weeks are left
    // exactly as they were — history must not re-colour itself.
    //
    // ⚠️ No role check here, and none on the goal POST below either: this whole
    // function is verify_jwt:false and unauthenticated, so a gate on one action
    // would be theatre. The modal is DM-gated in the UI. Worth closing properly
    // (the x-user-pin + server-side role re-check pattern from summary-weekly)
    // if this function ever holds anything more sensitive.
    if (body.action === "factor") {
      const f = Number(body.value);
      if (!Number.isFinite(f) || f < 0.3 || f > 1.2) {
        return json({ error: "Stretch factor must be between 0.30 and 1.20" }, 400);
      }
      const rounded = Math.round(f * 100) / 100;
      const { error: cErr } = await supabase.from("listing_config")
        .update({ value: rounded, updated_at: new Date().toISOString() })
        .eq("key", "goal_factor");
      if (cErr) return json({ error: cErr.message }, 500);
      _cfg = null;   // the cached config for this request is now stale

      const cfg = await config();
      const applied: Record<string, number> = {};
      for (const s of STORES) {
        const cap = capacityFrom(await rosterFor(s), thisMonday, cfg);
        applied[s] = cap.goal;
        await supabase.from("listing_goal_weeks").upsert({
          store: s, week_start: thisMonday, target: cap.goal,
          set_by: body.name || "Capacity model", set_at: new Date().toISOString(),
        }, { onConflict: "store,week_start" });
      }
      return json({ ok: true, goal_factor: rounded, applied });
    }

    const store = String(body.store || "").toUpperCase();
    if (!STORES.includes(store)) return json({ error: "Unknown store" }, 400);

    // Claim a floater for a day. Body: { action:'claim', store, employee, date?, name? }
    //
    // The race is settled by the primary key, not by a read-then-write: two
    // managers tapping the same role dot in the same second both reach the insert,
    // and exactly one succeeds. The loser is told who won rather than getting an
    // error, so their widget can grey the person out and say where he went.
    if (body.action === "claim" || body.action === "release") {
      const employee = String(body.employee || "").trim();
      if (!employee) return json({ error: "Missing employee" }, 400);
      const dateStr = body.date ? String(body.date) : todayStr;

      const { data: who } = await supabase
        .from("users").select("name, store, can_float").eq("name", employee).maybeSingle();
      if (!who || !who.can_float) return json({ error: `${employee} is not a floater` }, 400);
      if (!marketOf(store).includes(String(who.store || "").toUpperCase())) {
        return json({ error: `${employee} is not in ${store}'s market` }, 400);
      }

      if (body.action === "release") {
        // Only the store holding the claim may drop it — otherwise a second store
        // could quietly take someone off the first store's floor mid-shift.
        const { data: cur } = await supabase
          .from("listing_floater_claims").select("store")
          .eq("date", dateStr).eq("employee", employee).maybeSingle();
        if (cur && cur.store !== store) {
          return json({ ok: false, claimedBy: cur.store, error: `${employee} is claimed by ${cur.store}` }, 409);
        }
        await supabase.from("listing_floater_claims")
          .delete().eq("date", dateStr).eq("employee", employee).eq("store", store);
        return json({ ok: true, released: true, floaters: await floatersFor(store, dateStr) });
      }

      const { error: insErr } = await supabase.from("listing_floater_claims").insert({
        date: dateStr, employee, store, claimed_by: body.name || null,
      });
      if (insErr) {
        const { data: cur } = await supabase
          .from("listing_floater_claims").select("store, claimed_by")
          .eq("date", dateStr).eq("employee", employee).maybeSingle();
        if (cur && cur.store === store) {
          return json({ ok: true, alreadyMine: true, floaters: await floatersFor(store, dateStr) });
        }
        return json({
          ok: false, claimedBy: cur ? cur.store : null, claimedByName: cur ? cur.claimed_by : null,
          error: cur ? `${employee} is already at ${cur.store} today` : insErr.message,
          floaters: await floatersFor(store, dateStr),
        }, 409);
      }
      return json({ ok: true, floaters: await floatersFor(store, dateStr) });
    }

    // DM sets a week's listing goal. Body: { store, target, week_start?, name? }

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
