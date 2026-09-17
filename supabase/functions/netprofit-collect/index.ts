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
//
// ⚠️ SHIPPING COST IS THE SUM OF TWO SOURCES ON TWO DIFFERENT BOOKING RULES.
// Our OWN outbound label comes off the Shopify order timeline and books to the
// SALE day, because the store chooses when to buy it. EBAY-BILLED labels — the
// buyer's return leg, which eBay buys and charges to us — come off the eBay
// Finances feed and book to the day EBAY CHARGED them, because nobody here
// controls that timing. The asymmetry is deliberate; see the SHIPPING_LABEL
// branch in the eBay pass for the full reasoning and for what it cost to get
// wrong (25 charges, $311.80, booked nowhere at all until 2026-09-09).
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
  // ⚠️ THE THINGS THAT BREAK THE SHEET, AS FIELDS RATHER THAN PROSE. `warnings`
  // is for a person reading a response; this is for netprofit-sheet.gs, which
  // emails on it. Matching on warning text would break the first time a
  // sentence was reworded, and a broken alert is silent by definition.
  const health = {
    // Why the eBay pass failed, verbatim. When set, eBay Fee AND Shipping went
    // out as null for every day and the sheet writes #N/A. A revoked seller
    // login reads "token refresh failed ... invalid_grant".
    ebay_error: null as string | null,
    // eBay sales inside the window, on a day that is already over, that have no
    // Shopify order. Their SALES are missing from the day as well as their fee:
    // Marketplace Connect has not imported them. Sep 11-13 was exactly this.
    not_yet_imported: { n: 0, fee: 0, orders: [] as { ebay_order_id: string; day: string }[] },
    // eBay sales with no Shopify order that eBay has since REFUNDED — cancelled
    // before Marketplace Connect imported them, so there is no sale to miss.
    // Reported for visibility only; nothing alerts on it. See the ORPHAN note.
    cancelled_before_import: { n: 0, orders: [] as { ebay_order_id: string; day: string }[] },
    unknown_label_messages: 0,
    orders_with_truncated_events: 0,
    page_cap_hit: false,
    unhandled_ebay_types: {} as Record<string, number>,
    shopifyql_errors: [] as string[],
  };

  // Where the time went, returned with the response as timings_ms. The sheet
  // ignores it; it exists so the next "why was this slow" is a number, not a
  // theory. 2026-09-17 took most of a morning to reconstruct from outside.
  const timing = { total: 0, shopifyql: 0, scan: 0, scan_pages: 0, scan_chunks: 0,
                   scan_orders: 0, throttle_waits: 0, throttle_wait: 0, transient_retries: 0 };
  const tAll0 = Date.now();
  const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));

  async function gql(query: string, variables: unknown = {}) {
    // Shopify's throttle is a leaky bucket and a cost-heavy page can be refused
    // outright. Back off and retry rather than returning a short month, which
    // would read as a quiet business day rather than a failed fetch.
    //
    // ⚠️ WAIT FOR WHAT THE BUCKET SAYS IT NEEDS (2026-09-17). The old back-off was
    // a blind 2s/4s/6s/8s that gave up after four tries — fine for one request
    // at a time. The order scan now runs SCAN_CHUNKS pages at once, and the same
    // bucket is shared with shopify-live-refresh every minute and with the
    // catalog jobs, so a refusal is routine rather than exceptional. Shopify
    // returns how short the bucket is and how fast it refills; waiting exactly
    // that long is faster than guessing and much less likely to run out of tries.
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`https://${t.shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t.access_token },
        body: JSON.stringify({ query, variables }),
      });
      const body = await r.json().catch(() => null);
      // A 429 or 5xx with no JSON behind it is Shopify having a moment, not an
      // answer. It used to throw immediately and fail the whole store's pass.
      if (!body && (r.status === 429 || r.status >= 500) && attempt < 4) {
        timing.transient_retries++;
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!body) throw new Error(`Shopify returned non-JSON (HTTP ${r.status})`);
      const throttled = body?.errors?.some((e: any) =>
        e?.extensions?.code === "THROTTLED" || /throttl/i.test(e?.message || ""));
      if (throttled && attempt < 10) {
        const cost = body?.extensions?.cost;
        const ts = cost?.throttleStatus;
        let ms = 2000 * (attempt + 1);
        if (ts && Number(ts.restoreRate) > 0) {
          const short = (Number(cost.requestedQueryCost) || 0) - (Number(ts.currentlyAvailable) || 0);
          ms = Math.ceil(Math.max(short, 0) / Number(ts.restoreRate) * 1000) + 300;
        }
        ms = Math.min(Math.max(ms, 300), 10000);
        timing.throttle_waits++;
        timing.throttle_wait += ms;
        await sleep(ms);
        continue;
      }
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
  const tQl0 = Date.now();
  const qlBody = await gql(
    `{ shopifyqlQuery(query: "FROM sales SHOW net_sales, cost_of_goods_sold, returns GROUP BY day, order_name SINCE ${from} UNTIL ${to}") {
         parseErrors tableData { rows } } }`);
  timing.shopifyql = Date.now() - tQl0;
  const ql = qlBody?.data?.shopifyqlQuery;
  if (ql?.parseErrors?.length) {
    warnings.push(`shopifyql: ${ql.parseErrors.join("; ")}`);
    health.shopifyql_errors = ql.parseErrors.map(String);
  }
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
      // The two counts that let the sheet tell an EMPTY cell from a WRONG one.
      // A $0 card fee is right on a day that took only cash and eBay, and wrong
      // on a day that ran cards; a $0 eBay fee is wrong on any day that sold on
      // eBay. Neither is visible from the fee column alone — netprofit-sheet.gs
      // reads these to decide whether an empty figure is worth an email.
      card_orders: 0,
      // What eBay CHARGED on this day's sales, before any credit. ebay_fee is
      // net of refund credits and can legitimately be zero or negative; this
      // cannot be zero on a day with eBay sales unless the fee went missing.
      // null when the eBay pass failed, like ebay_fee.
      ebay_sale_fees: null,
    };
  }

  // --- credit card fee ------------------------------------------------------
  // Per-order, from transactions[].fees where type == processing_fee.
  //
  // The fee hangs off the CAPTURE, not the AUTHORIZATION — reading only an
  // order's first transaction returns fees: [] and reads as "no card fee".
  // eBay-gateway orders legitimately carry none; eBay takes its cut its own way.
  //
  // Booked to the day the order SOLD — its processedAt, the same day ShopifyQL
  // files its sale under. A capture can land the next day and must not drag the
  // money onto that day. See the SALE DAY note in the loop for why this is not
  // the order's createdAt.
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
  // ⚠️ AND FORWARD PAST IT, because an order can be CREATED after the day it
  // sold. Marketplace Connect imports eBay sales late — a day or two routinely,
  // ten days in the Aug 25 backfill — so an order sold on the last day of the
  // window may not exist in Shopify until after it. Stopping the scan at `to`
  // would lose that order's fees and label from every month. Orders created
  // after `to` are only kept if they SOLD inside the window (the days[] guard
  // below), so this widens what is seen, never what is booked. On the daily
  // pass `to` is today and there is nothing past it to read.
  const scanTo = (() => {
    const d = new Date(to + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + 14);
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
  // Every eBay order id carried by ANY scanned Shopify order, whatever day it
  // sold. ebayOrderDay only holds the ones that sold inside the window; this is
  // what lets the eBay pass tell "sold outside the window" from "no Shopify
  // order exists at all" — see the ORPHAN note there.
  const seenEbayIds = new Set<string>();
  const ebayIdsOf = (o: any): string[] => {
    const ids: string[] = [];
    for (const ca of o.customAttributes || []) {
      if (String(ca.key).trim().toLowerCase() !== "ebay order id") continue;
      const id = String(ca.value || "").trim();
      if (id) ids.push(id);
    }
    const srcId = String(o.sourceIdentifier || "").trim();
    if (/^\d{2}-\d{5}-\d{5}$/.test(srcId)) ids.push(srcId);
    return ids;
  };
  // ONE pass for both the card fee and the shipping label. Page size is 25,
  // not 100: the events connection makes each order node far more expensive
  // (measured ~38 cost points per 25 orders), and a 100-order page with events
  // trips Shopify's throttle on every request rather than occasionally.
  const ORDERS_Q = `query($q: String!, $after: String) {
     orders(first: 25, after: $after, sortKey: CREATED_AT, query: $q) {
       pageInfo { hasNextPage endCursor }
       edges { node {
         name createdAt processedAt sourceName sourceIdentifier
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
   }`;

  // ⚠️ THE SCAN RUNS IN SLICES AT ONCE, AND IS RE-JOINED IN THE ORIGINAL ORDER.
  //
  // WHY (2026-09-17). One cursor over the whole window meant pages one after
  // another: OVL took 67-97s through Sep 16 against a hard 150-second limit on
  // an edge request, and the window grows every day of the month (it starts 40
  // days back and runs to today). At 9:35 that morning the restarted pass shared
  // OVL's Shopify bucket with the catalog refresh and the request died at
  // 150.075s — OVL's column went unwritten. Splitting the creation-date range
  // into SCAN_CHUNKS slices and paging them together cuts the wall time to
  // roughly that of the slowest slice.
  //
  // ⚠️ WHY THE OUTPUT IS UNCHANGED, AND WHAT WOULD CHANGE IT. The loop below is
  // ORDER-SENSITIVE even though it looks like plain summing: every accumulator
  // rounds as it goes, so the same amounts added in a different order can land
  // a cent apart; ebayOrderDay is last-write-wins for the attribute and
  // first-write-wins for sourceIdentifier. So orders are NOT processed as each
  // slice returns. Each slice is a contiguous stretch of created_at, its pages
  // come back CREATED_AT-sorted exactly as before, and the slices are joined
  // oldest first — which is the original single-cursor order. The boundaries
  // are explicit UTC instants used as <X on one side and >=X on the other, so
  // every order falls in exactly one slice; the outer bounds keep their original
  // date form so the window itself does not move. A name seen twice is dropped
  // as belt and braces, and counted.
  //
  // Verified before release by running this beside the single-cursor version
  // for all five stores and comparing the responses field by field.
  const SCAN_CHUNKS = 4;
  const SCAN_PAGE_CAP = 200;   // per slice; the old cap was 200 for the whole scan
  const scanQueries = (() => {
    const outerFrom = `created_at:>=${scanFrom}`;
    const outerTo = `created_at:<=${scanTo}`;
    const lo = Date.parse(scanFrom + "T00:00:00Z");
    // Nothing is created in the future, so the part of the window after
    // tomorrow is always empty and not worth a slice of its own.
    const hi = Math.min(Date.parse(scanTo + "T00:00:00Z"), Date.now() + 86400000);
    if (!(hi - lo > 86400000 * SCAN_CHUNKS)) return [`${outerFrom} AND ${outerTo}`];
    const cuts: string[] = [];
    for (let i = 1; i < SCAN_CHUNKS; i++) {
      cuts.push(new Date(lo + Math.round((hi - lo) * i / SCAN_CHUNKS)).toISOString().slice(0, 19) + "Z");
    }
    return Array.from({ length: SCAN_CHUNKS }, (_, i) => [
      i === 0 ? outerFrom : `created_at:>='${cuts[i - 1]}'`,
      i === SCAN_CHUNKS - 1 ? outerTo : `created_at:<'${cuts[i]}'`,
    ].join(" AND "));
  })();
  const tScan0 = Date.now();
  const slices = await Promise.all(scanQueries.map(async (q) => {
    const nodes: any[] = [];
    let after: string | null = null;
    let n = 0;
    do {
      const page: any = await gql(ORDERS_Q, { q, after });
      if (page.errors?.length) return { error: page.errors, nodes, pages: n, capHit: false };
      const conn = page.data.orders;
      for (const e of conn.edges) nodes.push(e.node);
      after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
      n++;
    } while (after && n < SCAN_PAGE_CAP);
    return { error: null, nodes, pages: n, capHit: !!after };
  }));
  const failedSlice = slices.find((x) => x.error);
  if (failedSlice) {
    return json({ error: "shopify orders query failed", detail: failedSlice.error, store }, 502);
  }
  const scannedOrders: any[] = [];
  const scannedNames = new Set<string>();
  let scanDuplicates = 0;
  for (const sl of slices) {
    for (const node of sl.nodes) {
      if (scannedNames.has(node.name)) { scanDuplicates++; continue; }
      scannedNames.add(node.name);
      scannedOrders.push(node);
    }
    pages += sl.pages;
  }
  if (slices.some((x) => x.capHit)) cursor = "page cap";
  if (scanDuplicates) warnings.push(`${scanDuplicates} order(s) came back in two scan slices and were counted once`);
  timing.scan = Date.now() - tScan0;
  timing.scan_pages = pages;
  timing.scan_chunks = scanQueries.length;
  timing.scan_orders = scannedOrders.length;

  for (const o of scannedOrders) {

    // Collected BEFORE the window guard, because an order's sale day and its
    // creation day are not always the same one and the sale day is the one
    // the re-dating below needs.
    const soldOn = chicagoDay(o.processedAt || o.createdAt);
    const returnedLineItems = (o.refunds || []).some((rf: any) =>
      (rf.refundLineItems?.edges || []).length > 0);
    if (returnedLineItems && soldOn >= from && soldOn <= to) saleDay[o.name] = soldOn;

    // ⚠️ THE SALE DAY, NOT THE DAY THE ORDER WAS CREATED. Every cost below —
    // card fee, our label, and (through ebayOrderDay) the eBay fee — books to
    // `d`, and Sales and Cost come from ShopifyQL, which files an order under
    // its processedAt. For a till sale the two are the same day. For an eBay
    // sale they are not: Marketplace Connect creates the Shopify order when it
    // IMPORTS it, and when the import runs late the costs used to go with it.
    //
    // Measured 2026-09-15: the importer stalled over Sep 11-13 and 46 eBay
    // orders at all five stores were created one to two days after they sold.
    // OVL's Sep 12 and 13 kept their $9,228 of sales and showed $0.00 of eBay
    // fee, with the fees and labels of 15 orders piled onto Sep 14; LEE and
    // WSP lost Sep 11's the same way. Nothing guarded it, because every
    // month total was still right — only the days were wrong.
    const d = soldOn;
    for (const id of ebayIdsOf(o)) seenEbayIds.add(id);
    if (!days[d]) continue; // sold outside the window; never invent a row
    days[d].orders++;
    const isEbay = o.sourceName === "ebay"
      || (o.transactions || []).some((x: any) => x.gateway === "ebay");
    if (isEbay) days[d].ebay_orders++;
    if ((o.transactions || []).some((x: any) => x.status === "SUCCESS"
        && x.gateway === "shopify_payments" && (x.kind === "SALE" || x.kind === "CAPTURE"))) {
      days[d].card_orders++;
    }
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
    // The same id also sits in sourceIdentifier on the copies Marketplace
    // Connect makes (see sales-true-daily's header). Every September order
    // carries both, but an order with only this one would otherwise leave its
    // fee unmatched and report the sale as never imported.
    const srcId = String(o.sourceIdentifier || "").trim();
    if (/^\d{2}-\d{5}-\d{5}$/.test(srcId) && !ebayOrderDay[srcId]) {
      ebayOrderDay[srcId] = { day: d, name: o.name };
    }
  }
  if (cursor) warnings.push(`stopped at ${SCAN_PAGE_CAP} pages in a scan slice — range too wide, split it`);
  health.page_cap_hit = !!cursor;
  health.orders_with_truncated_events = ordersWithTruncatedEvents;
  health.unknown_label_messages = unknownLabelMessages.length;
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

  // --- eBay fees (and eBay-billed labels) -----------------------------------
  // A FEE is attributed by its ORDER, not by its own transaction date, so a
  // refund settled weeks later credits its fee back to the day the item SOLD.
  // A CHARGE whose order is not in this month's map belongs to another month,
  // was already counted there, and is reported rather than guessed at. A CREDIT
  // in the same position is RESCUED onto the day it posted — it was in no month
  // at all — see the fee attribution block for the full reasoning.
  //
  // ⚠️ A LABEL IS THE EXCEPTION AND BOOKS BY ITS OWN DATE. It is billed weeks
  // after the sale, so requiring an order match dropped every one of them into
  // `unmatched` and lost the postage from both months. See the SHIPPING_LABEL
  // branch below — it is handled before the order lookup for exactly that
  // reason, and `unmatched` now counts fees only.
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
    // A fee credit whose order sold in an earlier month, re-booked onto the day
    // the credit itself posted rather than discarded. The fee attribution block
    // below says why a CREDIT is rescued and a CHARGE is not.
    refund_credits_rebooked: 0, refund_credits_rebooked_amount: 0,
    // `unmatched` split by direction, because the two mean opposite things: a
    // stranded credit understates Net Profit, a stranded charge OVERSTATES it.
    unmatched_sale_fees: 0, unmatched_refund_credits: 0,
    // Labels booked by their own post date, so an order this window cannot see is
    // not a failure the way it is for a fee. `label_outside_window` is postage
    // that belongs to a day outside the range — the tie between two months.
    label_outside_window: 0, label_outside_window_count: 0,
    label_no_order_in_window: 0,
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

    // The day last month stopped accepting charges. A fee credit dated AFTER it
    // was never in that month's figures and can be rescued onto a day in this
    // window; one dated on or before it already is, and rescuing it would count
    // it twice. Same calendar the shipping rule uses, one month back.
    const prevMonthClose = (() => {
      const y = Number(from.slice(0, 4));
      const m = Number(from.slice(5, 7));
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return monthCloseDay(`${py}-${String(pm).padStart(2, "0")}`);
    })();

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
      days[d].ebay_sale_fees = 0;
    }
    // "Already over" is decided in the stores' calendar, same as everything else
    // here. Today's eBay sales are routinely not imported yet and today is never
    // written, so they are not a gap.
    const todayChicago = chicagoDay(new Date().toISOString());

    // ── ORPHANS: an eBay sale inside the window with NO Shopify order at all ──
    // Two very different things look identical here, and both used to be
    // mishandled:
    //   * a sale the importer has not brought across yet — the day is missing
    //     the SALE as well as the fee (Sep 11-13 was this);
    //   * a sale cancelled before it was ever imported — nothing is missing.
    //     Three of these (LEE 15-15146-24542, WSP 01-15172-32087 and
    //     14-15112-68662, confirmed cancelled 2026-09-15) were the first thing
    //     the "not imported" alert ever reported.
    //
    // ⚠️ AND THE CANCELLED KIND WAS UNDERSTATING THE FEE. Its SALE row had no
    // order to join to and was dropped as "another month's", while its REFUND
    // row — the fee eBay handed back — was rescued onto the day it posted. The
    // charge vanished and the credit stayed: $40.31 at LEE and $140.29 at WSP
    // came off the fee column that eBay never actually kept.
    //
    // So an orphan is DATED BY eBAY'S OWN SALE DATE, exactly as if it had a
    // Shopify order: its fee books to the day it sold and any credit follows it
    // there, the way a matched refund does. A cancellation nets to zero on its
    // own day; an unimported sale shows its real fee now, and sits on the same
    // day when its order arrives. It only counts as NOT IMPORTED while eBay has
    // no refund against it — a refunded orphan was a cancellation, not a gap.
    // (A PARTLY refunded unimported sale would be read as cancelled. None has
    // been seen; if one appears, compare amounts here.)
    //
    // seenEbayIds, not ebayOrderDay, decides "no Shopify order": an order that
    // exists but sold just outside the window must stay another month's, and a
    // sale a few seconds either side of midnight can fall on different days in
    // Shopify and eBay.
    const refundedIds = new Set<string>();
    for (const x of txs) {
      if (String(x.transactionType) === "REFUND") refundedIds.add(String(x.orderId || "").trim());
    }
    for (const x of txs) {
      if (String(x.transactionType) !== "SALE") continue;
      const oid = String(x.orderId || "").trim();
      if (!oid || ebayOrderDay[oid] || seenEbayIds.has(oid)) continue;
      const soldDay = x.transactionDate ? chicagoDay(String(x.transactionDate)) : "";
      if (!soldDay || !days[soldDay]) continue;
      ebayOrderDay[oid] = { day: soldDay, name: "" };  // "" = no Shopify order
      if (refundedIds.has(oid)) {
        health.cancelled_before_import.n++;
        if (health.cancelled_before_import.orders.length < 25) {
          health.cancelled_before_import.orders.push({ ebay_order_id: oid, day: soldDay });
        }
      } else if (soldDay < todayChicago) {
        // Today's are routinely not imported YET, and today is never written.
        health.not_yet_imported.n++;
        health.not_yet_imported.fee = round2(health.not_yet_imported.fee
          + (Number(x?.totalFeeAmount?.value) || 0));
        if (health.not_yet_imported.orders.length < 25) {
          health.not_yet_imported.orders.push({ ebay_order_id: oid, day: soldDay });
        }
      }
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

      // ── EBAY-BILLED SHIPPING LABELS BOOK ON THE DAY EBAY CHARGED THEM ─────
      // Handled BEFORE the order lookup below, and that placement is the whole
      // fix. These rows used to fall through to `ebayOrderDay[oid]` like a fee —
      // but a return label is billed weeks after the sale, so its order was
      // almost never inside the window, every row landed in `unmatched`, and the
      // postage was dropped from BOTH months. Measured 2026-09-09: 25 charges,
      // $311.80, every one a "Return shipping label", and `label_count` read 0
      // at all five stores. A real cost that reads as zero is the one direction
      // this file must never fail in.
      //
      // ⚠️ THE POST DATE, NOT THE SALE DATE (Ethan's call, 2026-09-09). WE DO
      // NOT BUY THESE. The buyer opens a return, eBay buys the label and bills
      // us, and the row carries exactly ONE date — `transactionDate`, all 25
      // already `PAYOUT`. So there is no purchase-vs-post choice to make: the
      // day eBay stamps the charge is the only day that exists. It is also the
      // rule shippingBookingDay() already applies to a carrier price
      // adjustment, for the same reason — a cost whose timing the store does not
      // control cannot be gamed, so it books when it was charged. Note the
      // asymmetry this leaves, which is deliberate: our OWN outbound Shopify
      // label still books to the SALE day, because we choose when to buy it.
      //
      // ⚠️ IT NEEDS NO ORDER MATCH, and that is why nothing can be silently
      // dropped again — the date comes off the transaction itself. A label whose
      // post day falls outside this window belongs to another day's row and is
      // COUNTED, not discarded: `label_outside_window` is what says so, and on a
      // month boundary it is the figure that ties one month's postage to the
      // next. It is also why booking here can never re-open a closed month, the
      // way sale-day attribution would have to for an August sale returned in
      // September.
      if (type === "SHIPPING_LABEL") {
        const postDay = x.transactionDate ? chicagoDay(String(x.transactionDate)) : "";
        // ⚠️ THE SIGN COMES FROM bookingEntry, NOT FROM THE TYPE NAME — the same
        // rule the NON_SALE_CHARGE branch above follows. A voided or refunded
        // label arrives as SHIPPING_LABEL with bookingEntry CREDIT and a
        // POSITIVE amount: it is money handed back. Adding it unsigned charged
        // us for postage twice — once when the label was bought, again when eBay
        // refunded it. Confirmed against the CFO's consolidated report, which
        // carries these as negative "Ebay Shipping" (OVL #KS01-12833, 7/23:
        // ($65.90)).
        const credit = String(x.bookingEntry) === "CREDIT";
        const signed = credit ? -amt : amt;
        // The window guard comes FIRST so every tally below describes exactly
        // what was booked. Counting a row we then refuse to book would make
        // `labels` disagree with the sum of the days, which is the kind of
        // quiet drift that took a month to find the first time.
        if (!postDay || !days[postDay]) {
          ebay.label_outside_window = round2(ebay.label_outside_window + signed);
          ebay.label_outside_window_count++;
          continue;
        }
        if (credit) {
          ebay.label_credits = round2(ebay.label_credits + amt);
          ebay.label_credit_count++;
        }
        // Most are the buyer's return leg — verified by transactionMemo "Return
        // shipping label" and a RETURN_ID reference. An order legitimately
        // carries BOTH legs: we buy the outbound label on Shopify, eBay bills us
        // the return. That is a return costing postage twice, not a double
        // count, and it is exactly the cost the GP-based view never charged
        // anyone for.
        //
        // A NON-return eBay label on an order that ALREADY has a Shopify label
        // is a different matter and still worth flagging. That check needs the
        // Shopify order name, so it can only fire when the order happens to sit
        // in this window — the booking above never waits for it, and
        // `label_no_order_in_window` says how often the name was unavailable.
        const isReturn = /return/i.test(String(x.transactionMemo || ""))
          || (x.references || []).some((r: any) => String(r?.referenceType) === "RETURN_ID");
        const owner = ebayOrderDay[oid];
        if (isReturn) {
          ebay.return_labels = round2(ebay.return_labels + signed);
          ebay.return_label_count++;
        } else if (!credit && owner && ordersWithShopifyLabel.has(owner.name)) {
          ebay.overlap_orders.push(owner.name);
        }
        if (!owner || !owner.name) ebay.label_no_order_in_window++;
        ebay.labels = round2(ebay.labels + signed);
        ebay.label_count++;
        days[postDay].shipping_cost = round2((days[postDay].shipping_cost || 0) + signed);
        continue;
      }

      // ── WHICH DAY A FEE BELONGS TO, and the one case where it is not the sale
      // A fee is the cost of a sale, so it books to the day the item SOLD, and
      // a refund settled weeks later credits its fee back to that original sale
      // date. That is the whole point of the ebayOrderDay join and it stays.
      //
      // ⚠️ BUT A CREDIT ON AN ORDER THIS WINDOW CANNOT SEE USED TO BE THROWN
      // AWAY, which silently leaves the fee too HIGH. Caught by Ethan tying
      // LEE's Sep 1-6 against eBay's own transaction report, 2026-09-09: eBay
      // credited $94.32 of fees back, we booked $41.27, and the missing $53.05
      // was five refunds and a claim against orders sold in August or earlier.
      // Same guard that was eating the return labels — and it fails in the SAFE
      // direction, a fee left too high making Net Profit too LOW, so no guard in
      // this file was ever going to notice. Company-wide: $766.13 of credits
      // dropped in six days, against $228.05 of postage dropped the other way.
      //
      // ⚠️ THE ASYMMETRY IS DELIBERATE: A CHARGE IS DROPPED, A CREDIT IS KEPT.
      // An unmatched SALE fee belongs to a sale in an earlier month and was
      // already charged there, so booking it here would count it twice. An
      // unmatched CREDIT was not in that month's figures — the return had not
      // happened when the month closed — so it belongs to nobody unless this
      // month takes it. That is exactly the rule shippingBookingDay() already
      // applies to a label bought after the close.
      //
      // ⚠️ AND THE RESCUE IS GUARDED ON LAST MONTH'S CLOSE, or it would double
      // count. That close run scanned up to its own close day, so a credit dated
      // on or before it is already in the closed figures; only one dated AFTER
      // it fell through both months. Measured on LEE: four of the five strays
      // qualify ($48.19), and the Sep 1 one does not, because August's 7pm close
      // on Sep 1 had already caught it.
      const hit = ebayOrderDay[oid];
      let d = hit && days[hit.day] ? hit.day : "";
      if (!d && type === "REFUND") {
        const creditDay = x.transactionDate ? chicagoDay(String(x.transactionDate)) : "";
        if (creditDay && days[creditDay] && creditDay > prevMonthClose) {
          d = creditDay;
          ebay.refund_credits_rebooked++;
          ebay.refund_credits_rebooked_amount =
            round2(ebay.refund_credits_rebooked_amount + fee);
        }
      }
      if (!d) {
        // Still nowhere to put it. Counted BY DIRECTION, because the two mean
        // opposite things: a stranded credit only understates Net Profit, while
        // a stranded CHARGE overstates it and is the one worth chasing.
        ebay.unmatched++;
        if (type === "REFUND") {
          ebay.unmatched_refund_credits = round2(ebay.unmatched_refund_credits + fee);
        } else {
          // Only another month's sales reach here now — an orphan inside the
          // window was given its own day by the ORPHAN pass above.
          ebay.unmatched_sale_fees = round2(ebay.unmatched_sale_fees + fee);
        }
        continue;
      }
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
          days[d].ebay_sale_fees = round2((days[d].ebay_sale_fees || 0) + fee);
        } else {
          // DEBIT row, but totalFeeAmount is the fee eBay hands BACK to us.
          ebay.refund_fee_credits = round2(ebay.refund_fee_credits + fee);
          days[d].ebay_fee = round2((days[d].ebay_fee || 0) - fee);
        }
      }
    }

    if (ebay.unmatched) {
      warnings.push(`${ebay.unmatched} eBay FEE row(s) had no matching order in `
        + "this month — they belong to sales outside the range. Labels are not in "
        + "this count: they book by their own post date and need no match");
    }
    if (ebay.refund_credits_rebooked) {
      warnings.push(`${ebay.refund_credits_rebooked} fee credit(s) worth `
        + `$${ebay.refund_credits_rebooked_amount} were for orders sold before this `
        + "window and are booked on the day the credit posted. These were dropped "
        + "entirely before 2026-09-09, which is why the fee column ran high");
    }
    if (ebay.unmatched_refund_credits) {
      warnings.push(`$${ebay.unmatched_refund_credits} of fee CREDITS arrived on or `
        + "before last month's close, so they are already in that closed month. Not "
        + "rescued here, deliberately, to avoid counting them twice");
    }
    if (ebay.unmatched_sale_fees) {
      warnings.push(`$${ebay.unmatched_sale_fees} of eBay fee CHARGES belong to sales `
        + "outside this window and are in no day. They should already sit in the month "
        + "those sales closed in — this is the direction that OVERSTATES Net Profit, so "
        + "a large figure here is worth chasing");
    }
    if (ebay.overlap_orders.length) {
      warnings.push(`${ebay.overlap_orders.length} order(s) carry BOTH a Shopify label and `
        + "an eBay OUTBOUND label — shipping may be double counted on: "
        + ebay.overlap_orders.slice(0, 5).join(", "));
    }
    if (Object.keys(ebay.unhandled_types).length) {
      warnings.push("unrecognised eBay finance transaction type(s), NOT counted anywhere: "
        + JSON.stringify(ebay.unhandled_types));
      health.unhandled_ebay_types = ebay.unhandled_types;
    }
    if (health.not_yet_imported.n) {
      warnings.push(`${health.not_yet_imported.n} eBay sale(s) on a finished day have no `
        + `Shopify order — $${health.not_yet_imported.fee} of fee, and their sales, are `
        + "missing from those days until Marketplace Connect imports them");
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
      days[d].ebay_sale_fees = null;
      days[d].shipping_cost = null;
    }
    warnings.push(`eBay fee unavailable: ${String(e)}`);
    health.ebay_error = String(e);
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
      rule: "OUR outbound label books to the SALE day unless it was charged after "
          + "that month closed; a carrier price adjustment, and an EBAY-BILLED "
          + "label (the buyer's return leg), always book to the day charged",
      month_closes: monthCloseDay(from.slice(0, 7)) + " 19:00 America/Chicago",
      scanned_orders_from: scanFrom,
      rebooked_to_a_different_day: rebooked,
      outside_this_window: outOfWindow,
    },
    shippingLabelLag: labelLag,
    shippingLabelDetail: wantLabels ? labelDetail : undefined,
    blocked,
    warnings,
    health,
    timings_ms: { ...timing, total: Date.now() - tAll0 },
    days: list,
  });
});
