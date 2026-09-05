// ============================================================================
// np-returns-probe — where does a refund BELONG on a daily sales grid?
//
//   ?secret=<ops>&store=OVL&from=2026-07-01&to=2026-07-31
//
// READ ONLY. Pages Shopify orders and reports, per refund, the two candidate
// dates and what each rule would total per day.
//
// WHY. netprofit-collect's Sales and Cost come from ShopifyQL `FROM sales …
// GROUP BY day`, and against PayMore's own consolidated export the GROSS side
// agrees to the cent on all 31 days of July while 29 of 31 days disagree on
// NET. Every dollar of that gap is a refund sitting on a different day.
//
// The two systems date a refund differently:
//
//   ShopifyQL  — the day the REFUND was created.
//   The export — the day the ORDER was created, when that order is inside the
//                reporting month; otherwise the refund's own day.
//
// OVL #KS01-12794 is the clean case: ordered 7/5, refunded 7/6. The export
// nets it against 7/5 (one row carrying both the sale and the return), and
// ShopifyQL books the return on 7/6 — which is why the export shows refunds on
// 7/5, 7/12, 7/19 and 7/26 where ShopifyQL reports exactly zero.
//
// THE AMOUNT IS THE LINE SUBTOTAL, NOT THE REFUND TOTAL. #KS01-12706 refunded
// $185.89, of which $15.90 was tax; the export's Returns column says $169.99.
// Tax never entered Net sales, so it must not leave through Returns either.
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

// The store's own calendar. A refund at 7pm Central is 1am UTC the next day, and
// dating it in UTC would move a quarter of every evening's refunds onto the
// following day — the same class of bug as [[edge-fn-utc-timezone]].
const DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
});
const chicagoDay = (iso: string) => DAY_FMT.format(new Date(iso));
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const ORDER_Q = `query($q: String!, $after: String) {
  orders(first: 100, query: $q, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { cursor node {
      name createdAt processedAt
      refunds(first: 20) {
        createdAt
        totalRefundedSet { shopMoney { amount } }
        refundLineItems(first: 100) {
          edges { node {
            quantity
            subtotalSet { shopMoney { amount } }
            lineItem { name variant { inventoryItem { unitCost { amount } } } }
          } }
        }
      }
    } }
  }
}`;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  const store = (url.searchParams.get("store") || "OVL").toUpperCase();
  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return json({ error: "pass from=YYYY-MM-DD&to=YYYY-MM-DD" }, 400);
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

  // Two sweeps, because a refund can be attached to an order on either side of
  // the month boundary and the rule needs both dates:
  //   A. orders created IN the month — their refunds may land any time after.
  //   B. orders created BEFORE the month but touched during it — their refunds
  //      may land inside it.
  // The `to` side runs well past the month so a late refund of an in-month
  // order is not missed; rows outside the rule are discarded below.
  const scans = [
    { label: "created-in-month", q: `created_at:>=${from} AND created_at:<=${to}T23:59:59Z` },
    { label: "older-touched-in-month", q: `created_at:<${from} AND updated_at:>=${from}` },
  ];

  const refunds: any[] = [];
  const scanStats: any = {};
  for (const scan of scans) {
    let after: string | null = null, pages = 0, orders = 0;
    for (;;) {
      const d: any = await gql(ORDER_Q, { q: scan.q, after });
      pages++;
      for (const e of d.orders.edges) {
        const o = e.node;
        orders++;
        for (const rf of (o.refunds || [])) {
          const lines = (rf.refundLineItems?.edges || [])
            .map((x: any) => Number(x.node.subtotalSet?.shopMoney?.amount || 0));
          const subtotal = r2(lines.reduce((a: number, b: number) => a + b, 0));
          // COGS reverses with the refund and must travel to the same day.
          // unitCost is the CURRENT cost, not a snapshot taken at the sale, so
          // this is exact only while a SKU's cost has not been re-keyed since.
          const cogs = r2((rf.refundLineItems?.edges || []).reduce((a: number, x: any) =>
            a + Number(x.node.quantity || 0)
              * Number(x.node.lineItem?.variant?.inventoryItem?.unitCost?.amount || 0), 0));
          if (!subtotal) continue;
          refunds.push({
            order: o.name,
            order_day: chicagoDay(o.processedAt || o.createdAt),
            created_day: chicagoDay(o.createdAt),
            refund_day: chicagoDay(rf.createdAt),
            subtotal, cogs,
            refund_total: Number(rf.totalRefundedSet?.shopMoney?.amount || 0),
          });
        }
      }
      if (!d.orders.pageInfo.hasNextPage) break;
      after = d.orders.pageInfo.endCursor;
      if (pages > 60) break; // a runaway page loop must not bill forever
    }
    scanStats[scan.label] = { pages, orders };
  }

  // De-duplicate: the two sweeps cannot overlap by construction, but a refund
  // seen twice would silently double a day.
  const seen = new Set<string>();
  const uniq = refunds.filter((r) => {
    const k = `${r.order}|${r.refund_day}|${r.subtotal}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const inMonth = (d: string) => d >= from && d <= to;

  const byRefundDay: Record<string, number> = {};   // what ShopifyQL does
  const byExportRule: Record<string, number> = {};  // what the export does
  const add = (m: Record<string, number>, d: string, v: number) => {
    if (!inMonth(d)) return;
    m[d] = r2((m[d] || 0) + v);
  };
  for (const r of uniq) {
    add(byRefundDay, r.refund_day, -r.subtotal);
    // The export's rule: an in-month order carries its own refund, whenever
    // that refund happened; anything else falls on the refund's own day.
    add(byExportRule, inMonth(r.order_day) ? r.order_day : r.refund_day, -r.subtotal);
  }

  const sum = (m: Record<string, number>) => r2(Object.values(m).reduce((a, b) => a + b, 0));

  return {
    readOnly: "queried Shopify with GETs only; nothing written",
  } && json({
    readOnly: "read-only",
    store, from, to,
    scans: scanStats,
    refunds_found: uniq.length,
    total_by_refund_day: sum(byRefundDay),
    total_by_export_rule: sum(byExportRule),
    // The rows that move, which is the whole point.
    moved: uniq
      .filter((r) => inMonth(r.order_day) && r.order_day !== r.refund_day)
      .map((r) => ({ order: r.order, from_day: r.refund_day, to_day: r.order_day, amount: -r.subtotal })),
    rows: uniq,
    by_refund_day: byRefundDay,
    by_export_rule: byExportRule,
  });
});
