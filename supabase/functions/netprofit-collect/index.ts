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

// --- eBay Finances API -------------------------------------------------------
// ⚠️ The Finances API is served from apiz.ebay.com, NOT api.ebay.com. The wrong
// host returns a 404 that reads exactly like "this store had no transactions".
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
  const days: Record<string, any> = {};
  const qlBody = await gql(
    `{ shopifyqlQuery(query: "FROM sales SHOW net_sales, cost_of_goods_sold, returns GROUP BY day SINCE ${from} UNTIL ${to} ORDER BY day") {
         parseErrors tableData { rows } } }`);
  const ql = qlBody?.data?.shopifyqlQuery;
  if (ql?.parseErrors?.length) warnings.push(`shopifyql: ${ql.parseErrors.join("; ")}`);
  for (const row of ql?.tableData?.rows || []) {
    const d = String(row.day).slice(0, 10);
    days[d] = {
      day: d,
      net_sales: round2(Number(row.net_sales) || 0),
      cost: round2(Number(row.cost_of_goods_sold) || 0),
      returns: round2(Number(row.returns) || 0),
      cc_fee: 0,
      ebay_fee: null,
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
  let ordersWithTruncatedEvents = 0;
  let labelEvents = 0;
  // eBay Order Id -> the Chicago day the order SOLD. This is what makes eBay
  // fees land on the sale date instead of the settlement date: a refund posted
  // on Aug 10 against a Jul 5 order credits its fee back to JUL 5.
  const ebayOrderDay: Record<string, { day: string; name: string }> = {};
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
             name createdAt sourceName
             customAttributes { key value }
             transactions { kind status gateway
               fees { type amount { amount } } }
             events(first: 50) {
               pageInfo { hasNextPage }
               edges { node { message } }
             }
           } }
         }
       }`,
      { q: `created_at:>=${from} AND created_at:<=${to}`, after: cursor });
    if (body.errors?.length) {
      return json({ error: "shopify orders query failed", detail: body.errors, store }, 502);
    }
    const conn = body.data.orders;
    for (const e of conn.edges) {
      const o = e.node;
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
        days[d].shipping_cost = round2((days[d].shipping_cost || 0) + v);
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
    rows: 0, matched: 0, unmatched: 0,
    account_fees_unattributed: 0, skipped_disputes: 0, skipped_transfers: 0,
    unhandled_types: {} as Record<string, number>,
    overlap_orders: [] as string[],
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

    const txs: any[] = [];
    for (let off = 0; off < 20000; off += 200) {
      const r2 = await ebayGet(
        `${host}/sell/finances/v1/transaction?limit=200&offset=${off}`
        + `&filter=${encodeURIComponent(filter)}`, token);
      if (r2.status !== 200) {
        throw new Error(`finances HTTP ${r2.status}: ${(await r2.text()).slice(0, 200)}`);
      }
      const b2 = await r2.json();
      const page = b2?.transactions || [];
      for (const x of page) txs.push(x);
      if (off + 200 >= (Number(b2?.total) || 0)) break;
    }

    // Only now that the WHOLE range came back 200 do the nulls become zeros: a
    // day with no eBay activity genuinely owes no fee, but a day we failed to
    // read owes an unknown one, and those two must never look alike.
    for (const d of Object.keys(days)) days[d].ebay_fee = 0;

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

      if (type === "SALE") {
        ebay.sale_fees = round2(ebay.sale_fees + fee);
        days[d].ebay_fee = round2((days[d].ebay_fee || 0) + fee);
      } else if (type === "REFUND") {
        // DEBIT row, but totalFeeAmount is the fee eBay hands BACK to us.
        ebay.refund_fee_credits = round2(ebay.refund_fee_credits + fee);
        days[d].ebay_fee = round2((days[d].ebay_fee || 0) - fee);
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
        const isReturn = /return/i.test(String(x.transactionMemo || ""))
          || (x.references || []).some((r: any) => String(r?.referenceType) === "RETURN_ID");
        if (isReturn) {
          ebay.return_labels = round2(ebay.return_labels + amt);
          ebay.return_label_count++;
        } else if (ordersWithShopifyLabel.has(hit.name)) {
          ebay.overlap_orders.push(hit.name);
        }
        ebay.labels = round2(ebay.labels + amt);
        ebay.label_count++;
        days[d].shipping_cost = round2((days[d].shipping_cost || 0) + amt);
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
    for (const d of Object.keys(days)) days[d].ebay_fee = null;
    warnings.push(`eBay fee unavailable: ${String(e)}`);
  }

  // --- what is still blocked ------------------------------------------------
  // Nothing, as of 2026-08-26 — all five columns read live. The map stays so a
  // future failure has somewhere honest to report itself; `warnings` carries the
  // detail, and a failed eBay pass leaves ebay_fee null (the sheet writes =NA()).
  const blocked: Record<string, string> = {};
  const scopes = String(t.scopes || "");

  const list = Object.values(days).sort((a: any, b: any) => (a.day < b.day ? -1 : 1));
  const sum = (k: string) => round2(list.reduce((a: number, r: any) => a + (Number(r[k]) || 0), 0));

  return json({
    store, shop: t.shop, from, to, scopes,
    totals: {
      net_sales: sum("net_sales"),
      cost: sum("cost"),
      cc_fee: sum("cc_fee"),
      shipping_cost: sum("shipping_cost"),
      ebay_fee: sum("ebay_fee"),
      ebay_net_sales: sum("ebay_net_sales"),
      orders: sum("orders"),
      ebay_orders: sum("ebay_orders"),
      label_events: labelEvents,
      // ⚠️ NOT the sheet's Net Profit. The tab also subtracts a flat 7% of sales
      // (the `(B5*0.07)` line in its NP formula), which is the workbook's own
      // definition and is applied there, not here. This is the cost side only.
      net_before_royalty: round2(
        sum("net_sales") - sum("cost") - sum("cc_fee")
        - sum("shipping_cost") - sum("ebay_fee")),
    },
    ebayFinances: ebay,
    feeByTransactionKind: feeByKind,
    blocked,
    warnings,
    days: list,
  });
});
