// ============================================================================
// shopify-live — live store metrics for the Live Dashboard tab.
//
// Two entry points, deliberately separated:
//
//   ?secret=<sync>   pg_cron, once a minute. Talks to Shopify, writes app_cache,
//                    broadcasts on change. The ONLY path that calls Shopify.
//   x-user-pin       the browser. Reads the cache and scopes it to that person's
//                    store. Never calls Shopify, never sees a token.
//
// Shopify tokens live in shopify_stores (service-role only) and are never
// returned, logged, or reachable from the client. A store's numbers are chosen
// by the pin's OWN store on the server, so hiding a tab in the frontend is not
// load-bearing.
//
// REFRESH WINDOW (America/Chicago, computed here so DST needs no second cron)
//   Stores open 10-7 Mon-Fri, 10-4 Sat, closed Sun. A two-hour buffer each side
//   covers people arriving early and closing late:
//       Mon-Fri 08:00-21:00   Sat 08:00-18:00   Sun: closed
//   Inside the window: refresh every minute.
//   Outside it: refresh only if the cache is over 5 minutes stale, which is what
//   "every five minutes after close" means without a second schedule.
//
// COST: one ShopifyQL query plus one last-order query per store, ~4 points each
// against a 2000-point bucket restoring at 100/s. A per-minute pass over five
// stores is nowhere near a limit.
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
const CLOSED_STALE_MS = 5 * 60 * 1000;

// shop domain -> the store code used everywhere else on the site.
const SHOP_TO_CODE: Record<string, string> = {
  "paymore-overland-park.myshopify.com": "OVL",
  "paymore-lees-summit.myshopify.com": "LEE",
  "paymore-westport.myshopify.com": "WSP",
  "paymore-maplewood.myshopify.com": "MPL",
  "paymore-ballwin.myshopify.com": "BAL",
};
const STORE_ORDER = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const STORE_NAMES: Record<string, string> = {
  OVL: "Overland Park", LEE: "Lees Summit", WSP: "Westport",
  MPL: "Maplewood", BAL: "Ballwin",
};

// Everyone at CORP sees the district. Kept as a role list too, because role and
// store have drifted apart before (see the KPI role-gate bug).
const DISTRICT_ROLES = ["ceo", "district manager", "tom"];
// The Multi-Store Manager runs BAL and MPL, and sees both stacked — the same
// scoping the checklist, audit panel and Listing Goals already use.
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

/** Is the buffered trading window open right now? */
function isOpen(c: Central): boolean {
  if (c.dow === 0) return false;                       // closed Sunday
  if (c.dow === 6) return c.hour >= 8 && c.hour < 18;  // Sat 10-4 + buffer
  return c.hour >= 8 && c.hour < 21;                   // Mon-Fri 10-7 + buffer
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
  prev: DayMetrics | null;
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
      orders(first: 1, reverse: true, sortKey: CREATED_AT) {
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

    const last = data?.orders?.nodes?.[0];
    if (last) {
      base.lastOrderAt = last.createdAt ?? null;
      base.lastOrderAmount = round2(num(last.currentTotalPriceSet?.shopMoney?.amount));
    }
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
  const open = isOpen(c);

  const { data: cached } = await sb.from("app_cache").select("payload, synced_at")
    .eq("key", CACHE_KEY).maybeSingle();
  const prev = cached?.payload ?? null;
  const ageMs = cached?.synced_at ? now.getTime() - new Date(cached.synced_at).getTime() : Infinity;

  // The whole closed-hours cadence, in one condition: outside the window we only
  // work if the cache has gone stale.
  if (!force && !open && ageMs < CLOSED_STALE_MS) {
    return { ok: true, skipped: "closed and cache is fresh", open, ageSeconds: Math.round(ageMs / 1000) };
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
    // Broadcasts reach every subscriber, so shipping the district payload down the
    // channel would hand every employee all five stores' sales and margin and
    // undo the server-side scoping on the read path. Each client re-fetches
    // instead and gets only its own store. That costs one small request per open
    // dashboard per CHANGE, not per minute, which is still far below the
    // per-client polling this design set out to avoid.
    await broadcastChange("live");
  }

  return {
    ok: true, open, changed: !same,
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
 * everyone — which is exactly what the scoped read path exists to prevent.
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

function scopeFor(role: string, store: string): { codes: string[]; district: boolean } {
  const r = role.toLowerCase().trim();
  const s = (store || "").toUpperCase().trim();
  if (DISTRICT_ROLES.includes(r) || s === "CORP") return { codes: STORE_ORDER, district: true };
  if (r === "multi-store manager") return { codes: MSM_STORES, district: false };
  return { codes: STORE_ORDER.includes(s) ? [s] : [], district: false };
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
    // The district roll-up is withheld from store staff on the server. A store
    // employee gets their store and nothing else, whatever the frontend renders.
    district: scope.district ? p.district : null,
    stores,
    scope: { role: user.role, store: user.store, district: scope.district },
  });
});
