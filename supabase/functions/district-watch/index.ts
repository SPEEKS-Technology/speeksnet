import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// DISTRICT WATCH — the flag engine, every morning at 6:25am Central.
// ----------------------------------------------------------------------------
// One judgement per store, per metric, per day, written to `watch_flags`. The
// District Command Center's Watch tab reads it back; nothing else does yet.
//
// See supabase/migrations/0097_district_watch.sql for the rule and the WHY
// behind every threshold, and docs/district-watch-plan.md for the whole design.
// The short version of the part that matters, since 0110:
//
//   A store is judged on two facts per metric — is the MONTH under target, and
//   how many open days IN A ROW has it missed. Month fine = ok, or watch at 2+
//   in a row; month under = warn, or critical at 4+ in a row. Listing reads
//   the WEEK to date where the others read the month. A day is bad when it
//   finished under target, literally. The volume-significance gate
//   0097 opened with is retired; see "The rule" below for why.
//
// WHERE THE FIGURES COME FROM
// `day_end_facts` only, written by `day-end-ingest` at 5:05am. This function
// fetches nothing, recomputes nothing upstream and sends no mail. A missed run
// costs a stale board and nothing else; the next run repairs it, because every
// write is an upsert keyed on (day, store, metric).
//
// ⚠️ IT READS A TABLE IT DOES NOT FILL, so running it before day-end-ingest
// does not fail — it would quietly judge the day before. Same trap
// processed-report documents. 6:25 sits 80 minutes behind the 5:05 fill.
//
// ⚠️ MARGIN IS RECOMPUTED FROM est_value AND total_spent, never read out of
// est_margin_pct. Two reasons: that column is a FRACTION (0.52 = 52%) unlike
// most percent columns here, and a window figure has to be dollar-weighted
// rather than an average of daily percentages. Over 14 days the two differ by
// 1.1 points at OVL — enough to move it across a line. 0004_buying_margin.sql
// made the same point about buyers.
//
// Auth: the cron path needs ?secret=. The board path (action:'board') is open
// like every other browser-facing function here, because the secret must stay
// out of the frontend and there is no real identity in this app to check.
// Writing actions all require the secret.
// ============================================================================

const SECRET = "sp33ks-sync-k3y-2026-x9mq";
const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// --- Dates -----------------------------------------------------------------
// The edge runtime is UTC; every date here is an America/Chicago calendar date.
// Same approach as buying-margin — plain math on YYYY-MM-DD, anchored at noon
// UTC so no offset can shift the calendar day.

function centralToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function dayOfWeek(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0 = Sunday
}

// The working week is MONDAY to SATURDAY — Sunday is closed at every store.
// A Sunday maps back to the Monday six days earlier, i.e. to the week that
// has just closed, which is what a listing verdict written on a Sunday is
// about. Listing's frame is the week (0110 — see judgeListing).
function weekStart(iso: string): string {
  return addDays(iso, -((dayOfWeek(iso) + 6) % 7));
}

function monthStart(iso: string): string {
  return iso.slice(0, 7) + "-01";
}

// --- Math ------------------------------------------------------------------

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

// Percentages in the SENTENCE always carry one decimal. r1() is right for the
// stored `value` column — a number — but drops the trailing zero on the way to
// text, and "80% over 12 days" beside "85.7%" reads like a different precision
// of measurement rather than the same one.
const f1 = (n: number) => n.toFixed(1);

const money = (n: number) =>
  "$" + Math.abs(Math.round(n)).toLocaleString("en-US");

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// --- Config ----------------------------------------------------------------

type Config = {
  conv_target: number; margin_target: number; p_threshold: number;
  acute_window: number; acute_needed: number; chronic_window: number;
  gp_short_min: number; gp_short_red: number; gp_day_min: number;
  margin_recover_max: number;
  listing_short_min: number; listing_short_red: number; listing_min_goal: number;
  listing_catchup_mult: number;
  watch_run: number; critical_run: number;
};

// Only reached if the config row is missing. Kept in step with the column
// defaults in 0097, as re-tuned by 0098, 0099, 0100 and 0110. Since 0110 only
// conv_target, margin_target, chronic_window, watch_run and critical_run are
// read; the rest are kept so the table and the old rows still make sense.
const DEFAULTS: Config = {
  conv_target: 85.0, margin_target: 53.0, p_threshold: 0.10,
  acute_window: 3, acute_needed: 2, chronic_window: 7,
  gp_short_min: 750.0, gp_short_red: 1750.0, gp_day_min: 150.0,
  margin_recover_max: 60.0,
  listing_short_min: 25.0, listing_short_red: 200.0, listing_min_goal: 25.0,
  listing_catchup_mult: 1.30,
  watch_run: 2, critical_run: 4,
};

async function getConfig(supabase: any): Promise<Config> {
  const { data } = await supabase.from("watch_config").select("*").eq("id", 1).maybeSingle();
  if (!data) return DEFAULTS;
  return {
    conv_target: num(data.conv_target) || DEFAULTS.conv_target,
    margin_target: num(data.margin_target) || DEFAULTS.margin_target,
    p_threshold: num(data.p_threshold) || DEFAULTS.p_threshold,
    acute_window: num(data.acute_window) || DEFAULTS.acute_window,
    acute_needed: num(data.acute_needed) || DEFAULTS.acute_needed,
    chronic_window: num(data.chronic_window) || DEFAULTS.chronic_window,
    gp_short_min: num(data.gp_short_min) || DEFAULTS.gp_short_min,
    gp_short_red: num(data.gp_short_red) || DEFAULTS.gp_short_red,
    gp_day_min: num(data.gp_day_min) || DEFAULTS.gp_day_min,
    margin_recover_max: num(data.margin_recover_max) || DEFAULTS.margin_recover_max,
    listing_short_min: num(data.listing_short_min) || DEFAULTS.listing_short_min,
    listing_short_red: num(data.listing_short_red) || DEFAULTS.listing_short_red,
    listing_min_goal: num(data.listing_min_goal) || DEFAULTS.listing_min_goal,
    listing_catchup_mult: num(data.listing_catchup_mult) || DEFAULTS.listing_catchup_mult,
    watch_run: num(data.watch_run) || DEFAULTS.watch_run,
    critical_run: num(data.critical_run) || DEFAULTS.critical_run,
  };
}

type Fact = {
  store: string; date: string;
  cust_conv_num: number; cust_conv_den: number;
  est_value: number; total_spent: number;
  devices_lost: number; no_deal_customers: number;
  devices_processed: number;
};

// --- The rule, since 0110 ---------------------------------------------------
// Ethan, 2026-09-23, with MPL at 80.9% month to date, nine misses in a row and
// green on the board: "on target needs to be MTD good and they don't have 2+
// days in a row of bad conversion". The whole verdict is now two facts:
//
//   is the MONTH under target?   and   how many OPEN DAYS IN A ROW missed?
//
//   ok        month fine,  fewer than watch_run misses in a row
//   watch     month fine,  watch_run+ in a row      — a bad trend starting
//   warn      month under, fewer than critical_run in a row
//   critical  month under, critical_run+ in a row
//
// The same rule for all three metrics, each in its own unit of a bad day:
// conversion under conv_target, margin under margin_target (dollar-weighted
// for the day), listing under that day's staffed goal.
//
// ⚠️ LITERAL, NO VOLUME TEST, and that is the point of 0110 rather than an
// oversight. Until then a day only counted when its shortfall was bigger than
// chance explains at its volume, and that gate kept MPL green (pooled p 0.114
// against a 0.10 line) while OVL, in the same place for the month, was red.
// The board exists to tell the DM who to call; a rule he can check against a
// day's numbers by eye is worth more to that than one that is statistically
// right and needs explaining. Do not put the binomial back without asking him.
//
// A closed day — no customers, no buying, no goal set — is stepped over. It
// neither extends a run nor breaks one, so a Sunday never resets a store. Runs
// are counted across the month boundary: four bad days either side of the 1st
// are four bad days.
//
// All three metrics are a ratio of two sums — converted/customers, gross
// profit/buy value, processed/goal — which is what lets one judge serve them.
// Every figure is pooled from the sums, never an average of daily percentages.

// WHICH TEST FIRED used to ride on four booleans (0101). They are written
// false now and kept only so rows from before 0110 still read; the board reads
// mtd_under and miss_run instead.
type Verdict = {
  metric: string; state: string;
  value: number | null; target: number;
  sample_n: number | null; sample_k: number | null;
  p_value: number | null; shortfall: number | null;
  acute: boolean; chronic: boolean; month_lost: boolean; drifting: boolean;
  mtd_under: boolean; miss_run: number | null; recent_value: number | null;
  reason: string;
};

const RETIRED = { p_value: null, acute: false, chronic: false, month_lost: false, drifting: false };

type Ratio = { num: number; den: number };

// One metric's view of a day: its two sums, or null for a day with nothing to
// judge.
type DayRatio = (r: Fact) => Ratio | null;

const sumRatio = (rows: Fact[], of: DayRatio): Ratio =>
  rows.reduce((a, r) => {
    const x = of(r);
    return x ? { num: a.num + x.num, den: a.den + x.den } : a;
  }, { num: 0, den: 0 });

// r1 before comparing, so a figure the board prints as "85.0%" can never be
// judged under an 85.0% target.
const ratioPct = (x: Ratio): number | null => (x.den > 0 ? r1((x.num / x.den) * 100) : null);

// Open days in a row, counting back from the judged day, that finished under
// target. `rows` oldest first.
function missRun(rows: Fact[], of: DayRatio, target: number): number {
  let n = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const x = of(rows[i]);
    if (!x || x.den <= 0) continue;
    if (r1((x.num / x.den) * 100) >= target) break;
    n++;
  }
  return n;
}

function stateFor(mtdUnder: boolean, run: number, cfg: Config): string {
  if (mtdUnder) return run >= cfg.critical_run ? "critical" : "warn";
  return run >= cfg.watch_run ? "watch" : "ok";
}

function runWords(run: number, what: string): string {
  if (run === 0) return `Made ${what} on its last day open.`;
  if (run === 1) return `Missed ${what} on its last day open.`;
  return `Missed ${what} ${run} open days in a row.`;
}

type Judged = {
  mtd: Ratio; recent: Ratio;
  mtdPct: number | null; recentPct: number | null;
  mtdUnder: boolean; run: number; state: string;
};

function judge(
  all: Fact[], mtdRows: Fact[], recentRows: Fact[], of: DayRatio, target: number, cfg: Config,
): Judged {
  const mtd = sumRatio(mtdRows, of);
  const recent = sumRatio(recentRows, of);
  const mtdPct = ratioPct(mtd);
  const recentPct = ratioPct(recent);
  // A month with nothing in it yet (the 1st falling on a Sunday) is not under.
  const mtdUnder = mtdPct !== null && mtdPct < target;
  const run = missRun(all, of, target);
  return { mtd, recent, mtdPct, recentPct, mtdUnder, run, state: stateFor(mtdUnder, run, cfg) };
}

const recentWords = (j: Judged, win: number, suffix = "") =>
  j.recentPct === null ? "" : ` ${f1(j.recentPct)}%${suffix} over the last ${win} days.`;

// --- Conversion -------------------------------------------------------------

const convOf: DayRatio = (r) =>
  num(r.cust_conv_den) > 0 ? { num: num(r.cust_conv_num), den: num(r.cust_conv_den) } : null;

function judgeConversion(all: Fact[], mtd: Fact[], recent: Fact[], cfg: Config): Verdict {
  const target = cfg.conv_target;
  const j = judge(all, mtd, recent, convOf, target, cfg);
  const base = {
    metric: "conversion", target, ...RETIRED,
    mtd_under: j.mtdUnder, miss_run: j.run, recent_value: j.recentPct,
  };
  if (j.mtdPct === null) {
    return { ...base, state: j.state, value: null, sample_n: 0, sample_k: 0, shortfall: null,
      reason: `No customers recorded this month yet. ${runWords(j.run, "target")}` };
  }
  // Customers short of where the target would have put the month. Never
  // negative — a store ahead is "on target", not "-4 short".
  const short = Math.max(0, Math.round((target / 100) * j.mtd.den - j.mtd.num));
  return {
    ...base, state: j.state,
    value: j.mtdPct, sample_n: j.mtd.den, sample_k: j.mtd.num, shortfall: short,
    reason: `${f1(j.mtdPct)}% for the month — ${j.mtd.num} of ${j.mtd.den} customers`
      + (short > 0 ? `, ${short} ${plural(short, "customer", "customers")} short of ${f1(target)}%.` : ".")
      + recentWords(j, cfg.chronic_window) + " " + runWords(j.run, "target"),
  };
}

// --- Margin -----------------------------------------------------------------
// ⚠️ RECOMPUTED FROM est_value AND total_spent (see the file header), and a
// day's margin is its own dollar-weighted figure. Gross profit is value - cost,
// so the ratio is (value - cost) / value.

const marginOf: DayRatio = (r) => {
  const v = num(r.est_value);
  return v > 0 ? { num: v - num(r.total_spent), den: v } : null;
};

function judgeMargin(all: Fact[], mtd: Fact[], recent: Fact[], cfg: Config): Verdict {
  const target = cfg.margin_target;
  const j = judge(all, mtd, recent, marginOf, target, cfg);
  const base = {
    metric: "margin", target, ...RETIRED,
    mtd_under: j.mtdUnder, miss_run: j.run, recent_value: j.recentPct,
  };
  if (j.mtdPct === null) {
    return { ...base, state: j.state, value: null, sample_n: 0, sample_k: null, shortfall: null,
      reason: `No buying recorded this month yet. ${runWords(j.run, "target")}` };
  }
  // Gross profit short of target for the month, in dollars. Negative = ahead;
  // the board words it, never prints the sign.
  const gpShort = (target / 100) * j.mtd.den - j.mtd.num;
  return {
    ...base, state: j.state,
    value: j.mtdPct, sample_n: Math.round(j.mtd.den), sample_k: null, shortfall: Math.round(gpShort),
    reason: `${f1(j.mtdPct)}% for the month on ${money(j.mtd.den)} of buying — `
      + `${money(gpShort)} of gross profit ${gpShort > 0 ? "behind" : "ahead of"} ${f1(target)}%.`
      + recentWords(j, cfg.chronic_window) + " " + runWords(j.run, "target"),
  };
}

// --- Listing, against each day's staffed goal, by the WEEK --------------------
// listing_goals holds one goal per person per day; a store-day's goal is its
// roster's sum. Since 0110 listing runs the same rule as the other two, on a
// daily-goal basis (Ethan: "Listing should apply the same, but be on a daily
// goal basis"): a bad day is one that finished under its own goal.
//
// ⚠️ THE FRAME IS THE WEEK, NOT THE MONTH — the one place listing differs.
// Ethan, 2026-09-23, the same day: "the left column should be daily tracked
// against the week". Listing is managed week to week off the rota, so the
// "month" half of the rule is WEEK TO DATE here: devices processed Monday
// through the judged day against the goal set for those days. The run of
// missed days is still daily and still crosses the week boundary, exactly as
// the other two cross the month. A Sunday judged day belongs to the week that
// has just closed (see weekStart). 0100's catch-up test stays retired.
//
// ⚠️ ONLY DAYS THAT HAVE A GOAL COUNT, on both sides of the ratio and in the
// run. A day nobody filled the rota in for is not a day the store listed
// nothing — counting its devices against a zero goal would flatter the store,
// and calling it a miss would damn it for a missing spreadsheet row.
//
// ⚠️ THIS READS HARSHER THAN THE STORE EFFICIENCY BOARD and that is not a bug
// to fix here. devices_processed comes from the Day End Report and runs 15-30%
// below the manager-filed kpi_entries.listed_count the efficiency board scores
// (0095). The UI carries a note saying so; do not quietly swap the source to
// make the two agree without reading 0095 first.

function judgeListing(
  all: Fact[], week: Fact[], recent: Fact[], goals: Record<string, number>, cfg: Config,
): Verdict {
  const target = 100;
  const listOf: DayRatio = (r) => {
    const g = num(goals[r.date]);
    return g > 0 ? { num: num(r.devices_processed), den: g } : null;
  };
  const j = judge(all, week, recent, listOf, target, cfg);
  const base = {
    metric: "listing", target, ...RETIRED,
    mtd_under: j.mtdUnder, miss_run: j.run, recent_value: j.recentPct,
  };
  if (j.mtdPct === null) {
    return { ...base, state: j.state, value: null, sample_n: 0, sample_k: 0, shortfall: null,
      reason: `No listing goals set this week yet. ${runWords(j.run, "its goal")}` };
  }
  const short = Math.round(j.mtd.den - j.mtd.num);
  return {
    ...base, state: j.state,
    value: j.mtdPct, sample_n: j.mtd.den, sample_k: j.mtd.num, shortfall: short,
    reason: `${j.mtd.num} listed against ${j.mtd.den} staffed for this week (${f1(j.mtdPct)}% of goal) — `
      + (short > 0 ? `${short} devices short.` : short < 0 ? `${-short} over.` : "on goal.")
      + recentWords(j, cfg.chronic_window, " of goal") + " " + runWords(j.run, "its goal"),
  };
}

// --- The guardrail ----------------------------------------------------------
// Margin rising while conversion falls means margin was bought by walking
// deals. speeks.js:42357 already carries this for the weekly buyer report and
// it reads the same at store level. It is a NOTE, never a flag — "you are
// making your margin by turning people away" is a different conversation from
// "your margin is low", and folding it into a state would merge the two.
function guardrailNote(rows: Fact[]): string | null {
  const half = Math.floor(rows.length / 2);
  if (half < 3) return null;
  const older = rows.slice(0, half);
  const newer = rows.slice(half);

  const mg = (rs: Fact[]) => {
    const v = rs.reduce((a, r) => a + num(r.est_value), 0);
    const c = rs.reduce((a, r) => a + num(r.total_spent), 0);
    return v > 0 ? ((v - c) / v) * 100 : null;
  };
  const cv = (rs: Fact[]) => {
    const n = rs.reduce((a, r) => a + num(r.cust_conv_den), 0);
    const k = rs.reduce((a, r) => a + num(r.cust_conv_num), 0);
    return n > 0 ? (k / n) * 100 : null;
  };

  const m0 = mg(older), m1 = mg(newer), c0 = cv(older), c1 = cv(newer);
  if (m0 === null || m1 === null || c0 === null || c1 === null) return null;

  if (m1 - m0 > 1 && c0 - c1 > 3) {
    return `Margin rose ${r1(m1 - m0)} pts while conversion fell ${r1(c0 - c1)} — check they aren't walking deals.`;
  }
  return null;
}

// --- One store, one day -----------------------------------------------------

async function evaluateStore(
  supabase: any, store: string, day: string, cfg: Config,
): Promise<Verdict[]> {
  // 45 days back: enough for any month to date (the 1st is at most 30 days
  // behind the judged day) plus a run that started in the month before. The
  // run needs history past the month start, or every store would reset on the
  // 1st and a four-day slide across it would read as a fresh start.
  const from = addDays(day, -44);
  const recentFrom = addDays(day, -(cfg.chronic_window - 1));
  const mStart = monthStart(day);

  const { data: win } = await supabase
    .from("day_end_facts")
    .select("store,date,cust_conv_num,cust_conv_den,est_value,total_spent,devices_lost,no_deal_customers,devices_processed")
    .eq("store", store).gte("date", from).lte("date", day).order("date");

  // The staffed goal, one row per PERSON per day, summed to a store-day here.
  const { data: goalRows } = await supabase
    .from("listing_goals")
    .select("date,goal")
    .eq("store", store).gte("date", from).lte("date", day);

  const goals: Record<string, number> = {};
  for (const g of goalRows || []) goals[g.date] = (goals[g.date] || 0) + num(g.goal);

  const all: Fact[] = (win || []) as Fact[];
  const mtd = all.filter((r) => r.date >= mStart);
  const recent = all.filter((r) => r.date >= recentFrom);
  const week = all.filter((r) => r.date >= weekStart(day));

  const verdicts = [
    judgeConversion(all, mtd, recent, cfg),
    judgeMargin(all, mtd, recent, cfg),
    judgeListing(all, week, recent, goals, cfg),
  ];

  // The note rides on whichever metric it is about, so it cannot be seen
  // without the number it qualifies. Read over the recent window, halves of
  // which are three open days at chronic_window 7 — the least it will judge.
  const note = guardrailNote(recent);
  if (note) {
    const m = verdicts.find((v) => v.metric === "margin");
    if (m) m.reason = m.reason + " " + note;
  }

  return verdicts;
}

// Streak = how many days this store has already been in this state for this
// metric. Read from yesterday's row rather than recounted, so the number is
// O(1) and a backfill that walks forward builds it correctly day by day.
async function writeVerdicts(
  supabase: any, store: string, day: string, verdicts: Verdict[],
): Promise<void> {
  const prevDay = addDays(day, -1);
  const { data: prev } = await supabase
    .from("watch_flags").select("metric,state,streak")
    .eq("store", store).eq("day", prevDay);

  const prevBy: Record<string, { state: string; streak: number }> = {};
  for (const r of prev || []) prevBy[r.metric] = { state: r.state, streak: num(r.streak) };

  const rows = verdicts.map((v) => {
    const p = prevBy[v.metric];
    const streak = p && p.state === v.state ? p.streak + 1 : 1;
    return {
      day, store, metric: v.metric, state: v.state,
      value: v.value, target: v.target,
      sample_n: v.sample_n, sample_k: v.sample_k,
      p_value: v.p_value, shortfall: v.shortfall,
      acute: v.acute, chronic: v.chronic,
      month_lost: v.month_lost, drifting: v.drifting,
      mtd_under: v.mtd_under, miss_run: v.miss_run, recent_value: v.recent_value,
      streak,
      // The streak belongs in the sentence, not beside it — "14th day running"
      // is most of what makes a flag actionable.
      reason: streak > 1 && v.state !== "ok"
        ? `${v.reason} Flagged ${streak} days running.`
        : v.reason,
      computed_at: new Date().toISOString(),
    };
  });

  const { error } = await supabase
    .from("watch_flags").upsert(rows, { onConflict: "day,store,metric" });
  if (error) throw new Error(`${store} ${day}: ${error.message}`);
}

async function runDay(supabase: any, day: string, stores: string[], cfg: Config) {
  const results: any[] = [];
  const failures: any[] = [];
  for (const store of stores) {
    // One bad store must not abort the other four.
    try {
      const verdicts = await evaluateStore(supabase, store, day, cfg);
      await writeVerdicts(supabase, store, day, verdicts);
      results.push({
        store,
        states: Object.fromEntries(verdicts.map((v) => [v.metric, v.state])),
      });
    } catch (e: any) {
      failures.push({ store, error: e?.message || String(e) });
    }
  }
  return { day, results, failures };
}

// ============================================================================

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const authed = url.searchParams.get("secret") === SECRET;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: any = {};
  if (req.method === "POST") {
    try { body = JSON.parse((await req.text()) || "{}"); } catch { body = {}; }
  }
  // A cron GET with no body still means "run".
  const action = String(body.action || (authed ? "run" : "board"));

  try {
    const cfg = await getConfig(supabase);

    // ---- Nightly run. Judges YESTERDAY: today's Day End Report does not exist
    // until tonight, so "today" would always be an empty day dressed up as a
    // perfect one. ------------------------------------------------------------
    if (action === "run") {
      if (!authed) return json({ error: "unauthorized" }, 401);
      const day = body.day ? String(body.day) : addDays(centralToday(), -1);
      const stores = Array.isArray(body.stores) && body.stores.length
        ? body.stores.map((s: string) => String(s).toUpperCase())
        : STORES;
      const out = await runDay(supabase, day, stores, cfg);
      return json({ success: true, ...out });
    }

    // ---- Backfill. Walks FORWARD, oldest first, because writeVerdicts reads
    // the previous day to extend a streak — running it backwards would give
    // every row a streak of 1. -------------------------------------------------
    if (action === "backfill") {
      if (!authed) return json({ error: "unauthorized" }, 401);
      const to = body.to ? String(body.to) : addDays(centralToday(), -1);
      const from = body.from ? String(body.from) : addDays(to, -41);
      const days: any[] = [];
      let cur = from;
      let guard = 0;
      while (cur <= to && guard++ < 400) {
        days.push(await runDay(supabase, cur, STORES, cfg));
        cur = addDays(cur, 1);
      }
      return json({
        success: true, from, to, days: days.length,
        failures: days.flatMap((d) => d.failures),
      });
    }

    // ---- The board. Latest judged day for all stores, plus the daily series
    // the sparklines draw. One call, because two would let the tiles and the
    // trend lines disagree about which day is the latest. ----------------------
    if (action === "board") {
      const { data: latest } = await supabase
        .from("watch_flags").select("day").order("day", { ascending: false }).limit(1);
      const day = latest && latest.length ? latest[0].day : addDays(centralToday(), -1);

      const { data: flags } = await supabase
        .from("watch_flags").select("*").eq("day", day);

      // 21 days: the board draws a chronic_window sparkline and yesterday's
      // figures, and the store popup reads the last 7 out of the same array.
      // One fetch, one source — two would let the row and the popup behind it
      // disagree about a day.
      const sparkFrom = addDays(day, -20);
      const { data: series } = await supabase
        .from("day_end_facts")
        .select("store,date,cust_conv_num,cust_conv_den,est_value,total_spent,devices_lost,no_deal_customers,devices_processed,processed_value")
        .gte("date", sparkFrom).lte("date", day).order("date");

      const { data: mtd } = await supabase
        .from("day_end_facts")
        .select("store,cust_conv_num,cust_conv_den,est_value,total_spent")
        .gte("date", monthStart(day)).lte("date", day);

      // Listing goals for the popup's third tab, and for the board's own sense
      // of the week. Summed per store per day HERE because listing_goals holds
      // one row per PERSON per day (~600 rows over this window) and the board
      // only ever wants the store's total. Fetched through SATURDAY so the
      // front end can say what is left of the week, as the engine does.
      //
      // ⚠️ READS HARSHER THAN THE EFFICIENCY BOARD. 0095 records that
      // devices_processed and the manager-filed kpi_entries.listed_count
      // disagree by 15-30% at every store. It IS flagged (0099 added the
      // state, 0110 moved it onto daily goals) — but do not quietly swap
      // the source to make the two boards agree without reading 0095 first.
      const goalTo = addDays(weekStart(day), 5);
      const { data: goalRows } = await supabase
        .from("listing_goals")
        .select("store,date,goal")
        .gte("date", sparkFrom).lte("date", goalTo > day ? goalTo : day);

      const goalBy: Record<string, number> = {};
      for (const g of goalRows || []) {
        const k = `${g.store}|${g.date}`;
        goalBy[k] = (goalBy[k] || 0) + num(g.goal);
      }
      const goals = Object.keys(goalBy).map((k) => {
        const [store, date] = k.split("|");
        return { store, date, goal: goalBy[k] };
      });

      return json({
        success: true, day, config: cfg, week_start: weekStart(day),
        flags: flags || [], series: series || [], mtd: mtd || [], goals,
      });
    }

    // ---- One store's history, for a drill-down. ------------------------------
    if (action === "history") {
      const store = String(body.store || "").toUpperCase();
      const metric = String(body.metric || "conversion");
      if (!STORES.includes(store)) return json({ error: "unknown store" }, 400);
      const { data } = await supabase
        .from("watch_flags").select("*")
        .eq("store", store).eq("metric", metric)
        .order("day", { ascending: false }).limit(90);
      return json({ success: true, store, metric, rows: data || [] });
    }

    // ---- DM re-tunes the thresholds. No deploy needed, which is the point of
    // the config table existing at all. ---------------------------------------
    if (action === "save_config") {
      if (!authed) return json({ error: "unauthorized" }, 401);
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const k of [
        "conv_target", "margin_target", "p_threshold",
        "acute_window", "acute_needed", "chronic_window",
        "gp_short_min", "gp_short_red", "gp_day_min", "margin_recover_max",
        "listing_short_min", "listing_short_red", "listing_min_goal",
        "listing_catchup_mult", "watch_run", "critical_run",
      ]) {
        if (body[k] !== undefined && body[k] !== null && body[k] !== "") patch[k] = Number(body[k]);
      }
      if (body.by) patch.updated_by = String(body.by).trim();
      const { error } = await supabase.from("watch_config").update(patch).eq("id", 1);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true, config: await getConfig(supabase) });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500);
  }
});
