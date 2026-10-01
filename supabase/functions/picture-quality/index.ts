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
//   THE PANEL, x-user-pin (Phase 2 builds the screen):
//     GET ?view=review&store=WSP        the open queue
//     GET ?view=counts                  per-store open totals
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
const DEFAULT_EFFORT = "low";
const PRICES: Record<string, [number, number]> = {   // $ per million in / out
  "claude-sonnet-5": [2, 10],
  "claude-opus-5": [5, 25],
};

// ⚠️ BUMP WHEN WHAT WE ASK CHANGES. It is part of every stamp, so a new recipe
// re-grades everything instead of leaving old answers given less to look at.
const RECIPE = "pq-v4";   // v4 2026-09-25: after calibration run 3 (8/10)

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
  id: string; title: string; sku: string; collections: string[];
  condition: string; cosmetic: string; functional: string; included: string; notIncluded: string;
  photos: { url: string; width: number; height: number; src: string }[];
};

async function fetchListings(shop: string, token: string, ids: string[]): Promise<Listing[]> {
  const q = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product {
      id title
      variants(first: 1) { nodes { sku } }
      collections(first: 12) { nodes { handle } }
      condition: metafield(namespace: "custom", key: "condition") { value }
      cosmetic: metafield(namespace: "custom", key: "cosmetic_condition") { value }
      functional: metafield(namespace: "custom", key: "functionality_condition") { value }
      included: metafield(namespace: "custom", key: "whats_include") { value }
      notIncluded: metafield(namespace: "custom", key: "not_included") { value }
      media(first: 40) { nodes { ... on MediaImage { image {
        url
        sized: url(transform: { maxWidth: ${PHOTO_PX}, maxHeight: ${PHOTO_PX} })
        width height } } } }
  } } }`;
  const data = await gql(shop, token, q, { ids });
  return (data.nodes || []).filter(Boolean).map((p: any) => ({
    id: p.id, title: p.title, sku: p.variants?.nodes?.[0]?.sku || "",
    collections: (p.collections?.nodes || []).map((c: any) => c.handle),
    condition: parseList(p.condition?.value),
    cosmetic: strip(p.cosmetic?.value), functional: strip(p.functional?.value),
    included: parseList(p.included?.value), notIncluded: parseList(p.notIncluded?.value),
    photos: (p.media?.nodes || []).filter((n: any) => n?.image).map((n: any) => ({
      url: n.image.sized || n.image.url, src: n.image.url,
      width: Number(n.image.width || 0), height: Number(n.image.height || 0),
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
- An item with no sheet of its own uses "small-medium-misc-items".
- If you cannot tell what the item is, return null with confidence "low".`;

const PhotoReport = z.object({
  n: z.number().int(),
  shots: z.array(z.string()),
  whole_item: z.boolean(),
  issues: z.array(z.object({
    type: z.enum([
      "tilted", "cut_off", "too_much_empty_space", "blurry", "too_dark_or_glare", "clutter",
      "stock_photo", "fake_or_edited", "personal_info", "wrong_item", "pair_not_together",
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
- issues, only when clearly true, each with a severity. "major" means a buyer would notice and it hurts the listing; "minor" means you can see it but it does not matter. Only major issues are acted on, so be honest about which is which:
  tilted — a straight-on shot of the whole item clearly off level (about 10 degrees or more) or at an angle it should not be. Never for a round item photographed face-on (a lens, a speaker cone): rotation does not exist for it.
  cut_off — a whole-item shot where part of the item is outside the frame.
  too_much_empty_space — ONLY when the item is tiny in the frame: its LONGEST side spans well under half the photo, where the sheet's example fills it. A tall, thin or small item naturally leaves space on its short sides; that is not this issue.
  blurry, too_dark_or_glare — the detail the shot exists for cannot be made out. A "Screen Off" shot is meant to be a dark screen with reflections — never report it.
  clutter — another object, a hand, or mess in frame (not lots, accessories or everything-included shots).
  stock_photo — a manufacturer or web image, not this unit.
  fake_or_edited — looks AI-generated, composited or heavily edited (a product floating unnaturally with no surface).
  personal_info — a customer's name, Apple ID, email or phone number on screen.
  wrong_item — plainly a different product from the title (another model or device). A colour that differs from the title is a title_note, not this.
  pair_not_together — on a speaker-pair sheet, a pair shot showing one speaker instead of both together.
- note: a few words on what the photo shows.

missing_shots: sheet shots with no photo covering them. Include a conditional shot ONLY when the listing shows it applies (Everything Included when items are included; Extra Accessories when extras are listed). Do not list Cosmetic Flaws or LCD Flaws here — that is main_flaw. Info shots (serial, model, CPU, RAM, storage) count as covered if ANY photo or screen shows the information legibly, including a BIOS or settings screen. A round item turned 90° looks the same — do not list its near-identical rotations as missing.

main_flaw: the one specific defect that is the main reason this unit is not in better condition — a crack, a dent, missing keys, a broken part — taken from notes marked [unit] (source "unit") or from the title (source "title"). General wear ("scuffs, scratches and wear", "minor marks") is NOT a main flaw. Ignore every sentence marked [standard] — it is the listing program's template, not about this unit. If there is no such specific defect: stated null, source "none", shown "not_applicable". Otherwise: shown "yes" if a photo shows it clearly, "partly" if it is visible but not clearly, "no" if no photo shows it. Lesser flaws never need their own photo.

lead_ok: true if photo 1 is a clear shot that shows what the item is (it need not be the sheet's first shot).

suggested_order: every photo number once, in the order the sheet would put them — the item before its box, sheet shots in sheet order, extras last. If the current order is already fine, return it unchanged.

title_notes: only where the photos show the title is wrong or incomplete — a model number on a box or label that differs from the title, a feature the photos contradict, or "Cartridge Only"/"Disc Only" missing from a game with no case. Empty if none.

summary: one plain sentence a store manager would understand.`;

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

async function pickSheet(client: Anthropic, model: string, l: Listing, sheets: Sheet[]) {
  const res = await client.messages.parse({
    model, max_tokens: 1500, system: PICK_SYSTEM,
    messages: [{ role: "user", content:
      "SHEETS:\n" + sheets.map(s => `${s.slug} — ${s.name}${s.group ? ` (${s.group})` : ""}`).join("\n") +
      `\n\nLISTING:\nTITLE: ${l.title}\nCOLLECTIONS: ${l.collections.join(", ")}\nCONDITION: ${l.condition}` +
      `\nINCLUDED: ${l.included}\nNOT INCLUDED: ${l.notIncluded}` }],
    output_config: { effort: "low", format: zodOutputFormat(SheetPick) },
  } as any);
  return { pick: res.parsed_output as z.infer<typeof SheetPick> | null, usage: res.usage };
}

async function review(client: Anthropic, model: string, effort: string, l: Listing, sheet: Sheet,
                      standard: Map<string, number>, otherSheets: string) {
  // The sheet and its examples go first and are cached, so a store's fifty
  // iPhones pay for the iPhone examples once.
  const sheetBlocks: any[] = [{ type: "text", text: sheetText(sheet) + "\n\nExample photos from the sheet:" }];
  for (const [i, s] of sheet.shots.entries()) {
    if (!s.img) continue;
    sheetBlocks.push({ type: "text", text: `Example for shot ${i + 1}: ${s.label}` });
    sheetBlocks.push(await imageBlock(guideUrl(s.img)));
  }
  sheetBlocks[sheetBlocks.length - 1].cache_control = { type: "ephemeral" };

  const listingBlocks: any[] = [{ type: "text", text:
    "OTHER SHEETS (only if this one is clearly wrong for the item): " + otherSheets +
    "\n\nTHE LISTING:\n" + listingText(l, standard) + "\n\nIts photos, in listing order:" }];
  const photoBlocks = await Promise.all(l.photos.map(p => imageBlock(p.url)));
  photoBlocks.forEach((b, i) => {
    listingBlocks.push({ type: "text", text: `Photo ${i + 1}` });
    listingBlocks.push(b);
  });

  const res = await client.messages.parse({
    model, max_tokens: 8000, system: REVIEW_SYSTEM,
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
  blurry: "is blurry", too_dark_or_glare: "is too dark or has glare", clutter: "has clutter in frame",
  stock_photo: "is a stock photo", fake_or_edited: "looks fake or edited", personal_info: "shows personal information",
  wrong_item: "shows a different item", pair_not_together: "should show both speakers together",
};

type Finding = { code: string; text: string; photo?: number };

function decide(l: Listing, sheet: Sheet, r: ReportT) {
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
    && p.shots.every(s => /^(extra|box|everything included|extra accessories)/i.test(s.trim()));
  const FRAMING = new Set(["tilted", "cut_off", "too_much_empty_space", "clutter"]);
  for (const p of r.photos) {
    for (const it of p.issues) {
      // Round 3: the same Canon lens face passed in round 2 and came back
      // "tilted" in round 3. The model's small calls wander run to run; only
      // the ones it will stand behind as major are allowed to cost a manager
      // a trip to the camera.
      if (it.severity !== "major") continue;
      const issue = it.type;
      if (issue === "cut_off" && !p.whole_item) continue;   // rule 8
      if (issue === "too_much_empty_space" && gameSheet) continue;
      if (FRAMING.has(issue) && staged(p)) continue;
      findings.push({ code: issue, photo: p.n, text: `Photo ${p.n} ${ISSUE_TEXT[issue] || issue}.` });
    }
  }

  // ⚠️ ONLY REQUIRED SHOTS COUNT AS MISSING, and the code enforces it. The
  // prompt says not to list Cosmetic Flaws; on the first calibration run the
  // model listed it anyway on three of ten listings. Conditional shots are the
  // main-flaw check's business (rule 2) or a judgement nobody can make from the
  // outside, so they never flag as missing.
  const required = sheet.shots.filter(s => !s.cond).map(s => s.label.toLowerCase());
  const missingRequired = [...new Set(r.missing_shots.map(m => m.trim()))]
    .filter(m => required.includes(m.toLowerCase()));
  // Rule 14. 40%, not half: Ethan's broken Acer was 6 of 14 missing and he
  // called it "please fill in all of the missing picture guide photos".
  const retake = required.length > 0 && missingRequired.length / required.length >= RETAKE_SHARE;

  // One missing PLAIN VIEW is tolerated (Ethan passed the PS5 without its
  // bottom, the AirPods without a back). An info shot — a screen, a setting, a
  // serial — never is, because it is the only place the buyer learns that fact.
  const plainView = (m: string) => /\b(front|back|side|top|bottom|corner)\b/i.test(m)
    && !/(screen|serial|model|settings|battery|info|port)/i.test(m);
  const counted = missingRequired.filter(m => !plainView(m)).length
    + Math.max(0, missingRequired.filter(plainView).length - 1);
  if (!retake && counted > 0) {
    for (const m of missingRequired) findings.push({ code: "missing_shot", text: `Missing: ${m}.` });
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

  const verdict = retake ? "retake" : findings.length ? "fix" : reorder ? "reorder" : "pass";
  if (retake) {
    findings.unshift({ code: "retake",
      text: `Retake following the guide — ${missingRequired.length} of ${required.length} required shots are missing: ${missingRequired.join(", ")}.` });
  }
  return { verdict, findings, reorder, orderScore: Math.round(score * 100) / 100 };
}

// --- the stamp ---------------------------------------------------------------

async function stampFor(l: Listing, sheet: Sheet | null) {
  const basis = JSON.stringify({ RECIPE, sheet: sheet ? [sheet.slug, sheet.updated] : null,
    photos: l.photos.map(p => p.src.split("?")[0]), c: [l.condition, l.cosmetic, l.included, l.notIncluded, l.title] });
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  return RECIPE + ":" + Array.from(new Uint8Array(d)).slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- the sweep ----------------------------------------------------------------

async function runReviews(store: string, ids: string[], model: string, effort: string, save: boolean) {
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
      if (!sheet) {
        return { ...base, verdict: "no_sheet", stamp: await stampFor(l, null), sheet_slug: null, sheet_name: null,
                 findings: [{ code: "no_sheet", text: `Not graded — no confident sheet match (${pick?.why || "no answer"}).` }] };
      }
      const others = (s: Sheet) => sheets.filter(x => x.slug !== s.slug).map(x => `${x.slug} (${x.name})`).join(", ");
      let { report, usage } = await review(client, model, effort, l, sheet, standard, others(sheet));
      let inTok = (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0);
      tin += inTok; tout += usage?.output_tokens || 0;
      // The text alone cannot always tell (the Pyle title says "Speaker"; the
      // photos show a pair). One re-grade on the sheet the photos point to.
      const better = !report.sheet_fits && report.better_sheet ? sheets.find(s => s.slug === report.better_sheet) : null;
      if (better) {
        sheet = better;
        ({ report, usage } = await review(client, model, effort, l, sheet, standard, others(sheet)));
        const extra = (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0);
        inTok += extra; tin += extra; tout += usage?.output_tokens || 0;
      }
      const d = decide(l, sheet, report);
      return { ...base, verdict: d.verdict, findings: d.findings, reorder: d.reorder,
               title_notes: report.title_notes, sheet_slug: sheet.slug, sheet_name: sheet.name,
               stamp: await stampFor(l, sheet),
               report: { ...report, orderScore: d.orderScore, sheetPick: pick, reSheeted: !!better,
                 notesAsSent: sentences(l.cosmetic).map(s => ((standard.get(norm(s)) || 0) >= BOILERPLATE_MIN ? "[standard] " : "[unit] ") + s),
                 cache: {
                 read: usage?.cache_read_input_tokens || 0, wrote: usage?.cache_creation_input_tokens || 0 } },
               input_tokens: inTok, output_tokens: usage?.output_tokens || 0,
               cost_usd: Math.round((inTok / 1e6 * price[0] + (usage?.output_tokens || 0) / 1e6 * price[1]) * 1e5) / 1e5 };
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

// --- routing -------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const view = url.searchParams.get("view") || "";

    if (view === "review" || view === "counts") {
      const scope = await scopeFor(req.headers.get("x-user-pin") || "");
      if (!scope) return json({ error: "unauthorized", detail: "no matching user, or Picture Quality is not switched on for you" }, 401);
      if (view === "counts") {
        const open = await rows(`picture_quality_reviews?status=eq.open&verdict=in.(retake,fix,reorder)`
          + `&store_code=in.(${scope.stores.join(",")})&select=store_code,verdict`);
        const counts: Record<string, Record<string, number>> = {};
        for (const r of open) (counts[r.store_code] ||= {})[r.verdict] = ((counts[r.store_code] || {})[r.verdict] || 0) + 1;
        return json({ scope, counts });
      }
      const asked = (url.searchParams.get("store") || "").toUpperCase();
      const store = scope.stores.includes(asked) ? asked : scope.stores[0];
      const queue = await rows(`picture_quality_reviews?store_code=eq.${store}&status=eq.open`
        + `&verdict=in.(retake,fix,reorder)&select=product_id,sku,title,sheet_name,verdict,findings,reorder,title_notes,photo_count,reviewed_at`
        + `&order=verdict.asc,reviewed_at.desc`);
      return json({ scope, store, queue });
    }

    if (!secretOk(url)) return json({ error: "unauthorized" }, 401);
    const store = (url.searchParams.get("store") || "").toUpperCase();
    if (!STORES.includes(store)) return json({ error: "pass ?store=OVL|LEE|WSP|MPL|BAL" }, 400);
    const ids = (url.searchParams.get("ids") || "").split(",").map(s => s.trim()).filter(Boolean)
      .map(s => s.startsWith("gid://") ? s : `gid://shopify/Product/${s}`);
    if (!ids.length) return json({ error: "pass &ids=<product ids> (Phase 1 reviews named listings only)" }, 400);
    if (ids.length > MAX_IDS) return json({ error: `at most ${MAX_IDS} ids per call — the edge wall is 150s` }, 400);
    const model = url.searchParams.get("model") || DEFAULT_MODEL;
    if (!PRICES[model]) return json({ error: `unknown model ${model}` }, 400);
    const effort = url.searchParams.get("effort") || DEFAULT_EFFORT;
    return json(await runReviews(store, ids, model, effort, url.searchParams.get("save") === "1"));
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
