// ============================================================================
// cogs-restock-probe — does a refund give the COST back, or only the SALE?
//
//   ?secret=<ops>&store=OVL&from=2026-08-01&to=2026-08-31
//
// READ ONLY. Nothing is written to Shopify or to us.
//
// THE QUESTION. When an order is refunded WITHOUT restocking the item, does
// Shopify reverse the cost of goods sold as well as the revenue? It matters
// because the August eBay glitch refunded hundreds of orders with NO_RESTOCK,
// and the two answers move Net Profit in opposite directions:
//
//   cost comes back  → the day loses (sale − cost); the margin, not the ticket
//   cost stays       → the day loses the WHOLE ticket and keeps the cost too
//
// THE TEST. Take refunds whose ORDER DAY is earlier than their REFUND DAY.
// On the refund day that order's ShopifyQL row can only contain refund
// activity — the sale is booked on its own, earlier day. So:
//
//   cost_of_goods_sold < 0 on the refund day  → the cost DID come back
//   cost_of_goods_sold = 0 on the refund day  → it did NOT
//
// Then split those rows by `restockType` and read the two buckets side by side.
// Shopify is asked the same question twice, once for restocked returns and
// once for non-restocked ones, on the same store and the same days.
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
  new Response(JSON.stringify(b, null, 1), { status: s, headers: { "Content-Type": "application/json" } });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

// The store's own calendar — a 7pm Central refund is 1am UTC tomorrow, and
// dating it in UTC would file it on the wrong day. [[edge-fn-utc-timezone]]
const DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
});
const chicagoDay = (iso: string) => DAY_FMT.format(new Date(iso));
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);

const ORDER_Q = `query($q: String!, $after: String) {
  orders(first: 60, query: $q, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      name createdAt processedAt
      refunds(first: 20) {
        createdAt
        totalRefundedSet { shopMoney { amount } }
        refundLineItems(first: 100) {
          edges { node {
            quantity restockType
            subtotalSet { shopMoney { amount } }
            lineItem { name variant { inventoryItem { unitCost { amount } } } }
          } }
        }
      }
    } }
  }
}`;

Deno.serve(async (req) => {
 try {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  const store = (url.searchParams.get("store") || "OVL").toUpperCase();
  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || "").trim();
  const limitPages = Number(url.searchParams.get("pages") || 80);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return json({ error: "pass from=YYYY-MM-DD&to=YYYY-MM-DD (the REFUND window)" }, 400);
  }
  const shop = SHOP_BY_STORE[store];
  if (!shop) return json({ error: `unknown store ${store}` }, 400);

  const rows = await fetch(
    `${SUPABASE_URL}/rest/v1/shopify_stores?select=shop,access_token&shop=eq.${shop}`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  ).then((r) => r.json());
  const token = rows?.[0]?.access_token;
  if (!token) return json({ error: `no token for ${store}` }, 400);

  async function gql(q: string, variables: any) {
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query: q, variables }),
    });
    const b = await res.json();
    if (b.errors?.length) throw new Error(JSON.stringify(b.errors).slice(0, 300));
    return b.data;
  }

  // Orders touched during the refund window. A refund of an old order shows up
  // as an update, so `updated_at` is the only filter that catches all of them.
  const refunds: any[] = [];
  let after: string | null = null, pages = 0, scanned = 0;
  for (;;) {
    const d: any = await gql(ORDER_Q, { q: `updated_at:>=${from} AND updated_at:<=${to}T23:59:59Z`, after });
    pages++;
    for (const e of d.orders.edges) {
      const o = e.node; scanned++;
      for (const rf of (o.refunds || [])) {
        const day = chicagoDay(rf.createdAt);
        if (day < from || day > to) continue;
        const lines = (rf.refundLineItems?.edges || []).map((x: any) => x.node);
        if (!lines.length) continue;
        const subtotal = r2(lines.reduce((a: number, n: any) => a + num(n.subtotalSet?.shopMoney?.amount), 0));
        // What the cost reversal WOULD be, priced off the SKU's current cost.
        const unitCogs = r2(lines.reduce((a: number, n: any) =>
          a + num(n.quantity) * num(n.lineItem?.variant?.inventoryItem?.unitCost?.amount), 0));
        const types = Array.from(new Set(lines.map((n: any) => String(n.restockType || "?")))).sort();
        refunds.push({
          order: o.name,
          order_day: chicagoDay(o.processedAt || o.createdAt),
          refund_day: day,
          restock: types.join("+"),
          refund_subtotal: subtotal,
          expected_cogs_reversal: unitCogs,
          refund_total: num(rf.totalRefundedSet?.shopMoney?.amount),
        });
      }
    }
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
    if (pages >= limitPages) break;
  }

  // Only refunds booked on a LATER day than the sale can answer the question —
  // a same-day refund's row mixes the sale and the return and proves nothing.
  const clean = refunds.filter((r) => r.order_day < r.refund_day);

  // ⚠️ ONE ShopifyQL QUERY PER DAY. `GROUP BY order_name` across a range
  // truncates silently on a busy store.
  const days = Array.from(new Set(clean.map((r) => r.refund_day))).sort();
  const ql: Record<string, Record<string, any>> = {};
  const qlErrors: any[] = [];
  for (const day of days) {
    const d: any = await gql(
      `{ shopifyqlQuery(query: "FROM sales SHOW net_sales, returns, cost_of_goods_sold, gross_profit GROUP BY order_name SINCE ${day} UNTIL ${day}") {
           parseErrors tableData { rows } } }`, {});
    const pe = d?.shopifyqlQuery?.parseErrors;
    if (pe?.length) qlErrors.push({ day, parseErrors: pe });
    const byName: Record<string, any> = {};
    for (const row of d?.shopifyqlQuery?.tableData?.rows || []) {
      byName[String(row.order_name || "")] = {
        net_sales: r2(num(row.net_sales)),
        returns: r2(num(row.returns)),
        cogs: r2(num(row.cost_of_goods_sold)),
        gross_profit: r2(num(row.gross_profit)),
      };
    }
    ql[day] = byName;
  }

  const out = clean.map((r) => {
    // null, not 0 — "ShopifyQL had no row" and "the row said zero" are
    // different answers and must not look the same.
    const q = ql[r.refund_day]?.[r.order] ?? null;
    return {
      ...r,
      ql_day_row: q,
      cost_came_back: q ? (q.cogs < -0.005 ? "YES" : "NO") : "no-ql-row",
    };
  });

  // The verdict, one line per restock type.
  const buckets: Record<string, any> = {};
  for (const r of out) {
    const b = buckets[r.restock] ||= {
      refunds: 0, with_ql_row: 0, cost_came_back: 0, cost_stayed: 0,
      refund_subtotal: 0, ql_returns: 0, ql_cogs: 0, expected_cogs_reversal: 0,
    };
    b.refunds++;
    b.refund_subtotal = r2(b.refund_subtotal + r.refund_subtotal);
    b.expected_cogs_reversal = r2(b.expected_cogs_reversal + r.expected_cogs_reversal);
    if (r.ql_day_row) {
      b.with_ql_row++;
      b.ql_returns = r2(b.ql_returns + r.ql_day_row.returns);
      b.ql_cogs = r2(b.ql_cogs + r.ql_day_row.cogs);
      if (r.cost_came_back === "YES") b.cost_came_back++; else b.cost_stayed++;
    }
  }

  return json({
    readOnly: "GraphQL reads only; nothing written to Shopify or to us",
    store, refund_window: { from, to },
    scanned_orders: scanned, pages,
    refunds_in_window: refunds.length,
    testable_refunds: clean.length,
    ql_errors: qlErrors.length ? qlErrors : null,
    verdict_by_restock_type: buckets,
    rows: url.searchParams.get("rows") === "0" ? undefined : out,
  });
 } catch (e) {
  return json({ error: String((e as Error).message || e) }, 500);
 }
});
