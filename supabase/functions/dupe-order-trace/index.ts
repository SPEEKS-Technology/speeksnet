// ---------------------------------------------------------------------------
// dupe-order-trace — every Shopify order that carries a given eBay order id,
// with what actually happened to each one.
//
// WHY THIS EXISTS. outreach-list decides "did the buyer receive anything?" by
// finding the SPEEKS Connect copy of an order and reading its fulfilment state.
// That rule is right in the ordinary case — where the new-MC twin is a phantom
// that never shipped — and WRONG whenever the two copies split the work: one
// copy cancelled, the other one shipped. When that happens the buyer has the
// item and outreach-list has quietly written the order off as "never shipped".
//
// BAL 13-15066-46687 is the case that found this: the SPEEKS Connect copy
// (#MO04-2821) is cancelled and unfulfilled, but eBay reports the ORDER as
// FULFILLED and refund_reprobe names a different Shopify order (#MO04-2836).
// Both cannot be true of the same shipment.
//
// READ ONLY. Queries Shopify and returns what it found. Writes nothing, to
// Shopify or to us.
//
//   ?secret=<ops secret>&ebay=13-15066-46687
//   ?secret=<ops secret>&ebay=<id>,<id>,<id>      up to 25 at a time
//   &store=BAL                                     skip the other four shops
// ---------------------------------------------------------------------------

const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";

// shopify_stores.store_code is NULL for every row, so the code cannot be read
// off the token table — the shop domain IS the identity. Same map the other
// functions carry.
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

const MAX_IDS = 25;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 1), {
    status: s,
    headers: { "Content-Type": "application/json" },
  });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

// --- the only door to eBay, and it only opens outward -----------------------
// Same discipline as ebay-refund-reprobe: the URL shape is checked against an
// anchored pattern before anything is sent, because the refund endpoint is a
// SIBLING of these paths (POST .../order/{id}/issue_refund). Two shapes are
// allowed, both GET-only endpoints, both anchored so no extra path segment can
// ride along. The method is hard-coded to GET as a second, independent guard.
const SHIPMENT_URL_RE =
  /^https:\/\/api(?:\.sandbox)?\.ebay\.com\/sell\/fulfillment\/v1\/order\/[^/]+\/shipping_fulfillment(?:\/[^/]+)?$/;

// EBAY_APPS arrives as a hand-pasted JSON secret and has carried literal line
// breaks before now, so it is parsed defensively rather than trusted.
let EBAY_APPS: Record<string, any> = {};
{
  const raw = (Deno.env.get("EBAY_APPS") || "").trim();
  for (const attempt of [raw, raw.replace(/[\r\n\t]/g, "")]) {
    if (!attempt) continue;
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === "object") { EBAY_APPS = parsed; break; }
    } catch { /* try the next form */ }
  }
}

const EBAY_HOSTS: Record<string, string> = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};

// Minted per call, never written back to ebay_stores.
async function mintToken(row: any): Promise<string> {
  const creds = EBAY_APPS[row.store_code];
  if (!creds) throw new Error(`no EBAY_APPS entry for ${row.store_code}`);
  const host = EBAY_HOSTS[row.environment as string] || EBAY_HOSTS.production;
  const res = await fetch(`${host}/identity/v1/oauth2/token`, {
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
  const b = await res.json().catch(() => null);
  if (!res.ok || !b?.access_token) {
    throw new Error(`token ${res.status}: ${JSON.stringify(b).slice(0, 160)}`);
  }
  return b.access_token as string;
}

// Every shipment eBay holds for an order, reduced to the one question that
// matters: is there a tracking number behind it? Returns null when we cannot
// tell — an unknown is reported as an unknown, never as "no".
async function ebayShipmentsFor(eid: string): Promise<any> {
  let stored: any[];
  try {
    stored = await sbGet(
      `refund_reprobe?select=store_code,body&ebay_order_id=eq.${encodeURIComponent(eid)}`
      + `&order=run_at.desc&limit=1`);
  } catch (e) {
    return { checked: false, why: `could not read refund_reprobe: ${String(e).slice(0, 120)}` };
  }
  const row = stored?.[0];
  const hrefs: string[] = row?.body?.fulfillmentHrefs || [];
  if (!row) return { checked: false, why: "no refund_reprobe row for this order" };
  if (!hrefs.length) {
    return { checked: true, shipment_records: 0, tracking: [], note: "eBay holds no shipment record" };
  }

  let ebayRow: any;
  try {
    const rows = await sbGet(
      `ebay_stores?select=store_code,refresh_token,scopes,environment`
      + `&store_code=eq.${encodeURIComponent(row.store_code)}&limit=1`);
    ebayRow = rows?.[0];
  } catch (e) {
    return { checked: false, why: `could not read ebay_stores: ${String(e).slice(0, 120)}` };
  }
  if (!ebayRow) return { checked: false, why: `no ebay_stores row for ${row.store_code}` };

  let token: string;
  try { token = await mintToken(ebayRow); }
  catch (e) { return { checked: false, why: `eBay token: ${String(e).slice(0, 160)}` }; }

  const tracking: any[] = [];
  const problems: string[] = [];
  for (const href of hrefs) {
    if (!SHIPMENT_URL_RE.test(href)) {
      problems.push(`refused: not a read-only eBay shipment URL -> ${href}`);
      continue;
    }
    const res = await fetch(href, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const b = await res.json().catch(() => null);
    if (!res.ok) { problems.push(`${res.status} on ${href.slice(-24)}`); continue; }
    if (b?.shipmentTrackingNumber) {
      tracking.push({
        number: b.shipmentTrackingNumber,
        carrier: b.shippingCarrierCode || null,
        shipped_date: b.shippedDate || null,
      });
    }
  }
  return {
    checked: true,
    store: row.store_code,
    shipment_records: hrefs.length,
    tracking,
    // A shipment eBay recorded with no number behind it is a status flag
    // somebody set, not evidence that a parcel exists.
    note: tracking.length ? undefined
      : "shipment recorded on eBay but with NO tracking number",
    problems: problems.length ? problems : undefined,
  };
}

const ORDER_Q = `query($q: String!) { orders(first: 25, query: $q) { edges { node {
  id name createdAt cancelledAt cancelReason
  displayFulfillmentStatus displayFinancialStatus
  tags sourceIdentifier
  totalPriceSet { shopMoney { amount } }
  app { name }
  customAttributes { key value }
  fulfillments(first: 10) { status createdAt trackingInfo { number company } }
  refunds(first: 10) { createdAt totalRefundedSet { shopMoney { amount } } }
} } } }`;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  // ---- SKU history --------------------------------------------------------
  // "Did the item we saved off the shelf actually get resold?" A recovered item
  // goes back into stock and is relisted, and PayMore SKUs carry a LOCATION
  // suffix that changes when the item moves — so match on the STEM, not the
  // whole SKU, or a resale from a new bin reads as "never resold".
  const skuLike = (url.searchParams.get("skuLike") || "").trim().toUpperCase();
  if (skuLike) {
    const since = (url.searchParams.get("since") || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return json({ error: "skuLike needs since=YYYY-MM-DD" }, 400);
    }
    const wantStore = (url.searchParams.get("store") || "").trim().toUpperCase();
    let shops = (await sbGet(`shopify_stores?select=shop,store_code,access_token`))
      .map((x: any) => ({ ...x, code: x.store_code || STORE_BY_SHOP[x.shop] || x.shop }));
    if (wantStore) shops = shops.filter((x: any) => x.code === wantStore);
    if (!shops.length) return json({ error: `no store matched ${wantStore}` }, 400);

    const SKU_Q = `query($q: String!, $after: String) {
      orders(first: 100, query: $q, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges { node {
          name createdAt displayFinancialStatus
          lineItems(first: 50) { edges { node {
            name quantity sku originalTotalSet { shopMoney { amount } }
          } } }
        } }
      }
    }`;

    const hits: any[] = [];
    for (const st of shops) {
      let after: string | null = null, pages = 0;
      for (;;) {
        const r = await fetch(`https://${st.shop}/admin/api/${API_VERSION}/graphql.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": st.access_token },
          body: JSON.stringify({ query: SKU_Q, variables: { q: `created_at:>=${since}`, after } }),
        });
        const b = await r.json();
        if (b.errors?.length) {
          return json({ error: `${st.code}: ${JSON.stringify(b.errors).slice(0, 200)}` }, 502);
        }
        for (const e of (b.data?.orders?.edges || [])) {
          for (const li of (e.node.lineItems?.edges || [])) {
            const sku = String(li.node.sku || "").toUpperCase();
            if (!sku.startsWith(skuLike)) continue;
            hits.push({
              store: st.code, order: e.node.name, created: e.node.createdAt,
              status: e.node.displayFinancialStatus, sku: li.node.sku,
              item: li.node.name, qty: li.node.quantity,
              amount: Number(li.node.originalTotalSet?.shopMoney?.amount || 0),
            });
          }
        }
        if (!b.data?.orders?.pageInfo?.hasNextPage) break;
        after = b.data.orders.pageInfo.endCursor;
        if (++pages > 40) break;
      }
    }
    hits.sort((a, b) => String(a.created).localeCompare(String(b.created)));
    return json({ readOnly: "Shopify GETs only; nothing written", skuLike, since,
                  matches: hits.length, hits });
  }

  const ids = (url.searchParams.get("ebay") || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return json({ error: "pass ebay=<eBay order id>[,<id>...]" }, 400);
  if (ids.length > MAX_IDS) {
    return json({ error: `at most ${MAX_IDS} ids per call, got ${ids.length}` }, 400);
  }
  const onlyStore = (url.searchParams.get("store") || "").trim().toUpperCase();

  let stores = (await sbGet(`shopify_stores?select=shop,store_code,access_token`))
    .map((s: any) => ({ ...s, code: s.store_code || STORE_BY_SHOP[s.shop] || s.shop }));
  if (onlyStore) stores = stores.filter((s: any) => s.code === onlyStore);
  if (!stores.length) return json({ error: `no store matched ${onlyStore || "(any)"}` }, 400);

  const out: any[] = [];

  for (const eid of ids) {
    const copies: any[] = [];
    const errors: string[] = [];

    for (const t of stores) {
      const res = await fetch(`https://${t.shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": t.access_token,
        },
        body: JSON.stringify({ query: ORDER_Q, variables: { q: eid } }),
      });
      const b = await res.json().catch(() => null);
      if (!b || b.errors?.length) {
        errors.push(`${t.code}: ${JSON.stringify(b?.errors || "no body").slice(0, 160)}`);
        continue;
      }
      // Shopify's search is fuzzy, so confirm the id really is on the order
      // rather than trusting that the query matched something relevant.
      const tagForId = ("ebay-" + eid).toLowerCase();
      for (const e of (b.data.orders.edges || [])) {
        const o = e.node;
        const byAttr = (o.customAttributes || []).some((a: any) =>
          /ebay order id/i.test(String(a.key)) && String(a.value).trim() === eid);
        const bySource = String(o.sourceIdentifier || "").trim() === eid;
        const byTag = (o.tags || []).some((tg: any) =>
          String(tg).trim().toLowerCase() === tagForId);
        if (!byAttr && !bySource && !byTag) continue;

        const shipped = (o.fulfillments || []).some((f: any) => String(f.status) === "SUCCESS")
          || String(o.displayFulfillmentStatus) === "FULFILLED";
        const tracking = (o.fulfillments || []).flatMap((f: any) =>
          (f.trackingInfo || []).map((ti: any) => ti.number).filter(Boolean));

        copies.push({
          store: t.code,
          shopify_order: o.name,
          created_at: o.createdAt,
          created_by_app: o.app?.name || null,
          cancelled_at: o.cancelledAt,
          cancel_reason: o.cancelReason,
          fulfillment: o.displayFulfillmentStatus,
          financial: o.displayFinancialStatus,
          shipped,
          tracking,
          total: Number(o.totalPriceSet?.shopMoney?.amount || 0),
          refunded: (o.refunds || []).reduce((a: number, rf: any) =>
            a + Number(rf.totalRefundedSet?.shopMoney?.amount || 0), 0),
          matched_by: [byAttr && "customAttribute", bySource && "sourceIdentifier",
            byTag && "tag"].filter(Boolean),
        });
      }
    }

    // What outreach-list would conclude, next to what the copies actually show.
    // Printing both is the point: the gap between them IS the bug class.
    const speeks = copies.filter((c) =>
      String(c.created_by_app || "").trim().toUpperCase() === "SPEEKS CONNECT");
    const anyShipped = copies.some((c) => c.shipped);
    const verdict = !copies.length ? "no Shopify copy found"
      : anyShipped ? "SHIPPED — the buyer received the item"
      : "never shipped by any copy";
    const outreachSays = speeks.length !== 1
      ? `unresolved (${speeks.length} SPEEKS Connect copies)`
      : speeks[0].shipped ? "shipped" : "never shipped";
    const disagrees = outreachSays !== "shipped" && anyShipped;

    // --- the contradiction case ---------------------------------------------
    // eBay can report an order FULFILLED while every Shopify copy shows no
    // fulfilment at all. Only one of those can describe a real parcel, and the
    // tie-breaker is whether eBay's shipment record carries a TRACKING NUMBER:
    // a shipment marked without tracking is a status flag, a shipment with a
    // real number means a label was bought and the item left the building.
    // Asked only when it matters, because each one is an eBay round trip.
    let ebayShipments: any = undefined;
    if (!anyShipped) {
      const probe = await ebayShipmentsFor(eid);
      if (probe) ebayShipments = probe;
    }
    const ebayHasTracking = !!ebayShipments?.tracking?.length;

    out.push({
      ebay_order_id: eid,
      copies_found: copies.length,
      verdict: ebayHasTracking && !anyShipped
        ? "CONTRADICTION — no Shopify copy shipped, but eBay holds a tracking number"
        : verdict,
      outreach_list_would_say: outreachSays,
      // The two flags worth grepping for across the whole set.
      MISCLASSIFIED: disagrees || (ebayHasTracking && !anyShipped),
      note: disagrees
        ? "a non-SPEEKS-Connect copy shipped this order — outreach-list excluded a buyer who DID receive the item"
        : (ebayHasTracking && !anyShipped)
        ? "eBay has tracking for a parcel Shopify has no record of — check by hand before writing this buyer off"
        : undefined,
      ebay_shipments: ebayShipments,
      copies,
      errors: errors.length ? errors : undefined,
    });
  }

  return json({
    readOnly: "queried Shopify and eBay with GETs only; nothing written",
    checked: ids.length,
    misclassified: out.filter((o) => o.MISCLASSIFIED).length,
    results: out,
  });
});
