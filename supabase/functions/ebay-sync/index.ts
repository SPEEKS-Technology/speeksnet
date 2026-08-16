// ============================================================================
// ebay-sync — Shopify product -> eBay listing.
//
//   ?store=OVL&preview=1[&q=cable]   list candidate products, change nothing
//   ?store=OVL&sku=ABC123&dry=1      show exactly what would be sent to eBay
//   ?store=OVL&sku=ABC123            publish for real
//
// The publish is three eBay calls, in this order and not negotiable:
//   1. PUT  /sell/inventory/v1/inventory_item/{sku}   the thing itself
//   2. POST /sell/inventory/v1/offer                  price, category, policies
//   3. POST /sell/inventory/v1/offer/{id}/publish     makes it live
//
// Step 3 is where required item aspects bite. eBay rejects the publish, not the
// offer, when a category's mandatory aspects are missing — so a listing can
// look fine right up to the last call. That error text is the most valuable
// output of this function and is stored on ebay_listings.last_error rather than
// being discarded.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";

const MARKETPLACE = "EBAY_US";
const CURRENCY = "USD";
// EBAY_US category tree. Constant per marketplace; worth fetching once if we
// ever list outside the US.
const CATEGORY_TREE_ID = "0";

// eBay hard-truncates nothing — it rejects. 80 characters, and the error does
// not say which field was too long.
const EBAY_TITLE_MAX = 80;
const EBAY_MAX_IMAGES = 24;
// The inventory item's product.description is capped at 4000 characters and
// eBay rejects anything longer (errorId 25718). The offer's listingDescription
// is a different field with a far larger limit, and it is the one buyers
// actually read, so the full HTML still reaches the listing.
const EBAY_ITEM_DESCRIPTION_MAX = 4000;
const EBAY_LISTING_DESCRIPTION_MAX = 500000;

const HOSTS = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};

// shopify_stores.store_code is currently null for every row, so the store ->
// shop link lives here until that column is populated. The DB value wins when
// it exists.
const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};

const stripControl = (s: string) =>
  Array.from(s).filter(ch => ch.charCodeAt(0) >= 32).join("");

let APPS: Record<string, { clientId?: string; clientSecret?: string }> = {};
{
  const raw = (Deno.env.get("EBAY_APPS") || "").trim();
  if (raw) {
    for (const text of [raw, stripControl(raw)]) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) { APPS = parsed; break; }
      } catch { /* fall through to the stripped attempt */ }
    }
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// --- supabase ---------------------------------------------------------------

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

type StoreRow = {
  store_code: string;
  environment: "production" | "sandbox";
  refresh_token: string;
  access_token: string | null;
  access_token_expires_at: string | null;
  scopes: string | null;
  merchant_location_key: string | null;
  payment_policy_id: string | null;
  return_policy_id: string | null;
  fulfillment_policy_id: string | null;
};

async function loadStore(store: string): Promise<StoreRow | null> {
  const res = await sb(`ebay_stores?store_code=eq.${encodeURIComponent(store)}&select=*`);
  return (await res.json())[0] || null;
}

async function shopFor(store: string): Promise<{ shop: string; token: string }> {
  const res = await sb(`shopify_stores?select=shop,store_code,access_token`);
  const rows: { shop: string; store_code: string | null; access_token: string }[] = await res.json();
  const byCode = rows.find(r => r.store_code === store);
  const target = byCode || rows.find(r => r.shop === SHOP_BY_STORE[store]);
  if (!target) throw new Error(`no shopify_stores row for ${store}`);
  return { shop: target.shop, token: target.access_token };
}

// --- shopify ----------------------------------------------------------------

async function shopifyGql(shop: string, token: string, query: string, variables: unknown) {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`shopify: ${JSON.stringify(body.errors).slice(0, 400)}`);
  return body.data;
}

const PRODUCT_FIELDS = `
  id title descriptionHtml vendor productType status
  images(first: ${EBAY_MAX_IMAGES}) { edges { node { url } } }
  variants(first: 10) { edges { node {
    id sku price inventoryQuantity
    inventoryItem { unitCost { amount } }
  } } }
`;

type Candidate = {
  productId: string;
  variantId: string;
  title: string;
  sku: string;
  price: string;
  cost: string | null;
  quantity: number;
  images: number;
  vendor: string;
  productType: string;
  descriptionHtml: string;
  imageUrls: string[];
};

function flatten(products: any[]): Candidate[] {
  const out: Candidate[] = [];
  for (const p of products) {
    const imageUrls = (p.images?.edges || []).map((e: any) => e.node.url);
    for (const v of (p.variants?.edges || []).map((e: any) => e.node)) {
      if (!v.sku) continue;
      out.push({
        productId: p.id,
        variantId: v.id,
        title: p.title,
        sku: v.sku,
        price: v.price,
        cost: v.inventoryItem?.unitCost?.amount ?? null,
        quantity: v.inventoryQuantity ?? 0,
        images: imageUrls.length,
        vendor: p.vendor || "",
        productType: p.productType || "",
        descriptionHtml: p.descriptionHtml || "",
        imageUrls,
      });
    }
  }
  return out;
}

async function findProducts(shop: string, token: string, q: string, n: number) {
  const data = await shopifyGql(
    shop, token,
    `query($q: String, $n: Int!) {
       products(first: $n, query: $q) { edges { node { ${PRODUCT_FIELDS} } } }
     }`,
    { q: q || null, n },
  );
  return flatten((data.products?.edges || []).map((e: any) => e.node));
}

// --- eBay -------------------------------------------------------------------

async function accessTokenFor(row: StoreRow): Promise<string> {
  const expiresAt = row.access_token_expires_at ? Date.parse(row.access_token_expires_at) : 0;
  if (row.access_token && expiresAt - Date.now() > 60000) return row.access_token;

  const creds = APPS[row.store_code];
  if (!creds?.clientId || !creds?.clientSecret) {
    throw new Error(`no credentials in EBAY_APPS for ${row.store_code}`);
  }
  const res = await fetch(`${HOSTS[row.environment]}/identity/v1/oauth2/token`, {
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
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${text}`);
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

function ebayClient(host: string, token: string) {
  return async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${host}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept-Language": "en-US",
        "Content-Language": "en-US",
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  };
}

const errText = (body: any) =>
  Array.isArray(body?.errors)
    ? body.errors.map((e: any) => {
        const params = (e.parameters || []).map((p: any) => `${p.name}=${p.value}`).join(",");
        return `${e.errorId}: ${e.message}${params ? ` [${params}]` : ""}`;
      }).join("; ")
    : typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400);

// --- mapping ----------------------------------------------------------------

// eBay rejects titles over 80 chars outright. Cut on a word boundary so the
// listing does not end mid-word.
function ebayTitle(raw: string): string {
  const t = raw.trim();
  if (t.length <= EBAY_TITLE_MAX) return t;
  const cut = t.slice(0, EBAY_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
}

// Cutting HTML at a character count can land inside a tag, which turns the tail
// of the description into visible junk. Back up to the last completed tag so the
// markup we send is at least well-formed up to the cut. Unclosed containers are
// tolerated by eBay's renderer; a half-written `<div cla` is not.
function clampHtml(html: string, max: number): string {
  if (html.length <= max) return html;
  const cut = html.slice(0, max);
  const lastClose = cut.lastIndexOf(">");
  const lastOpen = cut.lastIndexOf("<");
  // Only trim back when the cut actually landed mid-tag.
  return (lastOpen > lastClose ? cut.slice(0, lastOpen) : cut).trim();
}

// PayMore's Shopify descriptions are templated and carry a two-column spec
// table — Platform, Game Name, Release Year, UPC, Condition and so on. Those
// are precisely the fields eBay demands as item aspects, so parse them out
// rather than guessing from the title.
const stripTags = (html: string) =>
  html.replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function parseSpecs(html: string): Record<string, string> {
  const specs: Record<string, string> = {};
  // Any <tr> holding exactly two cells is a label/value pair. The templates use
  // nested markup inside the value cell, so match lazily and strip afterwards.
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = row.match(/<td[\s\S]*?<\/td>/gi) || [];
    if (cells.length !== 2) continue;
    const key = stripTags(cells[0]).replace(/[?:]+$/, "").trim();
    const value = stripTags(cells[1]);
    if (key && value) specs[key] = value;
  }
  return specs;
}

// Their condition vocabulary maps cleanly onto eBay's used-condition enums.
//
// DAMAGE IS TESTED FIRST, AND IT IS TESTED FOR PROPERLY.
// The list is ordered, first match wins, and the damage words have to come
// before the cosmetic grades — a spec reading "Broken, excellent screen" must
// land on For Parts, not on Excellent, because the conservative reading is the
// only safe one when two words disagree.
//
// "Broken" was missing from this list entirely. A Broken iPhone therefore
// matched nothing, fell through to the fallback, and went to eBay as USED
// EXCELLENT. eBay refused it (25019: the title says broken, the condition says
// working) and that refusal is the only reason it was caught — had the title
// been quieter, we would have sold a phone with a dead battery as excellent.
// Only words that cannot mean anything else. A bare "parts" or "repair" would
// swallow "all parts original" and "no repairs needed" and dump a working item
// into For Parts, which costs real money on price and placement. Anything not
// listed here is refused rather than guessed at, so the damage list can afford
// to be strict — the safety net is the refusal, not a catch-all pattern.
const CONDITION_BY_TEXT: [RegExp, string][] = [
  [/broken|for\s*parts|parts\s*only|not\s*working|faulty|defective|cracked|damaged|as[\s-]*is|dead/i,
   "FOR_PARTS_OR_NOT_WORKING"],
  [/^new$/i, "NEW"],
  [/like\s*new/i, "LIKE_NEW"],
  // PayMore's own top grade is "Flawless", not "Excellent" — sampled live at
  // OVL, where it is what the two iPads carry. It matched nothing here, so it
  // was only ever reaching eBay as USED_EXCELLENT by way of the default, which
  // happened to be right and was never a mapping. "Mint" is the same tier in
  // the buying vocabulary (mg_band_conditions: "Used-A/Mint").
  [/flawless|mint|pristine/i, "USED_EXCELLENT"],
  [/excellent/i, "USED_EXCELLENT"],
  [/very\s*good/i, "USED_VERY_GOOD"],
  [/^good$/i, "USED_GOOD"],
  [/acceptable|fair/i, "USED_ACCEPTABLE"],
  // eBay's 3000 is literally "Used" in hardware categories, so a spec saying
  // just "Used" is the plain used grade, not an unknown word to refuse over.
  [/^used$/i, "USED_EXCELLENT"],
];

// A CONDITION WE DO NOT RECOGNISE MUST NOT BECOME "EXCELLENT".
// The old fallback did exactly that: any word not on the list above quietly
// became whatever the default was, which is USED_EXCELLENT. That is the worst
// possible direction to guess in — it overstates the goods, and it does so
// silently, on the one field a buyer relies on most. Unknown now comes back as
// unknown and the caller refuses the listing, so the failure is a listing that
// did not go up rather than a return, a refund and an eBay defect.
function conditionFrom(
  specs: Record<string, string>, fallback: string,
): { value: string; unknown: string | null } {
  const text = (specs["Condition"] || "").trim();
  if (!text) return { value: fallback, unknown: null };
  for (const [re, value] of CONDITION_BY_TEXT) {
    if (re.test(text)) return { value, unknown: null };
  }
  return { value: fallback, unknown: text };
}

// THE USED TIERS ARE NOT UNIVERSAL.
// eBay's granular used conditions — Very Good (4000), Good (5000), Acceptable
// (6000) — exist only in media categories. Hardware categories accept a single
// "Used" (3000), and sending 5000 there kills the PUBLISH, not the offer, with
// "25021 ... condition id is invalid for the selected primary category id".
// All five of the first computer-part listings died on exactly this while the
// dry run looked clean, because nothing had asked the category what it takes.
const CONDITION_IDS: Record<string, number> = {
  NEW: 1000, NEW_OTHER: 1500, NEW_WITH_DEFECTS: 1750,
  CERTIFIED_REFURBISHED: 2000, EXCELLENT_REFURBISHED: 2010,
  VERY_GOOD_REFURBISHED: 2020, GOOD_REFURBISHED: 2030, SELLER_REFURBISHED: 2500,
  LIKE_NEW: 2750, USED_EXCELLENT: 3000, USED_VERY_GOOD: 4000,
  USED_GOOD: 5000, USED_ACCEPTABLE: 6000, FOR_PARTS_OR_NOT_WORKING: 7000,
};
const ID_TO_CONDITION: Record<number, string> = Object.fromEntries(
  Object.entries(CONDITION_IDS).map(([name, id]) => [id, name]));

// Substituting across families would misdescribe the goods — a used console
// must never become "New", and a working part must never become "For parts".
const conditionFamily = (id: number) =>
  id < 2000 ? "new" : id < 2750 ? "refurbished" : id < 7000 ? "used" : "parts";

async function allowedConditionIds(
  api: (p: string, i?: RequestInit) => Promise<{ status: number; body: any }>,
  categoryId: string,
): Promise<number[] | null> {
  const res = await api(
    `/sell/metadata/v1/marketplace/${MARKETPLACE}/get_item_condition_policies`
    + `?filter=categoryIds:{${encodeURIComponent(categoryId)}}`);
  // No answer is not a reason to block a publish — fall through to whatever we
  // resolved from the spec table and let eBay have the last word.
  if (res.status >= 300) return null;
  const policy = (res.body?.itemConditionPolicies || [])[0];
  const ids = (policy?.itemConditions || [])
    .map((c: any) => Number(c.conditionId))
    .filter((n: number) => Number.isFinite(n) && n > 0);
  return ids.length ? ids : null;
}

function adjustCondition(wanted: string, allowed: number[] | null) {
  const id = CONDITION_IDS[wanted];
  if (!id || !allowed || allowed.includes(id)) {
    return { condition: wanted, adjusted: false, unsupported: false };
  }
  const family = conditionFamily(id);
  const sameFamily = allowed.filter(a => conditionFamily(a) === family);
  if (!sameFamily.length) {
    return { condition: wanted, adjusted: false, unsupported: true };
  }
  // Nearest within the family; on a tie prefer the HIGHER id, which is the
  // worse condition — an ambiguous case should understate the item, never
  // flatter it.
  sameFamily.sort((a, b) => Math.abs(a - id) - Math.abs(b - id) || b - a);
  return { condition: ID_TO_CONDITION[sameFamily[0]] || wanted, adjusted: true, unsupported: false };
}

const normAspect = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// The spec table writes "N/A" where a field does not apply, and that string is
// a VALUE as far as the aspect mapper is concerned — which is how MPN: ["N/A"]
// reached a live listing. Junk in MPN is worse than cosmetic: eBay matches its
// catalog on it, so a placeholder can block the match that would have filled
// the rest of the aspects for free.
const PLACEHOLDER = /^(n[\/.]?a|none|null|nil|unknown|not applicable|no visible serial|-+|\?+)$/i;
const isPlaceholder = (v: string) => !v || PLACEHOLDER.test(v.trim());

// eBay's own wording for "this product has no manufacturer part number". It is
// a recognised value; "N/A" is not.
const MPN_ABSENT = "Does Not Apply";

// eBay calls it "Type"; the PayMore spec table calls it "Memory Type". Exact
// name matching leaves the required aspect empty, and the PUBLISH then fails
// with "25002: The item specific Type is missing" — after the offer has been
// created, so it reads as a listing fault rather than the mapping fault it is.
// Fall back to the closest spec key: one that ENDS with the aspect name first
// ("Memory Type" -> "Type"), then each half of a slashed name
// ("Chipset/GPU Model" -> "Chipset"), then any key containing it.
// Where the two vocabularies simply disagree and no amount of substring
// matching bridges them. eBay says "Storage Capacity", the spec table says
// "Storage Size" — no shared word ending, no shared half, no containment, so
// the aspect went out empty and the publish failed with "25002: The item
// specific Storage Capacity is missing" on a product that plainly says 32GB.
//
// Keyed by the EBAY name, listing the spec-table keys to try in order. Add to
// this when a 25002 names an aspect the product obviously has.
const ASPECT_SYNONYMS: Record<string, string[]> = {
  "storage capacity": ["Storage Size", "Hard Drive Capacity", "SSD Capacity", "Capacity", "Storage"],
  "hard drive capacity": ["Storage Size", "Hard Drive Capacity", "Capacity", "Storage"],
  "ssd capacity": ["Storage Size", "SSD Capacity", "Capacity", "Storage"],
  "screen size": ["Screen Size", "Display Size", "Size"],
  "ram size": ["RAM", "Memory Size", "Memory", "RAM Size"],
  "maximum resolution": ["Resolution", "Max Resolution"],
  "processor speed": ["Processor Speed", "CPU Speed", "Speed"],
  "network": ["Carrier", "Connectivity/Carrier", "Network"],
  "operating system": ["Android Version", "OS", "Operating System", "iOS Version"],
  "connectivity": ["Internet Connectivity", "Connectivity/Carrier", "Connectivity"],
  "model": ["Model", "Series"],
  "manufacturer color": ["Color", "Colour"],
};

// Keys above are written readably; normAspect strips every space and slash, so
// they must be normalised before any lookup can hit. Doing it here rather than
// writing "storagecapacity" in the table keeps the table legible.
const SYNONYMS_BY_NORM: Record<string, string[]> = Object.fromEntries(
  Object.entries(ASPECT_SYNONYMS).map(([k, v]) => [normAspect(k), v]));

function aliasValue(aspectName: string, specs: Record<string, string>): string | null {
  // Explicit synonyms first: they are the cases where the generic matching
  // below is known to find nothing, or worse, to find the wrong key.
  const syn = SYNONYMS_BY_NORM[normAspect(aspectName)];
  if (syn) {
    for (const key of syn) {
      const hit = Object.keys(specs).find(k => normAspect(k) === normAspect(key));
      if (hit && !isPlaceholder(specs[hit])) return specs[hit];
    }
  }
  return aliasValueGeneric(aspectName, specs);
}

function aliasValueGeneric(aspectName: string, specs: Record<string, string>): string | null {
  const want = normAspect(aspectName);
  const keys = Object.keys(specs).filter(k => !isPlaceholder(specs[k]));
  const ends = keys.find(k => normAspect(k).endsWith(want) && normAspect(k) !== want);
  if (ends) return specs[ends];
  for (const part of aspectName.split(/[\/,]/).map(p => p.trim()).filter(Boolean)) {
    const p = normAspect(part);
    const hit = keys.find(k => normAspect(k) === p) || keys.find(k => normAspect(k).endsWith(p));
    if (hit) return specs[hit];
  }
  const contains = keys.find(k => normAspect(k).includes(want));
  return contains ? specs[contains] : null;
}

// A closed value list means eBay rejects anything not on it, so map our wording
// onto theirs ("DDR4" -> "DDR4 SDRAM") instead of sending it raw. Free-text
// aspects take the value as-is; a closed list with no match returns null, which
// leaves the aspect out and lets the publish fail with a message that names it.
function legalValue(value: string, aspect: any): string | null {
  const allowed: string[] = (aspect?.aspectValues || [])
    .map((v: any) => v.localizedValue).filter(Boolean);
  if (!allowed.length) return value;
  const v = normAspect(value);
  return allowed.find(a => normAspect(a) === v)
    ?? allowed.find(a => normAspect(a).startsWith(v))
    ?? allowed.find(a => normAspect(a).includes(v) || v.includes(normAspect(a)))
    ?? (aspect?.aspectConstraint?.aspectMode === "FREE_TEXT" ? value : null);
}

function inventoryItemPayload(
  c: Candidate,
  resolvedCondition: string,
  specs: Record<string, string>,
  aspectDefs: any[],
  requiredAspects: string[],
) {
  // Only send aspects eBay actually declares for the category. Unrecognised
  // aspect names are a rejection risk, and the spec table carries plenty of
  // fields (Case/Box?, Manual?) that are ours, not eBay's.
  const aspects: Record<string, string[]> = {};
  for (const def of aspectDefs) {
    const name = def.localizedAspectName;
    const hit = Object.keys(specs).find(k => k.toLowerCase() === name.toLowerCase());
    if (!hit || isPlaceholder(specs[hit])) continue;
    const legal = legalValue(specs[hit], def);
    if (legal) aspects[name] = [legal];
  }
  // Second pass, required aspects only. Guessing at optional ones would put
  // wrong data on listings for no gain; a missing required one blocks the sale.
  for (const name of requiredAspects) {
    if (aspects[name]) continue;
    const raw = aliasValue(name, specs);
    if (!raw || isPlaceholder(raw)) continue;
    const legal = legalValue(raw, aspectDefs.find(d => d.localizedAspectName === name));
    if (legal) aspects[name] = [legal];
  }
  // Say it in eBay's words rather than leaving the field blank or, worse,
  // stamped "N/A".
  const mpnDef = aspectDefs.find((d: any) => normAspect(d.localizedAspectName) === "mpn");
  if (mpnDef && !aspects[mpnDef.localizedAspectName]) {
    aspects[mpnDef.localizedAspectName] = [MPN_ABSENT];
  }
  // NOT the Shopify vendor — that is the PayMore store, not the manufacturer.
  // Brand comes from the spec table when the template records it, otherwise
  // eBay's catalog match on UPC is the better source.
  const upc = (specs["UPC"] || "").replace(/\D/g, "");

  return {
    availability: { shipToLocationAvailability: { quantity: Math.max(c.quantity, 0) } },
    condition: resolvedCondition,
    product: {
      title: ebayTitle(c.title),
      description: clampHtml(c.descriptionHtml || c.title, EBAY_ITEM_DESCRIPTION_MAX),
      imageUrls: c.imageUrls.slice(0, EBAY_MAX_IMAGES),
      // A valid UPC lets eBay match its own catalog entry and fill aspects we
      // never sent, which is far more reliable than our parsing.
      ...(upc.length >= 12 ? { upc: [upc] } : {}),
      ...(Object.keys(aspects).length ? { aspects } : {}),
    },
  };
}

// --- the PayMore branded wrapper ---------------------------------------------

type Template = {
  html: string; store_name: string; seller: string; logo_url: string; enabled: boolean;
};

async function loadTemplate(store: string): Promise<Template | null> {
  const rows = await (await sb(
    `ebay_listing_templates?store_code=eq.${encodeURIComponent(store)}&select=*`)).json();
  const t = rows[0];
  return t && t.enabled ? t : null;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Rebuilds the thumbnail strip in the markup shape the template's CSS expects.
// The first image is the hero, so thumbnails start from it too — that is what
// Marketplace Connect renders and the gallery looks wrong without it.
function thumbnailsHtml(urls: string[]): string {
  return urls.map(u => `
          <div class="thumbnail-item">
            <img src="${escapeHtml(u)}" class="thumbnail" width="170" height="170">
          </div>`).join("");
}

// itemId is only known AFTER publishOffer, so the first render leaves the Buy
// It Now / Contact Us links pointing at the store rather than at a listing that
// does not exist yet; ebay-sync then re-renders with the real id.
function renderTemplate(
  t: Template, c: Candidate, itemId: string | null, descriptionHtml: string,
): string {
  const images = c.imageUrls.slice(0, EBAY_MAX_IMAGES);
  // DESCRIPTION is substituted LAST. Product copy is arbitrary text from
  // Shopify, and doing it first would let a stray "{{TITLE}}" in a description
  // get expanded by the passes that follow.
  return t.html
    .split("{{TITLE}}").join(escapeHtml(ebayTitle(c.title)))
    .split("{{PRICE}}").join("$" + c.price)
    .split("{{MAIN_IMAGE}}").join(escapeHtml(images[0] || ""))
    .split("{{THUMBNAILS}}").join(thumbnailsHtml(images))
    .split("{{SELLER}}").join(t.seller)
    .split("{{STORE_NAME}}").join(escapeHtml(t.store_name))
    .split("{{LOGO_URL}}").join(escapeHtml(t.logo_url))
    .split("{{YEAR}}").join(String(new Date().getUTCFullYear()))
    .split("{{ITEM_ID}}").join(itemId || "")
    .split("{{DESCRIPTION}}").join(descriptionHtml);
}

function offerPayload(
  c: Candidate, row: StoreRow, categoryId: string, listingDescription: string,
) {
  return {
    sku: c.sku,
    marketplaceId: MARKETPLACE,
    format: "FIXED_PRICE",
    availableQuantity: Math.max(c.quantity, 0),
    categoryId,
    listingDescription: clampHtml(listingDescription, EBAY_LISTING_DESCRIPTION_MAX),
    listingPolicies: {
      fulfillmentPolicyId: row.fulfillment_policy_id,
      paymentPolicyId: row.payment_policy_id,
      returnPolicyId: row.return_policy_id,
    },
    pricingSummary: { price: { value: String(c.price), currency: CURRENCY } },
    merchantLocationKey: row.merchant_location_key,
  };
}

// --- auth --------------------------------------------------------------------
// Machine auth, the same secret and the same reasoning as shopify-live. These
// endpoints publish listings, move real stock and create real orders, and
// verify_jwt has to stay OFF because Shopify webhooks and pg_cron cannot
// present a Supabase JWT.
//
// Deliberately NOT in speeks.js. A secret shipped in public JavaScript is not a
// secret, so when the Operations UI needs these it gets an x-user-pin path with
// a role check instead — the pattern the rest of the site already uses.
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";

// --- where does this thing actually sell? -----------------------------------
//
// Browse search wants a query a buyer would type, not our full listing title.
// "Broken Verizon Apple iPhone 12 Pro Max 256GB 26.1 MYW33LL/A BAD BATT" finds
// nothing; "Apple iPhone 12 Pro Max 256GB" finds the market. So the condition
// words, the carrier, the MPN and any bare version numbers come out, and what
// is left is the product.
const MARKET_NOISE =
  /\b(broken|for\s*parts|parts\s*only|not\s*working|faulty|defective|cracked|damaged|as[\s-]*is|dead|bad\s*batt\w*|no\s*charg\w*|unlocked|locked|network\s*locked)\b/gi;

function marketQuery(title: string): string {
  const cleaned = title
    .replace(MARKET_NOISE, " ")
    // Model numbers like MYW33LL/A or SM-G781U are precise enough to return
    // nothing at all, which is the opposite of what a market sample needs.
    .replace(/\b[A-Z0-9]{3,}[-/][A-Z0-9-/]{2,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Browse rewards a short query. Past about eight words it starts returning
  // nothing rather than something loosely related.
  return cleaned.split(" ").slice(0, 8).join(" ") || title.split(" ").slice(0, 6).join(" ");
}

async function recommendCategory(
  api: (path: string, init?: RequestInit) => Promise<{ status: number; body: any }>,
  title: string,
) {
  const q = marketQuery(title);

  const sugg = await api(
    `/commerce/taxonomy/v1/category_tree/${CATEGORY_TREE_ID}/get_category_suggestions`
    + `?q=${encodeURIComponent(title)}`);
  const top = sugg.body?.categorySuggestions?.[0]?.category;
  const suggested = top ? { id: top.categoryId, name: top.categoryName } : null;

  const live = await api(
    `/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=50`);

  // Browse is a nice-to-have, not a dependency. If it is unavailable or the
  // query matched nothing, say so plainly and fall back to the taxonomy rather
  // than pretending to a confidence we do not have.
  if (live.status >= 300) {
    return { query: q, suggested, market: null, recommended: suggested,
             basis: "taxonomy", note: `Browse unavailable: ${errText(live.body).slice(0, 160)}` };
  }

  const tally = new Map<string, { id: string; name: string; n: number }>();
  for (const it of (live.body?.itemSummaries || [])) {
    const id = it.leafCategoryIds?.[0] || it.categories?.[0]?.categoryId;
    const name = it.categories?.find((k: any) => k.categoryId === id)?.categoryName
      || it.categories?.[0]?.categoryName;
    if (!id) continue;
    const hit = tally.get(id) || { id, name: name || id, n: 0 };
    hit.n += 1;
    tally.set(id, hit);
  }
  const ranked = [...tally.values()].sort((a, b) => b.n - a.n);
  const sampled = (live.body?.itemSummaries || []).length;
  const best = ranked[0] || null;

  // One or two stray listings are not a market. Below a quarter of the sample
  // the taxonomy guess is no worse, and it is at least consistent.
  const confident = !!best && sampled >= 4 && best.n / sampled >= 0.25;

  return {
    query: q,
    suggested,
    market: ranked.slice(0, 5).map(r => ({ ...r, share: Math.round((r.n / (sampled || 1)) * 100) })),
    sampled,
    recommended: confident ? { id: best.id, name: best.name } : suggested,
    basis: confident ? "market" : "taxonomy",
  };
}

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

// --- handler ----------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!opsAuthed(url)) return json({ error: "unauthorised" }, 401);
  const store = (url.searchParams.get("store") || "").toUpperCase().trim();
  const sku = (url.searchParams.get("sku") || "").trim();
  const preview = url.searchParams.get("preview") === "1";
  const dry = url.searchParams.get("dry") === "1";
  const q = url.searchParams.get("q") || "";
  const condition = url.searchParams.get("condition") || "USED_EXCELLENT";

  if (!store) return json({ error: "pass ?store=OVL" }, 400);

  const row = await loadStore(store);
  if (!row) return json({ error: `no ebay_stores row for ${store}` }, 404);

  const { shop, token: shopToken } = await shopFor(store);

  // --- category search: type words, get categories --------------------------
  // eBay publishes no "list every category" endpoint worth calling from a
  // browser — the tree is tens of thousands of nodes. get_category_suggestions
  // IS the search: give it words and it ranks leaf categories. Ancestors come
  // back with each hit, so the picker can show the full path and a person can
  // tell "Sunglasses" under Clothing apart from one under Consumer Electronics.
  if (url.searchParams.get("categorySearch") === "1") {
    const term = (url.searchParams.get("q") || "").trim();
    if (!term) return json({ error: "pass &q=" }, 400);
    const searchApi = ebayClient(HOSTS[row.environment], await accessTokenFor(row));
    const res = await searchApi(
      `/commerce/taxonomy/v1/category_tree/${CATEGORY_TREE_ID}/get_category_suggestions`
      + `?q=${encodeURIComponent(term)}`);
    if (res.status >= 300) {
      return json({ error: "eBay category search failed", detail: errText(res.body) }, 502);
    }
    return json({
      q: term,
      results: (res.body?.categorySuggestions || []).slice(0, 25).map((s: any) => ({
        id: s.category?.categoryId,
        name: s.category?.categoryName,
        // Ancestors arrive deepest-first; reversed they read as a path.
        path: (s.categoryTreeNodeAncestors || [])
          .map((a: any) => a.categoryName).reverse().join(" › "),
      })).filter((r: any) => r.id),
    });
  }

  // --- recommend a category from what the same thing actually sells in ------
  // The taxonomy suggestion is a text match on our title, and it is how a pair
  // of Ray-Ban META smart glasses ended up in Sunglasses — where eBay then
  // refused the condition, so a category mistake surfaced as a condition error.
  //
  // Asking the marketplace is a better question than asking the dictionary: run
  // the title through Browse, look at where the live listings for that same
  // product actually sit, and take the most common leaf. Taxonomy stays as the
  // fallback and is always returned alongside, because Browse can find nothing
  // (a rare item, or a title too specific to match anything).
  if (url.searchParams.get("recommend") === "1") {
    if (!sku) return json({ error: "pass &sku=" }, 400);
    const found = await findProducts(shop, shopToken, `sku:${sku}`, 10);
    const item = found.find(m => m.sku === sku);
    if (!item) return json({ error: `sku ${sku} not found in ${shop}` }, 404);
    const recApi = ebayClient(HOSTS[row.environment], await accessTokenFor(row));
    return json({ sku, title: item.title, ...(await recommendCategory(recApi, item.title)) });
  }

  // --- preview: pick something to test with ---------------------------------
  if (preview || !sku) {
    const found = await findProducts(shop, shopToken, q, 50);
    // Only things that could actually list: a SKU, stock, a price, an image.
    const listable = found.filter(c =>
      c.quantity > 0 && Number(c.price) > 0 && c.images > 0);
    return json({
      store,
      shop,
      totalVariants: found.length,
      listable: listable.length,
      candidates: listable.slice(0, 25).map(c => ({
        sku: c.sku,
        title: c.title,
        titleLength: c.title.length,
        wouldTruncateTo: c.title.length > EBAY_TITLE_MAX ? ebayTitle(c.title) : null,
        price: c.price,
        cost: c.cost,
        quantity: c.quantity,
        images: c.images,
        vendor: c.vendor,
        productType: c.productType,
      })),
      note: "pick a sku, then call ?store=" + store + "&sku=<sku>&dry=1",
    });
  }

  // --- one product ----------------------------------------------------------
  const matches = await findProducts(shop, shopToken, `sku:${sku}`, 10);
  const exact = matches.filter(m => m.sku === sku);
  if (!exact.length) return json({ error: `sku ${sku} not found in ${shop}` }, 404);

  // eBay keys inventory items by SKU per seller account, so pushing a second
  // product under a SKU that is already listed silently REPLACES the first
  // listing — no error, and the earlier item just quietly stops existing on
  // eBay. Refuse instead. Duplicates are a data-entry slip rather than a
  // designed state, so surfacing them is more useful than working around them.
  if (exact.length > 1) {
    return json({
      error: "this SKU belongs to more than one Shopify product",
      sku,
      wouldOverwrite: "publishing either one would replace the other's eBay listing",
      products: exact.map(m => ({ title: m.title, variantId: m.variantId, quantity: m.quantity })),
      fix: "give each product its own SKU in Shopify, then retry",
    }, 409);
  }
  const c = exact[0];

  const host = HOSTS[row.environment];
  const api = ebayClient(host, await accessTokenFor(row));

  // WHERE THIS THING BELONGS, asked of the marketplace before the dictionary.
  // recommendCategory samples the live listings for the same product and takes
  // the most common leaf, falling back to eBay's text-match suggestion when the
  // sample is thin. A person's explicit &category= always beats both — they are
  // holding the item.
  const chosenCategory = url.searchParams.get("category");
  const rec = await recommendCategory(api, c.title);
  const categoryId = chosenCategory || rec.recommended?.id;
  // The picker sends the name it showed, so an overridden category is not left
  // nameless in the panel. Without an override the name comes from whichever
  // source won.
  const categoryName: string | null = chosenCategory
    ? (url.searchParams.get("categoryName") || null)
    : (rec.recommended?.name || null);

  if (!categoryId) {
    return json({
      store, sku,
      error: "eBay matched this title to no category at all. Pick one from the "
        + "category list on the row and upload again.",
      recommendation: rec,
    }, 422);
  }

  // What aspects does this category actually demand? Reported so a failure is
  // immediately diagnosable rather than a guessing game.
  const aspectsRes = await api(
    `/commerce/taxonomy/v1/category_tree/${CATEGORY_TREE_ID}/get_item_aspects_for_category`
    + `?category_id=${encodeURIComponent(categoryId)}`,
  );
  const aspectDefs = aspectsRes.body?.aspects || [];
  const required = (aspectsRes.body?.aspects || [])
    .filter((a: any) => a.aspectConstraint?.aspectRequired)
    .map((a: any) => a.localizedAspectName);

  const specs = parseSpecs(c.descriptionHtml);

  // Ask the category which conditions it will accept BEFORE building the item.
  const allowedConditions = await allowedConditionIds(api, categoryId);
  const picked = conditionFrom(specs, condition);

  // An unrecognised condition word stops the listing. Guessing here would mean
  // publishing a grade nobody chose, and the grade is the field a buyer leans on
  // hardest — better a listing that did not go up than one that overstates the
  // goods. An explicit ?condition= is a person deciding on purpose, so it wins.
  if (picked.unknown && !url.searchParams.get("condition")) {
    const msg = `The product's Condition reads "${picked.unknown}", which is not a condition `
      + `SPEEKS Connect recognises, so it will not guess one — guessing here would put a grade `
      + `on eBay that nobody chose. Set the Condition on the Shopify product to one of: New, `
      + `Like New, Excellent, Very Good, Good, Acceptable, Used, or Broken / For Parts.`;
    if (!dry) await recordFailure(store, c, categoryId, msg, undefined, categoryName);
    return json({ store, sku, step: "condition", error: msg,
                  conditionFound: picked.unknown }, 422);
  }

  const wantedCondition = picked.value;
  const cond = adjustCondition(wantedCondition, allowedConditions);
  const item = inventoryItemPayload(c, cond.condition, specs, aspectDefs, required);

  // The branded wrapper. Without it a listing we publish looks nothing like the
  // hundreds Marketplace Connect already has live, which is the whole point of
  // matching. &noTemplate=1 falls back to the bare Shopify description.
  const rawDescription = c.descriptionHtml || c.title;
  const template = url.searchParams.get("noTemplate") === "1"
    ? null : await loadTemplate(store);
  const listingDescription = template
    ? renderTemplate(template, c, null, rawDescription)
    : rawDescription;
  const offer = offerPayload(c, row, categoryId, listingDescription);

  if (dry) {
    return json({
      store, sku, dryRun: true,
      shopify: { title: c.title, price: c.price, cost: c.cost, quantity: c.quantity, images: c.images },
      specsParsed: specs,
      conditionResolved: item.condition,
      condition: {
        fromSpecTable: wantedCondition,
        sending: cond.condition,
        adjustedForCategory: cond.adjusted,
        unsupportedByCategory: cond.unsupported,
        allowedHere: allowedConditions
          ? allowedConditions.map(i => `${i} ${ID_TO_CONDITION[i] || "?"}`)
          : "eBay did not answer — publishing will use the spec-table value",
      },
      category: {
        id: categoryId,
        name: categoryName,
        fromSuggestion: !chosenCategory,
        // How the category was arrived at, and what the live market looked
        // like. This is the part that makes a wrong category arguable instead
        // of mysterious.
        recommendation: rec,
        requiredAspects: required,
        aspectsWeAreSending: Object.keys(item.product.aspects || {}),
        missing: required.filter((r: string) => !(item.product.aspects || {})[r]),
      },
      template: template
        ? { applied: true, storeName: template.store_name, seller: template.seller,
            templateChars: template.html.length }
        : { applied: false, reason: url.searchParams.get("noTemplate") === "1"
              ? "&noTemplate=1" : "no enabled ebay_listing_templates row for this store" },
      // Report the description as measurements rather than dumping it. Hiding
      // it behind "<omitted>" is what let a 4000-character overflow reach the
      // live publish undetected — the length is the part that can fail.
      description: {
        shopifyChars: (c.descriptionHtml || c.title).length,
        itemDescriptionChars: item.product.description.length,
        itemLimit: EBAY_ITEM_DESCRIPTION_MAX,
        truncatedForItem:
          (c.descriptionHtml || c.title).length > EBAY_ITEM_DESCRIPTION_MAX,
        listingDescriptionChars: offer.listingDescription.length,
      },
      payloads: {
        // Pass &full=1 to see the description text itself.
        inventoryItem: url.searchParams.get("full")
          ? item
          : { ...item, product: { ...item.product, description: "<omitted, see description block>" } },
        offer: url.searchParams.get("full")
          ? offer
          : { ...offer, listingDescription: "<omitted, see description block>" },
      },
    });
  }

  // Refuse rather than misdescribe. If the category takes nothing in this
  // item's condition family, the only ways forward are to describe it as
  // something it is not or to list it somewhere else — both are decisions for
  // a person, not for this function.
  if (cond.unsupported) {
    return json({
      step: "condition",
      error: `category ${categoryId} accepts no condition in the "`
        + `${conditionFamily(CONDITION_IDS[wantedCondition])}" family`,
      sku, wanted: wantedCondition,
      allowedHere: (allowedConditions || []).map(i => `${i} ${ID_TO_CONDITION[i] || "?"}`),
      fix: "pass &category=<id> for a category that accepts it, or fix the Condition row in Shopify",
    }, 422);
  }

  // --- 1. inventory item ----------------------------------------------------
  const put = await api(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: "PUT",
    body: JSON.stringify(item),
  });
  if (put.status >= 300) {
    await recordFailure(store, c, categoryId, `inventory_item: ${errText(put.body)}`, undefined, categoryName);
    return json({ step: "inventory_item", status: put.status, error: errText(put.body) }, 502);
  }

  // --- 2. offer -------------------------------------------------------------
  const offerRes = await api("/sell/inventory/v1/offer", {
    method: "POST",
    body: JSON.stringify(offer),
  });
  // An existing offer for this SKU is a re-run, not an error: reuse its id.
  let offerId = offerRes.body?.offerId;
  let updatedExisting = false;
  if (offerRes.status >= 300) {
    const existing = await api(
      `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${MARKETPLACE}`,
    );
    offerId = existing.body?.offers?.[0]?.offerId;
    if (!offerId) {
      await recordFailure(store, c, categoryId, `offer: ${errText(offerRes.body)}`, undefined, categoryName);
      return json({ step: "offer", status: offerRes.status, error: errText(offerRes.body) }, 502);
    }
    // Reusing the id is not enough. Without this PUT the existing offer keeps
    // whatever price and description it was created with, so a re-push would
    // silently change nothing — which is exactly what you do NOT want from a
    // command whose whole purpose is to push the current state of the product.
    const { sku: _s0, marketplaceId: _m0, format: _f0, ...mutable0 } = offer;
    const upd = await api(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
      method: "PUT",
      body: JSON.stringify(mutable0),
    });
    if (upd.status >= 300) {
      await recordFailure(store, c, categoryId, `offer update: ${errText(upd.body)}`, offerId, categoryName);
      return json({ step: "offer update", status: upd.status, error: errText(upd.body) }, 502);
    }
    updatedExisting = true;
  }

  // --- 3. publish -----------------------------------------------------------
  const pub = await api(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {
    method: "POST",
  });
  if (pub.status >= 300) {
    await recordFailure(store, c, categoryId, `publish: ${errText(pub.body)}`, offerId, categoryName);
    return json({
      step: "publish",
      status: pub.status,
      error: errText(pub.body),
      categoryId,
      requiredAspects: required,
      hint: "publish failures are almost always missing required aspects for this category",
    }, 502);
  }

  const listingId = pub.body?.listingId;

  // The template's Buy It Now and Contact Us links embed the eBay item id,
  // which does not exist until the offer is published. Re-render with the real
  // id and update the live offer. Best effort on purpose: the listing is
  // already up and correct in every other respect, so a failure here is worth
  // recording but not worth reporting as a failed publish.
  let templateLinksPatched: boolean | string = false;
  if (template && listingId) {
    const finalDescription = renderTemplate(template, c, listingId, rawDescription);
    // updateOffer rejects sku / marketplaceId / format — they are immutable on
    // an existing offer, so send only the mutable fields.
    const { sku: _s, marketplaceId: _m, format: _f, ...mutable } = offer;
    const patch = await api(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
      method: "PUT",
      body: JSON.stringify({
        ...mutable,
        listingDescription: clampHtml(finalDescription, EBAY_LISTING_DESCRIPTION_MAX),
      }),
    });
    templateLinksPatched = patch.status < 300 ? true : errText(patch.body);
  }

  await upsertListing(store, c, categoryId, {
    ebay_offer_id: offerId,
    ebay_listing_id: listingId,
    status: "published",
    last_error: null,
    published_at: new Date().toISOString(),
  }, categoryName);

  return json({
    store, sku,
    published: true,
    listingId,
    offerId,
    categoryId,
    updatedExistingOffer: updatedExisting,
    templateApplied: !!template,
    templateLinksPatched,
    title: ebayTitle(c.title),
    viewUrl: row.environment === "sandbox"
      ? `https://sandbox.ebay.com/itm/${listingId}`
      : `https://www.ebay.com/itm/${listingId}`,
  });
});

async function upsertListing(
  store: string, c: Candidate, categoryId: string, extra: Record<string, unknown>,
  categoryName: string | null = null,
) {
  await sb("ebay_listings?on_conflict=store_code,sku", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      store_code: store,
      sku: c.sku,
      shopify_product_id: c.productId,
      shopify_variant_id: c.variantId,
      category_id: categoryId,
      // "56083" answers nobody's question. The category is the one part of a
      // listing that eBay picks rather than the store, so it is worth showing.
      ...(categoryName ? { category_name: categoryName } : {}),
      // Written on EVERY path, success and failure alike. A failed row with no
      // title is a SKU and an error message, which is not enough for anyone to
      // recognise the item they were trying to list.
      title: ebayTitle(c.title),
      price: Number(c.price) || null,
      quantity: c.quantity,
      updated_at: new Date().toISOString(),
      ...extra,
    }]),
  });
}

async function recordFailure(
  store: string, c: Candidate, categoryId: string, error: string, offerId?: string,
  categoryName: string | null = null,
) {
  await upsertListing(store, c, categoryId, {
    status: "failed",
    last_error: error,
    ...(offerId ? { ebay_offer_id: offerId } : {}),
  }, categoryName);
}
