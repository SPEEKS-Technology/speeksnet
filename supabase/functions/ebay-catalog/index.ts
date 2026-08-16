// ============================================================================
// ebay-catalog — the Shopify half of "what is not on eBay yet".
//
//   ?store=OVL&sweep=1            incremental: products touched since last run
//   ?store=OVL&sweep=1&full=1     full rebuild, and prunes what Shopify dropped
//   ?store=OVL&live=1             what is live on eBay right now, whoever listed it
//   ?store=OVL&status=1           when this store was last swept, and how big
//
// Marketplace Connect answered the coverage question by owning both sides. We
// only ever wrote down the items we PUSHED (ebay_listings), so "what did we
// miss" had no answer at all. This caches Shopify's side into ebay_catalog and
// the panel diffs the two tables — no Shopify call on a page load, same
// reasoning as shopify-live.
//
// WHY INCREMENTAL IS THE DEFAULT. A full sweep of a store is 40+ paginated
// GraphQL calls. Each page of 50 products with their variants and images costs
// ~550 of Shopify's 1000-point budget, and the bucket restores at 100/s — so a
// full sweep spends minutes mostly asleep. Products we care about are the ones
// that just changed, and `updated_at:>` finds those in one or two pages.
//
// The full sweep still has to exist: incremental never sees a product whose
// stock was decremented by an order placed before the window, and it can never
// prune. Nightly is the right cadence for it.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";

// 50 products a page, 5 images and 5 variants each: 50 * (1 + 5 + 5) = 550
// points, comfortably inside Shopify's 1000-point per-query ceiling. Raising
// any of the three trips it, and the error Shopify returns for that
// ("Query cost is 1100, maximum is 1000") arrives as a 200 with an errors
// array, so it fails as an empty sweep rather than as an obvious break.
const PAGE = 50;
const IMAGES_PER_PRODUCT = 5;
const VARIANTS_PER_PRODUCT = 5;
// Page ceilings. A sweep that runs away is worse than a sweep that stops short
// and says so — the edge runtime would kill it mid-write with no record of
// where it got to.
const MAX_PAGES_INCREMENTAL = 20;
const MAX_PAGES_FULL = 120;
// Overlap on the incremental window. Shopify's updated_at and our clock are not
// the same clock, and a product updated during the previous sweep can carry a
// timestamp just before it. Ten minutes of overlap costs one extra page.
const INCREMENTAL_OVERLAP_MS = 10 * 60 * 1000;

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

// EBAY_APPS has arrived with stray control characters in it before, which makes
// JSON.parse fail on a secret that looks perfectly fine in the dashboard.
const stripControl = (s: string) =>
  Array.from(s).filter(ch => ch.charCodeAt(0) >= 32).join("");

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
  const res = await sb(`shopify_stores?select=shop,store_code,access_token`);
  const rows: { shop: string; store_code: string | null; access_token: string }[] = await res.json();
  const target = rows.find(r => r.store_code === store)
    || rows.find(r => r.shop === SHOP_BY_STORE[store]);
  if (!target) throw new Error(`no shopify_stores row for ${store}`);
  return { shop: target.shop, token: target.access_token };
}

async function shopifyGql(shop: string, token: string, query: string, variables: unknown) {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  // Shopify answers 200 with an errors array for throttling and cost failures
  // alike. Treating that as success is how a sweep silently stores nothing.
  if (body.errors) throw new Error(`shopify: ${JSON.stringify(body.errors).slice(0, 400)}`);
  return body.data;
}

const PAGE_QUERY = `
  query($q: String, $n: Int!, $after: String) {
    products(first: $n, after: $after, query: $q, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id title createdAt status
        images(first: ${IMAGES_PER_PRODUCT}) { edges { node { id } } }
        variants(first: ${VARIANTS_PER_PRODUCT}) { edges { node {
          id sku price inventoryQuantity
        } } }
      } }
    }
  }`;

type Row = {
  store_code: string;
  sku: string;
  product_id: string;
  variant_id: string;
  title: string;
  price: number | null;
  quantity: number;
  image_count: number;
  product_created_at: string | null;
  seen_at: string;
  updated_at: string;
};

// DUPLICATE SKUs ARE REAL. Overland Park has products sharing a SKU, and an
// upsert batch containing the same key twice is rejected outright by Postgres
// ("ON CONFLICT DO UPDATE command cannot affect row a second time") — one
// duplicate anywhere in a page throws away the whole page.
//
// The in-stock copy wins, because that is the one somebody could actually sell;
// ties go to the first seen. They are counted rather than silently merged:
// ebay-sync refuses to publish a duplicated SKU at all (publishing either would
// replace the other's eBay listing), so these are items that can never list
// until someone fixes them in Shopify.
function dedupe(rows: Row[]): { rows: Row[]; duplicates: number } {
  const best = new Map<string, Row>();
  let duplicates = 0;
  for (const r of rows) {
    const seen = best.get(r.sku);
    if (!seen) { best.set(r.sku, r); continue; }
    duplicates += 1;
    if (r.quantity > seen.quantity) best.set(r.sku, r);
  }
  return { rows: [...best.values()], duplicates };
}

function rowsFrom(store: string, products: any[], stamp: string): Row[] {
  const out: Row[] = [];
  for (const p of products) {
    const images = (p.images?.edges || []).length;
    for (const v of (p.variants?.edges || []).map((e: any) => e.node)) {
      // No SKU means nothing eBay can be keyed on, and nothing our own Shopify
      // orders can be matched to either. Skipping is the only honest option.
      if (!v.sku) continue;
      out.push({
        store_code: store,
        sku: String(v.sku).trim(),
        product_id: String(p.id || ""),
        variant_id: String(v.id || ""),
        title: String(p.title || ""),
        price: v.price == null ? null : Number(v.price),
        quantity: Number(v.inventoryQuantity ?? 0),
        image_count: images,
        product_created_at: p.createdAt || null,
        seen_at: stamp,
        updated_at: stamp,
      });
    }
  }
  return out;
}

async function upsert(rows: Row[]) {
  if (!rows.length) return;
  // In blocks: a single 5,000-row body is one failure away from losing an
  // entire sweep, and PostgREST has its own limits on statement size.
  for (let i = 0; i < rows.length; i += 500) {
    await sb("ebay_catalog?on_conflict=store_code,sku", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
  }
}

// --- the eBay side ----------------------------------------------------------
//
// THE INVENTORY API CANNOT SEE MARKETPLACE CONNECT. MC (Codisto) lists through
// the Trading API, and listings created that way are "unmanaged": asking
// GET /sell/inventory/v1/inventory_item/{sku} about one returns 25710 NOT FOUND
// for an item that is live and selling right now.
//
// We share one eBay account per store with MC, so this sweep is the only honest
// answer to "is this already on eBay". GetMyeBaySelling returns the SKU of every
// active listing whichever API created it.
//
// Two traps, both hit while writing this:
//   * NO DetailLevel. ReturnAll makes eBay return Active, Scheduled, Sold and
//     Unsold alike, and the ActiveList pagination then only covers one of them —
//     page 1 and page 2 both answered 536 against a stated total of 413.
//   * Scope every match to the <ActiveList> container. ItemID, SKU and the
//     pagination totals all appear in other containers too.

const EBAY_HOSTS: Record<string, string> = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};
const LIVE_PER_PAGE = 200;      // eBay's own ceiling for this call
const LIVE_MAX_PAGES = 60;      // 12,000 listings; a store is nowhere near it

let EBAY_APPS: Record<string, { clientId?: string; clientSecret?: string }> = {};
{
  const raw = (Deno.env.get("EBAY_APPS") || "").trim();
  for (const text of [raw, stripControl(raw)]) {
    if (!text) break;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) { EBAY_APPS = parsed; break; }
    } catch { /* try the stripped copy */ }
  }
}

async function ebayToken(row: any): Promise<string> {
  const expiresAt = row.access_token_expires_at ? Date.parse(row.access_token_expires_at) : 0;
  if (row.access_token && expiresAt - Date.now() > 60000) return row.access_token;
  const creds = EBAY_APPS[row.store_code];
  if (!creds?.clientId || !creds?.clientSecret) {
    throw new Error(`no credentials in EBAY_APPS for ${row.store_code}`);
  }
  const res = await fetch(`${EBAY_HOSTS[row.environment]}/identity/v1/oauth2/token`, {
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
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${text.slice(0, 200)}`);
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

async function activePage(row: any, token: string, page: number) {
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>
     <GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
       <ActiveList>
         <Include>true</Include>
         <Pagination>
           <EntriesPerPage>${LIVE_PER_PAGE}</EntriesPerPage>
           <PageNumber>${page}</PageNumber>
         </Pagination>
       </ActiveList>
     </GetMyeBaySellingRequest>`;
  const res = await fetch(`${EBAY_HOSTS[row.environment]}/ws/api.dll`, {
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
  const text = await res.text();
  const ack = (text.match(/<Ack>([^<]+)<\/Ack>/) || [])[1] || "unknown";
  if (ack === "Failure") {
    const why = [...text.matchAll(/<LongMessage>([^<]*)<\/LongMessage>/g)].map(e => e[1]).join("; ");
    throw new Error(`GetMyeBaySelling: ${why || text.slice(0, 200)}`);
  }
  const active = (text.match(/<ActiveList>([\s\S]*?)<\/ActiveList>/) || [])[1] || "";
  const items = [...active.matchAll(/<Item>([\s\S]*?)<\/Item>/g)].map(m => {
    const chunk = m[1];
    const one = (tag: string) =>
      (chunk.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1] || null;
    return {
      itemId: one("ItemID"),
      sku: (one("SKU") || "").trim(),
      title: one("Title"),
      quantity: Number(one("Quantity") || 0),
    };
  });
  return {
    items,
    totalPages: Number((active.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/) || [])[1] || 0),
    totalEntries: Number((active.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/) || [])[1] || 0),
  };
}

async function sweepLive(store: string): Promise<Response> {
  const startedAt = new Date().toISOString();
  const row = (await (await sb(
    `ebay_stores?store_code=eq.${encodeURIComponent(store)}&select=*`)).json())[0];
  if (!row) return json({ error: `no ebay_stores row for ${store}` }, 404);

  await sb("ebay_live_runs?on_conflict=store_code", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ store_code: store, started_at: startedAt, error: null }]),
  });

  let listings = 0;
  let withoutSku = 0;
  let duplicateSkus = 0;
  let totalEntries = 0;
  let truncated = false;
  const seen = new Set<string>();

  try {
    const token = await ebayToken(row);
    for (let page = 1; page <= LIVE_MAX_PAGES; page++) {
      const { items, totalPages, totalEntries: te } = await activePage(row, token, page);
      totalEntries = te;
      // A listing with no SKU cannot be matched to a Shopify product, so it
      // cannot be reasoned about — counted, not stored, and reported so the
      // number is never quietly smaller than reality.
      const rows = items
        .filter(i => { if (!i.sku) { withoutSku += 1; return false; } return true; })
        // Two live listings under one SKU. Real on OVL, and the reason our
        // stored count lands below eBay's own: both are the same item as far as
        // coverage goes, but only one of them can be kept as a row.
        .filter(i => {
          if (seen.has(i.sku)) { duplicateSkus += 1; return false; }
          seen.add(i.sku);
          return true;
        })
        .map(i => ({
          store_code: store, sku: i.sku, item_id: i.itemId,
          title: i.title, quantity: i.quantity, seen_at: new Date().toISOString(),
        }));
      for (let i = 0; i < rows.length; i += 500) {
        await sb("ebay_live?on_conflict=store_code,sku", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(rows.slice(i, i + 500)),
        });
      }
      listings += rows.length;
      if (!items.length || page >= totalPages) break;
      if (page === LIVE_MAX_PAGES) truncated = true;
    }
  } catch (e) {
    const message = String((e as Error)?.message || e).slice(0, 500);
    await sb("ebay_live_runs?on_conflict=store_code", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ store_code: store, started_at: startedAt, error: message }]),
    });
    return json({ store, listings, error: message }, 502);
  }

  // Anything not seen this run is no longer live — sold, ended or delisted —
  // and leaving it would make an available item look already-listed forever.
  // Skipped on a truncated run, which never reached the tail.
  let pruned = 0;
  if (!truncated) {
    const res = await sb(
      `ebay_live?store_code=eq.${encodeURIComponent(store)}&seen_at=lt.${encodeURIComponent(startedAt)}`,
      { method: "DELETE", headers: { Prefer: "return=representation", Range: "0-9999" } });
    pruned = (await res.json()).length;
  }

  // RECONCILE OUR OWN ROWS AGAINST WHAT EBAY ACTUALLY HAS.
  //
  // ebay_listings.status is event-driven — ebay-sync writes it on publish,
  // ebay-inventory on a stock change — and that is the right source for the
  // panel, because it is current to the second. What it cannot see is a listing
  // eBay ended on its own: policy takedowns, expiries, an end from Seller Hub.
  // Nothing calls us about those, so the row would read "live" forever.
  //
  // This is the only place that comparison can be made honestly, because only a
  // COMPLETE sweep proves an absence. A truncated run never reached the tail,
  // and marking rows ended from it would kill listings that are perfectly fine.
  //
  // Published DURING the sweep is excluded: a listing created after this run
  // started was never going to appear in it.
  let reconciled = 0;
  if (!truncated) {
    const stale = (await (await sb(
      `ebay_listings?store_code=eq.${encodeURIComponent(store)}&status=eq.published`
      + `&published_at=lt.${encodeURIComponent(startedAt)}&select=sku`)).json())
      .filter((r: any) => !seen.has(r.sku));
    for (const r of stale) {
      await sb(`ebay_listings?store_code=eq.${encodeURIComponent(store)}`
             + `&sku=eq.${encodeURIComponent(r.sku)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "ended",
          last_error: "eBay no longer lists this. It was ended outside SPEEKS Connect.",
          updated_at: new Date().toISOString(),
        }),
      });
      reconciled += 1;
    }
  }

  await sb("ebay_live_runs?on_conflict=store_code", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      store_code: store, started_at: startedAt, finished_at: new Date().toISOString(),
      listings, without_sku: withoutSku,
      error: truncated ? `stopped at the ${LIVE_MAX_PAGES}-page cap` : null,
    }]),
  });

  // eBay's own count of active listings, reported beside ours. They should
  // match once SKU-less listings are added back; if they do not, the sweep is
  // missing something and the difference is the place to look.
  return json({ store, listings, withoutSku, duplicateSkus, ebayReports: totalEntries, pruned, reconciled, truncated });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!opsAuthed(url)) return json({ error: "unauthorised" }, 401);

  const store = (url.searchParams.get("store") || "").toUpperCase().trim();
  if (!store) return json({ error: "pass ?store=OVL" }, 400);

  if (url.searchParams.get("status") === "1") {
    const run = await (await sb(
      `ebay_catalog_runs?store_code=eq.${encodeURIComponent(store)}&select=*`)).json();
    const counted = await sb(
      `ebay_catalog?store_code=eq.${encodeURIComponent(store)}&select=sku&quantity=gt.0`,
      { headers: { Prefer: "count=exact", "Range-Unit": "items", Range: "0-0" } });
    // PostgREST reports the total after the slash in Content-Range: "0-0/1842".
    const total = Number((counted.headers.get("content-range") || "/0").split("/")[1] || 0);
    return json({ store, lastRun: run[0] || null, inStock: total });
  }

  if (url.searchParams.get("live") === "1") return await sweepLive(store);

  if (url.searchParams.get("sweep") !== "1") {
    return json({ error: "pass &sweep=1, &live=1 or &status=1" }, 400);
  }

  const full = url.searchParams.get("full") === "1";
  const startedAt = new Date().toISOString();
  const { shop, token } = await shopFor(store);

  // The incremental window starts from the last run that FINISHED. Starting
  // from a run that died halfway would skip everything it never reached.
  const prev = (await (await sb(
    `ebay_catalog_runs?store_code=eq.${encodeURIComponent(store)}&select=finished_at`)).json())[0];
  const since = prev?.finished_at
    ? new Date(Date.parse(prev.finished_at) - INCREMENTAL_OVERLAP_MS).toISOString()
    : null;

  // A store swept for the first time has no window to be incremental about, so
  // it gets the full treatment whether or not it was asked for.
  const doFull = full || !since;
  const q = doFull ? "inventory_total:>0" : `updated_at:>'${since}'`;
  const maxPages = doFull ? MAX_PAGES_FULL : MAX_PAGES_INCREMENTAL;

  await sb("ebay_catalog_runs?on_conflict=store_code", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ store_code: store, started_at: startedAt, error: null }]),
  });

  let after: string | null = null;
  let pages = 0;
  let variants = 0;
  let duplicates = 0;
  let truncated = false;
  // Across pages as well as within one. The same SKU can appear on page 1 and
  // page 7, and only a set that outlives the page can tell that apart from two
  // legitimately different items.
  const seenSkus = new Set<string>();

  try {
    for (;;) {
      const data = await shopifyGql(shop, token, PAGE_QUERY, { q, n: PAGE, after });
      const conn = data.products;
      const nodes = (conn?.edges || []).map((e: any) => e.node);
      const deduped = dedupe(rowsFrom(store, nodes, new Date().toISOString()));
      duplicates += deduped.duplicates;
      const rows = deduped.rows.filter(r => {
        if (seenSkus.has(r.sku)) { duplicates += 1; return false; }
        seenSkus.add(r.sku);
        return true;
      });
      await upsert(rows);
      variants += rows.length;
      pages += 1;
      if (!conn?.pageInfo?.hasNextPage) break;
      if (pages >= maxPages) { truncated = true; break; }
      after = conn.pageInfo.endCursor;
    }
  } catch (e) {
    const message = String((e as Error)?.message || e).slice(0, 500);
    await sb("ebay_catalog_runs?on_conflict=store_code", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ store_code: store, started_at: startedAt, error: message }]),
    });
    return json({ store, mode: doFull ? "full" : "incremental", pages, variants, duplicates, error: message }, 502);
  }

  // Prune only after a COMPLETE full sweep. An incremental run never sees most
  // of the catalog, and a truncated full run never reached the tail — deleting
  // on either would empty the table of items that are alive and unlisted.
  let pruned = 0;
  if (doFull && !truncated) {
    const res = await sb(
      `ebay_catalog?store_code=eq.${encodeURIComponent(store)}&seen_at=lt.${encodeURIComponent(startedAt)}`,
      { method: "DELETE", headers: { Prefer: "return=representation", Range: "0-9999" } });
    pruned = (await res.json()).length;
  }

  const finishedAt = new Date().toISOString();
  await sb("ebay_catalog_runs?on_conflict=store_code", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      store_code: store, started_at: startedAt, finished_at: finishedAt,
      variants, pages, error: truncated ? `stopped at the ${maxPages}-page cap` : null,
    }]),
  });

  return json({
    store,
    mode: doFull ? "full" : "incremental",
    since: doFull ? null : since,
    pages, variants, duplicates, pruned, truncated,
    finishedAt,
  });
});

// Machine auth, the same secret and reasoning as the other ebay-* endpoints.
// Deliberately not in speeks.js: the browser reaches this data through
// ebay-channel, which authenticates a person by pin.
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
