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
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_EFFORT = "medium";   // low wandered run to run on small visual calls (calibration 2026-09-25)
const PRICES: Record<string, [number, number]> = {   // $ per million in / out
  "claude-sonnet-5": [2, 10],
  "claude-opus-5": [5, 25],
};

// ⚠️ BUMP WHEN WHAT WE ASK CHANGES. It is part of every stamp, so a new recipe
// re-grades everything instead of leaving old answers given less to look at.
// v8 2026-09-25: a flag must be seen by two independent looks
// v11 (a separate framing look) scored worse and is off — see FramingReport.
const RECIPE = "pq-v15";  // v15 2026-10-08: reflections cost 3/6/9 by price (not on Screen Off). v14: anything besides item + white backdrop costs 5/10/15 by price, like v13's dirty table. v12 2026-10-08: flagged by a weighted picture score under PASS_BAR, not by any finding. v10: controllers judged on their sheet; crooked = slanted in frame; wrong angle = side not visible; repeats

// Photos are sent at this size. The model sees framing, labels and screens
// fine at 800px; full size would roughly triple the bill for nothing.
const PHOTO_PX = 800;
// A sentence on at least this many of a store's listings is template text.
const BOILERPLATE_MIN = 4;
const SQUARE_TOLERANCE = 0.01;
const RETAKE_SHARE = 0.4;
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

// RULE 6. Every sentence of every active listing's cosmetic notes, counted. A
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

type Shot = { label: string; cond: string | null; repeatable: boolean; note: string | null; img: string | null };
type Sheet = { slug: string; name: string; group: string | null; updated: string; shots: Shot[] };

async function loadSheets(): Promise<Sheet[]> {
  const cats = await rows(`pg_categories?active=eq.true&select=id,slug,name,group_name,updated_at`);
  const shots = await rows(`pg_shots?select=category_id,label,cond_label,repeatable,note,image_path,sort_order,updated_at&order=sort_order`);
  return cats.map((c: any) => {
    const mine = shots.filter((s: any) => s.category_id === c.id);
    const newest = [c.updated_at, ...mine.map((s: any) => s.updated_at)].sort().pop();
    return {
      slug: c.slug, name: c.name, group: c.group_name, updated: String(newest || ""),
      shots: mine.map((s: any) => ({ label: s.label, cond: s.cond_label, repeatable: !!s.repeatable,
                                     note: s.note, img: s.image_path })),
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
- Two matching speakers sold together use "speaker-pairs".
- An item with no sheet of its own uses the CLOSEST similar sheet — a mirrorless or DSLR camera uses "point-and-shoot-cameras", a tablet-like device uses a tablet sheet. Use "small-medium-misc-items" only when nothing on the list is similar.
- If you cannot tell what the item is, return null with confidence "low".`;

const PhotoReport = z.object({
  n: z.number().int(),
  shots: z.array(z.string()),
  whole_item: z.boolean(),
  // An earlier photo this one repeats — the same view, barely moved. Null if none.
  repeats: z.number().int().nullable(),
  framing: z.enum(["matches", "close", "off"]),
  framing_problems: z.array(z.enum(["crooked", "off_center", "too_small", "cut_off", "wrong_angle"])),
  issues: z.array(z.object({
    type: z.enum([
      "blurry", "too_dark_or_glare", "clutter", "reflection",
      "stock_photo", "fake_or_edited", "personal_info", "wrong_item", "pair_not_together", "dirty_backdrop",
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
  main_flaw: z.object({
    stated: z.string().nullable(),
    source: z.enum(["unit", "title", "none"]),
    shown: z.enum(["yes", "partly", "no", "not_applicable"]),
    photo: z.number().int().nullable(),
  }),
  serial: z.enum(["shown", "hidden_behind_cover", "not_shown"]),
  lead_ok: z.boolean(),
  suggested_order: z.array(z.number().int()),
  title_notes: z.array(z.object({ issue: z.string(), suggestion: z.string(), photo: z.number().int().nullable() })),
  summary: z.string(),
});
type ReportT = z.infer<typeof Report>;

const REVIEW_SYSTEM = `You grade the photos of one used-electronics listing against the store's Picture Guide sheet for that kind of item. You report what you see; the store's code turns your report into a verdict, so be exact and do not decide pass/fail yourself.

The owner's principle: a photo problem matters only if it would stop a buyer judging the item. When a call is borderline, report no issue.

sheet_fits: false only if this sheet is clearly the wrong kind of item (e.g. the photos show two speakers sold as a pair but the sheet is for one). Then give better_sheet as a slug from OTHER SHEETS; otherwise better_sheet is null.

For each photo (numbered from 1, in listing order), report:
- shots: which sheet shot labels it covers. One photo may cover two (a front view with the lens cap off is both "Front of Projector" and "Front of Projector (Lens Open)"). Use "Box" for packaging, "Extra" for anything that is not a sheet shot.
- whole_item: true if it is meant to show the whole item, false for a deliberate closeup (glass, mount, ports, a label). A closeup may be tight — never report cut_off on one.
- repeats: the number of an EARLIER photo this one repeats — the same side from the same angle, only slightly moved or re-cropped, adding nothing a buyer did not already see. Null if it shows anything new (another side, another angle, a detail).
- framing: compare the photo to the sheet's EXAMPLE of the same shot. "matches" = shot like the example. "close" = small differences a buyer would not care about. "off" = one of these framing_problems. Judge EVERY photo of the item on its own — a listing where photo after photo sits low or to one side of the frame, or leans, is exactly what the store wants found, even when each one alone looks like a small miss:
  crooked — the item is rotated IN THE PICTURE: edges that should run level or upright visibly slant, as if the camera was turned or the item slumped on its stand. A different VIEWPOINT is not crooked — a tablet stood on edge and shot from the corner, a game case shown at the same angle as the example, a deliberately angled side view. A round item shot face-on (a lens, a speaker cone) is never crooked.
  off_center — the item sits clearly to one side, or low or high, in the frame instead of centred like the example (a stray cable or the stand does not count; the item does).
  too_small — the item is much smaller in the frame than in the example, leaving a lot of empty background (e.g. a phone lying small in the middle of the photo where the example fills the frame). A tall or thin item leaving space on its short sides is not this.
  cut_off — part of an item meant to be shown whole is outside the frame (e.g. the top of a tablet's screen cropped off).
  wrong_angle — the side or part the shot is FOR cannot be seen (e.g. a "Top Side" shot taken from straight above with the phone lying flat, so the top edge is not visible). A different angle from the example that still shows that side clearly is NOT wrong_angle — the guide's photos are there to show each side of the device, not to fix one exact angle. A photo that is not a sheet shot is never wrong_angle. A photo turned upside down or sideways is not wrong_angle.
  If framing is "matches" or "close", framing_problems is empty. Photos of OTHER things that come WITH the item — its box, cables, chargers, a console's controllers, a case, an everything-included spread — are staged: give them "matches". But when that thing IS the item (a controller on the Game Controllers sheet, a box on a New In Box sheet), it is the item and is judged. A photo of the item itself is always judged, even if it is not a sheet shot. A deliberate closeup of a detail (a label, ports, a lens mount, a memory stick's pins shot on its stand) is never cut_off — but a photo meant to show the whole screen or body that crops part of it off is.
- issues, only when clearly true, each with a severity. "major" means a buyer would notice and it hurts the listing; "minor" means you can see it but it does not matter. Only major issues are acted on:
  blurry, too_dark_or_glare — the detail the shot exists for cannot be made out AND it is something a buyer needs: a label, a screen, a flaw, the face or body of the item. An edge-on view of a thin item with nothing printed on its edge (a memory stick's side) is not this, even if soft. A "Screen Off" shot is meant to be a dark screen with reflections — never report it.
  reflection — the room, a light, a window, the photographer, or the phone or camera taking the photo is mirrored in the item's glossy surface (a screen, a case, the shrink-wrap of a box) — a reflection you can plainly make out. Report it on EVERY photo it shows in, as "major" whenever you can see it. NEVER on a "Screen Off" shot: that photo exists to show the dark screen, reflections and all. Soft even sheen with nothing mirrored in it is not a reflection.
  clutter — something in the frame that is not the item, its stand or the plain white backdrop: the edge of the lightbox or a wall, another item, a hand, a tool, mess. Report it on EVERY photo it shows in, and as "major" whenever you can plainly see it — a buyer's eye goes straight to it. Things that come WITH the item (its box, cables, accessories, everything included, the other items of a lot) are not clutter.
  stock_photo — a manufacturer or web image, not this unit.
  fake_or_edited — looks AI-generated, composited or heavily edited (a product floating unnaturally with no surface).
  personal_info — a customer's name, Apple ID, email or phone number on screen.
  wrong_item — plainly a different product from the title (another model or device). A colour that differs from the title is a title_note, not this.
  pair_not_together — on a speaker-pair sheet, a pair shot showing one speaker instead of both together.
  dirty_backdrop — the table, backdrop or stand the item is shot on is visibly dirty: scuff marks, scratches, stains, dust or debris on the surface around the item. Report it on EVERY photo it shows in, box and accessory photos included, and always as "major" — a dirty surface makes a clean item look grubby. Normal shadows, the stand's own reflections and the backdrop's gradient are not dirt.
- note: a few words on what the photo shows.

missing_shots: sheet shots with no photo covering them. Include a conditional shot ONLY when the listing shows it applies (Everything Included when items are included; Extra Accessories when extras are listed). Do not list Cosmetic Flaws or LCD Flaws here — that is main_flaw. Info shots (serial, model, CPU, RAM, storage) count as covered if ANY photo or screen shows the information legibly, including a BIOS or settings screen. A round item turned 90° looks the same — do not list its near-identical rotations as missing. BEFORE listing any shot as missing, look again at every photo you labelled Extra: it is often a shot you did not name (a top edge, a side of a box). For a box, deduce each side from what is printed on it. A serial/model closeup is not missing when the serial is hidden behind something that must be removed (a battery cover) — only when it is printed on the outside.

main_flaw: the one specific defect that is the main reason this unit is not in better condition — a crack, a dent, missing keys, a broken part — taken from notes marked [unit] (source "unit") or from the title (source "title"). General wear ("scuffs, scratches and wear", "minor marks") is NOT a main flaw. Ignore every sentence marked [standard] — it is the listing program's template, not about this unit. If there is no such specific defect: stated null, source "none", shown "not_applicable". A screenshot counts as showing a defect only a screen can show (Battery Health for a bad battery, a lock or iCloud screen). Otherwise: shown "yes" if a photo shows it clearly, "partly" if it is visible but not clearly, "no" if no photo shows it. Lesser flaws never need their own photo.

serial: "shown" if any photo shows the serial or model label legibly; "hidden_behind_cover" if it is on a part that must be removed to see it (under a battery cover, inside a compartment) and no photo opens it; otherwise "not_shown".

lead_ok: true if photo 1 is a clear shot that shows what the item is (it need not be the sheet's first shot).

suggested_order: every photo number once, in the order the sheet would put them — the item before its box, sheet shots in sheet order, extras last. If the current order is already fine, return it unchanged.

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
  const tag = (s: string) => ((standard.get(norm(s)) || 0) >= BOILERPLATE_MIN ? "[standard] " : "[unit] ") + s;
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
const BOX_SHEETS = new Set(["new-in-box", "new-open-box"]);
function gameSheetFor(l: Listing, sheet: Sheet | null, sheets: Sheet[]): Sheet | null {
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

// Longest run of photos already in sheet order, as a share of the photos that
// map to a sheet shot. Box and extras do not count either way.
function orderScore(photos: ReportT["photos"], sheet: Sheet): number {
  const ix = (label: string) => sheet.shots.findIndex(s => s.label.toLowerCase() === label.toLowerCase());
  const seq = photos.map(p => Math.min(...p.shots.map(ix).filter(i => i >= 0), Infinity))
    .filter(i => Number.isFinite(i));
  if (seq.length < 2) return 1;
  const tails: number[] = [];
  for (const v of seq) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] <= v) lo = m + 1; else hi = m; }
    tails[lo] = v;
  }
  return tails.length / seq.length;
}

const ISSUE_TEXT: Record<string, string> = {
  tilted: "is tilted", cut_off: "cuts off part of the item", too_much_empty_space: "has too much empty space",
  blurry: "is blurry", too_dark_or_glare: "is too dark or has glare", clutter: "has something besides the item and the white backdrop in frame",
  stock_photo: "is a stock photo", fake_or_edited: "looks fake or edited", personal_info: "shows personal information",
  wrong_item: "shows a different item", pair_not_together: "should show both speakers together",
};

type Finding = { code: string; text: string; photo?: number; shot?: string; shots?: string[]; photos?: number[] };

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


// ⚠️ A LISTING IS FLAGGED BY ITS SCORE, NOT BY HAVING A FINDING (Ethan,
// 2026-10-08): "I just don't need you to flag something that you believe is
// 90%+ effective with pictures … minor things like additional photos being off
// centre can be weighted less. Only major things and things missing that could
// impact a sale should be higher." Every listing starts at 100 and each finding
// costs what it costs a buyer; under PASS_BAR it goes to the queue. The
// findings are kept either way, so a passing listing still says what it lost.
//
// Weights were checked offline against the saved calibration runs before any
// paid run: the Micron RAM (one soft extra, 96) now passes as Ethan said, and
// every other call on the key held. ⚠️ Re-score scratch runs before changing
// a weight: HP 952XL sits at 88 (two box ends + a repeat), and a repeat at 3
// instead of 4 tips it to 89 — the wasted slot IS why Ethan flagged it.
//
// ⚠️ THE SCORE DECIDES WHETHER, NEVER WHAT (Ethan, 2026-10-08): "if a thing
// scores under 90 the user should make all required fixes, not just enough to
// bring them above 90 — so we probably shouldn't show the score." A flagged row
// carries EVERY finding, minor ones included, and the panel never shows the
// number. Do not trim a flagged listing's findings to the ones that cost most,
// and do not put the score on screen — a visible 88 invites fixing two points.
const PASS_BAR = 90;
const ALWAYS_FLAG = new Set(["retake", "not_square", "stock_photo", "fake_or_edited", "wrong_item",
  "personal_info", "flaw_not_shown", "no_photos", "pair_not_together"]);
function pictureScore(findings: Finding[], photoCount: number, price: number) {
  const n = Math.max(1, photoCount);
  const info = (s: string) => /(screen|serial|model|settings|battery|info|about|storage|software|cpu|ram|gpu)/i.test(s);
  let score = 100;
  const costs: { code: string; cost: number; photo?: number; shot?: string }[] = [];
  for (const f of findings) {
    const cost =
      ALWAYS_FLAG.has(f.code) ? 100
      // Missing: an info shot is the only place a buyer learns that fact; a box's
      // top or bottom is "not crucial to the sale"; a plain view sits between.
      : f.code === "missing_shot" ? (info(f.shot || "") ? 15 : /^(top|bottom) of box$/i.test(f.shot || "") ? 4 : 8)
      : f.code === "repeat" ? 4 * (f.photos?.length || 1)
      // Ethan's scale: the dearer the item, the more a grubby table costs it —
      // under $100 is 5, $100–250 is 10, over $250 is 15.
      // The same scale for anything else in frame (Ethan, the same day, on the
      // OVL Onyx's grey lightbox edge: "when there is something else that is not
      // the white background in the photo").
      : f.code === "dirty_backdrop" || f.code === "clutter" ? (price > 250 ? 15 : price >= 100 ? 10 : 5)
      // Reflections: "same concept as the dirty paper but 3, 6 and 9 points".
      : f.code === "reflection" ? (price > 250 ? 9 : price >= 100 ? 6 : 3)
      // The lead photo is what a buyer sees first. Any other photo's framing is
      // shared out by the photo count: one soft photo of fifteen costs little,
      // most of them off costs a lot.
      : f.code === "framing" || f.code === "lead" ? (f.photo === 1 ? 12 : 30 / n)
      : 8;   // blurry or glare on a sheet shot, anything new
    score -= cost;
    costs.push({ code: f.code, cost: Math.round(cost * 10) / 10, photo: f.photo, shot: f.shot });
  }
  return { score: Math.max(0, Math.round(score)), costs };
}

function decide(l: Listing, sheet: Sheet, r: ReportT, faults?: Map<number, string[]>) {
  const findings: Finding[] = [];

  // Rule 3 — measured, not asked.
  l.photos.forEach((p, i) => {
    if (p.width && p.height && Math.abs(p.width - p.height) / Math.max(p.width, p.height) > SQUARE_TOLERANCE) {
      findings.push({ code: "not_square", photo: i + 1,
                      text: `Photo ${i + 1} isn't square (${p.width}×${p.height}).` });
    }
  });

  // Rule 11 — a game is shot as close as a game can be; empty space around a
  // cartridge is the cartridge being small, not a framing mistake.
  const gameSheet = /^video-games/.test(sheet.slug);
  // Accessory, box and everything-included photos are staged, not measured:
  // the PS5's controllers sit angled on a stand on purpose, and round 2 of
  // calibration flagged three of them "tilted". Framing is judged only on the
  // photos of the item itself.
  const staged = (p: ReportT["photos"][number]) => p.shots.length > 0
    && p.shots.every(s => /^(box|everything included|extra accessories)/i.test(s.trim()));
  // ⚠️ NOT a bare "Extra" (removed after the OVL batch): it waved through the
  // iPad's cropped screen closeup, a photo of the item the model called Extra.
  // FRAMING IS JUDGED AGAINST THE SHEET'S EXAMPLE (OVL round, 2026-09-25).
  // Ethan's words were "not to our standard", and the standard is the example
  // photo. The "major only / longest side under half" gate from the WSP rounds
  // overcorrected: it let through the OVL iPhone SE's flat, tiny top/bottom
  // shots and the iPad's cropped and crooked ones, which he would flag. Only
  // "off" counts; "close" never does.
  const PROBLEM_TEXT: Record<string, string> = { crooked: "crooked", off_center: "not centred",
    too_small: "too small in the frame", cut_off: "cut off", wrong_angle: "taken from the wrong angle" };
  // ⚠️ A PHOTO THAT IS NOT A SHEET SHOT HAS NO EXAMPLE TO BE AT THE WRONG ANGLE
  // TO. OVL round 2 (2026-10-08): the RAM's three edge-on extras and a PS3's
  // upside-down extra were all "wrong angle"; Ethan passed every one.
  const extraOnly = (p: ReportT["photos"][number]) => p.shots.every(s => /^extra/i.test(s.trim()));
  // Crooked, off-centre and too small come from the FRAMING LOOK only (see
  // framingLook); the main review's word on them is not read. Cut off and wrong
  // angle stay here, because they need to know what the shot is FOR.
  // Without a framing look (the default — see FRAMING_LOOK), the review's own
  // word on them stands, exactly as pq-v10 graded.
  const ownLook = new Set(faults ? ["crooked", "off_center", "too_small"] : []);
  for (const p of r.photos) {
    if (staged(p)) continue;
    const said = p.framing !== "off" ? [] : p.framing_problems.filter(x => !ownLook.has(x)
      && !(x === "cut_off" && !p.whole_item) && !(x === "wrong_angle" && extraOnly(p)));
    const probs = [...(faults?.get(p.n) || []), ...said];
    if (probs.length) {
      findings.push({ code: "framing", photo: p.n,
        text: `Photo ${p.n} isn't to the guide's standard: ${probs.map(x => PROBLEM_TEXT[x] || x).join(", ")}.` });
    }
  }
  // ⚠️ A DIRTY TABLE IS ONE PROBLEM, NOT ONE PER PHOTO (Ethan, 2026-10-08, on
  // OVL Death Stranding 2's scuffed table: "this looks gross and would totally
  // be the reason that it might not sell"). It is the same table in every shot,
  // so it is costed once for the listing, by price — see pictureScore — and
  // named with every photo it shows in, staged ones included.
  const dirty = r.photos.filter(p => p.issues.some(it => it.type === "dirty_backdrop" && it.severity === "major")).map(p => p.n);
  if (dirty.length) {
    findings.push({ code: "dirty_backdrop", photos: dirty,
      text: `The table or backdrop is dirty in photo${dirty.length > 1 ? "s" : ""} ${dirty.join(", ")} — clean it, then retake.` });
  }
  // ⚠️ SO IS ANYTHING ELSE IN FRAME, and on box and accessory photos too (Ethan,
  // 2026-10-08, OVL Onyx Boox photo 9: the grey edge of the lightbox at the
  // left). It was "clutter", one line per photo at 4 points, skipped on staged
  // shots — but the lightbox edge is in the box photo as much as the item photo.
  // ⚠️ REFLECTIONS, THE SAME WAY (Ethan, 2026-10-08: "same concept as the dirty
  // paper but 3, 6 and 9 points"). The guide's own Screen Off shot is a dark
  // screen photographed FOR its reflections, so it never counts — decided here,
  // not trusted to the prompt alone.
  const screenOff = (p: ReportT["photos"][number]) => p.shots.some(x => /screen off/i.test(x));
  const reflected = r.photos.filter(p => !screenOff(p)
    && p.issues.some(it => it.type === "reflection" && it.severity === "major")).map(p => p.n);
  if (reflected.length) {
    findings.push({ code: "reflection", photos: reflected,
      text: `A reflection shows on the item in photo${reflected.length > 1 ? "s" : ""} ${reflected.join(", ")} — angle the item or the light, then retake.` });
  }
  const cluttered = r.photos.filter(p => p.issues.some(it => it.type === "clutter" && it.severity === "major")).map(p => p.n);
  if (cluttered.length) {
    findings.push({ code: "clutter", photos: cluttered,
      text: `Something besides the item and the white backdrop is in photo${cluttered.length > 1 ? "s" : ""} ${cluttered.join(", ")} — clear it out of the frame, then retake.` });
  }
  for (const p of r.photos) {
    for (const it of p.issues) {
      // Round 3: the same Canon lens face passed in round 2 and came back
      // "tilted" in round 3. The model's small calls wander run to run; only
      // the ones it will stand behind as major are allowed to cost a manager
      // a trip to the camera.
      if (it.severity !== "major") continue;
      const issue = it.type;
      // A soft EXTRA hides nothing the guide asks for — the sheet's own shots
      // carry the listing (Ethan, OVL Micron RAM 2026-10-08: the blurry edge-on
      // shots "are fine in this instance because the ram doesn't have anything
      // on the side to show"). A blurry SHEET shot still flags.
      if (issue === "blurry" && extraOnly(p)) continue;
      if (issue === "dirty_backdrop" || issue === "clutter" || issue === "reflection") continue;   // one finding for the listing, above
      findings.push({ code: issue, photo: p.n, text: `Photo ${p.n} ${ISSUE_TEXT[issue] || issue}.` });
    }
  }

  // ⚠️ ONLY REQUIRED SHOTS COUNT AS MISSING, and the code enforces it. The
  // prompt says not to list Cosmetic Flaws; on the first calibration run the
  // model listed it anyway on three of ten listings. Conditional shots are the
  // main-flaw check's business (rule 2) or a judgement nobody can make from the
  // outside, so they never flag as missing.
  // Two sheet shots that cannot apply to some listings, and the code knows it:
  //  - a SEALED game cannot be opened (Ethan, OVL Death Stranding 2: "one front
  //    and one back is totally fine");
  //  - a LOT with no box has no box to photograph (Ethan, his own Dell WD15
  //    lot: the sheet's box shots were only an example of showing multiples).
  const sealed = /^new\b/i.test(l.title) || /\bsealed\b/i.test(l.cosmetic);
  const hasBox = /\bbox\b/i.test(l.included);
  const required = sheet.shots.filter(s => !s.cond).map(s => s.label.toLowerCase())
    .filter(label => !(sealed && gameSheet && /opened case/.test(label)))
    .filter(label => !(sheet.slug === "item-lots" && !hasBox && /\bbox\b/.test(label)))
    // Rule 20: a serial under a battery cover is not worth taking the cover off
    // for (Ethan, OVL Xbox controller). Asked as its own field, because the
    // instruction buried in the prompt was ignored two runs in a row.
    .filter(label => !(r.serial === "hidden_behind_cover" && /serial|model info/.test(label)));
  const missingRequired = [...new Set(r.missing_shots.map(m => m.trim()))]
    .filter(m => required.includes(m.toLowerCase()));
  // Rule 14. 40%, not half: Ethan's broken Acer was 6 of 14 missing and he
  // called it "please fill in all of the missing picture guide photos".
  // …and at least three shots. With the box shots set aside, the Dell lot's
  // sheet needed only two, and one missing (a back view) read as 50%.
  const retake = required.length > 0 && missingRequired.length >= 3
    && missingRequired.length / required.length >= RETAKE_SHARE;

  // One missing PLAIN VIEW is tolerated (Ethan passed the PS5 without its
  // bottom, the AirPods without a back). An info shot — a screen, a setting, a
  // serial — never is, because it is the only place the buyer learns that fact.
  const plainView = (m: string) => /\b(front|back|side|top|bottom|corner)\b/i.test(m)
    && !/(screen|serial|model|settings|battery|info|port)/i.test(m);
  // One settings screen is enough when another settings screen is there
  // (Ethan passed the OVL Galaxy with About Phone but no Software Information,
  // the same call as deleting iPhone "Settings Page 2"). A different KIND of
  // info shot — Battery Health, Screen Off, a serial — still counts.
  const settingsShot = (m: string) => /(about|settings|software|storage information)/i.test(m);
  const haveSettings = r.photos.some(p => p.shots.some(settingsShot));
  // A serial closeup missing on its own never flags (Ethan, OVL Xbox One
  // controller: "not super important to have"). The model cannot be relied on
  // to know which serials hide under a battery cover — it answered "not shown"
  // for the Xbox three runs running — so this is decided here instead.
  const serialShot = (m: string) => /serial|model info/i.test(m);
  // ⚠️ A BOX'S TOP AND BOTTOM ARE OPTIONAL — UNLESS PHOTOS WERE WASTED (Ethan,
  // OVL HP 902XL / 952XL ink, 2026-10-08). "Where the top and bottom aren't
  // crucial to the sale, it's alright not to have it" — but both listings spent
  // photos 5 and 6 repeating 1 and 2, which left four real photos, so "they
  // should've taken top and bottom." A repeat is a slot that was there to use.
  const repeats = r.photos.filter(p => p.repeats != null && p.repeats >= 1 && p.repeats < p.n);
  const boxEnd = (m: string) => BOX_SHEETS.has(sheet.slug) && /^(top|bottom) of box$/i.test(m);
  const missing = repeats.length ? missingRequired : missingRequired.filter(m => !boxEnd(m));
  const counted = missing.filter(m => !plainView(m) && !serialShot(m) && !(haveSettings && settingsShot(m))).length
    + Math.max(0, missing.filter(plainView).length - 1)
    + Math.max(0, missing.filter(m => haveSettings && settingsShot(m)).length - 1)
    + (missing.some(serialShot) && missing.length > 1 ? 1 : 0);
  if (!retake && counted > 0) {
    // `shot` is the guide's own label, so the panel can mark that slot on the
    // guide strip instead of making a manager match a sentence to a picture.
    for (const m of missing) findings.push({ code: "missing_shot", shot: m, text: `Missing: ${m}.` });
    // Say what to change it TO: the repeat's spot is where the missing shot goes.
    if (repeats.length) {
      const ns = repeats.map(p => p.n), of = repeats.map(p => p.repeats);
      const many = ns.length > 1;
      findings.push({ code: "repeat", photos: ns,
        text: `Photo${many ? "s" : ""} ${ns.join(" and ")} repeat${many ? "" : "s"} photo${of.length > 1 ? "s" : ""} ${of.join(" and ")} — `
          + `use ${many ? "those spots" : "that spot"} for ${missing.join(", ")}.` });
    }
  }
  // Rule 2 — and only a flaw that is about THIS unit. Standard template wording
  // was the other half of the first run's false flags (PS5, Epson).
  // And only real DAMAGE. The prompt says general wear is not a main flaw; in
  // round 2 the model still offered "hinges have scuffs and scratches" on the
  // AirPods Max, which Ethan passed. Wear words alone never qualify.
  const damage = /\b(crack|cracked|dent|dented|broken|break|missing|chip|chipped|bent|hole|burn|burned|stain|stained|shatter|shattered|peel|peeling|torn|tear|damage|damaged|dead pixel|spot)/i;
  if (r.main_flaw.shown === "no" && r.main_flaw.stated && r.main_flaw.source !== "none"
      && damage.test(r.main_flaw.stated)) {
    findings.push({ code: "flaw_not_shown", text: `The main flaw isn't shown: ${r.main_flaw.stated}.` });
  }

  // Rule 7 — a reorder for the BIG, obvious moves only. Round 3 is why: the
  // model labelled the PS5's front and side differently from round 2 and its
  // order score swung 0.71 → 0.43 on photos nobody had touched. Everything
  // Ethan actually asked to reorder was coarse — Everything Included buried at
  // #6 (Surface), box photos ahead of the item (Pyle) — and he passed the PS5's
  // view order. So the score is reported, and never decides.
  const score = orderScore(r.photos, sheet);
  const n = l.photos.length;
  const isBox = (p: ReportT["photos"][number]) => p.shots.some(s => /^box/i.test(s.trim()));
  const isEI = (p: ReportT["photos"][number]) => p.shots.some(s => /^everything included/i.test(s.trim()));
  const isItem = (p: ReportT["photos"][number]) => !isBox(p) && p.shots.some(s => !/^(box|extra|everything included)/i.test(s.trim()));
  const byN = [...r.photos].sort((a, b) => a.n - b.n);
  const firstBox = byN.findIndex(isBox), firstItem = byN.findIndex(isItem), firstEI = byN.findIndex(isEI);
  const boxFirst = firstBox >= 0 && firstItem >= 0 && firstBox < firstItem;
  const eiLate = firstEI > 2;
  const order = r.suggested_order.filter((x, i, a) => x >= 1 && x <= n && a.indexOf(x) === i);
  const validPerm = order.length === n;
  const changed = validPerm && order.some((x, i) => x !== i + 1);
  const reorder = changed && (boxFirst || eiLate || !r.lead_ok)
    ? { current: l.photos.map((_, i) => i + 1), suggested: order, score: Math.round(score * 100) / 100,
        why: [boxFirst && "box photos come before the item", eiLate && "Everything Included is not in the first three", !r.lead_ok && "the first photo does not show the item"].filter(Boolean) }
    : null;
  if (!r.lead_ok && !reorder) findings.push({ code: "lead", photo: 1, text: "Photo 1 doesn't show what the item is." });

  if (retake) {
    findings.unshift({ code: "retake", shots: missingRequired,
      text: `Retake following the guide — ${missingRequired.length} of ${required.length} required shots are missing: ${missingRequired.join(", ")}.` });
  }
  const pic = pictureScore(findings, l.photos.length, l.price);
  const verdict = retake ? "retake" : pic.score < PASS_BAR ? "fix" : reorder ? "reorder" : "pass";
  return { verdict, findings, reorder, orderScore: Math.round(score * 100) / 100, pictureScore: pic.score, costs: pic.costs };
}

// --- the second look ----------------------------------------------------------
//
// ⚠️ A FLAG HAS TO BE SEEN TWICE (Ethan approved, 2026-09-25). Three calibration
// runs in a row scored 17–18 of 21, and the misses were DIFFERENT listings each
// time: the AirPods' cushions "missing" one run, the Ray-Ban's box sides "wrong
// angle" the next — photos nobody had touched. Every rule was right; the model's
// small visual calls wander. So a listing the first look passes is done, and a
// listing it flags gets a second, independent look. Only what BOTH looks report
// survives into the verdict — noise rarely lands on the same photo twice, a real
// problem does. Roughly half of listings are looked at twice: ~8¢ → ~12¢.
//
// Merged at the REPORT level, not the findings level, so decide() runs its rules
// once on facts both looks agree on — a retake needs 3+ shots BOTH called
// missing, not one look's retake beside the other's single finding. The
// leniency runs one way: anything that would pass a listing is taken from
// either look (lead photo fine, serial hidden, a shot label that covers a shot).
function agree(a: ReportT, b: ReportT): ReportT {
  const photos = a.photos.map(p => {
    const q = b.photos.find(x => x.n === p.n);
    const probs = q ? p.framing_problems.filter(x => q.framing_problems.includes(x)) : [];
    const off = !!q && p.framing === "off" && q.framing === "off" && probs.length > 0;
    return {
      ...p,
      shots: [...new Set([...p.shots, ...(q?.shots || [])])],
      // A repeat stands only when both looks name the same earlier photo.
      repeats: q && p.repeats != null && p.repeats === q.repeats ? p.repeats : null,
      whole_item: p.whole_item && !!q?.whole_item,
      framing: off ? "off" as const : "close" as const,
      framing_problems: off ? probs : [],
      issues: p.issues.filter(it => it.severity === "major"
        && !!q?.issues.some(x => x.type === it.type && x.severity === "major")),
    };
  });
  const bMissing = new Set(b.missing_shots.map(m => m.trim().toLowerCase()));
  const bothNo = a.main_flaw.shown === "no" && b.main_flaw.shown === "no";
  return {
    ...a,
    photos,
    missing_shots: a.missing_shots.filter(m => bMissing.has(m.trim().toLowerCase())),
    main_flaw: bothNo ? a.main_flaw
      : { ...a.main_flaw, shown: a.main_flaw.shown === "no" ? b.main_flaw.shown : a.main_flaw.shown },
    serial: a.serial === "hidden_behind_cover" || b.serial === "hidden_behind_cover" ? "hidden_behind_cover"
      : a.serial === "shown" || b.serial === "shown" ? "shown" : "not_shown",
    lead_ok: a.lead_ok || b.lead_ok,
    title_notes: a.title_notes,
  };
}

// --- the stamp ---------------------------------------------------------------

async function stampFor(l: Listing, sheet: Sheet | null) {
  const basis = JSON.stringify({ RECIPE, sheet: sheet ? [sheet.slug, sheet.updated] : null,
    photos: l.photos.map(p => p.src.split("?")[0]), c: [l.condition, l.cosmetic, l.included, l.notIncluded, l.title] });
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  return RECIPE + ":" + Array.from(new Uint8Array(d)).slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- the sweep ----------------------------------------------------------------

async function runReviews(store: string, ids: string[], model: string, effort: string, save: boolean,
                          withFraming = false) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set on this project");
  const client = new Anthropic({ apiKey });
  const { shop, token } = await shopFor(store);
  const [listings, sheets, standard] = await Promise.all([
    fetchListings(shop, token, ids), loadSheets(), boilerplateFor(shop, token)]);
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
      if (better && gameSheetFor(l, better, sheets) === better) {
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
      let d = decide(l, sheet, report, faults);
      const firstLook = { verdict: d.verdict, findings: d.findings.map(f => f.text) };
      let secondLook: typeof firstLook | null = null;
      // The main review's own second look is for ITS findings; a listing whose
      // only problem is framing has already been looked at twice above.
      if (decide(l, sheet, report).verdict !== "pass") {
        const again = await review(client, model, effort, l, sheet, standard, others(sheet));
        const extra = (again.usage?.input_tokens || 0) + (again.usage?.cache_read_input_tokens || 0) + (again.usage?.cache_creation_input_tokens || 0);
        inTok += extra; tin += extra; tout += again.usage?.output_tokens || 0; outTok += again.usage?.output_tokens || 0;
        const d2 = decide(l, sheet, again.report, faults);
        secondLook = { verdict: d2.verdict, findings: d2.findings.map(f => f.text) };
        const d1 = d;
        report = agree(report, again.report);
        d = decide(l, sheet, report, faults);
        // A reorder stands only if each look, on its own, asked for one: the
        // Synology's "Everything Included is not in the first three" came from
        // one look's labels and the next look's labels disagreed.
        if (d.reorder && !(d1.reorder && d2.reorder)) {
          d = { ...d, reorder: null };
          if (!report.lead_ok) d.findings.push({ code: "lead", photo: 1, text: "Photo 1 doesn't show what the item is." });
          const pic = pictureScore(d.findings, l.photos.length, l.price);
          d = { ...d, pictureScore: pic.score, costs: pic.costs };
          d.verdict = d.findings.some(f => f.code === "retake") ? "retake" : pic.score < PASS_BAR ? "fix" : "pass";
        }
      }
      return { ...base, verdict: d.verdict, findings: d.findings, reorder: d.reorder,
               title_notes: report.title_notes, sheet_slug: sheet.slug, sheet_name: sheet.name,
               stamp: await stampFor(l, sheet),
               report: { ...report, orderScore: d.orderScore, pictureScore: d.pictureScore, costs: d.costs,
                 sheetPick: pick, reSheeted: !!better,
                 looks: secondLook ? 2 : 1, firstLook, secondLook,
                 ...(withFraming ? { framing: { first: framing1, second: framing2, faults: Object.fromEntries(faults || []) } } : {}),
                 notesAsSent: sentences(l.cosmetic).map(s => ((standard.get(norm(s)) || 0) >= BOILERPLATE_MIN ? "[standard] " : "[unit] ") + s),
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
    const good = out.filter(r => r.verdict !== "error");
    if (good.length) {
      await sb("picture_quality_reviews", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(good.map(r => ({ ...r, status: "open", decided_by: null, decided_at: null,
                                             decided_note: null, reviewed_at: new Date().toISOString() }))),
      });
    }
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
    + `&select=product_id,sku,title,sheet_slug,sheet_name,verdict,findings,reorder,title_notes,photo_count,reviewed_at,stamp`
    + `&order=reviewed_at.desc&limit=500`);
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
      findings: r.findings || [], reorder: r.reorder, titleNotes: r.title_notes || [],
      reviewedAt: r.reviewed_at,
      stale: r.stamp !== await stampFor(l, sheet),
      // Which kind: the LISTING moved, or the check itself was improved since.
      // Telling a manager "your photos changed" when nobody touched them is the
      // sort of wrong that makes the rest of the row unbelievable.
      staleWhy: String(r.stamp || "").split(":")[0] !== RECIPE ? "recipe" : "listing",
      // A name, or null — the panel says "Unknown" for null, never the raw tag.
      lister: listerFrom(l.tags, listerIx, store)?.name || null,
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
const TRAIN_PROBLEMS = ["off_center", "crooked", "too_small", "blurry", "cut_off", "dirty_backdrop", "clutter", "reflection"];
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

// decided_note is "dismissed: why" or "reorder denied: why" — the answer, then
// the person's words. Split back apart for the screen and the ask.
function splitNote(s: unknown) {
  const t = String(s || "");
  const m = /^(dismissed|reorder denied)(?::\s*([\s\S]*))?$/.exec(t);
  return m ? { as: m[1] === "reorder denied" ? "reorder" : "fine", note: (m[2] || "").trim() }
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
  const kindOf = (r: any) => r.as === "reorder" ? "reorder"
    : String((r.findings || [])[0]?.code || r.verdict || "other");
  const groups: Record<string, any[]> = {};
  for (const r of open) (groups[kindOf(r)] ||= []).push(r);
  const KIND: Record<string, string> = {
    reorder: "Suggested a new photo order", retake: "Said to retake following the guide",
    missing_shot: "Said a guide shot was missing", not_square: "Said a photo is not square",
    framing: "Said a photo is not to the guide's standard", flaw_not_shown: "Said the main flaw is not shown",
    blurry: "Said a photo is blurry", fake_or_edited: "Said a photo looks fake or edited",
    stock_photo: "Said a photo is a stock photo", lead: "Said photo 1 does not show the item",
    repeat: "Said photos repeat each other",
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
    + `&select=verdict,status,reorder,stamp,sheet_slug&limit=1`))?.[0];
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
  await sb(`picture_quality_reviews?store_code=eq.${store}&product_id=eq.${encodeURIComponent(productId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "applied", decided_by: scope.name, decided_at: new Date().toISOString(),
                           decided_note: "reorder approved", stamp: await stampFor(reordered, sheet) }),
  });
  return json({ ok: true, applied: productId, order });
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
  if (action === "dismiss" || action === "deny-reorder") {
    const note = String(body.reason || "").trim().slice(0, 300);
    // Required (Ethan, 2026-09-30): a dismissal with no why gives nothing to fix.
    if (!note) return json({ error: "reason required", detail: "Say why the photos are fine — that note is how a wrong rule gets fixed." }, 400);
    await sb(`picture_quality_reviews?${key}&status=eq.open`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "dismissed", decided_by: scope.name, decided_at: new Date().toISOString(),
        decided_note: (action === "deny-reorder" ? "reorder denied" : "dismissed") + (note ? `: ${note}` : "") }),
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

    if (req.method === "POST" || view === "review" || view === "counts" || view === "feedback" || view === "train") {
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
      if (view === "train") return json(await trainView(scope, (url.searchParams.get("store") || "").toUpperCase(),
        Math.max(0, Number(url.searchParams.get("skip") || 0))));
      return json(await reviewView(scope, (url.searchParams.get("store") || "").toUpperCase()));
    }

    if (!secretOk(url)) return json({ error: "unauthorized" }, 401);
    const store = (url.searchParams.get("store") || "").toUpperCase();
    if (!STORES.includes(store)) return json({ error: "pass ?store=OVL|LEE|WSP|MPL|BAL" }, 400);
    const model = url.searchParams.get("model") || DEFAULT_MODEL;
    if (!PRICES[model]) return json({ error: `unknown model ${model}` }, 400);
    const effort = url.searchParams.get("effort") || DEFAULT_EFFORT;

    // ?sweep=N — grade up to N listings that need it, and SAVE. Run it again to
    // walk further; `remaining` says how far there is to go.
    const sweep = Number(url.searchParams.get("sweep") || 0);
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
    if (!ids.length) return json({ error: "pass &ids=<product ids>, or &sweep=N" }, 400);
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
