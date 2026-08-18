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
  metafields(first: 60) { edges { node { namespace key value type } } }
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
  metafields: Record<string, string>;
  imageUrls: string[];
};

function flatten(products: any[]): Candidate[] {
  const out: Candidate[] = [];
  for (const p of products) {
    const imageUrls = (p.images?.edges || []).map((e: any) => e.node.url);
    // Flattened to a plain name -> value map so it can be read exactly like the
    // spec table. The key alone is what a person would recognise ("connectivity"),
    // and the namespace is kept alongside for the cases where two namespaces use
    // the same key.
    const metafields: Record<string, string> = {};
    for (const e of (p.metafields?.edges || [])) {
      const n = e.node;
      if (!n?.key || n.value == null) continue;
      const v = String(n.value).trim();
      if (!v) continue;
      if (!metafields[n.key]) metafields[n.key] = v;
      metafields[`${n.namespace}.${n.key}`] = v;
    }
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
        metafields,
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

// IS THIS eBay ITEM STILL ACTIVE? BROWSE CANNOT ANSWER IT.
// The obvious check — Browse getItem, 404 means gone — is wrong: eBay keeps
// serving an ENDED listing through Browse with its full description for some
// time afterwards. Verified on a listing ended minutes earlier, which came back
// 200 with 171k characters of content. Trading GetItem carries an explicit
// ListingStatus (Active / Completed / Ended), which is the actual answer.
//
// Returns true, false, or null for "could not tell" — and null must be treated
// as still-live by callers, because the expensive mistake is publishing over a
// listing that really is up.
async function itemStillActive(row: StoreRow, itemId: string): Promise<boolean | null> {
  try {
    const token = await accessTokenFor(row);
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>'
      + '<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
      + '<ItemID>' + itemId + '</ItemID>'
      + '<DetailLevel>ReturnSummary</DetailLevel>'
      + '</GetItemRequest>';
    const res = await fetch(HOSTS[row.environment] + "/ws/api.dll", {
      method: "POST",
      headers: {
        "X-EBAY-API-CALL-NAME": "GetItem",
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
        "X-EBAY-API-IAF-TOKEN": token,
        "Content-Type": "text/xml",
      },
      body: xml,
    });
    const text = await res.text();
    const status = (text.match(/<ListingStatus>([^<]+)<\/ListingStatus>/) || [])[1];
    if (status) return status.toLowerCase() === "active";
    // eBay answers a long-gone item with an error rather than a status.
    if (/<Ack>Failure<\/Ack>/.test(text) && /(invalid item|not found|17)/i.test(text)) return false;
    return null;
  } catch {
    return null;
  }
}

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
// THE WRITER AND THE READER HAVE TO AGREE ABOUT ENTITIES.
// &nbsp; and &amp; were decoded and the rest were not, so a spec value holding
// a < or a > came back out as the literal text "&lt;" and went to eBay that way.
// It matters more now that upsertSpecRows() writes rows itself: it must escape
// what it writes — a raw < from a typed answer would otherwise land as markup in
// a storefront description — and an escape the reader cannot undo is a value
// that changes every time it makes the round trip.
//
// &amp; stays LAST. Decoding it first would turn a literal "&amp;lt;" into "<".
const stripTags = (html: string) =>
  html.replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// THE SPEC TABLE IS NOT THE ONLY PLACE THE ANSWER LIVES.
// PayMore's listing tool writes the same product into Shopify METAFIELDS as
// well as into the description table, and the two do not always carry the same
// fields. An Amazon Echo Show failed to publish for a missing Connectivity that
// was sitting in a `connectivity` metafield the whole time; a screen extender
// failed on Screen Size with `screen_size` right there. eBay was not being
// fussy — Connectivity really is required in that category — we were simply
// reading one of the two places the store had already written it down.
//
// Three shapes are handled:
//   connectivity: "Wired"        a plain scalar, keyed by name
//   screen_size:  "15.6\""       snake_case, so it becomes "Screen Size"
//   filter_attributes: JSON      [{key, value}, ...], the structured twin of
//                                the spec table, sometimes richer than it
//
// Values are only ever a FALLBACK. The description table is what a buyer reads
// on the listing, so where both speak, the table wins and nothing about the
// existing behaviour changes.
const METAFIELD_LISTS = ["filter_attributes", "other_attributes", "title_attributes"];

// Metafields we must not treat as item specifics: internal bookkeeping, long
// prose, or things that mean something different to eBay than to us.
const METAFIELD_SKIP = new Set([
  "condition", "ebay_condition", "functionality_condition", "cosmetic_condition",
  "whats_include", "not_included", "product_qty", "google_product_category",
  "serial_number", "title_attributes",
]);

function titleCaseKey(key: string): string {
  return String(key).replace(/[_-]+/g, " ").trim()
    .split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function specsFromMetafields(mf: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const listKey of METAFIELD_LISTS) {
    const raw = mf[listKey];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        const k = String(entry?.key || "").trim();
        const v = String(entry?.value ?? "").trim();
        // "MFG Warranty?" and friends are ours, not eBay's; the trailing question
        // mark would never match an aspect name anyway, so tidy it here.
        const key = k.replace(/\?+$/, "").trim();
        if (!key || !v || isPlaceholder(v)) continue;
        if (!out[key]) out[key] = v;
      }
    } catch { /* a malformed metafield is not worth failing a listing over */ }
  }
  for (const [k, v] of Object.entries(mf)) {
    // The namespaced duplicates are only for disambiguation; skip them here.
    if (k.includes(".")) continue;
    if (METAFIELD_SKIP.has(k) || METAFIELD_LISTS.includes(k)) continue;
    const val = String(v).trim();
    // Prose, not a specific. eBay caps a value at 65 characters anyway.
    if (!val || val.length > 65 || /^</.test(val) || isPlaceholder(val)) continue;
    const name = titleCaseKey(k);
    if (!out[name]) out[name] = val;
  }
  return out;
}

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

// --- writing an answer back into Shopify ------------------------------------
//
// THE POINT IS THAT THE FIX LANDS WHERE THE FIELD WAS MISSING.
// Keeping the answer in SPEEKS would list the item and leave the Shopify product
// exactly as blank as it was, so the next person to open it — or the next tool
// to read it — learns nothing. Both places the reader looks get written: the
// description spec table (buyer-facing, and what parseSpecs reads) and a
// metafield (what specsFromMetafields reads).

// Our own namespace. Writing into PayMore's filter_attributes instead would put
// us inside a field their listing tool owns and rewrites, so a fix would survive
// exactly until the next time that tool touched the product.
const SPEC_MF_NS = "speeks";

// Shopify keys are lowercase, 3-64 chars, letters/digits/_/-. titleCaseKey()
// turns them back into "Professional Grader" on the way in, so the round trip
// has to survive: write professional_grader, read back Professional Grader, and
// match the name eBay asked for.
function metafieldKey(name: string): string {
  const k = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return k.length >= 3 ? k.slice(0, 64) : `${k}_spec`;
}

const escHtml = (v: string) => String(v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

// The opening tag of a cell or row, with whatever attributes it carries, so a
// rewrite can put the content back inside the original markup.
function openTagOf(html: string, tag: string): string {
  const m = String(html).match(new RegExp(`^<${tag}[^>]*>`, "i"));
  return m ? m[0] : `<${tag}>`;
}

// The last two-cell row in the markup, as three opening tags to build from.
// Falls back to plain tags when the description has no spec table yet, which is
// the only case where there is nothing to copy.
function lastSpecRow(html: string): { tr: string; td0: string; td1: string } {
  const rows = String(html || "").match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const cells = rows[i].match(/<td[\s\S]*?<\/td>/gi) || [];
    if (cells.length !== 2) continue;
    return {
      tr: openTagOf(rows[i], "tr"),
      td0: openTagOf(cells[0], "td"),
      td1: openTagOf(cells[1], "td"),
    };
  }
  return { tr: "<tr>", td0: "<td>", td1: "<td>" };
}

// AN EXISTING ROW IS REPLACED, NEVER DUPLICATED.
// parseSpecs() takes the LAST <tr> it sees for a label, so two rows sharing one
// label would decide the listing by document order — not a thing to leave to
// accident. Where the label is already there only the value cell changes, which
// also leaves the template's own markup and styling on the label alone.
function upsertSpecRows(html: string, entries: [string, string][]) {
  let out = String(html || "");
  const added: string[] = [];
  const replaced: string[] = [];
  for (const [name, value] of entries) {
    let hit = false;
    out = out.replace(/<tr[\s\S]*?<\/tr>/gi, (row) => {
      if (hit) return row;
      const cells = row.match(/<td[\s\S]*?<\/td>/gi) || [];
      if (cells.length !== 2) return row;
      const label = stripTags(cells[0]).replace(/[?:]+$/, "").trim();
      if (label.toLowerCase() !== name.toLowerCase()) return row;
      hit = true;
      // Spliced at the LAST occurrence, not replaced by string match: a row
      // whose label and value happen to be identical would otherwise have its
      // label cell rewritten instead of its value.
      const at = row.lastIndexOf(cells[1]);
      // The cell's own opening tag is kept, not rewritten: a template whose
      // value cells carry a class would otherwise lose it on the one row a fix
      // touched, leaving a single odd-looking line in the middle of the table.
      return row.slice(0, at) + openTagOf(cells[1], "td") + escHtml(value) + "</td>"
           + row.slice(at + cells[1].length);
    });
    if (hit) { replaced.push(name); continue; }
    // Into the last table on the page, which is where the template puts specs.
    let close = out.lastIndexOf("</tbody>");
    if (close < 0) close = out.lastIndexOf("</table>");
    // A ROW WE ADD HAS TO LOOK LIKE THE ROWS ALREADY THERE. Bare <td> markup is
    // structurally fine and visibly wrong — the one row a person did not type by
    // hand is the one that stands out. So the shape is copied from the last
    // two-cell row above the insertion point, attributes and all.
    const like = lastSpecRow(close >= 0 ? out.slice(0, close) : out);
    const newRow = `${like.tr}${like.td0}${escHtml(name)}</td>`
                 + `${like.td1}${escHtml(value)}</td></tr>`;
    out = close >= 0
      ? out.slice(0, close) + newRow + out.slice(close)
      : out + `<table>${newRow}</table>`;
    added.push(name);
  }
  return { html: out, added, replaced };
}

// One mutation for both halves, so a fix cannot half-land: either the product
// gains the row AND the metafield, or it gains neither.
async function writeSpecsToShopify(
  shop: string, token: string, c: Candidate, entries: [string, string][],
) {
  const spec = upsertSpecRows(c.descriptionHtml || "", entries);
  const metafields = entries.map(([name, value]) => ({
    namespace: SPEC_MF_NS,
    key: metafieldKey(name),
    type: "single_line_text_field",
    // specsFromMetafields() discards anything over 65 characters as prose, and
    // eBay caps an aspect value at 65 too — writing more would be writing
    // something our own reader then skips.
    value: String(value).slice(0, 65),
  }));
  const data = await shopifyGql(
    shop, token,
    `mutation($product: ProductUpdateInput!) {
       productUpdate(product: $product) {
         product { id }
         userErrors { field message }
       }
     }`,
    { product: { id: c.productId, descriptionHtml: spec.html, metafields } },
  );
  const errs = data?.productUpdate?.userErrors || [];
  if (errs.length) {
    throw new Error("shopify refused the fix: " + errs
      .map((e: any) => `${(e.field || []).join(".")}: ${e.message}`).join("; "));
  }
  return {
    rowsAdded: spec.added,
    rowsReplaced: spec.replaced,
    metafieldsWritten: metafields.map(m => `${m.namespace}.${m.key}`),
  };
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
//
// AN ABSENT CONDITION IS THE SAME RISK BY A DIFFERENT ROUTE. A product with no
// Condition row at all used to take the fallback silently, which is the exact
// overstatement the unknown-word refusal exists to prevent — a listing graded
// Excellent purely because nobody typed anything. Missing is now refused too,
// and it is a separate signal from unknown because the fix is different: one
// person needs to correct a word, the other needs to add the field.
// PAYMORE ALREADY DECIDED THE eBay CONDITION; WE WERE RE-DERIVING IT FROM PROSE.
// The listing tool writes an `ebay_condition` metafield holding eBay's own
// numeric condition id. Reading it removes the whole guessing layer — the layer
// that once shipped a phone titled "Broken" as USED_EXCELLENT because "Broken"
// was missing from a regex list.
//
// Checked against 8 products across three stores: the metafield agreed with our
// text mapping on 7. The one disagreement was a Ray-Ban that PayMore graded 3000
// and we called USED_GOOD — and that SKU is exactly the one eBay rejected with
// 25021, condition invalid for the category. Their value was right and ours was
// not, which is the whole argument for preferring it.
const EBAY_CONDITION_BY_ID: Record<string, string> = {
  "1000": "NEW",
  "1500": "NEW_OTHER",
  "1750": "NEW_WITH_DEFECTS",
  "2000": "CERTIFIED_REFURBISHED",
  "2010": "EXCELLENT_REFURBISHED",
  "2020": "VERY_GOOD_REFURBISHED",
  "2030": "GOOD_REFURBISHED",
  "2500": "SELLER_REFURBISHED",
  // 2750 was missing, and it is the ONE id some categories insist on: eBay's
  // trading-card categories call it "Graded". Without this row the ebay_condition
  // metafield could not express a graded card at all — setting it to 2750 fell
  // silently through to the text mapping and sent 3000, which publish rejects.
  "2750": "LIKE_NEW",
  "3000": "USED_EXCELLENT",
  "4000": "USED_VERY_GOOD",
  "5000": "USED_GOOD",
  "6000": "USED_ACCEPTABLE",
  "7000": "FOR_PARTS_OR_NOT_WORKING",
};

// WHAT THE PROMPT SHOWS ITS WORKING FROM.
//
// A dropdown with a pre-filled answer and no evidence is a value nobody can
// check, and checking it meant opening the product in Shopify in another tab —
// which is the whole cost the Fix prompt exists to remove. Everything needed is
// already in hand at the moment of failure, so it is kept.
//
// THE CONDITION BLOCK IS THE POINT. A spec table cannot explain a refusal whose
// cause is a metafield the table never shows: 21 graded cards at MPL stopped on
// an `ebay_condition` of 1500 while their spec tables happily read "CGC 10".
// Naming the field that was actually read is the difference between "why is it
// saying that?" and "ah, that metafield is wrong".
type Evidence = {
  title: string;
  price: string | null;
  image: string | null;
  images: number;
  specs: [string, string][];
  condition: { read: string | null; source: string | null; allowedHere: string[] } | null;
};

// Bounded on the way in, not on the way out. This lands in a jsonb column on
// every failure, and one product with a 4,000-character "I/O Ports" row should
// not be able to decide how big that column gets.
const EV_ROWS = 40, EV_LEN = 240;

function buildEvidence(
  c: Candidate, specs: Record<string, string>,
  picked: { value: string; unknown: string | null; missing: boolean; source?: string },
  condWords: string[],
): Evidence {
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(specs || {})) {
    if (rows.length >= EV_ROWS) break;
    const val = String(v ?? "").replace(/\s+/g, " ").trim();
    if (!val) continue;
    rows.push([String(k).slice(0, 60), val.slice(0, EV_LEN)]);
  }
  return {
    title: c.title,
    price: c.price ?? null,
    image: (c.imageUrls || [])[0] || null,
    images: c.images || 0,
    specs: rows,
    condition: {
      // The word the product gave us, recognised or not — an unrecognised one is
      // the most useful thing on the screen, because it is the thing to change.
      read: picked.missing ? null : (picked.unknown || picked.value),
      source: picked.source || null,
      allowedHere: condWords,
    },
  };
}

function conditionFrom(
  specs: Record<string, string>, fallback: string,
  metafields: Record<string, string> = {},
): { value: string; unknown: string | null; missing: boolean; source?: string } {
  // AN ANSWER A PERSON GAVE OUTRANKS THE AUTOMATED ONE.
  //
  // `speeks.condition` is written by ONE thing: the Fix prompt, after eBay
  // refused the listing and somebody read the refusal and chose a value. So its
  // presence means a human looked at this item BECAUSE the automated grade did
  // not work. Letting ebay_condition win in that situation would send the
  // rejected value again and put the same refusal back on the screen, which
  // reads as the person's answer being wrong.
  //
  // This is the one case that beats ebay_condition, and it is narrow on purpose:
  // the namespaced key is read, never the bare `condition`, which PayMore also
  // writes and which would hand every product's ordinary spec data the same
  // authority. Trading cards are why this matters — a graded card needs 2750
  // where the tool has written 3000, and nothing else can express that.
  const ours = String(metafields["speeks.condition"] || "").trim();
  if (ours) {
    for (const [re, value] of CONDITION_BY_TEXT) {
      if (re.test(ours)) {
        return { value, unknown: null, missing: false,
                 source: `speeks.condition metafield ("${ours}", chosen in the panel)` };
      }
    }
  }

  const declared = String(metafields["ebay_condition"] || "").trim();
  if (EBAY_CONDITION_BY_ID[declared]) {
    return { value: EBAY_CONDITION_BY_ID[declared], unknown: null, missing: false,
             source: `ebay_condition metafield (${declared})` };
  }
  const text = (specs["Condition"] || "").trim();
  // No source when there is nothing to cite. "We read no field" is the honest
  // answer, and the prompt says so in its own words rather than naming a row
  // that was never there.
  if (!text) return { value: fallback, unknown: null, missing: true };
  for (const [re, value] of CONDITION_BY_TEXT) {
    if (re.test(text)) {
      return { value, unknown: null, missing: false,
               source: `the "Condition" row in the spec table ("${text}")` };
    }
  }
  return { value: fallback, unknown: text, missing: false,
           source: `the "Condition" row in the spec table ("${text}")` };
}

// The one place the accepted vocabulary is written down, so the refusal message
// and any future validator cannot drift apart.
// The prose form is what a refusal message reads out; the array is what the
// panel's Fix prompt turns into a dropdown. Built from one list so the sentence
// and the dropdown cannot come to disagree about what is accepted.
const CONDITION_CHOICES = [
  "New", "Like New", "Flawless", "Excellent", "Very Good", "Good",
  "Acceptable", "Used", "Broken / For Parts",
];
// The words from OUR vocabulary that this category will actually take.
//
// Built by round-tripping every choice — word -> enum -> id -> is it allowed —
// rather than by hand-mapping ids back to words. A hand map has to invent an
// answer for ids our vocabulary cannot express (NEW_OTHER, the refurbished
// tiers), and inventing one means offering a value that maps to a DIFFERENT id
// and fails all over again. Round-tripping can only ever offer a word that
// lands on an id the category listed.
function conditionWordsAllowed(allowed: number[] | null): string[] {
  if (!allowed || !allowed.length) return [];
  const out: string[] = [];
  for (const word of CONDITION_CHOICES) {
    for (const [re, value] of CONDITION_BY_TEXT) {
      if (!re.test(word)) continue;
      const id = CONDITION_IDS[value];
      if (id && allowed.includes(id)) out.push(word);
      break;
    }
  }
  return out;
}

const CONDITION_WORDS = CONDITION_CHOICES.slice(0, -1).join(", ")
  + ", or " + CONDITION_CHOICES[CONDITION_CHOICES.length - 1];

// A REFUSAL WE WROTE OURSELVES IS NOT A REFUSAL TO TRANSLATE.
// ebay-channel runs every stored error through humanError(), which pattern-matches
// eBay's phrasing and then caps the result at 300 characters so an untranslated
// wall of eBay markup cannot reach a store. Our own messages are already plain
// English and are longer than that cap, so they were arriving with their most
// useful half — the list of conditions to actually type — cut off the end. This
// prefix marks a message as ours; the channel strips it and passes the rest
// through whole, no rules and no cap.
// --- what is eBay actually waiting for? -------------------------------------
//
// A refusal is a sentence, and a sentence is only useful to somebody who can go
// and edit Shopify. A form needs a list: which fields, and for each one whether
// it is a closed set of legal values or free text. That is what this type is —
// the structured twin of the message, stored on the row so the panel can ask
// for the answer instead of sending somebody off to find it.
type MissingField = {
  name: string;
  allowed: string[];          // empty means free text
  kind: "aspect" | "descriptor" | "condition";
  // What we think the answer is, and where it came from. Both or neither: a
  // pre-filled box with no stated source is a value nobody can check, and the
  // person confirming it is the only safeguard against putting a guess on eBay.
  suggestion?: string;
  source?: string;
  // Set when the allowed list was too long to store whole, so the panel can say
  // so rather than letting a missing value read as "eBay does not accept it".
  truncated?: boolean;
};

// eBay names the offending field in two places and NEITHER IS SAFE ALONE: the
// message prose ("Professional Grader (27501) is a required field") and the
// parameters array. The prose has no stable grammar, so a name lifted out of it
// is only accepted here if it ALSO matches the category's own vocabulary — the
// aspects and condition descriptors already fetched for this listing.
//
// Matching against a known list is the whole point. A regex looking for field
// names in free text will happily pull "Type" or "Color" out of an unrelated
// sentence and put a made-up question in front of a person, which is worse than
// showing them the raw error.
function missingFromEbayError(
  body: any, aspectDefs: any[], condEntry: any,
): MissingField[] {
  const errs = Array.isArray(body?.errors) ? body.errors : [];
  if (!errs.length) return [];

  const candidates: string[] = [];
  for (const e of errs) {
    const msg = String(e?.message || "");
    // The shape eBay uses for both aspects and condition descriptors.
    for (const m of msg.matchAll(
      /([A-Za-z][\w &.'\/-]{1,48}?)\s*(?:\(\d+\))?\s+is (?:a |an )?required/gi)) {
      candidates.push(m[1]);
    }
    // "The item aspect Compatible Brand is missing", and its invalid-value twin.
    for (const m of msg.matchAll(
      /aspects?\s+["']?([A-Za-z][\w &.'\/-]{1,48}?)["']?\s+(?:is|has|was)/gi)) {
      candidates.push(m[1]);
    }
    for (const p of (e?.parameters || [])) {
      const v = String(p?.value ?? "").trim();
      if (v) candidates.push(v);
    }
  }
  if (!candidates.length) return [];
  const wanted = new Set(candidates.map(c => c.trim().toLowerCase()).filter(Boolean));

  const out: MissingField[] = [];
  const seen = new Set<string>();
  const take = (name: string, allowed: string[], kind: MissingField["kind"]) => {
    const k = name.toLowerCase();
    if (!name || seen.has(k)) return;
    seen.add(k);
    // THE WHOLE LIST. Trimming here to 60 quietly dropped "Pokémon TCG" from a
    // Game aspect with 168 values: the dropdown could not offer it, and the
    // suggester rejected it as "not in eBay's list" — a value we had, thrown
    // away, then blamed on eBay. Capping happens once, at the end, in
    // withSuggestions(), where the suggestion can be protected from the cut.
    out.push({ name, allowed: allowed.slice(), kind });
  };

  // Descriptors first: they are the narrower vocabulary, and where a name
  // appears in both lists the descriptor is the one eBay is asking about.
  for (const d of (condEntry?.conditionDescriptors || [])) {
    const name = String(d.conditionDescriptorName || "");
    if (wanted.has(name.toLowerCase())) {
      take(name, (d.conditionDescriptorValues || [])
        .map((v: any) => String(v.conditionDescriptorValueName)), "descriptor");
    }
  }
  for (const def of (aspectDefs || [])) {
    const name = String(def.localizedAspectName || "");
    if (wanted.has(name.toLowerCase())) {
      take(name, (def.aspectValues || [])
        .map((v: any) => String(v.localizedValue)), "aspect");
    }
  }
  return out;
}

// --- suggesting the answer ---------------------------------------------------
//
// A BLANK BOX IS AN ANSWER WE ALREADY HAD. eBay asks for "Manufacturer Color"
// while the product carries "Color"; it asks for Brand while Shopify holds a
// Vendor; it asks for a colour from a fixed list of sixteen while the title
// says the word. Making somebody go and look all that up is asking them to
// retype what is already on the screen.
//
// NOTHING IS EVER FILLED IN SILENTLY. Every suggestion is offered with the
// place it came from, and the person still presses the button. A wrong aspect
// on eBay is a return and a dispute, so the human stays in the loop — the
// suggestion only removes the typing, never the decision.

// "Compatible Brand" vs "Brand", "Model Number" vs "Model". Token containment
// rather than string containment, so "Brand" does not match "Brandy" and
// "Color" does not match "Colorway".
const nameTokens = (s: string) =>
  new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

const tokensCover = (a: Set<string>, b: Set<string>) =>
  a.size > 0 && b.size > 0 && [...a].every(t => b.has(t));

// A suggestion eBay would refuse is worse than no suggestion: it reads as our
// answer being wrong rather than the spelling. So on a closed list the value
// must BE one of the allowed strings, and it is returned in eBay's own casing.
function snapToAllowed(value: string, allowed: string[]): string | null {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return null;
  if (!allowed.length) return String(value).trim();
  return allowed.find(a => String(a).trim().toLowerCase() === v) || null;
}

// Longest first, so "Rose Gold" wins over "Gold" in a title carrying both.
function fromTitle(title: string, allowed: string[]): string | null {
  if (!allowed.length) return null;
  const t = " " + String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  const sorted = [...allowed].sort((a, b) => b.length - a.length);
  for (const a of sorted) {
    const needle = " " + String(a).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
    if (needle.trim() && t.includes(needle)) return a;
  }
  return null;
}

// THE ANSWER IS OFTEN IN A ROW WITH THE WRONG NAME ON IT.
// eBay wants "Game"; the product has no Game row, but it does have
// `Collection: "Pokémon TCG Card"`. Reading spec NAMES alone walks straight
// past that. So every spec VALUE is searched for something the category will
// accept, the same way the title is.
//
// Last of all the text sources, and only for closed lists: this is the loosest
// match we make, and it should never beat the title or a row that is actually
// named after the field. The closed list is what keeps it honest — a value has
// to be one eBay named, so a stray word cannot become an answer.
function fromOtherSpecs(
  specs: Record<string, string>, allowed: string[],
): { value: string; from: string } | null {
  if (!allowed.length) return null;
  for (const [k, v] of Object.entries(specs || {})) {
    const hit = fromTitle(String(v), allowed);
    if (hit) return { value: hit, from: k };
  }
  return null;
}

// eBay spells its graders out in full and the world writes the abbreviation:
// the value is "Professional Sports Authenticator (PSA)" and every title on the
// shelf says "PSA 10". Matching only the full string found nothing on a card
// whose title names the grader twice.
function matchByAbbrev(title: string, allowed: string[]): string | null {
  const t = " " + String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  for (const a of allowed) {
    const m = String(a).match(/\(([^)]{2,12})\)/);
    if (!m) continue;
    const abbr = m[1].toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (abbr.length >= 2 && t.includes(" " + abbr + " ")) return a;
  }
  return null;
}

// A NUMBER IN A CARD TITLE IS USUALLY THE CARD NUMBER, NOT THE GRADE.
// "Pikachu V 045/184" would hand a Grade field 045 or 184 with a straight
// match, and a wrong grade is not a cosmetic error — it is a misdescribed item
// and a return. So a grade is only ever read when it sits directly after the
// name of a grading company, which is exactly how these titles are written.
const GRADE_AFTER_GRADER =
  /\b(?:PSA|BGS|BVG|BCCG|CGC|SGC|HGA|TAG|GMA|KSA|MNT|ACE)\s*([0-9]{1,2}(?:\.5)?)\b/i;

const allNumeric = (allowed: string[]) => allowed.length > 0
  && allowed.every(v => /^[0-9]{1,2}(\.[05])?$/.test(String(v).trim()));

// The one condition worth suggesting. A grade is a judgement about the physical
// item and guessing it is exactly what this function refuses to do elsewhere —
// but a seller who typed "broken" in their own title has already told us.
const DAMAGED_RE = /\b(broken|cracked|for parts|parts only|not working|no charge|damaged)\b/i;

function suggestFor(
  f: MissingField, c: Candidate, specs: Record<string, string>,
): MissingField {
  const want = nameTokens(f.name);

  // 1. The product already answers it under a different name.
  for (const [k, v] of Object.entries(specs || {})) {
    const have = nameTokens(k);
    if (!tokensCover(have, want) && !tokensCover(want, have)) continue;
    const snapped = snapToAllowed(v, f.allowed);
    if (snapped) return { ...f, suggestion: snapped, source: `the product's "${k}" row` };
  }

  // 2. Shopify's Vendor is the brand, and is the one product field that is not
  //    a spec row.
  if (c.vendor && (want.has("brand") || want.has("manufacturer"))) {
    const snapped = snapToAllowed(c.vendor, f.allowed);
    if (snapped) return { ...f, suggestion: snapped, source: "Shopify's Vendor field" };
  }

  // 3. Our own Condition, and only the damaged end of it.
  if (f.kind === "condition") {
    if (DAMAGED_RE.test(c.title || "")) {
      const snapped = snapToAllowed("Broken / For Parts", f.allowed);
      if (snapped) return { ...f, suggestion: snapped, source: "the wording of the title" };
    }
    return f;   // never guess a grade
  }

  // 4. A grade, and only where a grader vouches for it. Ahead of the plain
  //    title match on purpose: that one would happily read a card number.
  if (allNumeric(f.allowed)) {
    const m = String(c.title || "").match(GRADE_AFTER_GRADER);
    const snapped = m ? snapToAllowed(m[1], f.allowed) : null;
    if (snapped) {
      return { ...f, suggestion: snapped,
               source: "the grade written beside the grader in the title" };
    }
    return f;
  }

  // 5. A closed-list value said out loud in the title.
  const fromT = fromTitle(c.title || "", f.allowed);
  if (fromT) return { ...f, suggestion: fromT, source: "the product title" };

  // 6. The same, by the abbreviation eBay hides in brackets.
  const abbr = matchByAbbrev(c.title || "", f.allowed);
  if (abbr) return { ...f, suggestion: abbr, source: "the abbreviation in the title" };

  // 7. Last resort: an accepted value sitting inside some other row.
  const other = fromOtherSpecs(specs, f.allowed);
  if (other) {
    return { ...f, suggestion: other.value,
             source: `the product's "${other.from}" row (a different field)` };
  }

  // Nothing in the text answers it. The panel says so and asks the person,
  // which is the right end state — not a guess dressed up as an answer.
  return f;
}

// Long enough for every list seen so far (Game is 168, the big Brand lists run
// to a few hundred) while still bounding what goes into a jsonb column from an
// HTTP response. The suggestion is carried across the cut, because the one
// value we are most sure about is the one that must not be lost to it.
const ALLOWED_CAP = 1200;

const withSuggestions = (
  fields: MissingField[], c: Candidate, specs: Record<string, string>,
) => fields.map(f => {
  const out = suggestFor(f, c, specs);
  if (out.allowed.length <= ALLOWED_CAP) return out;
  const kept = out.allowed.slice(0, ALLOWED_CAP);
  if (out.suggestion && !kept.includes(out.suggestion)) kept[kept.length - 1] = out.suggestion;
  return { ...out, allowed: kept, truncated: true };
});

const OURS = "SPEEKS: ";

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

// Returns the category's full itemConditions array, NOT just the ids.
//
// The ids were all this ever kept, and the descriptors nested inside each
// condition were thrown away with the rest of the response — which is why every
// trading card died at publish with 25064 naming a field that does not exist as
// an aspect. See descriptorsFor() below.
async function conditionPolicyFor(
  api: (p: string, i?: RequestInit) => Promise<{ status: number; body: any }>,
  categoryId: string,
): Promise<any[] | null> {
  const res = await api(
    `/sell/metadata/v1/marketplace/${MARKETPLACE}/get_item_condition_policies`
    + `?filter=categoryIds:{${encodeURIComponent(categoryId)}}`);
  // No answer is not a reason to block a publish — fall through to whatever we
  // resolved from the spec table and let eBay have the last word.
  if (res.status >= 300) return null;
  const policy = (res.body?.itemConditionPolicies || [])[0];
  const conditions = policy?.itemConditions || [];
  return conditions.length ? conditions : null;
}

const conditionIdsOf = (policy: any[] | null): number[] | null => {
  const ids = (policy || [])
    .map((c: any) => Number(c.conditionId))
    .filter((n: number) => Number.isFinite(n) && n > 0);
  return ids.length ? ids : null;
};

// CONDITION DESCRIPTORS ARE NOT ASPECTS.
//
// eBay returns them nested inside each condition in the condition policy, and
// they never appear in get_item_aspects_for_category. A Graded trading card must
// carry Professional Grader (27501) and Grade (27502); an Ungraded one must carry
// Card Condition (40001). Miss them and publish fails with
// "25064: Professional Grader (27501) is a required field" — naming something no
// amount of filling in the spec table could have supplied, because nothing here
// was sending the field at all.
const DESCRIPTOR_SPEC_KEYS: Record<string, string[]> = {
  "professional grader": ["Professional Grader", "Grader", "Grading Company", "Graded By"],
  "grade": ["Grade", "Card Grade"],
  "certification number": ["Certification Number", "Cert Number", "Cert No", "Cert #",
                           "Certificate Number", "Serial Number"],
  // Deliberately NOT aliased to the plain "Condition" row: that one already means
  // the eBay condition, and "Like New" is not one of eBay's card grades.
  "card condition": ["Card Condition"],
};

// "Professional Sports Authenticator (PSA)" has to match a spec row that just
// says PSA — the abbreviation in the brackets is what anybody actually writes.
function descriptorValueMatches(spec: string, name: string): boolean {
  const s = spec.trim().toLowerCase();
  const n = String(name || "").trim().toLowerCase();
  if (!s || !n) return false;
  if (s === n) return true;
  const abbr = /\(([^)]+)\)\s*$/.exec(n);
  if (abbr && s === abbr[1].trim()) return true;
  if (s === n.replace(/\s*\([^)]*\)\s*$/, "").trim()) return true;
  // Grades arrive as "10", "9.5", "PSA 10", "Gem Mint 10" — compare the number.
  const sn = /(\d+(?:\.\d+)?)/.exec(s);
  const nn = /^(\d+(?:\.\d+)?)$/.exec(n);
  if (sn && nn && Number(sn[1]) === Number(nn[1])) return true;
  return false;
}

// Never defaults. eBay offers one (PSA, grade 10) and taking it would stamp a
// grade nobody chose onto a listing — the same reason conditionFrom() refuses to
// guess a condition. A missing required descriptor is reported instead, so the
// refusal can name the field and list its legal values.
function descriptorsFor(entry: any, specs: Record<string, string>) {
  const values: { name: string; values: string[] }[] = [];
  const missing: { name: string; allowed: string[] }[] = [];
  for (const d of (entry?.conditionDescriptors || [])) {
    const dName = String(d.conditionDescriptorName || "");
    const constraint = d.conditionDescriptorConstraint || {};
    const required = String(constraint.usage || "").toUpperCase() === "REQUIRED";
    const legal = d.conditionDescriptorValues || [];
    const allowed = legal.map((v: any) => String(v.conditionDescriptorValueName));
    const keys = DESCRIPTOR_SPEC_KEYS[dName.toLowerCase()] || [dName];
    let raw = "";
    for (const k of keys) {
      const hit = Object.keys(specs).find(x => x.toLowerCase() === k.toLowerCase());
      if (hit && !isPlaceholder(specs[hit])) { raw = String(specs[hit]).trim(); break; }
    }
    if (!raw) { if (required) missing.push({ name: dName, allowed }); continue; }
    if (String(constraint.mode || "") === "SELECTION_ONLY") {
      const hit = legal.find((v: any) => descriptorValueMatches(raw, v.conditionDescriptorValueName));
      if (!hit) { if (required) missing.push({ name: dName, allowed }); continue; }
      values.push({ name: String(d.conditionDescriptorId),
                    values: [String(hit.conditionDescriptorValueId)] });
    } else {
      values.push({ name: String(d.conditionDescriptorId), values: [raw.slice(0, 60)] });
    }
  }
  return { values, missing };
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
  if (contains) return specs[contains];

  // THE ASPECT CAN BE MORE SPECIFIC THAN OUR KEY, AND THAT DIRECTION IS RISKY.
  // Everything above matches when OUR key carries the extra words — "Processor
  // Speed" answering "Speed". A CPU is the other way round: eBay category 164
  // requires "Processor Model" and the spec table just says "Model", so nothing
  // matched and a perfectly good i9-13900k failed the publish with 25002 while
  // its model number sat right there in the table.
  //
  // Matching that direction blindly would be worse than the bug. On a laptop the
  // same rule would answer "Processor Model" with the LAPTOP model — publishing
  // "Lenovo Yoga Pro 9i" as the CPU. So the extra words the aspect adds have to
  // be corroborated by what the item says it IS: the spec table names itself
  // "Sub-Collection: Processor (CPU)", and a laptop never will. The item
  // describes itself; we only agree with it.
  const context = normAspect(
    [specs["Sub-Collection"], specs["Collection"], specs["Type"], specs["Category"]]
      .filter(Boolean).join(" "));
  if (context) {
    const general = keys.find(k => {
      const n = normAspect(k);
      if (n === want || !want.endsWith(n) || n.length < 3) return false;
      // What the aspect adds beyond our key — "processor" for Processor Model.
      const extra = want.slice(0, want.length - n.length);
      return extra.length >= 3 && context.includes(extra);
    });
    if (general) return specs[general];
  }

  return null;
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

  const exact = allowed.find(a => normAspect(a) === v);
  if (exact) return exact;

  // MATCH BY PREFIX, IN A DIRECTION, RATHER THAN BY RAW SUBSTRING LENGTH.
  //
  // Two wrong versions preceded this. Taking the FIRST substring match sent a
  // SATA III drive as SATA I — normalised, "sataiii6gbps" contains "satai", and
  // "SATA I" comes first in eBay's list. Ranking those same matches by LENGTH
  // fixed SATA and broke other things just as badly, because "longest" is no
  // less of a guess than "first": DDR4 desktop RAM became "GDDR4 SDRAM", which
  // is graphics memory (ours merely sits INSIDE theirs), a 2.5" drive became
  // 5.25" ("25" sits inside "525in"), and an 11" iPad became 11.1". An audit of
  // the live listings caught all three before a re-push shipped them.
  //
  // Direction is what those cases turn on, so it is what this matches on:
  //
  //   ours starts with theirs  — "sataiii6gbps" -> "sataiii". Ours carries
  //     extra detail past a value that genuinely fits, so take the LONGEST such
  //     value: the most specific one our text actually supports.
  //
  //   theirs starts with ours  — "ddr4" -> "ddr4 dram". Theirs adds detail we
  //     did not state, so take the SHORTEST: the least invented. This is what
  //     rejects "gddr4 sdram", which does not start with "ddr4" at all, and
  //     "5.25 in", which does not start with "2.5".
  //
  // Only if neither direction fits does a loose contains apply, and there the
  // shortest wins for the same reason — "GeForce GTX 970" should become
  // "NVIDIA GeForce GTX 970", not "NVIDIA GeForce GTX 970 Jetstream", which
  // names a board variant nobody wrote down.
  const byLen = (dir: number) => (a: string, b: string) =>
    (normAspect(a).length - normAspect(b).length) * dir;

  const oursExtends = allowed.filter(a => v.startsWith(normAspect(a))).sort(byLen(-1));
  if (oursExtends.length) return oursExtends[0];

  const theirsExtends = allowed.filter(a => normAspect(a).startsWith(v)).sort(byLen(1));
  if (theirsExtends.length) return theirsExtends[0];

  // A LIST VALUE BEATS A TRUER VALUE THAT NOBODY CAN FILTER ON.
  // Tried and reverted: skipping this stage for FREE_TEXT aspects, so a
  // DualSense stayed "Starlight Blue" instead of becoming "Blue". It reads
  // better and it is more accurate, but eBay's aspect lists are what the
  // left-hand filters are built from — a colour outside the list drops the
  // listing out of "Blue", and the precise shade is in the title regardless. It
  // also regressed the GPU, turning a canonical "NVIDIA GeForce GTX 970" back
  // into "GeForce GTX 970". Snap to the list; free text is the last resort.
  const loose = allowed
    .filter(a => normAspect(a).includes(v) || v.includes(normAspect(a)))
    .sort(byLen(1));
  if (loose.length) return loose[0];

  return aspect?.aspectConstraint?.aspectMode === "FREE_TEXT" ? value : null;
}

// UPC-A (12) and EAN-13 share one check-digit rule: weight the digits 3-1-3-1
// from the right of the body, and the last digit is what makes the total land
// on a multiple of ten. Twelve or thirteen digits that fail it are not a
// barcode — they are a mis-scan or somebody's typing.
function validBarcode(code: string): boolean {
  const d = String(code || "").replace(/\D/g, "");
  if (d.length !== 12 && d.length !== 13) return false;
  // All-zero and all-same strings pass the arithmetic and mean nothing.
  if (/^(\d)\1+$/.test(d)) return false;
  const body = d.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    // Rightmost body digit always carries weight 3.
    const weight = (body.length - 1 - i) % 2 === 0 ? 3 : 1;
    sum += Number(body[i]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]);
}

// eBay REFUSES THE WHOLE LISTING OVER ONE OVER-LONG ASPECT VALUE.
// The cap is 65 characters, and the spec table cheerfully carries longer:
// Features on a handheld console arrived as the 88-character run-on "Gyro
// Controls Hall Effect Joysticks and Triggers Fingerprint Scanner Hall Effect
// Triggers", which killed the publish with 25002 over an aspect eBay did not
// even require. Losing a listing to an optional field is the wrong trade.
//
// Order of preference, most faithful first:
//   1. If the category publishes a value list, send every listed value that
//      appears in our text. Aspects like Features are multi-value by nature,
//      and this turns one unusable string into several correct entries.
//   2. Otherwise trim at a word boundary — still true, just shorter. Only for
//      free text; a truncated value would not survive a closed list.
//   3. Otherwise leave the aspect out, and let a genuinely required one fail
//      with eBay naming it, which humanError already turns into English.
const ASPECT_MAX = 65;

function fitAspect(value: string, def: any): string[] | null {
  if (value.length <= ASPECT_MAX) return [value];

  const allowed: string[] = (def?.aspectValues || [])
    .map((v: any) => v.localizedValue).filter(Boolean);
  if (allowed.length) {
    const hay = normAspect(value);
    const found = allowed.filter(a => {
      const n = normAspect(a);
      return n.length >= 4 && hay.includes(n);
    });
    // Longest first, then drop any that is merely a fragment of one already
    // kept, so "Hall Effect Sensor" does not also bring in "Sensor".
    found.sort((a, b) => b.length - a.length);
    const kept: string[] = [];
    for (const f of found) {
      if (!kept.some(k => normAspect(k).includes(normAspect(f)))) kept.push(f);
    }
    if (kept.length) return kept.slice(0, 10);
  }

  const freeText = def?.aspectConstraint?.aspectMode === "FREE_TEXT" && !allowed.length;
  if (freeText) {
    const cut = value.slice(0, ASPECT_MAX);
    const atWord = cut.replace(/\s+\S*$/, "");
    const trimmed = (atWord.length >= 8 ? atWord : cut).trim();
    if (trimmed) return [trimmed];
  }

  return null;
}

function inventoryItemPayload(
  c: Candidate,
  resolvedCondition: string,
  specs: Record<string, string>,
  aspectDefs: any[],
  requiredAspects: string[],
  conditionDescriptors: { name: string; values: string[] }[] = [],
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
    const fitted = legal ? fitAspect(legal, def) : null;
    if (fitted) aspects[name] = fitted;
  }
  // Second pass, required aspects only. Guessing at optional ones would put
  // wrong data on listings for no gain; a missing required one blocks the sale.
  for (const name of requiredAspects) {
    if (aspects[name]) continue;
    const raw = aliasValue(name, specs);
    if (!raw || isPlaceholder(raw)) continue;
    const def = aspectDefs.find(d => d.localizedAspectName === name);
    const legal = legalValue(raw, def);
    const fitted = legal ? fitAspect(legal, def) : null;
    if (fitted) aspects[name] = fitted;
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
  //
  // A BARCODE IS ONLY WORTH SENDING IF IT IS ARITHMETICALLY REAL.
  // eBay checks the check digit and refuses the whole listing over a bad one —
  // "UPC has an invalid value of 056597769440" is a mis-scan or a hand-typed
  // number, not a category problem, and it blocked a listing whose category had
  // just been corrected. Length alone never caught it: twelve wrong digits are
  // still twelve digits. Sending nothing is the honest move; a UPC we cannot
  // verify would attach the listing to the wrong catalogue entry, which is
  // worse than having none.
  const upcRaw = (specs["UPC"] || "").replace(/\D/g, "");
  const upc = validBarcode(upcRaw) ? upcRaw : "";

  // Where the category demands one, say so in eBay's own words rather than
  // passing the bad number through the aspect route instead.
  if (upcRaw && !upc) {
    const upcDef = aspectDefs.find((d: any) => normAspect(d.localizedAspectName) === "upc");
    if (upcDef) aspects[upcDef.localizedAspectName] = ["Does not apply"];
  }

  return {
    availability: { shipToLocationAvailability: { quantity: Math.max(c.quantity, 0) } },
    condition: resolvedCondition,
    // Sibling of condition, not part of product — see descriptorsFor().
    ...(conditionDescriptors.length ? { conditionDescriptors } : {}),
    product: {
      title: ebayTitle(c.title),
      description: clampHtml(c.descriptionHtml || c.title, EBAY_ITEM_DESCRIPTION_MAX),
      imageUrls: c.imageUrls.slice(0, EBAY_MAX_IMAGES),
      // A valid UPC lets eBay match its own catalog entry and fill aspects we
      // never sent, which is far more reliable than our parsing.
      ...(upc ? { upc: [upc] } : {}),
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
  // KEEP MORE THAN eBay'S FIRST GUESS.
  // Only [0] was kept, and when the market sample is empty that single guess is
  // the ENTIRE picker. A Hisense laser projector drew "TV Boards, Parts &
  // Components" and a store opening the dropdown saw one wrong option and no
  // projector anywhere — the right category was in eBay's own list all along,
  // just not first. Ranked, so the head of the list is unchanged.
  const suggestions = (sugg.body?.categorySuggestions || [])
    .map((s: any) => s.category)
    .filter((c: any) => c?.categoryId)
    .slice(0, 6)
    .map((c: any) => ({ id: c.categoryId, name: c.categoryName }));
  const suggested = suggestions[0] || null;

  const live = await api(
    `/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=50`);

  // Browse is a nice-to-have, not a dependency. If it is unavailable or the
  // query matched nothing, say so plainly and fall back to the taxonomy rather
  // than pretending to a confidence we do not have.
  if (live.status >= 300) {
    return { query: q, suggested, suggestions, market: null, recommended: suggested,
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

  // ⚠️ THE MARKET SAMPLE IS DOMINATED BY ACCESSORIES FOR ANY POPULAR DEVICE.
  // Searching an iPad Air's model number returns mostly CASES for that iPad —
  // 70% of the sample — because every case listing names the device it fits. So
  // "what do the same items sell in" answered "Cases, Covers, Keyboard Folios"
  // and overrode eBay's own correct suggestion of Tablets & eBook Readers. Same
  // shape on an external USB drive, where 44% of the sample was Internal Hard
  // Disk Drives. Both were caught auditing OVL's live listings.
  //
  // The tell is that eBay's suggestion is ITSELF in the sample, just outnumbered
  // — the iPad's real category held 30%. An accessory swarm cannot make the
  // device's own category disappear, it can only outvote it. So when the
  // taxonomy's answer appears in the market at all, take it: eBay matched on the
  // words of THIS item, while the market only matched on items that mention it.
  // The market data still rides along in the response, so the picker keeps
  // showing the reasoning and a person can override on sight of the item.
  const suggestedInMarket = !!suggested && ranked.some(r => r.id === suggested.id);
  const useMarket = confident && !suggestedInMarket;

  return {
    query: q,
    suggested,
    suggestions,
    market: ranked.slice(0, 5).map(r => ({ ...r, share: Math.round((r.n / (sampled || 1)) * 100) })),
    sampled,
    recommended: useMarket ? { id: best!.id, name: best!.name } : suggested,
    basis: useMarket ? "market"
      : suggestedInMarket ? "taxonomy (confirmed by market)"
      : "taxonomy",
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

  // --- fix: take the answer, write it into Shopify --------------------------
  // POST { fields: { "Professional Grader": "PSA", "Grade": "10" } }
  //
  // Listing is deliberately NOT done here. ebay-channel calls this and then runs
  // its own list path, so the retry goes through exactly the same code as any
  // other upload — a fixed listing that behaved differently from a normal one
  // would be a second route to maintain and a second one to get wrong.
  if (url.searchParams.get("fix") === "1") {
    if (!sku) return json({ error: "pass &sku=" }, 400);
    let raw: any = null;
    try { raw = await req.json(); } catch { /* no body */ }
    const entries = Object.entries((raw && raw.fields) || {})
      .map(([k, v]) => [String(k).trim(), String(v ?? "").trim()] as [string, string])
      .filter(([k, v]) => k && v);
    if (!entries.length) {
      return json({ error: `pass a JSON body: { "fields": { "Grade": "10" } }` }, 400);
    }

    const found = await findProducts(shop, shopToken, `sku:${sku}`, 10);
    const c = found.find(m => m.sku === sku);
    if (!c) return json({ error: `sku ${sku} not found in ${shop}` }, 404);

    try {
      const written = await writeSpecsToShopify(shop, shopToken, c, entries);
      return json({ store, sku, fixed: true, fields: Object.fromEntries(entries), ...written });
    } catch (e) {
      // A SCOPE PROBLEM MUST NOT READ AS A BAD ANSWER.
      // Every token here was granted read_products only, so until the app is
      // re-installed with write_products this is the error that comes back — and
      // "shopify refused the fix" in front of somebody who typed a correct grade
      // sends them looking in the wrong place entirely.
      const detail = String((e as Error)?.message || e);
      const denied = /access denied|not approved|scope|unauthorized|permission/i.test(detail);
      return json({
        store, sku, error: denied
          ? OURS + "SPEEKS Connect can read this Shopify store but cannot write to it "
            + "yet, so the answer could not be saved. The Shopify app has to be "
            + "re-installed with permission to edit products before Fix will work."
          : `could not write to Shopify: ${detail}`,
        detail, needsWriteScope: denied,
      }, denied ? 403 : 502);
    }
  }

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

  // --- what does a category actually accept? --------------------------------
  // "Brand has an invalid value" does not say what a valid one would be, and
  // that is the whole question when a listing is refused over an aspect. This
  // dumps eBay's own definitions for a category so the answer is readable
  // instead of inferred: which aspects are required, which are closed lists,
  // and exactly what is on each list.
  //   ?aspects=1&category=56083          by id
  //   ?aspects=1&sku=KS01-...            by whatever the sku resolves to
  //   &aspect=Brand                      just that one
  if (url.searchParams.get("aspects") === "1") {
    const aspectApi = ebayClient(HOSTS[row.environment], await accessTokenFor(row));
    let categoryId = (url.searchParams.get("category") || "").trim();
    if (!categoryId) {
      if (!sku) return json({ error: "pass &category=<id> or &sku=" }, 400);
      const found = await findProducts(shop, shopToken, `sku:${sku}`, 10);
      const item = found.find(m => m.sku === sku);
      if (!item) return json({ error: `sku ${sku} not found in ${shop}` }, 404);
      categoryId = (await recommendCategory(aspectApi, item.title)).recommended?.id || "";
      if (!categoryId) return json({ error: "no category resolved for that sku" }, 422);
    }
    const res = await aspectApi(
      `/commerce/taxonomy/v1/category_tree/${CATEGORY_TREE_ID}/get_item_aspects_for_category`
      + `?category_id=${encodeURIComponent(categoryId)}`);
    if (res.status >= 300) {
      return json({ error: "eBay would not describe that category", detail: errText(res.body) }, 502);
    }
    const only = (url.searchParams.get("aspect") || "").trim().toLowerCase();
    const aspects = (res.body?.aspects || [])
      .filter((a: any) => !only || String(a.localizedAspectName).toLowerCase() === only)
      .map((a: any) => ({
        name: a.localizedAspectName,
        required: !!a.aspectConstraint?.aspectRequired,
        mode: a.aspectConstraint?.aspectMode,
        closedList: (a.aspectValues || []).length > 0,
        values: (a.aspectValues || []).map((v: any) => v.localizedValue),
      }));
    return json({ categoryId, count: aspects.length, aspects });
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

  // ⚠️ THE MARKETPLACE-CONNECT OWNERSHIP GUARD LIVES HERE, IN THE ENGINE.
  // It used to exist only in ebay-channel, the browser's route. Every other way
  // in — this function called directly with the operator secret, a cron, a
  // future caller — walked straight past it and published over a live MC
  // listing. That is not hypothetical: three listings across WSP, MPL and BAL
  // were taken over exactly this way while *testing the guard*, because the test
  // used the unguarded route. A safety net that only one of four callers goes
  // through is not a safety net.
  //
  // The old comment in ebay-channel said this check could not live here, since
  // ebay-sync only knows the Inventory API and the Inventory API cannot see
  // Trading-API listings. True about eBay, irrelevant here: the check reads
  // `ebay_live` — OUR table, swept from GetMyeBaySelling, which does see MC —
  // and this function already talks to that database on every publish.
  //
  // Re-pushing something WE listed stays allowed: ownership is decided by an
  // ebay_listings row carrying a real listing id, not by presence in ebay_live
  // (our own published listings appear there too, on the next sweep).
  if (url.searchParams.get("force") !== "1") {
    const liveRows = await (await sb(
      `ebay_live?store_code=eq.${encodeURIComponent(store)}`
      + `&sku=eq.${encodeURIComponent(sku)}&select=item_id`)).json();
    if (liveRows.length) {
      const mineRows = await (await sb(
        `ebay_listings?store_code=eq.${encodeURIComponent(store)}`
        + `&sku=eq.${encodeURIComponent(sku)}&select=ebay_listing_id`)).json();
      if (!mineRows[0]?.ebay_listing_id) {
        // ASK eBay BEFORE REFUSING. ebay_live is a CACHE, refreshed by a sweep
        // every 20 minutes, and the most common reason to be listing a SKU
        // through SPEEKS Connect is that somebody just ended it in Marketplace
        // Connect in order to move it across. For up to twenty minutes after
        // they do, this guard refused them and the message told them to go and
        // end a listing they had already ended — a dead end with a Try Again
        // button that could only fail identically. Seen on three OVL SKUs at
        // once. One Browse lookup on the cached id settles it, and it only
        // runs on the refusal path, so the happy path costs nothing.
        const stale = [];
        let stillLive = null;
        for (const r of liveRows) {
          if (!r.item_id) continue;
          // Only a definite "not active" clears it. null means eBay could not
          // tell us, and that has to fail closed: the expensive mistake is
          // publishing over a listing that really is live.
          const active = await itemStillActive(row, r.item_id);
          if (active === false) stale.push(r.item_id);
          else { stillLive = r.item_id; break; }
        }
        // Drop what eBay says is gone so the panel and the next attempt agree,
        // rather than waiting on the sweep to notice.
        for (const id of stale) {
          await sb(`ebay_live?store_code=eq.${encodeURIComponent(store)}`
            + `&sku=eq.${encodeURIComponent(sku)}&item_id=eq.${encodeURIComponent(id)}`,
            { method: "DELETE" }).catch(() => {});
        }
        if (stillLive) {
          return json({
            store, sku, step: "ownership",
            error: OURS + `This SKU is already live on ${store}'s eBay account and SPEEKS Connect `
              + `did not put it there, which almost always means Marketplace Connect did. `
              + `Listing it again would overwrite MC's record and leave two systems fighting `
              + `over one physical unit — and if it sells, the sale would be imported into `
              + `Shopify twice. Take it down in Marketplace Connect first if you want SPEEKS `
              + `Connect to own it.`,
            alreadyLiveItemId: stillLive,
            viewUrl: `https://www.ebay.com/itm/${stillLive}`,
            // Deliberately fires on dry runs too. A dry run that reports "clean"
            // for a SKU that must not be published reads as permission, and the
            // preview → list flow means that is exactly when it would be read.
            // &force=1&dry=1 inspects one safely, since dry never writes.
            override: "&force=1 publishes anyway — for the day MC is switched off. "
              + "&force=1&dry=1 inspects without publishing.",
          }, 409);
        }
      }
    }
  }

  // A RENAMED SKU SLIPS PAST THE GUARD ABOVE, BECAUSE THE GUARD MATCHES ON SKU.
  // Split a shared SKU into new ones in Shopify and the physical unit stays live
  // on eBay under the OLD SKU while the new one looks untouched — upload it and
  // there are two live listings against one unit, with nothing to warn anybody.
  // Happened the moment three shared SKUs were split at OVL.
  //
  // The title is the thread that still connects them, since MC built its listing
  // from the same Shopify product. But a title match is NOT proof: identical
  // stock legitimately shares one (two SimpliSafe sensors at BAL match each other
  // exactly) and refusing those would block real listings. So this warns and
  // publishes. The judgement belongs to the person holding the item.
  let titleWarning: any = null;
  if (url.searchParams.get("force") !== "1") {
    const sameTitle = await (await sb(
      `ebay_live?store_code=eq.${encodeURIComponent(store)}`
      + `&title=eq.${encodeURIComponent(c.title)}&select=sku,item_id&limit=4`)).json();
    const others = (sameTitle || []).filter((r: any) => r.sku !== sku);
    if (others.length) {
      titleWarning = {
        message: `An item with this exact title is already live on ${store}'s eBay account `
          + `under a different SKU (${others.map((o: any) => o.sku).join(", ")}). If this SKU was `
          + `renamed in Shopify, that listing is the same physical unit and there are now two `
          + `— end the old one on eBay. If it is genuinely a second copy, nothing is wrong.`,
        liveUnder: others.map((o: any) => ({ sku: o.sku, itemId: o.item_id,
          viewUrl: `https://www.ebay.com/itm/${o.item_id}` })),
      };
    }
  }

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

  // Table first, metafields underneath it: where both speak, the buyer-facing
  // table wins and nothing that already worked changes.
  const specs = { ...specsFromMetafields(c.metafields || {}), ...parseSpecs(c.descriptionHtml) };

  // Ask the category which conditions it will accept BEFORE building the item.
  const conditionPolicy = await conditionPolicyFor(api, categoryId);
  const allowedConditions = conditionIdsOf(conditionPolicy);
  const picked = conditionFrom(specs, condition, c.metafields || {});
  // Hoisted above the first refusal that can use it: the unsupported-condition
  // branch below needs the same list, and computing it twice invites the two
  // copies to drift.
  const condWords = conditionWordsAllowed(allowedConditions);
  // One object, every failure path. Nothing after this point changes the
  // product, so a single snapshot is honest for all of them.
  const evidence = buildEvidence(c, specs, picked, condWords);

  // An unrecognised condition word stops the listing. Guessing here would mean
  // publishing a grade nobody chose, and the grade is the field a buyer leans on
  // hardest — better a listing that did not go up than one that overstates the
  // goods. An explicit ?condition= is a person deciding on purpose, so it wins.
  if ((picked.unknown || picked.missing) && !url.searchParams.get("condition")) {
    const msg = OURS + (picked.missing
      ? `This product has no Condition on it in Shopify, so SPEEKS Connect will not list it — `
        + `with the field blank the only thing it could do is assume a grade, and the assumption `
        + `it used to make was "Excellent". Add a Condition row to the product's description `
        + `specs in Shopify, set to one of: ${CONDITION_WORDS}. Then upload the SKU again.`
      : `The product's Condition reads "${picked.unknown}", which is not a condition `
        + `SPEEKS Connect recognises, so it will not guess one — guessing here would put a grade `
        + `on eBay that nobody chose. Set the Condition on the Shopify product to one of: `
        + `${CONDITION_WORDS}.`);
    // Condition is ours, not eBay's — it is the Condition row in the spec table
    // that the whole mapping reads from, so the prompt offers our vocabulary.
    const condMissing: MissingField[] = withSuggestions(
      [{ name: "Condition", allowed: CONDITION_CHOICES, kind: "condition" }],
      c, specs,
    );
    if (!dry) {
      await recordFailure(store, c, categoryId, msg, undefined, categoryName, condMissing,
                          evidence);
    }
    return json({ store, sku, step: "condition", error: msg, missing: condMissing,
                  conditionFound: picked.unknown, conditionMissing: picked.missing }, 422);
  }

  const wantedCondition = picked.value;
  const cond = adjustCondition(wantedCondition, allowedConditions);

  // ASK BEFORE eBay REFUSES, WHEN WE ALREADY KNOW IT WILL.
  // adjustCondition nudges a condition to a neighbour in the same family; when
  // there is no neighbour it hands back `unsupported`, and we would go on to
  // send a value the category has already told us it does not take. That round
  // trip buys nothing and costs the store a 25059 to read.
  if (cond.unsupported && condWords.length) {
    const msg = OURS + `eBay will not take "${wantedCondition.replace(/_/g, " ").toLowerCase()}" `
      + `as the condition in ${categoryName || "this category"} — the grade on the product is `
      + `not one this category allows. It will take: ${condWords.join(", ")}. Set the `
      + `Condition on the Shopify product to one of those and upload again.`;
    const condMissing: MissingField[] = [
      { name: "Condition", allowed: condWords, kind: "condition" },
    ];
    if (!dry) {
      await recordFailure(store, c, categoryId, msg, undefined, categoryName, condMissing,
                          evidence);
    }
    return json({ store, sku, step: "condition", error: msg, missing: condMissing,
                  conditionWanted: wantedCondition, allowedHere: condWords }, 422);
  }
  // Descriptors hang off the CHOSEN condition, so this can only run once the
  // condition is settled — Graded and Ungraded demand different fields.
  const condEntry = (conditionPolicy || [])
    .find((e: any) => Number(e.conditionId) === CONDITION_IDS[cond.condition]);
  const desc = descriptorsFor(condEntry, specs);
  if (desc.missing.length) {
    const lines = desc.missing.map(m =>
      m.name + (m.allowed.length ? ` — one of: ${m.allowed.slice(0, 24).join(", ")}` : ""));
    const many = desc.missing.length > 1;
    const msg = OURS + `eBay needs ${many ? "more fields" : "one more field"} before it will `
      + `take this as "${condEntry?.conditionDescription || cond.condition}" in `
      + `${categoryName || "this category"}. Add ${many ? "these rows" : "this row"} to the `
      + `product's spec table in Shopify, then upload again: ${lines.join("  |  ")}`;
    // Descriptors are ABSENT rather than rejected, so unlike the condition case
    // above there is no wrong answer to accidentally offer back.
    const descMissing: MissingField[] = withSuggestions(desc.missing.map(m => ({
      name: m.name, allowed: m.allowed, kind: "descriptor" as const,
    })), c, specs);
    if (!dry) {
      await recordFailure(store, c, categoryId, msg, undefined, categoryName, descMissing,
                          evidence);
    }
    return json({ store, sku, step: "conditionDescriptors", error: msg,
                  missing: descMissing }, 422);
  }
  const item = inventoryItemPayload(c, cond.condition, specs, aspectDefs, required, desc.values);

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
      titleWarning,
      specsParsed: specs,
      metafields: c.metafields,
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
  // Everything below can fail on a field eBay wants and the product does not
  // carry. condEntry and aspectDefs are the category's own vocabulary, which is
  // what turns eBay's wording into a field somebody can be asked for.
  // Suggestions are attached here rather than inside missingFromEbayError,
  // which only knows the CATEGORY. What the product itself says is the other
  // half of the answer, and it lives out here.
  const missingFrom = (b: any) => {
    const found = withSuggestions(
      missingFromEbayError(b, aspectDefs, condEntry), c, specs);
    if (found.length) return found;

    // 25059 NAMES NO FIELD, WHICH IS WHY IT USED TO BE A DEAD END.
    // "Condition information 3000 does not exist or is not a valid condition
    // for category X" is answerable — the category told us what it takes — but
    // it matches none of the missing-aspect shapes, so the row sat failed with
    // no Fix button and nothing a person could type. It is a question now.
    //
    // NOTHING IS SUGGESTED HERE. Every other field suggests from the product,
    // and the product's condition is the exact value eBay just refused —
    // offering it back would be pre-filling the wrong answer.
    const words = conditionWordsAllowed(allowedConditions);
    if (words.length && /\b25059\b|not a valid condition/i.test(errText(b))) {
      return [{ name: "Condition", allowed: words, kind: "condition" as const }];
    }
    return [];
  };

  if (put.status >= 300) {
    await recordFailure(store, c, categoryId, `inventory_item: ${errText(put.body)}`,
                        undefined, categoryName, missingFrom(put.body), evidence);
    return json({ step: "inventory_item", status: put.status, error: errText(put.body),
                  missing: missingFrom(put.body) }, 502);
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
      await recordFailure(store, c, categoryId, `offer: ${errText(offerRes.body)}`,
                          undefined, categoryName, missingFrom(offerRes.body), evidence);
      return json({ step: "offer", status: offerRes.status, error: errText(offerRes.body),
                    missing: missingFrom(offerRes.body) }, 502);
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
      await recordFailure(store, c, categoryId, `offer update: ${errText(upd.body)}`,
                          offerId, categoryName, missingFrom(upd.body), evidence);
      return json({ step: "offer update", status: upd.status, error: errText(upd.body),
                    missing: missingFrom(upd.body) }, 502);
    }
    updatedExisting = true;
  }

  // --- 3. publish -----------------------------------------------------------
  const pub = await api(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {
    method: "POST",
  });
  if (pub.status >= 300) {
    const pubMissing = missingFrom(pub.body);
    await recordFailure(store, c, categoryId, `publish: ${errText(pub.body)}`,
                        offerId, categoryName, pubMissing, evidence);
    return json({
      step: "publish",
      status: pub.status,
      error: errText(pub.body),
      categoryId,
      requiredAspects: required,
      missing: pubMissing,
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
    missing_fields: null,
    published_at: new Date().toISOString(),
  }, categoryName);

  return json({
    store, sku,
    published: true,
    titleWarning,
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
  categoryName: string | null = null, missingFields: MissingField[] | null = null,
  evidence: Evidence | null = null,
) {
  await upsertListing(store, c, categoryId, {
    status: "failed",
    last_error: error,
    // Rewritten on every failure, like missing_fields and for the same reason:
    // evidence from a refusal two edits ago would explain a listing nobody is
    // looking at.
    evidence: evidence || null,
    // Written on EVERY failure, including as null. A row that failed last time
    // on a missing Grade and this time on something else must not keep offering
    // a Fix form for a field eBay has stopped asking about.
    missing_fields: (missingFields && missingFields.length) ? missingFields : null,
    ...(offerId ? { ebay_offer_id: offerId } : {}),
  }, categoryName);
}
