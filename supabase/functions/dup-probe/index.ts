// ============================================================================
// dup-probe — throwaway measurement for the MC duplicate cleanup.
//
// The one thing that decides the remediation route: does CANCELLING an order
// retroactively remove it from Shopify's `sales` dataset (the dataset the Live
// Dashboard reads), or does only a REFUND move the money — dated to the day the
// refund was issued?
//
// It matters because a refund alone corrects MTD but leaves Aug 16-19 overstated
// and dumps the whole credit on today, which is exactly the negative day the DM
// noticed. Cancelling needs a scope we do not hold yet, so it is worth one
// measurement before asking for it.
//
// Method: take a day that contains an order we cancelled WITHOUT refunding, and
// compare that day's ShopifyQL net_sales against the sum of the day's orders
// taken from the Orders API — once counting cancelled orders, once excluding
// them. Whichever total ShopifyQL agrees with is the answer.
//
//   ?secret=...&store=MPL&day=2026-08-18
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";
const SECRET = "sp33ks-sync-k3y-2026-x9mq";

const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== SECRET) return json({ error: "unauthorised" }, 401);
  const store = (url.searchParams.get("store") || "MPL").toUpperCase();
  const shop = SHOP_BY_STORE[store];
  if (!shop) return json({ error: `unknown store ${store}` }, 400);

  const rows = await (await fetch(`${SUPABASE_URL}/rest/v1/shopify_stores?select=shop,access_token`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })).json();
  const target = rows.find((r: any) => r.shop === shop);
  if (!target) return json({ error: "no store row" }, 404);

  const gql = async (query: string, variables: unknown = {}) => {
    const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": target.access_token },
      body: JSON.stringify({ query, variables }),
    });
    return await r.json();
  };

  // What scopes did Shopify ACTUALLY grant this token? The stored string is what
  // we asked for; this is what we hold.
  const scopeBody = await gql(`{ currentAppInstallation { accessScopes { handle } } }`);
  const scopes = (scopeBody.data?.currentAppInstallation?.accessScopes ?? [])
    .map((s: any) => s.handle).sort();

  const day = url.searchParams.get("day") || "";
  let comparison: unknown = null;

  if (day) {
    // Every order created that calendar day, cancelled ones included.
    const ordersBody = await gql(
      `query($q: String!) {
         orders(first: 250, query: $q, sortKey: CREATED_AT) {
           nodes {
             name createdAt cancelledAt
             currentTotalPriceSet { shopMoney { amount } }
             totalPriceSet { shopMoney { amount } }
             totalRefundedSet { shopMoney { amount } }
             tags
           }
         }
       }`,
      { q: `created_at:>=${day} created_at:<=${day}` },
    );
    const nodes = ordersBody.data?.orders?.nodes ?? [];
    const sum = (f: (o: any) => boolean, pick: (o: any) => number) =>
      r2(nodes.filter(f).reduce((t: number, o: any) => t + pick(o), 0));

    const gross = (o: any) => num(o.totalPriceSet?.shopMoney?.amount);
    const current = (o: any) => num(o.currentTotalPriceSet?.shopMoney?.amount);

    const ql = await gql(
      `{ shopifyqlQuery(query: "FROM sales SHOW net_sales, returns, orders WHERE day = '${day}'") {
           parseErrors tableData { rows } } }`,
    );

    comparison = {
      day,
      ordersOnDay: nodes.length,
      cancelledOnDay: nodes.filter((o: any) => o.cancelledAt).length,
      sumAllGross: sum(() => true, gross),
      sumExcludingCancelled: sum((o: any) => !o.cancelledAt, gross),
      sumAllCurrent: sum(() => true, current),
      cancelledDetail: nodes.filter((o: any) => o.cancelledAt).map((o: any) => ({
        name: o.name, gross: gross(o), current: current(o),
        refunded: num(o.totalRefundedSet?.shopMoney?.amount), cancelledAt: o.cancelledAt,
      })),
      shopifyql: ql.data?.shopifyqlQuery?.tableData?.rows ?? ql.data?.shopifyqlQuery?.parseErrors ?? ql.errors,
    };
  }

  return json({ store, shop, scopes, comparison });
});
