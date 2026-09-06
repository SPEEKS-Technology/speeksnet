// ============================================================================
// netprofit-collect — per-store, per-day inputs for the NET PROFIT tab.
//
//   ?secret=<ops secret>&store=OVL&from=2026-07-01&to=2026-07-31
//
// Returns one row per calendar day (America/Chicago) carrying the figures the
// sheet needs: net sales, cost, eBay fee, shipping cost, credit card fee.
//
// READ-ONLY. Every call in here is a GraphQL query or a ShopifyQL read; nothing
// in this file mutates anything in Shopify or eBay.
//
// ATTRIBUTION: everything lands on the SALE date (user's call, 2026-08-25) — a
// label bought Tuesday for Monday's order is charged to MONDAY. That is what
// makes a day's row mean "what this day's sales actually earned us", and it is
// precisely why the writer needs a 1-day lag and a month-to-date restatement
// pass: today's row is not final until tomorrow's costs are known.
//
// STATUS: ALL FIVE COLUMNS ARE LIVE as of 2026-08-26. If the eBay pass fails,
// ebay_fee goes back to `null` for every day and a warning says why — never 0.
// The sheet writes =NA() for a null, which propagates #N/A into Net Profit; a 0
// would instead read as "eBay cost us nothing" and quietly overstate the bonus.
//
// SHIPPING COST comes from the ORDER TIMELINE, not from ShopifyPayments. Checked
// and rejected first, so nobody re-treads it: the shipping_labels ShopifyQL
// dataset has dimensions and a COUNT but no cost measure; balance transactions
// carry a SHIPPING_LABEL type that is never used (1,877 transactions across all
// five stores since Jul 1, zero of them shipping); and ShopifyPaymentsPayoutSummary
// has no shipping field. These stores bill labels to the Shopify invoice, not to
// the Payments balance. The timeline is the only per-order source that exists.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";

const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

// The edge runtime is UTC (see [[edge-fn-utc-timezone]]), so a naive
// toISOString().slice(0,10) files every sale after 7pm Central under tomorrow.
// Intl is the only thing here that knows about DST.
const DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
});
const chicagoDay = (iso: string) => DAY_FMT.format(new Date(iso));

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// --- WHEN A MONTH CLOSES, and what that does to a shipping charge ----------
// The rule, from the CFO (2026-08-27):
//   · the month closes at 7pm Central on the 1st, so the stores have that day
//     to ship what sold on the last day of the month;
//   · never on a day the stores are shut — they buy ZERO labels on a Sunday
//     (measured: 0 of 2,403 in July) and they close for Thanksgiving,
//     Christmas and New Year's Day — so it slips to the first eligible
//     business day;
//   · anything applied after that stays in the new month. No back-dating.
//
// Of the three holidays only New Year's Day can ever land on a close. The 1st
// and 2nd of a month are the only candidates and neither Thanksgiving (4th
// Thursday of November) nor Christmas can fall there, so December always
// closes on Jan 2 at the earliest and the other two never bite.
function isStoreHoliday(y: number, m0: number, day: number): boolean {
  if (m0 === 0 && day === 1) return true;    // New Year's Day
  if (m0 === 11 && day === 25) return true;  // Christmas
  if (m0 === 10) {                           // Thanksgiving, 4th Thursday
    const first = new Date(Date.UTC(y, 10, 1)).getUTCDay();
    return day === 1 + ((4 - first + 7) % 7) + 21;
  }
  return false;
}

// The last day whose charges still belong to the month that just ended.
// ym is the month being closed, e.g. "2026-07". Returns YYYY-MM-DD.
function monthCloseDay(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m0 = Number(ym.slice(5, 7)) - 1;
  const ny = m0 === 11 ? y + 1 : y;
  const nm0 = (m0 + 1) % 12;
  for (let day = 1; day < 15; day++) {
    if (new Date(Date.UTC(ny, nm0, day)).getUTCDay() === 0) continue;
    if (isStoreHoliday(ny, nm0, day)) continue;
    const mm = String(nm0 + 1).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return ny + "-" + mm + "-" + dd;
  }
  throw new Error("no eligible close day found for " + ym);
}

// Which day does this shipping charge belong to?
//
// ⚠️ TWO DIFFERENT RULES, AND THE DIFFERENCE IS WHO CONTROLS THE TIMING.
// A LABEL is the direct cost of one sale and the store decides when to buy it,
// so it books to the SALE — otherwise holding shipping until the 1st would
// push cost into next month and inflate the month the bonus is paid on. A
// carrier PRICE ADJUSTMENT is a billing correction whose timing the carrier
// decides, never arrives inside three days, and cannot be gamed, so it books
// when it was charged.
//
// The exception is the close. Once a month is shut nothing may re-open it, so
// a label that turns up afterwards books to the day it was charged.
// ⚠️ WHICH DAY A REFUND BOOKS TO. Ethan's call, 2026-09-02, and the reasoning
// matters more than the setting because either answer is defensible.
//
// FALSE — a refund books to the day it was PROCESSED. This is what the Sales
// Summary does, so the two sheets agree to the cent on every day, and a day that
// has been closed stops moving.
//
// TRUE — a refund travels back to the day the item SOLD, so each day's Net
// Profit is the true profit of what that day sold. This is how it was built.
//
// ⚠️ IT IS A RESHUFFLE, NOT A DIFFERENCE IN THE MONTH. A refund only ever moves
// between days INSIDE one month — a cross-month refund already stays put,
// because saleDay is only populated for orders whose sale day is in the window.
// So the monthly figure the bonus is paid on is IDENTICAL either way. Measured
// on WSP, Sep 1-2:
//
//              re-dated      not re-dated
//     Sep 1     4,095.76        4,885.73
//     Sep 2     2,546.87        1,756.90
//     total     6,642.63        6,642.63
//
// Which is why this went the way it did: the day view costing hours to reconcile
// against the sheet everyone else reads was a real cost, and it bought nothing
// the bonus could see.
//
// The response still reports refunds_that_would_move, so it stays visible from
// the outside what this setting is doing.
const REDATE_REFUNDS_TO_SALE_DAY = false;

function shippingBookingDay(saleDay: string, chargedOn: string, shape: string): string {
  if (!chargedOn) return saleDay;
  if (shape === "charge-adjustment" || shape === "credit-adjustment") return chargedOn;
  return chargedOn <= monthCloseDay(saleDay.slice(0, 7)) ? saleDay : chargedOn;
}

// --- eBay Finances API -------------------------------------------------------
// ⚠️ The Finances API is served from apiz.ebay.com, NOT api.ebay.com. The wrong
// host returns a 404 that reads exactly like "this store had no transactions".
// What Finance calls "eBay New" on the Selling → Payments report: the Final Value
// Fee, both halves. EVERYTHING ELSE eBay charges falls in "eBay Other" — the CFO
// listed six kinds (regulatory operating, very high "item not as described",
// below standard performance, international, charity donation, deposit
// processing) but the bucket is defined as the complement, not as that list, so a
// fee kind eBay adds later is counted from the day it appears instead of being
// silently dropped for not being on a hard-coded list.
//
// July 2026, all five stores, showed only four types in total:
//   FINAL_VALUE_FEE 42,317.31 · FINAL_VALUE_FEE_FIXED_PER_ORDER 938.30  (New)
//   HIGH_ITEM_NOT_AS_DESCRIBED_FEE 3,062.07 · INTERNATIONAL_FEE 1,089.54 (Other)
const EBAY_FEE_NEW = new Set([
  "FINAL_VALUE_FEE",
  "FINAL_VALUE_FEE_FIXED_PER_ORDER",
]);

const EBAY_FIN_HOST: Record<string, string> = {
  production: "https://apiz.ebay.com",
  sandbox: "https://apiz.sandbox.ebay.com",
};
const EBAY_AUTH_HOST: Record<string, string> = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};

// EBAY_APPS is a hand-pasted JSON secret and has carried literal line breaks.
let EBAY_APPS: Record<string, any> = {};
{
  const raw = (Deno.env.get("EBAY_APPS") || "").trim();
  const stripped = Array.from(raw).filter((c) => c.charCodeAt(0) >= 32).join("");
  for (const text of [raw, stripped]) {
    if (!text) break;
    try {
      const p = JSON.parse(text);
      if (p && typeof p === "object") { EBAY_APPS = p; break; }
    } catch { /* try the stripped form */ }
  }
}

// ⚠️ THE READ-ONLY DOOR. sell.finances is the scope that gates issueRefund
// (POST /sell/fulfillment/v1/order/{id}/issue_refund) — eBay ships no read-only
// variant, so holding it is the risk we accepted on 2026-08-25. It is contained
// HERE, in code, not by the grant: this is the only function in the file that
// reaches eBay, and it refuses anything that is not a GET on the finances
// transaction endpoint. Same guard as ebay-refund-reprobe.
const EBAY_FIN_RE =
  /^https:\/\/apiz(?:\.sandbox)?\.ebay\.com\/sell\/finances\/v1\/transaction(?:\?[^#]*)?$/;

async function ebayGet(url: string, token: string): Promise<Response> {
  if (!EBAY_FIN_RE.test(url)) {
    throw new Error(`refused: not a read-only eBay finances URL -> ${url}`);
  }
  return await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

// Minted per run and deliberately never persisted.
async function mintEbayToken(row: any): Promise<string> {
  const creds = EBAY_APPS[row.store_code];
  if (!creds) throw new Error(`no EBAY_APPS entry for ${row.store_code}`);
  const host = EBAY_AUTH_HOST[row.environment as string] || EBAY_AUTH_HOST.production;
  const res = await fetch(`${host}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: row.refresh_token,
      scope: row.scopes || "",
    }),
  });
  const text = await res.text();
  let tok: any = null;
  try { tok = JSON.parse(text); } catch { /* surfaced below */ }
  if (!tok?.access_token) {
    // A consent that did NOT actually grant sell.finances fails HERE, not at the
    // API call. Surfacing it verbatim matters: a swallowed failure would read as
    // "this store had no eBay fees".
    throw new Error(`token refresh failed for ${row.store_code}: ${res.status} ${text.slice(0, 300)}`);
  }
  return tok.access_token;
}

// --- shipping label cost, from the order timeline ----------------------------
// Five message shapes observed across a 150-order sample (OVL, July 2026). They
// carry DIFFERENT SIGNS and one of them carries TWO amounts, so a naive
// "first dollar figure on any line mentioning a label" is wrong three ways:
//
//   87x  "<who> purchased a $5.89 shipping label and the included shipping
//         insurance premium."                        -> +5.89  (insurance included)
//   18x  "<who> purchased a shipping label for $8.42 with a $1.30 shipping
//         insurance premium."                        -> +9.72  (BOTH amounts)
//    4x  "You were charged $2.10 for a shipping label price adjustment."
//                                                    -> +2.10  (carrier reweigh)
//    1x  "<who> voided a $7.15 shipping label and the included shipping
//         insurance premium."                        -> -7.15
//    1x  "$3.05 was credited to your account for a shipping label price
//         adjustment."                               -> -3.05
//
// ⚠️ This is FREE TEXT and Shopify owns the wording. An unrecognised shape
// returns null rather than 0 so the caller can WARN — silently scoring an
// unknown message as zero would understate shipping and overstate Net Profit,
// which is the one direction this whole collector must never fail in.
// Which of the five shapes a message is. The CFO's report and this collector
// disagree on shipping by a flat per-order amount at every store, and the shape
// tally is what tells them apart: an overage that lands entirely on ONE shape is
// a parsing bug, one spread across all of them is a scope difference.
function labelShape(msg: string): string {
  if (!/shipping label/i.test(msg)) return "not-a-label";
  if (/voided/i.test(msg)) return "voided";
  if (/credited to your account/i.test(msg)) return "credit-adjustment";
  if (/price adjustment/i.test(msg)) return "charge-adjustment";
  if (/purchased .*label for /i.test(msg)) return "purchased-for-with-premium";
  if (/purchased/i.test(msg)) return "purchased-included-premium";
  return "unknown";
}

function parseLabelCost(msg: string): number | null {
  if (!/shipping label/i.test(msg)) return null;
  const amounts = [...msg.matchAll(/\$([\d,]+\.\d{2})/g)]
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
  if (!amounts.length) return null;
  const sum = amounts.reduce((a, b) => a + b, 0);

  // Order matters: the credit line also contains "price adjustment", and the
  // void line also contains a dollar amount that must not read as a purchase.
  if (/voided/i.test(msg)) return -sum;
  if (/credited to your account/i.test(msg)) return -amounts[0];
  if (/price adjustment/i.test(msg)) return amounts[0];
  if (/purchased/i.test(msg)) return sum;
  return null;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  const store = (url.searchParams.get("store") || "").toUpperCase().trim();
  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || "").trim();
  // ?labels=1 dumps every shipping-label event per order, for reconciling
  // against a Shopify "shipping labels by order" export. Read-only, no cost.
  const wantLabels = url.searchParams.get("labels") === "1";
  // ?ledger=1 reads the Shopify Payments balance ledger and buckets the
  // shipping-label lines. This is ACTUAL MONEY off the payout, so it is the
  // only thing that can settle whether a timeline message like "a shipping
  // label for $17.88 with a $3.56 shipping insurance premium" cost us $17.88
  // or $21.44 — the prose alone cannot. READ-ONLY.
  const wantLedger = url.searchParams.get("ledger") === "1";
  if (!SHOP_BY_STORE[store]) return json({ error: `unknown store "${store}"` }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return json({ error: "pass from=YYYY-MM-DD&to=YYYY-MM-DD" }, 400);
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/shopify_stores?select=shop,store_code,access_token,scopes`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  const rows = await res.json();
  const t = rows.find((x: any) => x.store_code === store)
    || rows.find((x: any) => x.shop === SHOP_BY_STORE[store]);
  if (!t) return json({ error: `no shopify_stores row for ${store}` }, 404);

  const warnings: string[] = [];

  async function gql(query: string, variables: unknown = {}) {
    // Shopify's throttle is a leaky bucket and a cost-heavy page can be refused
    // outright. Back off and retry rather than returning a short month, which
    // would read as a quiet business day rather than a failed fetch.
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`https://${t.shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t.access_token },
        body: JSON.stringify({ query, variables }),
      });
      const body = await r.json().catch(() => null);
      const throttled = body?.errors?.some((e: any) =>
        e?.extensions?.code === "THROTTLED" || /throttl/i.test(e?.message || ""));
      if (throttled && attempt < 4) {
        await new Promise((s) => setTimeout(s, 2000 * (attempt + 1)));
        continue;
      }
      if (!body) throw new Error(`Shopify returned non-JSON (HTTP ${r.status})`);
      return body;
    }
  }

  // --- net sales + cost -----------------------------------------------------
  // Same dataset and columns the Sales tab already runs on, so the NET PROFIT
  // tab's Sales/Cost cannot drift from the Sales tab's by construction.
  //
  // ⚠️ GROUPED BY day AND order_name, NOT BY day ALONE, because a refund has to
  // be re-dated and a day total cannot be taken apart again.
  //
  // WHY RE-DATE AT ALL. Measured against PayMore's own consolidated export for
  // OVL July 2026: grouped by day alone the month total is exact to the cent
  // and 29 of the 31 DAYS are wrong, by as much as $1,516. Every dollar of that
  // is a refund filed on a different day — the gross side already agreed on all
  // 31 days. ShopifyQL books a refund on the day the money moved; the export
  // books it against the day the item SOLD, which is the number a manager can
  // act on, because a $1,500 return of a July 15th sale is a July 15th problem.
  //
  // The rule, and each clause is load-bearing (see the aggregation below):
  //   * only refunds that returned LINE ITEMS move. A refund with no line items
  //     behind it is a price adjustment and stays where it was recorded.
  //   * the destination is the order's processedAt, NOT its createdAt.
  //     Marketplace Connect imports an eBay sale a day or two after it happens,
  //     so createdAt is the import date; four of July's refunds land on the
  //     wrong day if you use it.
  //   * a row's SALE half never travels, only its RETURN half. An exchange
  //     books the returned item and its replacement under one order name, and
  //     dragging the replacement back would invent revenue on the wrong day.
  const qlBody = await gql(
    `{ shopifyqlQuery(query: "FROM sales SHOW net_sales, cost_of_goods_sold, returns GROUP BY day, order_name SINCE ${from} UNTIL ${to}") {
         parseErrors tableData { rows } } }`);
  const ql = qlBody?.data?.shopifyqlQuery;
  if (ql?.parseErrors?.length) warnings.push(`shopifyql: ${ql.parseErrors.join("; ")}`);
  const qlRows = (ql?.tableData?.rows || []).map((row: any) => ({
    day: String(row.day).slice(0, 10),
    order: String(row.order_name || ""),
    net: round2(Number(row.net_sales) || 0),
    cost: round2(Number(row.cost_of_goods_sold) || 0),
    ret: round2(Number(row.returns) || 0),
  }));

  // ⚠️ REFUSE AN EMPTY ANSWER RATHER THAN PUBLISHING ZEROS. The day skeleton
  // below is built from the date range, not from the rows, so a ShopifyQL query
  // that fails or comes back empty would otherwise produce a complete-looking
  // month of $0.00 — which the sheet would happily write over real figures. A
  // store with genuinely no sales in a range is not a case worth supporting at
  // the cost of that.
  if (!qlRows.length) {
    return json({
      error: "shopifyql returned no sales rows for this range — refusing to "
        + "report a month of zeros. Check the date range and the query.",
      store, from, to, parseErrors: ql?.parseErrors ?? null,
    }, 502);
  }

  // Every day in the range gets a row, whether or not it traded. A daily grid
  // with a hole in it reads as a quiet Tuesday, not as a day nobody collected.
  const days: Record<string, any> = {};
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    days[d] = {
      day: d,
      net_sales: 0,
      cost: 0,
      returns: 0,
      cc_fee: 0,
      ebay_fee: null,
      // The CFO's split of the line above. null for the same reason ebay_fee is:
      // a day we could not read owes an unknown fee, not a zero one.
      ebay_fee_new: null,
      ebay_fee_other: null,
      // 0, not null: shipping is now readable, so an empty day genuinely means
      // no labels were bought against it.
      shipping_cost: 0,
      orders: 0,
      ebay_orders: 0,
      ebay_net_sales: 0,
    };
  }

  // --- credit card fee ------------------------------------------------------
  // Per-order, from transactions[].fees where type == processing_fee.
  //
  // The fee hangs off the CAPTURE, not the AUTHORIZATION — reading only an
  // order's first transaction returns fees: [] and reads as "no card fee".
  // eBay-gateway orders legitimately carry none; eBay takes its cut its own way.
  //
  // Filtered on created_at so an order counts on the day it was SOLD. A capture
  // can land the next day and must not drag the money onto that day.
  let cursor: string | null = null;
  let pages = 0;
  const feeByKind: Record<string, number> = {};
  const unknownLabelMessages: string[] = [];
  const labelShapes: Record<string, { n: number; amount: number }> = {};
  const labelDetail: any[] = [];
  const labelLag: Record<string, { n: number; maxLag: number; over7: number; amountOver7: number }> = {};
  let ordersWithTruncatedEvents = 0;
  let labelEvents = 0;
  // Charges that belong to a day outside this window. Not losses — "before" is
  // the prior month's own cost and was reported there, "after" is picked up by
  // the next month's run. Counted so the two months can be tied together.
  const outOfWindow = { before: 0, before_n: 0, after: 0, after_n: 0 };
  const rebooked = { n: 0, amount: 0 };
  // ⚠️ THE SCAN HAS TO REACH BACK PAST THE WINDOW, or "no back-dating" quietly
  // loses money. A label bought Sep 2 for a Jul 31 sale books to Sep 2 — but
  // the ORDER is a July order, and a September run querying only September's
  // orders would never see it. It would fall out of both months and nobody
  // would be charged for the postage. 40 days covers the longest lag measured
  // (12 days, MPL #MO03-2363) with room for a slow close.
  const scanFrom = (() => {
    const d = new Date(from + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - 40);
    return d.toISOString().slice(0, 10);
  })();
  // eBay Order Id -> the Chicago day the order SOLD. This is what makes eBay
  // fees land on the sale date instead of the settlement date: a refund posted
  // on Aug 10 against a Jul 5 order credits its fee back to JUL 5.
  const ebayOrderDay: Record<string, { day: string; name: string }> = {};
  // Shopify order name -> the day that order SOLD. Only orders that returned
  // line items appear here; nothing else re-dates. See the ShopifyQL block.
  const saleDay: Record<string, string> = {};
  // Orders that already carry a Shopify Shipping label, so an eBay-bought label
  // on the same order can be spotted as a possible double count.
  const ordersWithShopifyLabel = new Set<string>();
  do {
    // ONE pass for both the card fee and the shipping label. Page size is 25,
    // not 100: the events connection makes each order node far more expensive
    // (measured ~38 cost points per 25 orders), and a 100-order page with events
    // trips Shopify's throttle on every request rather than occasionally.
    const body: any = await gql(
      `query($q: String!, $after: String) {
         orders(first: 25, after: $after, sortKey: CREATED_AT, query: $q) {
           pageInfo { hasNextPage endCursor }
           edges { node {
             name createdAt processedAt sourceName
             customAttributes { key value }
             transactions { kind status gateway
               fees { type amount { amount } } }
             refunds(first: 10) {
               refundLineItems(first: 1) { edges { node { quantity } } }
             }
             events(first: 50) {
               pageInfo { hasNextPage }
               edges { node { message createdAt } }
             }
           } }
         }
       }`,
      { q: `created_at:>=${scanFrom} AND created_at:<=${to}`, after: cursor });
    if (body.errors?.length) {
      return json({ error: "shopify orders query failed", detail: body.errors, store }, 502);
    }
    const conn = body.data.orders;
    for (const e of conn.edges) {
      const o = e.node;

      // Collected BEFORE the window guard, because an order's sale day and its
      // creation day are not always the same one and the sale day is the one
      // the re-dating below needs.
      const soldOn = chicagoDay(o.processedAt || o.createdAt);
      const returnedLineItems = (o.refunds || []).some((rf: any) =>
        (rf.refundLineItems?.edges || []).length > 0);
      if (returnedLineItems && soldOn >= from && soldOn <= to) saleDay[o.name] = soldOn;

      const d = chicagoDay(o.createdAt);
      if (!days[d]) continue; // outside the ShopifyQL window; never invent a row
      days[d].orders++;
      const isEbay = o.sourceName === "ebay"
        || (o.transactions || []).some((x: any) => x.gateway === "ebay");
      if (isEbay) days[d].ebay_orders++;
      for (const tx of o.transactions || []) {
        if (tx.status !== "SUCCESS") continue;
        for (const f of tx.fees || []) {
          const amt = Number(f.amount?.amount) || 0;
          // Tracked by transaction kind so we can SEE whether Shopify hands the
          // processing fee back on a refund, rather than assuming either way.
          const k = `${tx.kind}:${f.type}`;
          feeByKind[k] = round2((feeByKind[k] || 0) + amt);
          if (f.type === "processing_fee") days[d].cc_fee = round2(days[d].cc_fee + amt);
        }
      }

      // Shipping labels. The label is bought the day AFTER the sale, but it is
      // charged to the SALE day because the event hangs off this order — which
      // is exactly the attribution asked for, and exactly why the sheet writer
      // needs a 1-day lag and an MTD restatement pass.
      if (o.events?.pageInfo?.hasNextPage) ordersWithTruncatedEvents++;
      for (const ee of o.events?.edges || []) {
        const msg = String(ee.node?.message || "");
        if (!/shipping label/i.test(msg)) continue;
        labelEvents++;
        const v = parseLabelCost(msg);
        if (v === null) {
          if (unknownLabelMessages.length < 20) unknownLabelMessages.push(msg);
          continue;
        }
        const shape = labelShape(msg);
        const bucket = labelShapes[shape] || { n: 0, amount: 0 };
        bucket.n++;
        bucket.amount = round2(bucket.amount + v);
        labelShapes[shape] = bucket;
        // chargedOn is when the money moved; day is the order it is booked to.
        // A carrier reweigh can land weeks after the sale, which is the whole
        // reason the sheet needs an MTD restatement pass and not just a 1-day
        // lag — see the lagDays tally below.
        const chargedOn = ee.node?.createdAt ? chicagoDay(String(ee.node.createdAt)) : "";
        if (chargedOn && chargedOn !== d) {
          const lag = Math.round(
            (Date.parse(chargedOn + "T12:00:00Z") - Date.parse(d + "T12:00:00Z")) / 86400000);
          const lb = labelLag[shape] || { n: 0, maxLag: 0, over7: 0, amountOver7: 0 };
          lb.n++;
          lb.maxLag = Math.max(lb.maxLag, lag);
          if (lag > 7) { lb.over7++; lb.amountOver7 = round2(lb.amountOver7 + v); }
          labelLag[shape] = lb;
        }
        const bookTo = shippingBookingDay(d, chargedOn, shape);
        if (wantLabels) {
          labelDetail.push({ order: o.name, day: d, chargedOn, book_to: bookTo,
                             shape, amount: v, msg });
        }
        // A charge can now land outside the window. That is the rule working,
        // not a leak — but it is counted, because a silent one would be.
        if (!days[bookTo]) {
          if (bookTo > to) { outOfWindow.after = round2(outOfWindow.after + v); outOfWindow.after_n++; }
          else { outOfWindow.before = round2(outOfWindow.before + v); outOfWindow.before_n++; }
          continue;
        }
        if (bookTo !== d) { rebooked.n++; rebooked.amount = round2(rebooked.amount + v); }
        days[bookTo].shipping_cost = round2((days[bookTo].shipping_cost || 0) + v);
        ordersWithShopifyLabel.add(o.name);
      }

      // Marketplace Connect writes the eBay Order Id as a custom attribute — it
      // is the ONLY join between a Shopify order and eBay's Finances API, since
      // MC writes no metafields. Verified format matches exactly: "17-14959-57173".
      for (const ca of o.customAttributes || []) {
        if (String(ca.key).trim().toLowerCase() !== "ebay order id") continue;
        const id = String(ca.value || "").trim();
        if (id) ebayOrderDay[id] = { day: d, name: o.name };
      }
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages++;
    // 25 per page means a busy store's month needs ~30 pages. The old cap of 60
    // was sized for 100-order pages and would now truncate a month silently.
  } while (cursor && pages < 200);
  if (cursor) warnings.push("stopped at 200 pages — range too wide, split it");
  if (ordersWithTruncatedEvents) {
    warnings.push(`${ordersWithTruncatedEvents} order(s) had more than 50 timeline events; `
      + "a label message could sit past the cut and its cost be missed");
  }
  if (unknownLabelMessages.length) {
    warnings.push(`${unknownLabelMessages.length} unrecognised shipping-label message shape(s) — `
      + "these were NOT counted, so shipping is understated until parseLabelCost learns them: "
      + unknownLabelMessages.slice(0, 3).map((m) => JSON.stringify(m)).join(" | "));
  }

  // --- fold the ShopifyQL rows into days, re-dating the refunds --------------
  // Runs HERE, after the order sweep, because it needs `saleDay`, and that is
  // only known once every order has been read.
  //
  // Each row is split in two. `gross` is what the day actually sold and never
  // moves. `ret` is the refunded part and travels to the day the item sold —
  // but only when this order returned line items AND its sale day is inside the
  // window; otherwise it stays put, which is the correct answer for a refund of
  // something sold last month.
  //
  // Cost follows the same journey, with one gap that is left alone on purpose:
  // a row holding BOTH a sale and a return (an exchange) carries a single netted
  // cost figure that cannot be taken apart, so its cost stays on its own day.
  // One exchange in OVL's July put $20 of cost on the wrong day; the month total
  // is unaffected, and inventing a split would be worse than leaving it.
  let refundsRedated = 0;
  let refundsRedatedAmount = 0;
  // Counted even when the feature is off, because "how much WOULD have moved" is
  // the only way to see, from a response, why this tab and the Sales Summary
  // agree — or would not have.
  let refundsWouldMove = 0;
  let refundsWouldMoveAmount = 0;
  for (const r of qlRows) {
    const gross = round2(r.net - r.ret);
    const dest = REDATE_REFUNDS_TO_SALE_DAY
      ? (saleDay[r.order] && saleDay[r.order] !== r.day ? saleDay[r.order] : r.day)
      : r.day;
    if (days[r.day]) {
      days[r.day].net_sales = round2(days[r.day].net_sales + gross);
    }
    if (days[dest]) {
      days[dest].net_sales = round2(days[dest].net_sales + r.ret);
      days[dest].returns = round2(days[dest].returns + r.ret);
    }
    // Cost: a pure refund row travels whole, everything else stays.
    const costHome = (r.ret !== 0 && gross === 0) ? dest : r.day;
    if (days[costHome]) days[costHome].cost = round2(days[costHome].cost + r.cost);
    if (dest !== r.day) { refundsRedated++; refundsRedatedAmount = round2(refundsRedatedAmount - r.ret); }
    if (saleDay[r.order] && saleDay[r.order] !== r.day) {
      refundsWouldMove++;
      refundsWouldMoveAmount = round2(refundsWouldMoveAmount - r.ret);
    }
  }

  // --- eBay share -----------------------------------------------------------
  // Not a sheet column, but it is the denominator for any interim modelled eBay
  // fee, and it is the number this whole bonus change is about — so it comes
  // back on every run rather than being re-derived later.
  const chBody = await gql(
    `{ shopifyqlQuery(query: "FROM sales SHOW net_sales GROUP BY day, sales_channel SINCE ${from} UNTIL ${to}") {
         parseErrors tableData { rows } } }`);
  // ⚠️ Match the channel on a NORMALISED name. ShopifyQL returns
  // "Marketplace Connect" (with a space) here, and an exact-literal compare
  // against "MarketplaceConnect" silently yields 0 for every day — which reads
  // as "this store sells nothing on eBay" rather than as a bug. Verified the
  // hard way: OVL July came back with ebay_net_sales 0 against 494 eBay orders.
  const norm = (s: unknown) => String(s).replace(/[^a-z0-9]/gi, "").toLowerCase();
  for (const row of chBody?.data?.shopifyqlQuery?.tableData?.rows || []) {
    const d = String(row.day).slice(0, 10);
    if (days[d] && norm(row.sales_channel) === "marketplaceconnect") {
      days[d].ebay_net_sales = round2(Number(row.net_sales) || 0);
    }
  }

  // --- eBay fees (and eBay-bought labels) -----------------------------------
  // Every row is attributed by its ORDER, not by its own transaction date, so a
  // refund settled weeks later credits its fee back to the day the item SOLD.
  // Rows whose order is not in this month's map belong to another month and are
  // counted, not guessed at.
  //
  // ⚠️ The scan window runs from `from` to TODAY, not to `to`. Fees and refunds
  // settle days after the sale, so a window that stops at month end misses them
  // and understates the fee — which overstates Net Profit.
  const ebay = {
    sale_fees: 0, refund_fee_credits: 0, labels: 0, label_count: 0,
    return_labels: 0, return_label_count: 0,
    // Voided / refunded eBay labels. Non-zero here means postage came back.
    label_credits: 0, label_credit_count: 0,
    rows: 0, matched: 0, unmatched: 0,
    account_fees_unattributed: 0, skipped_disputes: 0, skipped_transfers: 0,
    unhandled_types: {} as Record<string, number>,
    overlap_orders: [] as string[],
    // The CFO's two columns off the Selling → Payments report, plus the raw
    // per-type tally behind them so a disagreement can be argued from the line
    // rather than from the total.
    fee_new: 0, fee_other: 0,
    fee_by_type: {} as Record<string, number>,
    fee_type_unbucketed: 0, fee_type_unbucketed_rows: 0,
    // Paging integrity. `transactions` short of `transactions_expected` is the
    // dropped-row failure; it throws rather than reporting a short fee.
    transactions: 0, transactions_expected: 0, duplicate_page_rows: 0,
  };
  try {
    const er = await fetch(
      `${SUPABASE_URL}/rest/v1/ebay_stores?select=store_code,environment,refresh_token,scopes`
      + `&store_code=eq.${encodeURIComponent(store)}`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const erows = await er.json();
    if (!erows.length) throw new Error(`no ebay_stores row for ${store}`);
    const token = await mintEbayToken(erows[0]);
    const host = EBAY_FIN_HOST[erows[0].environment as string] || EBAY_FIN_HOST.production;

    const today = new Date();
    const upper = new Date(Math.max(
      new Date(`${to}T00:00:00.000Z`).getTime(), today.getTime()));
    upper.setUTCDate(upper.getUTCDate() + 1);
    const filter = `transactionDate:[${from}T00:00:00.000Z..${upper.toISOString().slice(0, 23)}Z]`;

    // ⚠️ OFFSET PAGING OVER A LIVE SET. The window deliberately runs to TODAY,
    // so eBay is still writing into the range while we page through it. Offset
    // paging is position-based: a row inserted ahead of the cursor shifts every
    // later row down one, and the record sitting on a page boundary is then
    // never returned. The reverse shift returns one TWICE.
    //
    // Measured, WSP July 2026: three reads gave 9,849.08 / 9,753.28 / 9,849.08.
    // The low read was one dropped transaction, $95.80. Nothing detected it —
    // the total simply came back smaller, and a smaller fee reads as a BIGGER
    // Net Profit. That is the one direction this file must never fail in.
    //
    // So: dedupe by transactionId (catches the double), and require the row
    // count to reach eBay's own `total` (catches the drop). A short read throws,
    // which the catch below turns into ebay_fee = null and a warning — the same
    // honest #N/A an HTTP failure produces, instead of a plausible wrong number.
    const seen = new Set<string>();
    const txs: any[] = [];
    let expected = 0;
    let dupePageRows = 0;
    for (let off = 0; off < 20000; off += 200) {
      const r2 = await ebayGet(
        `${host}/sell/finances/v1/transaction?limit=200&offset=${off}`
        + `&filter=${encodeURIComponent(filter)}`, token);
      // 204 = No Content, which is how the Finances API says "that offset is past
      // the end". It is a normal terminator, not a failure: WSP July holds exactly
      // 1000 transactions, so offset 1000 answers 204. Treating it as an error
      // threw away the whole store's fee (and, worse, its eBay shipping — see the
      // catch below).
      if (r2.status === 204) break;
      if (r2.status !== 200) {
        throw new Error(`finances HTTP ${r2.status}: ${(await r2.text()).slice(0, 200)}`);
      }
      const b2 = await r2.json();
      const page = b2?.transactions || [];
      // `total` is re-read every page on purpose: it is the live count, and the
      // largest one seen is the bar the final tally has to clear.
      expected = Math.max(expected, Number(b2?.total) || 0);
      for (const x of page) {
        // No id means it cannot be de-duplicated; keep it rather than drop it,
        // and let the count check be the safety net.
        const id = String(x?.transactionId || "");
        if (id && seen.has(id)) { dupePageRows++; continue; }
        if (id) seen.add(id);
        txs.push(x);
      }
      // ⚠️ STOP ON A SHORT PAGE, NOT ON `total`. WSP July came back with total
      // exactly 1000 — a round number that is far more likely to be a reporting
      // cap than a true count, and trusting it would have stopped paging with
      // real transactions still unread. A full page always means "ask again";
      // only a page that comes back short proves the end. `total` is kept as the
      // floor the final count must clear, never as the thing that ends the loop.
      if (page.length < 200) break;
    }
    ebay.transactions = txs.length;
    ebay.transactions_expected = expected;
    ebay.duplicate_page_rows = dupePageRows;
    // Equal is the normal case. MORE than expected is fine and is why the dedupe
    // runs first — eBay wrote new rows while we paged, and they are real. FEWER
    // is the failure: rows the paging lost.
    if (txs.length < expected) {
      throw new Error(
        `finances paging incomplete: read ${txs.length} of ${expected} transactions `
        + `(${expected - txs.length} lost to offset drift). Refusing to report a `
        + "fee total that is short — a low fee overstates Net Profit.");
    }

    // Only now that the WHOLE range came back 200 do the nulls become zeros: a
    // day with no eBay activity genuinely owes no fee, but a day we failed to
    // read owes an unknown one, and those two must never look alike.
    for (const d of Object.keys(days)) {
      days[d].ebay_fee = 0;
      days[d].ebay_fee_new = 0;
      days[d].ebay_fee_other = 0;
    }

    for (const x of txs) {
      ebay.rows++;
      const type = String(x.transactionType || "");
      const oid = String(x.orderId || "").trim();
      const fee = Number(x?.totalFeeAmount?.value) || 0;
      const amt = Number(x?.amount?.value) || 0;

      // ⚠️ EVERY TYPE IS NAMED. There is deliberately no "anything without an
      // order id is a fee" catch-all: that exact shortcut swept TRANSFER — eBay's
      // payouts to the bank, 119 rows and $19,075.93 in one two-month window —
      // into the account-fee bucket, where it read as a plausible cost and was
      // larger than the real fees. Money movement is not a cost. An unrecognised
      // type is COUNTED and reported, never quietly folded into a total.
      if (type === "TRANSFER") { ebay.skipped_transfers++; continue; }

      // DISPUTE and CREDIT arrive as an equal, opposite pair on the same order
      // (verified: 6 and 6, $1,692.93 each, hours apart — chargebacks reversed).
      // They are not fees and must not be folded in as one.
      if (type === "DISPUTE" || type === "CREDIT") { ebay.skipped_disputes++; continue; }

      // Account-level money: NON_SALE_CHARGE (feeType OTHER_FEES) and ADJUSTMENT
      // (seen: "eBay Credit - VAT excluded", $7.55). Neither carries an orderId,
      // so neither can be attributed to a sale date — they are reported, never
      // spread across days. The SIGN comes from bookingEntry, not from the type
      // name: ADJUSTMENT arrives as a CREDIT and is money BACK, and assuming a
      // charge because the type sounds like one would invent a cost.
      if (type === "NON_SALE_CHARGE" || type === "ADJUSTMENT") {
        const signed = String(x.bookingEntry) === "CREDIT" ? -amt : amt;
        ebay.account_fees_unattributed = round2(ebay.account_fees_unattributed + signed);
        continue;
      }

      if (type !== "SALE" && type !== "REFUND" && type !== "SHIPPING_LABEL") {
        ebay.unhandled_types[type] = (ebay.unhandled_types[type] || 0) + 1;
        continue;
      }

      const hit = ebayOrderDay[oid];
      if (!oid || !hit || !days[hit.day]) { ebay.unmatched++; continue; }
      const d = hit.day;
      ebay.matched++;

      if (type === "SALE" || type === "REFUND") {
        // ── The CFO's split ────────────────────────────────────────────────
        // Finance does not read "eBay fee" as one number. Off the Selling →
        // Payments report he keeps two columns:
        //   eBay New   = Final Value Fee - fixed + Final Value Fee - variable
        //   eBay Other = regulatory operating, very high "item not as described",
        //                below standard performance, international, charity
        //                donation, deposit processing
        // Those report labels have API equivalents at
        // orderLineItems[].marketplaceFees[].feeType, so the same split can be
        // produced here and the two sources compared line for line rather than
        // "the totals are close".
        //
        // ✅ NOTHING IS LOST BY BUCKETING. Verified over all five stores in July
        // 2026: the line-item fees sum EXACTLY to totalFeeAmount, $0.00
        // unexplained across 2,700+ transactions. So New + Other is the whole
        // fee, and this is a split of the existing column, not a new total.
        // ebay_fee is still written from totalFeeAmount — the authoritative
        // figure — so a fee kind eBay invents tomorrow lands in the total even
        // if it lands in neither bucket. `fee_type_unbucketed` is what says so.
        const sign = type === "SALE" ? 1 : -1;
        let bucketed = 0;
        for (const li of x?.orderLineItems || []) {
          for (const f of li?.marketplaceFees || []) {
            const ft = String(f?.feeType || "?").toUpperCase();
            const fa = Number(f?.amount?.value) || 0;
            bucketed += fa;
            ebay.fee_by_type[ft] = round2((ebay.fee_by_type[ft] || 0) + sign * fa);
            if (EBAY_FEE_NEW.has(ft)) {
              ebay.fee_new = round2(ebay.fee_new + sign * fa);
              days[d].ebay_fee_new = round2((days[d].ebay_fee_new || 0) + sign * fa);
            } else {
              ebay.fee_other = round2(ebay.fee_other + sign * fa);
              days[d].ebay_fee_other = round2((days[d].ebay_fee_other || 0) + sign * fa);
            }
          }
        }
        if (Math.abs(bucketed - fee) > 0.005) {
          ebay.fee_type_unbucketed = round2(ebay.fee_type_unbucketed + (fee - bucketed));
          ebay.fee_type_unbucketed_rows++;
        }

        if (type === "SALE") {
          ebay.sale_fees = round2(ebay.sale_fees + fee);
          days[d].ebay_fee = round2((days[d].ebay_fee || 0) + fee);
        } else {
          // DEBIT row, but totalFeeAmount is the fee eBay hands BACK to us.
          ebay.refund_fee_credits = round2(ebay.refund_fee_credits + fee);
          days[d].ebay_fee = round2((days[d].ebay_fee || 0) - fee);
        }
      } else {
        // An eBay label never appears in the Shopify timeline, so it is real
        // ADDITIONAL postage. Most are RETURN labels — verified by
        // transactionMemo "Return shipping label" and a RETURN_ID reference —
        // and an order legitimately carries BOTH: we buy the outbound label on
        // Shopify, eBay bills us the buyer's return leg. That is a return
        // costing postage twice, not a double count, and it is exactly the kind
        // of cost the GP-based view never charged anyone for.
        //
        // A NON-return eBay label on an order that already has a Shopify label
        // is a different matter and still worth flagging.
        // ⚠️ THE SIGN COMES FROM bookingEntry, NOT FROM THE TYPE NAME — the same
        // rule the NON_SALE_CHARGE branch above already follows. A voided or
        // refunded label comes back as SHIPPING_LABEL with bookingEntry CREDIT
        // and a POSITIVE amount: it is money handed back. Adding it unsigned
        // charged us for postage twice — once when we bought the label, again
        // when eBay refunded it. Confirmed against the CFO's consolidated
        // report, which carries these as negative "Ebay Shipping" (OVL
        // #KS01-12833, 7/23: ($65.90)).
        const credit = String(x.bookingEntry) === "CREDIT";
        const signed = credit ? -amt : amt;
        if (credit) {
          ebay.label_credits = round2(ebay.label_credits + amt);
          ebay.label_credit_count++;
        }
        const isReturn = /return/i.test(String(x.transactionMemo || ""))
          || (x.references || []).some((r: any) => String(r?.referenceType) === "RETURN_ID");
        if (isReturn) {
          ebay.return_labels = round2(ebay.return_labels + signed);
          ebay.return_label_count++;
        } else if (!credit && ordersWithShopifyLabel.has(hit.name)) {
          ebay.overlap_orders.push(hit.name);
        }
        ebay.labels = round2(ebay.labels + signed);
        ebay.label_count++;
        days[d].shipping_cost = round2((days[d].shipping_cost || 0) + signed);
      }
    }

    if (ebay.unmatched) {
      warnings.push(`${ebay.unmatched} eBay finance row(s) had no matching order in `
        + "this month — expected, they belong to sales outside the range");
    }
    if (ebay.overlap_orders.length) {
      warnings.push(`${ebay.overlap_orders.length} order(s) carry BOTH a Shopify label and `
        + "an eBay OUTBOUND label — shipping may be double counted on: "
        + ebay.overlap_orders.slice(0, 5).join(", "));
    }
    if (Object.keys(ebay.unhandled_types).length) {
      warnings.push("unrecognised eBay finance transaction type(s), NOT counted anywhere: "
        + JSON.stringify(ebay.unhandled_types));
    }
    if (ebay.account_fees_unattributed) {
      warnings.push(`$${ebay.account_fees_unattributed} of account-level eBay charges `
        + "(NON_SALE_CHARGE / no order id) are NOT in any day — they cannot be "
        + "attributed to a sale date and are reported separately");
    }
  } catch (e) {
    // A failure here must leave ebay_fee NULL, never 0 — the sheet writes =NA()
    // for null, and a 0 would silently overstate Net Profit.
    //
    // ⚠️ SHIPPING GOES NULL TOO. shipping_cost is the SUM of two sources: Shopify
    // labels from the order timeline, and eBay's own labels (mostly the buyer's
    // return leg) from this pass. When this pass fails, the Shopify half survives
    // and looks like a complete figure — measured on WSP July, $8,780.39 instead
    // of $9,233.53, understating postage by $453.14 with nothing to show for it.
    // A partial cost is more dangerous than no cost, because only one of them
    // announces itself.
    for (const d of Object.keys(days)) {
      days[d].ebay_fee = null;
      days[d].ebay_fee_new = null;
      days[d].ebay_fee_other = null;
      days[d].shipping_cost = null;
    }
    warnings.push(`eBay fee unavailable: ${String(e)}`);
  }

  // --- what is still blocked ------------------------------------------------
  // Nothing, as of 2026-08-26 — all five columns read live. The map stays so a
  // future failure has somewhere honest to report itself; `warnings` carries the
  // detail, and a failed eBay pass leaves ebay_fee null (the sheet writes =NA()).
  const blocked: Record<string, string> = {};
  const scopes = String(t.scopes || "");

  const list = Object.values(days).sort((a: any, b: any) => (a.day < b.day ? -1 : 1));

  // ⚠️ A NULL DAY POISONS THE TOTAL, and must. The per-day nulls were already
  // honest — the sheet writes =NA() for them — but `Number(null) || 0` quietly
  // turned a whole failed eBay pass into a totals.ebay_fee of 0.00, which reads
  // as "eBay charged us nothing" and inflates net_before_royalty by the entire
  // fee. Caught live: MPL came back 0.00 the first time the paging guard fired.
  // If any day is unknown, the month is unknown. Say so.
  const sum = (k: string) => {
    let a = 0;
    for (const r of list as any[]) {
      const v = r[k];
      if (v === null || v === undefined) return null;
      a += Number(v) || 0;
    }
    return round2(a);
  };
  // For the arithmetic below: any null input makes the result null too.
  const minus = (...xs: (number | null)[]): number | null => {
    if (xs.some((x) => x === null)) return null;
    const [head, ...rest] = xs as number[];
    return round2(rest.reduce((a, b) => a - b, head));
  };

  // --- Shopify Payments ledger, shipping-label lines only -------------------
  // ⚠️ /balance/transactions.json WITHOUT a payout_id returns only the CURRENT
  // UNPAID balance — 499 rows, none of them July. History lives behind the
  // payouts: list the payouts that settled in the window, then read each one's
  // transactions. Labels bought late in July settle in early August, so the
  // payout window is deliberately wider than the reporting window.
  //
  // ⚠️ AND IT DOES NOT ANSWER THE POSTAGE QUESTION AT THESE FIVE STORES.
  // Measured on OVL July: 68 payouts, source types payout / charge /
  // Payments::Refund / adjustment, and ZERO shipping_label rows. PayMore's
  // labels are billed on the Shopify invoice, not deducted from the payout,
  // so the order timeline stays the only programmatic source for label cost
  // (ShopifyQL's shipping_labels dataset has no cost column either — every
  // cost-shaped name is rejected; shipping_price is what the CUSTOMER paid).
  // Kept because it is read-only, cheap, and answers other questions.
  let ledger: any = undefined;
  if (wantLedger) {
    ledger = {
      byType: {} as Record<string, { n: number; amount: number }>,
      shippingLabelByOrder: {} as Record<string, number>,
      payouts: 0, rows: 0, inWindow: 0,
      shipping_label_total: 0,
      first_seen: "", last_seen: "",
      error: null as string | null,
    };
    const shopGet = async (path: string) => {
      const r = await fetch(`https://${t.shop}/admin/api/${API_VERSION}/${path}`,
        { headers: { "X-Shopify-Access-Token": t.access_token } });
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${path}: ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    };
    try {
      const padDate = (d: string, days: number) => {
        const x = new Date(d + "T12:00:00Z");
        x.setUTCDate(x.getUTCDate() + days);
        return x.toISOString().slice(0, 10);
      };
      const po = await shopGet(
        `shopify_payments/payouts.json?limit=250&date_min=${padDate(from, -10)}`
        + `&date_max=${padDate(to, 21)}`);
      const payouts = po?.payouts || [];
      ledger.payouts = payouts.length;
      for (const p of payouts) {
        // Shopify allows 2 calls/sec here and a busy store has ~70 payouts;
        // without this the walk 429s a third of the way in and the totals lie.
        await new Promise((r) => setTimeout(r, 600));
        const b = await shopGet(
          `shopify_payments/balance/transactions.json?limit=250&payout_id=${p.id}`);
        for (const x of (b?.transactions || [])) {
          ledger.rows++;
          const day = chicagoDay(String(x.processed_at || p.date || ""));
          if (!ledger.first_seen || day < ledger.first_seen) ledger.first_seen = day;
          if (day > ledger.last_seen) ledger.last_seen = day;
          const st = String(x.source_type || x.type || "unknown");
          const amt = Number(x.amount) || 0;
          const bk = ledger.byType[st] || { n: 0, amount: 0 };
          bk.n++; bk.amount = round2(bk.amount + amt);
          ledger.byType[st] = bk;
          if (day < from || day > to) continue;
          ledger.inWindow++;
          if (/shipping_label/i.test(st)) {
            ledger.shipping_label_total = round2(ledger.shipping_label_total + amt);
            const oid = String(x.source_order_id || x.source_id || "");
            if (oid) {
              ledger.shippingLabelByOrder[oid] =
                round2((ledger.shippingLabelByOrder[oid] || 0) + amt);
            }
          }
        }
      }
    } catch (e) {
      ledger.error = String(e);
    }
  }

  return json({
    store, shop: t.shop, from, to, scopes,
    // How much work the re-dating did. Zero here on a month that had refunds
    // means the rule stopped firing — the daily grid would look plausible and
    // be wrong, so it is reported rather than left to be inferred.
    refunds_redated: refundsRedated,
    refunds_redated_amount: refundsRedatedAmount,
    redate_refunds_to_sale_day: REDATE_REFUNDS_TO_SALE_DAY,
    refunds_that_would_move: refundsWouldMove,
    refunds_that_would_move_amount: refundsWouldMoveAmount,
    totals: {
      net_sales: sum("net_sales"),
      cost: sum("cost"),
      cc_fee: sum("cc_fee"),
      shipping_cost: sum("shipping_cost"),
      ebay_fee: sum("ebay_fee"),
      // Finance's two columns. They add to ebay_fee, and ebayFinances
      // .fee_type_unbucketed is non-zero if they ever stop doing so.
      ebay_fee_new: sum("ebay_fee_new"),
      ebay_fee_other: sum("ebay_fee_other"),
      ebay_net_sales: sum("ebay_net_sales"),
      orders: sum("orders"),
      ebay_orders: sum("ebay_orders"),
      label_events: labelEvents,
      // ⚠️ NOT the sheet's Net Profit. The tab also subtracts a flat 7% of sales
      // (the `(B5*0.07)` line in its NP formula), which is the workbook's own
      // definition and is applied there, not here. This is the cost side only.
      net_before_royalty: minus(
        sum("net_sales"), sum("cost"), sum("cc_fee"),
        sum("shipping_cost"), sum("ebay_fee")),
    },
    ebayFinances: ebay,
    feeByTransactionKind: feeByKind,
    paymentsLedger: ledger,
    shippingLabelShapes: labelShapes,
    shippingAttribution: {
      rule: "a label books to the SALE day unless it was charged after that month "
          + "closed; a carrier price adjustment always books to the day charged",
      month_closes: monthCloseDay(from.slice(0, 7)) + " 19:00 America/Chicago",
      scanned_orders_from: scanFrom,
      rebooked_to_a_different_day: rebooked,
      outside_this_window: outOfWindow,
    },
    shippingLabelLag: labelLag,
    shippingLabelDetail: wantLabels ? labelDetail : undefined,
    blocked,
    warnings,
    days: list,
  });
});
