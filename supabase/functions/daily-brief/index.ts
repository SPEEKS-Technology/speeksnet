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
  // Listed items are judged as a FRACTION OF THE STORE'S OWN DAILY GOAL (the sum
  // of each rostered person's target in listing_goals), not as a flat count —
  // Ethan 2026-08-14. Distribution over Aug 1-13: 35% of store-days at or above
  // goal, 13% at 150%+, and no store systematically high or low, which is exactly
  // what a flat count could not achieve.
  listedGoalPraise: 1.00,      // met their own goal
  listedGoalStrong: 1.50,      // well clear of it
  listedGoalLow: 0.60,         // needs a pattern, and someone rostered to list
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
      push({ key: "conv", dir: "praise", points: 1,
        fact: `customer conversion ${pct(f.custConv)} on ${f.custConvDen} customers` });
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

  // --- listed items, judged against the STORE'S OWN GOAL for that day.
  //
  // Not a flat item count. The goal is the sum of each rostered person's target,
  // so it already carries the staffing and role mix, and the same percentage means
  // the same thing at a two-person BAL and a four-person WSP. Measured over Aug
  // 1-13 the flat 20/25 rule silently missed LEE's best listing day of the window
  // (25 items against a goal of 10 — 250% — which "not more than 25" called
  // nothing) while nudging stores that were simply short-staffed.
  if (f.listedPct != null) {
    if (f.listedPct >= T.listedGoalPraise) {
      const strong = f.listedPct >= T.listedGoalStrong;
      // Worth more when they listed heavily AND bought heavily — his own phrasing
      // for that combination is "a very solid listing day even with 18 customers".
      const busy = f.buyValue >= buyFloor;
      push({ key: "listed", dir: "praise", points: (strong || busy) ? 2 : 1,
        fact: `${f.listed} items listed against a goal of ${f.storeGoal}`
          + ` (${Math.round(f.listedPct * 100)}%)`
          + (busy ? `, on a ${money(f.buyValue)} buying day` : ""),
        detail: strong ? "Well clear of goal — this is the kind of day worth leading with." : undefined });
    } else if (f.listedPct < T.listedGoalLow) {
      // Nobody rostered to a listing role means nobody was asked to list. Nudging
      // for it would be unfair and obviously so to the manager reading it.
      if ((f.listers ?? 0) > 0) {
        const recent = [f, ...hist].slice(0, T.patternOf)
          .filter((h) => h.listedPct != null && h.listedPct < T.listedGoalLow).length;
        if (recent >= T.patternHits) {
          push({ key: "listed_low", dir: "correct", points: 0,
            fact: `${f.listed} listed against a goal of ${f.storeGoal}`
              + ` (${Math.round(f.listedPct * 100)}%), ${recent} of the last ${T.patternOf} days under goal` });
        }
      }
    }
  }

  // --- Google reviews. ONLY from MTD movement (his rule): a jump day to day is
  // the signal, and a flat MTD across consecutive days is the nudge. The daily
  // count is deliberately unused — it lags and double-counts.
  if (f.fiveStarMtd != null) {
    const prev = hist.find((h) => h.fiveStarMtd != null);
    if (prev?.fiveStarMtd != null) {
      const jump = f.fiveStarMtd - prev.fiveStarMtd;
      if (jump >= 3) {
        push({ key: "reviews_jump", dir: "praise", points: 2,
          fact: `${jump} new 5-star reviews, ${f.fiveStarMtd} month to date` });
      } else if (jump > 0) {
        push({ key: "reviews_up", dir: "praise", points: 1,
          fact: `${jump} new 5-star review${jump === 1 ? "" : "s"}, ${f.fiveStarMtd} month to date` });
      } else {
        const flat = [f, ...hist].filter((h) => h.fiveStarMtd != null).slice(0, 3);
        const stuck = flat.length >= 3 && flat.every((h) => h.fiveStarMtd === f.fiveStarMtd);
        if (stuck) {
          push({ key: "reviews_flat", dir: "correct", points: 0,
            fact: `5-star reviews stuck on ${f.fiveStarMtd} for ${flat.length} days` });
        }
      }
    }
  }

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
    "- One or two sentences. Never more than about 25 words. Not one message in 150 is longer.",
    "- He opens with the REACTION, not the metric: \"Love seeing...\", \"Great...\", \"Huge...\", \"BOOM!\", \"Absolutely massive...\", \"HOLY...\", \"Props to you guys...\"",
    "- He names two or three things, usually paired: \"volume and margin\", \"conversion, volume, and listing productivity\".",
    "- He closes with a forward push, and only ever with one of HIS: \"Keep it up!\", \"Keep up the great work!\", \"Don't take your foot off the gas!\", \"Let's do it again today!\", \"Keep pushing!\", \"Let's keep that energy going!\". Do not invent a new one (\"let's run it back\" is not his). Not every message needs a closer at all.",
    "- Energy comes from caps, elongation and rhetorical questions: \"SALES ON SALES ON SALES\", \"lotsssssss of listings\", \"amazing as usual......\", \"Am I smelling a LEE record month???\"",
    "- He sometimes treats the store as a character (\"Team WSP\", \"the BUYING MACHINE\"). These are specific to the store he coined them for. NEVER transplant one to a different store — MPL's team would recognise their own nickname handed to BAL, and nothing gives a generated message away faster.",
    "- He calls the metric by name but almost NEVER quotes the dollar figure. \"Huge sales day\", not \"$7,863\". Numbers appear only as small counts (\"18 customers\", \"9 reviews\") or as targets (\"54%+ buy margin target\"). A message reciting revenue reads as automated — this is the single most important rule.",
    "- Corrections NEVER open negative. Always a sandwich — praise first, then the ask: \"Sales were great yesterday, but let's put some emphasis on customer conversion and buying margin.\" Or a bare soft ask: \"Let's try and tighten up our buying margin a little bit.\"",
    "- He writes to the team, not about them. \"You guys\", \"gentlemen\", first names when someone is named.",
    "",
    "HARD RULES:",
    "- Use ONLY the facts given. Never invent a number, a name, a rank, a record or a trend.",
    "- Do not quote dollar amounts unless the fact is a small count or a percentage target.",
    "- Output the message text ONLY. No greeting, no signature, no quote marks, no preamble.",
    "- At most one correction, and only if one is listed. If none is listed, the message is pure praise.",
    "- Do not reuse the opening words of the recent messages you are shown.",
    "- NEVER say a figure is \"over target\", \"above target\", \"beats the target\" or similar when praising. He cites the 54%+ target ONLY when asking for improvement. Praising a margin he says \"beautiful margin\", \"fantastic margin\", \"amazing as usual\" — the number is good on its own terms, not against a threshold. Naming a target while praising leaks the fact that a rule fired.",
    "- The SAME applies to listing goals. The facts give you a goal comparison so you know how good the day was; do NOT recite it. \"32 listings against a goal of 27\" is a spreadsheet talking. He says \"great listing productivity\", \"love seeing this listing productivity\", \"lotsssssss of listings\", \"smashing the listing productivity\", or on a short day \"let's get the listings back up\". Never quote the goal, the percentage, or \"X for X\".",
    "- Do not frame the day by its weekday (\"strong Monday\", \"good Tuesday\"). He says \"yesterday\" or nothing.",
    "- The example messages are for REGISTER ONLY. Do not reuse their sentence shapes with the nouns swapped. If your draft would still read as one of the examples after changing the store name and the metric, write a different sentence.",
  ].join("\n");
}

function userPrompt(store: string, refDate: string, signals: Signal[], recent: string[], f: Facts, siblings: string[]): string {
  const praise = signals.filter((s) => s.dir === "praise");
  const correct = signals.filter((s) => s.dir === "correct");
  const lines: string[] = [];

  lines.push(`Store: ${store}`);
  lines.push(`Reacting to: ${new Date(refDate + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`);
  lines.push("");
  lines.push("WHAT WENT WELL (lead with these):");
  praise.forEach((s) => lines.push(`- ${s.fact}${s.detail ? ` — ${s.detail}` : ""}`));

  if (correct.length) {
    lines.push("");
    lines.push("ONE THING TO PUSH ON (mention after the praise, softly):");
    correct.forEach((s) => lines.push(`- ${s.fact}${s.detail ? ` — ${s.detail}` : ""}`));
  }

  // Named people, straight from the report. This is where his best messages come
  // from ("great listing Zach", "C-Money coming in with 9 reviews") and it is the
  // one thing a generator could not otherwise reach.
  const top = Array.isArray(f.teamProduction)
    ? f.teamProduction.filter((t: any) => t?.top && t?.name)
    : [];
  if (top.length) {
    lines.push("");
    lines.push(`Top producer yesterday: ${top.map((t: any) => `${t.name} (${t.processed} processed)`).join(", ")}`);
    lines.push("You may name them. Only if it fits naturally — he does not do it every time.");
  }
  if (Array.isArray(f.shoutouts) && f.shoutouts.length) {
    lines.push("");
    lines.push("Customers named staff in 5-star reviews yesterday:");
    f.shoutouts.slice(0, 4).forEach((s: string) => lines.push(`- ${s}`));
  }

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
    lines.push("Already written to OTHER stores this morning. Yours must not share their sentence shape or their closing line:");
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
    // The crowned top producer — the ONE person a draft is allowed to name, so
    // the verification strip has to carry them. Every other claim in a message is
    // a number he can check against a column; "Zach led the way" was the single
    // assertion the strip said nothing about.
    topProducer: (() => {
      const tp = Array.isArray(f.teamProduction) ? f.teamProduction : [];
      const top = tp.find((p: any) => p && p.top);
      return top
        ? { name: String(top.name ?? ""), processed: top.processed ?? null, value: top.value ?? null }
        : null;
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
      // Published through the same shape the Send Store Comment tool uses, so
      // read receipts, the green bubble and the reads tab all work unchanged.
      const { data: pub, error } = await sb.from("store_comments").insert({
        date: new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago" }),
        store: draft.store,
        author: viewer?.name ?? "Ethan Kushnir",
        message: text,
      }).select("id").single();
      if (error) return json({ ok: false, error: error.message }, 500);
      patch.published_comment_id = pub.id;
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
    // The governor's window: drafts already written this Mon-Sun week.
    sb.from("comment_drafts").select("store,date,kind,status")
      .gte("date", addDays(parts.iso, -((parts.dow + 6) % 7))).lte("date", parts.iso),
    // Anything he has ALREADY approved or skipped for this morning is finished
    // business — a re-run must not reopen it, and an approved one has already
    // been published to the store.
    sb.from("comment_drafts").select("store,status").eq("date", parts.iso).neq("status", "pending"),
    // First trading day on record per store, for the "open under two months"
    // thresholds. Cheap, and it keeps that rule real for the next opening
    // instead of a constant nobody remembers to switch on.
    sb.from("daily_buysell").select("store,date").gt("buy", 0)
      .order("date", { ascending: true }).limit(2000),
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
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 400,
        // Adaptive by default on Opus 5. Effort kept low: the reasoning here is
        // small (pick an angle, stay inside 25 words) and the latency budget is
        // a five-store fan-out inside one edge-function invocation.
        output_config: { effort: "low" },
        system: sys,
        messages: [{ role: "user", content: userPrompt(c.store, ref, c.signals, recent, c.facts, written_so_far) }],
      });

      const text = res.content
        .filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim()
        .replace(/^["“]|["”]$/g, "").trim();
      if (!text) throw new Error(`empty completion (stop_reason ${res.stop_reason})`);

      written_so_far.push(text);
      results.push({
        store: c.store, ok: true, message: text, reason, kind: c.kind, score: c.score,
        signals: c.signals, usage: res.usage, facts: factSnapshot(c.facts),
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
