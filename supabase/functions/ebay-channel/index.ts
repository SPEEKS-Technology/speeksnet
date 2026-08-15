// ============================================================================
// ebay-channel — everything the Operations > eBay Channel tab needs, and the
// ONLY eBay endpoint the browser is allowed to talk to.
//
//   GET  ?view=summary                the four headline numbers, per store
//   GET  ?view=needs&store=OVL        in stock, not on eBay, and why
//   GET  ?view=live&store=OVL         what is live, ours and MC's, plus failures
//   GET  ?view=orders&store=OVL       eBay sales and where each one got to
//   GET  ?view=health                 per-store connection state (corp only)
//   POST {action, store, sku}         preview | list | retry | resync | refresh
//
// AUTH IS BY PERSON, NOT BY SECRET. Every other ebay-* function is gated by the
// shared operator secret, which pg_cron can carry and a browser cannot: a
// secret shipped in speeks.js is not a secret. This one takes x-user-pin, looks
// the person up, and decides from their role and store what they may see and
// do — the same split shopify-live documents.
//
// It holds the operator secret itself and calls the other functions with it
// server-side. That is the whole point: the privilege lives here, behind a
// role check, instead of in public JavaScript.
//
// WHY ebay_live EXISTS AND WHY EVERY COVERAGE ANSWER GOES THROUGH IT. We share
// one eBay account per store with Marketplace Connect, and MC lists through the
// Trading API, which the Inventory API cannot see. "Not in ebay_listings"
// therefore does NOT mean "not on eBay" — on OVL, 387 in-stock items are live
// via MC and absent from ebay_listings entirely. Answering the coverage
// question from our own table would offer 387 items for listing that are
// already live, and listing them would put two live listings against one
// physical unit. Coverage is always ebay_catalog minus ebay_live.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Held server-side so the browser never sees it. See the header note.
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const FN_BASE = `${SUPABASE_URL}/functions/v1`;

const STORE_ORDER = ["OVL", "LEE", "WSP", "MPL", "BAL"];
// Corp sees every store and may change setup. Store roles see their own.
const CORP_ROLES = ["district manager", "ceo", "mocd", "tom"];
const STORE_ROLES = ["manager", "owner (manager)", "owner manager", "assistant manager"];
// Mirrors MULTISTORE_MANAGER_STORES in speeks.js. Duplicated deliberately: the
// backend must not take the browser's word for which stores someone manages.
const MULTISTORE_MANAGER_STORES = ["BAL", "MPL"];

// An item can only be listed if eBay would accept it. Both of these are
// refusals from eBay, not preferences of ours: a listing with no picture is
// rejected outright, and one with no price has nothing to sell for.
const MIN_IMAGES = 1;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
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
  if (!res.ok) throw new Error(`supabase ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

const rows = async (path: string) => await (await sb(path)).json();

// POSTGREST CAPS EVERY RESPONSE AT 1000 ROWS AND SAYS NOTHING. `&limit=2000` is
// not an error and not a warning — it just returns 1000 and a Content-Range
// that nobody reads. OVL has 1,378 in-stock SKUs, so the first version of the
// coverage count answered 647 where the truth was 991, and the gap would widen
// with every product the store takes in.
//
// Range-paged, and it keeps going until a short page proves the end. Any table
// that can outgrow a thousand rows has to come through here.
const PAGE_ROWS = 1000;

async function allRows(path: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const res = await sb(path, {
      headers: { "Range-Unit": "items", Range: `${from}-${from + PAGE_ROWS - 1}` },
    });
    const page = await res.json();
    out.push(...page);
    if (page.length < PAGE_ROWS) return out;
    // A table that somehow never returns a short page must not spin forever.
    if (out.length >= 50000) return out;
  }
}

async function countOf(path: string): Promise<number> {
  const res = await sb(path, {
    headers: { Prefer: "count=exact", "Range-Unit": "items", Range: "0-0" },
  });
  return Number((res.headers.get("content-range") || "/0").split("/")[1] || 0);
}

// --- who is asking ----------------------------------------------------------

type Scope = {
  name: string;
  role: string;
  store: string;
  stores: string[];
  corp: boolean;
  canList: boolean;
  canManage: boolean;
};

async function scopeFor(pin: string): Promise<Scope | null> {
  if (!pin) return null;
  const found = await rows(
    `users?pin=eq.${encodeURIComponent(pin)}&select=name,role,store&limit=1`);
  const user = found[0];
  if (!user) return null;

  const role = String(user.role || "").toLowerCase().trim();
  const home = String(user.store || "").toUpperCase().trim();
  const corp = CORP_ROLES.includes(role);

  // A Multi-Store Manager runs two stores and needs both, not just the one
  // their user row happens to name.
  const stores = corp
    ? [...STORE_ORDER]
    : role === "multi-store manager"
      ? [...MULTISTORE_MANAGER_STORES]
      : home && home !== "CORP" ? [home] : [];

  const isStoreLead = STORE_ROLES.includes(role) || role === "multi-store manager";
  if (!corp && !isStoreLead) return null;   // employees and the TV role get nothing

  return {
    name: user.name || "",
    role,
    store: stores[0] || home,
    stores,
    corp,
    // Listing an item is a store job, so store leads do it. It is also the only
    // write here that reaches the outside world.
    canList: corp || isStoreLead,
    // Connecting an account, importing a template, registering webhooks: setup,
    // and setup is corp's.
    canManage: corp,
  };
}

// A store code a caller has no business seeing must never be answerable, and
// the honest answer to "which store?" is theirs, not a 403 the UI has to
// special-case on every call.
function resolveStore(scope: Scope, asked: string | null): string | null {
  const want = (asked || "").toUpperCase().trim();
  if (!want) return scope.stores[0] || null;
  return scope.stores.includes(want) ? want : null;
}

// --- freshness --------------------------------------------------------------

const ageMinutes = (iso: string | null | undefined) =>
  !iso ? null : Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));

// --- views ------------------------------------------------------------------

// The one query the whole panel is built on: in stock on Shopify, absent from
// eBay. Selected here rather than in five places so "listed" can only ever mean
// one thing.
// Both halves of the coverage question come out of the same two reads, so the
// "not listed" count and the "listed but out of stock" count can never be
// computed against different snapshots of the data.
async function coverage(store: string) {
  const catalog = await allRows(
    `ebay_catalog?store_code=eq.${encodeURIComponent(store)}&quantity=gt.0`
    + `&select=sku,title,price,quantity,image_count,product_created_at`
    + `&order=product_created_at.desc.nullslast`);
  const liveRows = await allRows(
    `ebay_live?store_code=eq.${encodeURIComponent(store)}&select=sku,item_id,title`);
  const live = new Set<string>(liveRows.map((r: any) => r.sku));
  const inStock = new Set<string>(catalog.map((c: any) => c.sku));
  // Our own failures carry the reason eBay gave, which is the single most
  // useful thing on the row — without it "this did not list" is unactionable.
  const mine: Record<string, any> = {};
  for (const l of await allRows(
    `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
    + `&select=sku,status,last_error,attempts,last_attempt_at`)) {
    mine[l.sku] = l;
  }

  // Live on eBay, and NOT among the in-stock SKUs Shopify gave us. Somebody
  // can buy it and we may not have it. Reported, never auto-corrected: ending
  // a listing is a decision, and half of these are usually a stock count that
  // needs fixing rather than a listing that needs killing.
  const oversell = liveRows
    .filter((r: any) => !inStock.has(r.sku))
    .map((r: any) => ({ sku: r.sku, title: r.title, itemId: r.item_id }));

  const needs = catalog
    .filter((c: any) => !live.has(c.sku))
    .map((c: any) => {
      const own = mine[c.sku];
      const blocked = !c.image_count || c.image_count < MIN_IMAGES
        ? "No photos on the Shopify product"
        : !(Number(c.price) > 0) ? "No price on the Shopify product"
        : null;
      return {
        sku: c.sku,
        title: c.title,
        price: c.price,
        quantity: c.quantity,
        images: c.image_count,
        since: c.product_created_at,
        // Three states, and the UI colours all three differently: ready to go,
        // blocked on Shopify data, or tried and refused by eBay.
        state: own?.status === "failed" ? "failed" : blocked ? "blocked" : "ready",
        blocked,
        error: own?.status === "failed" ? own.last_error : null,
        attempts: own?.attempts || 0,
        lastAttempt: own?.last_attempt_at || null,
      };
    });

  return { needs, oversell };
}

async function liveView(store: string) {
  const live = await allRows(
    `ebay_live?store_code=eq.${encodeURIComponent(store)}`
    + `&select=sku,item_id,title,quantity,seen_at&order=title.asc`);
  const mine: Record<string, any> = {};
  for (const l of await allRows(
    `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
    + `&select=sku,status,ebay_listing_id,last_error,published_at,price,title`)) {
    mine[l.sku] = l;
  }
  const catalog: Record<string, any> = {};
  for (const c of await allRows(
    `ebay_catalog?store_code=eq.${encodeURIComponent(store)}&select=sku,price,quantity`)) {
    catalog[c.sku] = c;
  }

  return live.map((r: any) => {
    const own = mine[r.sku];
    return {
      sku: r.sku,
      title: r.title || own?.title || catalog[r.sku]?.title || r.sku,
      itemId: r.item_id,
      quantity: r.quantity,
      price: own?.price ?? catalog[r.sku]?.price ?? null,
      // Which system put it there. Until MC is switched off this is the most
      // important column on the row: only "speeks" listings answer to our
      // stock and price sync, and an MC row moving is not ours to explain.
      source: own?.ebay_listing_id ? "speeks" : "mc",
      publishedAt: own?.published_at || null,
      // Shopify says zero, eBay says live. Somebody can buy something we do
      // not have.
      oversell: (catalog[r.sku]?.quantity ?? 0) < 1,
    };
  });
}

async function failedView(store: string) {
  return (await rows(
    `ebay_listings?store_code=eq.${encodeURIComponent(store)}&status=eq.failed`
    + `&select=sku,title,price,last_error,attempts,last_attempt_at,updated_at`
    + `&order=updated_at.desc&limit=200`));
}

async function ordersView(store: string) {
  return await rows(
    `ebay_orders?store_code=eq.${encodeURIComponent(store)}`
    + `&select=ebay_order_id,shopify_order_name,shopify_order_id,buyer_username,total,`
    + `sold_at,tracking_number,tracking_carrier,tracking_pushed_at,status,last_error`
    + `&order=sold_at.desc&limit=100`);
}

async function summaryFor(store: string) {
  const [ebayRow, catalogRun, liveRun] = await Promise.all([
    rows(`ebay_stores?store_code=eq.${encodeURIComponent(store)}`
       + `&select=ebay_user_id,environment,merchant_location_key,payment_policy_id,`
       + `return_policy_id,fulfillment_policy_id,installed_at`),
    rows(`ebay_catalog_runs?store_code=eq.${encodeURIComponent(store)}&select=*`),
    rows(`ebay_live_runs?store_code=eq.${encodeURIComponent(store)}&select=*`),
  ]);
  const st = ebayRow[0] || null;

  const [inStock, liveCount, ours, failed, lastOrder] = await Promise.all([
    countOf(`ebay_catalog?store_code=eq.${encodeURIComponent(store)}&quantity=gt.0&select=sku`),
    countOf(`ebay_live?store_code=eq.${encodeURIComponent(store)}&select=sku`),
    countOf(`ebay_listings?store_code=eq.${encodeURIComponent(store)}&status=eq.published&select=sku`),
    countOf(`ebay_listings?store_code=eq.${encodeURIComponent(store)}&status=eq.failed&select=sku`),
    rows(`ebay_orders?store_code=eq.${encodeURIComponent(store)}&select=sold_at&order=sold_at.desc&limit=1`),
  ]);

  // Counted from the same coverage() the table renders, so the headline
  // number and the list underneath can never disagree.
  const cover = st ? await coverage(store) : { needs: [], oversell: [] };
  const needs = cover.needs;

  // Sold this month, in the store's own month rather than UTC's.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(5, 0, 0, 0);   // ~midnight Central
  const sold = await allRows(
    `ebay_orders?store_code=eq.${encodeURIComponent(store)}`
    + `&sold_at=gte.${monthStart.toISOString()}&select=total`);

  return {
    store,
    connected: !!st,
    ebayUserId: st?.ebay_user_id || null,
    environment: st?.environment || null,
    setup: st ? {
      merchantLocation: !!st.merchant_location_key,
      paymentPolicy: !!st.payment_policy_id,
      returnPolicy: !!st.return_policy_id,
      fulfillmentPolicy: !!st.fulfillment_policy_id,
      installedAt: st.installed_at,
    } : null,
    counts: {
      inStock,
      liveOnEbay: liveCount,
      ours,
      mc: Math.max(0, liveCount - ours),
      needsListing: needs.length,
      ready: needs.filter(n => n.state === "ready").length,
      blocked: needs.filter(n => n.state === "blocked").length,
      failed,
      oversell: cover.oversell.length,
      soldThisMonth: sold.length,
      soldThisMonthValue: sold.reduce((a: number, r: any) => a + Number(r.total || 0), 0),
    },
    freshness: {
      catalogMinutes: ageMinutes(catalogRun[0]?.finished_at),
      catalogError: catalogRun[0]?.error || null,
      liveMinutes: ageMinutes(liveRun[0]?.finished_at),
      liveError: liveRun[0]?.error || null,
      lastOrderAt: lastOrder[0]?.sold_at || null,
    },
  };
}

// --- actions ----------------------------------------------------------------

// Every action is a call to a function that already exists, made with the
// operator secret this one holds. Nothing about eBay is reimplemented here;
// the point is only that a role check stands in front of it.
async function callFn(path: string): Promise<{ status: number; body: any }> {
  const url = `${FN_BASE}/${path}${path.includes("?") ? "&" : "?"}secret=${OPS_SECRET}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${SERVICE_KEY}` } });
  const text = await res.text();
  try { return { status: res.status, body: text ? JSON.parse(text) : null }; }
  catch { return { status: res.status, body: text.slice(0, 800) }; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);
  const pin = req.headers.get("x-user-pin") || "";

  let scope: Scope | null = null;
  try {
    scope = await scopeFor(pin);
  } catch (e) {
    return json({ error: "lookup failed", detail: String((e as Error).message) }, 500);
  }
  // A stale sessionStorage pin outlives a PIN change and lands exactly here.
  // Saying so beats leaving someone staring at an empty panel.
  if (!scope) return json({ error: "unauthorized", detail: "no matching user, or your role has no eBay access" }, 401);

  try {
    if (req.method === "POST") return await handleAction(req, scope);

    const view = url.searchParams.get("view") || "summary";

    if (view === "summary" || view === "health") {
      if (view === "health" && !scope.corp) return json({ error: "forbidden" }, 403);
      const list = view === "health" ? STORE_ORDER : scope.stores;
      const stores = [];
      for (const s of list) stores.push(await summaryFor(s));
      return json({ scope: publicScope(scope), stores });
    }

    const store = resolveStore(scope, url.searchParams.get("store"));
    if (!store) return json({ error: "forbidden", detail: "that store is not yours" }, 403);

    if (view === "needs") {
      const cover = await coverage(store);
      return json({ scope: publicScope(scope), store, items: cover.needs, oversell: cover.oversell });
    }
    if (view === "live")   return json({ scope: publicScope(scope), store, items: await liveView(store), failed: await failedView(store) });
    if (view === "orders") return json({ scope: publicScope(scope), store, orders: await ordersView(store) });

    return json({ error: `unknown view "${view}"` }, 400);
  } catch (e) {
    return json({ error: "failed", detail: String((e as Error)?.message || e).slice(0, 500) }, 500);
  }
});

// The caller is told what it may do, so the UI can hide what would 403 rather
// than offering a button that fails. The role gate above is still the one that
// decides — this is only so the interface can be honest about it.
const publicScope = (s: Scope) => ({
  name: s.name, role: s.role, store: s.store, stores: s.stores,
  corp: s.corp, canList: s.canList, canManage: s.canManage,
});

async function handleAction(req: Request, scope: Scope): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const store = resolveStore(scope, body.store || null);
  const sku = String(body.sku || "").trim();

  if (!store) return json({ error: "forbidden", detail: "that store is not yours" }, 403);

  if (action === "refresh") {
    if (!scope.canList) return json({ error: "forbidden" }, 403);
    // Shopify first: a live sweep is meaningless against a stale catalog.
    const catalog = await callFn(`ebay-catalog?store=${store}&sweep=1`);
    const live = await callFn(`ebay-catalog?store=${store}&live=1`);
    return json({ ok: catalog.status < 300 && live.status < 300, catalog: catalog.body, live: live.body });
  }

  if (!sku) return json({ error: "pass a sku" }, 400);

  if (action === "preview") {
    if (!scope.canList) return json({ error: "forbidden" }, 403);
    const r = await callFn(`ebay-sync?store=${store}&sku=${encodeURIComponent(sku)}&dry=1`);
    return json({ ok: r.status < 300, ...r.body }, r.status < 300 ? 200 : r.status);
  }

  if (action === "list" || action === "retry") {
    if (!scope.canList) return json({ error: "forbidden" }, 403);

    // REFUSE ANYTHING ALREADY LIVE, whoever listed it. ebay-sync cannot make
    // this check — it only knows the Inventory API, which cannot see MC — so it
    // has to happen here, against ebay_live. Publishing over a live MC listing
    // would leave two listings against one unit.
    const already = await rows(
      `ebay_live?store_code=eq.${encodeURIComponent(store)}&sku=eq.${encodeURIComponent(sku)}&select=item_id`);
    const ours = await rows(
      `ebay_listings?store_code=eq.${encodeURIComponent(store)}&sku=eq.${encodeURIComponent(sku)}&select=ebay_listing_id,status`);
    const isOurs = !!ours[0]?.ebay_listing_id;
    if (already.length && !isOurs) {
      return json({
        ok: false,
        error: "already listed on eBay by Marketplace Connect",
        itemId: already[0].item_id,
        detail: "Listing it again would put two live listings against one unit. End the Marketplace Connect listing first.",
      }, 409);
    }

    const r = await callFn(`ebay-sync?store=${store}&sku=${encodeURIComponent(sku)}`);
    await stampAttempt(store, sku, r.status < 300 ? null : errorOf(r.body));
    return json({ ok: r.status < 300, ...r.body }, r.status < 300 ? 200 : r.status);
  }

  if (action === "resync") {
    if (!scope.canList) return json({ error: "forbidden" }, 403);
    const r = await callFn(`ebay-inventory?store=${store}&resync=1&sku=${encodeURIComponent(sku)}`);
    return json({ ok: r.status < 300, ...r.body }, r.status < 300 ? 200 : r.status);
  }

  return json({ error: `unknown action "${action}"` }, 400);
}

const errorOf = (body: any): string =>
  typeof body === "string" ? body.slice(0, 400)
    : body?.error ? String(body.error).slice(0, 400)
    : JSON.stringify(body || {}).slice(0, 400);

// ebay-sync writes status and last_error itself. attempts is ours: it is what
// the auto-lister backs off on, and it has to count manual tries too or a
// person hammering Retry would reset the backoff for the robot.
async function stampAttempt(store: string, sku: string, error: string | null) {
  const existing = await rows(
    `ebay_listings?store_code=eq.${encodeURIComponent(store)}&sku=eq.${encodeURIComponent(sku)}&select=attempts`);
  await sb("ebay_listings?on_conflict=store_code,sku", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      store_code: store, sku,
      attempts: Number(existing[0]?.attempts || 0) + 1,
      last_attempt_at: new Date().toISOString(),
      ...(error ? { status: "failed", last_error: error } : {}),
    }]),
  });
}
