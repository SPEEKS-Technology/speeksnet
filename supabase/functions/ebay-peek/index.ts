// ============================================================================
// ebay-peek — read-only look at what eBay thinks the state of a listing is.
//
//   ?store=OVL&sku=KS01-1539-E10
//
// Diagnostic only. The sandbox storefront and its search index are unreliable,
// so "I cannot find my listing" is usually a question about listing STATUS, not
// about search. This answers it from the API, which is authoritative.
//
// Deliberately constrained to the inventory endpoints rather than proxying an
// arbitrary path — an open GET proxy on a public URL is not something to leave
// lying around.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const HOSTS = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};

const stripControl = (s: string) =>
  Array.from(s).filter(ch => ch.charCodeAt(0) >= 32).join("");

let EBAY_APPS: Record<string, any> = {};
{
  const raw = (Deno.env.get("EBAY_APPS") || "").trim();
  for (const text of [raw, stripControl(raw)]) {
    if (!text) break;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") { EBAY_APPS = parsed; break; }
    } catch { /* try stripped */ }
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status, headers: { "Content-Type": "application/json" },
  });

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

async function accessToken(row: any): Promise<string> {
  const expiresAt = row.access_token_expires_at ? Date.parse(row.access_token_expires_at) : 0;
  if (row.access_token && expiresAt - Date.now() > 60000) return row.access_token;
  const creds = EBAY_APPS[row.store_code];
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
  const tok = JSON.parse(await res.text());
  if (!tok.access_token) throw new Error("token refresh failed");
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

// Machine auth, same secret and reasoning as shopify-live. Read-only, but it
// reads out live listing, order and buyer state — not something to leave open.
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";

function opsAuthed(url: URL): boolean {
  const given = url.searchParams.get("secret") || "";
  if (given.length !== OPS_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) {
    diff |= given.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!opsAuthed(url)) return json({ error: "unauthorised" }, 401);
  const store = (url.searchParams.get("store") || "").toUpperCase().trim();
  const sku = (url.searchParams.get("sku") || "").trim();
  // ?store=OVL&mcTemplate=1 returns the description HTML of a listing that
  // Marketplace Connect created, which is how we recover the PayMore branded
  // template rather than rebuilding it by eye from a screenshot.
  const wantTemplate = url.searchParams.get("mcTemplate") === "1";
  // ?store=OVL&mine=1 lists what is ACTUALLY live on the eBay account, whoever
  // put it there. See the Trading-API note below the handler for why this is
  // the only question worth asking while Marketplace Connect is still running.
  const wantMine = url.searchParams.get("mine") === "1";
  if (!store || (!sku && !wantTemplate && !wantMine && !url.searchParams.get("order"))) {
    return json({ error: "pass ?store=OVL&sku=... , &mcTemplate=1 or &mine=1" }, 400);
  }

  const row = (await (await sb(
    `ebay_stores?store_code=eq.${encodeURIComponent(store)}&select=*`)).json())[0];
  if (!row) return json({ error: `no ebay_stores row for ${store}` }, 404);

  const host = HOSTS[row.environment as "production" | "sandbox"];
  const token = await accessToken(row);
  const get = async (path: string) => {
    const r = await fetch(`${host}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Accept-Language": "en-US",
        "Content-Language": "en-US",
      },
    });
    const t = await r.text();
    try { return { status: r.status, body: t ? JSON.parse(t) : null }; }
    catch { return { status: r.status, body: t }; }
  };

  // --- &mine=1 : every ACTIVE listing on the account, with its SKU ----------
  //
  // THE INVENTORY API CANNOT SEE MARKETPLACE CONNECT. MC (Codisto) lists
  // through the older Trading API, and listings created that way are
  // "unmanaged": GET /sell/inventory/v1/inventory_item/{sku} answers 25710 NOT
  // FOUND for an item that is live and selling on eBay right now. Verified on
  // three in-stock OVL SKUs.
  //
  // That matters more than it sounds. We share ONE eBay account with MC, so
  // "not in ebay_listings" does not mean "not on eBay" — and auto-listing on
  // that assumption would put a second live listing against a single physical
  // unit, which oversells by construction.
  //
  // GetMyeBaySelling is the Trading API call that answers it, and it returns
  // SKU for every active listing regardless of which API created it. The OAuth
  // token goes in X-EBAY-API-IAF-TOKEN rather than Authorization.
  if (wantMine) {
    const page = Number(url.searchParams.get("page") || 1);
    const perPage = Math.min(Number(url.searchParams.get("per") || 200), 200);
    const xml =
      `<?xml version="1.0" encoding="utf-8"?>
       <GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
         <ActiveList>
           <Include>true</Include>
           <Pagination>
             <EntriesPerPage>${perPage}</EntriesPerPage>
             <PageNumber>${page}</PageNumber>
           </Pagination>
         </ActiveList>
       </GetMyeBaySellingRequest>`;
    // NO DetailLevel. "ReturnAll" makes GetMyeBaySelling return every list it
    // has — Active, Scheduled, Sold and Unsold — regardless of the Include
    // flags, and the Pagination under ActiveList then paginates only one of
    // them. That is what made page 1 and page 2 both answer 536 items against a
    // reported total of 413: sold and unsold items were being counted as live.
    const tradingHost = row.environment === "sandbox"
      ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
    const r = await fetch(`${tradingHost}/ws/api.dll`, {
      method: "POST",
      headers: {
        "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
        "X-EBAY-API-IAF-TOKEN": token,
        "Content-Type": "text/xml",
      },
      body: xml,
    });
    const text = await r.text();
    const ack = (text.match(/<Ack>([^<]+)<\/Ack>/) || [])[1] || "unknown";
    // Scope to the ActiveList container before matching anything. Item, and the
    // pagination totals, appear inside several containers in this response, and
    // reading them from the whole document is how sold items get counted as
    // live. Regex rather than an XML parser: one flat repeating shape, three
    // fields, not worth a dependency in an edge function.
    const active = (text.match(/<ActiveList>([\s\S]*?)<\/ActiveList>/) || [])[1] || "";
    const items = [...active.matchAll(/<Item>([\s\S]*?)<\/Item>/g)].map(m => {
      const chunk = m[1];
      const one = (tag: string) =>
        (chunk.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1] || null;
      return { itemId: one("ItemID"), sku: one("SKU"), title: one("Title"), quantity: one("Quantity") };
    });
    return json({
      store, ack, page, perPage,
      totalPages: Number((active.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/) || [])[1] || 0),
      totalEntries: Number((active.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/) || [])[1] || 0),
      returned: items.length,
      withSku: items.filter(i => i.sku).length,
      items: url.searchParams.get("raw") === "1" ? items : items.slice(0, 10),
      errors: ack === "Success" ? null
        : [...text.matchAll(/<LongMessage>([^<]*)<\/LongMessage>/g)].map(e => e[1]),
    }, ack === "Failure" ? 502 : 200);
  }

  // ?store=OVL&order=<ebayOrderId> — what eBay itself holds for an order,
  // including the shipping fulfilments. Seller Hub can lag or cache, so this is
  // the authoritative answer to "did the tracking actually land".
  const orderId = (url.searchParams.get("order") || "").trim();

  // &fulfill=1 repeats the createShippingFulfillment call and returns eBay's
  // RAW status, body and Location header. ebay-orders only reports ok/not-ok,
  // which was not enough when a 2xx came back but no fulfilment appeared.
  if (orderId && url.searchParams.get("fulfill") === "1") {
    const tracking = (url.searchParams.get("tracking") || "").trim();
    const carrier = (url.searchParams.get("carrier") || "USPS").trim().toUpperCase();
    if (!tracking) return json({ error: "pass &tracking=<number>" }, 400);
    const ord = await get(`/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`);
    const lineItems = (ord.body?.lineItems || [])
      .map((li: any) => ({ lineItemId: li.lineItemId, quantity: li.quantity ?? 1 }))
      .filter((li: any) => li.lineItemId);
    const payload = {
      lineItems,
      shippedDate: new Date().toISOString(),
      shippingCarrierCode: carrier,
      trackingNumber: tracking,
    };
    const r = await fetch(
      `${host}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept-Language": "en-US",
          "Content-Language": "en-US",
        },
        body: JSON.stringify(payload),
      },
    );
    const text = await r.text();
    return json({
      store, orderId, sent: payload,
      status: r.status,
      location: r.headers.get("location"),
      contentType: r.headers.get("content-type"),
      bodyLength: text.length,
      body: text.slice(0, 2000),
    });
  }

  if (orderId) {
    const ord = await get(`/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`);
    const ful = await get(
      `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`);
    return json({
      store, orderId,
      orderStatus: ord.status,
      // Payment status matters: eBay will not treat an order as shipped until
      // it is paid, so an unpaid order can accept a fulfilment (201) and still
      // report NOT_STARTED with no fulfilments listed.
      orderPaymentStatus: ord.body?.orderPaymentStatus,
      orderFulfillmentStatus: ord.body?.orderFulfillmentStatus,
      creationDate: ord.body?.creationDate,
      cancelState: ord.body?.cancelStatus?.cancelState,
      total: ord.body?.pricingSummary?.total,
      lineItems: (ord.body?.lineItems || []).map((li: any) => ({
        lineItemId: li.lineItemId, sku: li.sku, quantity: li.quantity,
      })),
      fulfillmentsStatus: ful.status,
      fulfillments: (ful.body?.fulfillments || []).map((f: any) => ({
        fulfillmentId: f.fulfillmentId,
        shippedDate: f.shippedDate,
        carrier: f.shippingCarrierCode,
        tracking: f.shipmentTrackingNumber,
        lineItems: (f.lineItems || []).map((li: any) => li.lineItemId),
      })),
      // Read the fulfilment back at the exact Location eBay handed us, which
      // distinguishes "never created" from "created but not yet listed".
      byId: url.searchParams.get("fid")
        ? await get(`/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment/${encodeURIComponent(url.searchParams.get("fid")!)}`)
        : undefined,
      rawFulfillments: url.searchParams.get("raw") === "1" ? ful.body : undefined,
      rawOrder: url.searchParams.get("raw") === "1" ? ord.body : undefined,
    });
  }

  if (wantTemplate) {
    // Recent orders are the cheapest route to a legacyItemId for a listing we
    // did NOT create: MC lists through the Trading API, so its items never
    // appear in our Inventory API offers.
    const ord = await get(`/sell/fulfillment/v1/order?limit=20`);
    const ids: string[] = [];
    for (const o of (ord.body?.orders || [])) {
      for (const li of (o.lineItems || [])) {
        if (li.legacyItemId && !ids.includes(li.legacyItemId)) ids.push(li.legacyItemId);
      }
    }
    // Orders only yield SOLD items, whose description iframe 410s. Ask Browse
    // for the seller's ACTIVE listings first; fall back to order history.
    let activeIds: string[] = [];
    let searchStatus: number | null = null;
    const sellerName = url.searchParams.get("seller") || row.ebay_user_id || "paymore_overland_park";
    {
      const r = await fetch(
        `${host}/buy/browse/v1/item_summary/search`
        + `?limit=10&filter=sellers:{${encodeURIComponent(sellerName)}}`
        + `&q=${encodeURIComponent(url.searchParams.get("q") || "nintendo")}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
          },
        },
      );
      searchStatus = r.status;
      const t = await r.text();
      try {
        const b = JSON.parse(t);
        activeIds = (b.itemSummaries || [])
          .map((s: any) => String(s.itemId || "").split("|")[1])
          .filter(Boolean);
      } catch { /* leave empty; the order fallback still applies */ }
    }

    const wanted = url.searchParams.get("item") || activeIds[0] || ids[0];
    if (!wanted) {
      return json({ error: "no legacyItemId found in recent orders", orderStatus: ord.status });
    }
    // Browse getItem returns the listing's full description HTML. The old
    // vi.vipr.ebaydesc.com iframe host now 410s for every item, and the www
    // item page is bot-blocked, so this is the only reliable route.
    const itemRes = await fetch(
      `${host}/buy/browse/v1/item/${encodeURIComponent(`v1|${wanted}|0`)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
      },
    );
    const itemText = await itemRes.text();
    let html = "";
    let itemTitle: string | null = null;
    try {
      const b = JSON.parse(itemText);
      html = b.description || "";
      itemTitle = b.title || null;
      if (!html) html = itemText.slice(0, 2000);
    } catch { html = itemText.slice(0, 2000); }
    const descRes = { status: itemRes.status };
    return json({
      store, itemId: wanted,
      seller: sellerName, searchStatus,
      activeItemIds: activeIds.slice(0, 10),
      soldItemIds: ids.slice(0, 10),
      itemTitle, status: descRes.status, chars: html.length,
      html: url.searchParams.get("raw") === "1" ? html : html.slice(0, 20000),
    });
  }

  const offers = await get(
    `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=EBAY_US`);
  const item = await get(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);

  const offer = offers.body?.offers?.[0];
  return json({
    store, sku, environment: row.environment,
    inventoryItem: item.status === 200
      ? { quantity: item.body?.availability?.shipToLocationAvailability?.quantity,
          condition: item.body?.condition,
          title: item.body?.product?.title }
      : { status: item.status, body: item.body },
    offer: offer
      ? {
          offerId: offer.offerId,
          listingId: offer.listing?.listingId,
          // The field that answers "why can I not find it": PUBLISHED,
          // UNPUBLISHED, ENDED or OUT_OF_STOCK.
          status: offer.status,
          listingStatus: offer.listing?.listingStatus,
          availableQuantity: offer.availableQuantity,
          price: offer.pricingSummary?.price,
          categoryId: offer.categoryId,
        }
      : { note: "no offer found for this sku", status: offers.status, body: offers.body },
  });
});
