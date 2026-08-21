// ============================================================================
// shopify-recat — files the `other` pile onto the right shelf.
//
// TWO WAYS IN, and they authenticate differently on purpose.
//
//   THE PANEL (SPEEKS Connect → Categories), x-user-pin:
//     GET  ?view=review&store=OVL      the queue, one row per product
//     GET  ?view=counts                per-store totals for both queues, and
//                                      nothing else — what the feed card polls
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
// default. FEATURE_KEY below is the same switch the Categories button reads, so
// the DM can hand the tool to an ASM in Feature Access and have it actually
// work, rather than granting a button that 403s (see [[kpi-role-gate]]).
const CORP_ROLES = ["district manager", "ceo", "mocd"];
const STORE_ROLES = ["manager", "owner (manager)", "owner manager", "multi-store manager"];
const MSM_STORES = ["BAL", "MPL"];

// The junk drawer we are emptying. A proposal always leaves this one.
// The Feature Access key of the Categories tab. One string, read by the button
// and by this function, so a grant cannot be half-made.
const FEATURE_KEY = "ec-view-categories";
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

type Scope = { name: string; role: string; stores: string[]; corp: boolean };

// An override row for this feature, resolved the way the site resolves it:
// the person beats their role, and neither existing means "use the default".
// Returns null for "nothing said".
async function featureSays(role: string, name: string): Promise<boolean | null> {
  const list = await rows(`feature_overrides?feature_key=eq.${FEATURE_KEY}`
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
  const byRole = corp || STORE_ROLES.includes(role);
  const said = await featureSays(role, String(user.name || ""));
  if (!(said === null ? byRole : said)) return null;
  // A granted role still only gets ITS OWN stock. Feature Access answers "may
  // this person file", never "whose catalogue" — that stays the store on their
  // user row, and corp is the only thing that means all five.
  const stores = corp ? STORES
    : role === "multi-store manager" ? MSM_STORES
    : [String(user.store || "").toUpperCase()].filter(s => STORES.includes(s));
  if (!stores.length) return null;
  return { name: user.name || "", role, stores, corp };
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

const queueFor = (store: string, mode: string) =>
  mode === "misfiled" ? misfiledFor(store) : proposalsFor(store);

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
// since title and collections are per product. A product that has since sold or
// been deleted has no row at all, and keeps just its id — the skip is still real
// and still undoable.
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
  return skips.map((s: any) => {
    const c = byId.get(s.product_id);
    return {
      ...s,
      sku: c?.sku ?? null,
      title: c?.title ?? null,
      // Where it is now, in words, `newly-listed-devices` excepted — that one is
      // every product at every store and says nothing about a category.
      in: (c?.collections || [])
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
    const queue = await queueFor(store, String(body.mode || ""));
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
    if (req.method === "POST" || view === "review" || view === "counts") {
      const scope = await scopeFor(pin);
      // A stale sessionStorage PIN outlives a PIN change and lands exactly here.
      if (!scope) {
        return json({ error: "unauthorized",
                      detail: "no matching user, or your role may not file stock" }, 401);
      }
      if (req.method === "POST") return await handlePost(req, scope);

      // JUST THE NUMBERS, for the notification check that every manager runs
      // on a timer. The review payload carries a whole store queue with it —
      // 90 rows to answer "is there anything to do", on every page, forever.
      if (view === "counts") {
        const [other, misfiled] = await Promise.all([
          queueTotals(scope.stores, "other"), queueTotals(scope.stores, "misfiled")]);
        return json({ scope: { name: scope.name, role: scope.role, stores: scope.stores, corp: scope.corp },
                      other, misfiled });
      }

      const asked = (url.searchParams.get("store") || "").toUpperCase();
      const store = scope.stores.includes(asked) ? asked : scope.stores[0];
      const mode = url.searchParams.get("mode") === "misfiled" ? "misfiled" : "other";
      const [queue, titles, shelves] = await Promise.all([
        queueFor(store, mode), shelfTitles(), matchableShelves()]);
      const skipped = await skippedFor(store, titles);
      // BOTH counts, for THIS STORE — they are the numbers on the two tabs, and a
      // tab that says 17 above a list of one is worse than no number at all. The
      // queue in hand is one of the two, so only the other mode costs a query.
      const otherModeTotal = (await queueTotals([store], mode === "other" ? "misfiled" : "other"))[store] || 0;
      return json({
        scope: { name: scope.name, role: scope.role, stores: scope.stores, corp: scope.corp },
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
          other: mode === "other" ? queue.length : otherModeTotal,
          misfiled: mode === "misfiled" ? queue.length : otherModeTotal,
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
  const view = mode === "misfiled" ? "collection_misfiled" : "collection_proposals";
  const all = await rows(`${view}?select=store_code`);
  const out: Record<string, number> = {};
  for (const s of stores) out[s] = 0;
  for (const r of all) if (r.store_code in out) out[r.store_code] += 1;
  return out;
}
