// ============================================================================
// ebay-inventory — keep eBay in step with Shopify stock and price, fast.
//
//   POST /                            Shopify webhook. Two topics, told apart
//                                     by X-Shopify-Topic:
//                                       inventory_levels/update -> quantity
//                                       products/update         -> price
//   GET  ?register=1&store=OVL        subscribe to BOTH topics
//   GET  ?status=1&store=OVL          list the subscriptions Shopify holds
//   GET  ?resync=1&store=OVL&sku=X    force one sku back into step (qty+price)
//   GET  ?end=1&store=OVL&sku=X       take one listing down on purpose, for good
//
// Store is derived from X-Shopify-Shop-Domain, so one callback URL serves every
// store.
//
// THE ZERO CASE IS NOT A QUANTITY UPDATE.
// eBay's bulk_update_price_quantity rejects a quantity of 0 outright
// (errorId 25004, "quantity must be a valid number greater than 0"), so the
// single most important event — the item sold in the store, get it off eBay —
// cannot be expressed as an update. Zero means withdrawOffer, which ends the
// listing. Stock coming back means publishOffer again. For one-of-a-kind used
// goods that is also the honest representation: the item is gone, not
// awaiting restock.
//
// The webhook is a PING, not a payload. Shopify retries a failed delivery with
// the ORIGINAL body for up to 48 hours, so the quantity in the body may be
// hours stale. We re-read the live value instead. This is not theoretical: a
// retry carrying a stale 0 arrived over an hour late during testing and would
// have pulled a correctly-stocked listing down a second time.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";

const HOSTS = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};

const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};
const STORE_BY_SHOP: Record<string, string> = Object.fromEntries(
  Object.entries(SHOP_BY_STORE).map(([code, shop]) => [shop, code]),
);

const stripControl = (s: string) =>
  Array.from(s).filter(ch => ch.charCodeAt(0) >= 32).join("");

function parseJsonSecret(name: string): Record<string, any> {
  const raw = (Deno.env.get(name) || "").trim();
  if (!raw) return {};
  for (const text of [raw, stripControl(raw)]) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* try the stripped form */ }
  }
  return {};
}

const SHOPIFY_APPS = parseJsonSecret("SHOPIFY_APPS");
const EBAY_APPS = parseJsonSecret("EBAY_APPS");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// --- supabase ---------------------------------------------------------------

async function sb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`supabase ${path}: ${res.status} ${await res.text()}`);
  return res;
}

async function shopFor(store: string): Promise<{ shop: string; token: string }> {
  const rows = await (await sb("shopify_stores?select=shop,store_code,access_token")).json();
  const target = rows.find((r: any) => r.store_code === store)
    || rows.find((r: any) => r.shop === SHOP_BY_STORE[store]);
  if (!target) throw new Error(`no shopify_stores row for ${store}`);
  return { shop: target.shop, token: target.access_token };
}

async function ebayStore(store: string) {
  const rows = await (await sb(
    `ebay_stores?store_code=eq.${encodeURIComponent(store)}&select=*`)).json();
  return rows[0] || null;
}

async function patchListing(id: number, patch: Record<string, unknown>) {
  await sb(`ebay_listings?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

// --- shopify ----------------------------------------------------------------

async function shopifyGql(shop: string, token: string, query: string, variables: unknown = {}) {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`shopify: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data;
}

// products/update carries the variants, but the same ping-not-payload rule
// applies: Shopify retries a failed delivery with the ORIGINAL body for up to
// 48 hours, so a late retry would push a stale price over a current one. The
// product is therefore always re-read live — see shopifyProductContent, which
// returns the variants along with everything else the listing is built from.
type VariantState = { id: string; sku: string; price: string; quantity: number };

async function shopifyVariantForSku(
  shop: string, token: string, sku: string,
): Promise<VariantState | null> {
  const data = await shopifyGql(shop, token, `
    query($q: String!) {
      productVariants(first: 10, query: $q) { edges { node { id sku price inventoryQuantity } } }
    }`,
    { q: `sku:${sku}` },
  );
  // Shopify's sku: filter is a prefix-ish match, so confirm the exact string.
  const node = (data.productVariants?.edges || [])
    .map((e: any) => e.node).find((n: any) => n.sku === sku);
  if (!node) return null;
  return {
    id: String(node.id),
    sku,
    price: String(node.price ?? ""),
    quantity: Math.max(Number(node.inventoryQuantity ?? 0), 0),
  };
}

// --- content sync (title / description / photos / specs) ---------------------
//
// Price and stock have always had instant paths. Everything else a store edits
// in Shopify — the title, the description, the photos, the spec table that
// becomes eBay's item aspects — reached eBay only if somebody remembered to
// re-upload the item by hand. So a corrected title or an added photo silently
// never appeared, and the listing drifted from the product for the rest of its
// life.
//
// products/update already fires for all of those edits and is already
// registered at all five stores; we simply threw the payload away and pushed
// price. This reads the whole product so the change can be DETECTED, and
// re-pushes through ebay-sync so the listing is rebuilt by the one piece of
// code that knows how to build a listing. Duplicating any of that here would
// guarantee the two drift.
const CONTENT_FIELDS = `
  id title descriptionHtml
  metafields(first: 60) { edges { node { namespace key value } } }
  images(first: 24) { edges { node { url } } }
  variants(first: 25) { edges { node { id sku price inventoryQuantity } } }
`;

type ProductContent = {
  title: string;
  descriptionHtml: string;
  imageUrls: string[];
  metafields: Record<string, string>;
  variants: VariantState[];
};

async function shopifyProductContent(
  shop: string, token: string, productId: string,
): Promise<ProductContent | null> {
  const data = await shopifyGql(shop, token, `
    query($id: ID!) { product(id: $id) { ${CONTENT_FIELDS} } }`,
    { id: `gid://shopify/Product/${productId}` },
  );
  const p = data.product;
  if (!p) return null;

  const metafields: Record<string, string> = {};
  for (const e of (p.metafields?.edges || [])) {
    const n = e.node;
    if (!n?.key || n.value == null) continue;
    metafields[`${n.namespace}.${n.key}`] = String(n.value);
  }
  return {
    title: String(p.title ?? ""),
    descriptionHtml: String(p.descriptionHtml ?? ""),
    imageUrls: (p.images?.edges || []).map((e: any) => String(e.node.url)),
    metafields,
    variants: (p.variants?.edges || []).map((e: any) => e.node)
      .filter((n: any) => n.sku)
      .map((n: any) => ({
        id: String(n.id),
        sku: String(n.sku),
        price: String(n.price ?? ""),
        quantity: Math.max(Number(n.inventoryQuantity ?? 0), 0),
      })),
  };
}

// PRICE AND QUANTITY ARE DELIBERATELY NOT IN THE FINGERPRINT. Both already
// reach eBay through their own cheap paths, and including them would turn every
// price edit — the most common edit there is — into a full listing rebuild,
// burning pooled Taxonomy/Metadata quota to change a number two API calls
// already handle. Metafield keys are sorted because object order is not a
// promise, and an unstable hash would re-push the whole estate at random.
async function contentHash(p: ProductContent): Promise<string> {
  const specs = Object.keys(p.metafields).sort().map(k => [k, p.metafields[k]]);
  // JSON rather than joining on a delimiter: a description containing the
  // delimiter could otherwise make two different products hash the same, and
  // JSON keeps the material readable when something has to be debugged.
  const material = JSON.stringify([p.title, p.descriptionHtml, p.imageUrls, specs]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

// The same variant, addressed the way that cannot go stale. ?resync=1&sku= is
// the repair route someone reaches for AFTER a rename has already broken
// something, so it has to accept the sku eBay knows and still find the product
// under whatever Shopify calls it now.
async function shopifyVariantById(
  shop: string, token: string, variantId: string,
): Promise<VariantState | null> {
  const data = await shopifyGql(shop, token, `
    query($id: ID!) {
      node(id: $id) { ... on ProductVariant { id sku price inventoryQuantity } }
    }`,
    { id: variantId },
  );
  const node = data.node;
  if (!node?.id) return null;
  return {
    id: String(node.id),
    sku: String(node.sku ?? ""),
    price: String(node.price ?? ""),
    quantity: Math.max(Number(node.inventoryQuantity ?? 0), 0),
  };
}

// Shopify signs the raw body. Compare in constant time — a fast-exit compare
// leaks enough timing to forge a signature given enough attempts.
async function verifyShopifyHmac(shop: string, raw: string, header: string): Promise<boolean> {
  const secret = SHOPIFY_APPS[shop]?.clientSecret
    || Deno.env.get("SHOPIFY_CLIENT_SECRET")
    || "";
  if (!secret || !header) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

// --- eBay -------------------------------------------------------------------

async function ebayAccessToken(row: any): Promise<string> {
  const expiresAt = row.access_token_expires_at ? Date.parse(row.access_token_expires_at) : 0;
  if (row.access_token && expiresAt - Date.now() > 60000) return row.access_token;

  const creds = EBAY_APPS[row.store_code];
  if (!creds?.clientId || !creds?.clientSecret) {
    throw new Error(`no EBAY_APPS credentials for ${row.store_code}`);
  }
  const res = await fetch(`${HOSTS[row.environment as "production" | "sandbox"]}/identity/v1/oauth2/token`, {
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
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${text}`);
  const tok = JSON.parse(text);
  await sb(`ebay_stores?store_code=eq.${encodeURIComponent(row.store_code)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      access_token: tok.access_token,
      access_token_expires_at: new Date(Date.now() + (tok.expires_in ?? 7200) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  return tok.access_token;
}

function ebayClient(host: string, token: string) {
  return async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${host}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // Both language headers are required on write calls. Sending only
        // Content-Language fails with errorId 25709 "Invalid value for header
        // Accept-Language", which names the header it is missing rather than
        // the one you sent.
        "Accept-Language": "en-US",
        "Content-Language": "en-US",
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  };
}

const errList = (errors: any[]) =>
  (errors || []).map((e: any) => `${e.errorId}: ${e.message}`).join("; ");

const errText = (body: any) =>
  Array.isArray(body?.errors)
    ? errList(body.errors)
    : typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);

// eBay's BULK endpoints answer HTTP 200 while reporting per-item failures
// inside responses[].statusCode. Checking only the outer status marks a failed
// push as successful — which is exactly how a listing sat at quantity 0 while
// this function reported OK. Always unwrap.
function bulkFailure(status: number, body: any): string | null {
  if (status >= 300) return errText(body);
  const bad = (body?.responses || []).find((r: any) => (r.statusCode ?? 200) >= 300);
  if (!bad) return null;
  return `sku ${bad.sku}: ${errList(bad.errors) || `statusCode ${bad.statusCode}`}`;
}

// PUBLISHING IS NOT STOCKING.
// When an item sells, eBay decrements the offer to 0 itself. publishOffer does
// not undo that, so a republished offer goes live at quantity 0: the API calls
// it PUBLISHED, the listing page calls it OUT_OF_STOCK, and no buyer can buy
// it. Quantity is always a second, separate push.
async function pushQuantity(
  api: ReturnType<typeof ebayClient>, sku: string, offerId: string, quantity: number,
): Promise<{ ok: boolean; detail?: string; quantity?: number; listingStatus?: string | null }> {
  const res = await api("/sell/inventory/v1/bulk_update_price_quantity", {
    method: "POST",
    body: JSON.stringify({
      requests: [{
        sku,
        // The offer figure is what buyers see; the ship-to-home figure is what
        // the inventory item holds. Leaving the second one behind makes the
        // next read of the SKU disagree with the live listing.
        shipToLocationAvailability: { quantity },
        offers: [{ offerId, availableQuantity: quantity }],
      }],
    }),
  });

  const failure = bulkFailure(res.status, res.body);
  if (failure) return { ok: false, detail: failure };

  // A 2xx from eBay is not proof of effect — this integration has been bitten
  // by that twice. Read the offer back and believe the offer.
  const check = await api(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`);
  const live = Number(check.body?.availableQuantity ?? -1);
  if (live !== quantity) {
    return { ok: false, detail: `eBay accepted the push but the offer still reads ${live}` };
  }
  return { ok: true, quantity: live, listingStatus: check.body?.listingStatus ?? null };
}

// Shopify is the price of record. A Shopify price edit has to reach eBay on its
// own or the two drift silently, and the first anyone hears of it is a buyer
// paying yesterday's price.
async function pushPrice(
  api: ReturnType<typeof ebayClient>, sku: string, offerId: string, price: string,
): Promise<{ changed: boolean; ok: boolean; from?: string; to?: string; detail?: string }> {
  const before = await api(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`);
  const live = String(before.body?.pricingSummary?.price?.value ?? "");
  // Compare as numbers: eBay answers "34.99" where Shopify may hold "34.990".
  if (live && Number(live) === Number(price)) return { changed: false, ok: true, from: live };

  const res = await api("/sell/inventory/v1/bulk_update_price_quantity", {
    method: "POST",
    body: JSON.stringify({
      requests: [{
        sku,
        offers: [{ offerId, price: { value: String(price), currency: "USD" } }],
      }],
    }),
  });
  const failure = bulkFailure(res.status, res.body);
  if (failure) return { changed: true, ok: false, from: live, to: price, detail: failure };

  const after = await api(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`);
  const now = String(after.body?.pricingSummary?.price?.value ?? "");
  if (Number(now) !== Number(price)) {
    return { changed: true, ok: false, from: live, to: price,
             detail: `eBay accepted the push but the offer still reads ${now}` };
  }
  return { changed: true, ok: true, from: live, to: now };
}

// --- reconcile one sku ------------------------------------------------------
// Shared by the webhook and by ?resync=1, so a hand-run repair takes exactly
// the same path as a live event rather than a second, drifting implementation.

// MATCH ON THE VARIANT ID FIRST, THE SKU ONLY AS A FALLBACK.
//
// The Shopify SKU is an editable field and stores edit it — the location tail
// is rewritten every time a unit changes shelf. eBay's SKU is not editable: it
// is the inventory-item key the listing was published under and it is frozen
// for the life of that listing. So the two drift apart, and matching on the SKU
// alone is how a rename silently unhooks a live listing from its own stock.
//
// This is not hypothetical. MPL MO03-2497A-CB1R1 was renamed to
// MO03-2497A-E10; when that unit then sold through the web store this webhook
// looked up the NEW sku, found no row, returned "sku not listed on ebay", and
// never withdrew the offer. The same physical laptop sold again on eBay for
// $239.99 a few hours later. A rename turned into an oversell.
//
// shopify_variant_id survives any amount of SKU editing, and the inventory
// webhook already has the variant in hand, so it costs nothing to ask.
async function reconcile(
  store: string, sku: string, available: number, variantId: string | null = null,
) {
  let listings: any[] = [];
  if (variantId) {
    listings = await (await sb(
      `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
      + `&shopify_variant_id=eq.${encodeURIComponent(variantId)}&select=*`)).json();
  }
  if (!listings.length) {
    listings = await (await sb(
      `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
      + `&sku=eq.${encodeURIComponent(sku)}&select=*`)).json();
  }
  // Only rows we have actually put on eBay are actionable.
  const listing = (listings || []).find((l: any) =>
    l.ebay_offer_id && (l.status === "published" || l.status === "ended"));
  // Not every Shopify product is on eBay. 202 keeps Shopify from retrying
  // something that will never succeed.
  if (!listing) return { status: 202, body: { skipped: "sku not listed on ebay", sku } };

  // Every call BELOW here talks to eBay, so it must use the SKU eBay knows —
  // listing.sku — never the current Shopify one. After a rename they differ,
  // and sending the new name would address an inventory item that does not
  // exist on eBay.
  const ebaySku = listing.sku;
  const renamed = ebaySku !== sku;
  if (renamed) {
    console.log(`ebay-inventory: ${store} shopify sku ${sku} is ebay sku ${ebaySku} `
      + `(matched on variant ${variantId})`);
  }

  const row = await ebayStore(store);
  const host = HOSTS[row.environment as "production" | "sandbox"];
  const api = ebayClient(host, await ebayAccessToken(row));
  const offerId = listing.ebay_offer_id;

  // ---- sold out: end the listing, do not "update" it to zero ---------------
  if (available === 0) {
    if (listing.status === "ended") {
      return { status: 200, body: { ok: true, store, sku, action: "already ended" } };
    }
    const res = await api(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
      { method: "POST" });
    if (res.status >= 300) {
      const msg = errText(res.body);
      console.error("ebay-inventory: withdraw failed", sku, res.status, msg);
      await patchListing(listing.id, { last_error: `withdraw: ${msg}` });
      return { status: 502, body: { error: "eBay rejected the withdraw", sku, detail: msg } };
    }
    await patchListing(listing.id, { status: "ended", last_error: null });
    return { status: 200, body: {
      ok: true, store, sku, ...(renamed ? { ebaySku } : {}),
      action: "listing ended (sold out)" } };
  }

  // ---- back in stock after ending: republish, then restock -----------------
  if (listing.status === "ended") {
    const res = await api(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
      { method: "POST" });
    if (res.status >= 300) {
      const msg = errText(res.body);
      console.error("ebay-inventory: republish failed", sku, res.status, msg);
      await patchListing(listing.id, { last_error: `republish: ${msg}` });
      return { status: 502, body: { error: "eBay rejected the republish", sku, detail: msg } };
    }
    const stocked = await pushQuantity(api, ebaySku, offerId, available);
    await patchListing(listing.id, {
      status: "published",
      ebay_listing_id: res.body?.listingId ?? listing.ebay_listing_id,
      last_error: stocked.ok ? null : `republish quantity: ${stocked.detail}`,
      published_at: new Date().toISOString(),
    });
    if (!stocked.ok) {
      console.error("ebay-inventory: relisted but still out of stock", sku, stocked.detail);
      return { status: 502, body: {
        error: "relisted, but eBay would not take the quantity — the listing is live at 0",
        store, sku, listingId: res.body?.listingId, detail: stocked.detail,
      } };
    }
    return { status: 200, body: {
      ok: true, store, sku,
      action: "relisted and restocked",
      listingId: res.body?.listingId,
      quantity: stocked.quantity,
      listingStatus: stocked.listingStatus,
    } };
  }

  // ---- ordinary quantity change -------------------------------------------
  const stocked = await pushQuantity(api, ebaySku, offerId, available);
  if (!stocked.ok) {
    console.error("ebay-inventory: quantity push failed", sku, stocked.detail);
    await patchListing(listing.id, { last_error: `quantity push: ${stocked.detail}` });
    // 5xx so Shopify retries a transient eBay problem.
    return { status: 502, body: {
      error: "ebay rejected the quantity update", sku, detail: stocked.detail } };
  }

  await patchListing(listing.id, { last_error: null });
  return { status: 200, body: {
    ok: true, store, sku, ...(renamed ? { ebaySku } : {}),
    action: "quantity updated",
    quantity: stocked.quantity,
    listingStatus: stocked.listingStatus,
  } };
}

async function reprice(
  store: string, variants: { id?: string; sku: string; price: string }[],
) {
  const skus = variants.map(v => v.sku).filter(Boolean);
  const ids = variants.map(v => v.id).filter(Boolean) as string[];
  if (!skus.length) return { status: 202, body: { skipped: "no skus on this product" } };

  // Two queries rather than one `or=`: the variant ids are gids full of slashes
  // and colons, and PostgREST's or= grammar is not the place to find out how it
  // feels about those. Both are indexed lookups on a small table. The ids are
  // percent-encoded inside their quotes for the same reason — a raw gid in a
  // query string is legal but depends on every hop agreeing about it.
  const byVariant = ids.length
    ? await (await sb(
        `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
        + `&shopify_variant_id=in.(${ids.map(i => `"${encodeURIComponent(i)}"`).join(",")})`
        + `&status=in.(published,ended)&select=*`)).json()
    : [];
  const bySku = await (await sb(
    `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
    + `&sku=in.(${skus.map(s => `"${s}"`).join(",")})`
    + `&status=in.(published,ended)&select=*`)).json();
  // A renamed variant matches on the id and not on the sku, and an old row with
  // no variant id recorded matches the other way round. Merge, de-duped by row.
  const merged = new Map<number, any>();
  for (const r of [...(byVariant || []), ...(bySku || [])]) merged.set(r.id, r);
  const listed = [...merged.values()].filter((r: any) => r.ebay_offer_id);
  // Most product edits are for things we never listed. 202 so Shopify does not
  // retry a webhook that will never have anything to do.
  if (!listed.length) return { status: 202, body: { skipped: "no listed skus on this product", skus } };

  const row = await ebayStore(store);
  const api = ebayClient(HOSTS[row.environment as "production" | "sandbox"],
    await ebayAccessToken(row));

  const results: any[] = [];
  for (const listing of listed) {
    // By variant first: after a rename listing.sku is the OLD name and matches
    // no current variant, so a sku-only match would silently skip the price
    // update on exactly the products someone has just been editing.
    const variant = variants.find(v => v.id && v.id === listing.shopify_variant_id)
      || variants.find(v => v.sku === listing.sku);
    if (!variant?.price) continue;
    // pushPrice must address eBay by the sku eBay knows, which is listing.sku.
    const res = await pushPrice(api, listing.sku, listing.ebay_offer_id, variant.price);
    if (!res.ok) {
      console.error("ebay-inventory: price push failed", listing.sku, res.detail);
      await patchListing(listing.id, { last_error: `price push: ${res.detail}` });
    } else if (res.changed) {
      await patchListing(listing.id, { last_error: null });
    }
    results.push({
      sku: listing.sku,
      ...(variant.sku !== listing.sku ? { shopifySku: variant.sku } : {}),
      ...res,
    });
  }

  const failed = results.filter(r => !r.ok);
  return {
    // 5xx so Shopify retries a transient eBay problem rather than dropping the
    // price change on the floor.
    status: failed.length ? 502 : 200,
    body: { ok: !failed.length, store, prices: results },
  };
}

// Rebuilds listings whose Shopify content has changed, by calling ebay-sync —
// the only code that knows how to turn a Shopify product into an eBay listing.
// Re-implementing any of that here (aspect matching, condition mapping, the
// branded template) would guarantee two versions that drift.
async function resyncContent(store: string, product: ProductContent, listed: any[]) {
  const hash = await contentHash(product);
  const results: any[] = [];

  for (const listing of listed) {
    // Only live listings. An 'ended' row is a sold or withdrawn item, and
    // ebay-sync publishes — re-pushing one would put a sold item back on sale.
    if (listing.status !== "published") continue;

    const variant = product.variants.find(v => v.id === listing.shopify_variant_id)
      || product.variants.find(v => v.sku === listing.sku);
    if (!variant) continue;

    // Out of stock is the stock path's business, not ours. Re-pushing here
    // would publish an item at quantity 0 — the dead-listing case ebay-sync now
    // refuses outright.
    if (variant.quantity <= 0) continue;

    if (listing.content_hash === hash) {
      results.push({ sku: listing.sku, changed: false });
      continue;
    }

    // Read Shopify under the name it uses NOW, write eBay under the name eBay
    // was given. Without &ebaySku the re-push of a renamed item would create a
    // second inventory item and duplicate the listing.
    //
    // &category is pinned to what this listing already sits in. ebay-sync would
    // otherwise re-run its market-based recommendation and could silently move
    // a listing somebody had deliberately categorised by hand.
    const qs = new URLSearchParams({
      store,
      sku: variant.sku,
      ebaySku: listing.sku,
      secret: OPS_SECRET,
    });
    if (listing.category_id) qs.set("category", String(listing.category_id));
    if (listing.category_name) qs.set("categoryName", String(listing.category_name));

    let ok = false;
    let detail = "";
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/ebay-sync?${qs}`);
      const body = await res.json().catch(() => null);
      ok = res.ok;
      detail = ok ? "" : String(body?.error || body?.detail || `status ${res.status}`).slice(0, 300);
    } catch (err) {
      detail = String(err).slice(0, 300);
    }

    if (ok) {
      await patchListing(listing.id, { content_hash: hash, last_error: null });
      results.push({ sku: listing.sku, changed: true, resynced: true });
      continue;
    }

    // ⚠️ A FAILED RE-PUSH MUST NOT DEMOTE A LIVE LISTING.
    // ebay-sync records a failure by writing status='failed', which is right
    // when somebody is trying to list something and wrong here: this listing is
    // already live and selling. Worse, ebay-orders' ownership guard only claims
    // orders whose sku sits in ebay_listings at published/ended — so letting a
    // rejected content edit flip the row to 'failed' would stop us importing
    // that item's eBay sale, recreating the exact bug this whole change set was
    // written to fix. Put the status back and keep the error.
    await patchListing(listing.id, { status: listing.status, last_error: `content resync: ${detail}` });
    results.push({ sku: listing.sku, changed: true, resynced: false, error: detail });
  }

  return results;
}

// --- auth --------------------------------------------------------------------
// Machine auth, the same secret and reasoning as shopify-live. verify_jwt has
// to stay OFF here because Shopify webhooks cannot present a Supabase JWT, so
// the operator GET paths carry the check themselves.
//
// Deliberately NOT in speeks.js: a secret shipped in public JavaScript is not a
// secret, so the Operations UI gets an x-user-pin path with a role check.
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";

function opsAuthed(url: URL): boolean {
  const given = url.searchParams.get("secret") || "";
  // Constant time: a fast-exit compare leaks the secret a character at a time.
  if (given.length !== OPS_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) {
    diff |= given.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

// --- handler ----------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // --- registration / status (operator, not Shopify) ------------------------
  if (req.method === "GET") {
    // The POST path below authenticates with Shopify's HMAC. These GET paths
    // had nothing at all, and they can move real stock and price.
    if (!opsAuthed(url)) return json({ error: "unauthorised" }, 401);
    const store = (url.searchParams.get("store") || "").toUpperCase().trim();
    if (!store) return json({ error: "pass ?store=OVL with &register=1 or &status=1" }, 400);

    const { shop, token } = await shopFor(store);
    const callbackUrl = `${SUPABASE_URL}/functions/v1/ebay-inventory`;

    if (url.searchParams.get("status") === "1") {
      const data = await shopifyGql(shop, token, `
        query { webhookSubscriptions(first: 25) { edges { node {
          id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
        } } } }`);
      return json({
        store, shop,
        subscriptions: (data.webhookSubscriptions?.edges || []).map((e: any) => ({
          topic: e.node.topic,
          callbackUrl: e.node.endpoint?.callbackUrl,
        })),
      });
    }

    // Hand-run what the webhooks run — for when a listing and Shopify have
    // drifted apart and you want them back in step now, without waiting for
    // someone to touch the stock count. Quantity AND price, because "resync"
    // should mean the listing matches Shopify, not one field of it.
    if (url.searchParams.get("resync") === "1") {
      const sku = (url.searchParams.get("sku") || "").trim();
      if (!sku) return json({ error: "pass &sku=" }, 400);
      let variant = await shopifyVariantForSku(shop, token, sku);
      // Not in Shopify under that name. Before giving up, try it as an EBAY sku
      // and follow our own listing row to the variant — a renamed product is
      // the single most likely reason someone is running a resync by hand.
      if (!variant) {
        const rows = await (await sb(
          `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
          + `&sku=eq.${encodeURIComponent(sku)}&select=shopify_variant_id&limit=1`)).json();
        const vid = rows[0]?.shopify_variant_id;
        if (vid) variant = await shopifyVariantById(shop, token, vid);
      }
      if (!variant) {
        return json({ error: `no Shopify variant with sku ${sku}, and no listing row `
          + `pointing at one — the product may have been deleted` }, 404);
      }
      const out = await reconcile(store, variant.sku, variant.quantity, variant.id);
      // Price only when the listing is actually live; repricing a withdrawn
      // offer is a call spent on nothing.
      const priced = variant.quantity > 0 && out.status < 300
        ? await reprice(store, [variant])
        : null;
      return json({
        shopifyQuantity: variant.quantity,
        shopifyPrice: variant.price,
        ...out.body,
        ...(priced ? { prices: priced.body.prices } : {}),
      }, out.status);
    }

    // Take a listing down on purpose, and have it STAY down.
    //
    // ?resync=1 asks Shopify what is true and makes eBay agree. This asks for
    // the opposite: end it whatever the stock says. Withdrawing alone would not
    // hold — reconcile() republishes anything sitting at 'ended' as soon as the
    // next inventory_levels/update or products/update webhook arrives for that
    // product, so a Disable button would quietly undo itself within minutes of
    // anyone touching the item in Shopify.
    //
    // Parking the row at 'disabled' is what makes it stick: reconcile() only
    // acts on published/ended, and ebay-catalog's sweep only reconciles
    // published, so neither automatic path can see it. Shopify is untouched —
    // the unit is still for sale in the store, it is only off eBay. Uploading
    // it again through SPEEKS Connect is the way back on, which is the
    // deliberate act it ought to be.
    if (url.searchParams.get("end") === "1") {
      const sku = (url.searchParams.get("sku") || "").trim();
      if (!sku) return json({ error: "pass &sku=" }, 400);

      const listings = await (await sb(
        `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
        + `&sku=eq.${encodeURIComponent(sku)}&select=*`)).json();
      const listing = (listings || []).find((l: any) => l.ebay_offer_id);
      if (!listing) {
        return json({ error: `SPEEKS Connect has no listing for ${sku}` }, 404);
      }
      if (listing.status === "disabled") {
        return json({ ok: true, store, sku, action: "already disabled" });
      }

      // Only a live listing needs withdrawing. One already ended — sold, or
      // pulled on eBay's side — just needs the row moved out of reach of the
      // republish path, and calling withdraw on it would fail for no reason.
      if (listing.status === "published") {
        const row = await ebayStore(store);
        const api = ebayClient(HOSTS[row.environment as "production" | "sandbox"],
                               await ebayAccessToken(row));
        const res = await api(
          `/sell/inventory/v1/offer/${encodeURIComponent(listing.ebay_offer_id)}/withdraw`,
          { method: "POST" });
        if (res.status >= 300) {
          const msg = errText(res.body);
          console.error("ebay-inventory: end failed", sku, res.status, msg);
          await patchListing(listing.id, { last_error: `end: ${msg}` });
          return json({ error: "eBay would not end the listing", sku, detail: msg }, 502);
        }
      }

      await patchListing(listing.id, { status: "disabled", last_error: null });
      return json({ ok: true, store, sku, action: "listing disabled" });
    }

    // Both topics land on this one URL and are told apart by X-Shopify-Topic.
    // Stock moves and price edits are different events on the same product, and
    // registering only one of them is how a listing ends up correct in quantity
    // and wrong in price.
    if (url.searchParams.get("register") === "1") {
      const created: string[] = [];
      const errors: any[] = [];
      for (const topic of ["INVENTORY_LEVELS_UPDATE", "PRODUCTS_UPDATE"]) {
        const data = await shopifyGql(shop, token, `
          mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
            webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
              webhookSubscription { id topic }
              userErrors { field message }
            }
          }`,
          { topic, sub: { callbackUrl, format: "JSON" } },
        );
        const result = data.webhookSubscriptionCreate;
        // "already taken" means the subscription exists — success, not an error.
        const bad = (result?.userErrors || [])
          .filter((e: any) => !/taken|already/i.test(e.message));
        if (bad.length) errors.push({ topic, errors: bad });
        else created.push(result?.webhookSubscription?.topic || `${topic} (already present)`);
      }
      return json({ store, shop, callbackUrl, created, errors },
        errors.length ? 502 : 200);
    }

    return json({ error: "pass &register=1, &status=1 or &resync=1&sku=" }, 400);
  }

  // --- the webhook itself ---------------------------------------------------
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const shop = req.headers.get("X-Shopify-Shop-Domain") || "";
  const hmac = req.headers.get("X-Shopify-Hmac-Sha256") || "";
  const raw = await req.text();

  if (!await verifyShopifyHmac(shop, raw, hmac)) {
    console.error("ebay-inventory: bad HMAC", { shop });
    return json({ error: "bad signature" }, 401);
  }

  const store = STORE_BY_SHOP[shop];
  if (!store) return json({ error: `unmapped shop ${shop}` }, 202);

  const payload = JSON.parse(raw);

  // --- product edits (products/update) --------------------------------------
  // Price inline, everything else in the background. See below for why.
  const topic = (req.headers.get("X-Shopify-Topic") || "").toLowerCase();
  if (topic === "products/update") {
    const { shop: shopDomain2, token: token2 } = await shopFor(store);
    const product = await shopifyProductContent(shopDomain2, token2, String(payload.id));
    if (!product) return json({ skipped: "product not found", productId: payload.id }, 202);

    // Price is two or three eBay calls and it is the edit stores make most
    // often, so it stays on the fast inline path exactly as before.
    const out = await reprice(store, product.variants);

    const ids = product.variants.map(v => v.id);
    const listed = ids.length
      ? await (await sb(
          `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
          + `&shopify_variant_id=in.(${ids.map(i => `"${encodeURIComponent(i)}"`).join(",")})`
          + `&status=eq.published&select=*`)).json()
      : [];

    if (listed.length) {
      // ⚠️ A CONTENT RE-PUSH CANNOT RUN INSIDE THE WEBHOOK RESPONSE.
      // Rebuilding a listing is several eBay calls plus a taxonomy lookup —
      // comfortably past Shopify's ~5s webhook timeout. And a timed-out webhook
      // is not merely slow: Shopify retries the SAME body for up to 48 hours,
      // so every rebuild would be attempted over and over. Answer Shopify now
      // and finish the work after the response.
      const work = resyncContent(store, product, listed)
        .catch(err => console.error("ebay-inventory: content resync failed", store, String(err)));
      // @ts-ignore EdgeRuntime is provided by the Supabase edge runtime.
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(work);
      } else {
        await work;
      }
    }

    return json({ ...out.body, contentSyncQueued: listed.length }, out.status);
  }

  const inventoryItemId = payload.inventory_item_id;

  const { shop: shopDomain, token } = await shopFor(store);
  const data = await shopifyGql(shopDomain, token, `
    query($id: ID!) { inventoryItem(id: $id) { variant { id sku inventoryQuantity } } }`,
    { id: `gid://shopify/InventoryItem/${inventoryItemId}` },
  );
  const variant = data.inventoryItem?.variant;
  const sku = variant?.sku;
  if (!sku) return json({ skipped: "no sku for inventory item", inventoryItemId }, 202);

  // Total across locations: eBay gets one figure regardless of which shelf the
  // item sits on.
  const available = Math.max(Number(variant.inventoryQuantity ?? 0), 0);
  const claimed = Number(payload.available ?? 0);
  if (claimed !== available) {
    console.log(`ebay-inventory: stale webhook for ${sku} claimed ${claimed}, actual ${available}`);
  }

  // variant.id, not just the sku: it is already in hand from the query above,
  // and it is the only half of this pair that a store cannot edit.
  const out = await reconcile(store, sku, available, variant.id || null);
  return json(out.body, out.status);
});
