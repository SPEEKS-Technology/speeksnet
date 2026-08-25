// ============================================================================
// shopify-recat — files the `other` pile onto the right shelf.
//
// TWO WAYS IN, and they authenticate differently on purpose.
//
//   THE PANEL (SPEEKS Connect → Categories), x-user-pin:
//     GET  ?view=review&store=OVL      the queue, one row per product
//     GET  ?view=counts                per-store totals for every queue, and
//                                      nothing else — what the feed card polls
//     GET  ?view=photos&store=OVL      live listings with NO PHOTOGRAPH. Read
//                                      only: the fix is a camera, not an API
//                                      call (see the 0065 migration).
//     POST {action:"apply", store, productIds:[...]}
//     POST {action:"skip",  store, productId, reason}
//     POST {action:"unskip", store, productId}
//
//   THE SWEEP, ?secret= :
//     ?store=OVL                       DRY RUN: what would move, and by which rule
//     ?store=OVL&apply=1&secret=...    write it
//     ?apply=1&secret=...&ids=gid,gid  write exactly these products
//     ?limit=25                        cap the products touched in one run
//
// The secret in speeks.js is not a secret — it ships to every browser — so the
// panel cannot use it. It sends the person's PIN and the function decides from
// their role, the same posture as ebay-channel. The secret path stays for the
// scripted runs, which nobody's browser makes.
//
// DRY RUN IS THE DEFAULT because this is the only function in the estate that
// writes to somebody's product catalogue.
//
// WHAT IT DOES NOT SEE. Both queues are scoped to products that are LIVE ON
// THE ONLINE STORE — ebay_catalog.online_published, which is Shopify's
// `onlineStoreUrl` being non-null. 967 in-stock units are unpublished, and the
// collection an unpublished product sits in is a shelf no shopper can reach.
// The scope is in the views so this function and the sweep cannot disagree
// about it.
//
// AND THE SHELVES ARE PAYMORE'S. Corp runs the storefront, so the 63
// collections are the ones we get; a rule may only target a collection that
// exists in shopify_collections (a foreign key since 0056), and the picker only
// ever offers matchable ones. We do not invent a 64th — one was created here on
// 2026-08-21 and deleted the next hour.
//
// WHAT IT MOVES. `collection_proposals` (the view) is the whole decision: it
// scores a title against `collection_rules`, longest keyword first, and only
// ever considers a product whose ONLY real collection is `other`. So this can
// put something on the wrong shelf, but it can never take a product out of a
// collection a human chose. Every add and remove lands in `collection_moves`,
// and the view drops what it has already moved — ebay_catalog keeps the stale
// collection list until the next full sweep, so without that the queue would
// re-offer its own finished work.
//
// HOW SHOPIFY DOES IT NOW. `collectionAddProducts` / `collectionRemoveProducts`
// are gone in 2026-07 — checked by introspection rather than assumed, because
// the obvious mutation names still appear all over the docs. What exists is
// `productUpdate(product: {id, collectionsToJoin, collectionsToLeave})`, which
// is better for us anyway: joining the new shelf and leaving `other` are one
// mutation on one product, so a product can never end up on both or neither.
//
// Mutations are aliased BATCH_SIZE to a request. Shopify prices a mutation at
// ~10 cost points against a 2000-point bucket refilling at 100/s, so ten at a
// time keeps a request cheap enough to retry and slow enough not to drain the
// bucket. Throttling comes back as a 200 with an `errors` array — the same
// trap ebay-catalog documents — so a failed batch is reported, never silently
// counted as done.
//
// See [[shopify-product-taxonomy]] for why collections are the taxonomy at all,
// and [[callback-shopify-match]] for what depends on this being right.
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";
const SECRET = "sp33ks-sync-k3y-2026-x9mq";

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};

// Filing stock is a merchandising decision that writes to a live catalogue, so
// it starts with the people who answer for the storefront: corp everywhere, a
// manager at their own store. Everyone else is refused BY DEFAULT — and only by
// default. CATS_KEY / PHOTOS_KEY below are the same switches the tab reads, so
// the DM can hand either half to an ASM in Feature Access and have it actually
// work, rather than granting a button that 403s (see [[kpi-role-gate]]).
const CORP_ROLES = ["district manager", "ceo", "mocd"];
const STORE_ROLES = ["manager", "owner (manager)", "owner manager", "multi-store manager"];
const MSM_STORES = ["BAL", "MPL"];

// The junk drawer we are emptying. A proposal always leaves this one.
//
// TWO KEYS, because Listing Health is two tools sharing one page. Categories is
// a merchandising queue you work down; the photo alarm is a read-only number
// that should always be zero and is squarely an ASM's job. Since they were
// merged onto one tab, one switch meant granting the alarm forced you to grant
// the filing queue with it. Each half now answers for itself and the tab shows
// whichever halves the reader holds.
//
// ⚠️ Both keys are read HERE as well as by the button. A grant that shows a
// section the server then 401s is worse than no grant (see [[kpi-role-gate]]).
const CATS_KEY = "ec-view-categories";
const PHOTOS_KEY = "ec-view-photos";
// The photo alarm's default audience is wider by one role: an ASM is usually the
// person holding the camera. Filing stock into collections is not theirs by
// default, so STORE_ROLES alone still gates Categories.
const PHOTO_EXTRA_ROLES = ["assistant manager"];
const FROM_HANDLE = "other";
const BATCH_SIZE = 10;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
const rows = async (path: string) => await (await sb(path)).json();

type Scope = { name: string; role: string; stores: string[]; corp: boolean;
               mayCats: boolean; mayPhotos: boolean };

// An override row for this feature, resolved the way the site resolves it:
// the person beats their role, and neither existing means "use the default".
// Returns null for "nothing said".
async function featureSays(key: string, role: string, name: string): Promise<boolean | null> {
  const list = await rows(`feature_overrides?feature_key=eq.${encodeURIComponent(key)}`
    + `&select=subject_type,subject,enabled`);
  const lc = (v: unknown) => String(v || "").toLowerCase().trim();
  // "Owner (Manager)" -> "owner-manager", the slug the tool writes.
  const slug = lc(role).replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-");
  const forUser = list.find((r: any) => lc(r.subject_type) === "user" && lc(r.subject) === lc(name));
  if (forUser) return !!forUser.enabled;
  const forRole = list.find((r: any) => lc(r.subject_type) === "role" && lc(r.subject) === slug);
  if (forRole) return !!forRole.enabled;
  return null;
}

async function scopeFor(pin: string): Promise<Scope | null> {
  if (!pin) return null;
  const found = await rows(`users?pin=eq.${encodeURIComponent(pin)}&select=name,role,store&limit=1`);
  const user = found?.[0];
  if (!user) return null;
  const role = String(user.role || "").toLowerCase().trim();
  const corp = CORP_ROLES.includes(role);
  const byRoleCats = corp || STORE_ROLES.includes(role);
  // ⚠️ MOCD IS OUT OF THE PHOTO DEFAULT, and this has to match FEATURE_CATALOG's
  // `def` in speeks.js exactly. Their ec-view-categories was revoked by hand; a
  // new key defaulting on for them would re-open the page under a new name, and
  // a backend that says yes while the button says no is how you get a tool
  // reachable by URL that nobody can see.
  const byRolePhotos = (corp && role !== "mocd")
    || STORE_ROLES.includes(role) || PHOTO_EXTRA_ROLES.includes(role);
  const name = String(user.name || "");
  const [saidCats, saidPhotos] = await Promise.all([
    featureSays(CATS_KEY, role, name), featureSays(PHOTOS_KEY, role, name),
  ]);
  const mayCats = saidCats === null ? byRoleCats : saidCats;
  const mayPhotos = saidPhotos === null ? byRolePhotos : saidPhotos;
  // Only a reader holding NEITHER half is a stranger to this function. Holding
  // one is the whole point of splitting the keys.
  if (!mayCats && !mayPhotos) return null;
  // A granted role still only gets ITS OWN stock. Feature Access answers "may
  // this person file", never "whose catalogue" — that stays the store on their
  // user row, and corp is the only thing that means all five.
  const stores = corp ? STORES
    : role === "multi-store manager" ? MSM_STORES
    : [String(user.store || "").toUpperCase()].filter(s => STORES.includes(s));
  if (!stores.length) return null;
  return { name: user.name || "", role, stores, corp, mayCats, mayPhotos };
}

async function shopFor(store: string): Promise<{ shop: string; token: string }> {
  const all = await rows(`shopify_stores?select=shop,store_code,access_token`);
  const target = all.find((r: any) => r.store_code === store)
    || all.find((r: any) => r.shop === SHOP_BY_STORE[store]);
  if (!target) throw new Error(`no shopify_stores row for ${store}`);
  return { shop: target.shop, token: target.access_token };
}

async function shopifyGql(shop: string, token: string, query: string, variables?: unknown) {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`shopify: ${JSON.stringify(body.errors).slice(0, 400)}`);
  return body.data;
}

// Collection ids are per store — the 63 collections are byte-identical across
// the five shops by franchise standard, but they are still different rows with
// different ids, so the handle→id map has to be built per shop.
async function collectionIds(shop: string, token: string): Promise<Record<string, string>> {
  const data = await shopifyGql(shop, token,
    `{ collections(first: 250) { edges { node { id handle } } } }`);
  const out: Record<string, string> = {};
  for (const e of (data?.collections?.edges ?? [])) out[e.node.handle] = e.node.id;
  return out;
}

type Proposal = {
  store_code: string; product_id: string; sku: string | null;
  title: string; product_handle: string | null; keyword: string; target_handle: string;
  // What filing it makes the product LEAVE. `other` for the junk-drawer queue;
  // for a misfiled product it is whatever shelf it is wrongly on, which is why
  // this cannot be a constant.
  wrong_handles?: string[];
};

async function proposalsFor(store: string): Promise<Proposal[]> {
  return await rows(
    `collection_proposals?store_code=eq.${store}` +
    `&select=store_code,product_id,sku,title,product_handle,keyword,target_handle` +
    `&order=target_handle,title`);
}

// The second queue: stock that is already on a real shelf, and on the wrong
// one. Scored by STRONG rules only — see the 0054 migration for why pointing
// the whole rule set at filed stock produces 421 flags and ~20 truths.
async function misfiledFor(store: string): Promise<Proposal[]> {
  return await rows(
    `collection_misfiled?store_code=eq.${store}` +
    `&select=store_code,product_id,sku,title,product_handle,keyword,target_handle,wrong_handles` +
    `&order=target_handle,title`);
}

// The third queue: the SAME Other pile, minus every row a rule had a guess
// for. This is the one nobody could see — the panel only ever listed
// proposals, so 48 listings across the five stores sat in Other on the live
// storefront and appeared on no screen at all. There is no keyword and no
// target here on purpose: the row is a question, and the answer is whatever a
// person picks in the shelf popover.
async function unmatchedFor(store: string): Promise<Proposal[]> {
  const all = await rows(
    `collection_unmatched?store_code=eq.${store}` +
    `&select=store_code,product_id,sku,title,product_handle,wrong_handles` +
    `&order=title`);
  // "no match" rather than an empty keyword, so the ledger reads honestly once
  // it is filed: "no match -> chosen · Ethan Kushnir".
  return all.map((p: any) => ({ ...p, keyword: "no match", target_handle: "" }));
}

const queueFor = (store: string, mode: string) =>
  mode === "misfiled" ? misfiledFor(store)
  : mode === "unmatched" ? unmatchedFor(store)
  : proposalsFor(store);

// One spelling of the three modes, because the panel, the counts and the apply
// path all have to agree on which queue a request is about.
const modeOf = (v: unknown) => {
  const m = String(v || "");
  return m === "misfiled" || m === "unmatched" ? m : "other";
};

// Shelf handles are not what a person reading a queue wants to see, and the
// panel should not carry its own copy of 63 titles that a sweep can rename.
async function shelfTitles(): Promise<Record<string, string>> {
  const all = await rows(`shopify_collections?select=handle,title`);
  const out: Record<string, string> = {};
  for (const c of all) out[c.handle] = c.title;
  return out;
}

// The skipped list, with enough on it to tell whether the skip was right.
//
// `collection_skips` stores a decision, not a product: store, product id, who,
// why. A row showing only the numeric id asked somebody to audit their own
// judgement against a number — so this reads the product back out of
// ebay_catalog and adds the title, the SKU and the category it is sitting in
// TODAY. That last one is the point: a skip is correct when the item is already
// where it belongs, and wrong when it is still in Other.
//
// A product with several variants has several catalog rows; the first wins,
// since title and collections are per product.
//
// A PRODUCT THAT IS NO LONGER IN THE CATALOGUE IS DROPPED FROM THE LIST. It used
// to be kept with just its id, on the reasoning that the skip was still a real
// decision and still undoable. Neither half holds up: the row rendered as "This
// listing is no longer in the catalogue" with nothing to audit, and un-skipping it
// puts it back in a queue built from the same catalogue, where it cannot appear.
// So it is noise on the one list that has to stay short enough to read.
//
// ⚠️ FILTERED ON READ, NOT DELETED. `ebay_catalog` is a refreshed snapshot, and a
// refresh that fails or is halfway through makes every product look gone — a
// delete here would destroy every skip decision at a store on the strength of one
// bad sync. Filtering costs two rows of storage and is undone by the next good
// refresh; deleting is not undone by anything.
//
// NOTE THIS IS NOT A STOCK TEST. ebay_catalog keeps sold-out products with
// quantity 0, so "gone from the catalogue" means gone from Shopify's online store
// altogether — deleted or unpublished. Usually that is because it sold, but the
// list is not claiming that.
async function skippedFor(store: string, titles: Record<string, string>) {
  const skips = await rows(
    `collection_skips?store_code=eq.${store}&select=product_id,reason,skipped_by,created_at`
    + `&order=created_at.desc`);
  if (!skips.length) return skips;
  // gids carry no comma or quote, so they need no escaping inside in.(...) —
  // and capped, because this becomes a URL.
  const ids = skips.slice(0, 200).map((s: any) => `"${s.product_id}"`).join(",");
  const cat = await rows(
    `ebay_catalog?store_code=eq.${store}&product_id=in.(${ids})`
    + `&select=product_id,sku,title,collections`);
  const byId = new Map<string, any>();
  for (const c of cat) if (!byId.has(c.product_id)) byId.set(c.product_id, c);
  return skips.filter((s: any) => byId.has(s.product_id)).map((s: any) => {
    const c = byId.get(s.product_id);
    return {
      ...s,
      sku: c.sku ?? null,
      title: c.title ?? null,
      // Where it is now, in words, `newly-listed-devices` excepted — that one is
      // every product at every store and says nothing about a category.
      in: (c.collections || [])
        .filter((h: string) => h !== "newly-listed-devices")
        .map((h: string) => titles[h] || h),
    };
  });
}

// Every shelf a person may choose instead of the one the rule proposed. Sent
// with the queue so the picker opens instantly, and used to VALIDATE what comes
// back — a handle posted by a browser is checked against this list before it
// reaches Shopify, so the picker cannot be used to file stock anywhere else.
async function matchableShelves(): Promise<{ handle: string; title: string }[]> {
  const all = await rows(
    `shopify_collections?matchable=is.true&select=handle,title&order=title`);
  return all.map((c: any) => ({ handle: c.handle, title: c.title }));
}

// Applies exactly these products. Shared by the panel and the sweep so there
// is one place where a write to a live catalogue happens.
async function applyProducts(store: string, todo: Proposal[], who: string) {
  const { shop, token } = await shopFor(store);
  const ids = await collectionIds(shop, token);

  const moved: Proposal[] = [];
  const failed: { title: string; why: string }[] = [];

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    const parts: string[] = [];
    const usable: Proposal[] = [];

    batch.forEach((p, n) => {
      const toId = ids[p.target_handle];
      if (!toId) { failed.push({ title: p.title, why: `no collection ${p.target_handle}` }); return; }
      // ⚠️ EVERY ID HERE COMES FROM THE LIVE handle→id MAP, never from anything
      // remembered or guessed. Shopify accepts a collectionsToLeave id that the
      // product is not in — and that is not a userError, it is a silent no-op —
      // so a wrong id leaves the product on both shelves and reports success.
      const leave = (p.wrong_handles?.length ? p.wrong_handles : [FROM_HANDLE])
        .map(h => ids[h]).filter(Boolean);
      if (!leave.length) { failed.push({ title: p.title, why: `nothing to leave` }); return; }
      usable.push(p);
      parts.push(
        `m${n}: productUpdate(product: { id: "${p.product_id}", ` +
        `collectionsToJoin: ["${toId}"], ` +
        `collectionsToLeave: [${leave.map(id => `"${id}"`).join(", ")}] }) ` +
        `{ userErrors { field message } }`);
    });
    if (!parts.length) continue;

    const data = await shopifyGql(shop, token, `mutation { ${parts.join("\n")} }`);

    // A userErrors array is Shopify saying no while answering 200. Each alias
    // is its own product, so one refusal must not discredit the nine that
    // worked — hence the per-alias read rather than a batch verdict.
    usable.forEach((p, n) => {
      const errs = data?.[`m${n}`]?.userErrors ?? [];
      if (errs.length) failed.push({ title: p.title, why: errs.map((e: any) => e.message).join("; ") });
      else moved.push(p);
    });
  }

  if (moved.length) {
    await sb("collection_moves", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(moved.map(p => ({
        store_code: store, product_id: p.product_id, sku: p.sku, title: p.title,
        added_handle: p.target_handle,
        removed_handle: (p.wrong_handles?.length ? p.wrong_handles : [FROM_HANDLE]).join(", "),
        rule_keyword: who ? `${p.keyword} · ${who}` : p.keyword,
      }))),
    });
  }
  return { moved, failed };
}

// --- the panel --------------------------------------------------------------

async function handlePost(req: Request, scope: Scope) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const store = String(body.store || "").toUpperCase();
  if (!scope.stores.includes(store)) return json({ error: "forbidden", detail: `not your store: ${store}` }, 403);

  if (action === "skip" || action === "unskip") {
    const productId = String(body.productId || "");
    if (!productId) return json({ error: "productId required" }, 400);
    if (action === "unskip") {
      await sb(`collection_skips?store_code=eq.${store}&product_id=eq.${encodeURIComponent(productId)}`,
        { method: "DELETE" });
      return json({ ok: true, unskipped: productId });
    }
    await sb("collection_skips", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        store_code: store, product_id: productId,
        skipped_by: scope.name, reason: String(body.reason || "").slice(0, 300) || null,
      }),
    });
    return json({ ok: true, skipped: productId });
  }

  if (action === "apply") {
    // Two shapes: bare ids (file where the rule said) or {productId, to} pairs
    // (file where the PERSON said). The rule's answer is a default, not a
    // verdict — it is right about four titles in five and wrong about the fifth
    // in a way only somebody who knows the item can see.
    const items: { productId: string; to?: string }[] =
      Array.isArray(body.items) ? body.items.map((i: any) => ({ productId: String(i.productId), to: i.to ? String(i.to) : undefined }))
      : (Array.isArray(body.productIds) ? body.productIds : []).map((id: any) => ({ productId: String(id) }));
    if (!items.length) return json({ error: "productIds or items required" }, 400);

    const chosen = new Map(items.map(i => [i.productId, i.to]));
    // Only ever act on what the QUEUE says — a product id posted by a browser
    // is a request to file a proposal, not a licence to move anything. Which
    // queue matters: the misfiled one carries the shelves to LEAVE, and filing
    // a misfiled product against the junk-drawer queue would try to take it out
    // of `other`, where it never was.
    const queue = await queueFor(store, modeOf(body.mode));
    let todo = queue.filter(p => chosen.has(p.product_id));
    if (!todo.length) return json({ error: "nothing in the queue matched those products" }, 400);

    // And a chosen shelf is checked against the real, matchable collections
    // for the same reason: the picker may not file stock somewhere arbitrary.
    const allowed = new Set((await matchableShelves()).map(s => s.handle));
    const badShelf = items.find(i => i.to && !allowed.has(i.to));
    if (badShelf) return json({ error: `not a shelf anything may be filed on: ${badShelf.to}` }, 400);

    todo = todo.map(p => {
      const to = chosen.get(p.product_id);
      return to && to !== p.target_handle
        ? { ...p, target_handle: to, keyword: `${p.keyword} → chosen` }
        : p;
    });

    // An unmatched row arrives with no target, because nothing proposed one. If
    // the picker was never opened there is no shelf to file it on, and the only
    // honest answer is to refuse — filing it "somewhere" is how stock ends up on
    // a shelf nobody chose.
    const noShelf = todo.filter(p => !p.target_handle);
    if (noShelf.length) {
      return json({ error: `no category chosen for ${noShelf.length} listing(s)`,
                    titles: noShelf.slice(0, 5).map(p => p.title) }, 400);
    }

    const { moved, failed } = await applyProducts(store, todo, scope.name);
    return json({
      ok: true, store, requested: items.length,
      moved: moved.length, failed: failed.length, errors: failed.slice(0, 20),
      products: moved.map(p => ({ title: p.title, to: p.target_handle })),
    });
  }

  return json({ error: `unknown action: ${action}` }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const pin = req.headers.get("x-user-pin") || "";
    const view = url.searchParams.get("view") || "";

    // --- panel ---------------------------------------------------------------
    if (req.method === "POST" || view === "review" || view === "counts"
        || view === "photos") {
      const scope = await scopeFor(pin);
      // A stale sessionStorage PIN outlives a PIN change and lands exactly here.
      if (!scope) {
        return json({ error: "unauthorized",
                      detail: "no matching user, or your role may not file stock" }, 401);
      }
      // Per-half gates. scopeFor only proved they hold ONE of the two.
      const noCats = () => json({ error: "forbidden",
        detail: "the Categories queue is not switched on for you" }, 403);
      const noPhotos = () => json({ error: "forbidden",
        detail: "the no-pictures alarm is not switched on for you" }, 403);

      // Filing writes to a live catalogue and is Categories' half, always.
      if (req.method === "POST") {
        if (!scope.mayCats) return noCats();
        return await handlePost(req, scope);
      }
      if (view === "photos" && !scope.mayPhotos) return noPhotos();
      if (view === "review" && !scope.mayCats) return noCats();

      // JUST THE NUMBERS, for the notification check that every manager runs
      // on a timer. The review payload carries a whole store queue with it —
      // 90 rows to answer "is there anything to do", on every page, forever.
      if (view === "counts") {
        // Only the halves this reader holds — and the ones they do not are
        // OMITTED rather than sent as zero. A zero means "nothing to do"; a
        // missing key means "not your tool", and the nag that reads this must
        // be able to tell those apart or it will report an all-clear on a
        // queue it was never allowed to look at.
        const [other, misfiled, unmatched, photos] = await Promise.all([
          scope.mayCats ? queueTotals(scope.stores, "other") : null,
          scope.mayCats ? queueTotals(scope.stores, "misfiled") : null,
          scope.mayCats ? queueTotals(scope.stores, "unmatched") : null,
          scope.mayPhotos ? photoTotals(scope.stores) : null]);
        return json({ scope: { name: scope.name, role: scope.role, stores: scope.stores,
                               corp: scope.corp, mayCats: scope.mayCats, mayPhotos: scope.mayPhotos },
                      ...(scope.mayCats ? { other, misfiled, unmatched } : {}),
                      ...(scope.mayPhotos ? { photos } : {}) });
      }

      // The photo alarm for one store. Its own view rather than a field on the
      // review payload: Categories and Photos are two sections of one page now,
      // and bolting this onto `review` would make every tab switch inside
      // Categories re-fetch a list that cannot have changed.
      if (view === "photos") {
        const askedP = (url.searchParams.get("store") || "").toUpperCase();
        const storeP = scope.stores.includes(askedP) ? askedP : scope.stores[0];
        return json({
          scope: { name: scope.name, role: scope.role, stores: scope.stores, corp: scope.corp,
                   mayCats: scope.mayCats, mayPhotos: scope.mayPhotos },
          store: storeP,
          queue: await photosFor(storeP),
        });
      }

      const asked = (url.searchParams.get("store") || "").toUpperCase();
      const store = scope.stores.includes(asked) ? asked : scope.stores[0];
      const mode = modeOf(url.searchParams.get("mode"));
      const [queue, titles, shelves] = await Promise.all([
        queueFor(store, mode), shelfTitles(), matchableShelves()]);
      const skipped = await skippedFor(store, titles);
      // ALL THREE counts, for THIS STORE — they are the numbers on the three tabs,
      // and a tab that says 17 above a list of one is worse than no number at all.
      // The queue in hand is one of the three, so only the other two cost a query.
      const totals: Record<string, number> = {};
      for (const m of ["other", "misfiled", "unmatched"]) {
        totals[m] = m === mode ? queue.length : (await queueTotals([store], m))[store] || 0;
      }
      return json({
        scope: { name: scope.name, role: scope.role, stores: scope.stores, corp: scope.corp,
                   mayCats: scope.mayCats, mayPhotos: scope.mayPhotos },
        store, mode,
        queue: queue.map(p => ({
          productId: p.product_id, sku: p.sku, title: p.title, handle: p.product_handle,
          rule: p.keyword, to: p.target_handle, toTitle: titles[p.target_handle] || p.target_handle,
          // What it leaves. `Other` for the junk drawer; the shelves it is
          // wrongly on for a misfiled one — and the panel has to show that,
          // because "join Car Electronics" and "leave Digital Cameras" are two
          // different things to agree with.
          from: (p.wrong_handles?.length ? p.wrong_handles : [FROM_HANDLE])
                  .map(h => titles[h] || h),
          shop: SHOP_BY_STORE[store],
        })),
        skipped,
        shelves,
        counts: {
          other: totals.other,
          misfiled: totals.misfiled,
          unmatched: totals.unmatched,
        },
      });
    }

    // --- sweep ---------------------------------------------------------------
    const apply = url.searchParams.get("apply") === "1";
    const wanted = (url.searchParams.get("store") || "").toUpperCase();
    const limit = Math.max(0, parseInt(url.searchParams.get("limit") || "0", 10)) || 0;
    const only = new Set((url.searchParams.get("ids") || "").split(",").map(s => s.trim()).filter(Boolean));
    const stores = STORES.includes(wanted) ? [wanted] : STORES;

    if (apply && url.searchParams.get("secret") !== SECRET) {
      return json({ error: "apply=1 needs the secret" }, 403);
    }

    const report: Record<string, unknown> = {};
    let movedTotal = 0, proposedTotal = 0;

    for (const store of stores) {
      let proposals = await proposalsFor(store);
      if (only.size) proposals = proposals.filter(p => only.has(p.product_id));
      proposedTotal += proposals.length;

      // What this store would do, by shelf — the useful shape for a human
      // reading a dry run, and cheap enough to include in an apply too.
      const byShelf: Record<string, number> = {};
      for (const p of proposals) byShelf[p.target_handle] = (byShelf[p.target_handle] ?? 0) + 1;

      if (!apply) {
        report[store] = {
          proposed: proposals.length,
          by_shelf: byShelf,
          sample: proposals.slice(0, 10).map(p => ({
            title: p.title, rule: p.keyword, to: p.target_handle,
          })),
        };
        continue;
      }

      const todo = limit ? proposals.slice(0, limit) : proposals;
      const { moved, failed } = await applyProducts(store, todo, "");
      movedTotal += moved.length;
      report[store] = {
        proposed: proposals.length, moved: moved.length, failed: failed.length,
        by_shelf: byShelf, errors: failed.slice(0, 20),
        products: moved.map(p => ({ title: p.title, to: p.target_handle })),
      };
    }

    return json({
      ok: true, mode: apply ? "applied" : "dry-run",
      proposed: proposedTotal, moved: movedTotal, stores: report,
      // ebay_catalog still holds the old collection list until the catalogue is
      // swept again; the Call Back matcher reads that table, not Shopify.
      note: apply
        ? "run ebay-catalog?store=X&sweep=1&full=1 for each store so ebay_catalog.collections catches up"
        : "nothing was written",
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// ONE query, tallied here, rather than one count per store. The view is not
// free — it scores every unfiled product against every rule — and asking it
// five separate times for five numbers is what made the panel look hung.
//
// The counts follow the MODE. Showing the junk-drawer totals above a misfiled
// queue puts "WSP 97" on a chip that opens a list of two.
async function queueTotals(stores: string[], mode: string): Promise<Record<string, number>> {
  const view = mode === "misfiled" ? "collection_misfiled"
             : mode === "unmatched" ? "collection_unmatched"
             : "collection_proposals";
  const all = await rows(`${view}?select=store_code`);
  const out: Record<string, number> = {};
  for (const s of stores) out[s] = 0;
  for (const r of all) if (r.store_code in out) out[r.store_code] += 1;
  return out;
}

// --- PHOTOS: live on the online store with nothing to look at ---------------
//
// A different question from everything above it, sharing this function for one
// reason: it is the same person, the same PIN and the same store scope, and a
// second edge function would mean a second copy of scopeFor to drift out of
// sync (see [[kpi-role-gate]] for what that costs).
//
// READ ONLY, and it stays that way. The fix is a photograph, taken in Shopify
// with the item in your hands — so a row carries the SKU and a link and nothing
// that pretends to act. See 0065 for why unpublished no-photo stock, which is
// 500× larger, is deliberately not in here.
async function photosFor(store: string) {
  const list = await rows(`listing_no_photos?store_code=eq.${encodeURIComponent(store)}`
    + `&select=sku,product_id,product_handle,title,price,quantity,product_created_at`
    // In stock first: the alarm is meant to be short, and when it is not, the
    // unit somebody can actually walk over and photograph is the one to do now.
    + `&order=quantity.desc,product_created_at.asc`);
  return list.map((r: any) => ({
    productId: r.product_id,
    sku: r.sku,
    title: r.title,
    handle: r.product_handle,
    price: r.price,
    quantity: r.quantity,
    listedAt: r.product_created_at,
    shop: SHOP_BY_STORE[store],
  }));
}

// One query for all five, tallied here — same reasoning as queueTotals.
async function photoTotals(stores: string[]): Promise<Record<string, number>> {
  const all = await rows(`listing_no_photos?select=store_code`);
  const out: Record<string, number> = {};
  for (const s of stores) out[s] = 0;
  for (const r of all) if (r.store_code in out) out[r.store_code] += 1;
  return out;
}
