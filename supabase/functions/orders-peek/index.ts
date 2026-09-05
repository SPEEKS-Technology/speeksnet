// ============================================================================
// orders-peek — every order a store booked on a day, with enough detail to
// recognise one by eye.
//
//   ?secret=<ops>&store=WSP&from=2026-08-27[&to=2026-08-27]
//   &q=dummy            optional: only orders whose text matches (case-insensitive)
//   &min=50&max=200     optional: only orders inside a price band
//
// READ ONLY. One paged GraphQL query against Shopify. Writes nothing, anywhere.
//
// WHY THIS EXISTS. The restatement work keeps hitting the same wall: we can
// total a day five different ways, but when someone says "exclude the dummy
// listing the customer re-purchased" there is no way to SEE the day's orders and
// point at one. sales-true-daily reports buckets; dupe-order-trace needs an eBay
// id you already have. Neither answers "show me the day".
//
// It reports line-item titles and SKUs because that is how a made-up listing
// gives itself away — the money looks like an ordinary sale, the product does
// not.
// ============================================================================

const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";

const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 1), {
    status: s,
    headers: { "Content-Type": "application/json" },
  });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// The store's own calendar. The edge runtime is UTC, so a 7pm Central sale is
// tomorrow in UTC and a quarter of every evening would land on the wrong day.
const DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
});
const chicagoDay = (iso: string) => DAY.format(new Date(iso));

const buildQ = (fields: string) => `query($q: String!, $after: String) {
  orders(first: 60, query: $q, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node {${fields}
      customAttributes { key value }
      currentSubtotalPriceSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      lineItems(first: 20) { edges { node {
        title quantity sku
        originalTotalSet { shopMoney { amount } }
      } } }
    } }
  }
}`;

function ebayIdOf(o: any): string | null {
  const src = String(o.sourceIdentifier || "").trim();
  if (/^\d{2}-\d{5}-\d{5}$/.test(src)) return src;
  for (const a of (o.customAttributes || [])) {
    if (/ebay\s*order\s*id/i.test(String(a.key))) {
      const v = String(a.value || "").trim();
      if (v) return v;
    }
  }
  const m = String(o.tags || "").match(/\b\d{2}-\d{5}-\d{5}\b/);
  return m ? m[0] : null;
}

// Some of the fields worth having are gated: `customer` needs protected
// customer data approval and `app` needs read_apps. A diagnostic that 500s
// because one field is walled off is useless exactly when it is needed, so the
// query is tried in full and then again without the gated block.
const FIELDS_FULL = `
      name createdAt sourceName sourceIdentifier tags note
      displayFinancialStatus displayFulfillmentStatus cancelledAt
      app { name }
      customer { displayName }`;
const FIELDS_PLAIN = `
      name createdAt sourceName sourceIdentifier tags note
      displayFinancialStatus displayFulfillmentStatus cancelledAt`;

Deno.serve(async (req) => {
 try {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  const store = (url.searchParams.get("store") || "").toUpperCase();
  if (!SHOP_BY_STORE[store]) return json({ error: `pass store=one of ${Object.keys(SHOP_BY_STORE).join(", ")}` }, 400);

  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || from).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return json({ error: "pass from=YYYY-MM-DD[&to=YYYY-MM-DD]" }, 400);
  }

  const needle = (url.searchParams.get("q") || "").trim().toLowerCase();
  const min = url.searchParams.get("min") ? num(url.searchParams.get("min")) : null;
  const max = url.searchParams.get("max") ? num(url.searchParams.get("max")) : null;

  const shop = SHOP_BY_STORE[store];
  const tokRes = await fetch(`${SUPABASE_URL}/rest/v1/shopify_stores?select=shop,access_token&shop=eq.${shop}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const token = ((await tokRes.json())[0] || {}).access_token;
  if (!token) return json({ error: `no token for ${store}` }, 400);

  const gql = async (q: string, variables: any) => {
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query: q, variables }),
    });
    const b = await res.json();
    if (b.errors?.length) throw new Error(`${store}: ${JSON.stringify(b.errors).slice(0, 300)}`);
    return b.data;
  };

  // Settle which field set this store's token can actually read, once, before
  // paging — so a scope wall costs one wasted call, not one per page.
  let fields = FIELDS_FULL;
  const gated: string[] = [];
  const probeQ = `created_at:>=${from} AND created_at:<=${to}T23:59:59Z`;
  try {
    await gql(buildQ(FIELDS_FULL), { q: probeQ, after: null });
  } catch (e) {
    fields = FIELDS_PLAIN;
    gated.push(`customer/app unavailable on ${store}: ${String((e as Error).message).slice(0, 200)}`);
  }

  const orders: any[] = [];
  let after: string | null = null, pages = 0;
  const query = probeQ;
  do {
    const d: any = await gql(buildQ(fields), { q: query, after });
    const conn = d.orders;
    for (const e of conn.edges) {
      const o = e.node;
      const day = chicagoDay(o.createdAt);
      // Shopify's created_at filter is UTC; re-test on the STORE's calendar so
      // the answer is the day the store would say it was.
      if (day < from || day > to) continue;

      const items = (o.lineItems?.edges || []).map((x: any) => ({
        title: x.node.title,
        qty: x.node.quantity,
        sku: x.node.sku || null,
        amount: r2(num(x.node.originalTotalSet?.shopMoney?.amount)),
      }));
      const row: any = {
        order: o.name,
        day,
        created_at: o.createdAt,
        source: o.sourceName || null,
        app: o.app?.name || null,
        ebay_order_id: ebayIdOf(o),
        customer: o.customer?.displayName || null,
        financial: o.displayFinancialStatus,
        fulfillment: o.displayFulfillmentStatus,
        cancelled_at: o.cancelledAt || null,
        subtotal: r2(num(o.currentSubtotalPriceSet?.shopMoney?.amount)),
        total: r2(num(o.totalPriceSet?.shopMoney?.amount)),
        refunded: r2(num(o.totalRefundedSet?.shopMoney?.amount)),
        tags: o.tags || null,
        note: o.note || null,
        items,

      };

      if (min !== null && row.subtotal < min) continue;
      if (max !== null && row.subtotal > max) continue;
      if (needle) {
        const hay = JSON.stringify(row).toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      orders.push(row);
    }
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after && ++pages < 40);

  orders.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

  // Per-order COGS, on request. Priced from ShopifyQL the way sales-true-daily
  // prices its buckets, and for the same reason: unitCost is the CURRENT cost
  // of the SKU, not what the item cost when it sold.
  //
  // ⚠️ ONE QUERY PER DAY. `GROUP BY order_name` across a range silently
  // truncates on a busy store, and the rows it drops read as a plausible
  // answer rather than as a failure.
  if (url.searchParams.get("cost")) {
    const days = Array.from(new Set(orders.map((o: any) => o.day))).sort();
    for (const day of days) {
      const perOrder = await gql(
        `{ shopifyqlQuery(query: "FROM sales SHOW cost_of_goods_sold GROUP BY order_name SINCE ${day} UNTIL ${day}") {
             parseErrors tableData { rows } } }`, {});
      const byName: Record<string, number> = {};
      for (const row of perOrder?.shopifyqlQuery?.tableData?.rows || []) {
        byName[String(row.order_name || "")] = r2(num(row.cost_of_goods_sold));
      }
      for (const o of orders) {
        // null, not 0 — "ShopifyQL had no row for this order" and "this order
        // cost nothing" are different answers and must not look the same.
        if (o.day === day) o.cost = Object.prototype.hasOwnProperty.call(byName, o.order) ? byName[o.order] : null;
      }
    }
  }

  return json({
    readOnly: "queried Shopify with a GET-equivalent GraphQL read; nothing written",
    store, from, to,
    filters: { q: needle || null, min, max },
    gated: gated.length ? gated : null,
    count: orders.length,
    subtotal_sum: r2(orders.reduce((s: number, o: any) => s + o.subtotal, 0)),
    orders,
  });
 } catch (e) {
  // Say what broke. A diagnostic that answers "Internal Server Error" sends the
  // next hour into guessing which field was the problem.
  return json({ error: String((e as Error).message || e) }, 500);
 }
});
