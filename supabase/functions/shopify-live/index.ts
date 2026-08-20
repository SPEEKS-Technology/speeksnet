// ============================================================================
// shopify-live — live store metrics for the Live Dashboard tab.
//
// Two entry points, deliberately separated:
//
//   ?secret=<sync>   pg_cron, once a minute. Talks to Shopify, writes app_cache,
//                    broadcasts on change. The ONLY path that calls Shopify.
//   x-user-pin       the browser. Reads the cache. Never calls Shopify, never
//                    sees a token.
//
// Shopify tokens live in shopify_stores (service-role only) and are never
// returned, logged, or reachable from the client. That has not changed and is
// the part that matters.
//
// WHAT DID CHANGE: the read path used to hand a store employee their own store
// and nothing else. It now returns all five stores and the district roll-up to
// every signed-in user — see scopeFor. The Live Dashboard replaced the Buying &
// Sales tab on the store Command Center, and it is shown district-wide on
// purpose so a store can see where it stands against the others. So the pin is
// still an authentication check, but it is no longer an authorization one: any
// valid pin sees the whole district's sales, cost, margin, goals and buying.
// Whoever can open the site can read those numbers.
//
// REFRESH WINDOW (America/Chicago, computed here so DST needs no second cron)
//   TWO SEPARATE QUESTIONS, and conflating them is what put an "open" pill on a
//   Sunday morning. isRefreshWindow() is about how often we do work;
//   isTrading() is about whether the shop has its doors open. They were one
//   function until Ethan spotted the pill (20 Aug).
//
//       isRefreshWindow  every day 08:00-21:00   (trading + a 2h buffer either
//                        side, so early arrivals and late closers are covered)
//       isTrading        Mon-Fri 10:00-19:00, Sat 10:00-16:00, never Sunday
//
//   Inside the refresh window: refresh every minute.
//   Outside it: refresh only if the cache is over an hour stale. That is the
//   overnight pause — 11 refreshes between close and open instead of 660 — done
//   with the staleness check rather than a second cron, so DST needs no care.
//   A long heartbeat rather than a hard stop, on purpose: nothing scheduled reads
//   this cache overnight, but a manager opening the app at 07:30 should not be
//   looking at last night 9pm numbers. CLOSED_STALE_MS = Infinity for a true stop.
//
// COST: one ShopifyQL query plus one recent-orders query per store, ~10 points
// each against a 2000-point bucket restoring at 100/s — and each store is its own
// shop with its own bucket. A per-minute pass over five stores is nowhere near a
// limit.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Machine auth (pg_cron only). Deliberately NOT present in speeks.js: this same
// secret guards weekly-report, which emails real store managers, and the Gmail
// relay. The browser gets the pin path instead.
const SECRET = "sp33ks-sync-k3y-2026-x9mq";

const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";
const CACHE_KEY = "shopify_live";
const TZ = "America/Chicago";

// Stale threshold for the closed-hours cadence.
const CLOSED_STALE_MS = 60 * 60 * 1000;   // overnight heartbeat — see the header

// shop domain -> the store code used everywhere else on the site.
const SHOP_TO_CODE: Record<string, string> = {
  "paymore-overland-park.myshopify.com": "OVL",
  "paymore-lees-summit.myshopify.com": "LEE",
  "paymore-westport.myshopify.com": "WSP",
  "paymore-maplewood.myshopify.com": "MPL",
  "paymore-ballwin.myshopify.com": "BAL",
};
const STORE_ORDER = ["OVL", "LEE", "WSP", "MPL", "BAL"];
// How many of today's orders ride along on each store row, for the activity strip
// to open with. Matches what that strip pins (LV_ACTIVITY_KEEP in speeks.js) —
// fetching more would only be trimmed on arrival.
const RECENT_ORDERS = 5;
const STORE_NAMES: Record<string, string> = {
  OVL: "Overland Park", LEE: "Lees Summit", WSP: "Westport",
  MPL: "Maplewood", BAL: "Ballwin",
};

// UNUSED as of the district-for-everyone change — scopeFor no longer consults
// them. Kept deliberately, not overlooked: they are the two facts a restored
// gate would need, and re-deriving them from scratch is how the KPI role-gate
// bug happened. Delete them only when the decision to show every store to
// everyone is settled for good.
//
// Everyone at CORP sees the district. Kept as a role list too, because role and
// store have drifted apart before.
const DISTRICT_ROLES = ["ceo", "district manager", "tom"];
// The Multi-Store Manager runs BAL and MPL — the same scoping the checklist,
// audit panel and Listing Goals still use.
const MSM_STORES = ["BAL", "MPL"];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// --- Central-time helpers ---------------------------------------------------
// The edge runtime is UTC. Every date decision here goes through Intl with an
// explicit timeZone, so "today" means the store's today and DST is not our
// problem. (A naive new Date() rolls the day over at 7pm Central — that exact
// bug reset checklists a day early.)

type Central = { y: number; m: number; d: number; hour: number; minute: number; dow: number };

function centralNow(now: Date): Central {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    // Intl gives hour "24" at midnight with hour12:false in some runtimes.
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    dow: dowMap[get("weekday")] ?? 0,
  };
}

/**
 * How often we do work: the buffered window, seven days a week. Nothing about
 * this is shown to anyone — it only decides whether this pass calls Shopify or
 * skips on a fresh cache.
 */
function isRefreshWindow(c: Central): boolean {
  return c.hour >= 8 && c.hour < 21;
}

/**
 * Whether the shop is actually trading. THIS is what the dashboard shows.
 *
 * It drives two things: the freshness pill (a green pulsing "open" against the
 * grey "closed"), and whether the activity strip pins recent sales instead of
 * running as a ticker. Both are claims about the shop floor, so both have to
 * follow the real hours — a pill reading "open" at 08:15 on a Sunday is simply
 * false, however busy the webstore is.
 *
 * Note what "closed" does NOT mean here: finished. The Today tab keeps taking
 * online orders after the doors shut, so it stays grey-but-live; only the
 * Yesterday and Month tabs say "final", and they decide that for themselves
 * (see _lvFreshness) without consulting this.
 */
function isTrading(c: Central): boolean {
  if (c.dow === 0) return false;                        // closed Sunday
  if (c.dow === 6) return c.hour >= 10 && c.hour < 16;  // Sat 10-4
  return c.hour >= 10 && c.hour < 19;                   // Mon-Fri 10-7
}

/**
 * Days in the month, and how many have elapsed including today. This is the
 * denominator behind the pace pill: pace = (GP banked ÷ goal) ÷ (month elapsed),
 * which is arithmetically the same as projected-month-end GP ÷ goal on a flat
 * run rate.
 *
 * CALENDAR days, Sundays included. This used to exclude Sundays as non-selling
 * days, which was wrong in a way that quietly inflated every store's pace: the
 * webstore trades on Sunday, so Sunday's gross profit landed in the numerator
 * while Sunday itself was missing from the denominator — five days of earnings
 * divided by four days. OVL on 2026-08-05 read 118 against the Buy/Sell sheet's
 * 112.49% for the identical $13,970.91 of GP against the identical $77,000 goal;
 * the whole gap was 26/4 versus 31/5.
 *
 * Matching the sheet is also the point: staff compare the two screens, and a
 * dashboard that disagrees with the workbook reads as one of them being broken.
 */
function monthDays(c: Central): { total: number; elapsed: number } {
  return { total: new Date(Date.UTC(c.y, c.m, 0)).getUTCDate(), elapsed: c.d };
}

const iso = (c: Central) =>
  `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;

// Which Central day an order timestamp falls on. Shopify stamps createdAt in UTC,
// so a 7pm sale is already "tomorrow" there for five hours every evening — the
// exact hours the stores are still open. en-CA formats as YYYY-MM-DD, which is
// what everything else here compares against. Hoisted because it runs per order.
const DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
});
const centralDay = (ts: string) => {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? "" : DAY_FMT.format(d);
};

// --- yesterday ---------------------------------------------------------------
// Literally the previous CALENDAR day, Sundays included. The stores are shut on
// Sunday but the webstore is not, so a Sunday still has sales worth seeing — and
// skipping it would mean Monday's "yesterday" silently showed Saturday, which is
// a lie people would act on.
//
// Note this is deliberately NOT the same rule as sellingDays(): that one excludes
// Sundays because it measures how much of the SELLING month has gone, which is
// what a monthly goal is set against. Both rules are right for their own job.
type PrevDay = {
  iso: string;          // the day being reported
  sinceDays: number;    // how far the ShopifyQL window must reach back
  inMonth: boolean;     // false on the 1st, when it belongs to last month
  day: number;          // day-of-month, for the selling-day count
};

function prevDay(c: Central): PrevDay {
  const d = new Date(Date.UTC(c.y, c.m - 1, c.d - 1));
  const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
    + `-${String(d.getUTCDate()).padStart(2, "0")}`;
  return {
    iso,
    // On the 1st of a month this reaches into LAST month, which is why the
    // accumulator in fetchStore filters rows by month rather than trusting the
    // window to contain only in-month days.
    sinceDays: Math.max(c.d - 1, 1),
    inMonth: iso.slice(0, 7) === `${c.y}-${String(c.m).padStart(2, "0")}`,
    day: d.getUTCDate(),
  };
}

// --- comparison periods ------------------------------------------------------
// Month-over-month and year-over-year, as WHOLE FINISHED MONTHS.
//
// Whole months rather than the same span of days, because of what these figures
// are read against: the Tracking band's tiles are month-END PROJECTIONS, and the
// question a projection answers is "will this month beat last month?". So the
// delta measures this month's projection against that month's actual — which is
// exactly what the Daily Breakdown popout does, and what the Sales Summary
// workbook's own YoY line does (verified there to the dollar on OVL August:
// a $145,167 projection against $105,622.08 for August 2025 gives its 37.44%).
// Two surfaces quoting the same comparison must not compute it two ways.
//
// An earlier build used matched day-of-month spans (Aug 1-16 vs Jul 1-16) against
// the banked figures instead. That is a coherent comparison too, but it is not the
// one the tiles carrying it are about, and it left the site with two different
// definitions of "vs last month".
type Span = { from: string; to: string; days: number; ym: string };

const ymd = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const wholeMonth = (y: number, m: number): Span => ({
  from: ymd(y, m, 1),
  to: ymd(y, m, daysInMonth(y, m)),
  days: daysInMonth(y, m),
  ym: `${y}-${String(m).padStart(2, "0")}`,
});

function cmpSpans(c: Central, pd: PrevDay): { cur: Span; lastMonth: Span; lastYear: Span } | null {
  // On the 1st there is no complete day in this month yet, so the Month tab is not
  // offered and there is nothing to compare.
  if (!pd.inMonth) return null;
  return {
    cur: wholeMonth(c.y, c.m),
    lastMonth: c.m === 1 ? wholeMonth(c.y - 1, 12) : wholeMonth(c.y, c.m - 1),
    lastYear: wholeMonth(c.y - 1, c.m),
  };
}

// --- Shopify ----------------------------------------------------------------

async function gql(shop: string, token: string, query: string) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch (_) { /* surfaced by the caller */ }
  // Shopify answers 200 with an `errors` array for a bad query, so status alone
  // proves nothing.
  if (!res.ok || !parsed || parsed.errors) {
    throw new Error(
      `${res.status} ${JSON.stringify(parsed?.errors ?? text.slice(0, 160))}`,
    );
  }
  return parsed.data;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

// One finished comparison month for one store. Selling comes from Shopify;
// `resale` and `paid` are the BUYING half and come from the sheet's own tables —
// Shopify knows nothing about what was bought over the counter.
type CmpFigures = Span & {
  net: number; cogs: number; gp: number; orders: number; returns: number;
  // Resale value of goods bought, and the cash actually paid out. Null when the
  // sheet has no figures for that month, which is a different thing from zero —
  // see the naming inversion note on loadBuyCompare.
  resale: number | null; paid: number | null;
  // Did this store trade at all in the window? Maplewood and Ballwin did not
  // exist in August 2025 — Shopify's first real month for them is April and May
  // 2026 — and a store with no history has to read as "no last year" rather than
  // as a month in which it sold nothing. The first is an absence of data, the
  // second is a business result, and showing one as the other would put a
  // meaningless +51% on the district tile. This flag is what keeps the district
  // year-over-year on a same-store basis, and it is derived from the data rather
  // than from a list of store codes, so it corrects itself the month a store's
  // history catches up.
  has: boolean;
};
type StoreCompare = { through: string; days: number; lastMonth: CmpFigures; lastYear: CmpFigures };

/**
 * The two comparison windows for one store: one request, both spans, no GROUP BY
 * — each answers with a single summary row.
 *
 * Runs at most ONCE A DAY. Both windows are finished days, so they can only move
 * when a back-dated refund lands against them or when the span itself rolls over
 * at midnight; refresh() carries the answer forward on every other pass, which
 * keeps this off the per-minute Shopify call entirely.
 */
async function fetchCompare(
  shop: string, token: string, spans: { cur: Span; lastMonth: Span; lastYear: Span },
): Promise<StoreCompare | null> {
  const q = (s: Span) =>
    `FROM sales SHOW net_sales, cost_of_goods_sold, orders, returns SINCE ${s.from} UNTIL ${s.to}`;
  try {
    const data = await gql(shop, token, `{
      lm: shopifyqlQuery(query: "${q(spans.lastMonth)}") { parseErrors tableData { rows } }
      ly: shopifyqlQuery(query: "${q(spans.lastYear)}") { parseErrors tableData { rows } }
    }`);
    const read = (key: string, span: Span): CmpFigures => {
      const node = (data as any)?.[key];
      if (node?.parseErrors?.length) throw new Error(`ShopifyQL: ${node.parseErrors.join("; ")}`);
      const row = (node?.tableData?.rows ?? [])[0] ?? null;
      const net = round2(num(row?.net_sales));
      const cogs = round2(num(row?.cost_of_goods_sold));
      const orders = num(row?.orders);
      return {
        ...span,
        net, cogs, gp: round2(net - cogs), orders,
        // Returns come back NEGATIVE here exactly as they do on the daily rows.
        returns: round2(Math.abs(num(row?.returns))),
        // Filled in by loadBuyCompare, from the sheet's tables rather than Shopify.
        resale: null, paid: null,
        has: !!row && orders > 0,
      };
    };
    return {
      through: spans.cur.to,
      days: spans.cur.days,
      lastMonth: read("lm", spans.lastMonth),
      lastYear: read("ly", spans.lastYear),
    };
  } catch (_) {
    // A comparison that cannot be fetched is DROPPED, never zeroed. The Month tab
    // then shows its month as usual with nothing to compare it against, which is
    // honest; a zeroed window would read as a store that took no money last year.
    // The next pass retries, because the carry-forward key still will not match.
    return null;
  }
}

/**
 * The BUYING half of both comparison months, per store code.
 *
 * Shopify has no idea what was bought over the counter, so this comes from the two
 * tables the sheet feeds — the same sources the Daily Breakdown popout reads, so
 * the two surfaces cannot quote different figures for the same month:
 *   last month     -> daily_buysell (daily rows, 2026-01 onward)
 *   last year      -> buysell_monthly_history (month totals; 2025 has no days
 *                     anywhere in the database, only these totals)
 *
 * ⚠️ THE NAMING INVERSION. The sheet's column headings are backwards from this
 * codebase's vocabulary and swapping them is a silent ~2x error:
 *   sheet "Sell" column = resale value of goods BOUGHT = daily_buysell.buy -> resale
 *   sheet "Buy"  column = cash actually paid out = resale x (1 - buy_margin_pct) -> paid
 * daily_buysell.buy is therefore the ESTIMATED VALUE, not the cash. Renamed here at
 * the boundary so no caller has to remember.
 */
async function loadBuyCompare(
  sb: any, spans: { lastMonth: Span; lastYear: Span },
): Promise<Record<string, { lastMonth: [number, number] | null; lastYear: [number, number] | null }>> {
  const out: Record<string, { lastMonth: [number, number] | null; lastYear: [number, number] | null }> = {};
  for (const code of STORE_ORDER) out[code] = { lastMonth: null, lastYear: null };

  try {
    const { data } = await sb.from("daily_buysell")
      .select("store, buy, buy_margin_pct")
      .gte("date", spans.lastMonth.from).lte("date", spans.lastMonth.to);
    const acc: Record<string, [number, number]> = {};
    for (const r of (data ?? [])) {
      const code = String(r.store || "").toUpperCase();
      if (!out[code]) continue;
      const resale = num(r.buy);
      if (!resale) continue;                         // a closed day, or one not keyed yet
      // Cash paid is SUMMED per day, never derived from a mean of the daily
      // margins: margins cannot be averaged across days of different size.
      const paid = resale * (1 - num(r.buy_margin_pct));
      acc[code] = acc[code] ?? [0, 0];
      acc[code][0] += resale;
      acc[code][1] += paid;
    }
    for (const code of Object.keys(acc)) {
      out[code].lastMonth = [round2(acc[code][0]), round2(acc[code][1])];
    }
  } catch (_) { /* no buying comparison rather than a wrong one */ }

  try {
    const { data } = await sb.from("buysell_monthly_history")
      .select("store, resale, paid").eq("ym", spans.lastYear.ym);
    for (const r of (data ?? [])) {
      const code = String(r.store || "").toUpperCase();
      if (!out[code]) continue;
      const resale = num(r.resale);
      if (resale > 0) out[code].lastYear = [round2(resale), round2(num(r.paid))];
    }
  } catch (_) { /* same */ }

  return out;
}

// The closed-out numbers for the previous open day. Field names deliberately
// MIRROR the live ones (netToday, mtdNet, …) so the frontend can overlay this
// object onto the store row and reuse every renderer unchanged, rather than
// growing a second copy of each one that differs only in which key it reads.
type DayMetrics = {
  netToday: number; cogsToday: number; gpToday: number; ordersToday: number;
  returnsToday: number; marginToday: number | null; aov: number | null;
  mtdNet: number; mtdCogs: number; mtdGp: number; mtdOrders: number;
  mtdReturns: number; mtdMargin: number | null;
  pctOfGoal: number | null; paceIndex: number | null;
};

type StoreMetrics = {
  code: string; name: string;
  netToday: number; cogsToday: number; gpToday: number; ordersToday: number;
  returnsToday: number; marginToday: number | null; aov: number | null;
  mtdNet: number; mtdCogs: number; mtdGp: number; mtdOrders: number;
  mtdReturns: number; mtdMargin: number | null;
  goal: number; pctOfGoal: number | null; paceIndex: number | null;
  lastOrderAt: string | null; lastOrderAmount: number | null;
  // Today's last few orders, newest first. The activity strip on a store dashboard
  // pins the most recent sales, and derived-by-diffing alone means it can only ever
  // show what happened while that page was open — so a screen switched on at noon,
  // or signed back in after a break, sat empty next to a till that had been ringing
  // all morning. This is the same list the strip would have built for itself.
  recentOrders: { at: string; amount: number }[];
  prev: DayMetrics | null;
  // Month-over-month and year-over-year for the month-through-yesterday span.
  // Filled in by refresh() rather than by fetchStore: it is fetched once a day and
  // carried forward the rest of the time, so it does not belong on the per-minute
  // path. Null means "no comparison available", which the UI states rather than
  // filling with zeros.
  cmp?: StoreCompare | null;
  error?: string;
};

async function fetchStore(
  shop: string, token: string, c: Central, goal: number, pd: PrevDay,
): Promise<StoreMetrics> {
  const code = SHOP_TO_CODE[shop] ?? shop;
  const base: StoreMetrics = {
    code, name: STORE_NAMES[code] ?? code,
    netToday: 0, cogsToday: 0, gpToday: 0, ordersToday: 0, returnsToday: 0,
    marginToday: null, aov: null,
    mtdNet: 0, mtdCogs: 0, mtdGp: 0, mtdOrders: 0, mtdReturns: 0, mtdMargin: null,
    goal, pctOfGoal: null, paceIndex: null,
    lastOrderAt: null, lastOrderAmount: null,
    recentOrders: [],
    prev: null,
  };

  try {
    // One query covers today AND month-to-date: -Nd back to the 1st, grouped by
    // day. cost_of_goods_sold rather than net_sales - gross_profit, which
    // disagrees on about half of all days and would put the dashboard at odds
    // with the Sales Summary sheet staff already compare against.
    //
    // The previous open day is in this SAME response — it always was, and was
    // being folded into the MTD totals and then thrown away. Reporting it costs
    // no extra Shopify call; only the window start moves, and only on the 1st.
    const sinceDays = pd.sinceDays;
    const data = await gql(shop, token, `{
      shopifyqlQuery(query: "FROM sales SHOW net_sales, cost_of_goods_sold, orders, returns GROUP BY day SINCE -${sinceDays}d UNTIL today ORDER BY day") {
        parseErrors
        tableData { rows }
      }
      orders(first: ${RECENT_ORDERS}, reverse: true, sortKey: CREATED_AT) {
        nodes { createdAt currentTotalPriceSet { shopMoney { amount } } }
      }
    }`);

    const q = data?.shopifyqlQuery;
    if (q?.parseErrors?.length) throw new Error(`ShopifyQL: ${q.parseErrors.join("; ")}`);
    const rows: any[] = q?.tableData?.rows ?? [];
    const todayIso = iso(c);
    const monthPrefix = `${c.y}-${String(c.m).padStart(2, "0")}`;

    // Month-to-date as it stood at the CLOSE of the previous open day. Derived by
    // subtracting everything dated after it rather than re-summing, so the two
    // figures can never disagree about which days they include.
    let afterNet = 0, afterCogs = 0, afterOrders = 0, afterReturns = 0;
    let pNet = 0, pCogs = 0, pOrders = 0, pReturns = 0;

    for (const r of rows) {
      const day = String(r.day).slice(0, 10);
      const net = num(r.net_sales), cogs = num(r.cost_of_goods_sold), ord = num(r.orders);
      // Returns come back NEGATIVE from ShopifyQL; every figure below is a magnitude.
      const ret = Math.abs(num(r.returns));

      // The window reaches into last month on the 1st, so MTD is filtered by
      // month here. Accumulating blind would have carried a December day into a
      // January total the moment this feature widened the window.
      if (day.slice(0, 7) === monthPrefix) {
        base.mtdNet += net; base.mtdCogs += cogs; base.mtdOrders += ord;
        base.mtdReturns += ret;
        if (day > pd.iso) {
          afterNet += net; afterCogs += cogs; afterOrders += ord; afterReturns += ret;
        }
      }

      if (day === todayIso) {
        base.netToday = round2(net);
        base.cogsToday = round2(cogs);
        base.ordersToday = ord;
        // returns come back negative; show the magnitude.
        base.returnsToday = round2(ret);
      }
      if (day === pd.iso) {
        pNet = net; pCogs = cogs; pOrders = ord; pReturns = ret;
      }
    }

    base.mtdNet = round2(base.mtdNet);
    base.mtdCogs = round2(base.mtdCogs);
    base.mtdReturns = round2(base.mtdReturns);
    base.gpToday = round2(base.netToday - base.cogsToday);
    base.mtdGp = round2(base.mtdNet - base.mtdCogs);

    // Guarded: a store with no sales yet today would otherwise divide by zero
    // and render NaN%. Null means "nothing to show", which the UI can dash out.
    base.marginToday = base.netToday > 0
      ? round2((base.netToday - base.cogsToday) / base.netToday * 100) : null;
    base.aov = base.ordersToday > 0 ? round2(base.netToday / base.ordersToday) : null;
    base.mtdMargin = base.mtdNet > 0
      ? round2((base.mtdNet - base.mtdCogs) / base.mtdNet * 100) : null;

    if (pd.iso) {
      // When the previous open day belongs to last month there is no meaningful
      // "month to date" to show beside it, so those fields go null and the UI
      // drops the goal bar rather than printing a zero that looks like failure.
      const pMtdNet = pd.inMonth ? round2(base.mtdNet - afterNet) : 0;
      const pMtdCogs = pd.inMonth ? round2(base.mtdCogs - afterCogs) : 0;
      base.prev = {
        netToday: round2(pNet),
        cogsToday: round2(pCogs),
        gpToday: round2(pNet - pCogs),
        ordersToday: pOrders,
        returnsToday: round2(pReturns),
        marginToday: pNet > 0 ? round2((pNet - pCogs) / pNet * 100) : null,
        aov: pOrders > 0 ? round2(pNet / pOrders) : null,
        mtdNet: pMtdNet,
        mtdCogs: pMtdCogs,
        mtdGp: round2(pMtdNet - pMtdCogs),
        mtdOrders: pd.inMonth ? base.mtdOrders - afterOrders : 0,
        mtdReturns: pd.inMonth ? round2(base.mtdReturns - afterReturns) : 0,
        mtdMargin: pMtdNet > 0 ? round2((pMtdNet - pMtdCogs) / pMtdNet * 100) : null,
        // Filled in by refresh(), which is where the goal lives. Present as null
        // either way: the frontend overlays this object onto the live row, and a
        // MISSING key would let today's pace show through under a past date.
        pctOfGoal: null, paceIndex: null,
      };
    }

    const nodes: any[] = data?.orders?.nodes ?? [];
    const last = nodes[0];
    if (last) {
      base.lastOrderAt = last.createdAt ?? null;
      base.lastOrderAmount = round2(num(last.currentTotalPriceSet?.shopMoney?.amount));
    }
    // TODAY's only. The connection returns the newest orders full stop, so a store
    // that has not sold anything yet this morning would otherwise hand the strip
    // five of yesterday's — announced, on a shop floor, as what is happening now.
    // Filtered here rather than with a `query:` argument so the same response keeps
    // serving lastOrderAt, which deliberately survives an empty day.
    base.recentOrders = nodes
      .filter(o => o?.createdAt && centralDay(o.createdAt) === todayIso)
      .map(o => ({
        at: String(o.createdAt),
        amount: round2(num(o.currentTotalPriceSet?.shopMoney?.amount)),
      }));
  } catch (err) {
    // One store failing must not blank the other four. The row carries its own
    // error and the district totals simply exclude it.
    base.error = String(err).slice(0, 200);
  }

  return base;
}

// --- goals ------------------------------------------------------------------
// The monthly GP goal is a static number the DM already maintains, and it is
// already synced into app_cache/buy_sell_hub as <store>Goal. Read it rather than
// duplicating it: a second copy would drift the first time goals change.
async function loadGoals(sb: any): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const { data } = await sb.from("app_cache").select("payload").eq("key", "buy_sell_hub").single();
    const p = data?.payload ?? {};
    for (const code of STORE_ORDER) out[code] = Math.round(num(p[`${code.toLowerCase()}Goal`]));
  } catch (_) { /* goals absent -> tiles show a dash rather than a wrong number */ }
  return out;
}

/**
 * District/roll-up totals for the previous open day.
 *
 * Kept separate from the live roll-up above rather than generalised into one
 * function: the live one also carries storesReporting, aov labelling and the
 * last-order sweep, none of which mean anything on a closed day.
 */
function rollPrev(healthy: StoreMetrics[], goal: number, elapsedPct: number): DayMetrics | null {
  const parts = healthy.map(m => m.prev).filter(Boolean) as DayMetrics[];
  if (!parts.length) return null;
  const sum = (f: (p: DayMetrics) => number) => round2(parts.reduce((a, p) => a + f(p), 0));
  const net = sum(p => p.netToday), cogs = sum(p => p.cogsToday);
  const orders = parts.reduce((a, p) => a + p.ordersToday, 0);
  const mtdNet = sum(p => p.mtdNet), mtdCogs = sum(p => p.mtdCogs);
  const mtdGp = round2(mtdNet - mtdCogs);
  const pctOfGoal = goal > 0 ? round2(mtdGp / goal * 100) : null;
  return {
    netToday: net, cogsToday: cogs, gpToday: round2(net - cogs),
    ordersToday: orders, returnsToday: sum(p => p.returnsToday),
    marginToday: net > 0 ? round2((net - cogs) / net * 100) : null,
    aov: orders > 0 ? round2(net / orders) : null,
    mtdNet, mtdCogs, mtdGp,
    mtdOrders: parts.reduce((a, p) => a + p.mtdOrders, 0),
    mtdReturns: sum(p => p.mtdReturns),
    mtdMargin: mtdNet > 0 ? round2(mtdGp / mtdNet * 100) : null,
    pctOfGoal,
    paceIndex: pctOfGoal !== null && elapsedPct > 0
      ? Math.round(pctOfGoal / elapsedPct * 100) : null,
  };
}

// --- refresh ----------------------------------------------------------------

async function refresh(sb: any, now: Date, force: boolean) {
  const c = centralNow(now);
  // The cadence question and the display question, kept apart.
  const refreshing = isRefreshWindow(c);
  const open = isTrading(c);

  const { data: cached } = await sb.from("app_cache").select("payload, synced_at")
    .eq("key", CACHE_KEY).maybeSingle();
  const prev = cached?.payload ?? null;
  const ageMs = cached?.synced_at ? now.getTime() - new Date(cached.synced_at).getTime() : Infinity;

  // The whole closed-hours cadence, in one condition: outside the window we only
  // work if the cache has gone stale.
  if (!force && !refreshing && ageMs < CLOSED_STALE_MS) {
    return {
      ok: true, skipped: "outside the refresh window and the cache is fresh",
      open, refreshing, ageSeconds: Math.round(ageMs / 1000),
    };
  }

  const { data: stores } = await sb.from("shopify_stores").select("shop, access_token");
  if (!stores?.length) return { ok: false, error: "no stores connected" };

  const goals = await loadGoals(sb);
  const sd = monthDays(c);
  const pd = prevDay(c);
  // The same count taken a day earlier, so yesterday's pace is judged against
  // yesterday's expectation rather than today's.
  const psd = pd.inMonth ? monthDays({ ...c, d: pd.day }) : null;

  const metrics = await Promise.all(
    stores.map((s: any) => fetchStore(s.shop, s.access_token, c, goals[SHOP_TO_CODE[s.shop]] ?? 0, pd)),
  );

  // --- month-over-month / year-over-year --------------------------------------
  // Both windows are FINISHED days, so they only move when the span itself rolls
  // over at midnight (or when a back-dated refund lands against one). Fetching
  // them on the per-minute pass would be ten extra Shopify queries a minute for
  // numbers that change once a day, so the stored payload's answer is carried
  // forward and `cmpThrough` is the key that says whether it is still current.
  //
  // A store whose carried answer is MISSING is fetched even on a carry-forward
  // pass: a store that errored yesterday, or one connected since, would otherwise
  // wait until tomorrow's rollover for a comparison the others already have.
  const spans = cmpSpans(c, pd);
  const cmpThrough = spans ? spans.cur.to : null;
  const carried: Record<string, StoreCompare> = {};
  for (const s of (prev?.stores ?? [])) {
    if (s?.code && s.cmp && s.cmp.through === cmpThrough) carried[s.code] = s.cmp;
  }
  if (spans) {
    await Promise.all(metrics.map(async (m) => {
      if (m.error) return;
      if (carried[m.code]) { m.cmp = carried[m.code]; return; }
      const s = stores.find((x: any) => SHOP_TO_CODE[x.shop] === m.code);
      m.cmp = s ? await fetchCompare(s.shop, s.access_token, spans) : null;
    }));
    // The buying half, only when at least one store actually needed a fetch —
    // otherwise the carried figures already have it.
    if (metrics.some(m => !m.error && m.cmp && !carried[m.code])) {
      const buy = await loadBuyCompare(sb, spans);
      for (const m of metrics) {
        if (!m.cmp) continue;
        const b = buy[m.code];
        if (!b) continue;
        if (b.lastMonth) { m.cmp.lastMonth.resale = b.lastMonth[0]; m.cmp.lastMonth.paid = b.lastMonth[1]; }
        if (b.lastYear) { m.cmp.lastYear.resale = b.lastYear[0]; m.cmp.lastYear.paid = b.lastYear[1]; }
      }
    }
  }

  // Goal progress against SELLING-day progress, so "17% of goal" on day 5 reads
  // as slightly ahead rather than alarming. No forecast involved.
  const elapsedPct = sd.total > 0 ? sd.elapsed / sd.total * 100 : 0;
  const prevElapsedPct = psd && sd.total > 0 ? psd.elapsed / sd.total * 100 : 0;
  for (const m of metrics) {
    if (m.goal > 0) {
      m.pctOfGoal = round2(m.mtdGp / m.goal * 100);
      m.paceIndex = elapsedPct > 0 ? Math.round(m.pctOfGoal / elapsedPct * 100) : null;
      if (m.prev && pd.inMonth) {
        m.prev.pctOfGoal = round2(m.prev.mtdGp / m.goal * 100);
        m.prev.paceIndex = prevElapsedPct > 0
          ? Math.round(m.prev.pctOfGoal / prevElapsedPct * 100) : null;
      }
    }
  }

  const ordered = STORE_ORDER
    .map(code => metrics.find(m => m.code === code))
    .filter(Boolean) as StoreMetrics[];
  const healthy = ordered.filter(m => !m.error);

  const sum = (f: (m: StoreMetrics) => number) => round2(healthy.reduce((a, m) => a + f(m), 0));
  const dNet = sum(m => m.netToday), dCogs = sum(m => m.cogsToday);
  const dOrders = healthy.reduce((a, m) => a + m.ordersToday, 0);
  const dMtdNet = sum(m => m.mtdNet), dMtdCogs = sum(m => m.mtdCogs);
  const dGoal = healthy.reduce((a, m) => a + m.goal, 0);

  const district = {
    netToday: dNet,
    cogsToday: dCogs,
    gpToday: round2(dNet - dCogs),
    ordersToday: dOrders,
    returnsToday: sum(m => m.returnsToday),
    marginToday: dNet > 0 ? round2((dNet - dCogs) / dNet * 100) : null,
    aov: dOrders > 0 ? round2(dNet / dOrders) : null,
    mtdNet: dMtdNet,
    mtdReturns: sum(m => m.mtdReturns),
    // NOTE: no mtdCogs or mtdOrders here, unlike every store row and the
    // previous-day roll-up. The month-to-date view needs both for the District
    // line, and both are exactly recoverable from what IS sent — cost is
    // mtdNet - mtdGp by definition, and the order count is the sum of the store
    // rows already in the payload. _lvFillDistrictMtd does that on arrival.
    // Adding them here would mean redeploying this function for a value the
    // client can derive without error, so it stays as it is.
    mtdGp: round2(dMtdNet - dMtdCogs),
    mtdMargin: dMtdNet > 0 ? round2((dMtdNet - dMtdCogs) / dMtdNet * 100) : null,
    goal: dGoal,
    pctOfGoal: dGoal > 0 ? round2((dMtdNet - dMtdCogs) / dGoal * 100) : null,
    storesReporting: healthy.length,
    storesTotal: ordered.length,
    // Same overlay shape as a store's, summed over the stores that reported.
    prev: rollPrev(healthy, dGoal, prevElapsedPct),
  };

  const payload = {
    asOfCentral: `${iso(c)} ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`,
    open,
    month: { daysTotal: sd.total, daysElapsed: sd.elapsed, elapsedPct: round2(elapsedPct) },
    // Everything the UI needs to LABEL the previous-day view. The numbers ride on
    // each store row; this is just which day it is and how far into the month it
    // sat, which is identical for every store.
    prev: pd.iso
      ? {
        date: pd.iso,
        inMonth: pd.inMonth,
        daysElapsed: psd ? psd.elapsed : null,
        elapsedPct: round2(prevElapsedPct),
      }
      : null,
    // Which day both comparison windows run to. Doubles as the carry-forward key
    // above: when this no longer matches the span the clock says it should, the
    // comparisons are refetched.
    cmpThrough,
    district,
    stores: ordered,
  };

  // Write and broadcast ONLY when a number moved. Nothing changes during a quiet
  // minute, so quiet minutes cost nothing — which is what keeps a per-minute
  // cron off the egress bill.
  const same = prev ? canon(stripVolatile(prev)) === canon(stripVolatile(payload)) : false;

  if (!same) {
    await sb.from("app_cache").upsert({ key: CACHE_KEY, payload, synced_at: new Date().toISOString() });
    // A BARE ping — deliberately no payload attached.
    //
    // The original reason was scoping: a broadcast reaches every subscriber, so
    // putting the district payload on the channel would have undone the
    // per-store filtering the read path did. That filtering is gone (see
    // scopeFor), so the ping stays bare for the two reasons that outlived it —
    // the channel is shared by every signed-in client and is the wrong place to
    // put anything a future gate might need to withhold, and a re-fetch costs
    // one small request per open dashboard per CHANGE rather than per minute,
    // which is still far below the per-client polling this design replaced.
    await broadcastChange("live");
  }

  return {
    ok: true, open, refreshing, changed: !same,
    storesReporting: district.storesReporting,
    errors: ordered.filter(m => m.error).map(m => ({ store: m.code, error: m.error })),
    asOfCentral: payload.asOfCentral,
  };
}

/** Fields that move every pass and must not count as a change. */
function stripVolatile(p: any) {
  const { asOfCentral, ...rest } = p ?? {};
  return rest;
}

/**
 * Key-order-independent serialization, for comparing the fresh payload against
 * the stored one.
 *
 * Postgres jsonb does NOT preserve key order — it stores keys sorted by length
 * then bytewise. So the payload that comes back out of app_cache stringifies
 * differently to the one that went in, even when every value is identical.
 * Comparing raw JSON.stringify therefore reported "changed" on every single
 * pass, which would have written the cache and broadcast to every open dashboard
 * once a minute forever — exactly the per-client traffic this design exists to
 * avoid. Sorting keys recursively is what makes the comparison mean anything.
 */
function canon(v: any): string {
  const walk = (x: any): any => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) out[k] = walk(x[k]);
      return out;
    }
    // jsonb round-trips 8 and 8.0 identically, but a JS float that only differs
    // in trailing precision would otherwise read as a change.
    if (typeof x === "number") return Math.round(x * 100) / 100;
    return x;
  };
  return JSON.stringify(walk(v));
}

/**
 * Ping every subscriber that this tool changed. Same shape as the other tools'
 * broadcasts, so it plugs into the existing client registry.
 *
 * Never put store data in here. The channel is shared by every signed-in
 * browser regardless of role, so anything in the payload is readable by
 * everyone. The read path no longer withholds store data (see scopeFor), so
 * that is not the live concern it once was — but the rule stands, because a
 * gate restored there would be silently undone by a payload sent here.
 */
async function broadcastChange(tool: string) {
  try {
    const base = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${base}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{
          topic: "speeks-notify",
          event: "changed",
          payload: { tool, store: null, ts: Date.now() },
        }],
      }),
    });
  } catch (_) { /* best-effort; the next pass will try again */ }
}

// --- read path (browser) ----------------------------------------------------

/**
 * What a signed-in user may read. Now: everything, for everyone.
 *
 * This used to be a real authorization gate — district roles got all five
 * stores and the roll-up, a Multi-Store Manager got their two, and everyone
 * else got exactly their own store, chosen server-side so that hiding the tab
 * in the frontend was not load-bearing.
 *
 * That gate is gone by request. The Live Dashboard replaced Buying & Sales on
 * the store Command Center, and managers, assistant managers and employees are
 * meant to see the district board there — all five stores' net sales, cost,
 * gross profit, margin, refunds, goals, pace, and the buying half with each
 * store's cash paid and buy margin. A store seeing itself beside the other four
 * is the point of the change.
 *
 * Read that plainly before touching it: there is no longer any per-store
 * filtering on this endpoint. A valid pin returns the whole district. If a
 * future role must NOT see another store's numbers, this function is where that
 * has to come back — the frontend's role classes hide the tab, not the data,
 * and anyone who can reach the endpoint with a pin can read the payload.
 *
 * `role` and `store` are kept in the signature: they are still echoed back in
 * `scope` for the frontend, and restoring a gate here should not also mean
 * rethreading the call site.
 */
function scopeFor(_role: string, _store: string): { codes: string[]; district: boolean } {
  return { codes: STORE_ORDER, district: true };
}

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const now = new Date();

  // ---- machine path: refresh from Shopify ----
  if (url.searchParams.get("secret") === SECRET) {
    return json(await refresh(sb, now, url.searchParams.get("force") === "1"));
  }

  // ---- browser path: read the cache, scoped ----
  const pin = req.headers.get("x-user-pin") || "";
  if (!pin) return json({ ok: false, error: "unauthorized" }, 401);

  const { data: user } = await sb.from("users").select("name, role, store").eq("pin", pin).single();
  // Stale sessionStorage pins survive a PIN change and produce exactly this —
  // say so, rather than leaving someone staring at an empty panel.
  if (!user) return json({ ok: false, error: "Invalid PIN — sign out and back in" }, 401);

  const { data: cached } = await sb.from("app_cache").select("payload, synced_at")
    .eq("key", CACHE_KEY).maybeSingle();
  if (!cached?.payload) {
    return json({ ok: true, pending: true, message: "No live data yet — the first refresh has not run." });
  }

  const p = cached.payload as any;
  const scope = scopeFor(String(user.role || ""), String(user.store || ""));
  const stores = (p.stores ?? []).filter((s: any) => scope.codes.includes(s.code));

  return json({
    ok: true,
    asOfCentral: p.asOfCentral,
    syncedAt: cached.synced_at,
    open: p.open,
    month: p.month,
    prev: p.prev ?? null,
    // Null on a cache written before the comparisons existed, and on the 1st of a
    // month. Either way the Month tab renders without them rather than dashing out
    // a band that looks broken.
    cmpThrough: p.cmpThrough ?? null,
    // Everyone gets the roll-up now — see scopeFor. Still routed through `scope`
    // rather than reading p.district directly, so re-introducing a gate is a
    // change to one function and not to this response shape.
    district: scope.district ? p.district : null,
    stores,
    scope: { role: user.role, store: user.store, district: scope.district },
  });
});
