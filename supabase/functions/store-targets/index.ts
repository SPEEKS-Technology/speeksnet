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
  days_full_time: 5, days_part_time: 4, days_floater: 5, max_shift_hours: 12,
  days_off_full_time: 1, goal_factor: 0.75, open_days: 6, hours_per_day: 8,
  saturday_factor: 0.5, customer_time_source: 0,
};

// The stretch factor, per store.
//
// goal_factor is the district default; goal_factor_<STORE> overrides it for one
// store. Both are rows in listing_config, which is key/value, so this needed no
// schema change — and a store with no row of its own simply runs the district
// number, which is what all five did before this existed.
//
// Why per store (user, 2026-09-07): "so I can incrementally move up stores that
// keep hitting their weekly goals, but keep stores that aren't at lower ones."
// One dial for all five could only be set to what the weakest store could take,
// which is the opposite of pushing the strong ones. The dial is still a SHARE OF
// CAPACITY, not a hand-typed goal, so a store that adds a person still moves on
// its own — the thing the old typed-target ladder got wrong stays fixed.
function factorFor(store: string, cfg: Cfg): number {
  const own = cfg["goal_factor_" + String(store).toUpperCase()];
  return Number.isFinite(own) ? own : cfg.goal_factor;
}

// A person's hours, and the length of one of their days.
//
// Both are per person now (users.weekly_hours / users.days_per_week, migration
// 0091). Either may be NULL, which means "the default for this person's kind of
// schedule" — so the exceptions are the only rows anyone has to type into.
//
// ⚠️ The DAY LENGTH IS DERIVED, never stored. That is the whole point of the
// shape: the weekly goal is built from weekly hours and the daily goal from the
// shift, and if the two were typed independently they would eventually disagree
// — which is precisely the failure 0091 retired. weekly / days is the only
// source either of them reads.
function weeklyHoursFor(u: any, cfg: Cfg): number {
  const own = Number(u.weekly_hours);
  if (Number.isFinite(own) && own > 0) return own;
  // A floater is neither full- nor part-time: he is guaranteed a minimum and
  // lands wherever the market needs him, so he carries his own hours figure.
  if (u.can_float) return cfg.hours_floater;
  return String(u.employment_type || "full_time") === "part_time"
    ? cfg.hours_part_time
    : cfg.hours_full_time;
}

function daysPerWeekFor(u: any, cfg: Cfg): number {
  const own = Number(u.days_per_week);
  if (Number.isFinite(own) && own > 0) return Math.min(own, cfg.open_days);
  if (u.can_float) return cfg.days_floater;

  // A Multi-Store Manager's WEEK is split between two stores. Their DAY is not.
  //
  // They are stored as part_time because that is how the split is counted —
  // hours_part_time at each of the two stores, 40 across the pair (see
  // rosterFor). Reading that flag as "works short days" is a different claim
  // entirely, and the board says it is false: Joseph Ortega is marked OFF at one
  // store and given a full seat at the other, in runs of days, at a full day's
  // goal. Where he is varies week to week with what each store needs (user,
  // 2026-09-17) — which is exactly why a fixed day count for him is the wrong
  // shape, and why his real schedule is already recorded in the role board
  // rather than in a column.
  //
  // So: derive the day count from a FULL day. 20h ÷ 8h = 2.5 days at each store,
  // which lands the shift back on 8 and leaves their daily goal untouched.
  // Deliberately derived rather than stored as 2.5 — days_per_week is an integer
  // column, and the fact worth keeping is "a normal day", not the fraction.
  if (String(u.role || "").toLowerCase().trim() === "multi-store manager") {
    const fullShift = cfg.hours_full_time / cfg.days_full_time;
    return fullShift > 0 ? weeklyHoursFor(u, cfg) / fullShift : cfg.days_full_time;
  }

  return String(u.employment_type || "full_time") === "part_time"
    ? cfg.days_part_time
    : cfg.days_full_time;
}

// The number a daily listing goal is actually built from.
//
// Capped at max_shift_hours so a mistyped 40h over 2 days cannot hand one person
// a 20-hour day's worth of goal — the goal would be absurd, and because
// `Staffed For` is the sum of the daily goals it would quietly wreck that
// store's efficiency reading too. Falls back to hours_per_day only when neither
// figure resolves, which no seeded row should hit.
function shiftHoursFor(u: any, cfg: Cfg): number {
  const hours = weeklyHoursFor(u, cfg);
  const days = daysPerWeekFor(u, cfg);
  if (!(hours > 0) || !(days > 0)) return cfg.hours_per_day;
  return Math.min(hours / days, cfg.max_shift_hours || 12);
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
//
// factor is passed in, not read off cfg.goal_factor: it is per store now (see
// factorFor) and everything else in here is store-agnostic. Required rather than
// defaulted, so a call site that forgets it fails loudly instead of quietly
// handing one store another store's goal.
function capacityFrom(roster: any[], weekStart: string, cfg: Cfg, factor: number) {
  const weekdays = cfg.open_days - 1;
  const effDays = weekdays + cfg.saturday_factor;      // 5.5 of 6 open days
  const dayFactor = effDays / cfg.open_days;           // 0.9167
  const seatWeek = cfg.hours_per_day * effDays;        // 44h — one seat, all week

  const people = roster.map((u: any) => {
    const hours = weeklyHoursFor(u, cfg);
    const days = daysPerWeekFor(u, cfg);
    return {
      name: u.name,
      role: u.role,
      hours,
      // Carried on every person because the DAILY goal is built from it and the
      // frontend computes that itself, instantly, as a manager taps a role dot.
      // Shipping the derived number rather than the two it comes from keeps the
      // division in one place — speeks.js re-deriving it is how the old
      // baseForSize ladder drifted out of step with its server twin.
      days,
      shift: round1(shiftHoursFor(u, cfg)),
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
    goal: Math.round(capacity * factor),
    goalFactor: factor,
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
      .select("name, role, store, employment_type, can_float, hire_date, weekly_hours, days_per_week");
    return (data || []).filter((u: any) => {
      const role = String(u.role || "").toLowerCase().trim();
      if (NON_STAFF_ROLES.has(role)) return false;
      if (role === "multi-store manager") return MULTISTORE_MANAGER_STORES.includes(store);
      return String(u.store || "").toUpperCase() === store;
    });
  }

  // A store-week's capacity, frozen once the week is over.
  //
  // ⚠️ This used to be a bare capacityFrom(rosterFor(store), …). rosterFor takes
  // no date — it reads users as it stands RIGHT NOW — so every past week silently
  // re-scored itself whenever anyone was hired, left, or had their hours changed.
  // The DM's Goal and Ceiling columns for a week in August were computed from a
  // roster that week never had, and did not match the number the store was
  // actually given at the time. See migration 0093.
  //
  // The current week is re-captured on every read, so a Tuesday hire shows up in
  // this week's ceiling the way it should. A week that has ENDED is written once,
  // sealed, and never recomputed again.
  //
  // A week that finished before 0093 has no snapshot and cannot get a real one —
  // the roster is not recoverable — so it falls back to a live computation and is
  // flagged `estimated`, rather than being quietly presented as what the store
  // was told.
  async function capacityFor(store: string, weekStart: string) {
    const cfg = await config();
    const ended = weekStart < thisMonday;

    if (ended) {
      const { data: snap } = await supabase
        .from("listing_week_capacity")
        .select("roster, hours, capacity, planned, goal_factor, seats, sealed_at")
        .eq("store", store)
        .eq("week_start", weekStart)
        .maybeSingle();
      if (snap) {
        // Seal on first read after the week closes. The CONTENT is already right
        // — it is the last capture taken while the week was live — so sealing
        // only records that it may never be rewritten.
        if (!snap.sealed_at) {
          await supabase.from("listing_week_capacity")
            .update({ sealed_at: new Date().toISOString() })
            .eq("store", store).eq("week_start", weekStart);
        }
        return {
          people: snap.roster, totalHours: Number(snap.hours),
          seats: snap.seats, capacity: snap.capacity,
          goal: snap.planned, goalFactor: Number(snap.goal_factor),
          estimated: false,
        };
      }
      // No snapshot: a week that finished before 0093 existed. Reconstruct it
      // from today's roster and SAY SO — deliberately writing nothing, because a
      // reconstruction stored in the snapshot table is indistinguishable from a
      // real one the moment it is read back.
      return {
        ...capacityFrom(await rosterFor(store), weekStart, cfg, factorFor(store, cfg)),
        estimated: true,
      };
    }

    const cap = capacityFrom(await rosterFor(store), weekStart, cfg, factorFor(store, cfg));

    // Capture the CURRENT week on every read, so a Tuesday hire lands in this
    // week's ceiling. A future week writes nothing: its roster is a guess, and
    // the guess would be what got sealed when the week arrives.
    if (weekStart === thisMonday) {
      // Best-effort — a snapshot that fails to write must not take the response
      // down with it. The figures in `cap` are correct either way.
      await supabase.from("listing_week_capacity").upsert({
        store, week_start: weekStart,
        roster: cap.people, hours: cap.totalHours, capacity: cap.capacity,
        planned: cap.goal, goal_factor: cap.goalFactor, seats: cap.seats,
        captured_at: new Date().toISOString(), sealed_at: null,
      }, { onConflict: "store,week_start" });
    }

    return { ...cap, estimated: false };
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

  // The last four completed weeks, each carrying BOTH readings of itself.
  //
  // The store's own bars and the DM's efficiency table were measuring different
  // things and both calling the answer "target": the bars are listed vs the goal
  // the DM set on Monday, the DM's Result chip is listed vs what the store was
  // actually staffed for. Neither is wrong — a week that lost two people to a
  // callout genuinely did beat the capacity it had while genuinely missing the
  // number it was given — but with each screen showing only one of them, the two
  // roles looked at the same week and saw opposite verdicts.
  //
  // So both travel together from here, and the widget shows both.
  //
  // `adjusted` is the sum of the daily goals actually assigned that week, which
  // is the same figure breakdown() calls Staffed For — read here in ONE query
  // across the whole span rather than four, because this runs on every store
  // payload fetch.
  async function weekHistory(
    store: string,
    weeks: Array<{ week: string; total: number }>,
    targetFor: (endSunday: string) => { target: number; source: string; setFor: string | null },
  ) {
    if (!weeks.length) return [];
    const starts = weeks.map((w) => mondayOf(w.week));
    const from = starts.reduce((a, b) => (a < b ? a : b));
    const to = weeks.map((w) => w.week).reduce((a, b) => (a > b ? a : b));

    const { data } = await supabase
      .from("listing_goals")
      .select("date, employee, goal")
      .eq("store", store)
      .gte("date", from)
      .lte("date", to);

    // Deduped by person-day before summing, for the same reason breakdown() is:
    // this figure has to be the SAME `Staffed For` the DM's table shows, and a
    // duplicated day counted here but not there would put the two screens back
    // into the disagreement this whole change exists to end.
    const seen: Record<string, number> = {};
    (data || []).forEach((r: any) => { seen[`${r.date}|${r.employee}`] = Number(r.goal) || 0; });

    const adjByStart: Record<string, number> = {};
    Object.keys(seen).forEach((k) => {
      const s = mondayOf(k.split("|")[0].slice(0, 10));
      adjByStart[s] = (adjByStart[s] || 0) + seen[k];
    });

    return weeks.map((w) => {
      const t = targetFor(w.week);
      const adjusted = adjByStart[mondayOf(w.week)] || 0;
      return {
        ...w,
        target: t.target,
        // 'set' | 'carried' | 'capacity' — a bar scored against a goal nobody
        // typed for that week says so instead of passing as a clean pass.
        targetSource: t.source,
        targetSetFor: t.setFor,
        adjusted,
        efficiency: adjusted > 0 ? Math.round((w.total / adjusted) * 100) : null,
      };
    });
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
    //
    // It also reports WHERE the number came from, which the bars now show. A
    // carried goal used to be invisible, and that is how OVL came to show three
    // green weeks in a row: no goal was set for the weeks of 17, 24 or 31 August,
    // so all three were scored against the 151 typed on 10 August for a roster
    // the store no longer had. 178, 162 and 190 all cleared it comfortably. The
    // moment a real goal was typed (274, on 7 September) the store went red, and
    // to a manager that looked like the goal had been yanked rather than like
    // three weeks having never been judged against anything current.
    const byWeekStart: Record<string, number> = {};
    goals.forEach((g: any) => { byWeekStart[g.week_start] = g.target; });
    const sortedStarts = Object.keys(byWeekStart).sort();
    const targetForWeekEnd = (endSunday: string) => {
      const start = mondayOf(endSunday);
      if (byWeekStart[start] != null) return { target: byWeekStart[start], source: "set", setFor: start };
      let prior: string | null = null;
      for (const s of sortedStarts) { if (s < start) prior = s; else break; }
      if (prior) return { target: byWeekStart[prior], source: "carried", setFor: prior };
      return { target: cap.goal, source: "capacity", setFor: null };
    };

    return {
      store,
      target,
      base: cap.goal,                    // capacity suggestion / prefill
      suggested: cap.goal,
      // THIS store's stretch factor, and the district default it may or may not
      // be following. Deliberately not inside cfg below: the frontend merges
      // every store's cfg into one shared object (ListingGoalsEngine.
      // applyConfig), so a per-store number in there would leave whichever
      // store's fetch landed last deciding the factor for all five.
      goalFactor: cap.goalFactor,
      districtGoalFactor: cfg.goal_factor,
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
        // The DISTRICT DEFAULT. For anything that has to agree with this store's
        // goal, read goalFactor above instead — these two differ for any store
        // whose factor has been set on its own.
        goal_factor: cfg.goal_factor,
        // Not used in the goal maths — these label the schedule dropdown and the
        // ramp tooltip in User Permissions, so those read the real numbers
        // instead of hard-coding 40 / 20 / 25 / 2 weeks.
        hours_full_time: cfg.hours_full_time,
        hours_part_time: cfg.hours_part_time,
        hours_floater: cfg.hours_floater,
        new_hire_weeks: cfg.new_hire_weeks,
        // The day counts behind the defaults, so the schedule control can show
        // what a type implies ("Part-time · 20h over 4 days") instead of leaving
        // a manager to work out why a part-timer's goal is what it is.
        days_full_time: cfg.days_full_time,
        days_part_time: cfg.days_part_time,
        days_floater: cfg.days_floater,
        max_shift_hours: cfg.max_shift_hours,
      },
      // Who is inside the new-hire ramp this week, so their lister days score at
      // the new-hire rate. Names, because that is what listing_goals keys on.
      newHires: cap.people.filter((p: any) => p.newHire).map((p: any) => p.name),
      // Each person's own day length, so the widget can compute a DAILY goal
      // that agrees with the weekly one. Before this the frontend multiplied
      // cfg.hours_per_day by a seat rate for everybody, which is why a floater on
      // 25 hours and a full-timer on 40 both showed 18 (migration 0091).
      //
      // Shipped as the derived shift rather than as weekly hours ÷ days so the
      // division lives in exactly one place. Keyed by name for the same reason
      // newHires is: listing_goals has no user_id to key on.
      shifts: Object.fromEntries(cap.people.map((p: any) => [p.name, p.shift])),
      manual: !!exact,                   // was THIS week set by hand
      carried: !exact && !!carried,      // running on a previous week's number
      weekStart: thisMonday,
      setBy: exact ? exact.set_by : (carried ? carried.set_by : null),
      setAt: exact ? exact.set_at : (carried ? carried.set_at : null),
      weeks: await weekHistory(store, weeks.slice(-4), targetForWeekEnd),
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

    // One row per person per day, same rule roleweeks has always applied.
    //
    // THIS is where the duplicates did their damage. roleweeks deduped, so the
    // manager's Past Weeks view read correctly; here the rows were summed raw
    // into `adjusted`, which is the Staffed For column and the denominator of the
    // efficiency ratio. A single duplicated day — every one of OVL's six people
    // twice on 2026-09-09 — added 47 to a denominator of 302 and dropped the
    // store's week from 49% to the 42% on the DM's board, with the store's own
    // screen showing no sign of it.
    //
    // Migration 0092 collapsed the duplicates and the unique index stops new
    // ones, so this is belt-and-braces. It stays because the cost is one map and
    // the failure it guards against was invisible for months.
    const byPersonDay: Record<string, any> = {};
    (assigned || []).forEach((r: any) => { byPersonDay[`${r.date}|${r.employee}`] = r; });
    const rows = Object.values(byPersonDay);
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
    // `shift` is the person's own day length now, not cfg.hours_per_day. That
    // constant was the bug: it handed a floater on 25 hours a week and a
    // part-timer on 10 the same 8-hour day as someone on 40, so all three showed
    // 18 on a lister day. See migration 0091.
    const perDay = (role: string, shift: number, isSat: boolean, newHire: boolean) => {
      const r = String(role || "").toUpperCase();
      if (!r || r === "-" || r === "OFF") return 0;
      const rate = dayRate[r] != null
        ? dayRate[r]
        : (newHire ? cfg.rate_new_hire : cfg.rate_lister);   // L1, L2, L3 …
      return Math.round(shift * rate * (isSat ? cfg.saturday_factor : 1) * factorFor(store, cfg));
    };
    // The full-time shift, for the sample row — it is a worked example of the
    // arithmetic, not a figure about any one person.
    const fullShift = cfg.hours_full_time / cfg.days_full_time;

    return {
      store, weekStart, weekEnd: endStr,
      config: cfg,
      goalFactor: factorFor(store, cfg),
      people: cap.people,
      hours: cap.totalHours,
      seats: cap.seats,
      capacity: cap.capacity,
      planned: cap.goal,
      adjusted,
      assignedDays: rows.length,
      offDays,
      actual,
      // True when this week predates the capacity snapshot (0093), so Hours,
      // Ceiling and Goal above were reconstructed from TODAY'S roster rather than
      // read back from the one the week actually had. The figures are the best
      // available, but they are not what the store was shown at the time and the
      // table says so rather than letting them pass as history.
      estimated: !!cap.estimated,
      efficiency: adjusted > 0 ? Math.round((actual / adjusted) * 100) / 100 : null,
      sampleGoals: {
        weekday: { B1: perDay("B1", fullShift, false, false), B2: perDay("B2", fullShift, false, false), L: perDay("L1", fullShift, false, false), newHireLister: perDay("L1", fullShift, false, true) },
        saturday: { B1: perDay("B1", fullShift, true, false), B2: perDay("B2", fullShift, true, false), L: perDay("L1", fullShift, true, false), newHireLister: perDay("L1", fullShift, true, true) },
      },
      sampleShift: round1(fullShift),
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

    // ---- Past weeks: who sat where, and what they listed --------------------
    // Feeds the Listing Goals "Past weeks" view, where a manager or ASM reads the
    // seats each person was given day by day against what they actually listed.
    //
    // The last FOUR FINISHED weeks, newest first. The current week is left out on
    // purpose: its KPI is not filed until Sunday, so a half-week would score
    // every person as far behind.
    //
    // MARKET-wide, not store-only, because of floaters. A floater's KPI is filed
    // under one store for the whole week, however many stores he worked at, so
    // scoring him on one store's days would compare a week of listings to half a
    // week of goals. The client sums a person across the market and paints the
    // days he spent elsewhere as that store's code.
    //
    // Listings are the weekly KPI, the same number breakdown() uses; the daily
    // result column is always 0 and is not read.
    if (action === "roleweeks") {
      if (!store || !STORES.includes(store)) return json({ error: "Unknown store" }, 400);
      const market = marketOf(store);

      const weeks: { weekStart: string; weekEnd: string }[] = [];
      for (let i = 1; i <= 4; i++) {
        const s = new Date(thisMonday + "T00:00:00Z");
        s.setUTCDate(s.getUTCDate() - 7 * i);
        const e = new Date(s);
        e.setUTCDate(e.getUTCDate() + 6);
        weeks.push({ weekStart: s.toISOString().split("T")[0], weekEnd: e.toISOString().split("T")[0] });
      }
      const from = weeks[weeks.length - 1].weekStart;
      const to = weeks[0].weekEnd;

      const [{ data: goalRows }, { data: kpiRows }] = await Promise.all([
        supabase
          .from("listing_goals")
          .select("date, store, employee, role, goal, created_at")
          .in("store", market)
          .gte("date", from)
          .lte("date", to)
          .order("created_at", { ascending: true }),
        supabase
          .from("kpi_entries")
          .select("period_end_date, store, employee_name, listed_count")
          .in("store", market)
          .eq("period_type", "weekly")
          .in("period_end_date", weeks.map((w) => w.weekEnd)),
      ]);

      // One row per person per day, keyed so the latest insert wins.
      //
      // This used to be a workaround: the goal POST deleted a day and re-inserted
      // it, so two saves racing each other left the same person on the day twice.
      // That is fixed at the source now — the POST upserts, against the unique
      // index from migration 0092 — and the duplicates already in the table were
      // collapsed by the same migration.
      //
      // Kept anyway. It costs one map and it is the only reason this view was
      // reading correctly while breakdown(), which summed the same rows without
      // it, was quietly double-counting a duplicated day into `Staffed For`.
      // Deduping where rows are consumed is cheap insurance against the next
      // writer that forgets.
      const byKey: Record<string, any> = {};
      (goalRows || []).forEach((r: any) => {
        byKey[`${r.date}|${r.store}|${r.employee}`] = {
          date: r.date, store: r.store, employee: r.employee,
          role: String(r.role || "").toUpperCase(), goal: Number(r.goal) || 0,
        };
      });

      return json({
        store,
        market,
        weeks,
        goals: Object.values(byKey),
        listed: (kpiRows || []).map((r: any) => ({
          weekEnd: r.period_end_date, store: r.store,
          employee: r.employee_name, listed: Number(r.listed_count) || 0,
        })),
      });
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
      // A store means "set this store's own factor". No store means "move the
      // district default", which every store that has never been set on its own
      // then follows. The UI sends a store; the storeless form is kept because it
      // is what an older cached client sends.
      const target = body.store ? String(body.store).toUpperCase() : null;
      if (target && !STORES.includes(target)) return json({ error: "Unknown store" }, 400);
      const key = target ? "goal_factor_" + target : "goal_factor";

      // Update, then insert only if there was nothing to update: a store's row
      // does not exist until its factor is first moved off the district default.
      // Done this way rather than as an upsert so an existing row keeps the note
      // that explains it — the whole point of that column.
      const { data: updated, error: uErr } = await supabase.from("listing_config")
        .update({ value: rounded, updated_at: new Date().toISOString() })
        .eq("key", key).select("key");
      if (uErr) return json({ error: uErr.message }, 500);
      if (!updated || !updated.length) {
        const { error: iErr } = await supabase.from("listing_config").insert({
          key, value: rounded,
          note: target + " weekly goal = its capacity x this. Overrides goal_factor"
            + " for this store only; delete this row to put it back on the district default.",
        });
        if (iErr) return json({ error: iErr.message }, 500);
      }
      _cfg = null;   // the cached config for this request is now stale

      // Re-freeze the current week at the new number, because listing_goal_weeks
      // holds a row per store per week and that row beats the computed
      // suggestion — without this the stores would keep running last Monday's
      // figure and the save would change nothing visible. Past weeks are left
      // exactly as they were: history must not re-colour itself.
      //
      // Only the store that changed. When the DISTRICT default moves, only the
      // stores actually following it — re-freezing a store that has its own
      // factor would jump its goal to the district number, which is the one
      // thing a per-store dial exists to prevent.
      const cfg = await config();
      const touched = target
        ? [target]
        : STORES.filter((s) => !Number.isFinite(cfg["goal_factor_" + s]));
      const applied: Record<string, number> = {};
      for (const s of touched) {
        const cap = capacityFrom(await rosterFor(s), thisMonday, cfg, factorFor(s, cfg));
        applied[s] = cap.goal;
        await supabase.from("listing_goal_weeks").upsert({
          store: s, week_start: thisMonday, target: cap.goal,
          set_by: body.name || "Capacity model", set_at: new Date().toISOString(),
        }, { onConflict: "store,week_start" });
      }
      const factors: Record<string, number> = {};
      STORES.forEach((s) => { factors[s] = factorFor(s, cfg); });
      return json({
        ok: true, store: target, goal_factor: rounded,
        district_goal_factor: cfg.goal_factor, factors, applied,
      });
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
