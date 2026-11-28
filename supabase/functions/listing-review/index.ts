// ============================================================================
// listing-review — the Fix Queue, Ethan's Spot Check, the overnight re-grade
// loop and the per-lister flag rate. Design: docs/listing-review-flow-design.md,
// approved by Ethan 2026-11-18. Tables: migration 0189.
//
// WHAT THIS FUNCTION OWNS AND WHAT IT DOES NOT. It owns the CARD (one per
// listing, listing_review_cards), the daily ten (listing_spot_checks), who
// listed what (listing_listers) and the flag ledger (listing_flags). It does
// NOT own a single finding: photo lines are picture_quality_reviews rows, title
// and label lines are listing_title_queue rows, category lines are the three
// collection_* views. The one-click fixes and the dismissals go to the tool
// that owns the line (picture-quality, listing-titles, shopify-recat) straight
// from the browser, so each keeps writing its own notes the way it always has.
// This function only READS those lines, to draw the card and to decide whether
// a fixed card is really fixed.
//
// TWO WAYS IN, the house posture (see shopify-recat):
//   PANEL, x-user-pin:
//     GET  ?view=queue&store=OVL        one store's cards
//     GET  ?view=counts                 open cards per store (the pill / card)
//     GET  ?view=spot[&store=OVL]       Ethan's daily ten, per store   (spot key)
//     GET  ?view=confirm                re-graded and passed           (spot key)
//     GET  ?view=flags&weeks=8          lister flag rate                (spot key)
//     POST {action:"mark-fixed"|"undo-fixed", store, productId}
//     POST {action:"mark-sold", store, productId}   it sold before it was fixed (0213)
//     POST {action:"mine-dismiss", store, productId, reason}   a lister's Not Wrong on their photo flag
//     POST {action:"spot-agree"|"spot-grade", id, ticks?, note?}       (spot key)
//     POST {action:"confirm"|"send-back", store, productId, note?}     (spot key)
//   SCHEDULE, ?secret= :
//     ?daily=1     6am CT — listers, flags, the day's pick. Free.
//     ?regrade=1   3:20am CT — submit fixed cards to the overnight Batch. PAID,
//                  so it does nothing unless LR_REGRADE_ON=1 (Ethan: confirm
//                  before it starts). ~5c a listing.
//     ?settle=1    4–10am CT — read what the re-grade said and move each card.
//     ?settle=1&fake=pass|fail&store=X&productId=… — TEST ONLY: settle one
//                  card as if the re-grade had answered. No model call.
// ============================================================================

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
// ⚠️ Must match FEATURE_CATALOG's `def` for these keys in speeks.js — a backend
// that says yes while the button says no is a tool reachable by URL nobody sees.
const FIX_KEY = "ec-view-fix-queue";
const FIX_ROLES = ["district manager", "ceo", "manager", "owner (manager)", "owner manager", "assistant manager"];
// ⚠️ ASMs KEEP THE STORE LIST but see only THEIR OWN full listing reviews
// (Ethan, 2026-11-24: "ASM's can still help with title, category and picture
// tool, but they should only see full listing reviews that pertain to just
// them"). A full-review card (Notes Only included) is hidden from an ASM unless
// it was sent to them; only managers see every one. See fullHidden().
const OWN_FULL_ONLY = ["assistant manager"];
const SPOT_KEY = "ec-view-spot-check";
const SPOT_ROLES = ["district manager", "ceo"];
// FULL LISTING REVIEW (0197): "let's just start with DM being the only person"
// (Ethan, 2026-11-21). ⚠️ Must match FEATURE_CATALOG's def for ec-view-full-review.
const FULL_KEY = "ec-view-full-review";
const FULL_ROLES = ["district manager"];
// MY FIXES (0204, Ethan 2026-11-23): a full-review send-back also goes to the
// team member who listed it. Employees by default — managers and ASMs already
// see every card on the store's list. ⚠️ Must match FEATURE_CATALOG's def for
// ec-view-my-fixes.
const MINE_KEY = "ec-view-my-fixes";
const MINE_ROLES = ["employee", "assistant manager"];
// The parts of a listing a full review can flag, besides its photos.
const FULL_PARTS = new Set(["Title", "Price", "Condition", "Category", "Cosmetic Notes", "Functionality",
  "What’s Included", "Not Included", "Description & Specs", "Listing Description"]);
const CORP_ROLES = ["district manager", "ceo", "mocd"];
// ⚠️ KEEP IN STEP with picture-quality's RECIPE: only the current recipe's
// verdicts are lines, the same rule the photo tool's own queue applies.
const PQ_RECIPE = "pq-v18";
const SPOT_N = 10;
const SPOT_DAYS = 7;       // a pass this old or newer can be picked
const LISTER_DAYS = 3;     // the daily job reads tags for listings this new

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function sb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`supabase ${path}: ${res.status} ${await res.text()}`);
  return res;
}
const rows = async (path: string) => await (await sb(path)).json();
// PostgREST stops at 1,000 rows whatever limit says — page it. `path` carries its own order.
async function allRows(path: string) {
  const out: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await rows(`${path}&limit=1000&offset=${offset}`);
    if (!Array.isArray(page)) throw new Error(`read failed: ${path}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}
const enc = encodeURIComponent;
const inList = (ids: string[]) => `(${ids.map(i => `"${String(i).replace(/"/g, "")}"`).join(",")})`;

function secretOk(url: URL): boolean {
  const given = url.searchParams.get("secret") || "";
  if (given.length !== SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < SECRET.length; i++) diff |= given.charCodeAt(i) ^ SECRET.charCodeAt(i);
  return diff === 0;
}

// The CT calendar day, as YYYY-MM-DD. The pick is "today's ten" in Kansas City.
function ctDay(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
// The Monday (CT) of the week a moment falls in — the flag ledger's week.
function ctMonday(at: string | Date): string {
  const day = ctDay(new Date(at));
  const d = new Date(day + "T12:00:00Z");
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// --- who is asking -------------------------------------------------------------

type Scope = { name: string; role: string; stores: string[]; corp: boolean; mayFix: boolean; maySpot: boolean; mayFull: boolean; mayMine: boolean; test: boolean };

async function featureSays(key: string, role: string, name: string): Promise<boolean | null> {
  const list = await rows(`feature_overrides?feature_key=eq.${enc(key)}&select=subject_type,subject,enabled`);
  const lc = (v: unknown) => String(v || "").toLowerCase().trim();
  const slug = lc(role).replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-");
  const forUser = list.find((r: any) => lc(r.subject_type) === "user" && lc(r.subject) === lc(name));
  if (forUser) return !!forUser.enabled;
  const forRole = list.find((r: any) => lc(r.subject_type) === "role" && lc(r.subject) === slug);
  if (forRole) return !!forRole.enabled;
  return null;
}

// A TEST ACCOUNT (0160) may read with its own role and store; every write from
// one is refused (`test` on the scope), the same as everywhere else.
async function scopeFor(pin: string): Promise<Scope | null> {
  if (!pin) return null;
  let test = false;
  let user = (await rows(`users?pin=eq.${enc(pin)}&select=name,role,store&limit=1`))?.[0];
  if (!user) { user = (await rows(`test_users?pin=eq.${enc(pin)}&select=name,role,store&limit=1`))?.[0]; test = !!user; }
  if (!user) return null;
  const role = String(user.role || "").toLowerCase().trim();
  const name = String(user.name || "");
  const [saidFix, saidSpot, saidFull, saidMine] = await Promise.all([featureSays(FIX_KEY, role, name), featureSays(SPOT_KEY, role, name),
    featureSays(FULL_KEY, role, name), featureSays(MINE_KEY, role, name)]);
  const mayMine = saidMine === null ? MINE_ROLES.includes(role) : saidMine;
  const mayFull = saidFull === null ? FULL_ROLES.includes(role) : saidFull;
  const mayFix = saidFix === null ? FIX_ROLES.includes(role) : saidFix;
  const maySpot = saidSpot === null ? SPOT_ROLES.includes(role) : saidSpot;
  if (!mayFix && !maySpot && !mayFull && !mayMine) return null;
  const corp = CORP_ROLES.includes(role);
  const stores = corp ? STORES : [String(user.store || "").toUpperCase()].filter(s => STORES.includes(s));
  if (!stores.length) return null;
  return { name, role, stores, corp, mayFix, maySpot, mayFull, mayMine, test };
}

// --- shopify ---------------------------------------------------------------------

async function shopFor(store: string) {
  const all = await rows(`shopify_stores?select=shop,store_code,access_token`);
  const t = all.find((r: any) => r.store_code === store) || all.find((r: any) => r.shop === SHOP_BY_STORE[store]);
  if (!t) throw new Error(`no shopify_stores row for ${store}`);
  return { shop: t.shop as string, token: t.access_token as string };
}
async function gql(shop: string, token: string, query: string, variables?: unknown) {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`shopify: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data;
}

type Mini = { id: string; title: string; handle: string; sku: string; price: number; tags: string[]; createdAt: string;
              photos: { thumb: string; url: string }[] };
// What a card needs from Shopify, 25 at a time: the photos in their CURRENT
// order (a card about photo order is useless with stale thumbnails), the price
// and the tags. Read live, never stored, like the photo tool's own queue.
async function minis(store: string, ids: string[], withPhotos = true): Promise<Map<string, Mini>> {
  const out = new Map<string, Mini>();
  if (!ids.length) return out;
  const { shop, token } = await shopFor(store);
  const media = withPhotos ? `media(first: 30) { nodes { ... on MediaImage { image {
      thumb: url(transform: { maxWidth: 240, maxHeight: 240 })
      big: url(transform: { maxWidth: 1200, maxHeight: 1200 }) } } } }` : "";
  const q = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product {
      id title handle tags createdAt variants(first: 1) { nodes { sku price } } ${media} } } }`;
  for (let i = 0; i < ids.length; i += 25) {
    const data = await gql(shop, token, q, { ids: ids.slice(i, i + 25) });
    for (const p of (data?.nodes || []).filter(Boolean)) {
      out.set(p.id, {
        id: p.id, title: p.title || "", handle: p.handle || "",
        sku: p.variants?.nodes?.[0]?.sku || "", price: Number(p.variants?.nodes?.[0]?.price || 0),
        tags: Array.isArray(p.tags) ? p.tags.map(String) : [], createdAt: p.createdAt || "",
        photos: (p.media?.nodes || []).filter((n: any) => n?.image).map((n: any) => ({ thumb: n.image.thumb, url: n.image.big })),
      });
    }
  }
  return out;
}

// THE WHOLE LISTING (Ethan, 2026-11-21): photos, every field, the category and
// the description — for View Listing on every tool, and for Full Listing Review.
// The description goes back as Shopify holds it; the browser cleans it to an
// allow-list of tags before showing it (_lrCleanHtml), never as raw HTML.
const asList = (v: unknown) => { const t = String(v || "").trim();
  if (t.startsWith("[")) { try { return (JSON.parse(t) as unknown[]).join(", "); } catch { /* as is */ } } return t; };
const plain = (v: unknown) => String(v || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();
async function fullListing(store: string, pid: string) {
  const { shop, token } = await shopFor(store);
  const q = `query($id: ID!) { product(id: $id) {
      id title handle tags createdAt descriptionHtml onlineStoreUrl
      variants(first: 1) { nodes { sku price } }
      collections(first: 12) { nodes { title } }
      condition: metafield(namespace: "custom", key: "condition") { value }
      cosmetic: metafield(namespace: "custom", key: "cosmetic_condition") { value }
      functional: metafield(namespace: "custom", key: "functionality_condition") { value }
      included: metafield(namespace: "custom", key: "whats_include") { value }
      notIncluded: metafield(namespace: "custom", key: "not_included") { value }
      media(first: 40) { nodes { ... on MediaImage { image {
        thumb: url(transform: { maxWidth: 240, maxHeight: 240 })
        big: url(transform: { maxWidth: 1200, maxHeight: 1200 }) } } } } } }`;
  const p = (await gql(shop, token, q, { id: pid }))?.product;
  if (!p) return null;
  // ⚠️ ALREADY FLAGGED (Ethan, 2026-11-23): "if the system ever misses a flag … it
  // shouldn't let me flag it if it's already been flagged, just so things don't
  // get confused." A title the Title Check has open (Wrong / Hard To Find) is
  // not flagged twice. A store's dismissal re-opens it to him — his send-back
  // then keeps the flag. Photos: the Photo Check's open lines are shown, but
  // his eye tags (angle, framing, a dirty table) are not what it checks, so
  // photos stay flaggable.
  const [tq, pq] = await Promise.all([
    rows(`listing_title_reviews?store_code=eq.${store}&product_id=eq.${enc(pid)}&status=eq.open&severity=gte.2&select=severity,suggested_title&limit=1`),
    rows(`picture_quality_reviews?store_code=eq.${store}&product_id=eq.${enc(pid)}&status=eq.open&verdict=in.(retake,fix,reorder)&select=verdict,findings&limit=1`),
  ]);
  const already = {
    title: tq[0] ? `The Title Check already flagged this title (${tq[0].severity === 3 ? "The Title Is Wrong" : "Hard To Find"}) — it is on the store's list.` : null,
    photos: pq[0] ? `The Photo Check already flagged these photos: ${(pq[0].findings || []).map((f: any) => String(f.text || "")).filter(Boolean).join(" ") || pq[0].verdict}` : null,
  };
  const ix = await loadListerIx();
  const hit = listerFrom(Array.isArray(p.tags) ? p.tags : [], ix, store);
  return {
    store, productId: p.id, title: p.title || "", handle: p.handle || "", live: !!p.onlineStoreUrl,
    sku: p.variants?.nodes?.[0]?.sku || "", price: Number(p.variants?.nodes?.[0]?.price || 0),
    createdAt: p.createdAt || null, lister: hit?.name || rawListerTag(p.tags || []) || null,
    photos: (p.media?.nodes || []).filter((n: any) => n?.image).map((n: any) => ({ thumb: n.image.thumb, url: n.image.big })),
    category: (p.collections?.nodes || []).map((c: any) => c.title).filter((t: string) => t && !/^(all|home ?page|new arrivals?|newly listed( devices)?)$/i.test(t)),
    condition: asList(p.condition?.value), cosmetic: plain(p.cosmetic?.value), functional: plain(p.functional?.value),
    included: asList(p.included?.value), notIncluded: asList(p.notIncluded?.value),
    descriptionHtml: String(p.descriptionHtml || "").slice(0, 60000),
    shop: SHOP_BY_STORE[store], already,
  };
}

// The listings a full review picks from: a store's newest first (or a search),
// each with when it was last reviewed and whether it is sent back now.
async function fullList(store: string, q: string, test = false) {
  const term = q.replace(/[^\w\s.-]/g, " ").trim().slice(0, 60);
  let list: any[];
  let pickDay: string | null = null;
  if (term) {
    const cat = await rows(`ebay_catalog?store_code=eq.${store}&quantity=gt.0&or=(sku.ilike.*${enc(term)}*,title.ilike.*${enc(term)}*)`
      + `&select=product_id,sku,title,price,product_created_at&order=product_created_at.desc&limit=120`);
    list = [...new Map(cat.map((c: any) => [c.product_id, c])).values()].slice(0, 60) as any[];
  } else {
    // THE DAILY TEN (0202): the newest day's picks, then any older pick not yet
    // reviewed (two weeks back at most) — "whatever I might have missed".
    const since = ctDay(new Date(Date.now() - 14 * 86400000));
    const picks = await rows(`listing_full_picks?store_code=eq.${store}&day=gte.${since}`
      + `&select=day,product_id,sku,title,price,rank&order=day.desc,rank.asc&limit=200`);
    pickDay = picks[0]?.day || null;
    const done = new Set((picks.length ? await rows(`listing_full_reviews?store_code=eq.${store}&test=is.${test}&product_id=in.${inList(picks.map((x: any) => x.product_id))}&select=product_id`) : [])
      .map((r: any) => r.product_id));
    list = picks.filter((x: any) => x.day === pickDay || !done.has(x.product_id))
      .map((x: any) => ({ product_id: x.product_id, sku: x.sku, title: x.title, price: x.price, day: x.day, missed: x.day !== pickDay }));
    const made = list.length ? await rows(`ebay_catalog?store_code=eq.${store}&product_id=in.${inList(list.map(c => c.product_id))}&select=product_id,product_created_at`) : [];
    const at = new Map<string, string>(made.map((m: any) => [m.product_id, m.product_created_at]));
    for (const c of list) c.product_created_at = at.get(c.product_id) || null;
  }
  const ids = list.map(c => c.product_id);
  const [reviews, cards, listers] = ids.length ? await Promise.all([
    rows(`listing_full_reviews?store_code=eq.${store}&test=is.${test}&product_id=in.${inList(ids)}&select=product_id,result,reviewed_at&order=reviewed_at.desc`),
    rows(`${CARDS(test)}?store_code=eq.${store}&product_id=in.${inList(ids)}&status=neq.done&select=product_id,status`),
    rows(`listing_listers?store_code=eq.${store}&product_id=in.${inList(ids)}&select=product_id,lister_name,lister_tag`),
  ]) : [[], [], []];
  const last = new Map<string, any>(); for (const r of reviews) if (!last.has(r.product_id)) last.set(r.product_id, r);
  const open = new Set(cards.map((c: any) => c.product_id));
  const who = new Map<string, any>(listers.map((l: any) => [l.product_id, l]));
  // First photo of each, in one light read.
  const thumbs = new Map<string, string>();
  try {
    const { shop, token } = await shopFor(store);
    for (let i = 0; i < ids.length; i += 50) {
      const d = await gql(shop, token, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id
        media(first: 1) { nodes { ... on MediaImage { image { url(transform: { maxWidth: 120, maxHeight: 120 }) } } } } } } }`, { ids: ids.slice(i, i + 50) });
      for (const n of (d?.nodes || []).filter(Boolean)) { const u = n.media?.nodes?.[0]?.image?.url; if (u) thumbs.set(n.id, u); }
    }
  } catch { /* rows still list without a picture */ }
  return { store, q: term, pickDay, items: list.map(c => ({
    productId: c.product_id, sku: c.sku, title: c.title, price: c.price, createdAt: c.product_created_at,
    day: c.day || null, missed: !!c.missed,
    lister: who.get(c.product_id)?.lister_name || who.get(c.product_id)?.lister_tag || null,
    thumb: thumbs.get(c.product_id) || null,
    reviewed: last.get(c.product_id) ? { result: last.get(c.product_id).result, at: last.get(c.product_id).reviewed_at } : null,
    onList: open.has(c.product_id),
  })) };
}

// --- who listed it -----------------------------------------------------------------
// ⚠️ COPIED from picture-quality (which copied it from listing-titles) — the
// functions share no module. Read the long comments there; keep all three in step.
const squashName = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
type ListerIx = { byStore: Record<string, Record<string, string>>; all: Record<string, string> };
function listerIndex(users: { name: string; role?: string; store?: string }[]): ListerIx {
  const up = (u: any) => String(u?.store || "").trim().toUpperCase();
  const byStore: Record<string, Record<string, string>> = {};
  for (const st of new Set(users.map(up).filter(s => s && s !== "CORP"))) {
    byStore[st] = indexOf(users.filter(u => up(u) === st || up(u) === "CORP"), st);
  }
  return { byStore, all: indexOf(users, null) };
}
function indexOf(users: { name: string; role?: string; store?: string }[], home: string | null) {
  const ix: Record<string, string> = {}, local: Record<string, boolean> = {};
  for (const u of users) {
    const full = String(u?.name || "").trim();
    if (String(u?.role || "").trim().toLowerCase() === "store" || /\bteam$/i.test(full)) continue;
    const parts = full.split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const first = parts[0], last = parts[parts.length - 1];
    for (const form of [first[0] + last, first + last, first + last[0]]) {
      const k = squashName(form);
      if (k.length < 3) continue;
      const isLocal = home !== null && String(u?.store || "").trim().toUpperCase() === home;
      if (!(k in ix)) { ix[k] = full; local[k] = isLocal; continue; }
      if (ix[k] === full) continue;
      if (isLocal && !local[k]) { ix[k] = full; local[k] = true; }
      else if (isLocal === local[k]) ix[k] = "";
    }
  }
  return ix;
}
// + checkout: a workflow tag seen on LEE listings 2026-11-18, read as a lister. Only here so far.
const NOT_A_PERSON = /^(ebay|inv|market|pickuponly|pendingoffer|b2b|rcy|new|used|sale|read|no|yes|local|shipped|hold|checkout)$/i;
function rawListerTag(tags: string[]): string | null {
  return tags.map(t => String(t || "").trim()).find(t => /^[a-z][a-z'.-]{2,}$/i.test(t) && !NOT_A_PERSON.test(t)) || null;
}
function listerFrom(tags: string[], ix: ListerIx, store: string): { tag: string; name: string } | null {
  for (const table of [ix.byStore[store], ix.all]) {
    if (!table) continue;
    for (const t of tags) {
      const raw = String(t || "").trim();
      const hit = raw && table[squashName(raw)];
      if (hit) return { tag: raw, name: hit };
    }
  }
  return null;
}
const loadListerIx = async () => listerIndex(await rows("users?select=name,role,store").catch(() => []) || []);

// --- the lines -------------------------------------------------------------------------
// Everything open against a store's listings, from the three tools, keyed by
// product id. One read per source per store.

type Line = { kind: "photos" | "title" | "label" | "category" | "ethan"; [k: string]: unknown };

async function photoLines(store: string): Promise<Map<string, any>> {
  const pq = await rows(`picture_quality_reviews?store_code=eq.${store}&status=eq.open`
    + `&verdict=in.(retake,fix,reorder)&stamp=like.${PQ_RECIPE}:*`
    + `&select=product_id,sku,title,verdict,findings,reorder,deletion,sheet_name,sheet_slug,reviewed_at,lister_name&limit=1000`);
  return new Map(pq.map((r: any) => [r.product_id, r]));
}
async function titleLines(store: string): Promise<Map<string, any>> {
  const lt = await rows(`listing_title_queue?store_code=eq.${store}`
    + `&select=product_id,sku,current_title,suggested_title,findings,severity,ebay_title,lister_tag,basis,price&limit=1000`);
  return new Map(lt.map((r: any) => [r.product_id, r]));
}
async function categoryLines(store: string): Promise<Map<string, any>> {
  const [other, misfiled, unmatched, shelves] = await Promise.all([
    rows(`collection_proposals?store_code=eq.${store}&select=product_id,sku,title,keyword,target_handle&limit=1000`),
    rows(`collection_misfiled?store_code=eq.${store}&select=product_id,sku,title,keyword,target_handle,wrong_handles&limit=1000`),
    rows(`collection_unmatched?store_code=eq.${store}&select=product_id,sku,title&limit=1000`),
    rows(`shopify_collections?select=handle,title`),
  ]);
  const name = new Map<string, string>(shelves.map((s: any) => [s.handle, s.title]));
  const out = new Map<string, any>();
  for (const p of other) out.set(p.product_id, { mode: "other", sku: p.sku, title: p.title, rule: p.keyword, to: p.target_handle,
    toTitle: name.get(p.target_handle) || p.target_handle, from: ["Other"] });
  for (const p of misfiled) out.set(p.product_id, { mode: "misfiled", sku: p.sku, title: p.title, rule: p.keyword, to: p.target_handle,
    toTitle: name.get(p.target_handle) || p.target_handle, from: (p.wrong_handles || []).map((h: string) => name.get(h) || h) });
  for (const p of unmatched) if (!out.has(p.product_id)) out.set(p.product_id, { mode: "unmatched", sku: p.sku, title: p.title, from: ["Other"] });
  return out;
}

// A title row whose name finding came from the LABEL CHECK (listing-titles,
// source "label") is a label catch: same approve, its own word on the card.
const isLabel = (t: any) => (t?.findings || []).some((f: any) => f?.source === "label" || f?.photo?.source === "label");

function linesFor(pid: string, pq: any, lt: any, cat: any, card: any): Line[] {
  const out: Line[] = [];
  if (pq) out.push({ kind: "photos", verdict: pq.verdict, findings: pq.findings || [], reorder: pq.reorder || null,
                     deletion: pq.deletion || null, sheet: pq.sheet_name || null, sheetSlug: pq.sheet_slug || null,
                     // PHOTO FIXES GO TO THE LISTER TOO (Ethan, 2026-11-24: "treated the
                     // exact same way as the manual listing review") — who, for the
                     // manager's "Also sent to …" line. Null: the manager's alone.
                     sentTo: pq.lister_name || null });
  if (lt) out.push({ kind: isLabel(lt) ? "label" : "title", severity: lt.severity, current: lt.current_title,
                     suggested: lt.suggested_title, findings: lt.findings || [], ebayTitle: lt.ebay_title || null });
  if (cat) out.push({ kind: "category", ...cat });
  if (card?.ticks && card.status !== "done") out.push({ kind: "ethan", ticks: card.ticks });
  return out;
}

// --- views ---------------------------------------------------------------------------------

async function queueView(scope: Scope, asked: string) {
  const store = scope.stores.includes(asked) ? asked : scope.stores[0];
  const [pq, lt, cat, cardsRaw, noPhotos] = await Promise.all([
    photoLines(store), titleLines(store), categoryLines(store),
    rows(`${CARDS(scope.test)}?store_code=eq.${store}&status=neq.done&select=*`),
    rows(`listing_no_photos?store_code=eq.${store}&select=product_id,sku,title,price,product_handle,product_created_at&order=product_created_at.desc&limit=200`).catch(() => []),
  ]);
  const cards = new Map<string, any>(cardsRaw.filter((c: any) => !fullHidden(scope, c)).map((c: any) => [c.product_id, c]));
  const ids = [...new Set([...pq.keys(), ...lt.keys(), ...cat.keys(), ...cards.keys()])];
  const shop = await minis(store, ids).catch(() => new Map<string, Mini>());
  const ix = await loadListerIx();
  const open: any[] = [], waiting: any[] = [];
  for (const pid of ids) {
    const card = cards.get(pid) || null;
    const lines = linesFor(pid, pq.get(pid), lt.get(pid), cat.get(pid), card);
    const m = shop.get(pid);
    const waitingNow = card && ["fixed", "regrading", "confirm"].includes(card.status);
    // A card nothing is wrong with and nobody is waiting on is not a card.
    if (!lines.length && !waitingNow) continue;
    const lister = m ? listerFrom(m.tags, ix, store) : null;
    const c = {
      productId: pid,
      sku: m?.sku || pq.get(pid)?.sku || lt.get(pid)?.sku || cat.get(pid)?.sku || card?.sku || "",
      title: m?.title || pq.get(pid)?.title || lt.get(pid)?.current_title || cat.get(pid)?.title || card?.title || "",
      price: m?.price ?? lt.get(pid)?.price ?? card?.price ?? null,
      handle: m?.handle || "", createdAt: m?.createdAt || null,
      lister: lister?.name || (m ? rawListerTag(m.tags) : null) || lt.get(pid)?.lister_tag || card?.lister_tag || null,
      photos: m?.photos || [],
      lines,
      card: card ? { status: card.status, round: card.round, returnedKind: card.returned_kind, returnedNote: card.returned_note,
                     returnedBy: card.returned_by, returnedAt: card.returned_at, fixedBy: card.fixed_by, fixedAt: card.fixed_at,
                     regrade: card.regrade, assignedTo: card.assigned_to || null, assigneeSeenAt: card.assignee_seen_at || null } : null,
    };
    (waitingNow ? waiting : open).push(c);
  }
  // THE WHOLE GUIDE under a photo fix, as the example to shoot against (Ethan,
  // 2026-11-20: "show the whole guide underneath as an example for the user,
  // just like it used to"). One read of the guide for the whole store.
  if ([...open, ...waiting].some(c => c.lines.some((l: any) => l.kind === "photos"))) {
    const guides = await sheetGuides();
    for (const c of [...open, ...waiting]) for (const l of c.lines as any[]) {
      if (l.kind === "photos") l.guide = guides.get(l.sheetSlug) || guides.get(l.sheet) || [];
    }
  }
  // Sent back first (Ethan's, then a failed re-grade), then HIGHEST PRICE FIRST
  // (Ethan picked the list-and-detail design, 2026-11-18: the list reads
  // "Highest price first" — the expensive listing is the one worth fixing now).
  const rank = (c: any) => c.card?.status === "open" && c.card?.returnedKind
    ? ({ spot: 0, confirm: 1, regrade: 2 } as any)[c.card.returnedKind] ?? 3 : 4;
  open.sort((a, b) => rank(a) - rank(b) || (Number(b.price) || 0) - (Number(a.price) || 0));
  waiting.sort((a, b) => String(b.card?.fixedAt || "").localeCompare(String(a.card?.fixedAt || "")));
  return {
    scope: { name: scope.name, role: scope.role, stores: scope.stores, corp: scope.corp, mayFix: scope.mayFix, maySpot: scope.maySpot },
    store, open, waiting,
    fixedToday: (await fixedTodayFor([store], scope.test))[store] || 0,
    // The categories a listing in "Other" can be moved to — shopify-recat's own
    // list (matchable collections), so the move it is asked to make is one it
    // will accept.
    shelves: open.some((c: any) => c.lines.some((l: any) => l.kind === "category"))
      ? (await rows(`shopify_collections?matchable=is.true&select=handle,title&order=title`)).map((c: any) => ({ handle: c.handle, title: c.title }))
      : [],
    noPhotos: noPhotos.map((r: any) => ({ productId: r.product_id, sku: r.sku, title: r.title, price: r.price, handle: r.product_handle })),
    shop: SHOP_BY_STORE[store],
    // The 5-minute picture check (0206) re-grades a re-shot listing by itself, so
    // with it on, a card marked fixed is rechecked without the overnight batch.
    regradeOn: Deno.env.get("LR_REGRADE_ON") === "1" || Deno.env.get("PQ_QUICK_ON") === "1",
  };
}

// Open cards per store, for the Listing Health pill and the All Stores card.
// The same rule as the queue (a listing with any open line, or a returned card),
// without the Shopify read.
async function countsView(scope: Scope) {
  const counts: Record<string, number> = {};
  await Promise.all(scope.stores.map(async st => {
    const [pq, lt, cat, cardsAll] = await Promise.all([photoLines(st), titleLines(st), categoryLines(st),
      rows(`${CARDS(scope.test)}?store_code=eq.${st}&status=neq.done&select=product_id,status,ticks,returned_kind,assigned_to`)]);
    const cards = cardsAll.filter((c: any) => !fullHidden(scope, c));
    const waiting = new Set(cards.filter((c: any) => c.status !== "open").map((c: any) => c.product_id));
    const ids = new Set([...pq.keys(), ...lt.keys(), ...cat.keys(),
      ...cards.filter((c: any) => c.status === "open" && c.ticks).map((c: any) => c.product_id)]);
    counts[st] = [...ids].filter(id => !waiting.has(id)).length;
  }));
  return { scope: { stores: scope.stores }, counts };
}

// Midnight in Kansas City, as an instant — "today" on every count below.
function ctMidnightIso(): string {
  const now = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now).map(x => [x.type, x.value]));
  const into = ((Number(p.hour) % 24) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000;
  return new Date(now.getTime() - into - now.getMilliseconds()).toISOString();
}

// FIXED TODAY, per store: listings any of the four ways a fix happens touched
// since midnight CT — a card marked fixed, a title approved, a photo order or
// deletion approved, a category filed. One listing counts once.
async function fixedTodayFor(stores: string[], test = false): Promise<Record<string, number>> {
  const since = ctMidnightIso(), sIn = `store_code=in.(${stores.join(",")})`;
  const [cards, titles, photos, cats] = await Promise.all([
    rows(`${CARDS(test)}?${sIn}&fixed_at=gte.${since}&select=store_code,product_id&limit=1000`),
    rows(`listing_title_moves?${sIn}&applied_at=gte.${since}&select=store_code,product_id&limit=1000`),
    rows(`picture_quality_reviews?${sIn}&status=eq.applied&decided_at=gte.${since}&select=store_code,product_id&limit=1000`),
    rows(`collection_moves?${sIn}&applied_at=gte.${since}&undone_at=is.null&select=store_code,product_id&limit=1000`),
  ]);
  const seen: Record<string, Set<string>> = {};
  for (const r of [...cards, ...titles, ...photos, ...cats]) (seen[r.store_code] ||= new Set()).add(r.product_id);
  return Object.fromEntries(stores.map(s => [s, seen[s]?.size || 0]));
}

// THE DM'S TODAY PAGE (Ethan picked design "DM · Today", 2026-11-18): one tile
// per store, the two jobs (Spot Check, Confirm Fixes) with their counts, the
// most-flagged listers this week and how the checks are doing. One request.
async function todayView(scope: Scope) {
  const [counts, fixed, cards, spot, confirm, flags] = await Promise.all([
    countsView(scope), fixedTodayFor(scope.stores, scope.test),
    rows(`${CARDS(scope.test)}?store_code=in.(${scope.stores.join(",")})&status=eq.open&returned_kind=not.is.null&select=store_code`),
    rows(`listing_spot_checks?store_code=in.(${scope.stores.join(",")})&day=gte.${ctDay(new Date(Date.now() - 6 * 86400000))}&select=store_code,day,result&limit=1000`),
    rows(`${CARDS(scope.test)}?store_code=in.(${scope.stores.join(",")})&status=eq.confirm&select=store_code`),
    flagsView(scope, 1),
  ]);
  const latest: Record<string, string> = {};
  for (const s of spot) if (!latest[s.store_code] || s.day > latest[s.store_code]) latest[s.store_code] = s.day;
  const stores = scope.stores.map(st => ({
    store: st, toFix: counts.counts[st] || 0, fixedToday: fixed[st] || 0,
    sentBack: cards.filter((c: any) => c.store_code === st).length,
    spotLeft: spot.filter((s: any) => s.store_code === st && s.day === latest[st] && s.result === "pending").length,
    spotTotal: spot.filter((s: any) => s.store_code === st && s.day === latest[st]).length,
  }));
  const listers = flags.rows.filter((r: any) => r.listed >= 5 && r.lister !== "Unknown")
    .sort((a: any, b: any) => (b.rate ?? 0) - (a.rate ?? 0)).slice(0, 8);
  return { scope: { name: scope.name, stores: scope.stores }, day: ctDay(), stores,
           spotLeft: stores.reduce((n, s) => n + s.spotLeft, 0), confirm: confirm.length,
           listers, checkers: flags.checkers,
           spotNotes: (await spotNotesWaiting(scope.stores)).length };
}

// ⚠️ ONLY SEND-BACKS THE PHOTO CHECK MISSED (Ethan, 2026-11-19, on his first
// real one — angle and a dirty table: "should that even be in there? … I'm not
// copying that one for Claude, since it just had to do with stuff that you
// don't check for"). A send-back made only of Angle / Framing / Dirty Table is
// not a rule to fix; it comes back to him through Confirm Fixes as Check By
// Eye once the store marks it fixed. So it never waits here, never counts, and
// never raises the feed card.
async function spotNotesWaiting(stores: string[]): Promise<any[]> {
  const all = await rows(`listing_spot_checks?store_code=in.(${stores.join(",")})&result=eq.graded&triaged_at=is.null&select=*&order=decided_at.desc&limit=500`);
  return all.filter((w: any) => missedBy(w.ticks).length > 0);
}

// SPOT CHECK NOTES (0190): every listing Ethan sent back from the spot check,
// waiting until he clears it, plus the last 30 days of cleared ones — the same
// shape as Listing Health Notes. The ask is built here, next to the data it
// quotes, so the popup only copies it.
async function spotNotesView(scope: Scope) {
  const sIn = `store_code=in.(${scope.stores.join(",")})`;
  const [waiting, done] = await Promise.all([
    spotNotesWaiting(scope.stores),
    rows(`listing_spot_checks?${sIn}&result=eq.graded&triaged_at=gte.${new Date(Date.now() - 30 * 86400000).toISOString()}&select=id,store_code,product_id,sku,title,note,triaged_at&order=triaged_at.desc&limit=100`),
  ]);
  const pq = waiting.length ? await rows(`picture_quality_reviews?product_id=in.${inList(waiting.map((w: any) => w.product_id))}`
    + `&select=product_id,sheet_name,verdict,findings,stamp,reviewed_at`) : [];
  const pqOf = new Map<string, any>(pq.map((r: any) => [r.product_id, r]));
  const items = waiting.map((w: any) => {
    const r = pqOf.get(w.product_id);
    return { id: w.id, store: w.store_code, productId: w.product_id, sku: w.sku, title: w.title, price: w.price,
             lister: w.lister_tag, ticks: w.ticks, note: w.note, by: w.decided_by, at: w.decided_at,
             missed: missedBy(w.ticks), sheet: r?.sheet_name || null, recipe: String(r?.stamp || "").split(":")[0] || null,
             checkerSaid: (r?.findings || []).map((f: any) => f?.text).filter(Boolean) };
  });
  // Grouped by which check missed it — three photo misses on one sheet is a
  // rule to go and write; one is an anecdote.
  const groups: Record<string, any[]> = { photos: [] };
  for (const it of items) for (const m of it.missed) (groups[m] ||= []).push(it);
  const label: Record<string, string> = { photos: "Photo check (picture-quality, rules.ts)" };
  const ask = !items.length ? "" : [
    "These listings PASSED SPEEKSNET's automatic listing checks, and on my daily spot check I disagreed: each one should have been flagged.",
    "For each group, work out WHY the check passed it — read the listing in Shopify (link given) and the rule that should have caught it — and say what rule change would catch it without flagging good listings.",
    "Give the reasoning and the proposed change before changing any rule. Do not re-grade anything (paid) without asking me first.",
    "",
    ...Object.entries(groups).filter(([, g]) => g.length).flatMap(([k, g]) => [
      `## ${label[k]} — ${g.length} missed`,
      ...g.map((it: any) => [
        `- ${it.store} ${it.sku || ""} — ${it.title || ""} (${it.price != null ? "$" + it.price : "no price"})`,
        `  Shopify: https://admin.shopify.com/store/${(SHOP_BY_STORE[it.store] || "").replace(".myshopify.com", "")}/products/${String(it.productId).split("/").pop()}`,
        it.sheet ? `  Guide sheet: ${it.sheet}${it.recipe ? " (graded " + it.recipe + ")" : ""}` : "",
        `  What I found: ${ticksSay(it.ticks) || "—"}`,
        // Each tagged photo's own picture, so Claude looks at what Ethan looked at.
        ...((it.ticks?.photos || []).filter((ph: any) => ph.thumb).map((ph: any) => `  Photo ${ph.n} image: ${ph.thumb}`)),
        it.note ? `  My note: "${it.note}"` : "",
        it.checkerSaid.length ? `  The photo check said: ${it.checkerSaid.join(" ")}` : "  The photo check said nothing was wrong.",
      ].filter(Boolean).join("\n")),
      "",
    ]),
  ].join("\n");
  return { scope: { stores: scope.stores }, total: items.length, items,
           done: done.map((d: any) => ({ id: d.id, store: d.store_code, productId: d.product_id, sku: d.sku, title: d.title, note: d.note, takenAt: d.triaged_at })),
           ask };
}

// The sheet's required shots, by sheet name or slug — the ticks on Grade It Myself.
async function sheetShots(): Promise<Map<string, string[]>> {
  const cats = await rows(`pg_categories?active=eq.true&select=id,slug,name`);
  const shots = await rows(`pg_shots?select=category_id,label,sort_order&order=sort_order`);
  const out = new Map<string, string[]>();
  for (const c of cats) {
    // A repeatable shot (Extra Accessories) appears once per slot; one tick is enough.
    const mine = [...new Set<string>(shots.filter((s: any) => s.category_id === c.id).map((s: any) => String(s.label)))];
    out.set(c.slug, mine); out.set(c.name, mine);
  }
  return out;
}

// The guide itself, slot by slot, with its example photo — the Guide Order strip
// on the spot check (Ethan, 2026-11-18: "I like the guide order having the
// pictures like before"). Public object URLs, never the image-transform
// endpoint: Pro has 100 transforms a cycle and a 10-11 script tripped the cap.
async function sheetGuides(): Promise<Map<string, { label: string; img: string | null; cond: string | null }[]>> {
  const cats = await rows(`pg_categories?active=eq.true&select=id,slug,name`);
  const shots = await rows(`pg_shots?select=category_id,label,cond_label,image_path,sort_order&order=sort_order`);
  const out = new Map<string, { label: string; img: string | null; cond: string | null }[]>();
  for (const c of cats) {
    const mine = shots.filter((x: any) => x.category_id === c.id).map((x: any) => ({
      label: String(x.label), cond: x.cond_label || null,
      img: x.image_path ? `${SUPABASE_URL}/storage/v1/object/public/picture-guide/${encodeURIComponent(x.image_path)}` : null }));
    out.set(c.slug, mine); out.set(c.name, mine);
  }
  return out;
}

async function spotView(scope: Scope, asked: string) {
  const stores = scope.stores.includes(asked) ? [asked] : scope.stores;
  // The latest pick per store — today's once 6am has run, yesterday's before.
  const picks = await rows(`listing_spot_checks?store_code=in.(${stores.join(",")})&day=gte.${ctDay(new Date(Date.now() - 6 * 86400000))}`
    + `&select=*&order=day.desc,rank.asc&limit=500`);
  const latest: Record<string, string> = {};
  for (const p of picks) if (!latest[p.store_code]) latest[p.store_code] = p.day;
  const [shots, guides] = await Promise.all([sheetShots(), sheetGuides()]);
  const pqRows = picks.length ? await rows(`picture_quality_reviews?product_id=in.${inList(picks.map((p: any) => p.product_id))}`
    + `&select=product_id,sheet_slug,sheet_name,verdict`) : [];
  const sheetOf = new Map<string, any>(pqRows.map((r: any) => [r.product_id, r]));
  const out: Record<string, any> = {};
  for (const st of stores) {
    const mine = picks.filter((p: any) => p.store_code === st && p.day === latest[st]);
    const shop = await minis(st, mine.map((p: any) => p.product_id)).catch(() => new Map<string, Mini>());
    out[st] = {
      day: latest[st] || null,
      items: mine.map((p: any) => {
        const m = shop.get(p.product_id), pr = sheetOf.get(p.product_id);
        return {
          id: p.id, productId: p.product_id, sku: m?.sku || p.sku, title: m?.title || p.title, price: p.price,
          handle: m?.handle || "", lister: p.lister_tag, rank: p.rank, result: p.result, ticks: p.ticks, note: p.note,
          decidedBy: p.decided_by, decidedAt: p.decided_at, photos: m?.photos || [],
          sheet: pr?.sheet_name || null, shots: shots.get(pr?.sheet_slug) || shots.get(pr?.sheet_name) || [],
          guide: guides.get(pr?.sheet_slug) || guides.get(pr?.sheet_name) || [],
          gone: !m,
        };
      }),
    };
  }
  return { scope: { name: scope.name, stores: scope.stores }, stores: out, shops: SHOP_BY_STORE };
}

async function confirmView(scope: Scope) {
  const cards = await rows(`${CARDS(scope.test)}?status=eq.confirm&store_code=in.(${scope.stores.join(",")})&select=*&order=regraded_at.desc&limit=200`);
  const byStore: Record<string, any[]> = {};
  for (const c of cards) (byStore[c.store_code] ||= []).push(c);
  const items: any[] = [];
  for (const [st, list] of Object.entries(byStore)) {
    const shop = await minis(st, list.map(c => c.product_id)).catch(() => new Map<string, Mini>());
    for (const c of list) {
      const m = shop.get(c.product_id);
      items.push({ store: st, productId: c.product_id, sku: m?.sku || c.sku, title: m?.title || c.title, price: c.price,
        handle: m?.handle || "", lister: c.lister_tag, round: c.round, ticks: c.ticks, returnedNote: c.returned_note,
        returnedKind: c.returned_kind, fixedBy: c.fixed_by, fixedAt: c.fixed_at, regrade: c.regrade, regradedAt: c.regraded_at,
        photos: m?.photos || [], gone: !m, manualOnly: !!(c.regrade && c.regrade.manualOnly) });
    }
  }
  return { scope: { name: scope.name, stores: scope.stores }, items, shops: SHOP_BY_STORE };
}

async function flagsView(scope: Scope, weeks: number) {
  const since = ctMonday(new Date(Date.now() - (weeks - 1) * 7 * 86400000));
  const sIn = `store_code=in.(${scope.stores.join(",")})`;
  const [listedAll, flags, spots] = await Promise.all([
    allRows(`listing_listers?${sIn}&created_at=gte.${since}&select=store_code,product_id,lister_tag,lister_name,created_at&order=product_id`),
    allRows(`listing_flags?${sIn}&week=gte.${since}&select=week,store_code,product_id,lister_tag,source,checker_miss,missed_by,dismissed&order=id`),
    allRows(`listing_spot_checks?${sIn}&day=gte.${since}&result=neq.pending&select=day,store_code,result,checker_passed,ticks&order=id`),
  ]);
  // THROUGH YESTERDAY (Ethan, 2026-11-18: "show the current week and the through
  // date (yesterday)"): today's listings have not been through tonight's checks,
  // so counting them would only drag every rate down until morning.
  const until = new Date(ctMidnightIso()).getTime();
  const late = new Set(listedAll.filter((l: any) => new Date(l.created_at).getTime() >= until).map((l: any) => `${l.store_code}|${l.product_id}`));
  const listed = listedAll.filter((l: any) => new Date(l.created_at).getTime() < until);
  const nameOf = new Map<string, string>();
  for (const l of listed) if (l.lister_tag) nameOf.set(`${l.store_code}|${l.lister_tag}`, l.lister_name || l.lister_tag);
  // week|store|lister -> tallies. A listing counts once per bucket however many sources flagged it.
  const key = (w: string, st: string, tag: string | null) => `${w}|${st}|${tag || ""}`;
  const t = new Map<string, { week: string; store: string; lister: string; listed: number; flagged: Set<string>; ethan: Set<string>; dismissedOnly: Set<string> }>();
  const get = (w: string, st: string, tag: string | null) => {
    const k = key(w, st, tag);
    if (!t.has(k)) t.set(k, { week: w, store: st, lister: tag ? (nameOf.get(`${st}|${tag}`) || tag) : "Unknown",
                              listed: 0, flagged: new Set(), ethan: new Set(), dismissedOnly: new Set() });
    return t.get(k)!;
  };
  for (const l of listed) get(ctMonday(l.created_at), l.store_code, l.lister_tag).listed++;
  const live = new Set<string>();
  for (const f of flags) if (!f.dismissed) live.add(`${f.store_code}|${f.product_id}`);
  for (const f of flags) {
    if (late.has(`${f.store_code}|${f.product_id}`)) continue;
    const b = get(f.week, f.store_code, f.lister_tag);
    if (f.source === "ethan") b.ethan.add(f.product_id);
    else if (!f.dismissed) b.flagged.add(f.product_id);
    else if (!live.has(`${f.store_code}|${f.product_id}`)) b.dismissedOnly.add(f.product_id);
  }
  const out = [...t.values()].map(b => {
    const any = new Set([...b.flagged, ...b.ethan]);
    return { week: b.week, store: b.store, lister: b.lister, listed: b.listed, flagged: any.size, checkerFlags: b.flagged.size,
             ethanSendBacks: b.ethan.size, dismissed: b.dismissedOnly.size,
             rate: b.listed ? Math.round(any.size / b.listed * 100) : null };
  }).sort((a, b) => b.week.localeCompare(a.week) || a.store.localeCompare(b.store) || (b.rate ?? -1) - (a.rate ?? -1));
  // Checker accuracy from the spot checks: a graded pass is a miss for every
  // checker Ethan's ticks say got it wrong.
  const checkers: Record<string, { checked: number; misses: number }> = {
    photos: { checked: 0, misses: 0 } };
  for (const s of spots) {
    for (const c of Object.keys(checkers)) checkers[c].checked++;
    if (s.result === "graded") for (const c of missedBy(s.ticks)) if (checkers[c]) checkers[c].misses++;
  }
  return { scope: { stores: scope.stores }, since, weeks, through: ctDay(new Date(until - 12 * 3600000)), rows: out, checkers };
}

// ⚠️ THE SPOT CHECK IS PICTURES ONLY, FOR NOW (Ethan, 2026-11-19: "keep that
// just for pictures … I do want to bridge this out to full listing review").
// Its ticks are the guide's missing shots and the order — what the photo check
// looks at — plus `eye`: angle, framing, a dirty table, which it does not look
// at yet. `eye` is NOT a miss (a pass cannot have got wrong what nothing
// checked); it still counts against the lister and goes to Claude as an idea.
function missedBy(ticks: any): string[] {
  if (!ticks) return [];
  return (ticks.missing || []).length || ticks.order ? ["photos"] : [];
}
const EYE_OK = new Set(["Angle", "Framing", "Dirty Table"]);
// Only something the overnight photo recheck can actually see is worth paying
// it to look: a missing guide shot or the order.
const photoCheckable = (t: any) => !!t && (((t.missing || []).length > 0) || !!t.order);
// The ticks, as the sentence a manager reads and the note Claude reads.
function ticksSay(ticks: any): string {
  if (!ticks) return "";
  const out: string[] = [];
  if ((ticks.missing || []).length) out.push(`Missing: ${ticks.missing.join(", ")}`);
  if (ticks.order) out.push("Photos out of the guide's order");
  if (ticks.title) out.push("Title wrong");
  if ((ticks.fields || []).length) out.push(`Wrong field: ${ticks.fields.join(", ")}`);
  if (ticks.category) out.push("Wrong category");
  // A full review's parts (0197): the part, then Ethan's note on it.
  for (const pt of (ticks.parts || [])) out.push(`${pt.part}: "${pt.note || ""}"`);
  // Per photo (Ethan, 2026-11-19): what is wrong with EACH photo, and a note
  // for it — "photo 3 is the angle and a dirty table, photo 4 only the table".
  for (const ph of (ticks.photos || [])) {
    out.push(`Photo ${ph.n}: ${(ph.tags || []).join(", ") || "see note"}${ph.note ? ` — "${ph.note}"` : ""}`);
  }
  const loose = (ticks.eye || []).filter((x: string) => !(ticks.photos || []).some((ph: any) => (ph.tags || []).includes(x)));
  if (loose.length) out.push(`Only checked by eye: ${loose.join(", ")}`);
  return out.join(". ");
}

// --- writes ------------------------------------------------------------------------------------

// ⚠️ TEST CARDS (0203): a test account's cards live in listing_review_cards_test,
// never the real table — a card is keyed by (store, listing), so a test send on
// a real listing would otherwise overwrite that listing's real card. Every read
// and write of cards goes through CARDS(test). The re-grade and settle jobs only
// ever read the real table.
const CARDS = (test = false) => test ? "listing_review_cards_test" : "listing_review_cards";
async function cardOf(store: string, pid: string, test = false) {
  return (await rows(`${CARDS(test)}?store_code=eq.${store}&product_id=eq.${enc(pid)}&select=*&limit=1`))?.[0] || null;
}
async function upsertCard(row: Record<string, unknown>, test = false) {
  await sb(`${CARDS(test)}?on_conflict=store_code,product_id`, {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }) });
}
async function patchCard(store: string, pid: string, patch: Record<string, unknown>, test = false) {
  await sb(`${CARDS(test)}?store_code=eq.${store}&product_id=eq.${enc(pid)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
}
async function addFlag(f: Record<string, unknown>, update = false) {
  await sb("listing_flags?on_conflict=store_code,product_id,source", {
    method: "POST", headers: { Prefer: `resolution=${update ? "merge" : "ignore"}-duplicates,return=minimal` },
    body: JSON.stringify(f) });
}
// WHO A SEND-BACK GOES TO (0204): the lister, by the Shopify tag the daily job
// already reads (listing_listers) — but only when that name is somebody's
// SPEEKSNET account at this store. No tag, or a tag that is nobody's account
// (Ethan, 2026-11-23: SBuggs is a temp — "just send that to the manager and
// just have him delegate that"), leaves it unassigned: the manager's alone.
// A test send is assigned to the store's test employee, so Test DM → Test
// Employee can be tried without reaching a real person.
// ⚠️ listing_listers only holds listings the daily job has seen (recent ones).
// An older listing has no row there, yet View Listing shows its lister from the
// live Shopify tags — so a send-back read only the table and went to the manager
// while the header said "Rorie" (2026-11-24). Fall back to the same live read.
async function assigneeFor(store: string, pid: string, test: boolean): Promise<string | null> {
  if (test) {
    const t = await rows(`test_users?store=eq.${store}&select=name,role`);
    return (t.find((x: any) => /^employee$/i.test(String(x.role || "").trim()))
      || t.find((x: any) => /^assistant manager$/i.test(String(x.role || "").trim())))?.name || null;
  }
  let who = (await rows(`listing_listers?store_code=eq.${store}&product_id=eq.${enc(pid)}&select=lister_name&limit=1`))?.[0]?.lister_name || null;
  if (!who) {
    try {
      const { shop, token } = await shopFor(store);
      const tags = (await gql(shop, token, `query($id: ID!) { product(id: $id) { tags } }`, { id: pid }))?.product?.tags || [];
      who = listerFrom(tags, await loadListerIx(), store)?.name || null;
    } catch { who = null; }
  }
  if (!who) return null;
  const u = (await rows(`users?name=ilike.${enc(who)}&select=name,store,role&limit=5`))
    .find((x: any) => String(x.store || "").toUpperCase() === store && String(x.role || "").toLowerCase().trim() !== "store");
  return u ? String(u.name) : null;
}
// A full-review card: kind full/notes, or a later round of one (Fix Not Accepted,
// a failed recheck) — full-review ticks always carry `parts`, spot ticks never do.
const isFullCard = (c: any) => !!c && (c.returned_kind === "full" || c.returned_kind === "notes" || Array.isArray(c.ticks?.parts));
const fullHidden = (scope: Scope, c: any) => OWN_FULL_ONLY.includes(scope.role) && isFullCard(c) && !sameName(c.assigned_to, scope.name);
const sameName = (a: unknown, b: unknown) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase() && !!String(a || "").trim();
// THE LISTER'S OWN OPEN PHOTO FIXES (0206): picture_quality_reviews rows the
// grader saved with this person as lister_name (their Shopify tag matched their
// account at grading time). Test accounts list nothing, so they get none.
async function minePhotos(scope: Scope): Promise<any[]> {
  if (scope.test) return [];
  const pq = await rows(`picture_quality_reviews?store_code=eq.${scope.stores[0]}&status=eq.open&verdict=in.(retake,fix,reorder)`
    + `&stamp=like.${PQ_RECIPE}:*&lister_name=ilike.${enc(scope.name)}`
    + `&select=product_id,sku,title,verdict,findings,reorder,deletion,sheet_name,sheet_slug,reviewed_at,lister_name&limit=200`);
  return pq.filter((r: any) => sameName(r.lister_name, scope.name));
}
async function mineCards(scope: Scope) {
  const all = await rows(`${CARDS(scope.test)}?store_code=eq.${scope.stores[0]}&status=eq.open&assigned_to=not.is.null&select=*&order=returned_at.desc&limit=200`);
  return all.filter((c: any) => sameName(c.assigned_to, scope.name) && c.returned_kind !== "notes");
}
// May this person mark this listing fixed or sold as its lister? (2026-11-27)
async function ownPhotoRow(scope: Scope, store: string, pid: string): Promise<boolean> {
  if (scope.test || store !== scope.stores[0]) return false;
  const r = (await rows(`picture_quality_reviews?store_code=eq.${store}&product_id=eq.${enc(pid)}&status=eq.open`
    + `&verdict=in.(retake,fix,reorder)&select=lister_name&limit=1`))?.[0];
  return !!r && sameName(r.lister_name, scope.name);
}
// MY FIXES — the open list, plus what is waiting on the recheck. A photo fix the
// lister (or the manager) marked fixed leaves the open list at once and waits
// under Being Rechecked until the picture check grades the new photos (Ethan,
// 2026-11-27). Both readers below share this split, so the count matches.
async function mineSplit(scope: Scope) {
  const [cards, photos, waitingAll] = await Promise.all([mineCards(scope), minePhotos(scope),
    rows(`${CARDS(scope.test)}?store_code=eq.${scope.stores[0]}&status=in.(fixed,regrading)&select=*&order=fixed_at.desc&limit=200`)]);
  const myPhoto = new Set(photos.map((r: any) => String(r.product_id)));
  const waiting = waitingAll.filter((c: any) => sameName(c.assigned_to, scope.name) || myPhoto.has(String(c.product_id)));
  const skip = new Set([...cards, ...waiting].map((c: any) => String(c.product_id)));
  return { cards, waiting, photoOnly: photos.filter((r: any) => !skip.has(String(r.product_id))) };
}
// MY FIXES: the send-backs on listings this person made, with the photos.
async function mineView(scope: Scope) {
  const store = scope.stores[0];
  const { cards, waiting, photoOnly } = await mineSplit(scope);
  const shop = await minis(store, [...cards, ...waiting].map((c: any) => c.product_id).concat(photoOnly.map((r: any) => r.product_id)))
    .catch(() => new Map<string, Mini>());
  const guides = photoOnly.length ? await sheetGuides() : new Map<string, any>();
  return {
    scope: { name: scope.name, stores: scope.stores }, store, shop: SHOP_BY_STORE[store],
    // Photo fixes from the picture check. The fix is re-shooting or reordering in
    // Shopify; I Fixed It moves it to Being Rechecked (2026-11-27), and the
    // 5-minute check re-grades it as soon as the photos change. It Sold takes a
    // sold one off (it still counts).
    photoItems: photoOnly.map((r: any) => {
      const m = shop.get(r.product_id);
      const line: any = linesFor(r.product_id, r, null, null, null)[0];
      line.guide = guides.get(line.sheetSlug) || guides.get(line.sheet) || [];
      return { productId: r.product_id, sku: m?.sku || r.sku, title: m?.title || r.title, price: m?.price ?? null,
               handle: m?.handle || "", createdAt: m?.createdAt || null, photos: m?.photos || [], gradedAt: r.reviewed_at,
               lines: [line] };
    }),
    items: cards.map((c: any) => {
      const m = shop.get(c.product_id);
      return { productId: c.product_id, sku: m?.sku || c.sku, title: m?.title || c.title, price: m?.price ?? c.price,
               handle: m?.handle || "", createdAt: m?.createdAt || null, photos: m?.photos || [],
               lines: [{ kind: "ethan", ticks: c.ticks }],
               card: { status: c.status, round: c.round, returnedKind: c.returned_kind, returnedNote: c.returned_note,
                       returnedBy: c.returned_by, returnedAt: c.returned_at, assignedTo: c.assigned_to, assigneeSeenAt: c.assignee_seen_at } };
    }),
    waiting: waiting.map((c: any) => {
      const m = shop.get(c.product_id);
      return { productId: c.product_id, sku: m?.sku || c.sku, title: m?.title || c.title, photos: (m?.photos || []).slice(0, 1),
               status: c.status, fixedBy: c.fixed_by, fixedAt: c.fixed_at };
    }),
  };
}

async function listingWeek(store: string, pid: string, fallback = new Date()) {
  const l = (await rows(`listing_listers?store_code=eq.${store}&product_id=eq.${enc(pid)}&select=created_at,lister_tag&limit=1`))?.[0];
  if (l?.created_at) return { week: ctMonday(l.created_at), lister: l.lister_tag || null };
  const c = (await rows(`ebay_catalog?store_code=eq.${store}&product_id=eq.${enc(pid)}&select=product_created_at&limit=1`))?.[0];
  return { week: ctMonday(c?.product_created_at || fallback), lister: null };
}

async function handlePost(req: Request, scope: Scope) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  // ⚠️ TEST ACCOUNTS (Ethan, 2026-11-23: "from the test DM to the test manager for
  // that store, just so I don't accidentally send one"): the full-review loop
  // only — send, mark fixed, Got It, confirm or send back — on their own cards
  // (CARDS(true)), with no flag written. Everything else stays read-only.
  const TEST_OK = ["full-review", "mark-fixed", "undo-fixed", "notes-seen", "confirm", "send-back", "mine-seen"];
  if (scope.test && !TEST_OK.includes(action)) return json({ error: "forbidden", detail: "Test accounts can only try the Full Listing Review loop." }, 403);
  const T = scope.test;
  const now = new Date().toISOString();

  // The lister opened it (0204): the manager sees "Seen" beside the card.
  if (action === "mine-seen") {
    const pid = String(body.productId || ""), store = scope.stores[0];
    const card = await cardOf(store, pid, T);
    if (!card || !sameName(card.assigned_to, scope.name)) return json({ error: "forbidden" }, 403);
    if (!card.assignee_seen_at) await patchCard(store, pid, { assignee_seen_at: now }, T);
    return json({ ok: true });
  }

  // NOTES ONLY, read (0203): the manager has seen Ethan's notes. Nothing to fix,
  // nothing to confirm, never a flag — the card is simply done.
  if (action === "notes-seen") {
    const store = String(body.store || "").toUpperCase(), pid = String(body.productId || "");
    if (!scope.stores.includes(store) || !pid) return json({ error: "forbidden" }, 403);
    const card = await cardOf(store, pid, T);
    if (card && fullHidden(scope, card)) return json({ error: "forbidden" }, 403);
    if (!card || card.status !== "open" || card.returned_kind !== "notes") return json({ error: "conflict", detail: "These notes are already done." }, 409);
    await patchCard(store, pid, { status: "done", confirmed_by: scope.name, confirmed_at: now }, T);
    return json({ ok: true });
  }

  if (action === "mark-fixed" || action === "undo-fixed") {
    if (!scope.mayFix && !scope.mayMine) return json({ error: "forbidden", detail: "The Fix Queue is not switched on for you." }, 403);
    const store = String(body.store || "").toUpperCase(), pid = String(body.productId || "");
    if (!scope.stores.includes(store)) return json({ error: "forbidden", detail: `not your store: ${store}` }, 403);
    if (!pid) return json({ error: "productId required" }, 400);
    const card = await cardOf(store, pid, T);
    // A team member without the store's list may fix only what was sent to them.
    // A LISTER MAY FIX THEIR OWN PHOTO FLAG (Ethan, 2026-11-27: "when photos get
    // selected as fixed it should remove from the list and put in the getting
    // rechecked" thing) — the picture check's row names them as its lister.
    const minePhoto = !scope.mayFix && scope.mayMine && await ownPhotoRow(scope, store, pid);
    if ((!scope.mayFix || fullHidden(scope, card)) && !(card && sameName(card.assigned_to, scope.name)) && !minePhoto) {
      return json({ error: "forbidden", detail: "This listing was not sent to you." }, 403);
    }
    if (action === "undo-fixed") {
      // Only before tonight's re-grade has taken it — after that the answer is coming.
      if (!card || card.status !== "fixed") return json({ error: "conflict", detail: "This card is already being rechecked." }, 409);
      await patchCard(store, pid, { status: "open", fixed_by: null, fixed_at: null }, T);
      return json({ ok: true });
    }
    if (card?.returned_kind === "notes" && card.status === "open") {
      return json({ error: "conflict", detail: "These are notes only — tap Got It." }, 409);
    }
    // A test card is only ever a full review's: no paid recheck, straight to Confirm.
    if (T) {
      if (!card || card.status !== "open" || !card.ticks) return json({ error: "conflict", detail: "Nothing on this test card is waiting on a fix." }, 409);
      await patchCard(store, pid, { status: "confirm", regrade: { manualOnly: true }, regraded_at: now, fixed_by: scope.name, fixed_at: now }, true);
      return json({ ok: true, status: "confirm" });
    }
    // Mark Fixed is for what only a person can fix — the photos, and Ethan's own
    // lines. The title and category lines each have Approve and Dismiss, and a
    // card marked fixed over an open one would only come back tomorrow.
    const [pq, lt, cat] = await Promise.all([photoLines(store), titleLines(store), categoryLines(store)]);
    if (lt.has(pid) || cat.has(pid)) {
      return json({ error: "conflict", detail: "Approve or dismiss the title and category lines first — Mark Fixed is for the photos." }, 409);
    }
    if (!pq.has(pid) && !(card?.status === "open" && card?.ticks)) {
      return json({ error: "conflict", detail: "Nothing on this listing is waiting on a fix any more." }, 409);
    }
    const r = pq.get(pid);
    // ⚠️ CHECK BY EYE (Ethan, 2026-11-18): when everything open on the card is
    // something the photo recheck cannot see — only Ethan's "Only You Check"
    // ticks, or a title/category tick — paying the overnight Batch to look would
    // buy a pass that means nothing. It goes straight to his Confirm Fixes,
    // marked manualOnly, and he checks it himself.
    const eyeOnly = !pq.has(pid) && !photoCheckable(card?.ticks);
    await upsertCard({ store_code: store, product_id: pid, sku: r?.sku || card?.sku || null, title: r?.title || card?.title || null,
      fixed_by: scope.name, fixed_at: now, ...(card ? {} : { round: 0 }),
      ...(eyeOnly ? { status: "confirm", regrade: { manualOnly: true }, regraded_at: now } : { status: "fixed" }) });
    return json({ ok: true, status: eyeOnly ? "confirm" : "fixed" });
  }

  // ⚠️ IT SOLD (Ethan, 2026-11-27: "give an option for users to mark sold if the
  // pictures got flagged but the item has sold. This should still count against
  // the lister, but should be able to be removed from the list"). A flagged
  // listing that sells is no longer graded (the 5-minute check takes in-stock
  // listings only), so its open row sat on the list for good with nothing anyone
  // could fix. Mark Sold:
  //  - takes the photo row off every list (status 'sold', 0213) and closes any
  //    card on it (a send-back, or one waiting in Being Rechecked);
  //  - KEEPS THE FLAG: the listing_flags row is written here if the grade never
  //    wrote one, and the morning ledger counts a 'sold' row like an open one;
  //  - is refused while Shopify still shows stock, so it cannot be used to skip
  //    a fix on something still for sale.
  // BACK IN STOCK (a return): picture-quality's 5-minute check grades a sold row
  // again when the listing is in stock, whatever its age or stamp — and never
  // flags it a second time (sold_at stays on the row; recordFlags skips it).
  if (action === "mark-sold") {
    if (!scope.mayFix && !scope.mayMine) return json({ error: "forbidden", detail: "The Fix Queue is not switched on for you." }, 403);
    const store = String(body.store || "").toUpperCase(), pid = String(body.productId || "");
    if (!scope.stores.includes(store) || !pid) return json({ error: "forbidden" }, 403);
    const [card, pqRow] = await Promise.all([cardOf(store, pid),
      rows(`picture_quality_reviews?store_code=eq.${store}&product_id=eq.${enc(pid)}&select=status,verdict,lister_name,sku,title&limit=1`).then((r: any) => r?.[0] || null)]);
    const photoOpen = pqRow?.status === "open" && ["retake", "fix", "reorder"].includes(pqRow.verdict);
    const cardOpen = card && ["open", "fixed", "regrading"].includes(card.status) && card.returned_kind !== "notes";
    if (!photoOpen && !cardOpen) return json({ error: "conflict", detail: "Nothing on this listing is waiting on a fix any more." }, 409);
    const mayThis = (scope.mayFix && !fullHidden(scope, card))
      || (card && sameName(card.assigned_to, scope.name)) || (photoOpen && sameName(pqRow.lister_name, scope.name));
    if (!mayThis) return json({ error: "forbidden", detail: "This listing was not sent to you." }, 403);
    let stock: number | null = null;
    try {
      const { shop, token } = await shopFor(store);
      const p = (await gql(shop, token, `query($id: ID!) { product(id: $id) { totalInventory status } }`, { id: pid }))?.product;
      stock = p ? Number(p.totalInventory) : 0;   // gone from Shopify = sold
    } catch (e) {
      return json({ error: "shopify", detail: `Could not check the stock in Shopify: ${String((e as Error).message || e)}` }, 502);
    }
    if (stock !== null && stock > 0) {
      return json({ error: "conflict", code: "in-stock",
        detail: `Shopify still shows ${stock} in stock. Mark it sold once the sale has gone through — or fix the photos if it is still for sale.` }, 409);
    }
    if (photoOpen) {
      await sb(`picture_quality_reviews?store_code=eq.${store}&product_id=eq.${enc(pid)}&status=eq.open`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "sold", decided_by: scope.name, decided_at: now, decided_note: "Sold before it was fixed",
                               sold_at: now, sold_by: scope.name }) });
      // Still a flag: the grade normally wrote it; this covers one that did not.
      const lw = await listingWeek(store, pid);
      await addFlag({ week: lw.week, store_code: store, product_id: pid, source: "photos", lister_tag: lw.lister || null });
    }
    if (cardOpen) await patchCard(store, pid, { status: "done", confirmed_by: `${scope.name} (Sold)`, confirmed_at: now });
    return json({ ok: true, status: "sold" });
  }

  // NOT WRONG, FROM MY LISTING CORRECTIONS (Ethan, 2026-11-27: "all roles can
  // dismiss photo stuff as well to leave a note like titles and categories, so I
  // can take those notes and feed it to you so we can continue to improve the
  // rules"). The Fix Queue's Not Wrong calls picture-quality, which a lister
  // cannot reach — so the lister's own answer lands here, and writes exactly
  // what picture-quality's dismiss writes ("dismissed: why" / "reorder denied:
  // why"). That is the row Listing Health Notes reads, so the note reaches the
  // same pile as a manager's. Their own photo flag only, like Mark Fixed; the
  // note is required, as it is everywhere a rule can be called wrong.
  // ⚠️ Like a manager's dismissal, it takes the line off the flag count (a
  // dismissed photo row is not a flag in the morning ledger). The note is the
  // check on that — every one reaches Ethan.
  if (action === "mine-dismiss") {
    if (!scope.mayFix && !scope.mayMine) return json({ error: "forbidden", detail: "The Fix Queue is not switched on for you." }, 403);
    const store = String(body.store || "").toUpperCase(), pid = String(body.productId || "");
    if (!scope.stores.includes(store) || !pid) return json({ error: "forbidden" }, 403);
    const note = String(body.reason || "").trim().slice(0, 300);
    if (!note) return json({ error: "reason required", detail: "Say why the photos are fine — that note is how a wrong rule gets fixed." }, 400);
    const r = (await rows(`picture_quality_reviews?store_code=eq.${store}&product_id=eq.${enc(pid)}&status=eq.open`
      + `&verdict=in.(retake,fix,reorder)&select=verdict,lister_name&limit=1`))?.[0];
    if (!r) return json({ error: "conflict", detail: "Nothing on this listing's photos is waiting on a fix any more." }, 409);
    if (!scope.mayFix && !sameName(r.lister_name, scope.name)) return json({ error: "forbidden", detail: "This listing was not sent to you." }, 403);
    await sb(`picture_quality_reviews?store_code=eq.${store}&product_id=eq.${enc(pid)}&status=eq.open`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "dismissed", decided_by: scope.name, decided_at: now,
        decided_note: `${r.verdict === "reorder" ? "reorder denied" : "dismissed"}: ${note}` }) });
    return json({ ok: true, dismissed: pid });
  }

  if (action === "full-review") {
    if (!scope.mayFull) return json({ error: "forbidden", detail: "Full Listing Review is not switched on for you." }, 403);
    const store = String(body.store || "").toUpperCase(), pid = String(body.productId || "");
    if (!scope.stores.includes(store) || !pid) return json({ error: "forbidden" }, 403);
    // Notes Only (0203): sent to the manager to read, never a flag.
    const result = body.result === "back" ? (body.notesOnly ? "notes" : "back") : "good";
    const parts = (Array.isArray(body.parts) ? body.parts : []).slice(0, 20)
      .map((x: any) => ({ part: String(x?.part || ""), note: String(x?.note || "").trim().slice(0, 600) }))
      .filter((x: any) => FULL_PARTS.has(x.part) && x.note);
    const photos = (Array.isArray(body.photos) ? body.photos : []).slice(0, 40).map((ph: any) => ({
      n: Math.max(1, Math.min(99, Number(ph?.n) || 0)),
      tags: (Array.isArray(ph?.tags) ? ph.tags : []).map(String).filter((x: string) => EYE_OK.has(x)),
      note: String(ph?.note || "").trim().slice(0, 500),
      thumb: /^https:\/\/[^\s"']{1,600}$/.test(String(ph?.thumb || "")) ? String(ph.thumb) : null,
    })).filter((ph: any) => ph.n && (ph.tags.length || ph.note));
    const note = String(body.note || "").trim().slice(0, 1000);
    // Already flagged by the Title Check: never twice (see fullListing's `already`).
    if (parts.some((x: any) => x.part === "Title")) {
      const open = await rows(`listing_title_reviews?store_code=eq.${store}&product_id=eq.${enc(pid)}&status=eq.open&severity=gte.2&select=product_id&limit=1`);
      if (open.length) return json({ error: "already flagged", detail: "The Title Check already flagged this title — it is on the store's list." }, 409);
    }
    if (result === "back" && !parts.length && !photos.length) {
      return json({ error: "nothing flagged", detail: "Flag at least one part or photo, with a note, to send it back." }, 400);
    }
    if (result === "notes" && !note && !parts.length && !photos.some((ph: any) => ph.note)) {
      return json({ error: "note required", detail: "Write the note the manager should read." }, 400);
    }
    const card = await cardOf(store, pid, T);
    // A notes-only send never replaces a card the store still has to fix.
    if (result === "notes" && card && card.status !== "done" && card.returned_kind !== "notes") {
      return json({ error: "conflict", detail: "This listing already has an open fix on the store's list — send it back as a flag instead." }, 409);
    }
    const info = (await rows(`ebay_catalog?store_code=eq.${store}&product_id=eq.${enc(pid)}&select=sku,title,price&limit=1`))?.[0] || {};
    const lw = await listingWeek(store, pid);
    await sb("listing_full_reviews", { method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ store_code: store, product_id: pid, sku: info.sku || null, title: info.title || null, price: info.price ?? null,
        lister_tag: lw.lister, result, parts, photos, note: note || null, reviewed_by: scope.name, reviewed_at: now, test: T }) });
    // ⚠️ LOOKS GOOD COUNTS FOR NOTHING AGAINST ANYONE (Ethan, 2026-11-21: "if it
    // looks good … that lister should not get flagged"). Only a send-back goes
    // on the store's list and into the flag ledger.
    if (result === "good") return json({ ok: true, result });
    const ticks = { missing: [], order: false, parts, photos,
      eye: [...new Set<string>(photos.flatMap((ph: any) => ph.tags))] };
    // Notes Only is for management, never the lister (Ethan, 2026-11-23).
    const assigned = result === "notes" ? null : await assigneeFor(store, pid, T);
    await upsertCard({ store_code: store, product_id: pid, sku: info.sku || null, title: info.title || null, price: info.price ?? null,
      lister_tag: lw.lister, status: "open", round: (card?.round || 0) + (card ? 1 : 0), ticks,
      assigned_to: assigned, assignee_seen_at: null,
      returned_kind: result === "notes" ? "notes" : "full", returned_note: note || null, returned_by: scope.name, returned_at: now,
      fixed_by: null, fixed_at: null, regrade: null, regrade_batch: null, confirmed_by: null, confirmed_at: null }, T);
    // Notes only and test sends: no flag against anyone.
    if (result === "notes" || T) return json({ ok: true, result, test: T });
    await addFlag({ week: lw.week, store_code: store, product_id: pid, lister_tag: lw.lister,
      source: "ethan", checker_miss: false, missed_by: [], dismissed: false, at: now }, true);
    return json({ ok: true, result });
  }

  if (!scope.maySpot) return json({ error: "forbidden", detail: "The Spot Check is not switched on for you." }, 403);

  if (action === "spot-agree" || action === "spot-grade") {
    const id = Number(body.id || 0);
    const s = (await rows(`listing_spot_checks?id=eq.${id}&select=*&limit=1`))?.[0];
    if (!s) return json({ error: "not found" }, 404);
    if (!scope.stores.includes(s.store_code)) return json({ error: "forbidden" }, 403);
    if (action === "spot-agree") {
      await sb(`listing_spot_checks?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ result: "agree", decided_by: scope.name, decided_at: now, ticks: null, note: null }) });
      return json({ ok: true });
    }
    const ticks = {
      missing: (Array.isArray(body.ticks?.missing) ? body.ticks.missing : []).map(String).slice(0, 30),
      order: !!body.ticks?.order,
      eye: [] as string[],
      // One entry per photo Ethan tapped: its number, the problems, a note for
      // that photo, and its thumbnail AS IT LOOKED — the number can move once
      // the store reorders, the picture cannot.
      photos: (Array.isArray(body.ticks?.photos) ? body.ticks.photos : []).slice(0, 40).map((ph: any) => ({
        n: Math.max(1, Math.min(99, Number(ph?.n) || 0)),
        tags: (Array.isArray(ph?.tags) ? ph.tags : []).map(String).filter((x: string) => EYE_OK.has(x)),
        note: String(ph?.note || "").trim().slice(0, 500),
        thumb: /^https:\/\/[^\s"']{1,600}$/.test(String(ph?.thumb || "")) ? String(ph.thumb) : null,
      })).filter((ph: any) => ph.n && (ph.tags.length || ph.note)),
    };
    // The eye-only rule (no paid recheck) reads `eye`: the union of every
    // photo's tags, plus any listing-wide ones an older client sent.
    const older = (Array.isArray(body.ticks?.eye) ? body.ticks.eye : []).map(String).filter((x: string) => EYE_OK.has(x));
    ticks.eye = [...new Set<string>([...older, ...ticks.photos.flatMap((ph: any) => ph.tags)])];
    const note = String(body.note || "").trim().slice(0, 1000);
    // A note is needed somewhere: overall, or on a photo.
    if (!note && !ticks.photos.some((ph: any) => ph.note)) {
      return json({ error: "note required", detail: "Add a note — on a photo or for the whole listing. The store reads it." }, 400);
    }
    const missed = missedBy(ticks);
    if (!missed.length && !ticks.eye.length && !ticks.photos.length) return json({ error: "ticks required", detail: "Mark at least one thing that is wrong." }, 400);
    await sb(`listing_spot_checks?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ result: "graded", decided_by: scope.name, decided_at: now, ticks, note }) });
    // (a) back to the store's Fix Queue, Ethan's note on top.
    const card = await cardOf(s.store_code, s.product_id);
    await upsertCard({ store_code: s.store_code, product_id: s.product_id, sku: s.sku, title: s.title, price: s.price,
      lister_tag: s.lister_tag, status: "open", round: (card?.round || 0) + (card ? 1 : 0), ticks,
      returned_kind: "spot", returned_note: note, returned_by: scope.name, returned_at: now,
      // Pictures stay the manager's for now (Ethan, 2026-11-23) — never assigned.
      assigned_to: null, assignee_seen_at: null,
      fixed_by: null, fixed_at: null, regrade: null, regrade_batch: null });
    // (b) + (c) against the lister, and a miss for the checkers that passed it.
    const lw = await listingWeek(s.store_code, s.product_id);
    await addFlag({ week: lw.week, store_code: s.store_code, product_id: s.product_id, lister_tag: s.lister_tag || lw.lister,
      source: "ethan", checker_miss: missed.length > 0, missed_by: missed, dismissed: false, at: now }, true);
    // (d) the note stays on THIS row and waits in Spot Check Notes (0190).
    // ⚠️ NOT in Listing Health Notes any more. It used to be written onto the
    // photo row as a "should flag" dismissal; Ethan, 2026-11-18: "keep the
    // passes that I regrade to its own thing" — a missed rule and a too-strict
    // rule are opposite asks, and his are the missed ones.
    return json({ ok: true });
  }

  // Clear: Claude has been through these. A person's assertion, never a copy's.
  if (action === "spot-notes-clear") {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(n => n > 0).slice(0, 500);
    if (!ids.length) return json({ error: "ids required" }, 400);
    await sb(`listing_spot_checks?id=in.(${ids.join(",")})&result=eq.graded&triaged_at=is.null&store_code=in.(${scope.stores.join(",")})`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ triaged_at: now, triaged_by: scope.name }) });
    return json({ ok: true, cleared: ids.length });
  }

  if (action === "confirm" || action === "send-back") {
    const store = String(body.store || "").toUpperCase(), pid = String(body.productId || "");
    if (!scope.stores.includes(store)) return json({ error: "forbidden" }, 403);
    const card = await cardOf(store, pid, T);
    if (!card || card.status !== "confirm") return json({ error: "conflict", detail: "This card is not waiting on you any more." }, 409);
    if (action === "confirm") {
      await patchCard(store, pid, { status: "done", confirmed_by: scope.name, confirmed_at: now }, T);
      return json({ ok: true });
    }
    const note = String(body.note || "").trim().slice(0, 1000);
    if (!note) return json({ error: "note required", detail: "Say what is still wrong — the store reads it on the card." }, 400);
    // Back to the store, headed Fix Not Accepted. NOT a second flag against the
    // lister: it is still the same flag.
    await patchCard(store, pid, { status: "open", round: (card.round || 0) + 1, returned_kind: "confirm", assignee_seen_at: null,
      returned_note: note, returned_by: scope.name, returned_at: now, fixed_by: null, fixed_at: null,
      ticks: card.ticks || { missing: [], order: false, title: false, category: false, fields: [] } }, T);
    return json({ ok: true });
  }
  return json({ error: `unknown action: ${action}` }, 400);
}

// --- the schedule ----------------------------------------------------------------------------------

// 6am CT: who listed yesterday's listings, the flag ledger, and the day's ten. Free.
async function daily(onlyStore?: string, pickAgain = false) {
  const ix = await loadListerIx();
  const report: Record<string, unknown> = {};
  const since = new Date(Date.now() - LISTER_DAYS * 86400000).toISOString();
  for (const st of onlyStore ? [onlyStore] : STORES) {
    const r: Record<string, unknown> = {};
    // 1. Listers for new listings.
    const freshRaw = await rows(`ebay_catalog?store_code=eq.${st}&product_created_at=gte.${since}&select=product_id,sku,title,price,product_created_at&limit=1000`);
    // One row per PRODUCT: a product with two variants has two catalog rows (MPL,
    // 2026-11-18), and an upsert carrying both is refused outright.
    const fresh = [...new Map(freshRaw.map((f: any) => [f.product_id, f])).values()];
    const m = await minis(st, fresh.map((f: any) => f.product_id), false);
    const up = fresh.map((f: any) => {
      const p = m.get(f.product_id), hit = p ? listerFrom(p.tags, ix, st) : null;
      return { store_code: st, product_id: f.product_id, sku: f.sku, title: f.title, price: f.price,
               lister_tag: hit?.tag || (p ? rawListerTag(p.tags) : null), lister_name: hit?.name || null,
               created_at: f.product_created_at, seen_at: new Date().toISOString() };
    });
    if (up.length) await sb("listing_listers?on_conflict=store_code,product_id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(up) });
    r.listers = up.length;

    // 2. The flag ledger, for listings listed in the last three weeks. A source
    // is a flag once anything from it was raised; `dismissed` follows the store's
    // answer (every line from it dismissed = shown greyed, not counted).
    const known = await allRows(`listing_listers?store_code=eq.${st}&created_at=gte.${new Date(Date.now() - 21 * 86400000).toISOString()}`
      + `&select=product_id,lister_tag,created_at&order=product_id`);
    const who = new Map<string, any>(known.map((k: any) => [k.product_id, k]));
    const flags: any[] = [];
    const add = (pid: string, source: string, dismissed: boolean) => {
      const k = who.get(pid); if (!k) return;
      flags.push({ week: ctMonday(k.created_at), store_code: st, product_id: pid, lister_tag: k.lister_tag, source, dismissed });
    };
    const ids = [...who.keys()];
    for (let i = 0; i < ids.length; i += 150) {
      const chunk = inList(ids.slice(i, i + 150));
      const pq = await rows(`picture_quality_reviews?store_code=eq.${st}&product_id=in.${chunk}&verdict=in.(retake,fix,reorder)&select=product_id,status,decided_note`);
      for (const p of pq) add(p.product_id, "photos", p.status === "dismissed" && !/^should flag/i.test(String(p.decided_note || "")));
      // ⚠️ WHAT A TITLE FLAG IS (Ethan, 2026-11-23): coaching, not polish — "flag
      // just people who need coaching on misspellings, the cutting off titles".
      // So only The Title Is Wrong (3) and Hard To Find (2). Could Be Better (1)
      // is opportunity, not a mistake ("PayMore does draft titles"), and a CLEAN
      // row is a title that passed: counting every reviewed title (606 of 647
      // flags in the week of 11-16) was a bug.
      const lt = await rows(`listing_title_reviews?store_code=eq.${st}&product_id=in.${chunk}&status=neq.clean&severity=gte.2&select=product_id,status,findings`);
      for (const t of lt) add(t.product_id, isLabel(t) ? "label" : "title", t.status === "denied");
    }
    // ⚠️ CATEGORIES ARE NEVER A FLAG (Ethan, 2026-11-23): "that's not really our
    // fault, we're kind of limited to it" — the category lines stay on the card
    // to fix, they just never count against the lister.
    // One per (listing, source): if a source has both kinds, an undismissed line wins.
    const best = new Map<string, any>();
    for (const f of flags) {
      const k = `${f.product_id}|${f.source}`, was = best.get(k);
      if (!was || (was.dismissed && !f.dismissed)) best.set(k, f);
    }
    if (best.size) await sb("listing_flags?on_conflict=store_code,product_id,source", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([...best.values()]) });
    r.flags = best.size;

    // 3. The day's ten.
    r.picked = await pick(st, pickAgain);
    // 4. The Full Listing Review's ten, from yesterday's listings.
    r.fullPicks = await pickFull(st, ctDay(new Date(Date.now() - 86400000)));
    report[st] = r;
  }
  return report;
}

// THE DAILY TEN: the highest-price listings every check PASSED. Picked once a
// day so the list does not move under Ethan, and a listing is offered once,
// ever (listing_spot_checks is unique on store + product).
async function pick(st: string, again = false): Promise<number> {
  const day = ctDay();
  const already = await rows(`listing_spot_checks?store_code=eq.${st}&day=eq.${day}&select=id`);
  if (already.length && !again) return 0;
  const since = new Date(Date.now() - SPOT_DAYS * 86400000).toISOString();
  const passes = await rows(`picture_quality_reviews?store_code=eq.${st}&status=eq.open&verdict=eq.pass`
    + `&stamp=like.${PQ_RECIPE}:*&reviewed_at=gte.${since}&select=product_id,sku,title&limit=1000`);
  if (!passes.length) return 0;
  const ids = passes.map((p: any) => p.product_id);
  // Pictures only: a listing with an open title or category line is still a
  // photo pass worth checking — that line is on the store's list already.
  const [seen, catRows, listers] = await Promise.all([
    rows(`listing_spot_checks?store_code=eq.${st}&product_id=in.${inList(ids)}&select=product_id`),
    rows(`ebay_catalog?store_code=eq.${st}&product_id=in.${inList(ids)}&quantity=gt.0&select=product_id,price,online_published`),
    rows(`listing_listers?store_code=eq.${st}&product_id=in.${inList(ids)}&select=product_id,lister_tag,lister_name`),
  ]);
  const done = new Set(seen.map((s: any) => s.product_id));
  const price = new Map<string, number>(catRows.map((c: any) => [c.product_id, Number(c.price || 0)]));
  const who = new Map<string, any>(listers.map((l: any) => [l.product_id, l]));
  const ok = passes.filter((p: any) => !done.has(p.product_id) && price.has(p.product_id))
    .sort((a: any, b: any) => (price.get(b.product_id) || 0) - (price.get(a.product_id) || 0))
    .slice(0, SPOT_N - already.length);
  if (!ok.length) return 0;
  await sb("listing_spot_checks?on_conflict=store_code,product_id", {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(ok.map((p: any, i: number) => ({
      day, store_code: st, product_id: p.product_id, sku: p.sku, title: p.title, price: price.get(p.product_id),
      lister_tag: who.get(p.product_id)?.lister_name || who.get(p.product_id)?.lister_tag || null,
      rank: already.length + i + 1, checker_passed: ["photos"] }))) });
  return ok.length;
}

// The Full Listing Review's daily ten (0202): the ten highest-priced listings a
// store MADE on `day` (CT), in stock. Recomputed until one is reviewed, so a
// preview run mid-day is replaced by the whole day's ten next morning.
function ctStartOf(day: string): string {
  const noon = new Date(day + "T12:00:00Z");
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour12: false, hour: "2-digit" }).format(noon)) % 24;
  return new Date(Date.parse(day + "T00:00:00Z") + (12 - h) * 3600000).toISOString();
}
const FULL_N = 10;
async function pickFull(st: string, day: string): Promise<number | string> {
  const was = await rows(`listing_full_picks?store_code=eq.${st}&day=eq.${day}&select=product_id`);
  if (was.length) {
    const reviewed = await rows(`listing_full_reviews?store_code=eq.${st}&test=is.false&product_id=in.${inList(was.map((w: any) => w.product_id))}&select=id&limit=1`);
    if (reviewed.length) return "kept (already being reviewed)";
    await sb(`listing_full_picks?store_code=eq.${st}&day=eq.${day}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
  const next = new Date(Date.parse(day + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
  const cat = await rows(`ebay_catalog?store_code=eq.${st}&quantity=gt.0&product_created_at=gte.${ctStartOf(day)}&product_created_at=lt.${ctStartOf(next)}`
    + `&select=product_id,sku,title,price&order=price.desc&limit=200`);
  const top = ([...new Map(cat.map((c: any) => [c.product_id, c])).values()] as any[])
    .sort((a, b) => Number(b.price || 0) - Number(a.price || 0)).slice(0, FULL_N);
  if (!top.length) return 0;
  const who = new Map<string, any>((await rows(`listing_listers?store_code=eq.${st}&product_id=in.${inList(top.map(t => t.product_id))}&select=product_id,lister_tag,lister_name`))
    .map((l: any) => [l.product_id, l]));
  await sb("listing_full_picks?on_conflict=store_code,product_id", {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(top.map((t, i) => ({ day, store_code: st, product_id: t.product_id, sku: t.sku, title: t.title,
      price: t.price, lister_tag: who.get(t.product_id)?.lister_name || who.get(t.product_id)?.lister_tag || null, rank: i + 1 }))) });
  return top.length;
}

// 3:20am CT, after the nightly grade: every card the stores marked fixed goes to
// the photo check's overnight Batch (~5c a listing). PAID — off unless
// LR_REGRADE_ON=1, which Ethan turns on himself.
async function regrade() {
  if (Deno.env.get("LR_REGRADE_ON") !== "1") {
    return { paused: true, note: "Re-grade is off (LR_REGRADE_ON is not 1) — nothing submitted, nothing spent." };
  }
  const fixed = await rows(`listing_review_cards?status=eq.fixed&select=store_code,product_id&limit=1000`);
  const out: Record<string, unknown> = {};
  for (const st of STORES) {
    const ids = fixed.filter((c: any) => c.store_code === st).map((c: any) => c.product_id);
    if (!ids.length) continue;
    const res = await fetch(`${SUPABASE_URL}/functions/v1/picture-quality?sweep=${ids.length}&batch=1&force=1&regrade=1`
      + `&store=${st}&ids=${enc(ids.join(","))}&secret=${SECRET}`, { headers: { Authorization: `Bearer ${SERVICE_KEY}` } });
    // picture-quality streams spaces to keep the line open, then the JSON.
    const body = JSON.parse((await res.text()).trim() || "{}");
    if (body.error || !body.batch) { out[st] = { error: body.error || "no batch id", ids: ids.length }; continue; }
    await sb(`listing_review_cards?store_code=eq.${st}&status=eq.fixed&product_id=in.${inList(ids)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "regrading", regrade_batch: body.batch, updated_at: new Date().toISOString() }) });
    out[st] = { submitted: body.submitted, batch: body.batch };
  }
  return out;
}

// Every 15 minutes (0207): read what the re-grade wrote. A card whose listing has
// been graded again since it was marked fixed goes to Ethan's Confirm Fixes if
// nothing on it is open any more, and back to the store if anything is.
// ⚠️ 'fixed' AS WELL AS 'regrading' (2026-11-24): with the overnight re-grade off
// and the 5-minute check on, a card marked fixed never became 'regrading' — the
// 5-minute check re-graded the re-shot listing, but nothing read that grade back,
// so the card sat in Tonight's Recheck for good. Any grade newer than fixed_at
// settles it, whichever job wrote it.
async function settle(fake?: { result: string; store: string; productId: string }) {
  const cards = fake
    ? [await cardOf(fake.store, fake.productId)].filter(Boolean)
    : await rows(`listing_review_cards?status=in.(fixed,regrading)&select=*&limit=1000`);
  const moved = { confirm: 0, back: 0, waiting: 0 };
  for (const c of cards) {
    const st = c.store_code, pid = c.product_id;
    const pq = (await rows(`picture_quality_reviews?store_code=eq.${st}&product_id=eq.${enc(pid)}&select=verdict,findings,reviewed_at,status&limit=1`))?.[0];
    let verdict = pq?.verdict, findings = pq?.findings || [];
    if (fake) { verdict = fake.result === "pass" ? "pass" : "fix";
                findings = fake.result === "pass" ? [] : [{ code: "missing_shot", text: "Missing: (test) the shot that was asked for." }]; }
    else if (!pq || !c.fixed_at || new Date(pq.reviewed_at) <= new Date(c.fixed_at)) { moved.waiting++; continue; }
    const [lt, cat] = await Promise.all([titleLines(st), categoryLines(st)]);
    const still = verdict !== "pass" || lt.has(pid) || cat.has(pid);
    const now = new Date().toISOString();
    const regradeSaid = { verdict, findings, titleOpen: lt.has(pid), categoryOpen: cat.has(pid) };
    if (!still) {
      await patchCard(st, pid, { status: "confirm", regrade: regradeSaid, regraded_at: now });
      moved.confirm++;
    } else {
      const why = verdict !== "pass"
        ? (findings || []).map((f: any) => f?.text).filter(Boolean).join(" ") || "The recheck still found a problem with the photos."
        : "The recheck passed the photos, but a title or category line is still open.";
      await patchCard(st, pid, { status: "open", round: (c.round || 0) + 1, regrade: regradeSaid, regraded_at: now,
        returned_kind: "regrade", returned_note: why, returned_by: "Overnight Recheck", returned_at: now,
        fixed_by: null, fixed_at: null });
      moved.back++;
    }
  }
  return moved;
}

// --- routing ---------------------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const view = url.searchParams.get("view") || "";
    if (req.method === "POST" || view) {
      const scope = await scopeFor(req.headers.get("x-user-pin") || "");
      if (!scope) return json({ error: "unauthorized", detail: "no matching user, or the Fix Queue is not switched on for you" }, 401);
      if (req.method === "POST") return await handlePost(req, scope);
      const store = (url.searchParams.get("store") || "").toUpperCase();
      // MY FIXES (0204) — the lister's own send-backs, and the feed card's count.
      if (view === "mine") return json(await mineView(scope));
      if (view === "mine-count") {
        const { cards, photoOnly } = await mineSplit(scope);
        return json({ n: cards.length + photoOnly.length });
      }
      // THE POP-UP FEED (Ethan, 2026-11-24): "they finish a listing, it grades,
      // they come back and there's just a notification" — every picture grade
      // of this person's listings since `since` (at most 3 hours back), pass or
      // not. The browser shows each one once as a desktop notification.
      if (view === "pq-news") {
        if (scope.test) return json({ items: [] });
        const floor = Date.now() - 3 * 3600000;
        const since = Math.max(floor, Date.parse(url.searchParams.get("since") || "") || floor);
        const got = await rows(`picture_quality_reviews?store_code=eq.${scope.stores[0]}&lister_name=ilike.${enc(scope.name)}`
          + `&reviewed_at=gt.${encodeURIComponent(new Date(since).toISOString())}&stamp=like.${PQ_RECIPE}:*`
          // A listing that sold and came back (a return) is graded again but never
          // re-flagged (0213) — so no pop-up for it either: nobody did anything new.
          + `&sold_at=is.null`
          + `&select=product_id,sku,title,verdict,findings,reorder,photo_count,reviewed_at,lister_name&order=reviewed_at.asc&limit=20`);
        const mine = got.filter((r: any) => sameName(r.lister_name, scope.name));
        // WHICH LISTING, AT A GLANCE (Ethan, 2026-11-24: "give them an idea on
        // what listing they did"): its first photo as the pop-up's picture, plus
        // SKU and price. One Shopify read, and only when there is news.
        const shop = mine.length ? await minis(scope.stores[0], mine.map((r: any) => r.product_id)).catch(() => new Map<string, Mini>())
          : new Map<string, Mini>();
        return json({ items: mine.map((r: any) => ({
          productId: r.product_id, title: shop.get(r.product_id)?.title || r.title, sku: shop.get(r.product_id)?.sku || r.sku || "",
          price: shop.get(r.product_id)?.price ?? null, thumb: shop.get(r.product_id)?.photos?.[0]?.thumb || null,
          verdict: r.verdict, photoCount: r.photo_count, at: r.reviewed_at,
          missing: (r.findings || []).filter((f: any) => f.code === "missing_shot").map((f: any) => f.shot || f.text),
          reorder: !!r.reorder, findings: (r.findings || []).map((f: any) => String(f.text || "")).filter(Boolean).slice(0, 4) })) });
      }
      if (view === "counts") return json(await countsView(scope));
      if (view === "queue") {
        if (!scope.mayFix && !scope.maySpot) return json({ error: "forbidden" }, 403);
        return json(await queueView(scope, store));
      }
      // VIEW LISTING — every role with the queue or the spot check, its own stores.
      if (view === "listing") {
        const pid = url.searchParams.get("productId") || "";
        if (!scope.stores.includes(store) || !pid) return json({ error: "forbidden" }, 403);
        const l = await fullListing(store, pid);
        return l ? json(l) : json({ error: "not found", detail: "That listing is no longer on Shopify." }, 404);
      }
      if (view === "full-list") {
        if (!scope.mayFull) return json({ error: "forbidden", detail: "Full Listing Review is not switched on for you." }, 403);
        const st = scope.stores.includes(store) ? store : scope.stores[0];
        return json(await fullList(st, url.searchParams.get("q") || "", scope.test));
      }
      // FLAG RATES FOR EVERY ROLE (Ethan, 2026-11-24): the DM sees every store;
      // a manager or ASM sees their own store (scope.stores is just theirs); a
      // team member with only My Listing Corrections sees ONLY their own rows.
      if (view === "flags") {
        const weeks = Math.min(Math.max(Number(url.searchParams.get("weeks") || 8), 1), 26);
        const fv: any = await flagsView(scope, weeks);
        if (scope.maySpot) return json(fv);
        if (scope.mayFix) return json({ ...fv, checkers: {}, mode: "store" });
        return json({ ...fv, checkers: {}, mode: "mine", rows: fv.rows.filter((r: any) => sameName(r.lister, scope.name)) });
      }
      if (!scope.maySpot) return json({ error: "forbidden", detail: "The Spot Check is not switched on for you." }, 403);
      if (view === "today") return json(await todayView(scope));
      if (view === "spot-notes") return json(await spotNotesView(scope));
      // Just the number, for the feed card's 30-minute poll.
      if (view === "spot-notes-count") return json({ waiting: (await spotNotesWaiting(scope.stores)).length });
      if (view === "spot") return json(await spotView(scope, store));
      if (view === "confirm") return json(await confirmView(scope));
      return json({ error: `unknown view: ${view}` }, 400);
    }
    if (!secretOk(url)) return json({ error: "unauthorized" }, 401);
    const st = (url.searchParams.get("store") || "").toUpperCase();
    if (url.searchParams.get("daily") === "1") {
      return json(await daily(STORES.includes(st) ? st : undefined, url.searchParams.get("again") === "1"));
    }
    if (url.searchParams.get("regrade") === "1") return json(await regrade());
    // ?fullpick=1&day=YYYY-MM-DD[&store=] — the daily ten for one day, by hand (a preview).
    if (url.searchParams.get("fullpick") === "1") {
      const day = url.searchParams.get("day") || ctDay(new Date(Date.now() - 86400000));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "day=YYYY-MM-DD" }, 400);
      const out: Record<string, unknown> = {};
      for (const x of STORES.includes(st) ? [st] : STORES) out[x] = await pickFull(x, day);
      return json({ day, picks: out });
    }
    if (url.searchParams.get("settle") === "1") {
      const fake = url.searchParams.get("fake");
      if (fake) {
        if (!STORES.includes(st) || !url.searchParams.get("productId")) return json({ error: "fake needs &store= and &productId=" }, 400);
        return json(await settle({ result: fake, store: st, productId: url.searchParams.get("productId") || "" }));
      }
      return json(await settle());
    }
    return json({ error: "pass ?daily=1, ?regrade=1 or ?settle=1" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
