// ============================================================================
// ebay-orders — the return path. Two directions, one function.
//
//   GET  ?store=OVL&poll=1[&days=7]  eBay orders  -> Shopify orders
//   GET  ?store=OVL&poll=1&dry=1     show what would be imported
//   GET  ?store=OVL&poll=1&all=1     ignore the Marketplace Connect guard
//   GET  ?store=OVL&register=1       subscribe to Shopify FULFILLMENTS_CREATE
//   GET  ?store=OVL&status=1         what we have imported so far
//   GET  ?store=OVL&pushTracking=1&ebayOrder=..&tracking=..[&carrier=USPS]
//   POST /                           Shopify fulfilment -> eBay tracking
//
// The eBay account is shared with Marketplace Connect while we migrate, so the
// poll imports ONLY orders for SKUs we published ourselves. See the ownership
// guard below — without it this function double-imports every MC sale.
//
// Why polling rather than eBay notifications: eBay's order notifications need a
// separate subscription stack and signature scheme, and orders are low volume.
// A poll every few minutes is simpler and its failure mode is a short delay
// rather than a silently missed sale.
//
// Money handling worth knowing:
//   - The Shopify order is backdated to eBay's sale time, so revenue lands in
//     the period the sale actually happened rather than when we imported it.
//   - Cost of goods needs no work: the Shopify variant already carries unitCost,
//     so margin reporting works as long as the order references the real variant.
//   - Inventory decrements through Shopify's own behaviour on order creation,
//     which then fires the inventory webhook and zeroes the eBay listing. The
//     two halves close the loop without either knowing about the other.
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

// --- shopify ----------------------------------------------------------------

async function shopifyGql(shop: string, token: string, query: string, variables: unknown = {}) {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`shopify: ${JSON.stringify(body.errors).slice(0, 400)}`);
  return body.data;
}

async function verifyShopifyHmac(shop: string, raw: string, header: string): Promise<boolean> {
  const secret = SHOPIFY_APPS[shop]?.clientSecret || Deno.env.get("SHOPIFY_CLIENT_SECRET") || "";
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
        // Both are required on write calls; sending only one fails with a
        // misleading "Invalid value for header Accept-Language".
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

const errText = (body: any) =>
  Array.isArray(body?.errors)
    ? body.errors.map((e: any) => `${e.errorId}: ${e.message}`).join("; ")
    : typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400);

// --- eBay order -> Shopify order --------------------------------------------

// eBay masks buyer email addresses. Shopify wants something, and inventing a
// plausible-looking personal address would be worse than an obviously
// synthetic one, so the buyer username is used as the local part.
const buyerEmail = (username: string) =>
  `${(username || "ebay-buyer").replace(/[^A-Za-z0-9._-]/g, "")}@ebay.invalid`;

function shippingAddressFrom(order: any) {
  const ship = order.fulfillmentStartInstructions?.[0]
    ?.shippingStep?.shipTo;
  if (!ship) return null;
  const addr = ship.contactAddress || {};
  const name = (ship.fullName || "").trim();
  const [first, ...rest] = name.split(/\s+/);
  return {
    firstName: first || "eBay",
    lastName: rest.join(" ") || "Buyer",
    address1: addr.addressLine1 || "",
    address2: addr.addressLine2 || null,
    city: addr.city || "",
    provinceCode: addr.stateOrProvince || null,
    zip: addr.postalCode || "",
    countryCode: addr.countryCode || "US",
    phone: ship.primaryPhone?.phoneNumber || null,
  };
}

// Marketplace Connect writes these into the Shopify order's "Additional
// details" panel, and store staff read them there. Matching the labels exactly
// means an order we imported looks identical to one MC imported — no retraining,
// and no ambiguity about which system produced a given order.
function ebayCustomAttributes(o: any, ebayAccount: string | null) {
  const ship = o.fulfillmentStartInstructions?.[0] || {};
  const itemIds = (o.lineItems || [])
    .map((li: any) => li.legacyItemId).filter(Boolean).join(", ");

  const pairs: [string, unknown][] = [
    ["eBay Sales Record Number", o.salesRecordReference],
    ["eBay Order Id", o.orderId],
    ["eBay Earliest Delivery Date", ship.minEstimatedDeliveryDate],
    ["eBay Latest Delivery Date", ship.maxEstimatedDeliveryDate],
    ["eBay Handle By Date", ship.shippingStep?.shipByDate
      ?? o.lineItems?.[0]?.lineItemFulfillmentInstructions?.shipByDate],
    ["eBay Account", ebayAccount],
    ["eBay ItemID", itemIds],
  ];

  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([key, value]) => ({ key, value: String(value) }));
}

// eBay rejects `lineItems: []` on createShippingFulfillment with
// "32200: Invalid line item id: ''". The fulfilment has to name the actual
// line items, so read them off the order first. Sending an empty array looked
// harmless and silently made every tracking push impossible.
// Shopify records a carrier NAME ("United States Postal Service"), eBay wants
// a CODE ("USPS"). Passing the name through gets the fulfilment rejected or
// files it under the wrong carrier, so map the ones PayMore actually uses.
const CARRIER_CODES: [RegExp, string][] = [
  [/usps|united states postal|postal service/i, "USPS"],
  [/fedex|federal express/i, "FEDEX"],
  [/ups|united parcel/i, "UPS"],
  [/dhl/i, "DHL"],
];

function carrierCode(raw: string): string {
  const t = (raw || "").trim();
  for (const [re, code] of CARRIER_CODES) if (re.test(t)) return code;
  return t.toUpperCase() || "USPS";
}

async function pushEbayTracking(
  api: (p: string, i?: RequestInit) => Promise<{ status: number; body: any }>,
  ebayOrderId: string, tracking: string, carrier: string,
) {
  const ord = await api(`/sell/fulfillment/v1/order/${encodeURIComponent(ebayOrderId)}`);
  const lineItems = (ord.body?.lineItems || [])
    .map((li: any) => ({ lineItemId: li.lineItemId, quantity: li.quantity ?? 1 }))
    .filter((li: any) => li.lineItemId);
  if (!lineItems.length) {
    return {
      status: 422,
      body: { errors: [{ errorId: 0,
        message: `no line items on eBay order ${ebayOrderId} (order fetch ${ord.status})` }] },
    };
  }
  const res = await api(
    `/sell/fulfillment/v1/order/${encodeURIComponent(ebayOrderId)}/shipping_fulfillment`,
    {
      method: "POST",
      body: JSON.stringify({
        lineItems,
        shippedDate: new Date().toISOString(),
        shippingCarrierCode: carrierCode(carrier),
        trackingNumber: tracking,
      }),
    },
  );
  if (res.status >= 300) return res;

  // 201 CREATED IS NOT PROOF OF A FULFILMENT.
  // On order 13-15030-67463 this call returned 201 with a Location header, and
  // the id in that header came back as "32110: Invalid Shipping Fulfillment Id"
  // — the record never existed, the order stayed NOT_STARTED, and the buyer
  // saw no tracking while our own row said "fulfilled". Read the list back and
  // only believe a fulfilment we can find by tracking number.
  const list = await api(
    `/sell/fulfillment/v1/order/${encodeURIComponent(ebayOrderId)}/shipping_fulfillment`);
  const landed = (list.body?.fulfillments || [])
    .some((f: any) => (f.shipmentTrackingNumber || "") === tracking);
  if (!landed) {
    return {
      status: 502,
      body: { errors: [{ errorId: 0, message:
        `eBay answered ${res.status} but no fulfilment with tracking ${tracking} exists on `
        + `order ${ebayOrderId} (it holds ${(list.body?.fulfillments || []).length})` }] },
    };
  }
  return res;
}

// Reads tracking off a Shopify order. Needed because Shopify is NOT delivering
// FULFILLMENTS_CREATE to us (proven by its absence from function_edge_logs
// while INVENTORY_LEVELS_UPDATE arrives normally) — most likely the app lacks
// the newer fulfillment-order scopes. Reading fulfilments works on the current
// scopes, so the poll sweeps for tracking rather than waiting on a webhook that
// never comes. The webhook path is kept: whichever fires first wins.
async function shopifyOrderTracking(shop: string, token: string, orderId: string) {
  const data = await shopifyGql(shop, token,
    `query($id: ID!) { order(id: $id) { fulfillments(first: 5) {
       trackingInfo { number company } } } }`,
    { id: `gid://shopify/Order/${orderId}` },
  );
  for (const f of (data.order?.fulfillments || [])) {
    for (const t of (f.trackingInfo || [])) {
      if (t?.number) return { number: String(t.number), company: String(t.company || "USPS") };
    }
  }
  return null;
}

async function variantIdForSku(shop: string, token: string, sku: string): Promise<string | null> {
  const data = await shopifyGql(shop, token,
    `query($q: String!) { productVariants(first: 5, query: $q) { edges { node { id sku } } } }`,
    { q: `sku:${sku}` },
  );
  const edges = data.productVariants?.edges || [];
  const exact = edges.filter((e: any) => e.node.sku === sku);
  // Ambiguity here would attach revenue to the wrong product, so refuse rather
  // than pick. This is the order-side twin of the publish collision guard.
  if (exact.length !== 1) return null;
  return exact[0].node.id;
}

// --- auth --------------------------------------------------------------------
// Machine auth, the same secret and reasoning as shopify-live. verify_jwt has
// to stay OFF here because the Shopify webhook and pg_cron cannot present a
// Supabase JWT, so the operator GET paths carry the check themselves.
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

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // ======================= Shopify fulfilment -> eBay ========================
  if (req.method === "POST") {
    const shop = req.headers.get("X-Shopify-Shop-Domain") || "";
    const hmac = req.headers.get("X-Shopify-Hmac-Sha256") || "";
    const raw = await req.text();

    if (!await verifyShopifyHmac(shop, raw, hmac)) {
      console.error("ebay-orders: bad HMAC", { shop });
      return json({ error: "bad signature" }, 401);
    }
    const store = STORE_BY_SHOP[shop];
    if (!store) return json({ error: `unmapped shop ${shop}` }, 202);

    const f = JSON.parse(raw);
    const shopifyOrderId = String(f.order_id ?? "");
    const tracking = f.tracking_number || (f.tracking_numbers || [])[0] || null;
    const carrier = f.tracking_company || null;

    const rows = await (await sb(
      `ebay_orders?store_code=eq.${encodeURIComponent(store)}`
      + `&shopify_order_id=eq.${encodeURIComponent(shopifyOrderId)}&select=*`)).json();
    const link = rows[0];
    // Most Shopify fulfilments are ordinary in-store or web sales with no eBay
    // counterpart. 202 so Shopify does not retry them.
    if (!link) return json({ skipped: "not an eBay order", shopifyOrderId }, 202);
    if (!tracking) return json({ skipped: "fulfilment carries no tracking number" }, 202);

    const row = await ebayStore(store);
    const api = ebayClient(HOSTS[row.environment as "production" | "sandbox"],
      await ebayAccessToken(row));

    const res = await pushEbayTracking(
      api, link.ebay_order_id, tracking, (carrier || "USPS").toUpperCase());

    if (res.status >= 300) {
      await sb(`ebay_orders?id=eq.${link.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          last_error: `tracking push: ${errText(res.body)}`,
          updated_at: new Date().toISOString(),
        }),
      });
      return json({ error: "eBay rejected the tracking push", detail: errText(res.body) }, 502);
    }

    await sb(`ebay_orders?id=eq.${link.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        tracking_number: tracking,
        tracking_carrier: carrier,
        tracking_pushed_at: new Date().toISOString(),
        status: "fulfilled",
        last_error: null,
        updated_at: new Date().toISOString(),
      }),
    });
    return json({ ok: true, ebayOrderId: link.ebay_order_id, tracking });
  }

  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  // The POST path above authenticates with Shopify's HMAC. These GET paths had
  // nothing, and they create real Shopify orders and push tracking to buyers.
  if (!opsAuthed(url)) return json({ error: "unauthorised" }, 401);

  const store = (url.searchParams.get("store") || "").toUpperCase().trim();
  if (!store) return json({ error: "pass ?store=OVL" }, 400);
  const dry = url.searchParams.get("dry") === "1";

  const { shop, token: shopToken } = await shopFor(store);

  // --- register the fulfilment webhook --------------------------------------
  if (url.searchParams.get("register") === "1") {
    const callbackUrl = `${SUPABASE_URL}/functions/v1/ebay-orders`;
    const data = await shopifyGql(shop, shopToken, `
      mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
          webhookSubscription { id topic }
          userErrors { field message }
        }
      }`,
      { topic: "FULFILLMENTS_CREATE", sub: { callbackUrl, format: "JSON" } },
    );
    const result = data.webhookSubscriptionCreate;
    const errors = (result?.userErrors || []).filter((e: any) => !/taken|already/i.test(e.message));
    return json({
      store, callbackUrl,
      created: result?.webhookSubscription?.topic || null,
      errors,
    }, errors.length ? 502 : 200);
  }

  // --- what have we imported ------------------------------------------------
  if (url.searchParams.get("status") === "1") {
    const rows = await (await sb(
      `ebay_orders?store_code=eq.${encodeURIComponent(store)}`
      + `&select=ebay_order_id,shopify_order_name,total,sold_at,status,tracking_number,last_error`
      + `&order=sold_at.desc&limit=25`)).json();
    return json({ store, orders: rows });
  }

  // --- push tracking to eBay by hand ----------------------------------------
  // The normal path is the Shopify FULFILLMENTS_CREATE webhook. This exists for
  // the orders that cannot carry tracking through Shopify at all — notably the
  // first import, created before requiresShipping was set, which Shopify
  // recorded as "Shipping not required". Without this, such an order can never
  // report tracking to eBay and the sale ages into a late shipment.
  if (url.searchParams.get("pushTracking") === "1") {
    const ebayOrderId = (url.searchParams.get("ebayOrder") || "").trim();
    const tracking = (url.searchParams.get("tracking") || "").trim();
    const carrier = (url.searchParams.get("carrier") || "USPS").trim().toUpperCase();
    if (!ebayOrderId || !tracking) {
      return json({ error: "pass &ebayOrder=<id>&tracking=<number>[&carrier=USPS|UPS]" }, 400);
    }
    const row2 = await ebayStore(store);
    if (!row2) return json({ error: `no ebay_stores row for ${store}` }, 404);
    const api2 = ebayClient(HOSTS[row2.environment as "production" | "sandbox"],
      await ebayAccessToken(row2));
    const res2 = await pushEbayTracking(api2, ebayOrderId, tracking, carrier);
    if (res2.status >= 300) {
      return json({ error: "eBay rejected the tracking push", status: res2.status,
                    detail: errText(res2.body) }, 502);
    }
    await sb(`ebay_orders?store_code=eq.${encodeURIComponent(store)}`
      + `&ebay_order_id=eq.${encodeURIComponent(ebayOrderId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        tracking_number: tracking,
        tracking_carrier: carrier,
        tracking_pushed_at: new Date().toISOString(),
        status: "fulfilled",
        last_error: null,
        updated_at: new Date().toISOString(),
      }),
    });
    return json({ ok: true, store, ebayOrderId, tracking, carrier });
  }

  // --- poll eBay ------------------------------------------------------------
  if (url.searchParams.get("poll") !== "1") {
    return json({ error: "pass &poll=1, &register=1 or &status=1" }, 400);
  }

  const row = await ebayStore(store);
  if (!row) return json({ error: `no ebay_stores row for ${store}` }, 404);

  const days = Math.min(Number(url.searchParams.get("days") || 7), 30);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const api = ebayClient(HOSTS[row.environment as "production" | "sandbox"],
    await ebayAccessToken(row));

  // Deliberately NO server-side filter. eBay's filter syntax is fussy about
  // encoding and a malformed one returns 200 with zero orders — identical to
  // "you made no sales". Silently missing real orders is far worse than
  // fetching a few extra, so the window is applied here instead.
  //
  // There was a &simulate=1 mode here that fabricated an eBay-shaped order to
  // exercise this path while the sandbox would not surface real ones. It
  // created a REAL Shopify order and was reachable in production, so it came
  // out once real orders proved the path.
  const ordersRes = await api(`/sell/fulfillment/v1/order?limit=100`);
  if (ordersRes.status >= 300) {
    return json({ error: "eBay order fetch failed", detail: errText(ordersRes.body) }, 502);
  }
  const allOrders: any[] = ordersRes.body?.orders || [];
  const cutoff = Date.parse(since);
  const orders = allOrders.filter((o: any) => {
    const t = Date.parse(o.creationDate || "");
    return Number.isNaN(t) ? true : t >= cutoff;
  });
  // ------------------------------------------------------------------------
  // Ownership guard. The eBay account is SHARED with Marketplace Connect, which
  // has its own listings and imports its own orders into Shopify already. An
  // unfiltered poll would re-import every MC sale as a duplicate Shopify order,
  // decrementing stock a second time and double-counting revenue — 64 of them
  // in a single 7-day window when this was first measured.
  //
  // So: only orders whose line items are SKUs WE published are ours to import.
  // ebay_listings is that record. &all=1 overrides, for the day MC is gone.
  //
  // Only PUBLISHED (or since-ended) listings count. A row whose publish failed
  // means the opposite of ownership: the SKU is not live under our offer, and MC
  // may well be listing it, so importing its sale would be the duplicate we are
  // trying to avoid.
  const ownedRows = await (await sb(
    `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
    + `&status=in.(published,ended)&select=sku`)).json();
  const owned = new Set(ownedRows.map((r: any) => r.sku));
  const importAll = url.searchParams.get("all") === "1";
  const isOurs = (o: any) =>
    importAll || (o.lineItems || []).some((li: any) => owned.has(li.sku));

  // Only a successful import blocks a retry. A "failed" or "skipped" row is a
  // record that we tried, NOT a record that the sale reached Shopify — and since
  // both write an ebay_orders row, treating any row as done would strand a real
  // eBay sale forever while every later poll reported it as already imported.
  const seen = await (await sb(
    `ebay_orders?store_code=eq.${encodeURIComponent(store)}&select=ebay_order_id,status`)).json();
  // "fulfilled" is "imported, and then shipped" — just as done. Leaving it out
  // would let the next poll create a SECOND Shopify order for a sale we have
  // already shipped, which is the exact duplicate this guard exists to prevent.
  const DONE = new Set(["imported", "fulfilled"]);
  const known = new Set(
    seen.filter((r: any) => DONE.has(r.status)).map((r: any) => r.ebay_order_id));
  const retrying = new Set(
    seen.filter((r: any) => !DONE.has(r.status)).map((r: any) => r.ebay_order_id));

  const report: any[] = [];
  let notOurs = 0;
  const notOursDetail: any[] = [];

  for (const o of orders) {
    const ebayOrderId = o.orderId;
    if (known.has(ebayOrderId)) {
      report.push({ ebayOrderId, action: "already imported" });
      continue;
    }
    // Deliberately writes no ebay_orders row: this order is not ours to track,
    // and staying silent keeps it importable if we later take over the SKU.
    if (!isOurs(o)) {
      notOurs++;
      // On a dry run, say WHICH skus were rejected. "skipped 7" with no detail
      // cannot distinguish "those are all MC's" from "ours is here but its sku
      // did not match", which is the question you actually need answered.
      if (dry) {
        notOursDetail.push({
          ebayOrderId,
          soldAt: o.creationDate,
          total: o.pricingSummary?.total?.value,
          skus: (o.lineItems || []).map((li: any) => li.sku ?? null),
        });
      }
      continue;
    }

    const lines = o.lineItems || [];
    const resolved: any[] = [];
    let unresolved: string | null = null;

    for (const li of lines) {
      const variantId = await variantIdForSku(shop, shopToken, li.sku || "");
      if (!variantId) {
        unresolved = li.sku || "(no sku)";
        break;
      }
      resolved.push({
        variantId,
        quantity: li.quantity || 1,
        // Without this Shopify defaults the line to requiresShipping:false, the
        // order shows "Shipping not required", and the fulfil dialog offers no
        // tracking field — which silently breaks the tracking push back to eBay.
        requiresShipping: true,
        priceSet: {
          shopMoney: {
            amount: li.lineItemCost?.value ?? "0.00",
            currencyCode: li.lineItemCost?.currency ?? "USD",
          },
        },
      });
    }

    if (unresolved) {
      // Better to leave it visible and unimported than to attach a real sale to
      // the wrong product.
      report.push({ ebayOrderId, action: "skipped", reason: `sku not uniquely resolvable: ${unresolved}` });
      if (!dry) {
        await sb("ebay_orders?on_conflict=store_code,ebay_order_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify([{
            store_code: store,
            ebay_order_id: ebayOrderId,
            buyer_username: o.buyer?.username || null,
            total: o.pricingSummary?.total?.value ?? null,
            sold_at: o.creationDate || null,
            status: "failed",
            last_error: `sku not uniquely resolvable: ${unresolved}`,
            updated_at: new Date().toISOString(),
          }]),
        });
      }
      continue;
    }

    if (dry) {
      report.push({
        ebayOrderId,
        action: "would import",
        soldAt: o.creationDate,
        total: o.pricingSummary?.total?.value,
        lines: lines.map((li: any) => ({ sku: li.sku, qty: li.quantity })),
      });
      continue;
    }

    const address = shippingAddressFrom(o);
    // ONE UNIMPORTABLE ORDER MUST NOT ABORT THE POLL.
    // orderCreate's *userErrors* were handled below from the start, but a
    // top-level GraphQL error — the ACCESS_DENIED you get without write_orders —
    // throws inside shopifyGql instead, and that throw went straight out of the
    // handler. Consequences, all seen live on LEE: the run 500s, every OTHER
    // order in the same batch is skipped, the tracking sweep at the end never
    // runs, and no ebay_orders row is written, so the failure is invisible in
    // the data and repeats every two minutes forever. Catch it, record it like
    // any other failure, and carry on; retriedPreviousFailures re-attempts it
    // each run, so it self-heals the moment the scope is granted.
    let created: any;
    try {
      created = await shopifyGql(shop, shopToken, `
      mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
        orderCreate(order: $order, options: $options) {
          order { id name }
          userErrors { field message }
        }
      }`,
      {
        // orderCreate defaults inventoryBehaviour to BYPASS, which would create
        // the order while leaving Shopify stock untouched — the item would stay
        // both on the shelf and live on eBay. Decrementing here is what makes
        // the loop close: stock drops, the inventory webhook fires, and the
        // eBay listing is withdrawn without either half knowing about the other.
        options: { inventoryBehaviour: "DECREMENT_OBEYING_POLICY" },
        order: {
          lineItems: resolved,
          // Backdated so the sale lands in the period it happened.
          processedAt: o.creationDate,
          email: buyerEmail(o.buyer?.username),
          tags: ["eBay", `ebay-${ebayOrderId}`],
          // No note: the eBay order id is already in customAttributes, and a
          // note adds a "SPEEKS Connect added a note" line to every timeline.
          customAttributes: ebayCustomAttributes(
            o, EBAY_APPS[store]?.ebayAccount || row.ebay_user_id || null),
          ...(address ? { shippingAddress: address } : {}),
          // A shipping line is what makes the order shippable in Shopify's UI.
          // Free shipping is the real PayMore policy, so the amount is 0 rather
          // than absent; an absent line reads as "no shipping needed".
          ...(address ? {
            shippingLines: [{
              title: "eBay Shipping",
              code: "eBay",
              source: "eBay",
              priceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
            }],
          } : {}),
          financialStatus: "PAID",
          // financialStatus alone only sets a LABEL: the first import showed
          // "Paid" while totalReceived was 0.00 and transactions was empty, so
          // the money never existed as far as reporting was concerned.
          transactions: [{
            kind: "SALE",
            status: "SUCCESS",
            gateway: "eBay",
            processedAt: o.creationDate,
            amountSet: {
              shopMoney: {
                amount: String(o.pricingSummary?.total?.value ?? "0.00"),
                currencyCode: o.pricingSummary?.total?.currency ?? "USD",
              },
            },
          }],
        },
      },
      );
    } catch (err) {
      const raw = String(err instanceof Error ? err.message : err);
      // The scope failure is the one worth naming, because the fix is an app
      // re-install and nothing about the order or the code will ever make it
      // work. Everything else keeps eBay's own words.
      const msg = /write_orders|ACCESS_DENIED/i.test(raw)
        ? `Shopify refused to create the order: this store's app does not have the `
          + `write_orders scope, so eBay sales cannot be written into Shopify. Re-install `
          + `the Shopify app for this store with write_orders. Raw: ${raw.slice(0, 300)}`
        : raw.slice(0, 600);
      report.push({ ebayOrderId, action: "failed", reason: msg });
      await sb("ebay_orders?on_conflict=store_code,ebay_order_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{
          store_code: store,
          ebay_order_id: ebayOrderId,
          buyer_username: o.buyer?.username || null,
          total: o.pricingSummary?.total?.value ?? null,
          sold_at: o.creationDate || null,
          status: "failed",
          last_error: msg,
          updated_at: new Date().toISOString(),
        }]),
      });
      continue;
    }

    const errs = created.orderCreate?.userErrors || [];
    if (errs.length || !created.orderCreate?.order) {
      const msg = errs.map((e: any) => `${(e.field || []).join(".")}: ${e.message}`).join("; ")
        || "orderCreate returned no order";
      report.push({ ebayOrderId, action: "failed", reason: msg });
      await sb("ebay_orders?on_conflict=store_code,ebay_order_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{
          store_code: store,
          ebay_order_id: ebayOrderId,
          buyer_username: o.buyer?.username || null,
          total: o.pricingSummary?.total?.value ?? null,
          sold_at: o.creationDate || null,
          status: "failed",
          last_error: msg,
          updated_at: new Date().toISOString(),
        }]),
      });
      continue;
    }

    const shopifyOrder = created.orderCreate.order;
    await sb("ebay_orders?on_conflict=store_code,ebay_order_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{
        store_code: store,
        ebay_order_id: ebayOrderId,
        shopify_order_id: shopifyOrder.id.split("/").pop(),
        shopify_order_name: shopifyOrder.name,
        buyer_username: o.buyer?.username || null,
        total: o.pricingSummary?.total?.value ?? null,
        currency: o.pricingSummary?.total?.currency ?? "USD",
        sold_at: o.creationDate || null,
        status: "imported",
        last_error: null,
        updated_at: new Date().toISOString(),
      }]),
    });

    report.push({
      ebayOrderId,
      action: "imported",
      shopifyOrder: shopifyOrder.name,
      total: o.pricingSummary?.total?.value,
      soldAt: o.creationDate,
    });
  }

  // --- sweep: imported orders that have since been fulfilled in Shopify -----
  // This is what actually gets tracking to eBay today. Bounded to 20 so one
  // poll cannot run long, and it only looks at OUR orders that still have no
  // tracking recorded.
  const trackingPushed: any[] = [];
  if (!dry) {
    // A failed push is retried, because the failure we actually hit was eBay
    // accepting a fulfilment and then not having it. That self-heals if eBay
    // was merely lagging. Backing off half an hour keeps a permanently broken
    // order from being retried every two minutes forever.
    const retryAfter = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const pending = await (await sb(
      `ebay_orders?store_code=eq.${encodeURIComponent(store)}`
      + `&status=eq.imported&tracking_number=is.null`
      + `&or=(tracking_pushed_at.is.null,tracking_pushed_at.lt."${retryAfter}")`
      + `&shopify_order_id=not.is.null&select=id,ebay_order_id,shopify_order_id&limit=20`)).json();
    for (const p of pending) {
      let info = null;
      try { info = await shopifyOrderTracking(shop, shopToken, p.shopify_order_id); }
      catch { /* a Shopify hiccup should not abort the whole poll */ }
      if (!info) continue;
      const res = await pushEbayTracking(api, p.ebay_order_id, info.number, info.company);
      if (res.status >= 300) {
        await sb(`ebay_orders?id=eq.${p.id}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            last_error: `tracking sweep: ${errText(res.body)}`,
            // Stamps the ATTEMPT, not a success — tracking_number stays null,
            // so the row is still pending and comes round again in 30 minutes.
            tracking_pushed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
        });
        trackingPushed.push({ ebayOrderId: p.ebay_order_id, error: errText(res.body) });
        continue;
      }
      await sb(`ebay_orders?id=eq.${p.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          tracking_number: info.number,
          tracking_carrier: carrierCode(info.company),
          tracking_pushed_at: new Date().toISOString(),
          status: "fulfilled",
          last_error: null,
          updated_at: new Date().toISOString(),
        }),
      });
      trackingPushed.push({ ebayOrderId: p.ebay_order_id, tracking: info.number,
                            carrier: carrierCode(info.company) });
    }
  }

  return json({
    store,
    environment: row.environment,
    dryRun: dry,
    windowDays: days,
    // Both numbers, so "eBay returned nothing" is distinguishable from "we
    // filtered them all out" without reading logs.
    ebayReturnedTotal: allOrders.length,
    ebayOrdersInWindow: orders.length,
    // Orders on this eBay account that belong to Marketplace Connect rather
    // than to us. Expected to be large while both systems share the account.
    skippedNotOurListings: notOurs,
    skippedDetail: dry ? notOursDetail.slice(0, 15) : undefined,
    ourSkus: dry ? [...owned] : undefined,
    skusWePublished: owned.size,
    // Orders in this window that had previously failed or been skipped and were
    // therefore attempted again. A number that stays non-zero poll after poll is
    // a sale stuck outside Shopify, not noise.
    trackingPushed,
    retriedPreviousFailures: orders.filter((o: any) => retrying.has(o.orderId)).length,
    report,
  });
});
