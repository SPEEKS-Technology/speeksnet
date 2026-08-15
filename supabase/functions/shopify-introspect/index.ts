// ============================================================================
// shopify-introspect — read-only GraphQL schema lookup for one input type.
//
//   ?store=OVL&type=OrderCreateLineItemInput
//   ?store=OVL&order=<shopify order id or name>   inspect a created order
//
// Exists so we stop guessing Admin API field names. Getting orderCreate's
// shape wrong is not a cheap mistake: the failure mode is a REAL order created
// with the wrong shipping/payment state, which is what happened to the first
// eBay import (it came in as "Shipping not required" and could not be shipped).
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";

const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status, headers: { "Content-Type": "application/json" },
  });

async function sb(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`supabase ${path}: ${res.status}`);
  return res;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const store = (url.searchParams.get("store") || "").toUpperCase().trim();
  if (!store) return json({ error: "pass ?store=OVL" }, 400);

  const rows = await (await sb("shopify_stores?select=shop,store_code,access_token")).json();
  const target = rows.find((r: any) => r.store_code === store)
    || rows.find((r: any) => r.shop === SHOP_BY_STORE[store]);
  if (!target) return json({ error: `no shopify_stores row for ${store}` }, 404);

  const gql = async (query: string, variables: unknown = {}) => {
    const r = await fetch(
      `https://${target.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": target.access_token,
        },
        body: JSON.stringify({ query, variables }),
      },
    );
    return await r.json();
  };

  const orderRef = url.searchParams.get("order");
  if (orderRef) {
    // What Shopify actually recorded, so "why can I not ship this" is answered
    // from the order itself rather than from assumptions about the mutation.
    const body = await gql(
      `query($q: String!) {
         orders(first: 1, query: $q) {
           edges { node {
             id name displayFinancialStatus displayFulfillmentStatus
             totalPriceSet { shopMoney { amount currencyCode } }
             totalReceivedSet { shopMoney { amount currencyCode } }
             requiresShipping
             shippingLine { title originalPriceSet { shopMoney { amount } } }
             transactions { id kind status gateway
               amountSet { shopMoney { amount currencyCode } } }
             lineItems(first: 5) { edges { node { id title sku quantity requiresShipping } } }
             fulfillments(first: 5) { id status createdAt trackingInfo { number company url } }
           } }
         }
       }`,
      { q: `name:${orderRef.replace(/^#/, "")}` },
    );
    return json({ store, shop: target.shop, order: body.data?.orders?.edges?.[0]?.node ?? null,
                  errors: body.errors ?? null });
  }

  const typeName = url.searchParams.get("type") || "OrderCreateOrderInput";
  const body = await gql(
    `query($n: String!) {
       __type(name: $n) {
         name kind
         inputFields {
           name
           description
           type { name kind ofType { name kind ofType { name kind } } }
         }
       }
     }`,
    { n: typeName },
  );
  const t = body.data?.__type;
  if (!t) return json({ store, typeName, error: "type not found", errors: body.errors }, 404);

  const flatten = (x: any): string =>
    !x ? "?" : x.kind === "NON_NULL" ? flatten(x.ofType) + "!"
      : x.kind === "LIST" ? "[" + flatten(x.ofType) + "]"
      : x.name || flatten(x.ofType);

  return json({
    store, typeName: t.name,
    fields: (t.inputFields || []).map((f: any) => ({
      name: f.name,
      type: flatten(f.type),
      description: (f.description || "").split("\n")[0].slice(0, 160),
    })),
  });
});
