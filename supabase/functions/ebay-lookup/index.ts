import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// SPEEKS CONNECT — SCAN A BARCODE INSTEAD OF A SKU
//
// The upload box says "Scan Or Type a SKU" and means it: a scanner pointed at
// the barcode ON the box produced a string Shopify had never heard of, so the
// item had to be looked up by hand first. This turns those scans into SKUs.
//
// Resolved LIVE against Shopify rather than out of ebay_catalog. The catalogue
// is swept on a schedule, and a barcode is scanned at the moment a unit is
// being listed — often the same hour it was bought in. A cached answer would be
// wrong exactly when it is needed most, and "the scanner does not work on new
// stock" is indistinguishable from "the scanner does not work".
//
// One GraphQL call for the whole batch, not one per code: a shelf of items
// pasted in at once is the normal case, and Shopify's variant query takes an OR.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";

// Same map the catalog sweep keeps: shopify_stores carries the token but its
// store_code column is null, so the code -> domain step lives in the functions.
const SHOPS: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};

// A scan is a barcode, not free text. Anything with a quote or a backslash in it
// would have to be escaped into the query string, and nothing legitimate looks
// like that — so it is dropped rather than escaped.
const SAFE = /^[A-Za-z0-9._/-]{4,64}$/;
const MAX_CODES = 40;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function rest(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  return r.ok ? await r.json() : [];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  try {
    // Same gate as the panel that calls this: a real PIN belonging to a real
    // user. It reads Shopify product data, so it is not open to the world.
    const pin = req.headers.get("x-user-pin") || "";
    if (!pin) return json({ error: "Missing x-user-pin header" }, 401);
    const who = await rest(`users?select=name&pin=eq.${encodeURIComponent(pin)}&limit=1`);
    if (!who.length) return json({ error: "Invalid PIN" }, 401);

    const body = await req.json().catch(() => ({}));
    const store = String(body.store || "").trim().toUpperCase();
    const shop = SHOPS[store];
    if (!shop) return json({ error: `Unknown store ${store}` }, 400);

    const codes: string[] = Array.from(new Set(
      (Array.isArray(body.codes) ? body.codes : [])
        .map((c: unknown) => String(c || "").trim())
        .filter((c: string) => SAFE.test(c)),
    )).slice(0, MAX_CODES);
    if (!codes.length) return json({ ok: true, map: {} });

    const rows = await rest(`shopify_stores?select=shop,access_token&shop=eq.${encodeURIComponent(shop)}&limit=1`);
    const token = rows[0]?.access_token;
    if (!token) return json({ error: `No Shopify credentials for ${store}` }, 500);

    const q = codes.map((c) => `barcode:${c}`).join(" OR ");
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({
        query: `query($q: String!) { productVariants(first: 100, query: $q) { nodes { sku barcode } } }`,
        variables: { q },
      }),
    });
    const out = await res.json();
    if (out.errors) return json({ error: `shopify: ${JSON.stringify(out.errors).slice(0, 300)}` }, 502);

    // Barcode -> SKU, and only where BOTH exist and the barcode is one we asked
    // about. Shopify's search is a search: it can return neighbours, and a
    // neighbour silently becoming the thing you list is the worst outcome here.
    const want = new Map(codes.map((c) => [c.toLowerCase(), c]));
    const map: Record<string, string> = {};
    const ambiguous: string[] = [];
    for (const n of (out.data?.productVariants?.nodes || [])) {
      const bc = String(n.barcode || "").trim();
      const sku = String(n.sku || "").trim();
      if (!bc || !sku) continue;
      const asked = want.get(bc.toLowerCase());
      if (!asked) continue;
      // Two variants sharing a barcode cannot be told apart, and guessing which
      // unit is in someone's hand is exactly how the wrong item gets listed.
      if (map[asked] && map[asked] !== sku) { ambiguous.push(asked); continue; }
      map[asked] = sku;
    }
    for (const a of ambiguous) delete map[a];

    return json({ ok: true, map, ambiguous });
  } catch (err: any) {
    return json({ error: String(err?.message ?? err) }, 500);
  }
});
