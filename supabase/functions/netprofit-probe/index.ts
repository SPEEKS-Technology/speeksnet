// ============================================================================
// netprofit-probe — read-only Shopify passthrough, used to establish what the
// NET PROFIT tab's three new columns (eBay Fee, Shipping Cost, Credit Card Fee)
// can actually be sourced from, per store, on the scopes we hold TODAY.
//
//   ?secret=<sync secret>&store=OVL&ql=<ShopifyQL>    -> shopifyqlQuery
//   ?secret=<sync secret>&store=OVL&gq=<GraphQL>      -> raw Admin API
//
// Same reasoning as shopify-probe: design against what the API answers, not
// what the docs imply. Two findings that cost a round trip each and are worth
// keeping:
//
//   * ShopifyQL's `parseErrors` is a list of STRINGS, not objects. Selecting
//     subfields on it fails the whole query with `selectionMismatch`.
//   * ⚠️ CORRECTED 2026-08-27 — THE BATCH-DIFF TRICK DOES NOT WORK, and this
//     file used to say it did. `parseErrors` carries exactly ONE entry, the
//     FIRST column that could not be resolved:
//         ["Column Not Found: Column 'zzz_bogus_col' not found"]
//     Every name after that failure is simply never reached, so reading
//     "not named in the error" as "valid" mislabels real columns in both
//     directions. Caught by a positive control: `shipping_price` came back
//     "invalid" from a batch sweep, having been queried successfully minutes
//     earlier.
//     ENUMERATE ONE COLUMN PER REQUEST. A column is valid iff parseErrors is
//     EMPTY **and** tableData came back — that pair is also what separates a
//     real answer from a throttled one, which returns neither. Run known-good
//     and known-bad controls in the same pass and void the run if either fails.
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

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);
  const store = (url.searchParams.get("store") || "OVL").toUpperCase().trim();
  const ql = (url.searchParams.get("ql") || "").trim();
  const gq = (url.searchParams.get("gq") || "").trim();

  const r = await fetch(`${SUPABASE_URL}/rest/v1/shopify_stores?select=shop,store_code,access_token,scopes`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const rows = await r.json();
  const t = rows.find((x: any) => x.store_code === store) || rows.find((x: any) => x.shop === SHOP_BY_STORE[store]);
  if (!t) return json({ error: `no shopify_stores row for ${store}` }, 404);

  const gql = async (query: string) => {
    const res = await fetch(`https://${t.shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t.access_token },
      body: JSON.stringify({ query }),
    });
    const body = await res.json().catch(() => ({ parseError: true }));
    return { http: res.status, body };
  };

  if (ql) {
    const { http, body } = await gql(
      `{ shopifyqlQuery(query: ${JSON.stringify(ql)}) { parseErrors tableData { columns { name dataType displayName } rows } } }`);
    return json({ store, ql, http, errors: body.errors ?? null, data: body.data ?? null });
  }
  if (gq) {
    const { http, body } = await gql(gq);
    // `extensions.cost.throttleStatus` is how a throttled sweep is told apart
    // from a sweep that found everything valid.
    return json({ store, http, errors: body.errors ?? null, data: body.data ?? null,
                  extensions: body.extensions ?? null });
  }
  return json({ store, shop: t.shop, apiVersion: API_VERSION, scopes: t.scopes,
                usage: "pass ?ql= for ShopifyQL or ?gq= for GraphQL" });
});
