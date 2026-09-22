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
// The short version of the part that matters:
//
//   A day counts as "under target" only when the shortfall is bigger than
//   chance explains AT THAT DAY'S VOLUME. 4 of 5 customers is not a bad day;
//   14 of 20 is. Measured on 43 real days, that is the difference between MPL
//   looking bad 18 times and looking bad once — and once is the truth.
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
// about: there is nothing left of that week to catch up in.
function weekStart(iso: string): string {
  return addDays(iso, -((dayOfWeek(iso) + 6) % 7));
}

// "Sat 19". Only ever used inside a sentence that already establishes the
// month, so the month is left out — toLocaleDateString is avoided here for the
// same reason every other date in this file avoids it: the runtime is UTC and
// these are Central calendar dates.
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function shortDay(iso: string): string {
  return `${DOW_SHORT[dayOfWeek(iso)]} ${Number(iso.slice(8))}`;
}

function monthStart(iso: string): string {
  return iso.slice(0, 7) + "-01";
}

function monthEnd(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month
  return `${iso.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

// Sunday is closed at every store (same rule cash-report and processed-report
// use), so "open days left" never counts one.
function openDaysBetween(fromExclusive: string, toInclusive: string): number {
  let n = 0;
  let cur = addDays(fromExclusive, 1);
  while (cur <= toInclusive) {
    if (dayOfWeek(cur) !== 0) n++;
    cur = addDays(cur, 1);
  }
  return n;
}

// --- Math ------------------------------------------------------------------

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

// Percentages in the SENTENCE always carry one decimal. r1() is right for the
// stored `value` column — a number — but drops the trailing zero on the way to
// text, and "80% over 12 days" beside "85.7%" reads like a different precision
// of measurement rather than the same one.
const f1 = (n: number) => n.toFixed(1);

// Log-factorials, memoised. Done in logs rather than with a plain factorial
// because the pooled window reaches n ~ 300: 300! overflows a double long
// before the binomial coefficient does anything useful, and the naive product
// silently returns Infinity/NaN rather than failing.
const LOG_FACT: number[] = [0];
function logFact(n: number): number {
  while (LOG_FACT.length <= n) {
    LOG_FACT.push(LOG_FACT[LOG_FACT.length - 1] + Math.log(LOG_FACT.length));
  }
  return LOG_FACT[n];
}

function logChoose(n: number, k: number): number {
  return logFact(n) - logFact(k) - logFact(n - k);
}

// One-sided binomial: P(X <= k | n, p). "How likely is a result this bad or
// worse, if the store really were performing at target?" Small answer = the
// shortfall is not luck.
//
// Returns null when there is nothing to test. k === n short-circuits to 1
// because a perfect day is never evidence of underperformance, and the loop
// would otherwise spend n terms arriving at the same place.
function binomCdf(k: number, n: number, p: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (k >= n) return 1;
  if (k < 0) return 0;
  let sum = 0;
  const lp = Math.log(p);
  const lq = Math.log(1 - p);
  for (let i = 0; i <= k; i++) {
    sum += Math.exp(logChoose(n, i) + i * lp + (n - i) * lq);
  }
  return Math.min(1, sum);
}

function pct(part: number, whole: number): number | null {
  if (!whole) return null;
  return r1((part / whole) * 100);
}

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
};

// Only reached if the config row is missing. Kept in step with the column
// defaults in 0097, as re-tuned by 0098, 0099 and 0100.
const DEFAULTS: Config = {
  conv_target: 85.0, margin_target: 53.0, p_threshold: 0.10,
  acute_window: 3, acute_needed: 2, chronic_window: 14,
  gp_short_min: 750.0, gp_short_red: 1750.0, gp_day_min: 150.0,
  margin_recover_max: 60.0,
  listing_short_min: 25.0, listing_short_red: 200.0, listing_min_goal: 25.0,
  listing_catchup_mult: 1.30,
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
  };
}

type Fact = {
  store: string; date: string;
  cust_conv_num: number; cust_conv_den: number;
  est_value: number; total_spent: number;
  devices_lost: number; no_deal_customers: number;
  devices_processed: number;
};

// --- Conversion -------------------------------------------------------------

// WHICH TEST FIRED is stored alongside the sentence, not baked into it. The
// board writes a one-line "why" from these four booleans (0101); the sentence
// is kept for the hover and the popup. Storing the facts rather than a second
// short sentence means re-wording the board costs a JS edit, not a redeploy
// and a 47-day re-backfill.
type Verdict = {
  metric: string; state: string;
  value: number | null; target: number;
  sample_n: number | null; sample_k: number | null;
  p_value: number | null; shortfall: number | null;
  acute: boolean; chronic: boolean; month_lost: boolean; drifting: boolean;
  reason: string;
};

// The defaults, so the early returns below do not each have to spell out four
// falses. A metric with nothing to judge is not drifting; it is unknown.
const NO_TESTS = { acute: false, chronic: false, month_lost: false, drifting: false };

// How far a window has to fall within itself before it counts as a trend and
// not as noise. MEASURED, not chosen — the first cut used 2 points for
// conversion and 1 for margin, which turned out to sit near the MEDIAN of
// ordinary variation and marked three of five stores as drifting on a normal
// day. Across 120 days of store-days, older-half minus newer-half comes out:
//
//              p50    p75    p85    p90
//   conversion 0.41   4.49   7.32   8.99
//   margin     0.17   1.49   1.98   2.59
//
// The 90th percentile is the line, so roughly one clear store-day in ten
// carries the annotation. Any lower and "drifting" is on half the board,
// which makes it furniture rather than information.
//
// Not in watch_config, unlike every threshold that can FLAG a store: drift
// only ever annotates a metric that already reads ok, so a wrong value here
// costs a word on the board rather than a store's colour.
const DRIFT_DROP_CONVERSION = 9.0;
const DRIFT_DROP_MARGIN = 2.5;

// Is the window getting worse within itself? Splits it in half and compares.
// This is the one shape the acute test cannot see by construction — it only
// ever looks at three days, so a store that is worse every week while staying
// inside every threshold is invisible to it.
function halfOverHalf(
  vals: number[], minDrop: number,
): boolean {
  if (vals.length < 6) return false;
  const half = Math.floor(vals.length / 2);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  return mean(vals.slice(0, half)) - mean(vals.slice(half)) >= minDrop;
}

function judgeConversion(
  day: string, rows: Fact[], mtd: Fact[], cfg: Config,
): Verdict {
  const target = cfg.conv_target;
  const p = target / 100;

  // Rows are the chronic window, oldest first, days with no customers dropped
  // — a closed or zero-traffic day is not evidence either way, and leaving it
  // in would let a run of quiet days satisfy "2 of the last 3".
  const days = rows.filter((r) => num(r.cust_conv_den) > 0);

  if (!days.length) {
    return {
      metric: "conversion", state: "ok", value: null, target,
      sample_n: 0, sample_k: 0, p_value: null, shortfall: null, ...NO_TESTS,
      reason: "No customers recorded in the window.",
    };
  }

  // Per-day significance. This is the gate that makes 4-of-5 a non-event.
  const scored = days.map((r) => {
    const n = num(r.cust_conv_den), k = num(r.cust_conv_num);
    const pv = binomCdf(k, n, p);
    return { date: r.date, n, k, pv, counting: pv !== null && pv < cfg.p_threshold };
  });

  // ACUTE — was fine, is slipping. "acute_needed of the last acute_window".
  const recent = scored.slice(-cfg.acute_window);
  const recentBad = recent.filter((d) => d.counting).length;
  const acute = recentBad >= cfg.acute_needed;

  // CHRONIC — quietly bad, never spikes. Pool the window and test that.
  // Without this the engine cannot see a store that runs 81% every single day,
  // which is the single most expensive failure mode it has.
  const poolK = scored.reduce((a, d) => a + d.k, 0);
  const poolN = scored.reduce((a, d) => a + d.n, 0);
  const poolPct = pct(poolK, poolN);
  const poolP = binomCdf(poolK, poolN, p);
  const chronic = poolP !== null && poolP < cfg.p_threshold && (poolPct ?? 100) < target;

  // Customers short of where the target would have put them. This is the
  // number worth saying out loud — "7 customers" lands in a way "80.0%" does
  // not. Rounded, never shown negative.
  const shortfall = Math.max(0, Math.round(p * poolN - poolK));

  // RED — the month can no longer be recovered.
  //
  // Only ever applied on top of an existing warn: a store having a merely
  // mathematically-awkward month while performing fine is not a crisis, and
  // projecting off a handful of days produces nonsense, so this also waits for
  // a week of the month to exist.
  const mtdDays = mtd.filter((r) => num(r.cust_conv_den) > 0);
  const mtdK = mtdDays.reduce((a, r) => a + num(r.cust_conv_num), 0);
  const mtdN = mtdDays.reduce((a, r) => a + num(r.cust_conv_den), 0);
  const elapsed = mtdDays.length;
  const left = openDaysBetween(day, monthEnd(day));

  let required: number | null = null;
  if ((acute || chronic) && elapsed >= 7 && left > 0 && mtdN > 0) {
    const rate = mtdN / elapsed;               // customers per open day so far
    const projected = mtdN + rate * left;      // where the month is heading on volume
    const needed = p * projected - mtdK;       // conversions still owed
    required = needed / (rate * left);         // ...as a rate on what is left
  }
  // 95% is the line. Not "impossible" — impossible is a rate above 1, and by
  // then the month has been lost for a fortnight. A store being asked to
  // convert better than 95% of everyone left, for every remaining day, has
  // lost the month; saying so on the 20th is the whole point.
  const monthLost = required !== null && required > 0.95;

  const state = monthLost ? "critical" : (acute || chronic) ? "warn" : "ok";

  // Clear, but sliding. Two arms, and the first one's guard matters:
  //
  //   a bad day ONLY counts as drift when the store is also under target for
  //   the window. A store sitting above target with one wobbly day in it is
  //   not sliding, it is a store having a normal fortnight — and saying
  //   otherwise is exactly the noise this whole engine exists to avoid
  //   ("missing one person isn't bad", Ethan, at the start of all this).
  //
  //   the half-over-half arm stands alone, with no such guard, because that IS
  //   the case Ethan asked for: good today and getting worse. A store can be
  //   comfortably above target and still be two points down on where it was a
  //   week ago, and that is worth a word before it becomes a warning.
  const conversionByDay = scored.map((d) => d.n > 0 ? (d.k / d.n) * 100 : target);
  const drifting = state === "ok" && (
    (recentBad >= 1 && (poolPct ?? 100) < target) ||
    halfOverHalf(conversionByDay, DRIFT_DROP_CONVERSION)
  );

  // --- The sentence ---------------------------------------------------------
  let reason: string;
  if (state === "ok") {
    reason = poolPct !== null && poolPct >= target
      ? `On target — ${f1(poolPct)}% over ${days.length} days.`
      : `${f1(poolPct ?? 0)}% over ${days.length} days, but no day is further below target than its volume explains.`;
  } else {
    const bits: string[] = [];
    if (chronic) {
      bits.push(`${f1(poolPct ?? 0)}% over ${days.length} days — ${shortfall} ${plural(shortfall, "customer", "customers")} short of target`);
    }
    if (acute) {
      bits.push(recentBad >= cfg.acute_window
        ? `under target ${recentBad} days running`
        : `under target ${recentBad} of the last ${recent.length} days`);
    }
    reason = bits.join("; ") + ".";
    if (monthLost) {
      // A required rate above 1 is not a rate any more — printing "needs 101%"
      // reads as a rounding bug rather than as the impossibility it is.
      const need = required as number;
      reason += need > 1
        ? ` ${f1(target)}% for the month is now out of reach — even converting everyone left would not close it.`
        : ` The month can no longer reach ${f1(target)}% — that would now need ${Math.round(need * 100)}% on every remaining customer.`;
    }
  }

  return {
    metric: "conversion", state,
    value: poolPct, target,
    sample_n: poolN, sample_k: poolK,
    p_value: poolP === null ? null : r4(poolP),
    shortfall,
    acute, chronic, month_lost: monthLost, drifting,
    reason,
  };
}

// --- Margin -----------------------------------------------------------------
// Judged the way conversion is, since 0100. Ethan, 2026-09-21: "For margin,
// same concept as conversion just with a 53% threshold." So margin now runs
// the same four tests — a per-day gate, an acute test, a chronic test, and a
// month-lost red — rather than the single pooled dollar floor it used to be.
//
// WHY THE SHAPE MATTERS MORE THAN THE FLOOR: a store $900 of gross profit
// behind because of one bad Tuesday and a store $900 behind because it has
// missed every day for a fortnight read identically under a pooled floor, and
// they are not the same conversation.
//
// THE PER-DAY GATE IS THE ONE PART THAT CANNOT BE A STRAIGHT PORT. Conversion
// asks a binomial question — "is this shortfall bigger than chance explains at
// this volume?" — and margin is not a count of successes, so there is no
// distribution to test against. It asks the money question instead: is the day
// at least `gp_day_min` of gross profit behind? Same job, which is to keep a
// day off the board when the miss is too small to mean anything. 0100 has the
// measurement behind $150.

function judgeMargin(
  day: string, rows: Fact[], mtd: Fact[], cfg: Config,
): Verdict {
  const target = cfg.margin_target;
  const p = target / 100;

  // A day with no buying is not evidence either way — dropped, exactly as a
  // day with no customers is dropped from conversion. Leaving them in would
  // let three quiet days satisfy "2 of the last 3".
  const days = rows.filter((r) => num(r.est_value) > 0);

  const value = days.reduce((a, r) => a + num(r.est_value), 0);
  const cost = days.reduce((a, r) => a + num(r.total_spent), 0);

  if (value <= 0) {
    return {
      metric: "margin", state: "ok", value: null, target,
      sample_n: 0, sample_k: null, p_value: null, shortfall: null, ...NO_TESTS,
      reason: "No buying recorded in the window.",
    };
  }

  // Dollar-weighted, as the header insists — never an average of daily
  // percentages.
  const margin = r1(((value - cost) / value) * 100);

  // Gross profit short of target, in dollars. THE ranking number: percentage
  // points ignore volume, and volume is exactly what separates a store worth
  // driving to from one worth a text message. OVL at 50.2% on $91k and LEE at
  // 52.5% on $40k read alike in points and differ nearly fivefold in money.
  const gpShort = p * value - (value - cost);

  // Per-day, the same quantity at one day's scale.
  const scored = days.map((r) => {
    const v = num(r.est_value), c = num(r.total_spent);
    const short = p * v - (v - c);
    return { date: r.date, short, counting: short >= cfg.gp_day_min };
  });

  // ACUTE — was fine, is slipping.
  const recent = scored.slice(-cfg.acute_window);
  const recentBad = recent.filter((d) => d.counting).length;
  const acute = recentBad >= cfg.acute_needed;

  // CHRONIC — quietly under, never spikes. The pooled test, which is what the
  // whole metric used to be.
  const chronic = margin < target && gpShort >= cfg.gp_short_min;

  // RED — the month can no longer be recovered. Only ever on top of a warn,
  // and only once a week of the month exists, both for the reasons conversion
  // gives: projecting off three days produces nonsense, and a store having an
  // awkward month while buying well is not a crisis.
  const mtdDays = mtd.filter((r) => num(r.est_value) > 0);
  const mtdV = mtdDays.reduce((a, r) => a + num(r.est_value), 0);
  const mtdC = mtdDays.reduce((a, r) => a + num(r.total_spent), 0);
  const elapsed = mtdDays.length;
  const left = openDaysBetween(day, monthEnd(day));

  let required: number | null = null;
  if ((acute || chronic) && elapsed >= 7 && left > 0 && mtdV > 0) {
    const rate = mtdV / elapsed;                      // buying value per open day
    const rest = rate * left;                         // value still to come, on that pace
    const needed = p * (mtdV + rest) - (mtdV - mtdC); // gross profit still owed
    required = (needed / rest) * 100;                 // ...as a margin on what is left
  }
  // margin_recover_max is margin's version of conversion's 95% line, and like
  // it, it is a measured ceiling rather than an arithmetic one: 60.0% is the
  // best rolling ten-day margin any store in the district has posted in a
  // year. Being asked to beat the district record every remaining day is what
  // "the month is gone" means in practice.
  const monthLost = required !== null && required > cfg.margin_recover_max;

  const state = monthLost ? "critical" : (acute || chronic) ? "warn" : "ok";

  // Same two arms as conversion's, same guard on the first: BAL at 55.1% with
  // one $164 day in the window is not drifting, it is fine.
  //
  // The trend arm's line is lower than conversion's because margin moves in a
  // narrower band — the whole district lives between 50% and 58% — and the
  // measurement bears that out: margin's 90th-percentile drop is 2.59 points
  // against conversion's 8.99.
  const marginByDay = days.map((r) => {
    const v = num(r.est_value), c = num(r.total_spent);
    return v > 0 ? ((v - c) / v) * 100 : target;
  });
  const drifting = state === "ok" && (
    (recentBad >= 1 && margin < target) ||
    halfOverHalf(marginByDay, DRIFT_DROP_MARGIN)
  );

  // --- The sentence ---------------------------------------------------------
  let reason: string;
  if (state === "ok") {
    reason = margin >= target
      ? `On target — ${f1(margin)}% on ${money(value)} of buying.`
      : `${f1(margin)}% against ${f1(target)}%, but only ${money(gpShort)} of gross profit behind over ${days.length} days.`;
  } else {
    const bits: string[] = [];
    if (chronic) {
      bits.push(`${f1(margin)}% over ${days.length} days — ${money(gpShort)} of gross profit behind on ${money(value)} of buying`);
    }
    if (acute) {
      bits.push(recentBad >= cfg.acute_window
        ? `under ${f1(target)}% ${recentBad} buying days running`
        : `under ${f1(target)}% on ${recentBad} of the last ${recent.length} buying days`);
    }
    reason = bits.join("; ") + ".";
    if (monthLost) {
      const need = required as number;
      reason += need >= 100
        ? ` ${f1(target)}% for the month is now out of reach — even buying the rest of it for nothing would not close the gap.`
        : ` The month can no longer reach ${f1(target)}% — that needs ${f1(need)}% on everything still to be bought, past the ${f1(cfg.margin_recover_max)}% ceiling.`;
    }
  }

  return {
    metric: "margin", state,
    value: margin, target,
    sample_n: Math.round(value), sample_k: null,
    p_value: null,
    shortfall: Math.round(gpShort),
    acute, chronic, month_lost: monthLost, drifting,
    reason,
  };
}

// --- Listing productivity, by the working week ------------------------------
// "Did the store list what it was STAFFED to list, THIS WEEK?" listing_goals
// holds one goal per person per day, so a store's staffed goal for a day is
// its roster's sum.
//
// THE FRAME IS THE WEEK, NOT A ROLLING WINDOW, since 0100. Ethan, 2026-09-21:
// "for listing per week, warning needs to be if they are behind on goal and it
// switches to critical if they realistically based on our set daily goals
// can't catch up by end of day saturday." A rolling 14-day window straddles
// two weeks, and "240 devices short over eleven days" is not a number anybody
// can act on on a Wednesday. A week can still be saved while it is running.
//
// MONDAY TO SATURDAY. Sunday is closed at every store — openDaysBetween
// already knew that — and "end of day saturday" is Ethan's own framing. A
// Sunday judged day therefore belongs to the week that has just closed, which
// is right: nothing is left to catch up with.
//
// CRITICAL IS A CAPACITY TEST, NOT A BIGGER NUMBER. The question is whether
// the days still to come can absorb the shortfall, so it is measured against
// the goals still to come: a store can be assumed to claw back
// `listing_catchup_mult` - 1 of the goal remaining, and no more. 1.30 is
// measured over RUNS of days, which is what catching up actually asks for: on
// 196 three-day runs, processed over goal comes out at 0.84 median, 1.15 at
// the 75th percentile, 1.48 at the 90th. 1.30 is a pace a store manages about
// one week in five. The single-DAY figure is much higher (p90 1.89, max 5.11)
// and would have been the wrong number to reach for — one big day is not a
// week of recovery.
//
// ⚠️ ONLY DAYS THAT HAVE A GOAL COUNT, on both sides of the ratio. A day nobody
// filled the rota in for is not a day the store listed nothing — counting its
// processed devices against a goal of zero would flatter the store, and
// counting a zero goal as a target would be meaningless. Both are dropped.
// Days still to come are different: an unfilled future day is rota that has
// not been written yet, so it is estimated at this store's own average for the
// week rather than treated as zero capacity, which would make every Monday
// critical.
//
// ⚠️ THIS READS HARSHER THAN THE STORE EFFICIENCY BOARD and that is not a bug
// to fix here. devices_processed comes from the Day End Report and runs 15-30%
// below the manager-filed kpi_entries.listed_count the efficiency board scores
// (0095). The UI carries a note saying so; do not quietly swap the source to
// make the two agree without reading 0095 first.
function judgeListing(
  day: string, rows: Fact[], goals: Record<string, number>, cfg: Config,
): Verdict {
  const wkStart = weekStart(day);
  const wkEnd = addDays(wkStart, 5); // Monday + 5 = Saturday

  const scored = rows
    .filter((r) => r.date >= wkStart && r.date <= day)
    .map((r) => ({ goal: num(goals[r.date]), proc: num(r.devices_processed) }))
    .filter((d) => d.goal > 0);

  const goalTot = scored.reduce((a, d) => a + d.goal, 0);
  const procTot = scored.reduce((a, d) => a + d.proc, 0);

  if (!scored.length || goalTot < cfg.listing_min_goal) {
    return {
      metric: "listing", state: "ok", value: null, target: 100,
      sample_n: goalTot, sample_k: procTot, p_value: null, shortfall: null, ...NO_TESTS,
      reason: goalTot > 0
        ? `Only ${Math.round(goalTot)} devices of goal set so far this week — too little of the rota filled in to judge.`
        : "No listing goals set this week.",
    };
  }

  const pctGoal = r1((procTot / goalTot) * 100);
  const short = Math.round(goalTot - procTot);

  // What is left of the week, and what it could hold.
  const avgGoal = goalTot / scored.length;
  let restGoal = 0, restDays = 0;
  for (let d = addDays(day, 1); d <= wkEnd; d = addDays(d, 1)) {
    if (dayOfWeek(d) === 0) continue; // closed
    restDays++;
    const set = num(goals[d]);
    restGoal += set > 0 ? set : avgGoal;
  }

  // A CLOSED WEEK IS GRADED, NOT ESCALATED. Once Saturday has gone there is
  // nothing left to absorb a shortfall, so "they cannot catch up" is trivially
  // true of every miss — and judged that way, two mornings in seven turn every
  // store that missed by a device into a red. Measured over six weeks: 28 of
  // the 73 reds the first cut produced were Saturdays and Sundays.
  //
  // So a finished week is graded on the same yardstick applied to the whole
  // week rather than to what is left of it: was the miss bigger than a full
  // week of catching up would have covered? MPL closing 36 behind on a goal of
  // 154 is a warning; OVL closing 85 behind on 190 is not.
  const closed = restDays === 0;
  const room = Math.round((closed ? goalTot : restGoal) * (cfg.listing_catchup_mult - 1));

  const behind = short >= cfg.listing_short_min;
  const state = behind ? (short > room ? "critical" : "warn") : "ok";

  const left = `${restDays} ${plural(restDays, "day", "days")} left`;
  // The judged day and the week it is about are not the same thing on a
  // Sunday, when the board says "through Sun 20" and this sentence is about
  // the week that ended on the Saturday. Naming the date closes that gap.
  const wkTo = closed ? ` to ${shortDay(wkEnd)}` : "";

  let reason: string;
  if (state === "ok") {
    const frame = closed ? `the week${wkTo}` : "the week so far";
    reason = short <= 0
      ? `Cleared the staffed goal for ${frame} — ${procTot} listed against ${goalTot} set (${f1(pctGoal)}%).`
      : `${procTot} listed against ${goalTot} staffed for over ${frame} (${f1(pctGoal)}%), ${short} short — inside the margin worth raising.`;
  } else if (closed) {
    reason = `The week${wkTo} closed ${short} devices short — ${procTot} listed against the ${goalTot} the store was staffed for (${f1(pctGoal)}%).`
      + (state === "critical" ? " More than a full week of catching up would have covered." : "");
  } else {
    const head = `${procTot} listed against ${goalTot} the store was staffed for this week — `
      + `${short} devices short (${f1(pctGoal)}% of goal)`;
    reason = state === "critical"
      ? `${head}, with only ${left} and room for about ${room} of catch-up in them.`
      : `${head}, ${left} to make it up.`;
  }

  return {
    metric: "listing", state,
    value: pctGoal, target: 100,
    sample_n: goalTot, sample_k: procTot,
    p_value: null,
    shortfall: short,
    // Listing has no acute/chronic split — one frame, the week. It is chronic
    // when it is flagged at all, and red when the week cannot be recovered.
    acute: false,
    chronic: state !== "ok",
    month_lost: state === "critical",
    // Behind the goal, but by less than the floor: the "inside the margin
    // worth raising" case, which the sentence described and nothing made
    // scannable.
    drifting: state === "ok" && short > 0,
    reason,
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
  const from = addDays(day, -(cfg.chronic_window - 1));

  const { data: win } = await supabase
    .from("day_end_facts")
    .select("store,date,cust_conv_num,cust_conv_den,est_value,total_spent,devices_lost,no_deal_customers,devices_processed")
    .eq("store", store).gte("date", from).lte("date", day).order("date");

  const { data: mtd } = await supabase
    .from("day_end_facts")
    .select("store,date,cust_conv_num,cust_conv_den,est_value,total_spent")
    .eq("store", store).gte("date", monthStart(day)).lte("date", day).order("date");

  // The staffed goal, one row per PERSON per day, summed to a store-day here.
  // Fetched THROUGH SATURDAY, not through the judged day: the listing verdict
  // asks what the rest of the week is staffed for, which is a question about
  // days that have not happened yet.
  const weekEnd = addDays(weekStart(day), 5);
  const { data: goalRows } = await supabase
    .from("listing_goals")
    .select("date,goal")
    .eq("store", store).gte("date", from).lte("date", weekEnd > day ? weekEnd : day);

  const goals: Record<string, number> = {};
  for (const g of goalRows || []) goals[g.date] = (goals[g.date] || 0) + num(g.goal);

  const rows: Fact[] = (win || []) as Fact[];

  const verdicts = [
    judgeConversion(day, rows, (mtd || []) as Fact[], cfg),
    judgeMargin(day, rows, (mtd || []) as Fact[], cfg),
    judgeListing(day, rows, goals, cfg),
  ];

  // The note rides on whichever metric it is about, so it cannot be seen
  // without the number it qualifies.
  const note = guardrailNote(rows);
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

      // 21 days, because the board draws a 12-day sparkline and the store
      // popup reads the last 7 out of the same array. One fetch, one source —
      // two would let the row and the popup behind it disagree about a day.
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
      // state, 0100 moved it onto the working week) — but do not quietly swap
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
        "listing_catchup_mult",
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
