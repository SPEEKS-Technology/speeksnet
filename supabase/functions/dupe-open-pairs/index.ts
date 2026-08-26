// ============================================================================
// dupe-open-pairs — duplicate Shopify orders where NEITHER copy has been
// refunded. Two live orders, same buyer, same item, one sale.
//
//   ?secret=<ops>&store=OVL      one store
//   ?secret=<ops>&store=ALL      all five
//   &since=2026-08-10            override the window (default 2026-08-10)
//
// READ-ONLY against Shopify and eBay. Nothing is written.
//
// WHY THIS IS ITS OWN LIST: the other duplicate sets are already decided. These
// are not. Both copies still read as completed sales, so the store is carrying
// two live orders for one item — the stock is wrong, the day's revenue is
// double-counted, and nobody has been refunded on either side.
//
// ⚠️ THESE ARE NOT THE 176 "AT RISK" ORDERS. There the duplicate was refunded
// in Shopify and eBay has not replayed it. Here NOTHING has been refunded
// anywhere, which is why the two lists must never be merged: the safe action is
// opposite in each case.
//
// HOW THE PAIR IS FOUND: Shopify is asked only for orders that are still fully
// paid (`financial_status:paid`). Any eBay order id that comes back twice in
// that set therefore has two unrefunded copies by construction — a pair with
// one copy already refunded simply cannot appear. That is much cheaper than
// reading every order and comparing refunds, and it cannot produce a false
// positive from a stale refund total.
//
// The two apps record the eBay order id DIFFERENTLY, so three forms are read:
//   SPEEKS Connect  -> tag "ebay-<id>", customAttribute, sourceIdentifier NULL
//   new MC ("PayMore") -> sourceIdentifier = <id>, customAttribute
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

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${path}: ${r.status}`);
  return await r.json();
}

// PostgREST caps a page at 1000 rows silently; refund_reprobe is well past that.
async function sbAll(path: string) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
        Range: `${from}-${from + 999}`, "Range-Unit": "items",
      },
    });
    if (!r.ok) throw new Error(`supabase ${path}: ${r.status}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

const ORDER_FIELDS = `
  id name createdAt cancelledAt
  displayFinancialStatus displayFulfillmentStatus
  sourceIdentifier tags
  app { name }
  totalPriceSet { shopMoney { amount } }
  totalRefundedSet { shopMoney { amount } }
  customAttributes { key value }
  lineItems(first: 5) { edges { node { sku title quantity } } }
`;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  const want = (url.searchParams.get("store") || "").toUpperCase().trim();
  if (!want) return json({ error: "pass ?store=OVL or ?store=ALL" }, 400);
  const stores = want === "ALL" ? Object.keys(SHOP_BY_STORE) : [want];
  if (stores.some((s) => !SHOP_BY_STORE[s])) return json({ error: `unknown store "${want}"` }, 400);
  const since = url.searchParams.get("since") || "2026-08-10";

  const tokRows = await sbGet(`shopify_stores?select=shop,store_code,access_token`);

  // eBay's current state for any order we have probed, so a pair can be read
  // against what eBay thinks rather than in isolation.
  const probe = await sbAll(
    `refund_reprobe?select=run_at,ebay_order_id,ebay_refund_total,ebay_payment_status`
    + `&order=ebay_order_id.asc,run_at.desc`);
  const ebayState: Record<string, any> = {};
  for (const p of probe) if (!ebayState[p.ebay_order_id]) ebayState[p.ebay_order_id] = p;

  const report: any[] = [];

  for (const store of stores) {
    const shop = SHOP_BY_STORE[store];
    const t = tokRows.find((x: any) => x.store_code === store) || tokRows.find((x: any) => x.shop === shop);
    if (!t) { report.push({ store, error: "no shopify_stores row" }); continue; }

    async function gql(query: string, variables: unknown = {}) {
      for (let attempt = 0; ; attempt++) {
        const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t.access_token },
          body: JSON.stringify({ query, variables }),
        });
        const body = await r.json().catch(() => null);
        const throttled = body?.errors?.some((e: any) =>
          e?.extensions?.code === "THROTTLED" || /throttl/i.test(e?.message || ""));
        if (throttled && attempt < 6) {
          await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
          continue;
        }
        if (!body) throw new Error(`Shopify non-JSON (HTTP ${r.status})`);
        if (body.errors?.length) throw new Error(JSON.stringify(body.errors).slice(0, 300));
        return body;
      }
    }

    // Fully-paid orders only. See the header: this is what makes "appears twice"
    // mean "neither copy refunded" without a second pass.
    const q = `created_at:>=${since} AND financial_status:paid`;
    const orders: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    try {
      for (;;) {
        const body: any = await gql(
          `query($q: String!, $after: String) {
             orders(first: 50, query: $q, after: $after, sortKey: CREATED_AT) {
               pageInfo { hasNextPage endCursor }
               edges { node { ${ORDER_FIELDS} } }
             }
           }`, { q, after: cursor });
        const conn = body.data.orders;
        orders.push(...conn.edges.map((e: any) => e.node));
        pages++;
        if (!conn.pageInfo.hasNextPage || pages > 60) break;
        cursor = conn.pageInfo.endCursor;
      }
    } catch (e) {
      report.push({ store, error: String(e) });
      continue;
    }

    // Group by eBay order id.
    const groups: Record<string, any[]> = {};
    let withoutEbayId = 0;
    for (const o of orders) {
      if (o.cancelledAt) continue;            // a cancelled copy is already dealt with
      const attr = (o.customAttributes || [])
        .find((a: any) => /ebay order id/i.test(String(a.key)));
      const tag = (o.tags || [])
        .map((x: any) => String(x).trim())
        .find((x: string) => /^ebay-\d[\d-]+$/i.test(x));
      const eid = String(attr?.value || o.sourceIdentifier || (tag ? tag.slice(5) : "")).trim();
      if (!eid) { withoutEbayId++; continue; }
      (groups[eid] ||= []).push(o);
    }

    const pairs: any[] = [];
    for (const [eid, copies] of Object.entries(groups)) {
      if (copies.length < 2) continue;
      // Belt and braces: the query already excluded refunded orders, but a
      // refund landing between pages would be invisible to it.
      const anyRefunded = copies.some((o) => num(o.totalRefundedSet?.shopMoney?.amount) > 0.005);
      if (anyRefunded) continue;

      copies.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      const first = copies[0];
      const li = (first.lineItems?.edges || []).map((e: any) => e.node);
      const es = ebayState[eid];

      pairs.push({
        store,
        ebay_order_id: eid,
        copies: copies.length,
        // The duplicate is the LATER one; the first is the original sale. Named
        // rather than inferred at read time so the two never get swapped.
        original_order: first.name,
        duplicate_orders: copies.slice(1).map((o) => o.name),
        order_value: r2(num(first.totalPriceSet?.shopMoney?.amount)),
        double_counted: r2(copies.slice(1)
          .reduce((a, o) => a + num(o.totalPriceSet?.shopMoney?.amount), 0)),
        // No customer field: these apps run without read_customers, and the eBay
        // probe already carries the buyer where we have one.
        buyer: null,
        items: li.map((x: any) => x.title).filter(Boolean).join(" | "),
        skus: li.map((x: any) => x.sku).filter(Boolean).join(" | "),
        ebay_refunded: es ? num(es.ebay_refund_total) > 0 : null,
        ebay_payment_status: es?.ebay_payment_status ?? null,
        detail: copies.map((o) => ({
          order: o.name,
          shopify_order_id: String(o.id).split("/").pop(),
          app: o.app?.name ?? null,
          created_at: o.createdAt,
          financial: o.displayFinancialStatus,
          fulfillment: o.displayFulfillmentStatus,
          total: r2(num(o.totalPriceSet?.shopMoney?.amount)),
          refunded: r2(num(o.totalRefundedSet?.shopMoney?.amount)),
          admin_url: `https://${shop.replace(".myshopify.com", "")}.myshopify.com/admin/orders/`
            + String(o.id).split("/").pop(),
        })),
      });
    }

    pairs.sort((a, b) => b.double_counted - a.double_counted);
    report.push({
      store,
      paid_orders_scanned: orders.length,
      orders_without_an_ebay_id: withoutEbayId,
      ebay_ids_seen: Object.keys(groups).length,
      open_duplicate_pairs: pairs.length,
      double_counted_amount: r2(pairs.reduce((a, p) => a + p.double_counted, 0)),
      pairs,
    });
  }

  const sum = (k: string) => r2(report.reduce((a, r) => a + (Number(r[k]) || 0), 0));
  return json({
    generated_at: new Date().toISOString(),
    window: `Shopify orders created on or after ${since}, still fully paid`,
    readOnly: "nothing written; no refund, cancel or eBay call",
    scope: "duplicate pairs where NEITHER copy is refunded — NOT the 176 at-risk orders",
    totals: {
      paid_orders_scanned: sum("paid_orders_scanned"),
      open_duplicate_pairs: sum("open_duplicate_pairs"),
      double_counted_amount: sum("double_counted_amount"),
    },
    report,
  });
});
