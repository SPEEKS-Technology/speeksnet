// ============================================================================
// ebay-channel — everything the Operations > SPEEKS Connect tab needs, and the
// ONLY eBay endpoint the browser is allowed to talk to.
//
//   GET  ?view=listings&store=OVL     what SPEEKS Connect has listed, and what failed
//   GET  ?view=health                 per-store: live count, error count (DM/CEO)
//   POST {action, store, sku}         preview | list | retry | end | resync
//
// SPEEKS CONNECT IS ITS OWN CHANNEL. It runs independently of Marketplace
// Connect: a SKU listed here is not listed by MC, and this panel reports on
// OUR listings only. It deliberately does NOT try to answer "what is not on
// eBay yet" across the whole catalog — a store decides what to list by typing
// the SKU, and the panel's job is to say whether it worked.
//
// AUTH IS BY PERSON, NOT BY SECRET. Every other ebay-* function is gated by the
// shared operator secret, which pg_cron can carry and a browser cannot: a
// secret shipped in speeks.js is not a secret. This one takes x-user-pin, looks
// the person up, and decides from their role and store what they may see and
// do — the same split shopify-live documents. It holds the operator secret
// itself and calls the other functions with it server-side, so the privilege
// lives behind a role check instead of in public JavaScript.
//
// WHO GETS WHAT. Listing is open to every role that has a store, because the
// person who photographs and prices an item is the person who should be able to
// put it on eBay, and at four of five stores that is not the manager. The role
// check that remains is about REACH, not permission: an employee's SKU has to
// go to their own store, and the five-store overview is a district view that
// only the DM and the CEO have any use for.
//
// ONE GUARD REMAINS FROM THE MC ERA, AND IT SHOULD. Each store shares one eBay
// account with MC, and MC lists through the Trading API, which the Inventory
// API cannot see — asking /sell/inventory/v1/inventory_item/{sku} about a live
// MC listing returns 25710 NOT FOUND. So ebay-sync cannot tell whether a SKU is
// already live. `ebay_live` (swept from GetMyeBaySelling, which does see
// everything) is checked before any publish. The channels are meant to be
// separate; this is what makes a mistake bounce instead of creating two live
// listings against one physical unit.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Held server-side so the browser never sees it. See the header note.
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const FN_BASE = `${SUPABASE_URL}/functions/v1`;

const STORE_ORDER = ["OVL", "LEE", "WSP", "MPL", "BAL"];
// Corp has no home store of its own, so it gets the picker over all five.
const CORP_ROLES = ["district manager", "ceo", "mocd", "tom"];
// The All Stores overview is narrower than corp on purpose: it is a district
// view of five stores at once, which is a thing to run a district with, not a
// thing to do a job with.
const ALL_STORES_ROLES = ["district manager", "ceo"];
// LISTING IS FOR EVERYONE. Whoever photographs and prices the item is who
// should be able to put it on eBay, and that is usually not the manager. The
// only role held back is the TV board, which has no operator sitting at it and
// no Operations page to reach this from.
const NO_ACCESS_ROLES = ["store"];
// Mirrors MULTISTORE_MANAGER_STORES in speeks.js. Duplicated deliberately: the
// backend must not take the browser's word for which stores someone manages.
const MULTISTORE_MANAGER_STORES = ["BAL", "MPL"];

// shopify_stores.store_code is null on every row, so the mapping lives here the
// same way it lives in ebay-inventory. Used only to build an admin link.
const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};

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
// not an error and not a warning — it returns 1000 and a Content-Range nobody
// reads. That silently under-reported a count here by a third before it was
// found. Any table that can outgrow a thousand rows comes through this.
const PAGE_ROWS = 1000;

async function allRows(path: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const res = await sb(path, {
      headers: { "Range-Unit": "items", Range: `${from}-${from + PAGE_ROWS - 1}` },
    });
    const page = await res.json();
    out.push(...page);
    if (page.length < PAGE_ROWS || out.length >= 50000) return out;
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
  name: string; role: string; store: string; stores: string[];
  corp: boolean; canList: boolean; allStores: boolean;
};

async function scopeFor(pin: string): Promise<Scope | null> {
  if (!pin) return null;
  const found = await rows(`users?pin=eq.${encodeURIComponent(pin)}&select=name,role,store&limit=1`);
  const user = found[0];
  if (!user) return null;

  const role = String(user.role || "").toLowerCase().trim();
  const home = String(user.store || "").toUpperCase().trim();
  if (NO_ACCESS_ROLES.includes(role)) return null;

  const corp = CORP_ROLES.includes(role);

  // A Multi-Store Manager runs two stores and needs both, not just the one
  // their user row happens to name.
  const stores = corp
    ? [...STORE_ORDER]
    : role === "multi-store manager"
      ? [...MULTISTORE_MANAGER_STORES]
      : home && home !== "CORP" ? [home] : [];

  // Somebody with no store and no corp role has nothing to list against. That
  // is a data problem, not a permission one, but it still has no answer here.
  if (!stores.length) return null;

  return {
    name: user.name || "", role, store: stores[0], stores, corp,
    // Every role that gets this far lists. What separates them is how many
    // stores they can point at, not whether they may upload.
    canList: true,
    allStores: ALL_STORES_ROLES.includes(role),
  };
}

// A store code a caller has no business seeing must never be answerable, and
// the honest default is theirs rather than a 403 the UI has to special-case.
function resolveStore(scope: Scope, asked: string | null): string | null {
  const want = (asked || "").toUpperCase().trim();
  if (!want) return scope.stores[0] || null;
  return scope.stores.includes(want) ? want : null;
}

const publicScope = (s: Scope) => ({
  name: s.name, role: s.role, store: s.store, stores: s.stores,
  corp: s.corp, canList: s.canList, allStores: s.allStores,
});

// Shopify ids are stored as GIDs — gid://shopify/Product/8154021462118. The
// admin URL wants the number on the end.
const shopifyUrlFor = (store: string, gid: string | null | undefined) => {
  const id = gid ? String(gid).split("/").pop() : null;
  const shop = SHOP_BY_STORE[store];
  return id && shop ? `https://${shop}/admin/products/${id}` : null;
};

const ebayUrlFor = (itemId: string | null | undefined, environment?: string | null) =>
  !itemId ? null
    : environment === "sandbox"
      ? `https://sandbox.ebay.com/itm/${itemId}`
      : `https://www.ebay.com/itm/${itemId}`;

const ageMinutes = (iso: string | null | undefined) =>
  !iso ? null : Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));

// --- views ------------------------------------------------------------------

// OUR listings only. `ebay_listings` is written solely by ebay-sync, so every
// row here is something SPEEKS Connect tried to publish — which is exactly the
// scope this panel reports on.
const LISTING_COLS = "sku,title,price,quantity,status,ebay_listing_id,shopify_product_id,"
  + "category_id,category_name,last_error,attempts,last_attempt_at,published_at,updated_at";

// --- saying what went wrong, to the person holding the item -----------------
//
// eBay writes its refusals for the developer who made the API call. They arrive
// as a number, a sentence of API vocabulary, and — routinely — eBay's own help
// page pasted in as raw markup, which rendered in the panel as several hundred
// words of <div class="g-rcp-rcp"> nobody could read past. Even the readable
// part says things like "the unpublished offer has invalid item condition
// information", which is true and useless: it does not say what to change or
// where to change it.
//
// So the codes we actually see get turned into a sentence that names the field,
// names the place, and says what to do. Everything else falls back to eBay's
// own words with the markup stripped, which is worse than a translation and far
// better than the wall. The original is always kept as errorRaw — a store needs
// plain English, and whoever they escalate to needs the exact refusal.

const stripMarkup = (s: string) =>
  s.replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

const ERROR_RULES: { test: RegExp; help: (m: RegExpMatchArray) => string }[] = [
  // Not a listing problem at all — the SKU never matched a product. Nearly
  // always a partial SKU: "B2B310" typed where "KS01-B2B310-E11" was meant.
  {
    test: /sku (\S+) not found in/i,
    help: (m) => `Shopify has no product with the SKU ${m[1]}. Check it against the `
      + `product page — a partial SKU will not match, so "${m[1]}" has to be the whole thing.`,
  },
  // An aspect whose value eBay will not take. The advice has to match the
  // field: telling somebody to set a UPC to "the real manufacturer" is worse
  // than saying nothing, and an early version of this rule did exactly that
  // because it was written for Brand and then applied to everything.
  {
    test: /\b(UPC|EAN|GTIN|ISBN)\b has an invalid value of ["“]([^"”]{1,60})["”]/i,
    help: (m) => `The barcode on this product — ${m[1].toUpperCase()} "${m[2]}" — is not a valid `
      + `one; its check digit does not add up, so it is a mis-scan or a typo rather than a real `
      + `${m[1].toUpperCase()}. Fix it on the Shopify product, or clear the field and upload `
      + `again: an item with no barcode lists fine, one with the wrong barcode does not.`,
  },
  {
    test: /\bBrand\b has an invalid value of ["“]([^"”]{1,60})["”]/i,
    help: (m) => `eBay will not accept "${m[1]}" as the Brand in this category — it keeps a fixed `
      + `list of brands and that is not on it. Open the item in Shopify and set Brand to the real `
      + `manufacturer, or to Unbranded if it does not have one.`,
  },
  {
    test: /\b([A-Z][\w \-\/]{1,28}?) has an invalid value of ["“]([^"”]{1,60})["”]/,
    help: (m) => `eBay will not accept "${m[2]}" as the ${m[1]} in this category — it keeps a `
      + `fixed list of ${m[1]} values and that is not on it. Open the item in Shopify and correct `
      + `${m[1]}, then upload again.`,
  },
  // A required aspect missing from the product.
  {
    test: /\b(?:aspect ["“]?)?([A-Z][\w \-\/]{1,28}?)["“]?\s+is missing\b/,
    help: (m) => `eBay requires ${m[1]} for this category and the item does not have it. Add `
      + `${m[1]} to the product's spec table in Shopify and upload again.`,
  },
  // 25019. eBay compares the title against the condition and refuses when they
  // disagree — a "Broken"/"Cracked"/"Bad" title listed as a working condition.
  // Its own explanation is buried in the markup dump, so it is restated here.
  {
    test: /\b25019\b|cannot revise listing|title.{0,80}conflicts with other details|improper words/i,
    help: () => `eBay refused this because the title and the condition disagree. A title saying `
      + `Broken, Cracked, Bad or No Charge has to be listed as "For Parts Or Not Working" — `
      + `eBay will not let an item described as damaged go up under a working condition. `
      + `Either set the item's Condition in Shopify to For Parts Or Not Working, or take the `
      + `damage wording out of the title.`,
  },
  // 25021. The granular used tiers only exist in some categories.
  {
    test: /\b25021\b|condition id is invalid for the selected primary category/i,
    help: () => `eBay does not allow this item's condition in the category it was matched to. `
      + `Most hardware categories accept only a plain "Used" — not Good, Very Good or `
      + `Acceptable. Set the item's Condition in Shopify to Used or Excellent and upload again. `
      + `If the category itself looks wrong, that is the thing to fix first.`,
  },
  // No photos. eBay will not publish a listing without at least one.
  {
    test: /\b25004\b.{0,80}(picture|image)|at least one picture|no images/i,
    help: () => `eBay will not publish a listing with no photos. Add at least one image to the `
      + `product in Shopify and upload again.`,
  },
  // Policies not set up for the store. An operator problem, not a store one.
  {
    test: /(payment|return|fulfillment|shipping) polic/i,
    help: () => `This store's eBay account is missing one of its policies (payment, returns or `
      + `postage), so nothing can publish until it is set up. This is an account setting, not `
      + `something wrong with the item — send it on rather than retrying.`,
  },
];

// eBay repeats itself: the readable sentence, then the same thing again inside
// a bracketed array of raw help markup. Cut at the bracket before translating.
function humanError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const flat = stripMarkup(String(raw));
  const head = flat.split(/\s*\[0=/)[0].trim() || flat;

  for (const rule of ERROR_RULES) {
    const m = head.match(rule.test) || flat.match(rule.test);
    if (m) return rule.help(m);
  }
  // Nothing matched. Give back eBay's own leading sentence rather than a guess,
  // capped so an untranslated refusal can never become a wall again.
  return head.length > 300 ? head.slice(0, 300).replace(/\s+\S*$/, "") + "…" : head;
}

// STATE COMES FROM OUR OWN COLUMN, NOT FROM THE SWEEP. See the long note in
// listingsFor(). Four states, and they are all the panel needs to show:
//   live      published, and eBay still has it
//   ended     published, but no longer live — it sold, or someone ended it
//   disabled  somebody took it down on purpose; nothing automatic will undo it
//   failed    eBay refused, and last_error says why
function mapListing(store: string, l: any) {
  return {
    sku: l.sku,
    title: l.title || l.sku,
    price: l.price,
    quantity: l.quantity,
    itemId: l.ebay_listing_id,
    state: l.status === "failed" ? "failed"
         : l.status === "disabled" ? "disabled"
         : l.status === "published" ? "live"
         : l.ebay_listing_id ? "ended" : "failed",
    // Plain English for the person holding the item; eBay's exact words kept
    // alongside it for whoever they escalate to.
    error: humanError(l.last_error),
    errorRaw: l.last_error ? stripMarkup(l.last_error).slice(0, 1200) : null,
    category: l.category_name || null,
    categoryId: l.category_id || null,
    attempts: l.attempts || 0,
    lastAttempt: l.last_attempt_at || null,
    publishedAt: l.published_at || null,
    updatedAt: l.updated_at || null,
    // Both halves of the item, one click each. The eBay link only exists once
    // there is a listing id; the Shopify link exists as soon as we know the
    // product, which includes every failure — and a failure is precisely when
    // somebody needs to open the product and fix what eBay complained about.
    ebayUrl: ebayUrlFor(l.ebay_listing_id),
    shopifyUrl: shopifyUrlFor(store, l.shopify_product_id),
  };
}

async function itemFor(store: string, sku: string) {
  const found = await rows(
    `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
    + `&sku=eq.${encodeURIComponent(sku)}&select=${LISTING_COLS}&limit=1`);
  return found[0] ? mapListing(store, found[0]) : null;
}

async function listingsFor(store: string) {
  const mine = await allRows(
    `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
    + `&select=${LISTING_COLS}&order=updated_at.desc`);

  // STATE COMES FROM OUR OWN COLUMN, NOT FROM THE SWEEP. The first version of
  // this joined ebay_live and called anything present there "live", which reads
  // as the more trustworthy source right up until you notice the sweep is a
  // snapshot up to twenty minutes old while ebay_listings.status is written by
  // ebay-sync and ebay-inventory at the moment of each event.
  //
  // It showed up immediately: a GPU sold out, was ended, and was republished by
  // the restock path within the same sweep window. Our column tracked all three
  // steps; the sweep still held the pre-sale snapshot and called it live under
  // a listing id that no longer existed.
  //
  // The sweep's job is the other direction — catching a listing that ended on
  // eBay's side without telling us — and that reconciliation belongs in
  // ebay-catalog, where it can compare against a COMPLETE sweep, rather than
  // being guessed at per page load.
  return mine.map((l: any) => mapListing(store, l));
}

async function summaryFor(store: string) {
  const [ebayRow, liveRun] = await Promise.all([
    rows(`ebay_stores?store_code=eq.${encodeURIComponent(store)}`
       + `&select=ebay_user_id,environment,merchant_location_key,payment_policy_id,`
       + `return_policy_id,fulfillment_policy_id,installed_at`),
    rows(`ebay_live_runs?store_code=eq.${encodeURIComponent(store)}&select=*`),
  ]);
  const st = ebayRow[0] || null;
  if (!st) {
    return { store, connected: false,
             counts: { live: 0, ended: 0, disabled: 0, failed: 0, total: 0 },
             setup: null, freshness: { liveMinutes: null, liveError: null } };
  }

  const items = await listingsFor(store);
  const failed = await countOf(
    `ebay_listings?store_code=eq.${encodeURIComponent(store)}&status=eq.failed&select=sku`);

  return {
    store,
    connected: true,
    ebayUserId: st.ebay_user_id || null,
    environment: st.environment || null,
    setup: {
      merchantLocation: !!st.merchant_location_key,
      paymentPolicy: !!st.payment_policy_id,
      returnPolicy: !!st.return_policy_id,
      fulfillmentPolicy: !!st.fulfillment_policy_id,
      installedAt: st.installed_at,
    },
    counts: {
      live: items.filter(i => i.state === "live").length,
      ended: items.filter(i => i.state === "ended").length,
      disabled: items.filter(i => i.state === "disabled").length,
      // Counted from the table AND from the column, which must agree. They can
      // only diverge if a row is written outside ebay-sync.
      failed: items.filter(i => i.state === "failed").length,
      failedByStatus: failed,
      total: items.length,
    },
    freshness: {
      liveMinutes: ageMinutes(liveRun[0]?.finished_at),
      liveError: liveRun[0]?.error || null,
    },
  };
}

// --- actions ----------------------------------------------------------------

// Every action calls a function that already exists, with the operator secret
// this one holds. Nothing about eBay is reimplemented here; the point is only
// that a role check stands in front of it.
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
  if (!scope) {
    return json({ error: "unauthorized",
                  detail: "no matching user, or your role has no SPEEKS Connect access" }, 401);
  }

  try {
    if (req.method === "POST") return await handleAction(req, scope);

    const view = url.searchParams.get("view") || "listings";

    if (view === "health") {
      if (!scope.allStores) return json({ error: "forbidden" }, 403);
      const stores = [];
      for (const s of STORE_ORDER) stores.push(await summaryFor(s));
      return json({ scope: publicScope(scope), stores });
    }

    const store = resolveStore(scope, url.searchParams.get("store"));
    if (!store) return json({ error: "forbidden", detail: "that store is not yours" }, 403);

    // The category picker's search. eBay publishes no "every category" list
    // worth shipping to a browser, so its suggestion endpoint IS the search:
    // words in, ranked leaf categories with their full path out.
    if (view === "categories") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json({ results: [] });
      // eBay's category tree is the same for every seller — the store only
      // supplies the token to ask with. Tying the search to the CALLER's store
      // meant anyone at a store still being onboarded got a 404 from a picker
      // that has nothing to do with their store's setup, so any connected store
      // will do.
      const connected = await rows(
        `ebay_stores?store_code=eq.${encodeURIComponent(store)}&select=store_code&limit=1`);
      const tokenStore = connected.length
        ? store
        : (await rows(`ebay_stores?select=store_code&limit=1`))[0]?.store_code;
      if (!tokenStore) {
        return json({ results: [], note: "no eBay-connected store to search with" });
      }
      const r = await callFn(
        `ebay-sync?store=${tokenStore}&categorySearch=1&q=${encodeURIComponent(q)}`);
      return json(r.body, r.status < 300 ? 200 : r.status);
    }

    if (view === "listings") {
      const summary = await summaryFor(store);
      return json({
        scope: publicScope(scope), store, summary,
        items: summary.connected ? await listingsFor(store) : [],
      });
    }

    return json({ error: `unknown view "${view}"` }, 400);
  } catch (e) {
    return json({ error: "failed", detail: String((e as Error)?.message || e).slice(0, 500) }, 500);
  }
});

async function handleAction(req: Request, scope: Scope): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const store = resolveStore(scope, body.store || null);
  const sku = String(body.sku || "").trim();

  if (!store) return json({ error: "forbidden", detail: "that store is not yours" }, 403);
  if (!scope.canList) return json({ error: "forbidden" }, 403);
  if (!sku) return json({ error: "pass a sku" }, 400);

  // A STORE WITH NO eBay CONNECTION HAS TO BE REFUSED HERE, NOT LATER.
  // ebay_listings.store_code is a foreign key into ebay_stores, so the attempt
  // stamp at the end of a failed action hit a 23503 and turned an ordinary "not
  // set up yet" into a 500 with raw Postgres in the body. Every store except
  // OVL is in exactly this state until it is onboarded, so this is the normal
  // path for a second store, not an edge case.
  if (!(await rows(
    `ebay_stores?store_code=eq.${encodeURIComponent(store)}&select=store_code&limit=1`)).length) {
    return json({
      ok: false,
      error: "store not connected",
      detail: `${store} is not connected to eBay yet, so nothing can be listed from it. `
            + `The store's eBay account has to be connected first.`,
    }, 409);
  }

  if (action === "preview") {
    const r = await callFn(`ebay-sync?store=${store}&sku=${encodeURIComponent(sku)}&dry=1`);
    return json({ ok: r.status < 300, ...r.body }, r.status < 300 ? 200 : r.status);
  }

  if (action === "list" || action === "retry") {
    // REFUSE ANYTHING ALREADY LIVE, whoever listed it. ebay-sync cannot make
    // this check — it only knows the Inventory API, which cannot see listings
    // made through the Trading API — so it happens here, against ebay_live.
    // SPEEKS Connect and Marketplace Connect are meant to hold different SKUs;
    // this is what makes a slip bounce rather than double-list a single unit.
    const already = await rows(
      `ebay_live?store_code=eq.${encodeURIComponent(store)}&sku=eq.${encodeURIComponent(sku)}&select=item_id`);
    const ours = await rows(
      `ebay_listings?store_code=eq.${encodeURIComponent(store)}&sku=eq.${encodeURIComponent(sku)}`
      + `&select=ebay_listing_id,status`);
    const isOurs = !!ours[0]?.ebay_listing_id;
    if (already.length && !isOurs) {
      const itemId = already[0].item_id;
      // A conflict row used to be a dead end: no title, no price, no links, and
      // a Try Again button that would fail identically forever. The one useful
      // thing is the listing itself, so hand back everything needed to open it.
      // ebay_catalog is our Shopify mirror and may be stale, so it is a bonus
      // rather than a dependency — the eBay link is the part that matters.
      const cat = (await rows(
        `ebay_catalog?store_code=eq.${encodeURIComponent(store)}`
        + `&sku=eq.${encodeURIComponent(sku)}&select=title,price,product_id&limit=1`))[0] || {};
      const detail =
        "This SKU is already live on the store's eBay account, and SPEEKS Connect did not "
        + "put it there — which almost always means Marketplace Connect did. Uploading it "
        + "again would put two live listings against one unit. SPEEKS Connect cannot end it "
        + "either, because it cannot see a listing it did not create: open it on eBay and end "
        + "it where it was made.";
      return json({
        ok: false,
        error: "already live on eBay",
        // Tells the panel this is not a retryable failure.
        conflict: true,
        itemId,
        detail,
        item: {
          sku, title: cat.title || sku, price: cat.price ?? null, quantity: null,
          itemId, state: "failed", conflict: true, error: detail,
          attempts: 0, lastAttempt: null, publishedAt: null, updatedAt: null,
          ebayUrl: ebayUrlFor(itemId),
          shopifyUrl: shopifyUrlFor(store, cat.product_id),
        },
      }, 409);
    }

    // A category chosen on the row beats anything eBay suggests — the person
    // sending it is holding the item. The name rides along so an overridden
    // category is not left showing a bare id in the panel.
    const cat = String(body.category || "").trim();
    const catName = String(body.categoryName || "").trim();
    const override = cat
      ? `&category=${encodeURIComponent(cat)}`
        + (catName ? `&categoryName=${encodeURIComponent(catName)}` : "")
      : "";

    const r = await callFn(`ebay-sync?store=${store}&sku=${encodeURIComponent(sku)}${override}`);

    // A TYPO MUST NOT LEAVE A ROW BEHIND.
    // stampAttempt upserts by (store, sku), so a SKU that does not exist in
    // Shopify used to become a permanent ebay_listings row — counted forever in
    // the store's "Did Not Upload" and in the DM's five-store view. "B2B310"
    // typed instead of "KS01-B2B310-E11" is not a failed listing; it is a
    // keystroke. The session feed still shows it, which is where a mistake
    // belongs — in front of the person who made it, until they sign out.
    const failedText = r.status < 300 ? "" : errorOf(r.body);
    const notInShopify = /not found in \S*myshopify\.com/i.test(failedText);
    if (!notInShopify) {
      await stampAttempt(store, sku, r.status < 300 ? null : failedText);
    }
    // The finished row goes back with the answer. The panel shows one line per
    // SKU somebody typed, and it has to turn from pending into a real item —
    // title, price, both links — without re-reading the whole store to find the
    // one row that just changed.
    return json({ ...r.body, ok: r.status < 300, item: await itemFor(store, sku) },
                r.status < 300 ? 200 : r.status);
  }

  // Where does this thing actually sell? Answered from the live market rather
  // than from a text match on our title, with the taxonomy guess alongside it.
  if (action === "recommend") {
    const r = await callFn(`ebay-sync?store=${store}&recommend=1&sku=${encodeURIComponent(sku)}`);
    return json({ ...r.body, ok: r.status < 300 }, r.status < 300 ? 200 : r.status);
  }

  // Take it off eBay and leave it off. ebay-inventory holds the logic and the
  // reasoning; see the note on its ?end=1 route for why 'ended' would not hold.
  if (action === "end") {
    const r = await callFn(`ebay-inventory?store=${store}&end=1&sku=${encodeURIComponent(sku)}`);
    return json({ ...r.body, ok: r.status < 300, item: await itemFor(store, sku) },
                r.status < 300 ? 200 : r.status);
  }

  if (action === "resync") {
    const r = await callFn(`ebay-inventory?store=${store}&resync=1&sku=${encodeURIComponent(sku)}`);
    return json({ ok: r.status < 300, ...r.body }, r.status < 300 ? 200 : r.status);
  }

  return json({ error: `unknown action "${action}"` }, 400);
}

const errorOf = (body: any): string =>
  typeof body === "string" ? body.slice(0, 400)
    : body?.error ? String(body.error).slice(0, 400)
    : JSON.stringify(body || {}).slice(0, 400);

// ebay-sync writes status, title, price and last_error itself. attempts and
// last_attempt_at are ours, and they must be stamped even when ebay-sync never
// got far enough to write a row — otherwise a SKU that fails at the very first
// step shows no evidence of having been tried at all.
// Bookkeeping, so it must never be what fails the request. The caller has
// already done the thing that matters — published, or been refused by eBay —
// and losing an attempt counter is not worth turning that answer into a 500.
async function stampAttempt(store: string, sku: string, error: string | null) {
  try {
    await stampAttemptInner(store, sku, error);
  } catch (e) {
    console.error("ebay-channel: attempt stamp failed", store, sku, String((e as Error).message));
  }
}

async function stampAttemptInner(store: string, sku: string, error: string | null) {
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
