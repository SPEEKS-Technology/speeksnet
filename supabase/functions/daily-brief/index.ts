// ============================================================================
// daily-brief — drafts the DM's morning store messages for review.
//
// Flow:  pg_cron 7:15am Central  ->  this function  ->  comment_drafts
//        ->  Action Menu feed card  ->  he edits/approves  ->  store_comments
//
// Two halves, deliberately split:
//
//   1. The RULE ENGINE decides *whether* a store gets a message and *what it is
//      about*. Pure code, no model. Thresholds and the governor are Ethan's
//      numbers, backtested over 349 store-days; see the constants below.
//   2. The MODEL only writes the sentence. It never chooses the topic, never
//      sees a threshold, and never computes the `reason` line — that is built
//      here from the signals that actually fired, so the fact he reads beside a
//      draft cannot drift from the data that triggered it.
//
// That split is the whole design. A model deciding which store deserves praise
// would be unauditable and would drift; a template writing the sentence would be
// clocked as automated inside a week. Each does the half it is good at.
//
// Cost: one call per surviving store, ~2.5 stores/day after the governor.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// npm: specifier rather than esm.sh — the rest of this project pins esm.sh
// versions, but the Anthropic SDK moves fast and Supabase's runtime resolves
// npm: natively, so there is no build step to get wrong here.
import Anthropic from "npm:@anthropic-ai/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SECRET = "sp33ks-sync-k3y-2026-x9mq";
const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const ADMIN_ROLES = ["ceo", "district manager"];

const MODEL = "claude-opus-5";

// Realtime "ping" — same shape every other tool's fn uses. Approving on the
// laptop clears the card on the phone without waiting for a poll. Best-effort:
// a broadcast failure must never cost him a decision he already made.
async function broadcastChange(tool: string, store: string | null) {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ topic: "speeks-notify", event: "changed", payload: { tool, store: store ? String(store).toUpperCase() : null, ts: Date.now() } }],
      }),
    });
  } catch (_) { /* best-effort */ }
}

// Drop a row on the email-notification queue. The twin of broadcastChange above:
// that one refreshes an already-open page, this one reaches the people who are not
// looking at the site.
//
// Copied deliberately from store-comments rather than reimplemented, because an
// approved draft has to be indistinguishable from a hand-sent store comment for
// everyone downstream. Without this the message appeared on the store's dashboard
// but sent no email, so anybody relying on the alert would simply never hear about
// it. Best-effort and never throws: failing to notify must not fail the publish.
async function queueNotification(n: {
  category: string; kind: string; title: string; body?: string; link?: string;
  store?: string | null; audienceStores?: string[] | null; excludeUser?: string | null;
}) {
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    await sb.from("notify_queue").insert({
      category: n.category, kind: n.kind, title: n.title, body: n.body ?? null,
      link: n.link ?? null,
      store: n.store ? String(n.store).toUpperCase() : null,
      audience_stores: n.audienceStores ?? null,
      audience_roles: null,
      audience_user: null,
      exclude_user: n.excludeUser ? String(n.excludeUser).trim().toLowerCase() : null,
      priority: "normal",
    });
  } catch (_) { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Thresholds — Ethan's numbers, 2026-08-13. All stores identical unless the
// store is under two months old (NEW_STORE_DAYS), which as of Aug 2026 none are.
// ---------------------------------------------------------------------------
const T = {
  // Praise
  buyMargin: 0.56,
  buyMarginStretch: 0.53,      // a store climbing out of a hole
  sellMargin: 0.56,
  sellMarginStretch: 0.54,
  // Listed items: ABSOLUTE counts, tiered on how many people were rostered
  // (Ethan 2026-08-14). This replaced a goal-fraction rule, which gave MPL listing
  // credit for 16 items and BAL for 10 — a percentage of a small goal reads as an
  // achievement he would never have called out. Over the 55 store-days on record
  // this fires on 29% of them.
  listedSmall: 25,             // 3 or fewer people rostered
  listedBig: 40,               // 4 or more
  listedBigTeamFrom: 4,
  // Processed VALUE, as its own signal. A store can have a quiet count and a big
  // day: MPL listed 16 items on 2026-08-13 worth $7,235, and his own read was to
  // "compliment the store as a whole for their listed value". Fires on 13%.
  listedValue: 7_000,
  badListed: 20,
  buyValue: 6_500,
  netSales: 5_000,
  custConv: 0.90,
  custConvMinCustomers: 12,

  // Motivate. Every one of these needs a PATTERN, never a single bad day.
  badBuyMargin: 0.51,
  badCustConv: 0.85,
  patternOf: 3,                // ...in this many recent open days
  patternHits: 2,              // ...this many must be bad

  // Exceptional — scores a second point, and cancels any correction that day.
  excBuyValue: 10_000,
  excBuyMargin: 0.60,
  excNetSales: 8_000,
  excSellMargin: 0.62,

  // Size floors. Without these a $314.50 sales day at 65.7% margin reads as
  // "great selling margin!" — the single fastest way to reveal a generator.
  floorBuyValue: 2_500,
  floorNetSales: 2_000,

  // New store (open < 2 months)
  newBuyValue: 4_000,
  newNetSales: 3_000,
  newStoreDays: 62,
};

// Governor. Backtest: score>=2 + cap 3 lands at 2.5 drafts per store per week,
// against his real ~12/week across five stores. score>=3 gives 1.2 — too quiet.
const G = {
  minScore: 2,
  perStorePerWeek: 3,
  correctionsPerStorePerWeek: 1,
  // Mornings a draft may be written.
  //
  // Saturday added 2026-08-14 at his request: his own 150 messages contain only
  // 5 Saturday sends, but that reflects the cost of writing them by hand, not
  // what he wants now that it is automated. Saturday is what makes FRIDAY's
  // numbers get acknowledged, and Friday is the biggest buying day at several
  // stores (LEE averages $5,931 Friday against $3,623 Thursday).
  //
  // REMAINING GAP, his call: Monday is still off, so Saturday's own numbers are
  // never acknowledged (Sunday is skipped by refDayFor, so Monday would react to
  // Saturday). Add 1 here to close it.
  sendDays: [2, 3, 4, 5, 6],   // Tue Wed Thu Fri Sat, Chicago
  // Praise-only window at the top of the month — observed, not invented: BAL on
  // Jul 1 ran a 49.4% margin, well under any floor, and got pure praise.
  praiseOnlyThroughDay: 2,
  // A draft unreviewed by NOON Central is retired unsent. These are morning
  // messages — they land as people open the site — and one arriving mid-afternoon
  // about yesterday reads as an afterthought. Expiring is his "skip": nothing is
  // sent, and it does not spend the weekly budget.
  expireHour: 12,
};

type Facts = Record<string, any>;

const fmtMoney = (x: number) => "$" + Math.round(x).toLocaleString("en-US");

// He does not write dashes, and an em dash is the single most recognisable tell of
// generated text — his own words: "get rid of all em dashes as that screams AI".
// The prompt forbids them; this is the net for when it slips through anyway, since
// one dash undoes the whole point of the voice work.
//
// Replaced with a comma rather than deleted: a dash is nearly always doing a
// comma's job in these sentences ("margin is gorgeous — let's do it again" reads
// correctly as "margin is gorgeous, let's do it again"). The follow-up passes
// clean up the punctuation collisions that substitution can create.
// The rules a draft can be checked against mechanically. The prompt states all of
// these, and the blind test showed the prompt alone does not hold them: he
// identified 14 of 15 drafts, almost entirely on numbers and length.
//
// Returns the list of what is wrong, which is fed straight back for one retry.
// Enforced here rather than trusted because these are the exact tells: 0 of his 15
// real messages carried a percentage, 60% of the drafts did.
// Figures that are not measurements and are allowed through: the standing target
// written "54%+", and "5 star" as an adjective. "5 star review" is how everyone
// writes it, including him; treating that 5 as a statistic made the checker demand
// a rewrite of a perfectly natural phrase.
const TARGET_OK = /\b5[0-9]%\+|\b5[\s-]?star\b/gi;
function violations(text: string): string[] {
  const out: string[] = [];
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words > 20) out.push(`It is ${words} words. His median is 11. Cut it to under 15.`);
  // Strip the allowed figures before looking for stray ones.
  const bare = text.replace(TARGET_OK, " ");
  if (/%/.test(bare)) out.push("It quotes a percentage. He never does. Describe the margin or the conversion in words instead.");
  if (/\$/.test(bare)) out.push("It quotes a dollar amount. He never does.");
  if (/\b\d+\s*(?:for|of|\/)\s*\d+\b/.test(bare)) out.push("It quotes a conversion fraction. Say the conversion was strong, without the figures.");
  if (/\d/.test(bare)) out.push("It contains a figure. Take every number out except a '54%+' style target in an ask.");
  if (/[—–]/.test(text)) out.push("It contains a dash. Use a comma or a full stop.");
  return out;
}

function stripDashes(s: string): string {
  return String(s)
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,+/g, ",")
    .replace(/,\s*([.!?,;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Dates. The edge runtime is UTC, so a naive new Date() rolls over at 7pm
// Central and every "yesterday" would be wrong for five hours each evening.
// ---------------------------------------------------------------------------
function chicagoParts(d: Date) {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    // hourCycle h23, not hour12:false — the latter reports midnight as "24" in
    // some locales, which would make an hour comparison silently wrong once a day.
    hour: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => s.find((p) => p.type === t)?.value ?? "";
  const iso = `${get("year")}-${get("month")}-${get("day")}`;
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { iso, dow, day: parseInt(get("day"), 10), hour: parseInt(get("hour"), 10) };
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dowOf(iso: string): number {
  return new Date(iso + "T12:00:00Z").getUTCDay();
}

// The trading day a message written this morning is reacting to. Stores are shut
// Sunday, so Monday's draft would otherwise react to a day with no trading —
// it steps back to Saturday instead.
function refDayFor(iso: string): string {
  let ref = addDays(iso, -1);
  while (dowOf(ref) === 0) ref = addDays(ref, -1);
  return ref;
}

// ---------------------------------------------------------------------------
// Fact loading. day_end_facts is the real source; daily_buysell fills in
// est_value / margin / net sales when a report is missing, so one undelivered
// email costs us conversion and listed items rather than the whole draft.
// ---------------------------------------------------------------------------
async function loadFacts(sb: any, from: string, to: string): Promise<Map<string, Facts>> {
  const [de, bs, lg] = await Promise.all([
    sb.from("day_end_facts").select("*").gte("date", from).lte("date", to),
    sb.from("daily_buysell").select("store,date,buy,sell,gp,buy_margin_pct").gte("date", from).lte("date", to),
    // Listing goals across the WHOLE window, not just the ref day: the low-listing
    // nudge needs a pattern, and a pattern needs each historical day's own goal.
    sb.from("listing_goals").select("store,date,role,goal").gte("date", from).lte("date", to),
  ]);

  // Store daily listing goal = the sum of every rostered person's goal, which is
  // what makes this fair across stores (Ethan 2026-08-14). A flat item count
  // cannot be: BAL on a two-person day is held to 21 and WSP on a four-person day
  // to 45, and judging both against "25" rewards the store that happened to be
  // fully staffed. `listers` is tracked separately because a day with nobody in an
  // L role must never draw a low-listing nudge.
  const goals = new Map<string, { goal: number; staffed: number; listers: number }>();
  for (const g of lg.data ?? []) {
    const role = String(g.role || "").toUpperCase();
    if (role === "OFF") continue;
    const k = `${g.store}|${g.date}`;
    const cur = goals.get(k) ?? { goal: 0, staffed: 0, listers: 0 };
    cur.goal += Number(g.goal) || 0;
    cur.staffed += 1;
    if (role.startsWith("L")) cur.listers += 1;
    goals.set(k, cur);
  }

  const out = new Map<string, Facts>();
  for (const r of bs.data ?? []) {
    const sell = Number(r.sell) || 0;
    out.set(`${r.store}|${r.date}`, {
      store: r.store, date: r.date,
      buyValue: Number(r.buy) || 0,
      buyMargin: r.buy_margin_pct == null ? null : Number(r.buy_margin_pct),
      netSales: sell,
      sellMargin: sell > 0 ? (Number(r.gp) || 0) / sell : null,
      hasReport: false,
    });
  }
  for (const r of de.data ?? []) {
    const key = `${r.store}|${r.date}`;
    const prior = out.get(key) ?? { store: r.store, date: r.date };
    const sell = Number(r.net_sales) || prior.netSales || 0;
    out.set(key, {
      ...prior,
      // The report wins where both have it — it is the source, and daily_buysell
      // is a copy of the same figures that arrives via the sheet.
      buyValue: r.est_value == null ? prior.buyValue : Number(r.est_value),
      buyMargin: r.est_margin_pct == null ? prior.buyMargin : Number(r.est_margin_pct),
      netSales: sell,
      sellMargin: r.sales_margin_pct == null ? prior.sellMargin : Number(r.sales_margin_pct),
      cashSpent: r.total_spent == null ? null : Number(r.total_spent),
      custConv: r.cust_conv_den ? Number(r.cust_conv_num) / Number(r.cust_conv_den) : null,
      custConvNum: r.cust_conv_num, custConvDen: r.cust_conv_den,
      devConv: r.dev_conv_den ? Number(r.dev_conv_num) / Number(r.dev_conv_den) : null,
      totalCustomers: r.total_customers,
      listed: r.devices_processed,
      processedValue: r.processed_value == null ? null : Number(r.processed_value),
      fiveStarMtd: r.five_star_mtd,
      availableCount: r.available_count,
      teamProduction: r.team_production,
      shoutouts: r.shoutouts,
      hasReport: true,
    });
  }
  // Attach the roster to every day we have, report or not.
  for (const [k, f] of out) {
    const g = goals.get(k);
    f.storeGoal = g?.goal ?? null;
    f.staffed = g?.staffed ?? null;
    f.listers = g?.listers ?? null;
    // Null, not zero, when there is no goal to divide by — three days in the
    // window have no listing_goals rows at all, and 0% would read as a disaster.
    f.listedPct = (f.storeGoal && f.listed != null) ? f.listed / f.storeGoal : null;
  }
  return out;
}

// The store's recent open days, newest first, excluding the day in question.
function historyFor(facts: Map<string, Facts>, store: string, ref: string, n: number): Facts[] {
  const out: Facts[] = [];
  let d = addDays(ref, -1);
  for (let i = 0; i < n * 2 && out.length < n; i++) {
    if (dowOf(d) !== 0) {
      const f = facts.get(`${store}|${d}`);
      if (f && f.buyValue > 0) out.push(f);
    }
    d = addDays(d, -1);
  }
  return out;
}

function mean(xs: (number | null | undefined)[]): number | null {
  const v = xs.filter((x): x is number => typeof x === "number" && isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// ---------------------------------------------------------------------------
// The rule engine.
// ---------------------------------------------------------------------------
type Signal = {
  key: string;
  dir: "praise" | "correct";
  points: number;
  fact: string;          // the human-readable figure, verbatim into `reason`
  detail?: string;       // extra colour the model may use
};

function evaluate(f: Facts, hist: Facts[], ctx: {
  isNew: boolean;
  record: number | null;
  staffed: number | null;
  monthDay: number;
}): { signals: Signal[]; score: number } {
  const sig: Signal[] = [];
  const push = (s: Signal) => sig.push(s);
  const pct = (x: number) => (x * 100).toFixed(1) + "%";
  const money = (x: number) => "$" + Math.round(x).toLocaleString("en-US");

  const buyFloor = ctx.isNew ? T.newBuyValue : T.buyValue;
  const salesFloor = ctx.isNew ? T.newNetSales : T.netSales;

  // --- buy volume
  if (f.buyValue >= buyFloor) {
    const exc = f.buyValue >= T.excBuyValue;
    push({ key: "buy_value", dir: "praise", points: exc ? 2 : 1, fact: `buying volume ${money(f.buyValue)}` });
  }
  // Record watch. The records table is hand-typed and 2026-only in
  // daily_buysell, so a store can beat a record nobody has updated yet — which
  // is itself worth saying, and worth flagging so the table gets corrected.
  if (ctx.record && f.buyValue >= ctx.record) {
    push({ key: "buy_record", dir: "praise", points: 3,
      fact: `${money(f.buyValue)} buying volume — past the store record of ${money(ctx.record)}`,
      detail: "This BEATS the all-time store record. Rare enough to lead with." });
  } else if (ctx.record && f.buyValue >= ctx.record * 0.95) {
    push({ key: "buy_near_record", dir: "praise", points: 2,
      fact: `${money(f.buyValue)} buying volume, within 5% of the ${money(ctx.record)} store record` });
  }

  // --- buy margin. Floored on size: a percentage of almost nothing is noise.
  if (f.buyMargin != null && f.buyValue >= T.floorBuyValue) {
    const tr14 = mean(hist.slice(0, 14).map((h) => h.buyMargin));
    const tr7 = mean(hist.slice(0, 7).map((h) => h.buyMargin));
    if (f.buyMargin >= T.buyMargin) {
      push({ key: "buy_margin", dir: "praise", points: f.buyMargin >= T.excBuyMargin ? 2 : 1,
        fact: `buying margin ${pct(f.buyMargin)}` });
    } else if (f.buyMargin >= T.buyMarginStretch && tr14 != null && tr14 < T.buyMargin
               && tr7 != null && f.buyMargin > tr7) {
      // The "struggling store" stretch: below target on the fortnight, above
      // the stretch floor yesterday, and above their own last week — genuinely
      // climbing out rather than one lucky day.
      // Worth two points on its own, unlike the other single signals: a store
      // climbing back toward the target is the motivational message he most
      // reliably sends, and at one point the governor silenced it. OVL on
      // 2026-07-30 scored 1 here and he wrote "Love seeing the buy margin start
      // to improve. Keep pushing... 54%+ buy margin target" that same morning.
      push({ key: "buy_margin_improving", dir: "praise", points: 2,
        fact: `buying margin ${pct(f.buyMargin)}, up from a ${pct(tr7)} week`,
        detail: `Still under the 54%+ target — praise the climb and point at the target.` });
    }
    if (f.buyMargin <= T.badBuyMargin) {
      const recent = [f, ...hist].slice(0, T.patternOf)
        .filter((h) => h.buyMargin != null && h.buyMargin <= T.badBuyMargin).length;
      if (recent >= T.patternHits) {
        push({ key: "buy_margin_low", dir: "correct", points: 0,
          fact: `buying margin ${pct(f.buyMargin)}, ${recent} of the last ${T.patternOf} days at or under ${pct(T.badBuyMargin)}`,
          detail: "A pattern, not one day. The target is 54%+." });
      }
    }
  }

  // --- sales
  if (f.netSales >= salesFloor) {
    push({ key: "net_sales", dir: "praise", points: f.netSales >= T.excNetSales ? 2 : 1,
      fact: `net sales ${money(f.netSales)}` });
  }
  if (f.sellMargin != null && f.netSales >= T.floorNetSales && f.sellMargin >= T.sellMargin) {
    push({ key: "sell_margin", dir: "praise", points: f.sellMargin >= T.excSellMargin ? 2 : 1,
      fact: `selling margin ${pct(f.sellMargin)}` });
  }

  // --- customer conversion
  if (f.custConv != null && (f.totalCustomers ?? f.custConvDen ?? 0) > T.custConvMinCustomers) {
    if (f.custConv >= 1) {
      push({ key: "conv_perfect", dir: "praise", points: 2,
        fact: `perfect customer conversion, ${f.custConvNum}/${f.custConvDen}` });
    } else if (f.custConv >= T.custConv) {
      // The NUMERATOR has to be in here. Without it this read "customer conversion
      // 93.3% on 15 customers", and the model filled the gap by writing "15 for 15
      // conversion" to OVL on 2026-08-14 — when they went 14 for 15. A fact that
      // omits a figure the sentence wants is an invitation to invent it.
      push({ key: "conv", dir: "praise", points: 1,
        fact: `customer conversion ${f.custConvNum} of ${f.custConvDen} customers (${pct(f.custConv)})` });
    }
  }
  if (f.custConv != null && f.custConv < T.badCustConv) {
    const recent = [f, ...hist].slice(0, T.patternOf)
      .filter((h) => h.custConv != null && h.custConv < T.badCustConv).length;
    if (recent >= T.patternHits) {
      push({ key: "conv_low", dir: "correct", points: 0,
        fact: `customer conversion ${pct(f.custConv)}, ${recent} of the last ${T.patternOf} days under ${pct(T.badCustConv)}` });
    }
  }

  // --- listed items: an absolute count, tiered on the roster.
  //
  // 25+ with three or fewer people, 40+ with four or more (Ethan 2026-08-14). The
  // previous rule scored listings as a fraction of the store's summed daily goal,
  // which was mathematically fair and practically wrong: it handed MPL listing
  // credit for 16 items (59% of a 27 goal) and BAL for 10, and his own reaction to
  // those two drafts was that he would never have praised either. A percentage of
  // a small goal is not a good listing day.
  const staffedN = ctx.staffed ?? 0;
  if (f.listed != null) {
    const bar = staffedN >= T.listedBigTeamFrom ? T.listedBig : T.listedSmall;
    if (f.listed >= bar) {
      const busy = f.buyValue >= buyFloor;
      push({ key: "listed", dir: "praise", points: busy ? 2 : 1,
        fact: `${f.listed} items listed with ${staffedN || "?"} people rostered`
          + (busy ? `, on a ${money(f.buyValue)} buying day` : "") });
    } else if (f.listed < T.badListed) {
      // Two exemptions, both his. Nobody in a listing role was never asked to
      // list; and a two-person day that was slammed with buying earned the
      // shortfall ("unless only 2 people staffed and a very busy buying day").
      const noListers = (f.listers ?? 0) === 0;
      const shortAndBusy = staffedN > 0 && staffedN <= 2 && f.buyValue >= buyFloor;
      if (!noListers && !shortAndBusy) {
        const recent = [f, ...hist].slice(0, T.patternOf)
          .filter((h) => h.listed != null && h.listed < T.badListed).length;
        if (recent >= T.patternHits) {
          push({ key: "listed_low", dir: "correct", points: 0,
            fact: `${f.listed} items listed, ${recent} of the last ${T.patternOf} days under ${T.badListed}` });
        }
      }
    }
  }

  // --- the VALUE of what was processed, separate from the count.
  //
  // A quiet count can still be a big day, and this is the signal that catches it:
  // MPL listed 16 items on 2026-08-13 worth $7,235. His own read of that day was
  // to compliment the store as a whole for the listed value rather than name
  // anyone, which is exactly what the detail line asks for.
  if (f.processedValue != null && f.processedValue >= T.listedValue) {
    push({ key: "listed_value", dir: "praise", points: 2,
      fact: `${money(f.processedValue)} of inventory processed and listed`,
      detail: "This is the store as a WHOLE having a big day, not one person. Praise the store." });
  }

  // --- Google reviews: DELIBERATELY NOT A SIGNAL (his call, 2026-08-21).
  //
  // The only MTD review figure we have comes from the nightly Day End Report, and
  // the POS behind that report LAGS the truth. Measured: LEE stood at 29 reviews
  // on the month while the report still said 26. Three days of that lag looks
  // exactly like a store that has stopped earning reviews, which is how a nudge
  // gets sent to a store that is actually doing fine — and praise for "3 new
  // reviews" can be last week's, arriving late.
  //
  // A wrong number in a message to a store costs more than a missing one, so
  // reviews are out of the messaging entirely. `fiveStarMtd` is still carried in
  // the facts and still shown on the verification strip — the DM can see it and
  // add review talk by hand when he knows the real figure. This is a data-quality
  // decision, not a design one: if we ever read review counts from Google itself
  // rather than through the POS, the signal can come straight back.
  //
  // Nothing else here reads fiveStarMtd, so removing the block is the whole change.

  const score = sig.filter((s) => s.dir === "praise").reduce((a, s) => a + s.points, 0);
  return { signals: sig, score };
}

// ---------------------------------------------------------------------------
// The prompt. His voice is characterised from all 150 messages he has sent; the
// examples are pulled live from store_comments so the few-shot stays current as
// he writes more, and rotates so consecutive days do not lean on one template.
// ---------------------------------------------------------------------------
function systemPrompt(): string {
  return [
    "You are drafting a short morning message from Ethan Kushnir, Director of Operations, to one of his five PayMore stores. He reacts to yesterday's numbers. You are writing AS him, in his voice, for him to review.",
    "",
    "HOW HE WRITES — from 150 of his real messages:",
    "- SHORT. His median message is ELEVEN WORDS. 20 is a hard ceiling. Measured in a blind test the drafts ran to a median of 25 against his 11, and length alone gave them away. One clean thought beats three stacked ones.",
    "- VARY the length, hard. His fifteen messages ran from FOUR words to twenty-seven. A second round of drafts fixed the median but landed 14, 14, 15, 15, 16, and that uniformity is its own tell: nobody writes five messages the same length. A day with one good signal should often be four to eight words. Look at what you have already written to the other stores this morning and deliberately do not match their length.",
    "- Often only ONE thing. \"MPL the BUYING MACHINE!\" \"LEE MACHINE! SALES ON SALES ON SALES\" \"Love seeing that level of volume to start the month off!\" Naming two metrics and adding a closer EVERY time is itself a tell: he flagged one of his own two-metric messages as machine-written because that shape has become the giveaway. If the facts give you three good things, pick the best one and drop the others.",
    "- He opens with the REACTION, not the metric: \"Love seeing...\", \"Great...\", \"Huge...\", \"BOOM!\", \"Absolutely massive...\", \"HOLY...\", \"Props to you guys...\"",
    "- He names two or three things, usually paired: \"volume and margin\", \"conversion, volume, and listing productivity\".",
    "- He closes with a forward push, and only ever with one of HIS: \"Keep it up!\", \"Keep up the great work!\", \"Don't take your foot off the gas!\", \"Let's do it again today!\", \"Keep pushing!\", \"Let's keep that energy going!\". Do not invent a new one (\"let's run it back\" is not his). Not every message needs a closer at all.",
    "- Energy comes from caps, elongation and rhetorical questions: \"SALES ON SALES ON SALES\", \"lotsssssss of listings\", \"amazing as usual......\", \"Am I smelling a LEE record month???\"",
    "- He sometimes treats the store as a character (\"Team WSP\", \"the BUYING MACHINE\"). These are specific to the store he coined them for. NEVER transplant one to a different store — MPL's team would recognise their own nickname handed to BAL, and nothing gives a generated message away faster.",
    "- NO NUMBERS. This is the single most important rule and the one the drafts kept breaking. In a blind test of 15 of his real messages, ZERO contained a percentage and only one contained any digit at all; 60% of the drafts quoted a percentage and 87% had a digit. He names the metric and rates it in words: \"huge buying day\", \"beautiful margin\", \"fantastic customer conversion\", \"lotsssssss of listings\". Never a percentage. Never a dollar amount. Never an item count. Never a conversion fraction, in any form, including \"14 for 15\" or \"14/15\".",
    "- The ONE exception: when you are asking for improvement you may cite the standing target, written exactly as \"54%+\". Nothing else. Never a target while praising.",
    "- Corrections NEVER open negative. Always a sandwich, praise first then the ask: \"Sales were great yesterday, but let's put some emphasis on customer conversion and buying margin.\" Or a bare soft ask: \"Let's try and tighten up our buying margin a little bit.\"",
    "- When there is BOTH praise and an ask, the two must CONNECT. They cannot be two unrelated sentences stapled together. \"44 listings and 14 for 15 conversion, unreal day guys! Let's get that buy margin climbing back toward 54%+.\" is stark: the praise stops dead and a new topic starts. Find the hinge and use a real conjunction: \"...unreal day guys, now let's get that buying margin up to match it\", or \"the only thing missing was the buying margin, let's get that back to 54%+ today\". The ask should read as the NEXT thing to do off the back of a good day, not as a separate memo.",
    "- He writes to the team, not about them. \"You guys\", \"gentlemen\", first names when someone is named.",
    "",
    "HARD RULES:",
    "- NEVER use an em dash or an en dash. Not one. He does not write them, and they are the clearest signal in English that a machine wrote the sentence. Use a comma, a full stop, or a conjunction.",
    "- Use ONLY the facts given. Never invent a number, a name, a rank, a record or a trend.",
    "- Never state a fraction, ratio or count that is not written in the facts. If the facts say \"14 of 15 customers\" you may write \"14 for 15\"; you may NOT write \"15 for 15\". Do not round a fraction up to a perfect score.",
    "- Naming a person is RARE. None of the 15 real messages in the blind test named anyone; 40% of the drafts did. Most mornings, name nobody.",
    "- FIRST NAMES ONLY. Never a surname, never a full name, not even the first time somebody is mentioned. Write \"great listing day Caleb\", never \"Caleb Starr\". A surname in a message to your own shop floor is the clearest tell in this whole list that a machine wrote it, because nobody standing in a store talks that way. The facts you are given contain first names only; if you find yourself with a surname you have invented it.",
    "- If you do name someone, say what they led IN WORDS, never with a figure: \"Caleb led the listings\" or \"Olivia had the biggest value day\", never \"Caleb led with 37 of them\". Never call someone the leader without saying which of the two things they led.",
    "- NEVER mention Google reviews, review counts, star ratings, or a customer naming somebody in a review. The review figures we hold are days behind reality, so anything you write about them may be wrong. He adds review praise by hand when he knows the real number. If a review somehow appears in the facts, ignore it.",
    "- Do not quote dollar amounts unless the fact is a small count or a percentage target.",
    "- Output the message text ONLY. No greeting, no signature, no quote marks, no preamble.",
    "- At most one correction, and only if one is listed. If none is listed, the message is pure praise.",
    "- Do not reuse the opening words of the recent messages you are shown.",
    "- NEVER say a figure is \"over target\", \"above target\", \"beats the target\" or similar when praising. He cites the 54%+ target ONLY when asking for improvement. Praising a margin he says \"beautiful margin\", \"fantastic margin\", \"amazing as usual\" — the number is good on its own terms, not against a threshold. Naming a target while praising leaks the fact that a rule fired.",
    "- The SAME applies to listings. The facts tell you the item count and how many people were on so you know how good the day was; recite neither. \"32 items with 3 people rostered\" is a spreadsheet talking, and so is \"44 listings\". He says \"great listing productivity\", \"love seeing this listing productivity\", \"lotsssssss of listings\", \"smashing the listing productivity\", or on a short day \"let's get the listings back up\".",
    "- Do not frame the day by its weekday (\"strong Monday\", \"good Tuesday\"). He says \"yesterday\" or nothing.",
    "- The example messages are for REGISTER ONLY. Do not reuse their sentence shapes with the nouns swapped. If your draft would still read as one of the examples after changing the store name and the metric, write a different sentence.",
  ].join("\n");
}

// FIRST NAME ONLY, everywhere a person reaches a draft.
//
// His rule, 2026-08-21: a surname in one of these messages reads as machine-
// written. It is true — nobody walking a shop floor says "great listing, Caleb
// Starr". The Day End Report gives full names, so the trim happens HERE, on the
// way into the prompt, rather than being asked of the model: a rule the data
// obeys cannot be broken by a draft that ignores it.
//
// Two people sharing a first name is fine and needs no special case — a human
// would say the first name too, and the alternative (naming nobody, or reaching
// for a surname to disambiguate) is worse than the ambiguity.
const firstName = (full: unknown) => String(full ?? "").trim().split(/\s+/)[0] || "";

function userPrompt(store: string, refDate: string, signals: Signal[], recent: string[], f: Facts, siblings: string[]): string {
  const praise = signals.filter((s) => s.dir === "praise");
  const correct = signals.filter((s) => s.dir === "correct");
  const lines: string[] = [];

  lines.push(`Store: ${store}`);
  lines.push(`Reacting to: ${new Date(refDate + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`);
  lines.push("");
  lines.push("WHAT WENT WELL (lead with these):");
  praise.forEach((s) => lines.push(`- ${s.fact}${s.detail ? `. ${s.detail}` : ""}`));

  if (correct.length) {
    lines.push("");
    lines.push("ONE THING TO PUSH ON (mention after the praise, softly):");
    correct.forEach((s) => lines.push(`- ${s.fact}${s.detail ? `. ${s.detail}` : ""}`));
  }

  // Named people, straight from the report. This is where his best messages come
  // from ("great listing Zach", "C-Money coming in with 9 reviews") and it is the
  // one thing a generator could not otherwise reach. Two things had to change:
  //
  // 1. GATED on a listing signal. BAL named its top producer on a 10-item day,
  //    which reads as listing praise the store had not earned. If the store's
  //    listings were unremarkable, there is nobody to congratulate for them.
  // 2. The report's crown is awarded on VALUE, not item count, and this block used
  //    to print only the count beside the crowned name. So "Olivia leading the way
  //    processing" went to MPL on a day Calvin had processed more items than her
  //    (9 to her 7). The two leaders are now named separately and labelled.
  const listingFired = signals.some((s) => s.key === "listed" || s.key === "listed_value");
  const team = Array.isArray(f.teamProduction) ? f.teamProduction.filter((t: any) => t?.name) : [];
  if (listingFired && team.length) {
    const num = (x: unknown) => Number(x) || 0;
    const byCount = [...team].sort((a: any, b: any) => num(b.processed) - num(a.processed))[0];
    const byValue = [...team].sort((a: any, b: any) => num(b.value) - num(a.value))[0];
    lines.push("");
    // First names only, trimmed here — see firstName above.
    const led = firstName(byCount?.name), ledVal = firstName(byValue?.name);
    if (byCount && byValue && byCount.name === byValue.name) {
      lines.push(`Led the board on BOTH counts: ${led}, ${byCount.processed} items and ${fmtMoney(num(byCount.value))} of value.`);
      lines.push("Unambiguous, so you may name them for the listing day.");
    } else {
      lines.push(`Most items listed: ${led} (${byCount.processed} items).`);
      lines.push(`Highest value processed: ${ledVal} (${fmtMoney(num(byValue.value))}).`);
      lines.push("These are two DIFFERENT people. Either name one and say which of the two things they led, or name nobody and praise the store. Do not call someone the leader without saying what they led.");
    }
    lines.push("He does not name anyone every time. Only if it fits.");
    lines.push("These are first names and that is the ONLY form to use. Never a surname, never a full name.");
  }

  // REVIEW SHOUTOUTS ARE GONE (his call, 2026-08-21). A store no longer gets told
  // that a customer named one of its people in a review.
  //
  // Two reasons, and the second is the real one. The names came from PaytonAI's
  // summary of the review rather than the review, and it mangles them — LEE's
  // 2026-08-12 report calls the same man "Jurrel" and "Jerrell" in consecutive
  // lines (he is Jurell Guild), which is why they used to be matched against the
  // roster before use. But the review COUNT this all hangs off lags the POS by
  // days, so a shoutout could be for a review that landed last week, or arrive
  // days after the person was thanked in person. Praise that is late and
  // second-hand is worse than none.
  //
  // The roster query that existed only to verify these names went with it.

  if (recent.length) {
    lines.push("");
    lines.push(`His last messages to ${store} — do NOT repeat their opening or their topic focus:`);
    recent.forEach((m) => lines.push(`- "${m}"`));
  }

  // The other stores' drafts from THIS SAME MORNING. Without these, two stores
  // that fired on the same two signals got the same sentence with synonyms
  // swapped — "a beautiful margin behind it" and "a gorgeous margin to go with
  // it" on the same day. He sends these within minutes of each other, so a
  // manager comparing notes would spot it instantly.
  if (siblings.length) {
    lines.push("");
    lines.push("Already written to OTHER stores this morning. Yours must not share their sentence shape, their closing line, their LENGTH, or the phrase they use to turn from praise into the ask. \"Now let's get that X climbing\" turned up in six drafts out of nine on one test run, which is worse than any single bad sentence: he sends these minutes apart and a manager comparing notes would see the template immediately. His own transitions vary: \"but let's put some emphasis on\", \"the only thing missing was\", \"let's try and tighten up\", \"let's finish the job and\", or simply a full stop and a fresh sentence.");
    siblings.forEach((m) => lines.push(`- "${m}"`));
  }

  lines.push("");
  lines.push("Write the message.");
  return lines.join("\n");
}

// The verification strip on the review card: every figure the draft could have
// been about, in a fixed order, whether or not it fired. Showing only what fired
// would make the card unfalsifiable — the point is that he can see conversion was
// 82% and confirm the message was right NOT to mention it.
//
// `null` is meaningful here and must survive to the UI as "—", not as a zero: a
// missing Day End Report means we do not know the conversion, which is a
// different statement from a conversion of nothing.
function factSnapshot(f: Facts) {
  const r1 = (x: unknown) => (typeof x === "number" && isFinite(x) ? Math.round(x * 1000) / 10 : null);
  return {
    buyValue: f.buyValue ?? null,
    cashSpent: f.cashSpent ?? null,
    buyMarginPct: r1(f.buyMargin),
    netSales: f.netSales ?? null,
    sellMarginPct: r1(f.sellMargin),
    custConvPct: r1(f.custConv),
    custConvNum: f.custConvNum ?? null,
    custConvDen: f.custConvDen ?? null,
    devConvPct: r1(f.devConv),
    listed: f.listed ?? null,
    processedValue: f.processedValue ?? null,
    fiveStarMtd: f.fiveStarMtd ?? null,
    totalCustomers: f.totalCustomers ?? null,
    availableCount: f.availableCount ?? null,
    // The roster and the goal it implies — the verification strip needs both to
    // make sense of a listing figure.
    storeGoal: f.storeGoal ?? null,
    listedPct: f.listedPct == null ? null : Math.round(f.listedPct * 1000) / 10,
    staffed: f.staffed ?? null,
    listers: f.listers ?? null,
    // The two leaders, BOTH of them, because they are frequently different people
    // and the report's crown only tracks value. A draft naming "the leader" is the
    // one claim a column of numbers cannot settle, so the strip has to show who led
    // on items AND who led on value: MPL 2026-08-13 was Calvin on items (9) and
    // Olivia on value ($4,150), and the draft called Olivia the processing leader.
    topLister: (() => {
      const tp = (Array.isArray(f.teamProduction) ? f.teamProduction : []).filter((p: any) => p?.name);
      if (!tp.length) return null;
      const top = [...tp].sort((a: any, b: any) => (Number(b.processed) || 0) - (Number(a.processed) || 0))[0];
      return { name: String(top.name ?? ""), processed: top.processed ?? null, value: top.value ?? null };
    })(),
    topProducer: (() => {
      const tp = (Array.isArray(f.teamProduction) ? f.teamProduction : []).filter((p: any) => p?.name);
      if (!tp.length) return null;
      const top = [...tp].sort((a: any, b: any) => (Number(b.value) || 0) - (Number(a.value) || 0))[0];
      return { name: String(top.name ?? ""), processed: top.processed ?? null, value: top.value ?? null };
    })(),
    // False means the Day End Report was missing for that night, so conversion,
    // listed items and reviews are unknown rather than zero — the card says so.
    hasReport: !!f.hasReport,
  };
}

// A rotating few-shot pool. Selected by topic overlap so the examples shown are
// the ones nearest what is being written, then varied by an index that moves
// with the date so five stores on one morning do not all echo one message.
function pickExamples(all: { store: string; message: string }[], rotate: number): string[] {
  if (!all.length) return [];
  const out: string[] = [];
  for (let i = 0; i < Math.min(8, all.length); i++) {
    out.push(all[(rotate * 3 + i * 5) % all.length].message);
  }
  return [...new Set(out)];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b, null, 2), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  const machine = url.searchParams.get("secret") === SECRET;

  // Browser path: the review card. Role is re-checked by pin against the users
  // table — hiding a control in the frontend is not a boundary.
  //
  // The role default is then deferred to feature_overrides on the SAME key the
  // frontend gate and the tools-panel link use (tool-store-comment-drafts), so
  // this allow-list cannot drift away from what the Feature Access tool shows.
  // A backend role list that silently disagrees with the frontend is how the
  // Weekly/Monthly KPI tool ended up 403-ing saves for a role the UI offered.
  let viewer: any = null;
  if (!machine) {
    const pin = req.headers.get("x-user-pin") || "";
    if (!pin) return json({ ok: false, error: "unauthorized" }, 401);
    const { data } = await sb.from("users").select("name, role").eq("pin", pin).single();
    if (!data) return json({ ok: false, error: "unauthorized" }, 401);

    const role = String(data.role ?? "").toLowerCase().trim();
    const roleClass = role.replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-");
    const { data: ovs } = await sb.from("feature_overrides")
      .select("subject_type, subject, enabled").eq("feature_key", "tool-store-comment-drafts");
    // A per-user override beats a per-role one, matching _featureOverrideFor.
    const forUser = (ovs ?? []).find((o: any) => o.subject_type === "user"
      && String(o.subject).toLowerCase() === String(data.name ?? "").toLowerCase());
    const forRole = (ovs ?? []).find((o: any) => o.subject_type === "role"
      && String(o.subject).toLowerCase() === roleClass);
    const ov = forUser ?? forRole;
    const allowed = ov ? !!ov.enabled : ADMIN_ROLES.includes(role);
    if (!allowed) return json({ ok: false, error: "forbidden" }, 403);
    viewer = data;
  }

  const now = new Date();
  const today = chicagoParts(now);

  // ---- read: today's drafts for the feed card ----
  //
  // The run row goes back with them. An empty draft list on its own is
  // ambiguous — it means either "every store was quiet this morning" or "the
  // generator never ran" — and those need opposite reactions from him, so the
  // card must be able to tell them apart rather than guess.
  if (req.method === "GET" && !url.searchParams.get("action")) {
    const [drafts, run] = await Promise.all([
      sb.from("comment_drafts").select("*").eq("date", today.iso).order("store"),
      sb.from("daily_brief_runs").select("*").eq("date", today.iso).maybeSingle(),
    ]);
    return json({
      ok: true, date: today.iso, stores: STORES,
      drafts: drafts.data ?? [], run: run.data ?? null,
    });
  }

  // ---- decide: approve (publish) or skip ----
  if (req.method === "POST" && !url.searchParams.get("action")) {
    const body = await req.json().catch(() => ({}));
    const { id, status, message } = body ?? {};
    if (!id || !["approved", "skipped"].includes(String(status))) {
      return json({ ok: false, error: "id and status (approved|skipped) required" }, 400);
    }
    const { data: draft } = await sb.from("comment_drafts").select("*").eq("id", id).single();
    if (!draft) return json({ ok: false, error: "no such draft" }, 404);
    if (draft.status !== "pending") return json({ ok: false, error: `already ${draft.status}` }, 409);

    const patch: Record<string, unknown> = {
      status, decided_at: new Date().toISOString(), decided_by: viewer?.name ?? "system",
    };
    if (typeof message === "string" && message.trim() && message.trim() !== draft.message) {
      patch.edited_message = message.trim();
    }

    if (status === "approved") {
      const text = String(patch.edited_message ?? draft.message);
      const author = viewer?.name ?? "Ethan Kushnir";
      // Published through the same shape the Send Store Comment tool uses, so
      // read receipts, the green bubble and the reads tab all work unchanged.
      //
      // ISO, not toLocaleDateString. The column is a `date`, and the locale form
      // ("8/14/2026") only parses because this server happens to run DateStyle MDY.
      // store-comments converts to ISO for exactly this reason.
      const today = chicagoParts(new Date()).iso;
      const { data: pub, error } = await sb.from("store_comments").insert({
        date: today, store: draft.store, author, message: text,
      }).select("id").single();
      if (error) return json({ ok: false, error: error.message }, 500);
      patch.published_comment_id = pub.id;

      // ...and the email, which the on-screen card is only half of. A hand-sent
      // comment queues this; an approved draft has to be indistinguishable from
      // one downstream, so it queues the identical row.
      //
      // The role is taken from the pin-resolved viewer, never from client input:
      // "Message from Ethan Kushnir (District Manager)" is a claim of authority
      // and it has to be one the server checked. A machine-authorised approval
      // has no viewer, so it gets the neutral name-only wording.
      const raw = String(viewer?.role ?? "").toLowerCase().trim();
      const role = raw === "district manager" ? "District Manager"
        : raw === "ceo" ? "CEO"
        : (raw === "manager" || raw === "owner (manager)" || raw === "multi-store manager") ? "Manager"
        : "";
      await queueNotification({
        category: "store_messages",
        kind: "store_comment",
        title: `Message from ${role ? `${author} (${role})` : author}`,
        body: text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300),
        link: "index.html",
        store: draft.store,
        audienceStores: [draft.store],
        excludeUser: author,
      });
    }

    await sb.from("comment_drafts").update(patch).eq("id", id);
    // Two pings, because two different things changed: `dailyBrief` refreshes
    // his own review card, and an approval also put a real comment on that
    // store's dashboard — which is what `comments` tells that store's browsers.
    await broadcastChange("dailyBrief", draft.store);
    if (status === "approved") await broadcastChange("comments", draft.store);
    return json({ ok: true, id, status });
  }

  // ---- expire: retire anything he did not get to ----
  //
  // Run by cron at noon Central. `status = 'expired'` rather than a delete: it is
  // behaviourally identical to a skip (nothing was sent, and the weekly budget is
  // not spent — see usedThisWeek below), but it keeps the distinction between "he
  // looked and passed" and "he never got to it". If these start expiring most
  // days that is the single most useful signal about whether the whole thing is
  // being used, and a DELETE would throw it away.
  //
  // Sweeps every date at or before today, not just today: a pending draft left
  // over from an earlier day would otherwise sit there forever counting against
  // that store's weekly cap for a message nobody ever sent.
  if (url.searchParams.get("action") === "expire") {
    const { data, error } = await sb.from("comment_drafts")
      .update({ status: "expired", decided_at: new Date().toISOString(), decided_by: "expired (unreviewed by noon)" })
      .eq("status", "pending").lte("date", today.iso)
      .select("store, date");
    if (error) return json({ ok: false, error: error.message }, 500);
    if (data?.length) await broadcastChange("dailyBrief", null);
    return json({ ok: true, date: today.iso, expired: data?.length ?? 0, rows: data ?? [] });
  }

  // ---- generate ----
  if (url.searchParams.get("action") !== "generate") {
    return json({ ok: false, error: 'unknown action — use ?action=generate, GET, or POST a decision' }, 400);
  }

  const force = url.searchParams.get("force") === "1";
  const dryRun = url.searchParams.get("dryRun") === "1";

  // Stamp what this morning's run did, so the review card can distinguish a
  // quiet morning from a broken one — and so a failure is visible to a human
  // instead of dying in the cron log. Never written on a dryRun: a test replay
  // of an old day must not overwrite the real record for that date.
  // opts.onlyIfAbsent — for the paths that did NO work (not a send day, past the
  // review window). Those must not upsert over a morning that already ran: the row
  // is keyed on date, so a late or retried invocation would replace "drafted 5,
  // here are the per-store skip reasons" with "drafted 0, past the window" and the
  // review card would report the morning as empty when it wasn't.
  const recordRun = async (row: Record<string, unknown>, opts?: { onlyIfAbsent?: boolean }) => {
    if (dryRun) return;
    if (opts?.onlyIfAbsent) {
      const { data: existing } = await sb.from("daily_brief_runs")
        .select("date").eq("date", row.date as string).maybeSingle();
      if (existing) return;
    }
    await sb.from("daily_brief_runs").upsert(
      { ran_at: new Date().toISOString(), ...row }, { onConflict: "date" },
    );
    await broadcastChange("dailyBrief", null);
  };

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    const error = "ANTHROPIC_API_KEY is not set on this project — no drafts can be written.";
    await recordRun({ date: url.searchParams.get("date") || today.iso, ok: false, drafted: 0, errors: [error] });
    return json({ ok: false, error }, 500);
  }
  // Overridable so a historical day can be replayed for testing without waiting
  // for a morning to come round.
  const forDate = url.searchParams.get("date") || today.iso;
  const parts = forDate === today.iso ? today : { iso: forDate, dow: dowOf(forDate), day: parseInt(forDate.slice(8), 10) };

  const skipReasons: string[] = [];

  // Past the review window already. Without this a late or retried cron could
  // write a fresh set of drafts at 1pm that nothing would clear until noon
  // TOMORROW — so they would either go out a day stale or sit in the card
  // contradicting "these are this morning's". Only guards a run for TODAY; a
  // deliberate historical replay by date is unaffected.
  if (!force && parts.iso === today.iso && today.hour >= G.expireHour) {
    const note = `past the ${G.expireHour}:00 Central review window — no drafts written`;
    await recordRun({ date: parts.iso, ok: true, drafted: 0, evaluated: 0, note }, { onlyIfAbsent: true });
    return json({ ok: true, date: parts.iso, generated: 0, note });
  }

  if (!force && !G.sendDays.includes(parts.dow)) {
    const note = `${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][parts.dow]} is not a send day.`;
    // Recorded, not silent. A morning with no card at all is indistinguishable
    // from a broken cron; a run row saying "today isn't a send day" is not.
    await recordRun({ date: parts.iso, ok: true, drafted: 0, evaluated: 0, note }, { onlyIfAbsent: true });
    return json({ ok: true, date: parts.iso, generated: 0, note });
  }

  // Already generated successfully this morning — stop before spending anything.
  //
  // The cron is a CDT/CST pair (the house pattern for every scheduled function
  // here), so one of the two fires at the wrong hour year-round. For an
  // idempotent upsert that is harmless and even useful as a retry; for this
  // function it would mean a second round of paid model calls AND a set of
  // freshly-worded drafts replacing the ones he may already be halfway through
  // reading. The cron SQL guards on the Central hour as well; this is the layer
  // that holds if anything else ever calls the endpoint twice.
  //
  // A FAILED or empty run is deliberately still retryable: ok=false means some
  // store errored and deserves another attempt, and drafted=0 costs nothing.
  if (!force) {
    const { data: prior } = await sb.from("daily_brief_runs")
      .select("drafted, ok").eq("date", parts.iso).maybeSingle();
    if (prior?.ok && (prior.drafted ?? 0) > 0) {
      return json({ ok: true, date: parts.iso, generated: 0,
        note: `already generated ${prior.drafted} drafts for ${parts.iso} — pass force=1 to regenerate` });
    }
  }

  const ref = refDayFor(parts.iso);
  const facts = await loadFacts(sb, addDays(ref, -21), ref);

  // Listing goals are NOT fetched here — loadFacts pulls them across the whole
  // window and hangs storeGoal / staffed / listers on every day, because the
  // low-listing pattern check needs each historical day's own goal, not just the
  // ref day's.
  const [recs, comments, weekDrafts, decided, opened] = await Promise.all([
    sb.from("records").select("store,label,value").eq("label", "Daily Buy Record"),
    sb.from("store_comments").select("store,author,message,created_at")
      .order("created_at", { ascending: false }).limit(120),
    // The governor's window: drafts already written EARLIER this Mon-Sun week.
    //
    // Strictly BEFORE today (lt, not lte). Today's own drafts are the ones this run
    // replaces, so counting them makes a re-run compete with itself: on 2026-08-14
    // a second run saw the first run's two `mixed` drafts, decided both stores had
    // already spent their one correction for the week, and silently emitted bare
    // praise instead — the buy-margin nudge OVL and WSP had earned just vanished.
    // The same self-count could drop a store's draft entirely once it was at 2
    // messages for the week. Anything already DECIDED today is handled separately
    // by `settled` below, so nothing escapes the cap by being excluded here.
    sb.from("comment_drafts").select("store,date,kind,status")
      .gte("date", addDays(parts.iso, -((parts.dow + 6) % 7))).lt("date", parts.iso),
    // Anything he has ALREADY approved or skipped for this morning is finished
    // business — a re-run must not reopen it, and an approved one has already
    // been published to the store.
    sb.from("comment_drafts").select("store,status").eq("date", parts.iso).neq("status", "pending"),
    // First trading day on record per store, for the "open under two months"
    // thresholds. Cheap, and it keeps that rule real for the next opening
    // instead of a constant nobody remembers to switch on.
    sb.from("daily_buysell").select("store,date").gt("buy", 0)
      .order("date", { ascending: true }).limit(2000),
    // (The `users` roster read that used to sit here existed ONLY to verify names
    // a review mentioned. Review shoutouts are gone — see userPrompt — so the
    // query went with them rather than being left to look load-bearing.)
  ]);

  const firstDay = new Map<string, string>();
  for (const r of opened.data ?? []) {
    if (!firstDay.has(r.store)) firstDay.set(r.store, r.date);
  }
  const settled = new Set((decided.data ?? []).map((d: any) => d.store));

  const recordFor = new Map<string, number>();
  for (const r of recs.data ?? []) {
    const n = parseFloat(String(r.value).replace(/[^0-9.]/g, ""));
    if (isFinite(n) && STORES.includes(r.store)) recordFor.set(r.store, n);
  }

  // HIS messages only. Managers and MSMs can send store comments too (see the
  // store-comments manager variant), and training the voice on their writing
  // would quietly blend it into someone else's.
  const mine = (comments.data ?? []).filter((c: any) => /ethan/i.test(String(c.author ?? "")));
  const byStore = new Map<string, string[]>();
  for (const c of mine) {
    const arr = byStore.get(c.store) ?? [];
    if (arr.length < 3) arr.push(c.message);
    byStore.set(c.store, arr);
  }

  const usedThisWeek = new Map<string, { total: number; corrections: number }>();
  for (const d of weekDrafts.data ?? []) {
    // Neither a skip nor an expiry reached a store, so neither spends the budget.
    if (d.status === "skipped" || d.status === "expired") continue;
    const u = usedThisWeek.get(d.store) ?? { total: 0, corrections: 0 };
    u.total++;
    if (d.kind === "correction" || d.kind === "mixed") u.corrections++;
    usedThisWeek.set(d.store, u);
  }

  // ---- evaluate every store, then rank ----
  const anthropic = new Anthropic({ apiKey });
  const examplesAll = mine.map((c: any) => ({ store: c.store, message: c.message }));

  type Candidate = {
    store: string; signals: Signal[]; score: number; kind: string;
    override: boolean; facts: Facts;
  };
  const candidates: Candidate[] = [];

  for (const store of STORES) {
    if (settled.has(store)) { skipReasons.push(`${store}: already decided for ${parts.iso}`); continue; }

    const f = facts.get(`${store}|${ref}`);
    if (!f || !(f.buyValue > 0)) { skipReasons.push(`${store}: no trading data for ${ref}`); continue; }

    // "Open under two months" — measured from the store's first trading day on
    // record, the only opening date this database holds. As of Aug 2026 no store
    // qualifies (BAL and MPL both opened in April), so this is dormant until the
    // next opening rather than a rule waiting to be remembered.
    const first = firstDay.get(store);
    const isNew = !!first
      && (Date.parse(ref + "T12:00:00Z") - Date.parse(first + "T12:00:00Z")) / 86_400_000 < T.newStoreDays;

    const hist = historyFor(facts, store, ref, 14);
    const { signals, score } = evaluate(f, hist, {
      isNew,
      record: recordFor.get(store) ?? null,
      staffed: f.staffed ?? null,
      monthDay: parts.day,
    });

    let sigs = signals;
    // Praise-only at the top of the month, and a big day cancels a correction:
    // both observed in his own record, not invented.
    //
    // "Big day" means SCALE — volume, sales, a record. Deliberately NOT a high
    // margin percentage: LEE on 2026-07-28 turned a 64.4% selling margin on only
    // $3,158 of sales, and an earlier version let that cancel the buy-margin
    // correction. What he actually sent that morning was "Let's try and tighten
    // up our buying margin a little bit" — a correction and nothing else. A good
    // percentage on a small day is not a parade, so it does not earn immunity.
    const BIG_DAY = ["buy_value", "net_sales", "buy_record", "buy_near_record"];
    const exceptional = sigs.some((s) => s.dir === "praise" && s.points >= 2 && BIG_DAY.includes(s.key));
    if (parts.day <= G.praiseOnlyThroughDay || exceptional) {
      sigs = sigs.filter((s) => s.dir !== "correct");
    }
    // At most one correction, and only within the weekly correction budget.
    const used = usedThisWeek.get(store) ?? { total: 0, corrections: 0 };
    let corrections = sigs.filter((s) => s.dir === "correct");
    if (used.corrections >= G.correctionsPerStorePerWeek) corrections = [];
    corrections = corrections.slice(0, 1);
    const praise = sigs.filter((s) => s.dir === "praise");
    sigs = [...praise, ...corrections];

    // A record or a perfect conversion day always goes out, cap or no cap.
    const override = sigs.some((s) => s.key === "buy_record" || s.key === "conv_perfect");

    if (!praise.length && !corrections.length) { skipReasons.push(`${store}: nothing fired`); continue; }
    if (!override && score < G.minScore && !corrections.length) {
      skipReasons.push(`${store}: score ${score} under ${G.minScore}`); continue;
    }
    if (!override && used.total >= G.perStorePerWeek) {
      skipReasons.push(`${store}: already ${used.total} messages this week`); continue;
    }

    candidates.push({
      store, signals: sigs, score, facts: f, override,
      kind: !praise.length ? "correction" : (corrections.length ? "mixed" : "praise"),
    });
  }

  candidates.sort((a, b) => (b.override ? 1 : 0) - (a.override ? 1 : 0) || b.score - a.score);

  // ---- write the sentences ----
  //
  // SEQUENTIAL, not Promise.all. Each call is shown the drafts already written
  // this morning so it can avoid their shape — and it cannot be shown them if
  // they are all in flight at once. Two stores firing on the same pair of signals
  // produced the same sentence twice when this ran in parallel.
  //
  // The cost is latency: three or four calls at ~2s each instead of one round.
  // Irrelevant for a 7:15am cron, and the drafts are not read until 8.
  const results: any[] = [];
  const written_so_far: string[] = [];

  for (const c of candidates) {
    const reason = c.signals.map((s) => s.fact).join("; ");
    const recent = byStore.get(c.store) ?? [];
    const examples = pickExamples(examplesAll, parts.day + STORES.indexOf(c.store));

    const sys = [
      { type: "text" as const, text: systemPrompt() },
      {
        type: "text" as const,
        text: "REAL MESSAGES HE HAS SENT — match this register, do not copy them:\n"
          + examples.map((m) => `- "${m}"`).join("\n"),
      },
    ];

    try {
      const ask = userPrompt(c.store, ref, c.signals, recent, c.facts, written_so_far);
      const turns: any[] = [{ role: "user", content: ask }];

      // Draft, check mechanically, and give it ONE chance to fix what it broke.
      //
      // The prompt has always forbidden figures and length; the blind test proved
      // instruction alone does not hold the line (14 of 15 drafts identified,
      // almost entirely on numbers and length). Feeding the specific violation back
      // is far more reliable than restating the rule, and one extra call on a
      // failing draft costs about a penny.
      let text = "", usage: any = null, fixed: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 400,
          // Adaptive by default on Opus 5. Effort kept low: the reasoning here is
          // small (pick an angle, stay inside the word count) and the latency
          // budget is a five-store fan-out inside one invocation.
          output_config: { effort: "low" },
          system: sys,
          messages: turns,
        });
        usage = res.usage;
        text = stripDashes(res.content
          .filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim()
          .replace(/^["“]|["”]$/g, "").trim());
        if (!text) throw new Error(`empty completion (stop_reason ${res.stop_reason})`);

        const bad = violations(text);
        if (!bad.length) break;
        if (attempt === 1) { fixed = bad; break; }   // second try still off: keep it, report it
        fixed = bad;
        turns.push({ role: "assistant", content: text });
        turns.push({ role: "user", content:
          "That breaks his rules:\n" + bad.map((b) => `- ${b}`).join("\n")
          + "\n\nRewrite it. Same facts, same warmth, shorter, and with no figures. Output the message only." });
      }

      written_so_far.push(text);
      results.push({
        store: c.store, ok: true, message: text, reason, kind: c.kind, score: c.score,
        signals: c.signals, usage, facts: factSnapshot(c.facts),
        // Surfaced so a rule the model keeps breaking is visible in the dryRun
        // output rather than only discoverable by reading 30 drafts by hand.
        retried: fixed.length ? fixed : undefined,
        stillBreaking: violations(text).length ? violations(text) : undefined,
      });
    } catch (err) {
      // One store failing must not cost the others their drafts — the loop
      // continues and the error rides out in `errors` for the caller to see.
      results.push({ store: c.store, ok: false, error: String((err as Error)?.message ?? err), reason });
    }
  }

  if (dryRun) {
    return json({ ok: true, dryRun: true, date: parts.iso, refDate: ref, results, skipped: skipReasons });
  }

  let written = 0;
  const errors: string[] = [];
  for (const r of results) {
    if (!r.ok) { errors.push(`${r.store}: ${(r as any).error}`); continue; }
    const row = {
      date: parts.iso, ref_date: ref, store: r.store, status: "pending",
      message: (r as any).message, reason: r.reason, signals: (r as any).signals,
      facts: (r as any).facts,
      score: (r as any).score, kind: (r as any).kind, model: MODEL,
      input_tokens: (r as any).usage?.input_tokens ?? null,
      output_tokens: (r as any).usage?.output_tokens ?? null,
    };
    // Idempotent per morning: a second run replaces a still-pending draft rather
    // than stacking a duplicate into the review card, and never touches one he
    // has already decided on.
    const { error } = await sb.from("comment_drafts").upsert(row, { onConflict: "store,date" });
    if (error) errors.push(`${r.store}: ${error.message}`);
    else written++;
  }

  await recordRun({
    date: parts.iso, ref_date: ref, ok: errors.length === 0,
    evaluated: STORES.length, drafted: written,
    skipped: skipReasons, errors,
  });

  return json({
    ok: errors.length === 0,
    date: parts.iso, refDate: ref,
    evaluated: STORES.length, drafted: written,
    skipped: skipReasons, errors,
  }, errors.length ? 500 : 200);
});
