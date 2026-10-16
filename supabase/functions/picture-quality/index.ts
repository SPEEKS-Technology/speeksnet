// ============================================================================
// picture-quality — do a listing's photos give a buyer enough to judge it?
//
// The fourth tool on the Listing Health page. For each live listing it picks the
// Picture Guide sheet the item belongs to, looks at every photo against that
// sheet and its example photos, and files one review: retake / fix / reorder /
// pass. READ-ONLY against Shopify in Phase 1 — the reorder is a suggestion here;
// applying one is a later, approved, one-click action.
//
//   THE SWEEP, ?secret= :
//     ?store=WSP&ids=gid,gid            DRY RUN on exactly these products
//     ?store=WSP&ids=...&save=1         …and file the reviews
//     &model=claude-opus-5&effort=low   calibration: which model, how hard
//
//     ?store=WSP&sweep=6                grade (and save) up to 6 live listings
//                                       that were never graded or whose stamp moved
//
//   THE PANEL, x-user-pin (Listing Health → Picture Quality):
//     GET ?view=review&store=WSP        the open queue, live photos, guide sheets
//     GET ?view=counts                  per-store open totals
//     POST {action:"dismiss"|"deny-reorder", store, productId, reason?}
//     POST {action:"reorder", store, productId}    applies the suggested order
//     POST {action:"recheck", store, productId}    grades it again now, and saves
//     POST {action:"reopen", store, productId}     undo a dismissal
//     GET ?view=feedback&days=30        dismissal notes + the ask, for Listing Health Notes
//     POST {action:"triaged", keys:[{store,productId}]}   those notes have been read
//
// ⚠️ THE MODEL REPORTS, THE CODE DECIDES. The model says which shot each photo
// is, what is wrong with each photo, what is missing, and whether the main flaw
// shows. Every threshold Ethan set — half the required shots missing means
// retake, 85% in order, square within 1% — is arithmetic below, so a verdict
// can always be traced to a number and a rule, and changing a rule never means
// re-asking (and re-paying for) the model.
//
// THE RULES, as Ethan calibrated them on ten WSP listings, 2026-09-24/25. His
// principle over all of them: flag what would stop a buyer judging the item,
// not every deviation from how he would have shot it — "probably wouldn't be
// the reason this doesn't sell." Lean pass.
//    1. Required shots are the sheet's always-taken shots, read LIVE from
//       pg_shots (he deleted iPhone "Settings Page 2" mid-calibration).
//    2. The MAIN reason for the condition must be clearly shown. Lesser flaws
//       need only be visible in the normal shots — buyers zoom.
//    3. Every photo SQUARE, within 1% (1080x1081 is an export rounding, fine).
//       Measured here from Shopify's width/height; the model never sees it.
//    4. The lead photo passes if it is a clear shot that shows what the item is.
//    5. Serial/model/CPU info may be on ANY photo or screen, BIOS included.
//    6. PayMore's standard condition wording is ignored for rule 2 — it is not
//       a claim about this unit. Found by FREQUENCY: a sentence that appears
//       word for word on many listings is the listing program's, not the
//       lister's (e.g. "Some of these scratches are semi-deep and easily seen").
//    7. Bad order is a reorder SUGGESTION, not a reshoot.
//    8. A deliberate closeup may be tight; "cut off" is only for whole-item shots.
//    9. Near-identical views of a round item (a lens turned 90°) may be skipped.
//   10. Stock, fake, AI-made or heavily edited photos are always flagged.
//   11. A loose cartridge/disk: two close photos is right.
//   12. Speaker pairs: the pair shots must show BOTH speakers together.
//   13. One photo can satisfy two shots; a closeup is unnecessary when another
//       photo shows the thing clearly.
//   14. 40% or more of the required shots missing → one action, "Retake
//       following the guide", not an itemised list. One missing PLAIN view
//       (a back, a bottom) is tolerated; a missing info shot never is.
//
// ONE ROW PER PRODUCT. See 0116 for why a SKU key is wrong (BAL shares SKUs).
// ============================================================================

import Anthropic from "npm:@anthropic-ai/sdk";
import { z } from "npm:zod";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk/helpers/zod";
import { agree, BOX_SHEETS, decide, isStandardSentence, needsSecondLook, PASS_BAR, pictureScore, verdictOf, type ListingR } from "./rules.ts";

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

// Starts DM-only (Ethan, 2026-09-23); later the same roles as ec-view-photos.
// ⚠️ Keep in step with the FEATURE_CATALOG entry when the panel lands.
const PQ_KEY = "ec-view-picture-quality";
const PQ_DEFAULT_ROLES = ["district manager", "ceo"];

// The cheaper model by default, because the task is recognition against a
// reference, not deep reasoning — and the calibration run is what decides
// whether that holds (?model= swaps it without a redeploy).
// Opus 5.5 from 2026-10-13 (Ethan: "let's move to opus"). On the 26 listings
// he had called it matched 21-22 to Sonnet 5's 12, for about the same money —
// Sonnet wrote ~4x the output tokens. See scratchpad ab.mjs / ab-score.mjs.
const DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_EFFORT = "medium";   // low wandered run to run on small visual calls (calibration 2026-09-25)
const PRICES: Record<string, [number, number]> = {   // $ per million in / out
  "claude-sonnet-5": [2, 10],
  "claude-opus-5": [5, 25],
  "claude-opus-5-5": [4, 20],   // 2026-10-13, A/B against Sonnet on Ethan's calls; list price, check before budgeting
  "claude-haiku-5-5": [0.1, 0.5],   // 2026-10-11, for the simple sheets (games) — see modelFor
};

// ⚠️ BUMP WHEN WHAT WE ASK CHANGES. It is part of every stamp, so a new recipe
// re-grades everything instead of leaving old answers given less to look at.
// v8 2026-09-25: a flag must be seen by two independent looks
// v11 (a separate framing look) scored worse and is off — see FramingReport.
const RECIPE = "pq-v18";  // v18 2026-10-11: PayMore's Good/Fair wording decides [standard] vs [unit]. v17: Ethan's scoring card v2 (rules.ts). v16 2026-10-08: photos from two spots cost 5/10/15 by price. v15: reflections cost 3/6/9 by price (not on Screen Off). v14: anything besides item + white backdrop costs 5/10/15 by price, like v13's dirty table. v12 2026-10-08: flagged by a weighted picture score under PASS_BAR, not by any finding. v10: controllers judged on their sheet; crooked = slanted in frame; wrong angle = side not visible; repeats

// Photos are sent at this size. The model sees framing, labels and screens
// fine at 800px; full size would roughly triple the bill for nothing.
const PHOTO_PX = 800;
const MAX_IDS = 12;
const CONCURRENCY = 4;

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

function secretOk(url: URL): boolean {
  const given = url.searchParams.get("secret") || "";
  if (given.length !== SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < SECRET.length; i++) diff |= given.charCodeAt(i) ^ SECRET.charCodeAt(i);
  return diff === 0;
}

// --- who is asking (panel) ---------------------------------------------------

type Scope = { name: string; role: string; stores: string[]; corp: boolean };

async function scopeFor(pin: string): Promise<Scope | null> {
  if (!pin) return null;
  const user = (await rows(`users?pin=eq.${encodeURIComponent(pin)}&select=name,role,store&limit=1`))?.[0];
  if (!user) return null;
  const role = String(user.role || "").toLowerCase().trim();
  const name = String(user.name || "");
  // Resolved the way the site resolves it: the person beats their role, and
  // neither saying anything means the default.
  const list = await rows(`feature_overrides?feature_key=eq.${PQ_KEY}&select=subject_type,subject,enabled`);
  const lc = (v: unknown) => String(v || "").toLowerCase().trim();
  const slug = role.replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-");
  const forUser = list.find((r: any) => lc(r.subject_type) === "user" && lc(r.subject) === lc(name));
  const forRole = list.find((r: any) => lc(r.subject_type) === "role" && lc(r.subject) === slug);
  const allowed = forUser ? !!forUser.enabled : forRole ? !!forRole.enabled : PQ_DEFAULT_ROLES.includes(role);
  if (!allowed) return null;
  const corp = ["district manager", "ceo", "mocd"].includes(role);
  const stores = corp ? STORES
    : role === "multi-store manager" ? ["BAL", "MPL"]
    : [String(user.store || "").toUpperCase()].filter(s => STORES.includes(s));
  return stores.length ? { name, role, stores, corp } : null;
}

// --- shopify ----------------------------------------------------------------

async function shopFor(store: string) {
  const all = await rows(`shopify_stores?select=shop,store_code,access_token`);
  // shopify_stores.store_code is NULL on every row; the domain map resolves it.
  const t = all.find((r: any) => r.store_code === store) || all.find((r: any) => r.shop === SHOP_BY_STORE[store]);
  if (!t) throw new Error(`no shopify_stores row for ${store}`);
  return { shop: t.shop as string, token: t.access_token as string };
}

async function gql(shop: string, token: string, query: string, variables?: unknown) {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  const body = await res.json();
  // Throttling arrives as a 200 with `errors` — throw, never read it as data.
  if (body.errors) throw new Error(`shopify: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data;
}

const strip = (s: unknown) => String(s || "")
  .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/\s+/g, " ").trim();

const parseList = (v: unknown): string => {
  const s = String(v || "").trim();
  if (s.startsWith("[")) { try { return (JSON.parse(s) as unknown[]).join(", "); } catch { /* fall through */ } }
  return s;
};

type Listing = {
  id: string; title: string; handle: string; sku: string; price: number; collections: string[]; tags: string[];
  condition: string; cosmetic: string; functional: string; included: string; notIncluded: string;
  // mediaId is what productReorderMedia moves; thumb is what the panel draws.
  photos: { url: string; width: number; height: number; src: string; mediaId: string; thumb: string }[];
};

async function fetchListings(shop: string, token: string, ids: string[]): Promise<Listing[]> {
  const q = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product {
      id title handle tags
      variants(first: 1) { nodes { sku price } }
      collections(first: 12) { nodes { handle } }
      condition: metafield(namespace: "custom", key: "condition") { value }
      cosmetic: metafield(namespace: "custom", key: "cosmetic_condition") { value }
      functional: metafield(namespace: "custom", key: "functionality_condition") { value }
      included: metafield(namespace: "custom", key: "whats_include") { value }
      notIncluded: metafield(namespace: "custom", key: "not_included") { value }
      media(first: 40) { nodes { ... on MediaImage { id image {
        url
        sized: url(transform: { maxWidth: ${PHOTO_PX}, maxHeight: ${PHOTO_PX} })
        thumb: url(transform: { maxWidth: 240, maxHeight: 240 })
        width height } } } }
  } } }`;
  const data = await gql(shop, token, q, { ids });
  return (data.nodes || []).filter(Boolean).map((p: any) => ({
    id: p.id, title: p.title, handle: p.handle || "", sku: p.variants?.nodes?.[0]?.sku || "",
    price: Number(p.variants?.nodes?.[0]?.price || 0),
    collections: (p.collections?.nodes || []).map((c: any) => c.handle),
    tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
    condition: parseList(p.condition?.value),
    cosmetic: strip(p.cosmetic?.value), functional: strip(p.functional?.value),
    included: parseList(p.included?.value), notIncluded: parseList(p.notIncluded?.value),
    photos: (p.media?.nodes || []).filter((n: any) => n?.image).map((n: any) => ({
      url: n.image.sized || n.image.url, src: n.image.url,
      width: Number(n.image.width || 0), height: Number(n.image.height || 0),
      mediaId: String(n.id || ""), thumb: n.image.thumb || n.image.sized || n.image.url,
    })),
  }));
}

// RULE 6 — NOW A FALLBACK. PayMore's own Good/Fair wording (PAYMORE_TEMPLATES in
// rules.ts, from Ethan 2026-10-11) decides first; this count covers only the
// categories those samples do not. Every sentence of every active listing's
// cosmetic notes, counted. A
// sentence the listing program writes shows up on dozens of listings word for
// word; one a lister wrote about this unit shows up once. Counted per store,
// which is enough: each store's program output repeats within the store.
const sentences = (s: string) =>
  s.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(x => x.length > 12);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

async function boilerplateFor(shop: string, token: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data: any = await gql(shop, token,
      `query($after: String) { products(first: 250, after: $after, query: "status:active") {
         nodes { cosmetic: metafield(namespace: "custom", key: "cosmetic_condition") { value } }
         pageInfo { hasNextPage endCursor } } }`, { after });
    for (const n of data.products.nodes) {
      const seen = new Set<string>();
      for (const s of sentences(strip(n.cosmetic?.value))) seen.add(norm(s));
      for (const k of seen) counts.set(k, (counts.get(k) || 0) + 1);
    }
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }
  return counts;
}

// --- who listed it ------------------------------------------------------------
// Ethan, 2026-10-08: "add the tag of who listed it so the managers can coach
// their teams on pictures." The same tag and the same matcher as the title
// tool (listing-titles listerIndex/listerFrom — read the long comments there):
// a tag counts only when it matches a real person in `users`, a store's own
// people beat the estate, a shared store login is never a lister, and a
// colliding form belongs to nobody. Copied rather than imported because the
// functions share no module; ⚠️ keep the two in step.
//
// ⚠️ READ LIVE, NEVER STORED. The panel already reads every queued product from
// Shopify for its photos, so the tags come with them — no column, no migration,
// and a rename shows right the next time the page loads.
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
// No match in users: the tag ITSELF, so the row still says who (Ethan,
// 2026-10-14: "Instead of unknown, just put the raw tag for those people").
// Only a tag that looks like a person — not eBay / INV / market / a number.
const NOT_A_PERSON = /^(ebay|inv|market|pickuponly|pendingoffer|b2b|rcy|new|used|sale|read|no|yes|local|shipped|hold)$/i;
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

// --- the guide ----------------------------------------------------------------

type Shot = { label: string; cond: string | null; repeatable: boolean; note: string | null; img: string | null; crucial: boolean };
type Sheet = { slug: string; name: string; group: string | null; updated: string; shots: Shot[] };

async function loadSheets(): Promise<Sheet[]> {
  const cats = await rows(`pg_categories?active=eq.true&select=id,slug,name,group_name,updated_at`);
  const shots = await rows(`pg_shots?select=category_id,label,cond_label,repeatable,note,image_path,crucial,sort_order,updated_at&order=sort_order`);
  return cats.map((c: any) => {
    const mine = shots.filter((s: any) => s.category_id === c.id);
    const newest = [c.updated_at, ...mine.map((s: any) => s.updated_at)].sort().pop();
    return {
      slug: c.slug, name: c.name, group: c.group_name, updated: String(newest || ""),
      shots: mine.map((s: any) => ({ label: s.label, cond: s.cond_label, repeatable: !!s.repeatable,
                                     note: s.note, img: s.image_path, crucial: !!s.crucial })),
    };
  });
}
const guideUrl = (path: string) => `${SUPABASE_URL}/storage/v1/object/public/picture-guide/${encodeURIComponent(path)}`;

// ⚠️ WE FETCH THE PHOTOS, NOT THE MODEL. Handing Anthropic the URL was the first
// version, and on the first calibration run one Surface photo timed out on
// their side ("The request timed out while trying to download the file") and
// the whole listing went ungraded. Fetching here, with a retry, and sending the
// bytes makes a slow CDN our problem to retry instead of a lost review. Cached
// per invocation because every listing on a sheet sends the same examples.
const imgCache = new Map<string, Promise<any>>();
function imageBlock(url: string) {
  if (!imgCache.has(url)) {
    imgCache.set(url, (async () => {
      let last = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const type = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
          const bytes = new Uint8Array(await r.arrayBuffer());
          let bin = "";
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          const media = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type) ? type : "image/jpeg";
          return { type: "image", source: { type: "base64", media_type: media, data: btoa(bin) } };
        } catch (e) { last = String((e as Error).message || e); await new Promise(r => setTimeout(r, 400 * (attempt + 1))); }
      }
      throw new Error(`could not fetch a photo (${last}): ${url.slice(0, 80)}`);
    })());
  }
  // A clone, because the sheet's last example gets a cache_control marker.
  return imgCache.get(url)!.then(b => ({ ...b }));
}

// --- the model ---------------------------------------------------------------

const SheetPick = z.object({
  slug: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  why: z.string(),
});

const PICK_SYSTEM = `You choose which Picture Guide sheet a used-electronics listing should be photographed against. Answer with one slug from the list, or null.

Rules:
- Pick the sheet for what the item IS, from the title, collections and what is included.
- A game whose case is NOT included (e.g. "Case" in the not-included list) uses the Video Games (No Case) sheet, slug "video-games-disk-cartridge-only". A game with its case, sealed or not, uses "video-games".
- "New In Box", "New Open Box" and "Item Lots" are for items that are new-in-box, open-box, or a lot of several items — but new sealed video games use "video-games".
- Two matching speakers sold together use "speaker-pairs". Indoor/outdoor, bookshelf, wall-mount and satellite speakers are never "subwoofers" — a subwoofer is the single bass cabinet with one large driver. When the photos or the included list show two matching speakers, it is "speaker-pairs" even if the title says "Speaker" (WSP Pyle PDWR53BTBK).
- A data-centre / server accelerator — a bare compute module or card with no fan and no display outputs (NVIDIA Tesla, A100, H100, an SXM module) — is not a graphics card: "small-medium-misc-items" (MPL NVIDIA Tesla V100, 2026-10-14).
- A smart ring (Oura, Elenva, Samsung Galaxy Ring, Ultrahuman, any fitness/health ring) is not a watch: "small-medium-misc-items", confidence "high" (LEE Elenva Ring Gen 2 Air, 2026-10-15: "no confident sheet match").
- A laptop is "windows-laptops" unless the title says Chromebook or MacBook (or it is a gaming laptop) — budget specs (Celeron, 4GB, 64GB) do not make it a Chromebook (OVL HP Stream 14, 2026-10-13: twice "no confident sheet match"). Answer with confidence "high" when this rule decides it.
- Trading cards (Pokémon, Magic, Yu-Gi-Oh, sports cards, any TCG card) use "video-games-disk-cartridge-only" — a card is shot like a game with no case.
- A NEW item still sealed in its retail packaging (the title starts "New", or the condition says new or sealed) uses "new-in-box" — small things on a card or blister pack too (a memory card, a cable) — except video games, which keep "video-games".
- An item with no sheet of its own uses the CLOSEST similar sheet — a mirrorless or DSLR camera uses "point-and-shoot-cameras", a tablet-like device uses a tablet sheet. Use "small-medium-misc-items" only when nothing on the list is similar.
- If you cannot tell what the item is, return null with confidence "low".`;

const PhotoReport = z.object({
  n: z.number().int(),
  shots: z.array(z.string()),
  whole_item: z.boolean(),
  // An earlier photo this one repeats — the same view, barely moved. Null if none.
  repeats: z.number().int().nullable(),
  framing: z.enum(["matches", "close", "off"]),
  framing_problems: z.array(z.enum(["crooked", "off_center", "too_small", "cut_off", "wrong_angle", "turned"])),
  issues: z.array(z.object({
    type: z.enum([
      "blurry", "too_dark_or_glare", "clutter", "reflection",
      "stock_photo", "fake_or_edited", "personal_info", "wrong_item", "dirty_backdrop", "loose_cord", "not_on_stand",
    ]),
    severity: z.enum(["minor", "major"]),
  })),
  note: z.string(),
});
const Report = z.object({
  sheet_fits: z.boolean(),
  better_sheet: z.string().nullable(),
  photos: z.array(PhotoReport),
  missing_shots: z.array(z.string()),
  needed_missing: z.array(z.string()),
  flaw_views: z.array(z.string()),
  units_claimed: z.number().int().nullable(),
  all_units_shown: z.boolean(),
  units_together: z.boolean(),
  all_sides_shown: z.boolean(),
  flat_package: z.boolean(),
  screen_never_on: z.boolean(),
  new_claim_wrong: z.boolean(),
  main_flaw: z.object({
    stated: z.string().nullable(),
    source: z.enum(["unit", "title", "none"]),
    shown: z.enum(["yes", "partly", "no", "not_applicable"]),
    photo: z.number().int().nullable(),
  }),
  serial: z.enum(["shown", "hidden_behind_cover", "not_shown"]),
  lead_ok: z.boolean(),
  // Photos taken in the same spot, grouped: [[1,2,3],[4,5]]. See setupsFinding.
  setups: z.array(z.array(z.number().int())),
  setup_difference: z.string(),
  suggested_order: z.array(z.number().int()),
  title_notes: z.array(z.object({ issue: z.string(), suggestion: z.string(), photo: z.number().int().nullable() })),
  summary: z.string(),
});
type ReportT = z.infer<typeof Report>;

const REVIEW_SYSTEM = `You grade the photos of one used-electronics listing against the store's Picture Guide sheet for that kind of item. You report what you see; the store's code turns your report into a verdict, so be exact and do not decide pass/fail yourself.

The owner's principle: a photo problem matters only if it would stop a buyer judging the item. When a call is borderline, report no issue.

sheet_fits: false only if this sheet is clearly the wrong kind of item (e.g. a camera listed on a phone sheet). On the Graphics Cards sheet, a bare server compute module (NVIDIA Tesla, A100, H100, SXM — no fan shroud, no display outputs) is the wrong sheet: better_sheet "small-medium-misc-items". On a VIDEO GAME sheet the photos decide case or no case, whatever the listing's fields say: photos of the game's own case (its front or back cover, the opened case holding the disc or cartridge) mean "video-games"; only the bare disc or cartridge means "video-games-disk-cartridge-only". When this sheet is the other one, sheet_fits is false with that better_sheet (WSP Chrono Cross and Super Mario Odyssey, 2026-10-11 — both shot in their cases, graded as cartridge-only). Then give better_sheet as a slug from OTHER SHEETS; otherwise better_sheet is null. One more case: on the New In Box sheet, if the photos show the item ITSELF out of its packaging (opened, handled, not sealed), the sheet is wrong — better_sheet "new-open-box" (WSP Yale lock, 2026-10-11).

For each photo (numbered from 1, in listing order), report:
- shots: which sheet shot labels it covers. A spec, settings or system screenshot is never "Extra" — name the info shot it shows (CPU, RAM, storage, graphics, battery, About), even when it is a second page of the same info. "Everything Included" is ONE photo of the item together with everything it comes with; a photo of an accessory, a cable or the inside of the box on its own is "Extra Accessories" (or "Box"), never Everything Included (WSP Galaxy Tab A9: a box insert holding the cable was taken for it). One photo may cover two (a front view with the lens cap off is both "Front of Projector" and "Front of Projector (Lens Open)"). Use "Box" for packaging, "Extra" for anything that is not a sheet shot. "Box" is ONLY the packaging — a plain, dark, boxy DEVICE shot from its sides and top is the device, labelled with its views (WSP Loupedeck+: photos 3-7 were the console itself, called "Box", and its sides "missing"). Before you call any photo "Extra", or any view missing, hold every photo up against EACH of the sheet's view examples: a photo that shows that view at all, at another angle or distance, IS that shot. The UNDERSIDE of an item — its feet, a label plate, screws, a battery door — is its Bottom view (OVL 8BitDo keyboard: photo 4, the beige underside, was called a side and the bottom "missing"; OVL PS3 controller: the view from below the grips was called Back and the bottom "missing"). MOTHERBOARDS: a close, angled photo of one area of the board — the I/O ports, the RAM slots, the CPU socket — is that area's Closeup shot with whole_item false, not a side of the board, and its edges running out of the frame are not "cut_off" (OVL MSI Z390 photos 2-5).
- whole_item: true if it is meant to show the whole item, false for a deliberate closeup (glass, mount, ports, a label). A closeup may be tight — never report cut_off on one.
- repeats: the number of an EARLIER photo this one repeats — ONLY when the two are near-identical: the same face of the item, from the same angle, only slightly moved or re-cropped, adding nothing a buyer did not already see. The SAME face shot again in a different spot — lying flat on the table after being shot on the stand, against another background — IS a repeat of the earlier one: name the photo in the store's standard setup (OVL Ryzen 7 2700X: 5, 6 and 7 lay flat and showed the same faces as 1 and 2 on the stand; OVL Ryzen 5 1600: 2 and 5 were photo 1 again; OVL Evercade game: 4 and 6 were the case front and back again, flat). Two photos where a part is in a different STATE are not repeats — a camera's lens extended vs retracted, a lid open vs closed, a screen on vs off (OVL Canon SX740: photo 4 has the lens out, photo 1 in). A closeup of a label or serial is never a repeat of the face it is on — but a closeup is shot TIGHT on the label. A second photo of the WHOLE face again, even flipped upside down, is a repeat (whole_item true), not a closeup (OVL Crucial DDR5: photo 2 was photo 1's label side again, pins up — "the same photo as photo 1"). Two photos of the same ARRANGEMENT — the item lying in the same place beside its accessories — are repeats even when one accessory is added or moved between them (OVL Canon SX740: photo 10 shows the camera with its charger, photo 11 the same with the battery added; Ethan: "the same photo"). Null if it shows anything new (another side, another angle, a detail). NOT repeats, however alike they look (WSP, 2026-10-11 — every one of these was wrongly called a repeat): the different sides of a watch or device seen at different angles; a screen-off shot and an everything-included shot of the same watch; the faces of a PLAIN box — top, bottom and the two sides are different faces even with nothing printed on them; two views of earbuds at different angles; the FRONT and the BACK of an item that looks the same from both sides — over-ear headphones on the stand, a plain case — when the sheet asks for both a Front and a Back shot, two such photos are the front and the back: label the second one the Back shot (WSP Beats Studio3 and Solo4, 2026-10-11). When in doubt, null — a repeat offers the store a one-click deletion, so a wrong one deletes a good photo. A CLOSER shot of the same view that brings a guide shot into focus is that guide shot, not a repeat: a tight front shot of glasses that shows the middle bridge is "Middle Bridge" (OVL Ray-Ban Meta, 2026-10-11 — photo 4 was called a repeat of photo 1 and the bridge was called missing). Check every closeup against the sheet's detail shots before calling it a repeat. Do look for these repeats, which were missed: three photos of a tablet's lit screen from the front, the same screen on the same stand — the first one stays, the others repeat it (OVL Onyx Boox photos 6, 7 and 8; its photo 12 was photo 3 again); two label closeups of the same RAM stick or two of the same top view (OVL Crucial Ballistix 3 and 4, 5 and 6). More that were missed: a case's back shot twice in a row (WSP AirPods 5th Gen photo 3 = photo 2; photo 7 = photo 6, the open case again); the same laptop view later in the listing (WSP Lenovo Legion 5: photo 17 = photo 14); a watch's back sensor shot four times from nearly the same angle (WSP Galaxy Watch7: 6, 7 and 8 = 5); a small ring propped in its charging case and shot twice from nearly the same angle, even when you labelled the two different sides (LEE Elenva smart ring photos 3 and 4 — "they are the same picture"); a game cartridge's front shot again closer (LEE Zelda Breath of the Wild photo 3 = photo 1); a controller's grip end shot twice at nearly the same angle, even when you labelled one "Side" and the other "Side" and "Opposite Side" (LEE Xbox Series X|S controller photos 5 and 7); on a listing that sells ONE of several identical units, the same view of the next unit (LEE Wii Remote QTY3: each remote's sides, top and bottom shot one after another). Two LIT screens showing different things are NOT repeats — a camera's live preview and its menu, two different settings pages (LEE Insta360 X3 photos 3 and 4: "showing the menu and the camera working").
- framing: compare the photo to the sheet's EXAMPLE of the same shot. "matches" = shot like the example. "close" = small differences a buyer would not care about. "off" = one of these framing_problems. Judge EVERY photo of the item on its own — a listing where photo after photo sits low or to one side of the frame, or leans, is exactly what the store wants found, even when each one alone looks like a small miss:
  crooked — the item is rotated IN THE PICTURE: edges that should run level or upright visibly slant, as if the camera was turned. An item or box propped on the ITEM STAND to show a narrow side, top or bottom will lean or sit at an angle — that is how the stand holds it, and it is NEVER crooked (OVL Xbox 360 controller box: its side shots on the stand were called crooked, and they are to standard). A different VIEWPOINT is not crooked — a tablet stood on edge and shot from the corner, a game case shown at the same angle as the example, a deliberately angled side view. A round item shot face-on (a lens, a speaker cone) is never crooked.
  off_center — the item sits clearly to one side, or low or high, in the frame instead of centred like the example (a stray cable or the stand does not count; the item does).
  too_small — the item is much smaller in the frame than in the example, leaving a lot of empty background (e.g. a phone lying small in the middle of the photo where the example fills the frame). A tall or thin item leaving space on its short sides is not this.
  cut_off — part of an item meant to be shown whole is outside the frame (e.g. the top of a tablet's screen cropped off). A game's "Opened Case With Disk" shot shows the WHOLE open case, like the example: shot so close that part of the open case is outside the frame is cut_off (LEE This War of Mine photo 3, LEE Payday 2 photo 3).
  wrong_angle — the side or part the shot is FOR cannot be seen (e.g. a "Top Side" shot taken from straight above with the phone lying flat, so the top edge is not visible). A different angle from the example that still shows that side clearly is NOT wrong_angle — the guide's photos are there to show each side of the device, not to fix one exact angle. A photo that is not a sheet shot is never wrong_angle. A photo turned upside down or sideways is not wrong_angle. EXCEPT a FLAT item's FACE — the top or bottom of a memory stick, an SSD or a board, the front or back of a CPU: the face IS the shot, and the example shows it square-on, standing on the stand. A face laid back on the stand and shot from steeply above, so it is seen squashed and edge-first instead of square-on, is wrong_angle (OVL Crucial DDR5 photo 3: the back of the stick lying back and seen from above).
  turned — the item is turned a different way from the guide's example AND the listing's other photos of the same view: stood on its end, or the long way up, where they lie lengthways (WSP TeamGroup RAM: photo 1 shows the sticks lengthways on the stand, photo 2 stood them upright on end). This applies to an Extra photo too. On the LENSES sheet, a lens lying on its barrel for a Front / Back / Side shot IS turned — the examples stand it upright (MPL Pentax 20790 photos 5 and 6). Otherwise never on a side, top, bottom or corner shot — turning the item to show that edge is the point of the shot (OVL Toshiba HDD photos 3 and 4, stood on edge on the stand, are right). Not a photo that turns the item over to show another face (an upside-down shot showing the bottom), and not the stand's normal lean. On a FLAT item whose faces are the shots (a memory stick, an SSD, a board, a CPU), "Top of …" and "Bottom of …" are its two FACES, not edges, so the side/top/bottom exception does not cover them: a face shot stood on end where the example lies lengthways is turned (OVL SK Hynix PC601 SSD photo 3), and so is a face rotated in the frame so its printing reads SIDEWAYS or upside down where the example's reads upright (OVL Ryzen 5 2600 photo 1: the CPU sat a quarter turn round, "RYZEN" reading down the photo).
  If framing is "matches" or "close", framing_problems is empty. Photos of OTHER things that come WITH the item — its box, cables, chargers, a console's controllers, a case, an everything-included spread — are staged: give them "matches". But when that thing IS the item (a controller on the Game Controllers sheet, a box on a New In Box sheet), it is the item and is judged. A photo of the item itself is always judged, even if it is not a sheet shot. A deliberate closeup of a detail (a label, ports, a lens mount, a memory stick's pins shot on its stand) is never cut_off — but a photo meant to show the whole screen or body that crops part of it off is.
- issues, only when clearly true, each with a severity. "major" means a buyer would notice and it hurts the listing; "minor" means you can see it but it does not matter. Only major issues are acted on:
  blurry, too_dark_or_glare — the detail the shot exists for cannot be made out AND it is something a buyer needs: a label, a screen, a flaw, the face or body of the item. An edge-on view of a thin item with nothing printed on its edge (a memory stick's side) is not this, even if soft. A "Screen Off" shot is meant to be a dark screen — never report it as too dark (a mirrored room or light in it is a "reflection", below).
  reflection — the room, a light, a window, the photographer, or the phone or camera taking the photo is mirrored in the item's glossy surface (a screen, a case, the shrink-wrap of a box) — a reflection you can plainly make out. Report it on EVERY photo it shows in, as "major" whenever you can see it — a "Screen Off" shot too: a room, a light or the photographer mirrored in the dark screen is a reflection there as well (LEE Lenovo 13w photo 6 — Ethan, 2026-10-15: "Screen off can definitely be flagged for reflection too"). Soft even sheen with nothing mirrored in it is not a reflection. A LIT screen reflects too: a pale band, a window or a light glaring across a screen-on or settings photo is a reflection — check every screen-on photo of a tablet or phone, not only the first (WSP Galaxy Tab A9 Plus photos 5-7; the T-Mobile Tab A9 Plus photos 1-4). The HOME/LOCK SCREEN lead photo most of all: a pale, milky wash or a light-edged shape across part of the screen that greys out the wallpaper and the widgets under it is the lightbox mirrored in the glass, not part of the wallpaper — compare that corner with the rest of the screen (WSP iPad 11" A16 Yellow photo 1: a hazy band over the upper left, missed while photos 3-5 were caught).
  clutter — something in the frame that is not the item, its stand or the plain white backdrop. A spec or settings screen photographed off a MONITOR must show the screen only: a photo that shows the monitor's frame and stand, the desk or the room around it is clutter (OVL Steam Machine photos 2 and 3). Otherwise: the edge of the lightbox or a wall, the FRONT EDGE OF THE TABLE showing as a line or a darker band along the BOTTOM of the frame (look at the bottom edge of every photo, not just the sides and top — WSP Konica toner and Sekonic meter, photo 1), another item, a hand, a tool, mess. Check EVERY photo for it separately — a wall or lightbox edge in one photo is usually in the photos taken next to it too (WSP i5-4690K: photo 3 was missed beside photo 4). Report it on EVERY photo it shows in, and as "major" whenever you can plainly see it — a buyer's eye goes straight to it. Things that come WITH the item (its box, cables, accessories, everything included, the other items of a lot) are not clutter.
  stock_photo — a manufacturer or web image, not this unit.
  fake_or_edited — looks AI-generated, composited or heavily edited (a product floating unnaturally with no surface).
  personal_info — a customer's name, Apple ID or email on screen, or a phone number in their contacts, messages or account. NOT the phone number on an About / Status / SIM settings screen — that is the store's own test SIM (Ethan, 2026-10-11, WSP Galaxy Tab A9). Only what you can actually READ in the photo at normal size — never a name you infer from a menu bar or a title bar too small to read (LEE 2014 MacBook Pro photo 1 was called personal info, and "does not show any personal information").
  wrong_item — plainly a different product from the title (another model or device). A colour that differs from the title is a title_note, not this.
  dirty_backdrop — the table, backdrop or stand the item is shot on is visibly dirty: scuff marks, scratches, stains, dust or debris on the surface around the item. Report it on EVERY photo it shows in, box and accessory photos included, and always as "major" — a dirty surface makes a clean item look grubby. Normal shadows, the stand's own reflections, the backdrop's gradient, the grain or texture of the backdrop, and light falling off toward the edges are not dirt — report only marks you could point to on a clean surface, and only as "major" when a buyer would notice them at a glance at normal size — one light scuff on the table is "minor" (WSP Gigabyte B850 box: "not horrible, I would've let this one pass") — faint specks you have to look for are "minor" (BAL Avolusion HDD: "not dirty enough to get flagged") (OVL 2023 MacBook Pro: photos 9-14 were called dirty and the table was perfectly clean). Light scuff marks on the table around an item are "minor" too: "major" is dirt, stains or debris a buyer sees at a glance (LEE 2022 MacBook Air photos 9-12: "some scuffs on the table but it is not horrible enough to flag").
  loose_cord — the item's own cable or power cord lies loose and sprawled across the frame instead of being tied, coiled or wrapped up neatly. That applies in an accessories photo too: a cable left in loose, open loops beside the item is loose (WSP XP-PEN photo 6), while cords laid out neatly in a tidy bundle beside the item for an Everything Included shot are fine (OVL Sony Handycam). Report it on EVERY photo it shows in, always as "major". A cord bundled with a tie, neatly coiled or wrapped (even with its plug end free), or tucked out of the way is fine — OVL 2023 MacBook Pro photo 16, a wrapped charger cable, was wrongly called loose (a speaker pair with its cords wrapped is the good example), and so is a cord plugged in to show a screen on. A wired controller's cord gathered in a loop or coil beside it is wrapped, even if it is not tied (LEE Original Xbox Controller S photo 1: "the cord is wrapped up fine"; LEE NES Zapper photo 1, its cord coiled in loops beside the gun: "wrapped up properly").
  not_on_stand — VIDEO GAME SHEETS ONLY: the game (its closed case, disc or cartridge) is lying flat on the table or propped some other way, instead of standing upright on the clear item stand the way the guide's examples are shot. Report it on EVERY such photo, always as "major". Never on any other kind of item, and never on a photo of the game laid out TOGETHER with its manual, inserts or accessories — that photo shows what comes with it (LEE Bully photo 4: "all good because it is showing the game with accessories of the game").
- note: a few words on what the photo shows.

missing_shots: the sheet's ALWAYS shots with no photo covering them (never an "only if" shot — those go in needed_missing). Info shots (serial, model, CPU, RAM, storage) count as covered if ANY photo or screen shows the information legibly, including a BIOS or settings screen. A round item turned 90° looks the same — do not list its near-identical rotations as missing. LENSES sheet: Front, Back, Side and Opposite Side are the four views round the BARREL, each a quarter turn apart — a lens is round, so they look alike; tell them apart by the markings, the focus window, the switches. Count the distinct barrel views across all the photos: a view shot with the lens LYING on its barrel still counts as that view (it is also "turned" — see framing), and a second photo of the same face (two fronts) counts once. Fewer than four distinct views means the rest are missing — the Opposite Side is the usual one (MPL Pentax 50 50mm and Pentax 22630: three views, Opposite Side missing; MPL Tamron 90mm: four views, two of them lying, so nothing missing). Top of Lens looks down at the front glass, Bottom at the mount; a cap beside it is fine.
A shot of a feature THIS item does not have is never missing: an "(On)" shot for an item with no screen, display, lights or LED that would show it is on (BAL Audiosource AD1002 amplifier — "this isn't something that shows that it is on"; its plain front covers the On shot); internals "(Glass Off and On)" on a PC with no glass side panel (OVL Steam Machine); a keyboard on a tablet or 2-in-1 sold without one (OVL Surface Pro 11). BEFORE listing any shot as missing, look again at every photo you labelled Extra, and at every closeup — a serial label closeup is often there (OVL Surface Pro 11's was called missing): it is often a shot you did not name (a top edge, a side of a box). For a box, deduce each side from what is printed on it — and for a PLAIN box (an Apple box is plain on most faces), from its shape and orientation: the long thin faces are the top and bottom, the short ends are the sides. A shot is covered only when the photo shows the item set up as in the example: a watch sold WITH a band must be photographed with the band attached, as the guide's examples are — a bare watch face (band shown separately) does not cover those shots. A serial/model closeup is not missing when the serial is hidden behind something that must be removed (a battery cover) — only when it is printed on the outside.

needed_missing: the sheet's "only if" shots that THIS listing calls for and no photo covers. A listing calls for one when it says the thing the shot is for: Everything Included when the INCLUDED field lists items; Extra Accessories when the listing names extras beyond the standard contents; Cosmetic Flaws when a cosmetic note marked [unit] describes a flaw on this unit (never for [standard] sentences); LCD Flaws when the functional notes describe a screen problem; any other "only if" shot when the listing states its condition (e.g. lamp hours, an active warranty). Use the sheet's exact shot names. Empty if none.

flaw_views: the sheet's view shots (sides, back, top, bottom, corners) that a [unit] cosmetic note or the title puts a flaw ON — "dent on the back" makes the back view one. Exact shot names; empty if none.

units_claimed: when the listing sells MORE THAN ONE of something — a pair, a set, a 2-pack, "Lot of 6", several units in the INCLUDED field — the number of units; otherwise null. all_units_shown: true unless the photos, taken together, plainly fail to show every unit the listing says it has (a lot of 6 games must show 6 games). units_together: true if the whole-item shots (front, back, sides, top, bottom) show all the units together; false if those shots show one unit at a time (single-unit photos as extras are fine). For a single item: null, true, true.
screen_never_on: true ONLY when the item has its OWN built-in display (a drawing tablet with a screen, a handheld, a portable monitor, a dashcam) AND the sheet has no shot of the screen turned on AND no photo shows that display lit. False for an item with no display, or when any photo shows it on (WSP XP-PEN Artist 12: a pen display on the Misc sheet, never shown on — Ethan: "because it has a screen I would want to see it on").
new_claim_wrong: true ONLY when the listing (title, condition or cosmetic notes) says the item is new — "brand new", "never used", "sealed", "unopened" — AND the photos plainly show a used one: opened with no seal or shrink-wrap, handled, worn, scratched (LEE Payday 2: the notes say "BRAND NEW!" and "never been used" over a cartridge with wear — "this game is brand new when it is in fact not"). False when the listing makes no such claim, or the photos agree with it.
flat_package: NEW IN BOX / NEW OPEN BOX sheets only — true when the packaging is FLAT: a blister card, a hanging card, a sleeve or an envelope (a memory card on its card), with no real top, bottom or sides to photograph. False for a box, and on every other sheet.
all_sides_shown: true when the photos, taken together, show EVERY edge of the device — top, bottom, left and right — clearly enough to judge its condition. A corner shot shows the two edges that meet there, so four corner shots can show all four sides. Angles different from the guide's are fine; the side and corner shots exist to show the sides, not to match one exact angle. False if any edge is never seen. For a boxed item, judge the item, not the box. A tablet or e-reader standing on one edge, or seen edge-on, shows that edge — four such photos of its four edges are all its sides, whatever the guide's corner examples look like (OVL Onyx Boox NoteAir 2 photos 4, 5, 9 and 10).

main_flaw: the one specific defect that is the main reason this unit is not in better condition — a crack, a dent, missing keys, a broken part — taken from notes marked [unit] (source "unit") or from the title (source "title"). General wear ("scuffs, scratches and wear", "minor marks") is NOT a main flaw. Ignore every sentence marked [standard] — it is the listing program's template, not about this unit. If there is no such specific defect: stated null, source "none", shown "not_applicable". A screenshot counts as showing a defect only a screen can show (Battery Health for a bad battery, a lock or iCloud screen). Otherwise: shown "yes" if a photo shows it clearly, "partly" if it is visible but not clearly, "no" if no photo shows it. Lesser flaws never need their own photo.

serial: "shown" if any photo shows the serial number legibly — a label, or a settings / About screen that lists it; "hidden_behind_cover" if it is on a part that must be removed to see it (under a battery cover, inside a compartment) and no photo opens it; otherwise "not_shown".

setups: the way MOST of the photos were taken is the standard — the photos taken another way are the odd ones, whether those are on the stand or off it (LEE Sony A7 III: one front on the stand among seven photos off it — "when the majority is taken a certain way, the minority should be the flag"). A stand propping a lid open is fine. A photo lying flat on the table among photos on the stand is a different spot unless the guide's example for that shot is shot flat (LEE Insta360 X3 photo 5, the screen side laid flat beside stand photos). Leave OUT of every group: an OPENED game case (some will not stay up on the stand — Ethan, OVL Evercade), closeups (whole_item false, e.g. a serial label) and small loose parts lying flat (earbuds out of their case, cables) — those may be shot off the stand. Then: group EVERY photo of the ITEM by where it was taken — the same backdrop, the same lighting, the same stand or surface — one array of photo numbers per spot. A listing shot all in one place is one group. Two groups means some photos were plainly taken somewhere else: a different backdrop or wall, light that is a different colour or brightness, a different surface, the stand in one and not the other. A closeup that is nearer than the others, the same spot otherwise, is the SAME spot. The CAMERA ANGLE is not a spot either: a large item shot straight on in some photos and from an angle in others, on the same table against the same backdrop, is one setup (OVL NZXT custom PC: photos 1, 9 and 11 straight on beside angled 2, 3 and 10 — Ethan: they "make sense taken the way they are"). A photo shot the way the GUIDE'S EXAMPLE for that shot is shot is never the odd one: the tablet guides lay the tablet flat for the corner and side shots, so flat corner shots beside upright front and back shots on the stand are one setup (WSP Galaxy Tab A9, 2026-10-11 — "the pictures mimic the angles in the picture guide pretty perfectly"). Compare each photo with its example before calling stand vs flat a different spot. Look hard for the clear stand before calling a photo off it: it is often only a thin acrylic edge or a small base under the item (WSP PlayStation Portal photo 2 and Hitman 3 photo 1 were on the stand and called a different spot). That covers the backdrop and light too: a top or bottom shot taken looking DOWN at the item lying on the table shows the flat white table and brighter light rather than the curved backdrop, and that is the same spot when the guide's example is shot that way (WSP 2019 MacBook Pro photos 10 and 11; WSP Dell WD19 dock, top and bottom edges laid flat — Ethan: "exactly what the guide shows"). Before putting ANY photo in a second group, find the guide example for its shot; if the example is shot the same way, it belongs in the first group. Leave out photos that are not of the item (a box or accessory spread shot elsewhere on purpose) and screenshots. setup_difference: a few words on what differs between the groups, or "" if one group.

lead_ok: true if photo 1 is a clear shot that shows what the item is (it need not be the sheet's first shot).

suggested_order: every photo number once, in the order the sheet would put them — the item before its box, Everything Included second, sheet shots in sheet order, extras last. Keep the store's order of the spec / settings screenshots among themselves. If the current order is already fine, return it unchanged.

title_notes: only where the photos show the title is wrong or incomplete — a model number on a box or label that differs from the title, a feature the photos contradict, or "Cartridge Only"/"Disc Only" missing from a game with no case. Empty if none.

summary: one plain sentence a store manager would understand.`;

// --- the framing look ----------------------------------------------------------
//
// ⚠️ CENTRED, LEVEL AND BIG ENOUGH ARE ASKED IN A CALL OF THEIR OWN (Ethan,
// 2026-10-08: "I want our tool to work 100% of the time"). Inside the main
// review they were three words among forty fields, and the model passed two PS3
// controllers, an iPhone SE and an iPad Ethan would flag — on the gold PS3 one
// look named four crooked photos and the next named none. A call that does
// nothing but framing, photo by photo against the examples, is the attention
// those three words were not getting. Measuring was tried first and failed —
// see the note above decide().
//
// ⚠️ OFF BY DEFAULT — IT SCORED WORSE (2026-10-08, 19/29 against pq-v10's
// 24/29). It swung the other way: it caught the iPhone SE, iPad and gold PS3,
// and then called the Onyx's edge shots, the WSP PS5, the Xbox One, the Ray-Ban
// box and the black Galaxy "crooked" — BOTH looks agreeing, so it is a steady
// misreading of viewpoint as lean, not noise. And the extra calls pushed three
// listings past the wall clock. Kept for calibration only: ?framing=1 on the
// secret route turns it on. Next step is a per-PHOTO labelled set from Ethan
// (centred / off / crooked), so this can be tuned against photos, not listings.
const FramingReport = z.object({
  photos: z.array(z.object({
    n: z.number().int(),
    item_photo: z.boolean(),
    centred: z.enum(["centred", "slightly_off", "off"]),
    level: z.enum(["level", "slight", "slanted"]),
    size: z.enum(["like_example", "smaller", "much_smaller"]),
    note: z.string(),
  })),
});
type FramingT = z.infer<typeof FramingReport>;

const FRAMING_SYSTEM = `You check ONE thing about a used-electronics listing's photos: whether each photo of the item is framed to the store's standard. The standard is the sheet's example photos — the item on a plain backdrop, usually on a clear stand, centred, level, and filling most of the frame.

This check exists because the owner looked at a listing where every photo seemed fine at a glance and said "a lot of the photos are not centred and some are crooked". Look at each photo on its own, carefully, and compare it with the example of the same shot.

For every photo, numbered from 1 in listing order:
- item_photo: true if it shows the whole item (any side, any screen). False for a deliberate closeup of a detail (a label, ports, pins, a lens mount), and for photos of things that come with the item rather than the item itself (its box, cables, chargers, a spread of everything included). When the sheet's item IS a box or a controller, photos of that box or controller are item photos.
- centred: where the item's own outline sits — ignore the stand, its shadow and any trailing cable. "off" = clearly to one side, or clearly high or low: the gap on one side is about twice the gap on the other or more. "slightly_off" = you can see it is not quite centred but a buyer would not notice. Otherwise "centred".
- level: "slanted" = the item is rotated in the picture — edges that should run level or upright visibly tilt, as if the camera was turned or the item slumped on the stand. A different VIEWPOINT is not slanted: a device stood on edge and shot from its corner, a side view angled like the example, a box shown in perspective. A round item shot face-on is always "level". "slight" = a tilt you can see but would not reshoot for.
- size: compare how much of the frame the item fills with the example of the same shot. "much_smaller" = clearly less than the example — lots of empty backdrop where the example fills the frame. A tall or thin item leaving space on its short sides is not smaller. A small item (a cartridge, a memory stick) shot as close as the example is "like_example".
- note: a few words on what you saw.
For a photo that is not an item photo, give "centred", "level", "like_example".`;

async function framingLook(client: Anthropic, model: string, effort: string, sheetBlocks: any[], photoBlocks: any[]) {
  const content: any[] = [...sheetBlocks, { type: "text", text: "\n\nThe listing's photos, in listing order:" }];
  photoBlocks.forEach((b, i) => { content.push({ type: "text", text: `Photo ${i + 1}` }); content.push({ ...b }); });
  // The second look reuses the first's prompt whole, so it is read from cache.
  content[content.length - 1].cache_control = { type: "ephemeral" };
  const res = await client.messages.parse({
    model, max_tokens: 12000, system: FRAMING_SYSTEM,
    messages: [{ role: "user", content }],
    output_config: { effort, format: zodOutputFormat(FramingReport) },
  } as any);
  const parsed = res.parsed_output as FramingT | null;
  if (!parsed) throw new Error("the framing look returned nothing that matched its schema");
  return { report: parsed, usage: res.usage };
}

// Which photos are off, and how. Only the clear calls count — slightly off, a
// slight tilt, a bit smaller are what the owner would not reshoot for.
function framingFaults(f: FramingT, gameSheet: boolean): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const p of f.photos) {
    if (!p.item_photo) continue;
    const probs: string[] = [];
    if (p.level === "slanted") probs.push("crooked");
    if (p.centred === "off") probs.push("off_center");
    if (p.size === "much_smaller" && !gameSheet) probs.push("too_small");   // rule 11
    if (probs.length) out.set(p.n, probs);
  }
  return out;
}

function listingText(l: Listing, standard: Map<string, number>) {
  // PayMore's own wording first, the store-wide count only as a fallback — see
  // PAYMORE_TEMPLATES in rules.ts.
  const tag = (s: string) => (isStandardSentence(s, standard.get(norm(s)) || 0) ? "[standard] " : "[unit] ") + s;
  const cos = sentences(l.cosmetic).map(tag).join("\n") || "(none)";
  return [
    `TITLE: ${l.title}`,
    `CONDITION: ${l.condition || "(not set)"}`,
    `INCLUDED: ${l.included || "(not listed)"}`,
    `NOT INCLUDED: ${l.notIncluded || "(not listed)"}`,
    `COSMETIC NOTES:\n${cos}`,
    `FUNCTIONAL NOTES: ${l.functional || "(none)"}`,
  ].join("\n");
}

function sheetText(s: Sheet) {
  return `PICTURE GUIDE SHEET: ${s.name}\nShots, in order:\n` + s.shots.map((x, i) =>
    `${i + 1}. ${x.label}${x.cond ? ` — only if: ${x.cond}` : " — always"}${x.repeatable ? " (as many as needed)" : ""}${x.note ? ` [${x.note}]` : ""}`
  ).join("\n");
}

// ⚠️ A VIDEO GAME IS NEVER GRADED ON A BOX SHEET — decided here, not asked.
// PICK_SYSTEM already says "new sealed video games use video-games", and the
// model still put OVL's sealed Death Stranding 2 (KS01-7086A3-E5) on New In Box
// on a Recheck (2026-10-01): the photos show a shrink-wrapped box, so either the
// pick or the "better sheet" re-grade went to the box sheet, which wants top,
// bottom, both sides and a serial closeup — "5 of 7 missing", RETAKE. Ethan
// dismissed it: "New in box video games should be fine at 2 pictures", the same
// call he made in calibration (the case is in picture-quality-calibrate.mjs).
// The sealed-game exemption in decide() only works on a video-games sheet, so
// the sheet has to be right first.
//
// A game is recognised by its title's "(Platform, Year)" tail — the house
// format for game listings ("… (Sony PlayStation 5 PS5, 2025)") — or a
// collection handle with "game" in it that is not a console's. A console title
// never ends that way, so a PS5 console in its box keeps New In Box.
const GAME_PLATFORM = /\b(playstation|ps[1-5]|psp|vita|xbox|nintendo|switch|wii|gamecube|game ?boy|3ds|\bds\b|n64|sega|genesis|dreamcast|atari|snes|nes)\b/i;
// The hardware sold in the same format — "DualSense Controller (Sony PlayStation
// 5 PS5, 2020)" — is not a game, and a boxed controller keeps its box sheet.
const GAME_HARDWARE = /\b(console|controller|headset|adapter|charger|charging|dock|cable|remote|memory card|accessor(y|ies)|bundle|system)\b/i;
function isVideoGame(l: Listing): boolean {
  if (GAME_HARDWARE.test(l.title)) return false;
  const tail = /\(([^()]*),\s*(19|20)\d\d\)\s*$/.exec(l.title);
  if (tail && GAME_PLATFORM.test(tail[1])) return true;
  return l.collections.some(h => /(^|-)games?(-|$)|video-games/i.test(h) && !/console/i.test(h));
}
// TRADING CARDS ARE SHOT LIKE A GAME WITH NO CASE (Ethan, 2026-10-11: "Trading
// cards can be treated the same as video games without a case"). There is no
// card sheet, and the pick sent one WSP Pokémon card to Small/Medium Misc (a
// "retake" for missing device sides) and found nothing for the other. Decided
// here, not asked — a Pokémon GAME has the platform tail and stays a game.
const CARD_WORDS = /\b(tcg|trading cards?|ccg)\b/i;
const CARD_BRANDS = /\b(pok[eé]mon|yu-?gi-?oh|magic the gathering|mtg|panini|topps|upper deck|one piece card|lorcana)\b/i;
const isTradingCard = (l: Listing) => CARD_WORDS.test(l.title) || (CARD_BRANDS.test(l.title) && !isVideoGame(l)
  && !/\b(plush|figure|console|game boy|switch)\b/i.test(l.title));

// The photos settle case vs no case (Ethan, 2026-10-11: Chrono Cross and Mario
// Odyssey were shot in their cases but the NOT INCLUDED field mentioned a case,
// so gameSheetFor vetoed the review's move back to Video Games every time).
const caseCall = (from: Sheet, to: Sheet) => /^video-games/.test(from.slug) && /^video-games/.test(to.slug);

function gameSheetFor(l: Listing, sheet: Sheet | null, sheets: Sheet[]): Sheet | null {
  if (isTradingCard(l)) return sheets.find(s => s.slug === "video-games-disk-cartridge-only") || sheet;
  // A NEW item is shot in its packaging (Ethan, 2026-10-11: the WSP SanDisk card
  // "should be based on new in box guide") — the pick kept sending it to Small/
  // Medium Misc. "New …" titles go to New In Box unless already on a box sheet
  // (an open-box re-sheet stands — the WSP Yale lock). Games are decided below.
  if (sheet && /^new\b/i.test(l.title) && !isVideoGame(l) && !BOX_SHEETS.has(sheet.slug)) {
    return sheets.find(s => s.slug === "new-in-box") || sheet;
  }
  if (!sheet || !BOX_SHEETS.has(sheet.slug) || !isVideoGame(l)) return sheet;
  const noCase = /\bcase\b/i.test(l.notIncluded);
  return sheets.find(s => s.slug === (noCase ? "video-games-disk-cartridge-only" : "video-games")) || sheet;
}

async function pickSheet(client: Anthropic, model: string, l: Listing, sheets: Sheet[]) {
  const res = await client.messages.parse({
    model, max_tokens: 4000, system: PICK_SYSTEM,
    messages: [{ role: "user", content:
      "SHEETS:\n" + sheets.map(s => `${s.slug} — ${s.name}${s.group ? ` (${s.group})` : ""}`).join("\n") +
      `\n\nLISTING:\nTITLE: ${l.title}\nCOLLECTIONS: ${l.collections.join(", ")}\nCONDITION: ${l.condition}` +
      `\nINCLUDED: ${l.included}\nNOT INCLUDED: ${l.notIncluded}` }],
    output_config: { effort: "low", format: zodOutputFormat(SheetPick) },
  } as any);
  return { pick: res.parsed_output as z.infer<typeof SheetPick> | null, usage: res.usage };
}

// The sheet and its examples go first and are cached, so a store's fifty
// iPhones pay for the iPhone examples once.
async function sheetBlocksFor(sheet: Sheet) {
  const blocks: any[] = [{ type: "text", text: sheetText(sheet) + "\n\nExample photos from the sheet:" }];
  for (const [i, s] of sheet.shots.entries()) {
    if (!s.img) continue;
    blocks.push({ type: "text", text: `Example for shot ${i + 1}: ${s.label}` });
    blocks.push(await imageBlock(guideUrl(s.img)));
  }
  blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
  return blocks;
}

async function review(client: Anthropic, model: string, effort: string, l: Listing, sheet: Sheet,
                      standard: Map<string, number>, otherSheets: string) {
  const sheetBlocks = await sheetBlocksFor(sheet);

  const listingBlocks: any[] = [{ type: "text", text:
    "OTHER SHEETS (only if this one is clearly wrong for the item): " + otherSheets +
    "\n\nTHE LISTING:\n" + listingText(l, standard) + "\n\nIts photos, in listing order:" }];
  const photoBlocks = await Promise.all(l.photos.map(p => imageBlock(p.url)));
  photoBlocks.forEach((b, i) => {
    listingBlocks.push({ type: "text", text: `Photo ${i + 1}` });
    listingBlocks.push(b);
  });

  const res = await client.messages.parse({
    // 16000, not 8000: at effort "medium" the thinking ate the budget and the
    // JSON came back cut off mid-string on two of five listings.
    model, max_tokens: 16000, system: REVIEW_SYSTEM,
    messages: [{ role: "user", content: [...sheetBlocks, ...listingBlocks] }],
    output_config: { effort, format: zodOutputFormat(Report) },
  } as any);
  const parsed = res.parsed_output as ReportT | null;
  // Null means the answer did not validate — never read that as "all clear".
  if (!parsed) throw new Error("the review returned nothing that matched its schema");
  return { report: parsed, usage: res.usage };
}

// --- the verdict, in code ---------------------------------------------------
//
// ⚠️ IT LIVES IN rules.ts (2026-10-11): decide(), agree(), pictureScore() and the
// scoring card, with no Deno or model in reach, so a rule is re-scored against
// saved reports for free (scripts/picture-quality-rules-test.mjs) before any
// paid run. This file asks; that one decides.

// ⚠️ CENTRING IS JUDGED BY THE MODEL, AND MEASURING WAS TRIED (2026-10-08).
// OVL round 2: Ethan called two PS3 controllers and an original Xbox
// controller "a lot of the photos are not centred and some are crooked", and
// the model had said "close" to nearly all of them. Two fixes to measure
// instead, both scored against his key and both worse:
//  - the MODEL giving an item box + lean in degrees (pq-v9, 14/19): it put the
//    centre at 0.47–0.52 on every photo of the black PS3, rounding to the
//    middle whatever the prompt said, and read viewpoint as lean — the Onyx's
//    edge-on shots and Death Stranding's case came back "crooked".
//  - PIXELS against the backdrop (prototype, not shipped): a white controller
//    on the white sweep barely registers, and the clear stand, a trailing cable
//    and the corner vignette all count as "item".
// What was actually wrong was the prompt calling CONTROLLERS staged, so on the
// Game Controllers sheet the item itself was waved through as "matches". That
// is fixed in REVIEW_SYSTEM, and crooked now means slanted in the picture, not
// a different viewpoint. Measure again only with a bigger labelled set.
// pq-v10 still scored 24/29, all four framing misses passed — so since pq-v11
// centred / level / size come from framingLook, a call that asks nothing else.

// The listing as rules.ts needs it: the cosmetic sentences that are about THIS
// unit, by the same frequency test the prompt's [unit]/[standard] tags use.
const forRules = (l: Listing, standard: Map<string, number>): ListingR => ({ ...l,
  unitCosmetic: sentences(l.cosmetic).filter(x => !isStandardSentence(x, standard.get(norm(x)) || 0)) });

// --- the stamp ---------------------------------------------------------------

async function stampFor(l: Listing, sheet: Sheet | null) {
  const basis = JSON.stringify({ RECIPE, sheet: sheet ? [sheet.slug, sheet.updated] : null,
    photos: l.photos.map(p => p.src.split("?")[0]), c: [l.condition, l.cosmetic, l.included, l.notIncluded, l.title] });
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  return RECIPE + ":" + Array.from(new Uint8Array(d)).slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- one listing's verdict, from its look(s) ------------------------------------
//
// Shared by the live path (runReviews) and the batch path (pollBatches), so the
// two can never decide differently. `second` is the second look's report, or
// null when needsSecondLook said one was not worth paying for.
async function finalRow(l: Listing, sheet: Sheet, standard: Map<string, number>, pick: unknown, reSheeted: boolean,
                        first: ReportT, second: ReportT | null, faults?: Map<number, string[]>) {
  const lr = forRules(l, standard);
  let report = first;
  let d = decide(lr, sheet, report, faults);
  const firstLook = { verdict: d.verdict, findings: d.findings.map(f => f.text) };
  let secondLook: typeof firstLook | null = null;
  if (second) {
    const d2 = decide(lr, sheet, second, faults);
    secondLook = { verdict: d2.verdict, findings: d2.findings.map(f => f.text) };
    const d1 = d;
    report = agree(report, second);
    d = decide(lr, sheet, report, faults);
    // A reorder stands only if each look, on its own, asked for one: the
    // Synology's "Everything Included is not in the first three" came from
    // one look's labels and the next look's labels disagreed.
    if (d.reorder && !(d1.reorder && d2.reorder)) {
      d = { ...d, reorder: null };
      if (!report.lead_ok) d.findings.push({ code: "lead", photo: 1, text: "Photo 1 doesn't show what the item is." });
      const pic = pictureScore(d.findings, l.photos.length, l.price);
      d = { ...d, pictureScore: pic.score, costs: pic.costs };
      d.verdict = verdictOf(d.findings, pic.score, null, d.deletion);
    }
  }
  return { verdict: d.verdict, findings: d.findings, reorder: d.reorder, deletion: d.deletion,
           title_notes: report.title_notes, sheet_slug: sheet.slug, sheet_name: sheet.name,
           stamp: await stampFor(l, sheet),
           report: { ...report, orderScore: d.orderScore, pictureScore: d.pictureScore, costs: d.costs,
             sheetPick: pick, reSheeted, looks: second ? 2 : 1, firstLook, secondLook,
             notesAsSent: sentences(l.cosmetic).map(s => (isStandardSentence(s, standard.get(norm(s)) || 0) ? "[standard] " : "[unit] ") + s) } };
}

async function saveRows(rowsOut: any[]) {
  const good = rowsOut.filter(r => r.verdict !== "error");
  if (!good.length) return;
  await sb("picture_quality_reviews", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    // title_notes is NOT NULL (default '[]'): a null here failed the whole
    // save the first time a result came back without it (a Pokémon card,
    // 2026-10-11) — and with it every other listing in the call.
    body: JSON.stringify(good.map(r => ({ reorder: null, deletion: null, ...r, title_notes: (r as any).title_notes || [], status: "open", decided_by: null, decided_at: null,
                                         decided_note: null, reviewed_at: new Date().toISOString() }))),
  });
}

// --- the sweep ----------------------------------------------------------------

async function runReviews(store: string, ids: string[], model: string, effort: string, save: boolean,
                          withFraming = false) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set on this project");
  const client = new Anthropic({ apiKey });
  const { shop, token } = await shopFor(store);
  const [listings, sheets, standard] = await Promise.all([
    // No store-wide sentence count any more: isStandardSentence (rules.ts) judges
    // a note by what it says, so reading every listing in the store just to
    // count its sentences was pure wait. boilerplateFor stays for reference.
    fetchListings(shop, token, ids), loadSheets(), Promise.resolve(new Map<string, number>())]);
  const price = PRICES[model] || PRICES[DEFAULT_MODEL];
  let tin = 0, tout = 0;
  const out: any[] = [];

  const one = async (l: Listing) => {
    const base = { store_code: store, product_id: l.id, sku: l.sku, title: l.title, photo_count: l.photos.length, model };
    try {
      if (!l.photos.length) {
        return { ...base, verdict: "fix", findings: [{ code: "no_photos", text: "This listing has no photos." }],
                 stamp: await stampFor(l, null), sheet_slug: null, sheet_name: null };
      }
      const { pick, usage: u1 } = await pickSheet(client, model, l, sheets);
      tin += u1?.input_tokens || 0; tout += u1?.output_tokens || 0;
      let sheet = pick?.slug && pick.confidence !== "low" ? sheets.find(s => s.slug === pick.slug) || null : null;
      sheet = gameSheetFor(l, sheet, sheets);
      if (!sheet) {
        return { ...base, verdict: "no_sheet", stamp: await stampFor(l, null), sheet_slug: null, sheet_name: null,
                 findings: [{ code: "no_sheet", text: `Not graded — no confident sheet match (${pick?.why || "no answer"}).` }] };
      }
      const others = (s: Sheet) => sheets.filter(x => x.slug !== s.slug).map(x => `${x.slug} (${x.name})`).join(", ");
      let { report, usage } = await review(client, model, effort, l, sheet, standard, others(sheet));
      let inTok = (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0);
      let outTok = usage?.output_tokens || 0;
      tin += inTok; tout += outTok;
      // The text alone cannot always tell (the Pyle title says "Speaker"; the
      // photos show a pair). One re-grade on the sheet the photos point to.
      const better = !report.sheet_fits && report.better_sheet ? sheets.find(s => s.slug === report.better_sheet) : null;
      if (better && (gameSheetFor(l, better, sheets) === better || caseCall(sheet, better))) {
        sheet = better;
        ({ report, usage } = await review(client, model, effort, l, sheet, standard, others(sheet)));
        const extra = (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0);
        inTok += extra; tin += extra; tout += usage?.output_tokens || 0; outTok += usage?.output_tokens || 0;
      }
      // The framing look — see framingLook. Same "seen twice" rule as the main
      // review: a second look only when the first finds something, and a photo
      // counts only when both name it. Both looks are on the same question, so
      // they agree far more often than two forty-field reviews did.
      const tally = (u: any) => {
        const i = (u?.input_tokens || 0) + (u?.cache_read_input_tokens || 0) + (u?.cache_creation_input_tokens || 0);
        inTok += i; tin += i; tout += u?.output_tokens || 0; outTok += u?.output_tokens || 0;
      };
      let faults: Map<number, string[]> | undefined;
      let framing1: FramingT | null = null, framing2: FramingT | null = null;
      if (withFraming) {
      const gameSheet = /^video-games/.test(sheet.slug);
      const fSheet = await sheetBlocksFor(sheet);
      const fPhotos = await Promise.all(l.photos.map(p => imageBlock(p.url)));
      const f1 = await framingLook(client, model, effort, fSheet, fPhotos);
      tally(f1.usage);
      framing1 = f1.report;
      faults = framingFaults(f1.report, gameSheet);
      if (faults.size) {
        const f2 = await framingLook(client, model, effort, fSheet, fPhotos);
        tally(f2.usage);
        framing2 = f2.report;
        const again = framingFaults(f2.report, gameSheet);
        const both = new Map<number, string[]>();
        for (const [n, a] of faults) {
          const b = again.get(n);
          if (!b) continue;
          const common = a.filter(x => b.includes(x));
          both.set(n, common.length ? common : a);
        }
        faults = both;
      }
      }
      const lr = forRules(l, standard);
      // The main review's own second look is for ITS findings; a listing whose
      // only problem is framing has already been looked at twice above.
      // Only when the flag is close to the line — see needsSecondLook (rules.ts).
      let second: ReportT | null = null;
      if (needsSecondLook(lr, sheet, report)) {
        const again = await review(client, model, effort, l, sheet, standard, others(sheet));
        const extra = (again.usage?.input_tokens || 0) + (again.usage?.cache_read_input_tokens || 0) + (again.usage?.cache_creation_input_tokens || 0);
        inTok += extra; tin += extra; tout += again.usage?.output_tokens || 0; outTok += again.usage?.output_tokens || 0;
        second = again.report;
      }
      const row = await finalRow(l, sheet, standard, pick, !!better, report, second, faults);
      return { ...base, ...row,
               report: { ...row.report,
                 ...(withFraming ? { framing: { first: framing1, second: framing2, faults: Object.fromEntries(faults || []) } } : {}),
                 cache: {
                 read: usage?.cache_read_input_tokens || 0, wrote: usage?.cache_creation_input_tokens || 0 } },
               input_tokens: inTok, output_tokens: outTok,
               cost_usd: Math.round((inTok / 1e6 * price[0] + outTok / 1e6 * price[1]) * 1e5) / 1e5 };
    } catch (e) {
      return { ...base, verdict: "error", stamp: "error", findings: [{ code: "error", text: String((e as Error).message || e).slice(0, 300) }] };
    }
  };

  for (let i = 0; i < listings.length; i += CONCURRENCY) {
    out.push(...await Promise.all(listings.slice(i, i + CONCURRENCY).map(one)));
  }

  if (save) {
    await saveRows(out);
    // Written down so "what did that cost" has an answer that is not an estimate.
    try {
      await sb("ai_usage_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
        tool: "picture-quality", store_code: store, model, effort, batches: out.length, items: out.length,
        input_tokens: tin, output_tokens: tout, cost_usd: tin / 1e6 * price[0] + tout / 1e6 * price[1] }) });
    } catch (e) { console.error("ai_usage_log write failed:", String(e)); }
  }

  return {
    store, model, effort, saved: save, reviewed: out.length,
    cost_usd: Math.round((tin / 1e6 * price[0] + tout / 1e6 * price[1]) * 1e4) / 1e4,
    tokens: { input: tin, output: tout },
    verdicts: out.reduce((a: any, r) => (a[r.verdict] = (a[r.verdict] || 0) + 1, a), {}),
    results: out,
  };
}

// --- the sweep: which listings need a (new) look -----------------------------
//
// Customer-facing stock only, the same list the title tool works: in stock and
// published on the online store (ebay_catalog, which ebay-sync keeps). A listing
// already reviewed is looked at again ONLY when its stamp moved — a photo, the
// notes, the sheet or the recipe changed — so a store is paid for once, and a
// dismissed row stays dismissed until there is something new to say about it.
// Never-reviewed first, so repeated runs walk the whole store.
async function sweepCandidates(store: string, shop: string, token: string, limit: number) {
  const cat: any[] = [];
  for (let off = 0; ; off += 1000) {
    const page = await rows(`ebay_catalog?store_code=eq.${store}&quantity=gt.0&online_published=is.true`
      + `&select=product_id&order=product_id&limit=1000&offset=${off}`);
    cat.push(...page);
    if (page.length < 1000) break;
  }
  const ids = [...new Set(cat.map(c => String(c.product_id || "")).filter(Boolean)
    .map(s => s.startsWith("gid://") ? s : `gid://shopify/Product/${s}`))];
  const seen = await rows(`picture_quality_reviews?store_code=eq.${store}&select=product_id,stamp,sheet_slug&limit=10000`);
  const bySeen = new Map(seen.map((r: any) => [r.product_id, r]));
  const fresh = ids.filter(id => !bySeen.has(id));
  // Graded under an older recipe first: those rows are HIDDEN from the queue
  // until re-graded (reviewView), so they are the listings nobody can see.
  const oldRecipe = ids.filter(id => bySeen.has(id)
    && String((bySeen.get(id) as any).stamp || "").split(":")[0] !== RECIPE);
  const need: string[] = [...oldRecipe, ...fresh].slice(0, limit);
  if (need.length < limit) {
    const sheets = await loadSheets();
    const known = ids.filter(id => bySeen.has(id) && !oldRecipe.includes(id));
    for (let i = 0; i < known.length && need.length < limit; i += 50) {
      for (const l of await fetchListings(shop, token, known.slice(i, i + 50))) {
        const r: any = bySeen.get(l.id);
        const sheet = sheets.find(s => s.slug === r.sheet_slug) || null;
        if (r.stamp !== await stampFor(l, sheet)) need.push(l.id);
        if (need.length >= limit) break;
      }
    }
  }
  return { need, live: ids.length, neverSeen: fresh.length + oldRecipe.length };
}

// --- the nightly sweep, through the Batch API -------------------------------------
//
// ⚠️ HALF PRICE, HOURS NOT SECONDS (Ethan approved, 2026-10-11). The Message
// Batches API bills every token at 50% and returns within hours — fine for a
// nightly sweep nobody is waiting on. Recheck stays live (runReviews): a manager
// pressing it is waiting.
//
// Two steps, each its own call, both on a cron (0143):
//   ?sweep=N&batch=1&store=X   build the night's requests and submit ONE batch
//   ?poll=1                    collect every ended batch, decide, save — and send
//                              a follow-up batch for any listing that needs a
//                              re-sheet or a second look (needsSecondLook)
// What a batch is waiting on lives in pq_batches (0143), so nothing is lost
// between the two calls, and a listing already in flight is never sent twice.
//
// Photos go BY URL here, not as bytes: a night's batch of base64 photos would be
// hundreds of MB through an edge function. A photo that fails to fetch fails
// that one request; the listing is simply picked up by the next sweep.
// The sheet pick stays live: text only, low effort, about a cent per hundred.
const urlImage = (url: string) => ({ type: "image", source: { type: "url", url } });

function reviewParams(l: Listing, sheet: Sheet, standard: Map<string, number>, otherSheets: string, model: string, effort: string) {
  const sheetBlocks: any[] = [{ type: "text", text: sheetText(sheet) + "\n\nExample photos from the sheet:" }];
  for (const [i, s] of sheet.shots.entries()) {
    if (!s.img) continue;
    sheetBlocks.push({ type: "text", text: `Example for shot ${i + 1}: ${s.label}` }, urlImage(guideUrl(s.img)));
  }
  sheetBlocks[sheetBlocks.length - 1].cache_control = { type: "ephemeral" };
  const listingBlocks: any[] = [{ type: "text", text:
    "OTHER SHEETS (only if this one is clearly wrong for the item): " + otherSheets +
    "\n\nTHE LISTING:\n" + listingText(l, standard) + "\n\nIts photos, in listing order:" }];
  l.photos.forEach((p, i) => listingBlocks.push({ type: "text", text: `Photo ${i + 1}` }, urlImage(p.url)));
  const fmt: any = zodOutputFormat(Report);
  return {
    model, max_tokens: 16000, system: REVIEW_SYSTEM,
    messages: [{ role: "user", content: [...sheetBlocks, ...listingBlocks] }],
    // The format object carries a parse function the batch cannot send; the
    // schema is what matters, and the answer is parsed with Report below.
    output_config: { effort, format: { type: fmt.type, schema: fmt.schema } },
  };
}

// `sample`: sent by a random sample (the nightly, or a hand run with &random=1)
// — saved on the row's report so the panel can outline it as NEW (Ethan,
// 2026-10-15: "have the entire box border for these highlighted so I know which
// ones are new for me to review tomorrow"). Follow-ups carry it ({...p}).
type Pending = { pid: string; kind: "first" | "resheet" | "second"; sheet: string; pick: unknown;
                 reSheeted: boolean; stamp: string; first?: ReportT; sample?: boolean };
const customId = (p: Pending) => `${p.kind[0]}${p.pid.split("/").pop()}`;

async function submitBatch(client: Anthropic, store: string, model: string, effort: string,
                           reqs: { p: Pending; params: unknown }[]) {
  if (!reqs.length) return null;
  const batch = await (client as any).messages.batches.create({
    requests: reqs.map(r => ({ custom_id: customId(r.p), params: r.params })),
  });
  await sb("pq_batches", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
    store_code: store, batch_id: batch.id, model, effort,
    items: Object.fromEntries(reqs.map(r => [customId(r.p), r.p])) }) });
  return batch.id as string;
}

// Listings in flight in a batch not yet collected — never sent twice.
async function inFlight(store: string) {
  const open = await rows(`pq_batches?store_code=eq.${store}&status=eq.submitted&select=items`);
  return new Set(open.flatMap((b: any) => Object.values(b.items || {}).map((p: any) => p.pid)));
}

// NEW listings only — created in the last `days` days — whose saved grade is
// missing or stale. The one-time backfill of the existing catalogue is a
// separate decision (Ethan, 2026-10-11: "do not include the one time backfill").
async function batchSweep(store: string, limit: number, days: number, model: string, effort: string, regrade = false, random = false) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set on this project");
  const client = new Anthropic({ apiKey });
  const { shop, token } = await shopFor(store);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const cat: any[] = await rows(`ebay_catalog?store_code=eq.${store}&quantity=gt.0&online_published=is.true`
    + `&product_created_at=gte.${since}&select=product_id&order=product_created_at.desc&limit=1000`);
  let ids = [...new Set(cat.map(c => String(c.product_id || "")).filter(Boolean)
    .map(s => s.startsWith("gid://") ? s : `gid://shopify/Product/${s}`))];
  // &regrade=1 — the store's OPEN rows, graded again whatever their stamp (a
  // model or rules change; Ethan's review queue after the Opus switch, 10-13).
  // A random handful, not the newest (Ethan's nightly sample, 10-13).
  if (random) ids = ids.map(id => [Math.random(), id] as const).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  if (regrade) ids = [...new Set<string>((await rows(`picture_quality_reviews?store_code=eq.${store}&status=eq.open&select=product_id&limit=10000`))
    .map((r: any) => String(r.product_id) as string))];
  const flying = await inFlight(store);
  const seen = new Map<string, string>((await rows(`picture_quality_reviews?store_code=eq.${store}&select=product_id,stamp&limit=10000`))
    .map((r: any) => [String(r.product_id), String(r.stamp || "")]));
  const sheets = await loadSheets();
  const standard = new Map<string, number>();
  const reqs: { p: Pending; params: unknown }[] = [];
  const direct: any[] = [];
  let pickIn = 0, pickOut = 0;
  // First the listings that need grading, cheaply (no model)…
  const todo: Listing[] = [];
  for (let i = 0; i < ids.length && todo.length < limit; i += 25) {
    const chunk = ids.slice(i, i + 25).filter(id => !flying.has(id));
    for (const l of await fetchListings(shop, token, chunk)) {
      if (todo.length >= limit) break;
      // Already graded and unchanged under this recipe: nothing to do. The
      // sheet is part of the stamp, so check against any sheet's stamp shape —
      // a stale recipe or a changed listing never matches.
      const was = seen.get(l.id);
      if (!regrade && was && String(was).startsWith(RECIPE + ":")) {
        const same = await Promise.all(sheets.map(s => stampFor(l, s)));
        if (same.includes(was) || was === await stampFor(l, null)) continue;
      }
      todo.push(l);
    }
  }
  // …then the sheet picks, EIGHT AT A TIME. One after another, a first night's
  // hundred listings at ~3s a pick would outrun the function's time limit.
  let next = 0;
  const pickOne = async () => {
    while (next < todo.length) {
      const l = todo[next++];
      const base = { store_code: store, product_id: l.id, sku: l.sku, title: l.title, photo_count: l.photos.length, model,
                     ...(random ? { report: { sample: new Date().toISOString() } } : {}) };
      if (!l.photos.length) {
        direct.push({ ...base, verdict: "fix", findings: [{ code: "no_photos", text: "This listing has no photos." }],
                      stamp: await stampFor(l, null), sheet_slug: null, sheet_name: null });
        continue;
      }
      try {
        const { pick, usage } = await pickSheet(client, model, l, sheets);
        pickIn += usage?.input_tokens || 0; pickOut += usage?.output_tokens || 0;
        let sheet = pick?.slug && pick.confidence !== "low" ? sheets.find(s => s.slug === pick.slug) || null : null;
        sheet = gameSheetFor(l, sheet, sheets);
        if (!sheet) {
          direct.push({ ...base, verdict: "no_sheet", stamp: await stampFor(l, null), sheet_slug: null, sheet_name: null,
                        findings: [{ code: "no_sheet", text: `Not graded — no confident sheet match (${pick?.why || "no answer"}).` }] });
          continue;
        }
        const others = sheets.filter(x => x.slug !== sheet!.slug).map(x => `${x.slug} (${x.name})`).join(", ");
        reqs.push({ p: { pid: l.id, kind: "first", sheet: sheet.slug, pick, reSheeted: false, stamp: await stampFor(l, sheet), ...(random ? { sample: true } : {}) },
                    params: reviewParams(l, sheet, standard, others, model, effort) });
      } catch (e) {
        // One failed pick costs that listing tonight, not the whole batch.
        console.error("pick failed", l.id, String((e as Error).message || e));
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, pickOne));
  await saveRows(direct);
  const batchId = await submitBatch(client, store, model, effort, reqs);
  const price = PRICES[model] || PRICES[DEFAULT_MODEL];
  await logUsage(store, model, effort, "sweep-pick", reqs.length + direct.length, pickIn, pickOut, pickIn / 1e6 * price[0] + pickOut / 1e6 * price[1]);
  return { store, candidates: ids.length, submitted: reqs.length, savedDirect: direct.length, batch: batchId };
}

async function logUsage(store: string, model: string, effort: string, what: string, items: number, tin: number, tout: number, cost: number) {
  try {
    await sb("ai_usage_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
      tool: `picture-quality:${what}`, store_code: store, model, effort, batches: 1, items,
      input_tokens: tin, output_tokens: tout, cost_usd: cost }) });
  } catch (e) { console.error("ai_usage_log write failed:", String(e)); }
}

// Collect every ended batch: decide, save, and send the follow-ups.
async function pollBatches() {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set on this project");
  const client = new Anthropic({ apiKey });
  const open = await rows(`pq_batches?status=eq.submitted&select=id,store_code,batch_id,model,effort,items,submitted_at&order=submitted_at`);
  const sheets = await loadSheets();
  const standard = new Map<string, number>();
  const report: any[] = [];
  for (const b of open) {
    const info = await (client as any).messages.batches.retrieve(b.batch_id);
    if (info.processing_status !== "ended") { report.push({ batch: b.batch_id, status: info.processing_status }); continue; }
    const { shop, token } = await shopFor(b.store_code);
    const items: Record<string, Pending> = b.items || {};
    const pids = [...new Set(Object.values(items).map(p => p.pid))];
    const live = new Map<string, Listing>();
    for (let i = 0; i < pids.length; i += 25) for (const l of await fetchListings(shop, token, pids.slice(i, i + 25))) live.set(l.id, l);
    const price = PRICES[b.model] || PRICES[DEFAULT_MODEL];
    let tin = 0, tcache = 0, tout = 0, ok = 0, failed = 0, changed = 0;
    const save: any[] = [], follow: { p: Pending; params: unknown }[] = [];
    for await (const res of await (client as any).messages.batches.results(b.batch_id)) {
      const p = items[res.custom_id];
      if (!p) continue;
      if (res.result?.type !== "succeeded") { failed++; continue; }   // picked up again by the next sweep
      const msg = res.result.message;
      const u = msg.usage || {};
      tin += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0); tcache += u.cache_read_input_tokens || 0; tout += u.output_tokens || 0;
      const l = live.get(p.pid);
      const sheet = sheets.find(s => s.slug === p.sheet);
      // Gone, or edited since it was sent: that grade is about photos that are
      // no longer there. The next sweep sends it again.
      if (!l || !sheet || await stampFor(l, sheet) !== p.stamp) { changed++; continue; }
      const text = (msg.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      let parsed: ReportT;
      try { parsed = Report.parse(JSON.parse(text)); } catch { failed++; continue; }
      ok++;
      const others = (s: Sheet) => sheets.filter(x => x.slug !== s.slug).map(x => `${x.slug} (${x.name})`).join(", ");
      if (p.kind === "first") {
        // The photos point at a better sheet: one re-grade on it, as live.
        const better = !parsed.sheet_fits && parsed.better_sheet ? sheets.find(s => s.slug === parsed.better_sheet) : null;
        if (better && (gameSheetFor(l, better, sheets) === better || caseCall(sheet, better))) {
          const np: Pending = { ...p, kind: "resheet", sheet: better.slug, reSheeted: true, stamp: await stampFor(l, better) };
          follow.push({ p: np, params: reviewParams(l, better, standard, others(better), b.model, b.effort) });
          continue;
        }
      }
      if (p.kind !== "second" && needsSecondLook(forRules(l, standard), sheet, parsed)) {
        follow.push({ p: { ...p, kind: "second", first: parsed }, params: reviewParams(l, sheet, standard, others(sheet), b.model, b.effort) });
        continue;
      }
      const first = p.kind === "second" ? p.first! : parsed;
      const second = p.kind === "second" ? parsed : null;
      const row = await finalRow(l, sheet, standard, p.pick, p.reSheeted, first, second);
      save.push({ store_code: b.store_code, product_id: l.id, sku: l.sku, title: l.title, photo_count: l.photos.length,
                  model: b.model, ...row, report: { ...row.report, batch: b.batch_id, ...(p.sample ? { sample: new Date().toISOString() } : {}) } });
    }
    await saveRows(save);
    // Batch tokens are half price; a cache read is a tenth of input.
    const cost = (tin / 1e6 * price[0] + tcache / 1e6 * price[0] * 0.1 + tout / 1e6 * price[1]) * 0.5;
    const next = await submitBatch(client, b.store_code, b.model, b.effort, follow);
    await sb(`pq_batches?id=eq.${b.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
      status: "done", finished_at: new Date().toISOString(), cost_usd: Math.round(cost * 1e4) / 1e4,
      result: { ok, failed, changed, saved: save.length, followUp: follow.length, followBatch: next } }) });
    await logUsage(b.store_code, b.model, b.effort, "batch", ok, tin + tcache, tout, cost);
    report.push({ batch: b.batch_id, store: b.store_code, ok, failed, changed, saved: save.length, followUp: follow.length, cost_usd: Math.round(cost * 1e4) / 1e4 });
  }
  return { batches: report };
}

// --- re-apply the rules to saved reports, for free ---------------------------------
//
// ?redecide=1&store=X — when a RULE changes (rules.ts) but the question asked of
// the model did not, every open row's verdict can be brought up to date from
// the report already saved with it: no model call, no cost. First used when
// the review's crooked / off-centre / too-small calls were paused (2026-10-11),
// so the queue Ethan reviewed did not show calls that no longer count. A
// listing edited since its grade is left alone — its stamp no longer matches
// and the next sweep re-grades it. The looks are kept as they were.
async function redecide(store: string) {
  const { shop, token } = await shopFor(store);
  const saved: any[] = await rows(`picture_quality_reviews?store_code=eq.${store}&status=eq.open&stamp=like.${RECIPE}:*`
    + `&select=product_id,sku,title,photo_count,model,verdict,reorder,report,sheet_slug,stamp&limit=2000`);
  const sheets = await loadSheets();
  const standard = new Map<string, number>();
  const live = new Map<string, Listing>();
  for (let i = 0; i < saved.length; i += 25) {
    for (const l of await fetchListings(shop, token, saved.slice(i, i + 25).map(r => r.product_id))) live.set(l.id, l);
  }
  const out: any[] = [];
  let skipped = 0, changed = 0;
  for (const r of saved) {
    const l = live.get(r.product_id), sheet = sheets.find(s => s.slug === r.sheet_slug);
    if (!l || !sheet || !r.report?.photos) { skipped++; continue; }
    const row = await finalRow(l, sheet, standard, r.report.sheetPick ?? null, !!r.report.reSheeted, r.report as ReportT, null);
    // A reorder the second look turned down stays turned down.
    if (!r.reorder && row.reorder) {
      row.reorder = null;
      const pic = pictureScore(row.findings, l.photos.length, l.price);
      row.verdict = verdictOf(row.findings, pic.score, null, row.deletion);
      row.report = { ...row.report, pictureScore: pic.score, costs: pic.costs };
    }
    if (row.verdict !== r.verdict) changed++;
    out.push({ store_code: store, product_id: l.id, sku: l.sku, title: l.title, photo_count: l.photos.length, model: r.model,
               ...row, report: { ...row.report, looks: r.report.looks, firstLook: r.report.firstLook,
                                 secondLook: r.report.secondLook, batch: r.report.batch, sample: r.report.sample, redecided: new Date().toISOString() } });
  }
  // Only rows whose stamp still matches the live listing are written.
  const fresh = out.filter(o => saved.find(s => s.product_id === o.product_id)?.stamp === o.stamp);
  skipped += out.length - fresh.length;
  await saveRows(fresh);
  return { store, open: saved.length, rewritten: fresh.length, verdictChanged: changed, skipped };
}

// --- the panel's half ----------------------------------------------------------
//
// The queue comes back with the listing's photos AS THEY ARE NOW, read live, and
// a `stale` flag when they no longer match what was graded. A manager who has
// already retaken the photos must not be shown the old verdict as if it still
// stood — the row says "changed since the check" and offers Check Again.
async function reviewView(scope: Scope, asked: string) {
  const store = scope.stores.includes(asked) ? asked : scope.stores[0];
  // ⚠️ ONLY VERDICTS FROM THE CURRENT RECIPE. Ethan, first look at the screen
  // (2026-09-30): "I thought we said this item lots example was good?" We did —
  // the Dell WD15 lot passes today. The row on screen was graded by pq-v1, before
  // the no-box lot rule existed, and a banner saying "the check has improved"
  // over a wrong verdict is still a wrong verdict on the page. An old row stays
  // hidden until the sweep grades it again under the rules that are true now.
  const queue: any[] = await rows(`picture_quality_reviews?store_code=eq.${store}&status=eq.open`
    + `&verdict=in.(retake,fix,reorder)&stamp=like.${RECIPE}:*`
    + `&select=product_id,sku,title,sheet_slug,sheet_name,verdict,findings,reorder,deletion,title_notes,photo_count,reviewed_at,stamp,sample:report->>sample`
    + `&order=reviewed_at.desc&limit=500`);
  // PASSED, for agreeing with (Ethan, 2026-10-11: "Can I see all of the OVL ones
  // on the tool even if they passed so I can confirm that I agree with the
  // pass?"). A pass nobody can see is a pass nobody can check — and a wrong pass
  // is the miss that never shows up anywhere else. The last 14 days only, so the
  // tab is this week's grading rather than the whole store; "Should Flag" on a
  // row sends the note to Listing Health Notes like a dismissal does.
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  queue.push(...await rows(`picture_quality_reviews?store_code=eq.${store}&status=eq.open`
    + `&verdict=eq.pass&stamp=like.${RECIPE}:*&reviewed_at=gte.${since}`
    + `&select=product_id,sku,title,sheet_slug,sheet_name,verdict,findings,reorder,deletion,title_notes,photo_count,reviewed_at,stamp,sample:report->>sample`
    + `&order=reviewed_at.desc&limit=60`));
  // What a person already answered, for the Confirmed Fine drawer under the
  // queue — the same drawer the Categories and Titles sections keep, so a
  // dismissal (and a denied reorder) can be seen and taken back.
  const dismissed: any[] = await rows(`picture_quality_reviews?store_code=eq.${store}&status=eq.dismissed`
    + `&select=product_id,sku,title,verdict,decided_by,decided_at,decided_note,feedback_triaged_at`
    + `&order=decided_at.desc&limit=100`);
  const { shop, token } = await shopFor(store);
  const sheets = await loadSheets();
  const listerIx = listerIndex(await rows("users?select=name,role,store").catch(() => []) || []);
  const live = new Map<string, Listing>();
  for (let i = 0; i < queue.length; i += 50) {
    for (const l of await fetchListings(shop, token, queue.slice(i, i + 50).map(r => r.product_id))) live.set(l.id, l);
  }
  const used = new Set<string>();
  const out = [];
  for (const r of queue) {
    const l = live.get(r.product_id);
    // Gone from Shopify, or no longer live: not a job for anybody.
    if (!l) continue;
    const sheet = sheets.find(s => s.slug === r.sheet_slug) || null;
    if (sheet) used.add(sheet.slug);
    out.push({
      productId: r.product_id, sku: l.sku || r.sku, title: l.title, handle: l.handle,
      sheet: r.sheet_slug, sheetName: r.sheet_name, verdict: r.verdict,
      findings: r.findings || [], reorder: r.reorder, deletion: r.deletion || null, titleNotes: r.title_notes || [],
      reviewedAt: r.reviewed_at,
      // Graded by a random sample — outlined as NEW on the panel. See Pending.
      sample: r.sample || null,
      stale: r.stamp !== await stampFor(l, sheet),
      // Which kind: the LISTING moved, or the check itself was improved since.
      // Telling a manager "your photos changed" when nobody touched them is the
      // sort of wrong that makes the rest of the row unbelievable.
      staleWhy: String(r.stamp || "").split(":")[0] !== RECIPE ? "recipe" : "listing",
      // A name, or null — the panel says "Unknown" for null, never the raw tag.
      lister: listerFrom(l.tags, listerIx, store)?.name || rawListerTag(l.tags),
      listerRaw: !listerFrom(l.tags, listerIx, store) && !!rawListerTag(l.tags),
      price: l.price,
      photos: l.photos.map(p => ({ thumb: p.thumb, full: p.src, w: p.width, h: p.height })),
    });
  }
  // The guide sheet for every row in the queue, with its example photos — the
  // reorder view puts it beside the listing (Ethan: "show the picture guide as
  // reference and then manager will approve or deny").
  const guide: Record<string, unknown> = {};
  for (const s of sheets.filter(x => used.has(x.slug))) {
    guide[s.slug] = { name: s.name, shots: s.shots.map(x => ({ label: x.label, cond: x.cond, img: x.img ? guideUrl(x.img) : null })) };
  }
  return { scope, store, shop, queue: out, guide,
           dismissed: dismissed.map(r => ({ productId: r.product_id, sku: r.sku, title: r.title, verdict: r.verdict,
             by: r.decided_by, at: r.decided_at, ...splitNote(r.decided_note), triaged: !!r.feedback_triaged_at })) };
}

// --- training: a person grades single photos ------------------------------------
//
// ⚠️ WHY PHOTOS AND NOT LISTINGS (2026-10-08). Framing — centred, level, big
// enough — was the one thing four tries could not get right, and the answer key
// only said "this LISTING is off", which cannot tell a rule which PHOTO it got
// wrong. Ethan grades photos one at a time beside the guide's example of the
// same shot, and those labels (pq_photo_labels, 0141) are what the next framing
// check is scored against — free, offline — before any paid run. Ethan: "I like
// building a tool to train the system on this before we start spending money."
//
// FREE TO SERVE: photos come from listings already graded (their saved report
// says which shot each photo is), read live through the Admin API, so a sold
// listing the storefront no longer shows (the two OVL PS3 controllers) is still
// here. No model is called.
const TRAIN_PROBLEMS = ["off_center", "crooked", "too_small", "blurry", "cut_off", "dirty_backdrop", "clutter", "reflection", "different_spot"];
async function trainView(scope: Scope, asked: string, skip = 0) {
  const store = scope.stores.includes(asked) ? asked : scope.stores[0];
  const graded: any[] = await rows(`picture_quality_reviews?store_code=eq.${store}&report=not.is.null`
    + `&select=product_id,sheet_slug,photo_count,report->photos&order=reviewed_at.desc&limit=200`);
  const labelled: any[] = await rows(`pq_photo_labels?store_code=eq.${store}&select=product_id,photo_src,label,problems&limit=10000`);
  const seen = new Set(labelled.map(r => `${r.product_id}|${r.photo_src}`));
  const { shop, token } = await shopFor(store);
  const sheets = await loadSheets();
  const live = new Map<string, Listing>();
  for (let i = 0; i < graded.length; i += 50) {
    for (const l of await fetchListings(shop, token, graded.slice(i, i + 50).map(r => r.product_id))) live.set(l.id, l);
  }
  const queue: any[] = [];
  let total = 0;
  for (const g of graded) {
    const l = live.get(g.product_id);
    if (!l) continue;
    // The sheet the listing would be graded on TODAY. OVL Death Stranding 2's
    // saved grade is from before gameSheetFor, on New In Box, and the trainer
    // showed Ethan a sealed game beside a MacBook box (2026-10-08).
    const saved = sheets.find(s => s.slug === g.sheet_slug) || null;
    const sheet = gameSheetFor(l, saved, sheets);
    // The saved report numbers photos as they were when graded, and names shots
    // from the sheet it was graded on. If the photos changed since, or the sheet
    // did, those answers point at the wrong example — show no shot then.
    const same = sheet === saved && Array.isArray(g.photos) && g.photos.length === l.photos.length;
    l.photos.forEach((p, i) => {
      total++;
      const src = p.src.split("?")[0];
      if (seen.has(`${l.id}|${src}`)) return;
      const said = same ? g.photos.find((x: any) => x.n === i + 1) : null;
      const shot = (said?.shots || []).find((s: string) => sheet?.shots.some(x => x.label.toLowerCase() === s.toLowerCase())) || null;
      const ex = shot ? sheet!.shots.find(x => x.label.toLowerCase() === shot.toLowerCase()) : null;
      queue.push({ productId: l.id, sku: l.sku, title: l.title, n: i + 1, of: l.photos.length,
                   src, img: p.url, w: p.width, h: p.height, sheet: sheet?.slug || null, sheetName: sheet?.name || null,
                   shot, said: said?.shots || [], example: ex?.img ? guideUrl(ex.img) : null });
    });
  }
  // `skip` = photos the person passed over this session; they stay unlabelled,
  // so without it the next lot would start with them again, forever.
  return { store, total, done: labelled.length, queue: queue.slice(skip, skip + 60), left: queue.length, problems: TRAIN_PROBLEMS };
}

async function saveLabel(scope: Scope, body: any) {
  const store = String(body.store || "").toUpperCase();
  if (!scope.stores.includes(store)) return json({ error: "forbidden" }, 403);
  const label = String(body.label || "");
  if (!["fine", "problem", "not_item"].includes(label)) return json({ error: "label must be fine | problem | not_item" }, 400);
  const problems = (Array.isArray(body.problems) ? body.problems : []).map(String).filter((p: string) => TRAIN_PROBLEMS.includes(p));
  if (label === "problem" && !problems.length) return json({ error: "a problem label needs at least one problem" }, 400);
  const src = String(body.src || "").split("?")[0];
  if (!body.productId || !src) return json({ error: "productId and src required" }, 400);
  await sb("pq_photo_labels?on_conflict=product_id,photo_src", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ store_code: store, product_id: String(body.productId), photo_src: src,
      photo_n: Number(body.n) || null, sheet_slug: body.sheet || null, shot: body.shot || null,
      label, problems: label === "problem" ? problems : [], note: String(body.note || "").trim().slice(0, 300) || null,
      labelled_by: scope.name, labelled_at: new Date().toISOString() }),
  });
  return json({ ok: true });
}

// ============================================================================
// CONFIRM SHOTS — a person says which shot each photo is (2026-10-16)
// ============================================================================
// ⚠️ WHY. The gold set for a local vision model (scripts/pq-gold/) found no human
// shot label anywhere. The trainer above graded FRAMING beside the model's shot
// and gave no way to say the shot was wrong. An approved Quick Fix accepts a
// grade as a whole. A model meant only to match the perception layer ("the
// model reports, the code decides") must be scored on labels a PERSON made. So
// Ethan confirms or corrects the saved grade's label on every photo of a
// listing, and the rows go to pq_shot_labels (0148).
//
// DM / CEO ONLY, whatever the feature override says. These labels are the
// answer key, and they're only worth anything if one trained eye makes them.
//
// THE QUEUE fills the sheets with the most graded listings and the thinnest
// gold first: need = min(TARGET, graded) − confirmed, ties going to the busier
// sheet. That way video-games (100+ graded) fills before a two-listing sheet.
// Inside a sheet the newest grade comes first (Opus, today's rules).
//
// ONLY ALIGNED LISTINGS. A saved grade numbers photos as they were when graded;
// if today's listing has a different number of photos, a prefilled label would
// sit on the wrong photo, so the listing is left out. An approved order or
// deletion renumbered its report (renumberRow), so it still lines up.
//
// FREE. No model call. Photos are read live through the Admin API (Shopify
// CDN, never a Supabase transform); guide examples are /object/public/.
const CONFIRM_TARGET = 40;
// Every per-photo field rules.ts reads from the model, by the model's own name
// (0149): framing problems, the issues it costs (major only, so a flag means "a
// buyer would notice"), and closeup = whole_item false. "cropped" is the 0148
// name for cut_off and is kept so an old row still validates.
const CONFIRM_FLAGS = ["crooked", "off_center", "too_small", "cut_off", "turned", "wrong_angle",
  "blurry", "too_dark_or_glare", "reflection",
  "clutter", "dirty_backdrop", "loose_cord", "not_on_stand", "different_spot",
  "closeup", "screen_on", "label_legible", "personal_info", "stock_photo", "fake_or_edited", "wrong_item", "cropped"];
// The listing-level facts (0149), yes/no unless noted.
const CONFIRM_FACTS = ["lead_unclear", "serial_hidden", "new_claim_wrong", "units_apart", "flat_package"];
const confirmer = (scope: Scope) => ["district manager", "ceo"].includes(scope.role);

async function confirmView(scope: Scope, want: string, skip: Set<string>) {
  if (!confirmer(scope)) return { error: "forbidden", detail: "Confirm Shots is for the DM and CEO" };
  const graded: any[] = await rows(`picture_quality_reviews?report=not.is.null&sheet_slug=not.is.null`
    + `&store_code=in.(${scope.stores.join(",")})`
    + `&select=store_code,product_id,sku,title,sheet_slug,model,stamp,reviewed_at,photos:report->photos`
    + `&order=reviewed_at.desc&limit=10000`);
  // sb() throws on a missing table; before 0148 is applied, say so plainly.
  const doneRows = await rows(`pq_shot_labels?select=product_id,sheet_slug&limit=50000`).catch(() => null);
  if (!Array.isArray(doneRows)) return { error: "no_table", detail: "pq_shot_labels is not in the database yet (migration 0148)" };
  const done = new Set(doneRows.map((r: any) => r.product_id));
  const confirmedBySheet = new Map<string, Set<string>>();
  for (const r of doneRows) {
    if (!confirmedBySheet.has(r.sheet_slug)) confirmedBySheet.set(r.sheet_slug, new Set());
    confirmedBySheet.get(r.sheet_slug)!.add(r.product_id);
  }
  const sheets = await loadSheets();
  const nameOf = new Map(sheets.map(s => [s.slug, s.name]));
  const bySheet = new Map<string, any[]>();
  for (const g of graded) {
    if (!Array.isArray(g.photos) || !g.photos.length) continue;
    if (!bySheet.has(g.sheet_slug)) bySheet.set(g.sheet_slug, []);
    bySheet.get(g.sheet_slug)!.push(g);
  }
  const stats = [...bySheet].map(([slug, list]) => {
    const confirmed = confirmedBySheet.get(slug)?.size || 0;
    return { slug, name: nameOf.get(slug) || slug, graded: list.length, confirmed,
             left: list.filter(g => !done.has(g.product_id) && !skip.has(g.product_id)).length,
             need: Math.max(0, Math.min(CONFIRM_TARGET, list.length) - confirmed) };
  }).sort((a, b) => b.need - a.need || b.graded - a.graded);
  const pick = stats.find(s => s.slug === want && s.left) || stats.find(s => s.need && s.left) || stats.find(s => s.left);
  const listings: any[] = [];
  const misaligned: string[] = [];
  if (pick) {
    const todo = bySheet.get(pick.slug)!.filter(g => !done.has(g.product_id) && !skip.has(g.product_id));
    // Six at a time: each is part of one Admin API read, and six is roughly ten
    // minutes of work.
    for (let i = 0; i < todo.length && listings.length < 6; i += 12) {
      const chunk = todo.slice(i, i + 12);
      const live = new Map<string, Listing>();
      for (const st of [...new Set(chunk.map(g => g.store_code))]) {
        const { shop, token } = await shopFor(st);
        for (const l of await fetchListings(shop, token, chunk.filter(g => g.store_code === st).map(g => g.product_id))) live.set(l.id, l);
      }
      for (const g of chunk) {
        if (listings.length >= 6) break;
        const l = live.get(g.product_id);
        if (!l || l.photos.length !== g.photos.length) { misaligned.push(g.product_id); continue; }
        listings.push({ store: g.store_code, productId: g.product_id, sku: g.sku || l.sku, title: l.title || g.title,
          sheet: g.sheet_slug, model: g.model, stamp: g.stamp, reviewedAt: g.reviewed_at,
          // What the listing SAYS, for the listing-level questions: the
          // cosmetic sentences about this unit (PayMore's template wording
          // left out, the way decide() reads them), the functional notes,
          // what's included, and the condition.
          unitNotes: sentences(l.cosmetic || "").filter(x => !isStandardSentence(x, 0)).slice(0, 8),
          // EVERY cosmetic sentence with the code's call on it, so a person can
          // overrule it in either direction: template wording read as a flaw,
          // or a real flaw dismissed as template wording (Ethan, 2026-10-16).
          notes: sentences(l.cosmetic || "").slice(0, 12).map(x => ({ text: x, unit: !isStandardSentence(x, 0) })),
          functional: String(l.functional || "").slice(0, 400), included: String(l.included || "").slice(0, 300),
          condition: String(l.condition || "").slice(0, 120),
          photos: l.photos.map((p, k) => ({ n: k + 1, src: p.src.split("?")[0], img: p.url, w: p.width, h: p.height,
            said: (g.photos.find((x: any) => x.n === k + 1)?.shots || []).map(String) })) });
      }
    }
  }
  const guide: Record<string, { name: string; shots: { label: string; cond: string | null; img: string | null }[] }> = {};
  for (const s of sheets) guide[s.slug] = { name: s.name, shots: s.shots.map(x => ({ label: x.label, cond: x.cond, img: x.img ? guideUrl(x.img) : null })) };
  // `misaligned`: sold or re-shot since the grade. Handed back so the page skips
  // them rather than being offered them again.
  return { target: CONFIRM_TARGET, sheets: stats, sheet: pick?.slug || null, misaligned,
           listings, guide, flags: CONFIRM_FLAGS, total: done.size };
}

async function saveShots(scope: Scope, body: any) {
  if (!confirmer(scope)) return json({ error: "forbidden", detail: "Confirm Shots is for the DM and CEO" }, 403);
  const store = String(body.store || "").toUpperCase();
  if (!scope.stores.includes(store)) return json({ error: "forbidden" }, 403);
  const productId = String(body.productId || "");
  const sheet = String(body.sheet || "");
  const photos = Array.isArray(body.photos) ? body.photos.slice(0, 60) : [];
  if (!productId || !sheet || !photos.length) return json({ error: "productId, sheet and photos required" }, 400);
  const clean = (a: unknown, max: number) => (Array.isArray(a) ? a : []).map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, max);
  const now = new Date().toISOString();
  const lf = body.listing && typeof body.listing === "object" ? body.listing : {};
  const facts = body.checked === true ? {
    ...Object.fromEntries(CONFIRM_FACTS.map(k => [k, lf[k] === true])),
    // not_applicable = "No Real Flaw": the notes name no flaw on this unit
    // (the model's own word for it, so it scores directly).
    main_flaw_shown: ["yes", "partly", "no", "not_applicable"].includes(lf.main_flaw_shown) ? lf.main_flaw_shown : null,
    // Each cosmetic sentence: the code's call (system) and the person's (real),
    // the answer key for isStandardSentence / PAYMORE_TEMPLATES.
    sentences: (Array.isArray(lf.sentences) ? lf.sentences : []).slice(0, 12)
      .filter((x: any) => x && typeof x.text === "string" && x.text.trim())
      .map((x: any) => ({ text: String(x.text).trim().slice(0, 400), system: x.system === true, real: x.real === true })),
    needed: clean(lf.needed, 12),
  } : null;
  const out = photos.map((p: any) => ({
    store_code: store, product_id: productId, sheet_slug: sheet, model_sheet: body.modelSheet || null,
    photo_src: String(p.src || "").split("?")[0], photo_n: Number(p.n) || 0,
    shots: clean(p.shots, 4), model_shots: clean(p.said, 6),
    flags: clean(p.flags, CONFIRM_FLAGS.length).filter(f => CONFIRM_FLAGS.includes(f)),
    repeat_of: Number.isInteger(p.repeatOf) && p.repeatOf >= 1 && p.repeatOf < (Number(p.n) || 0) ? p.repeatOf : null,
    // A flag left blank on a photo that was answered means NO (0149).
    flags_checked: body.checked === true,
    listing: facts,
    model: body.model || null, review_stamp: body.stamp || null, confirmed_by: scope.name, confirmed_at: now,
  }));
  if (out.some((r: any) => !r.photo_src || !r.photo_n || !r.shots.length)) return json({ error: "every photo needs src, n and at least one shot" }, 400);
  await sb("pq_shot_labels?on_conflict=product_id,photo_src", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(out),
  });
  return json({ ok: true, saved: out.length });
}

// decided_note is "dismissed: why" or "reorder denied: why" — the answer, then
// the person's words. Split back apart for the screen and the ask.
function splitNote(s: unknown) {
  const t = String(s || "");
  const m = /^(dismissed|reorder denied|should flag)(?::\s*([\s\S]*))?$/.exec(t);
  return m ? { as: m[1] === "reorder denied" ? "reorder" : m[1] === "should flag" ? "flag" : "fine", note: (m[2] || "").trim() }
           : { as: "fine", note: t.trim() };
}

// --- the notes, for Listing Health Notes ---------------------------------------
//
// Every dismissal that carries a note and has not been cleared, across the
// reader's stores, grouped by what the tool had said — a note is the only
// evidence a rule is wrong, and three notes against one kind of finding is a
// rule to go and change. The ask is written for Claude, with the listing's own
// fields, the findings as the tool stated them, and the photo URLs, so the call
// can be made by looking rather than by guessing (the same reason the title
// feedback carries the spec fields).
async function feedbackView(scope: Scope, days: number) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const all: any[] = await rows(`picture_quality_reviews?status=eq.dismissed&decided_note=not.is.null`
    + `&store_code=in.(${scope.stores.join(",")})&decided_at=gte.${since}`
    + `&select=store_code,product_id,sku,title,sheet_name,verdict,findings,reorder,decided_by,decided_at,decided_note,feedback_triaged_at`
    + `&order=decided_at.desc&limit=200`);
  const withNote = all.map(r => ({ ...r, ...splitNote(r.decided_note) })).filter(r => r.note);
  const open = withNote.filter(r => !r.feedback_triaged_at);
  const done = withNote.filter(r => r.feedback_triaged_at).slice(0, 40)
    .map(r => ({ sku: r.sku, note: r.note, takenAt: r.feedback_triaged_at }));
  const kindOf = (r: any) => r.as === "reorder" ? "reorder" : r.as === "flag" ? "should_flag"
    : String((r.findings || [])[0]?.code || r.verdict || "other");
  const groups: Record<string, any[]> = {};
  for (const r of open) (groups[kindOf(r)] ||= []).push(r);
  const KIND: Record<string, string> = {
    should_flag: "PASSED it — the manager says it should have been flagged (the note says what was missed)",
    reorder: "Suggested a new photo order", retake: "Said to retake following the guide",
    missing_shot: "Said a guide shot was missing", not_square: "Said a photo is not square",
    framing: "Said a photo is not to the guide's standard", flaw_not_shown: "Said the main flaw is not shown",
    blurry: "Said a photo is blurry", fake_or_edited: "Said a photo looks fake or edited",
    stock_photo: "Said a photo is a stock photo", lead: "Said photo 1 does not show the item",
    repeat: "Said photos repeat each other",
    dirty_backdrop: "Said the table or backdrop is dirty", clutter: "Said something else is in frame",
    reflection: "Said a reflection shows on the item", loose_cords: "Said cords are loose and sprawled out", not_on_stand: "Said a game is not on the stand", turned: "Said the item was turned a different way", order: "Said the photos are out of order", mixed_setups: "Said photos were taken in different spots",
    lot_not_shown: "Said a pair, set or lot is not all shown",
  };
  // Photos for the ask, read live — the note is about what the manager saw.
  const photosFor = new Map<string, string[]>();
  for (const st of [...new Set(open.map(r => r.store_code))]) {
    const { shop, token } = await shopFor(st);
    const ids = open.filter(r => r.store_code === st).map(r => r.product_id);
    for (let i = 0; i < ids.length; i += 50) {
      for (const l of await fetchListings(shop, token, ids.slice(i, i + 50))) photosFor.set(l.id, l.photos.map(p => p.src));
    }
  }
  const lines: string[] = [
    "SPEEKS Picture Quality — rule feedback from the review queue",
    `${scope.stores.join(", ")} · last ${days} days · ${open.length} dismissal${open.length === 1 ? "" : "s"} with a note`,
    "",
    "A manager looked at these listings' photos, decided the Picture Quality tool was",
    "wrong to flag them, and wrote why. For each group, look at the PHOTOS against the",
    "note and the guide sheet and say which it is:",
    "",
    "  A. THE RULE IS WRONG — change it in supabase/functions/picture-quality/index.ts,",
    "     add the case to scripts/picture-quality-calibrate.mjs, and deploy.",
    "  B. THE GUIDE IS WRONG OR UNCLEAR — say which sheet and shot to change.",
    "  C. THE MANAGER WAS MISTAKEN — the flag was right. Say so plainly, and say what",
    "     would have made the finding easier to trust.",
    "",
    "Nothing here has been changed. Do not write to any listing.",
  ];
  for (const [kind, list] of Object.entries(groups)) {
    lines.push("", "=".repeat(72), `${KIND[kind] || kind} — ${list.length}`, "=".repeat(72));
    list.forEach((r, i) => {
      lines.push("", `${i + 1}. ${r.store_code} · ${r.sku || "no SKU"} · ${r.product_id.split("/").pop()} · by ${r.decided_by || "?"} on ${String(r.decided_at || "").slice(0, 10)}`);
      lines.push(`   NOTE:      "${r.note}"`);
      lines.push(`   LISTING:   ${r.title}`);
      lines.push(`   GUIDE:     ${r.sheet_name || "—"}`);
      for (const f of r.findings || []) lines.push(`   TOOL SAID: ${f.text}`);
      if (r.as === "reorder" && r.reorder?.suggested) lines.push(`   ORDER:     ${r.reorder.current.join(",")} -> ${r.reorder.suggested.join(",")} (${(r.reorder.why || []).join("; ")})`);
      (photosFor.get(r.product_id) || []).forEach((u, k) => lines.push(`   PHOTO ${k + 1}:   ${u}`));
    });
  }
  lines.push("", "When you have decided, say which bucket each group fell in before changing anything.");
  return {
    total: open.length,
    groups: Object.entries(groups).map(([kind, list]) => ({ code: kind, label: KIND[kind] || kind, n: list.length,
      rows: list.map(r => ({ store: r.store_code, sku: r.sku, title: r.title, note: r.note, by: r.decided_by,
                             findings: (r.findings || []).map((f: any) => f.text), productId: r.product_id })) })),
    keys: open.map(r => ({ store: r.store_code, productId: r.product_id })),
    done, stores: scope.stores, ask: lines.join("\n"),
  };
}

// ⚠️ A REORDER IS APPLIED ONLY TO THE PHOTOS IT WAS WORKED OUT FOR. The
// suggestion is a list of photo NUMBERS; if a photo was added, removed or moved
// since the check, those numbers point at different photos and applying them
// would scramble the listing. So the live stamp must still match the reviewed
// one, and the move is by Shopify media id, never by position alone.
// ⚠️ AND IT GOES TO EBAY. PayMore's tool carries Shopify edits to eBay about a
// day later (confirmed for titles, HTML and fields; not yet for photo order —
// Ethan wants the overnight test re-run near launch, and the first approve is it).
async function applyReorder(scope: Scope, store: string, productId: string) {
  const r = (await rows(`picture_quality_reviews?store_code=eq.${store}&product_id=eq.${encodeURIComponent(productId)}`
    + `&select=verdict,status,reorder,deletion,findings,report,stamp,sheet_slug&limit=1`))?.[0];
  if (!r || r.status !== "open" || !r.reorder?.suggested) return json({ error: "no open reorder for this listing" }, 409);
  const { shop, token } = await shopFor(store);
  const l = (await fetchListings(shop, token, [productId]))[0];
  if (!l) return json({ error: "listing not found in Shopify" }, 404);
  const sheet = (await loadSheets()).find(s => s.slug === r.sheet_slug) || null;
  if (r.stamp !== await stampFor(l, sheet)) {
    return json({ error: "photos changed", detail: "The photos changed after this was checked, so the suggested order no longer fits. Press Check Again." }, 409);
  }
  const order: number[] = r.reorder.suggested;
  if (order.length !== l.photos.length || order.some(n => !l.photos[n - 1]?.mediaId)) {
    return json({ error: "the suggested order does not match this listing's photos" }, 409);
  }
  const moves = order.map((n, i) => ({ id: l.photos[n - 1].mediaId, newPosition: String(i) }));
  const res = await gql(shop, token, `mutation($id: ID!, $moves: [MoveInput!]!) {
      productReorderMedia(id: $id, moves: $moves) { job { id } mediaUserErrors { field message } } }`,
    { id: productId, moves });
  const errs = res?.productReorderMedia?.mediaUserErrors || [];
  if (errs.length) return json({ error: "shopify refused the reorder", detail: errs.map((e: any) => e.message).join("; ") }, 422);
  // The stamp moves to the NEW order, so the sweep does not pay to re-grade a
  // listing whose only change is the one we just made.
  const reordered = { ...l, photos: order.map(n => l.photos[n - 1]) };
  // Done only when nothing else is waiting: a Fix row keeps its real problems,
  // and a Quick Fix with a deletion still to approve keeps that (renumbered).
  const moved = renumberRow({ ...r, reorder: null }, n => { const i = order.indexOf(n); return i < 0 ? null : i + 1; });
  const findings = moved.findings.filter((f: any) => f.code !== "order");
  const done = r.verdict === "reorder" && !moved.deletion;
  await sb(`picture_quality_reviews?store_code=eq.${store}&product_id=eq.${encodeURIComponent(productId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ reorder: null, deletion: moved.deletion, findings, report: moved.report, stamp: await stampFor(reordered, sheet),
      ...(done ? { status: "applied", decided_by: scope.name, decided_at: new Date().toISOString(), decided_note: "reorder approved" } : {}) }),
  });
  return json({ ok: true, applied: productId, order });
}

// ⚠️ A DELETION IS APPLIED ONLY TO THE PHOTOS IT WAS WORKED OUT FOR — the same
// guard as applyReorder: the live stamp must match the graded one, and the
// photos go by Shopify media id, never by position alone. Ethan (2026-10-11):
// a repeated photo is a click on Quick Fixes — "say approve deletion. Don't
// imply that the user should delete it themselves."
//
// ⚠️ WHICH MUTATION IS ASKED, NOT ASSUMED. productDeleteMedia is the classic
// call and Shopify has been moving media work onto fileUpdate (detach with
// referencesToRemove, which leaves the file in Files rather than destroying
// it). Rather than bet on which one API ${SHOPIFY_API_VERSION} still has, the
// schema is asked once per invocation.
// ⚠️ includeDeprecated: true. productDeleteMedia IS deprecated (in favour of
// fileUpdate), so a plain `fields` list leaves it out — and the code fell
// through to fileUpdate, which needs the write_files scope no store granted:
// the first live Approve Deletion (WSP AirPods, 2026-10-11) came back
// "Access denied for fileUpdate field". productDeleteMedia needs only
// write_products, which all five stores have.
let deleteVia: Promise<"productDeleteMedia" | "fileUpdate" | null> | null = null;
function deleteMutation(shop: string, token: string) {
  deleteVia ||= gql(shop, token, `{ __type(name: "Mutation") { fields(includeDeprecated: true) { name } } }`).then((d: any) => {
    const names = new Set((d?.__type?.fields || []).map((x: any) => x.name));
    return names.has("productDeleteMedia") ? "productDeleteMedia" : names.has("fileUpdate") ? "fileUpdate" : null;
  });
  return deleteVia;
}

// ⚠️ PHOTO NUMBERS MOVE WHEN THE PHOTOS DO. Approve Order and Approve Deletion
// can now be used on a Fix row too (Ethan, 2026-10-14: "things that are in fix
// these photos can still have quick fix deletion and re orders"), and the row
// stays open for its real problems — so every number still on it (findings, the
// deletion, a suggested order, the saved report Recheck-free re-deciding reads)
// is moved to the new numbering. `to` maps an old photo number to its new one,
// or null when that photo is gone.
function renumberRow(r: any, to: (n: number) => number | null) {
  const m = (n: unknown) => typeof n === "number" ? to(n) : null;
  const findings = (r.findings || []).map((f: any) => {
    const g = { ...f };
    if (typeof f.photo === "number") g.photo = m(f.photo);
    if (Array.isArray(f.photos)) g.photos = f.photos.map(m).filter((x: number | null) => x != null);
    return g;
  }).filter((f: any) => f.photo !== null && !(Array.isArray(f.photos) && !f.photos.length && f.code !== "retake"));
  let deletion = null;
  if (r.deletion?.photos?.length) {
    const pairs = r.deletion.photos.map((x: number, i: number) => [m(x), m(r.deletion.of?.[i])])
      .filter(([a, b]: (number | null)[]) => a != null && b != null) as [number, number][];
    if (pairs.length) deletion = { photos: pairs.map(q => q[0]), of: pairs.map(q => q[1]) };
  }
  // The repeat line names its photos in words; say it again in the new numbers.
  for (const f of findings) if (f.code === "repeat") {
    if (!deletion) { f.drop = true; continue; }
    f.photos = deletion.photos;
    f.text = deletion.photos.map((x: number, i: number) => `Photo ${x} is the same shot as photo ${deletion!.of[i]}`).join("; ")
      + `. Approve Deletion removes ${deletion.photos.length > 1 ? "them" : "it"}.`;
  }
  let reorder = null;
  if (r.reorder?.suggested?.length) {
    const sug = r.reorder.suggested.map(m).filter((x: number | null) => x != null) as number[];
    if (sug.some((x, i) => x !== i + 1)) reorder = { ...r.reorder, current: sug.map((_, i) => i + 1), suggested: sug };
  }
  // The "out of order" line exists only beside a reorder. When deleting the
  // repeat was the whole order problem, the line goes too (Ethan, 2026-10-14,
  // OVL Yoshi's Island: "Says it's out of order, but it follows the guide" —
  // photo 3, a second front, had been deleted).
  if (!reorder) for (const f of findings) if (f.code === "order") f.drop = true;
  const rep = r.report;
  const kept = rep?.photos ? rep.photos.map((q: any) => ({ ...q, n: m(q.n), repeats: m(q.repeats) }))
    .filter((q: any) => q.n != null).sort((a: any, b: any) => a.n - b.n) : null;
  const report = kept ? { ...rep, photos: kept,
    setups: (rep.setups || []).map((g: number[]) => g.map(m).filter((x: number | null) => x != null)),
    // Nothing left to move: the order as it now stands.
    suggested_order: reorder ? reorder.suggested : kept.map((_: any, i: number) => i + 1),
  } : rep;
  return { findings: findings.filter((f: any) => !f.drop), deletion, reorder, report };
}

async function applyDeletion(scope: Scope, store: string, productId: string) {
  const r = (await rows(`picture_quality_reviews?store_code=eq.${store}&product_id=eq.${encodeURIComponent(productId)}`
    + `&select=verdict,status,deletion,reorder,findings,report,stamp,sheet_slug&limit=1`))?.[0];
  if (!r || r.status !== "open" || !r.deletion?.photos?.length) return json({ error: "no open deletion for this listing" }, 409);
  const { shop, token } = await shopFor(store);
  const l = (await fetchListings(shop, token, [productId]))[0];
  if (!l) return json({ error: "listing not found in Shopify" }, 404);
  const sheet = (await loadSheets()).find(s => s.slug === r.sheet_slug) || null;
  if (r.stamp !== await stampFor(l, sheet)) {
    return json({ error: "photos changed", detail: "The photos changed after this was checked, so the photo to delete may have moved. Press Recheck." }, 409);
  }
  const nums: number[] = r.deletion.photos;
  const ids = nums.map(n => l.photos[n - 1]?.mediaId).filter(Boolean);
  if (ids.length !== nums.length) return json({ error: "the photos to delete do not match this listing" }, 409);
  // Never the last photo, and never every photo: a listing with none is worse
  // than one with a repeat.
  if (ids.length >= l.photos.length) return json({ error: "that would delete every photo" }, 409);
  const via = await deleteMutation(shop, token);
  let errs: string[] = [];
  if (via === "productDeleteMedia") {
    const res = await gql(shop, token, `mutation($p: ID!, $m: [ID!]!) {
        productDeleteMedia(productId: $p, mediaIds: $m) { deletedMediaIds mediaUserErrors { message } } }`,
      { p: productId, m: ids });
    errs = (res?.productDeleteMedia?.mediaUserErrors || []).map((e: any) => e.message);
  } else if (via === "fileUpdate") {
    const res = await gql(shop, token, `mutation($f: [FileUpdateInput!]!) {
        fileUpdate(files: $f) { files { id } userErrors { message } } }`,
      { f: ids.map(id => ({ id, referencesToRemove: [productId] })) });
    errs = (res?.fileUpdate?.userErrors || []).map((e: any) => e.message);
  } else {
    return json({ error: "this Shopify API version offers no media delete" }, 501);
  }
  if (errs.length) return json({ error: "shopify refused the deletion", detail: errs.join("; ") }, 422);
  // The stamp moves to the photos that remain, so the sweep does not pay to
  // re-grade a listing whose only change is the one just made. Any suggested
  // order was worked out on the old numbering, so it goes too; the repeat
  // finding is done. A row that was only a Quick Fix is finished.
  const kept = { ...l, photos: l.photos.filter((_, i) => !nums.includes(i + 1)) };
  // Old number → new, with the deleted photos gone (see renumberRow). The
  // suggested order follows the photos that remain.
  const left = l.photos.map((_, i) => i + 1).filter(n => !nums.includes(n));
  const moved = renumberRow({ ...r, deletion: null }, n => { const i = left.indexOf(n); return i < 0 ? null : i + 1; });
  const findings = moved.findings.filter((f: any) => f.code !== "repeat");
  // A Quick Fix row is finished once nothing is left to approve on it.
  const done = r.verdict === "reorder" && !moved.reorder;
  await sb(`picture_quality_reviews?store_code=eq.${store}&product_id=eq.${encodeURIComponent(productId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ deletion: null, reorder: moved.reorder, findings, report: moved.report, stamp: await stampFor(kept, sheet),
      ...(done ? { status: "applied", decided_by: scope.name, decided_at: new Date().toISOString(),
                   decided_note: `deletion approved: photo ${nums.join(", ")}` } : {}) }),
  });
  return json({ ok: true, deleted: nums, via });
}

async function handlePost(req: Request, scope: Scope) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  // The notes have been worked through (Listing Health Notes → Clear). A list
  // across stores, so it comes before the one-store gate below — the same shape
  // as the title tool's `triaged`, and the same rule: it marks the NOTE read,
  // never the rule fixed.
  // A training label (see trainView) — one photo graded by a person.
  if (action === "label") return await saveLabel(scope, body);
  // Confirm Shots (see confirmView): one listing's photos, labelled by a person.
  if (action === "confirm-shots") return await saveShots(scope, body);
  if (action === "triaged") {
    const keys = Array.isArray(body.keys) ? body.keys.slice(0, 200) : [];
    let n = 0;
    for (const k of keys) {
      const st = String(k?.store || "").toUpperCase();
      const pid = String(k?.productId || "");
      if (!st || !pid || !scope.stores.includes(st)) continue;
      await sb(`picture_quality_reviews?store_code=eq.${st}&product_id=eq.${encodeURIComponent(pid)}&status=eq.dismissed`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ feedback_triaged_at: new Date().toISOString(), feedback_triaged_by: scope.name }),
      });
      n++;
    }
    return json({ ok: true, triaged: n });
  }
  const store = String(body.store || "").toUpperCase();
  if (!scope.stores.includes(store)) return json({ error: "forbidden", detail: `not your store: ${store}` }, 403);
  const productId = String(body.productId || "");
  if (!productId) return json({ error: "productId required" }, 400);
  const key = `store_code=eq.${store}&product_id=eq.${encodeURIComponent(productId)}`;

  // Dismiss — "this is fine" — and Deny on a reorder, which is the same answer
  // about the order. The note is kept: dismissals are how a rule is found wrong,
  // the same lesson the title tool's Confirmed Correct drawer taught.
  // "should-flag" is the same answer from the other side: a PASS the manager
  // disagrees with. It leaves the Passed tab the same way, and its note reaches
  // Listing Health Notes as its own group.
  if (action === "dismiss" || action === "deny-reorder" || action === "should-flag") {
    const note = String(body.reason || "").trim().slice(0, 300);
    // Required (Ethan, 2026-09-30): a dismissal with no why gives nothing to fix.
    if (!note) return json({ error: "reason required", detail: "Say why the photos are fine — that note is how a wrong rule gets fixed." }, 400);
    await sb(`picture_quality_reviews?${key}&status=eq.open`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "dismissed", decided_by: scope.name, decided_at: new Date().toISOString(),
        decided_note: (action === "deny-reorder" ? "reorder denied" : action === "should-flag" ? "should flag" : "dismissed") + (note ? `: ${note}` : "") }),
    });
    return json({ ok: true, dismissed: productId });
  }
  // Undo, from the Confirmed Fine drawer. The whole decision is cleared, not
  // just the status: a row back in the queue carrying somebody's old note would
  // read as still decided.
  if (action === "reopen") {
    await sb(`picture_quality_reviews?${key}&status=eq.dismissed`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "open", decided_by: null, decided_at: null, decided_note: null,
                             feedback_triaged_at: null, feedback_triaged_by: null }),
    });
    return json({ ok: true, reopened: productId });
  }
  if (action === "reorder") return await applyReorder(scope, store, productId);
  if (action === "delete-photos") return await applyDeletion(scope, store, productId);
  return json({ error: `unknown action: ${action}` }, 400);
}

// A long job answered in a stream of spaces, then the JSON. See the keep-alive
// note in the router; shared by the sweep and Check Again.
function streamed(work: () => Promise<unknown>) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctrl) {
      const tick = setInterval(() => ctrl.enqueue(enc.encode(" ")), 15000);
      let out: unknown;
      try { out = await work(); }
      catch (e) { out = { error: String((e as Error).message || e) }; }
      clearInterval(tick);
      ctrl.enqueue(enc.encode(JSON.stringify(out, null, 2)));
      ctrl.close();
    },
  });
  return new Response(body, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// --- routing -------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const view = url.searchParams.get("view") || "";

    if (req.method === "POST" || view === "review" || view === "counts" || view === "feedback" || view === "train" || view === "confirm") {
      const scope = await scopeFor(req.headers.get("x-user-pin") || "");
      if (!scope) return json({ error: "unauthorized", detail: "no matching user, or Picture Quality is not switched on for you" }, 401);
      if (req.method === "POST") {
        // Check Again: one listing, graded now and saved — for the manager who
        // just retook the photos. Streamed, because two looks can pass 150s.
        const peek = await req.clone().json().catch(() => ({}));
        if (peek.action === "recheck") {
          const store = String(peek.store || "").toUpperCase();
          if (!scope.stores.includes(store)) return json({ error: "forbidden" }, 403);
          const id = String(peek.productId || "");
          if (!id) return json({ error: "productId required" }, 400);
          return streamed(async () => {
            const out = await runReviews(store, [id], DEFAULT_MODEL, DEFAULT_EFFORT, true);
            const r = out.results[0];
            return { ok: r?.verdict !== "error", verdict: r?.verdict, findings: r?.findings, cost_usd: out.cost_usd };
          });
        }
        return await handlePost(req, scope);
      }
      if (view === "counts") {
        // Current recipe only — the same rule as the queue, so the All Stores
        // card and the tab it opens can never disagree about the count.
        const open = await rows(`picture_quality_reviews?status=eq.open&verdict=in.(retake,fix,reorder)`
          + `&stamp=like.${RECIPE}:*&store_code=in.(${scope.stores.join(",")})&select=store_code,verdict&limit=10000`);
        const counts: Record<string, Record<string, number>> = {};
        for (const r of open) (counts[r.store_code] ||= {})[r.verdict] = ((counts[r.store_code] || {})[r.verdict] || 0) + 1;
        return json({ scope, counts });
      }
      if (view === "feedback") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days") || 30), 1), 180);
        return json({ scope, ...(await feedbackView(scope, days)) });
      }
      if (view === "confirm") {
        const d: any = await confirmView(scope, url.searchParams.get("sheet") || "",
          new Set((url.searchParams.get("skip") || "").split(",").filter(Boolean)));
        return json(d, d.error ? (d.error === "forbidden" ? 403 : 409) : 200);
      }
      if (view === "train") return json(await trainView(scope, (url.searchParams.get("store") || "").toUpperCase(),
        Math.max(0, Number(url.searchParams.get("skip") || 0))));
      return json(await reviewView(scope, (url.searchParams.get("store") || "").toUpperCase()));
    }

    if (!secretOk(url)) return json({ error: "unauthorized" }, 401);
    // ?redecide=1&store=X — re-apply today's rules to saved reports, free.
    if (url.searchParams.get("redecide") === "1") {
      const st = (url.searchParams.get("store") || "").toUpperCase();
      if (!STORES.includes(st)) return json({ error: "pass ?store=" }, 400);
      return streamed(() => redecide(st));
    }
    // ?poll=1 — collect ended batches (every store at once). See pollBatches.
    if (url.searchParams.get("poll") === "1") return streamed(() => pollBatches());
    // ?cancel=<batch id> — a batch stuck "in progress" (MPL second looks, 10-14:
    // over an hour for 15 requests; the first pass of 65 took 14 minutes). Not
    // yet processed requests are not billed. Marked cancelled so the poller
    // leaves it, and the listings' ids come back to grade live.
    const cancelId = url.searchParams.get("cancel");
    if (cancelId) {
      const b = (await rows(`pq_batches?batch_id=eq.${encodeURIComponent(cancelId)}&select=id,store_code,items,status&limit=1`))?.[0];
      if (!b) return json({ error: "no such batch" }, 404);
      const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") || "" });
      const info = await (client as any).messages.batches.cancel(cancelId);
      // "failed", with a note: pq_batches_status_check allows only submitted /
      // done / failed, so the "cancelled" this wrote was refused and the row
      // stayed "submitted" (LEE, 2026-10-15) — leaving its listings "in flight"
      // for the next sweep and its partial results for the next poll.
      await sb(`pq_batches?id=eq.${b.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "failed", finished_at: new Date().toISOString(), result: { cancelled: true } }) });
      const pids = [...new Set(Object.values((b.items || {}) as Record<string, Pending>).map(p => p.pid))];
      return json({ cancelled: cancelId, store: b.store_code, processing_status: info?.processing_status, request_counts: info?.request_counts, pids });
    }
    const store = (url.searchParams.get("store") || "").toUpperCase();
    if (!STORES.includes(store)) return json({ error: "pass ?store=OVL|LEE|WSP|MPL|BAL" }, 400);
    const model = url.searchParams.get("model") || DEFAULT_MODEL;
    if (!PRICES[model]) return json({ error: `unknown model ${model}` }, 400);
    const effort = url.searchParams.get("effort") || DEFAULT_EFFORT;

    // ?sweep=N — grade up to N listings that need it, and SAVE. Run it again to
    // walk further; `remaining` says how far there is to go.
    const sweep = Number(url.searchParams.get("sweep") || 0);
    // ?sweep=N&batch=1[&days=3] — the nightly path: NEW listings through the
    // Batch API at half price. See batchSweep.
    if (sweep > 0 && url.searchParams.get("batch") === "1") {
      // PAUSED by Ethan 2026-10-13 until he has reviewed the first nights' rows
      // ("I don't need this running every night if there are errors"). The cron
      // still fires and gets this answer; nothing is graded or spent. Resume:
      //   npx supabase secrets unset PQ_NIGHTLY_PAUSED --project-ref ejzaqmyxxrkmxvzbjeuo
      // A hand run can still go with &force=1.
      if (Deno.env.get("PQ_NIGHTLY_PAUSED") === "1" && url.searchParams.get("force") !== "1") {
        return json({ store, paused: true, note: "Nightly sweep paused (PQ_NIGHTLY_PAUSED=1) — nothing submitted." });
      }
      // THE NIGHTLY SAMPLE (Ethan, 2026-10-13): "if we turn the batch back on, I
      // only want it for OVL and only pull 10 new listings from today at random".
      // The cron still calls every store with sweep=200&days=3; anything without
      // &force=1 is held to this instead. A hand run (&force=1) takes its params.
      // WIDENED TO ALL FIVE STORES (Ethan, 2026-10-15, once every store had been
      // re-graded on Opus and reviewed: "turn the nightly batch run back on and
      // run 10 random listings made today from all 5 stores").
      const NIGHTLY = { stores: ["OVL", "LEE", "WSP", "MPL", "BAL"], limit: 10, days: 1 };
      const forced = url.searchParams.get("force") === "1";
      if (!forced && !NIGHTLY.stores.includes(store)) {
        return json({ store, skipped: true, note: `Nightly sample is ${NIGHTLY.stores.join(", ")} only.` });
      }
      const days = forced ? Math.min(Math.max(Number(url.searchParams.get("days") || 3), 1), 30) : NIGHTLY.days;
      const limit = forced ? Math.min(sweep, 200) : NIGHTLY.limit;
      return streamed(() => batchSweep(store, limit, days, model, effort, url.searchParams.get("regrade") === "1",
        !forced || url.searchParams.get("random") === "1"));
    }
    if (sweep > 0) {
      return streamed(async () => {
        const { shop, token } = await shopFor(store);
        const c = await sweepCandidates(store, shop, token, Math.min(sweep, MAX_IDS));
        if (!c.need.length) return { store, live: c.live, reviewed: 0, remaining: 0, done: true };
        const out = await runReviews(store, c.need, model, effort, true);
        return { store, live: c.live, neverSeen: c.neverSeen, reviewed: out.reviewed,
                 remaining: Math.max(0, c.neverSeen - c.need.length), cost_usd: out.cost_usd, verdicts: out.verdicts };
      });
    }

    const ids = (url.searchParams.get("ids") || "").split(",").map(s => s.trim()).filter(Boolean)
      .map(s => s.startsWith("gid://") ? s : `gid://shopify/Product/${s}`);
    // &skus=KS01-…,KS01-… — re-grade rows already saved, by the SKU on the
    // screen (Ethan reviews by what the row shows; the id is not on it).
    const skus = (url.searchParams.get("skus") || "").split(",").map(s => s.trim()).filter(s => /^[\w-]+$/.test(s));
    if (skus.length) {
      const got = await rows(`picture_quality_reviews?store_code=eq.${store}&sku=in.(${skus.join(",")})&select=product_id`);
      ids.push(...new Set<string>(got.map((g: any) => String(g.product_id))));
    }
    // &listers=1 — FREE: every open row's tags, and which ones match no one in
    // users (Ethan, 2026-10-14: "why are so many things coming up as Unknown?").
    if (url.searchParams.get("listers") === "1") {
      const { shop, token } = await shopFor(store);
      const listerIx = listerIndex(await rows("users?select=name,role,store").catch(() => []) || []);
      const open = [...new Set<string>((await rows(`picture_quality_reviews?store_code=eq.${store}&status=eq.open&select=product_id&limit=2000`))
        .map((r: any) => String(r.product_id)))];
      const found: Record<string, number> = {}, unmatched: Record<string, number> = {};
      let none = 0;
      for (let i = 0; i < open.length; i += 25) {
        for (const l of await fetchListings(shop, token, open.slice(i, i + 25))) {
          const hit = listerFrom(l.tags, listerIx, store);
          if (hit) { found[hit.name] = (found[hit.name] || 0) + 1; continue; }
          const cand = l.tags.filter(t => !/^(ebay|inv|market|pickuponly|b2b|rcy|new|used|sale)$/i.test(String(t).trim()));
          if (!cand.length) none++;
          for (const t of cand) unmatched[t] = (unmatched[t] || 0) + 1;
        }
      }
      return json({ store, open: open.length, matched: found, unmatchedTags: unmatched, noNameTag: none });
    }
    if (!ids.length) return json({ error: "pass &ids=<product ids>, &skus=<saved SKUs>, or &sweep=N" }, 400);
    // &listing=1 — FREE: what the checker reads from Shopify, and which cosmetic
    // sentences count as about THIS unit (Gears 5, 10-14: a Fair game's normal
    // wording asked for a Cosmetic Flaws photo). No model call.
    if (url.searchParams.get("listing") === "1") {
      const { shop, token } = await shopFor(store);
      const listerIx = listerIndex(await rows("users?select=name,role,store").catch(() => []) || []);
      return json((await fetchListings(shop, token, ids.slice(0, MAX_IDS))).map(l => ({
        id: l.id, sku: l.sku, title: l.title, tags: l.tags, lister: listerFrom(l.tags, listerIx, store), condition: l.condition, included: l.included, notIncluded: l.notIncluded,
        cosmetic: sentences(l.cosmetic).map(x => ({ sentence: x, about: isStandardSentence(x, 0) ? "standard" : "unit" })),
        functional: l.functional })));
    }
    if (ids.length > MAX_IDS) return json({ error: `at most ${MAX_IDS} ids per call — the edge wall is 150s` }, 400);
    // ⚠️ KEEP-ALIVE. The gateway drops a request after 150s of SILENCE, and a
    // flagged listing now gets two looks — the Pyle (re-sheeted, then looked at
    // twice: three reviews) and the 14-photo Acer both hit it. A space every
    // 15s keeps the line open; JSON.parse ignores leading whitespace. The status
    // is sent with the first byte, so a failure after that arrives as a 200 with
    // an "error" field — callers check the body, not just the status.
    const save = url.searchParams.get("save") === "1";
    // ?framing=1 — the framing look, for calibration only (see FramingReport).
    return streamed(() => runReviews(store, ids, model, effort, save, url.searchParams.get("framing") === "1"));
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
