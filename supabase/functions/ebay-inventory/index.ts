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
// 48 hours, so a late retry would push a stale price over a current one.
async function shopifyVariantsForProduct(
  shop: string, token: string, productId: string,
): Promise<{ sku: string; price: string; quantity: number }[]> {
  const data = await shopifyGql(shop, token, `
    query($id: ID!) {
      product(id: $id) {
        variants(first: 25) { edges { node { sku price inventoryQuantity } } }
      }
    }`,
    { id: `gid://shopify/Product/${productId}` },
  );
  return (data.product?.variants?.edges || [])
    .map((e: any) => e.node)
    .filter((n: any) => n.sku)
    .map((n: any) => ({
      sku: String(n.sku),
      price: String(n.price ?? ""),
      quantity: Math.max(Number(n.inventoryQuantity ?? 0), 0),
    }));
}

async function shopifyVariantForSku(
  shop: string, token: string, sku: string,
): Promise<{ sku: string; price: string; quantity: number } | null> {
  const data = await shopifyGql(shop, token, `
    query($q: String!) {
      productVariants(first: 10, query: $q) { edges { node { sku price inventoryQuantity } } }
    }`,
    { q: `sku:${sku}` },
  );
  // Shopify's sku: filter is a prefix-ish match, so confirm the exact string.
  const node = (data.productVariants?.edges || [])
    .map((e: any) => e.node).find((n: any) => n.sku === sku);
  if (!node) return null;
  return {
    sku,
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

async function reconcile(store: string, sku: string, available: number) {
  const listings = await (await sb(
    `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
    + `&sku=eq.${encodeURIComponent(sku)}&select=*`)).json();
  // Only rows we have actually put on eBay are actionable.
  const listing = (listings || []).find((l: any) =>
    l.ebay_offer_id && (l.status === "published" || l.status === "ended"));
  // Not every Shopify product is on eBay. 202 keeps Shopify from retrying
  // something that will never succeed.
  if (!listing) return { status: 202, body: { skipped: "sku not listed on ebay", sku } };

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
    return { status: 200, body: { ok: true, store, sku, action: "listing ended (sold out)" } };
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
    const stocked = await pushQuantity(api, sku, offerId, available);
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
  const stocked = await pushQuantity(api, sku, offerId, available);
  if (!stocked.ok) {
    console.error("ebay-inventory: quantity push failed", sku, stocked.detail);
    await patchListing(listing.id, { last_error: `quantity push: ${stocked.detail}` });
    // 5xx so Shopify retries a transient eBay problem.
    return { status: 502, body: {
      error: "ebay rejected the quantity update", sku, detail: stocked.detail } };
  }

  await patchListing(listing.id, { last_error: null });
  return { status: 200, body: {
    ok: true, store, sku,
    action: "quantity updated",
    quantity: stocked.quantity,
    listingStatus: stocked.listingStatus,
  } };
}

async function reprice(
  store: string, variants: { sku: string; price: string }[],
) {
  const skus = variants.map(v => v.sku).filter(Boolean);
  if (!skus.length) return { status: 202, body: { skipped: "no skus on this product" } };

  const rows = await (await sb(
    `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
    + `&sku=in.(${skus.map(s => `"${s}"`).join(",")})`
    + `&status=in.(published,ended)&select=*`)).json();
  const listed = (rows || []).filter((r: any) => r.ebay_offer_id);
  // Most product edits are for things we never listed. 202 so Shopify does not
  // retry a webhook that will never have anything to do.
  if (!listed.length) return { status: 202, body: { skipped: "no listed skus on this product", skus } };

  const row = await ebayStore(store);
  const api = ebayClient(HOSTS[row.environment as "production" | "sandbox"],
    await ebayAccessToken(row));

  const results: any[] = [];
  for (const listing of listed) {
    const variant = variants.find(v => v.sku === listing.sku);
    if (!variant?.price) continue;
    const res = await pushPrice(api, listing.sku, listing.ebay_offer_id, variant.price);
    if (!res.ok) {
      console.error("ebay-inventory: price push failed", listing.sku, res.detail);
      await patchListing(listing.id, { last_error: `price push: ${res.detail}` });
    } else if (res.changed) {
      await patchListing(listing.id, { last_error: null });
    }
    results.push({ sku: listing.sku, ...res });
  }

  const failed = results.filter(r => !r.ok);
  return {
    // 5xx so Shopify retries a transient eBay problem rather than dropping the
    // price change on the floor.
    status: failed.length ? 502 : 200,
    body: { ok: !failed.length, store, prices: results },
  };
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
      const variant = await shopifyVariantForSku(shop, token, sku);
      if (!variant) return json({ error: `no Shopify variant with sku ${sku}` }, 404);
      const out = await reconcile(store, sku, variant.quantity);
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

  // --- price edits (products/update) ----------------------------------------
  const topic = (req.headers.get("X-Shopify-Topic") || "").toLowerCase();
  if (topic === "products/update") {
    const { shop: shopDomain2, token: token2 } = await shopFor(store);
    const variants = await shopifyVariantsForProduct(shopDomain2, token2, String(payload.id));
    const out = await reprice(store, variants);
    return json(out.body, out.status);
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

  const out = await reconcile(store, sku, available);
  return json(out.body, out.status);
});
