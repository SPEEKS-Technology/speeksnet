// ============================================================================
// listing-titles — the third tool on the Listing Health page.
//
// TWO WAYS IN, and they authenticate differently, exactly as shopify-recat does.
//
//   THE PANEL (SPEEKS Connect → Listing Health → Titles), x-user-pin:
//     GET  ?view=review&store=OVL     the queue, one row per product
//     GET  ?view=counts               per-store open totals and nothing else —
//                                     what the page header and the feed read
//     POST {action:"approve", store, productId, title?}   writes Shopify
//     POST {action:"deny",    store, productId, reason}
//
//   THE SWEEP, ?secret= :
//     ?sweep=1&store=OVL                    DRY RUN: what it would queue
//     ?sweep=1&store=OVL&save=1&secret=...   write the queue rows
//     ?sweep=1&store=OVL&market=1&secret=... also ask eBay (slower, see below)
//     ?limit=60                              products examined in one run
//
// ⚠️ `save=1` PERSISTS SUGGESTIONS. IT NEVER TOUCHES A LISTING. The only thing
// in this function that writes to a live catalogue is POST approve, and that
// needs a person's PIN and one product id. There is deliberately no bulk apply
// and no cron that applies: a title is customer-facing prose, and the whole
// value of the tool is that somebody read it.
//
// WHAT IT IS FOR. Not mainly SEO. See the 0067 migration header for the sample
// that motivated it — a $1,499 camera titled after a model that does not exist,
// mirrorless bodies labelled DSLR, six internal wipe-station items listed to the
// public, and three listings whose eBay title contradicts Shopify's.
//
// WHY THERE ARE NO SOLD COMPS. eBay retired findCompletedItems, and the sold
// data replacement — the Marketplace Insights API — is a Limited Release that
// eBay describes as "restricted and not open to new users"; as of mid-2026 it is
// major-partners-only and our token does not carry buy.marketplace.insights.
// So `market=1` samples ACTIVE listings through Browse, which needs no new scope
// and which we already use for category recommendation. eBay's Best Match
// ranking is itself sales-weighted, so the head of an active-listing sample is a
// reasonable proxy for what sells — but it is NOT sold data and nothing here
// claims it is. The panel says "Active Listings" for that reason.
//
// HOW A SUGGESTION IS BUILT, and this is the load-bearing decision:
// EVERY SUGGESTION IS THE CURRENT TITLE PLUS NAMED EDITS. It is never a
// from-scratch rewrite. Each finding contributes one explainable edit, so every
// character of the diff traces to a sentence on the row, and a title that is
// already good cannot be scrambled by a confident-sounding rewriter. Findings
// that we cannot safely fix (a model name that matches nothing; a listing that
// should not exist) contribute NO edit and leave `suggested_title` null, which
// makes the panel demand that a person type one.
//
// See [[listing-health-photos]] for the page, [[ebay-channel-ui]] for the
// accessory-swarm trap that governs comp sampling, [[db-rls-convention]],
// [[alert-message-plain-english]] and [[title-case-headers]].
// ============================================================================

// The same SDK and the same key daily-brief already uses — nothing new to
// provision. Only the name check touches it; every other finding in this file
// is rules and costs nothing to run.
import Anthropic from "npm:@anthropic-ai/sdk";
import { z } from "npm:zod";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk/helpers/zod";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// One verdict per listing we asked about. `id` is the Shopify product id, echoed
// back so a reordered or short answer can still be matched to the right row.
const NameReportSchema = z.object({
  results: z.array(z.object({
    id: z.string(),
    verdict: z.enum(["ok", "garbled", "wrong"]),
    wrong_text: z.string().optional(),
    correct_text: z.string().optional(),
    why: z.string().optional(),
  })),
});
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

const EBAY_HOSTS = { production: "https://api.ebay.com", sandbox: "https://api.sandbox.ebay.com" };
const EBAY_TITLE_MAX = 80;

// ⚠️ THIS MUST MATCH `def` FOR ec-view-titles IN FEATURE_CATALOG (speeks.js).
// A backend that says yes while the button says no is a tool reachable by URL
// that nobody can see; the reverse is a grant that 403s. Same trap as
// [[kpi-role-gate]] and the same shape shopify-recat documents for its two keys.
//
// Ethan, 2026-08-28: "all 5 managers and asms see their stores and then DM sees
// all 5." So the store roles AND assistant managers are in by default — an ASM
// is usually the person who wrote the title. MOCD is excluded for the same
// reason ec-view-photos excludes them: their Listing Health access was revoked
// by hand, and a new key defaulting on would re-open the page under a new name.
const CORP_ROLES = ["district manager", "ceo", "mocd"];
const STORE_ROLES = ["manager", "owner (manager)", "owner manager", "multi-store manager"];
const EXTRA_ROLES = ["assistant manager"];
const MSM_STORES = ["BAL", "MPL"];
const TITLES_KEY = "ec-view-titles";

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

// ⚠️ POSTGREST CAPS A RESPONSE AT 1000 ROWS AND SAYS NOTHING ABOUT IT.
// `&limit=2000` does not raise the cap — it is silently ignored, the request
// returns 200, and the caller believes it has everything. OVL is at 798 in-scope
// SKU rows today, so the candidate read is inside the cap by about 20% — which
// means growth, not a code change, is what would break it, and it would break by
// quietly never examining the newest stock. Same trap ebay-channel documents for
// the eBay sweeps.
async function allRows(path: string, pageSize = 900): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += pageSize) {
    const res = await sb(path, {
      headers: { Range: `${from}-${from + pageSize - 1}`, "Range-Unit": "items" },
    });
    const page = await res.json();
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

// --- who is asking ----------------------------------------------------------

type Scope = { name: string; role: string; stores: string[]; corp: boolean };

// Resolved the way the site resolves it: the person beats their role, and
// neither existing means "use the default". Null for "nothing said".
async function featureSays(key: string, role: string, name: string): Promise<boolean | null> {
  const list = await rows(`feature_overrides?feature_key=eq.${encodeURIComponent(key)}`
    + `&select=subject_type,subject,enabled`);
  const lc = (v: unknown) => String(v || "").toLowerCase().trim();
  // "Owner (Manager)" -> "owner-manager", the slug the Feature Access tool writes.
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
  const byRole = (corp && role !== "mocd")
    || STORE_ROLES.includes(role) || EXTRA_ROLES.includes(role);
  const said = await featureSays(TITLES_KEY, role, String(user.name || ""));
  if (!(said === null ? byRole : said)) return null;
  // A granted role still only gets ITS OWN stock. Feature Access answers "may
  // this person review titles", never "whose catalogue" — that stays the store
  // on their user row, and corp is the only thing that means all five.
  const stores = corp ? STORES
    : role === "multi-store manager" ? MSM_STORES
    : [String(user.store || "").toUpperCase()].filter(s => STORES.includes(s));
  if (!stores.length) return null;
  return { name: String(user.name || ""), role, stores, corp };
}

// --- shopify ----------------------------------------------------------------

async function shopFor(store: string): Promise<{ shop: string; token: string }> {
  const all = await rows(`shopify_stores?select=shop,store_code,access_token`);
  // ⚠️ shopify_stores.store_code is NULL on every row, so the domain map is what
  // actually resolves this. Kept in that order anyway so it starts working the
  // day somebody backfills the column.
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
  // ⚠️ Shopify returns THROTTLING AS A 200 with an `errors` array — the same
  // trap ebay-catalog and shopify-recat both document. A thrown error here is
  // what keeps a throttled batch from being silently counted as done.
  if (body.errors) throw new Error(`shopify: ${JSON.stringify(body.errors).slice(0, 400)}`);
  return body.data;
}

// What the analyser needs from Shopify that ebay_catalog does not carry: the
// spec table, and the What's Included list that decides whether "Bundle" is a
// word we have earned. Batched with `nodes(ids:)` so one request covers a page
// of candidates instead of one request each.
type Extra = { specs: Record<string, string>; included: string[] };

const stripTags = (s: string) =>
  s.replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();

// Any <tr> holding exactly two cells is a label/value pair, the same shape
// ebay-sync's parseSpecs reads. Nested markup in the value cell is why the
// match is lazy and stripped afterwards.
function parseSpecs(html: string): Record<string, string> {
  const specs: Record<string, string> = {};
  for (const row of (html.match(/<tr[\s\S]*?<\/tr>/gi) || [])) {
    const cells = row.match(/<td[\s\S]*?<\/td>/gi) || [];
    if (cells.length !== 2) continue;
    const key = stripTags(cells[0]).replace(/[?:]+$/, "").trim();
    const value = stripTags(cells[1]);
    if (key && value) specs[key] = value;
  }
  return specs;
}

// ⚠️ WIDENED FROM A REAL SWEEP. The spec table is filled by hand, so it carries
// stand-ins that are not values: "VARIOUS" as an MPN, "CUSTOM" as a Color,
// "MODEL C" as a model. Appending those to a title makes it worse, and they were
// being appended — "Micron 48GB … SODIMM Low Profile VARIOUS".
const PLACEHOLDER = /^(n\/?a|none|null|undefined|unknown|tbd|-+|\.+|various|varies|custom|generic|assorted|mixed|multiple|misc(ellaneous)?|other|see description|no visible serial|yes|no)$/i;

// WHAT'S INCLUDED IS ALREADY IN SHOPIFY. PayMore's listing tool writes it as a
// `whats_include` metafield, and ebay-sync deliberately SKIPS it as an item
// specific — so the data has been sitting there unused. It is the only
// trustworthy way to know a listing is a bundle: derived from the metafield we
// are accurate by construction, whereas "Bundle" hand-added as an SEO garnish
// on a single item is a search-manipulation problem on an account we share.
function parseIncluded(raw: string, html: string): string[] {
  const text = (raw || "").trim();
  const parts: string[] = [];
  if (text) {
    // Three shapes seen in the wild: a JSON array, a bullet/newline list, and a
    // comma-separated run. Splitting on all of them costs nothing.
    let handled = false;
    if (text.startsWith("[")) {
      try {
        const j = JSON.parse(text);
        if (Array.isArray(j)) {
          for (const v of j) {
            const s = String(typeof v === "object" && v ? (v.value ?? v.key ?? "") : v).trim();
            if (s) parts.push(s);
          }
          handled = true;
        }
      } catch { /* fall through to the text splitters */ }
    }
    if (!handled) {
      for (const p of text.split(/\s*(?:[\r\n]+|[•·]|,|\||;)\s*/)) {
        const s = stripTags(p).trim();
        if (s) parts.push(s);
      }
    }
  }
  // The spec table is the fallback, since the two do not always agree about
  // which fields they carry (the same reason ebay-sync reads both places).
  if (!parts.length && html) {
    const spec = parseSpecs(html);
    const key = Object.keys(spec).find(k => /what'?s? ?includ|included/i.test(k));
    if (key) {
      for (const p of spec[key].split(/\s*(?:,|\||;|\band\b|&)\s*/)) {
        const s = p.trim();
        if (s) parts.push(s);
      }
    }
  }
  // "Item only", "nothing", "N/A" are an EMPTY list, not a one-item bundle.
  return parts
    .filter(s => s.length > 1 && !PLACEHOLDER.test(s))
    .filter(s => !/^(item|device|unit|console)\s*only$/i.test(s))
    .filter(s => !/^no(ne|thing)?\b/i.test(s))
    .slice(0, 12);
}

async function extrasFor(shop: string, token: string, productIds: string[]): Promise<Record<string, Extra>> {
  const out: Record<string, Extra> = {};
  const CHUNK = 25;
  for (let i = 0; i < productIds.length; i += CHUNK) {
    const ids = productIds.slice(i, i + CHUNK);
    const data = await shopifyGql(shop, token, `
      query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product {
        id descriptionHtml
        metafields(first: 60) { edges { node { key value } } }
      } } }`, { ids });
    for (const n of (data?.nodes || [])) {
      if (!n?.id) continue;
      const mf: Record<string, string> = {};
      for (const e of (n.metafields?.edges || [])) {
        const k = String(e?.node?.key || "");
        if (k && !mf[k]) mf[k] = String(e?.node?.value ?? "");
      }
      const html = String(n.descriptionHtml || "");
      out[n.id] = {
        specs: { ...parseSpecs(html) },
        included: parseIncluded(mf["whats_include"] || mf["whats_included"] || "", html),
      };
    }
  }
  return out;
}

// --- ebay Browse ------------------------------------------------------------

type EbayStoreRow = {
  store_code: string; environment: "production" | "sandbox";
  refresh_token: string; access_token: string | null;
  access_token_expires_at: string | null; scopes: string | null;
};

let EBAY_APPS: Record<string, any> = {};
{
  const raw = (Deno.env.get("EBAY_APPS") || "").trim();
  const stripControl = (s: string) =>
    Array.from(s).filter(ch => ch.charCodeAt(0) >= 32).join("");
  for (const text of [raw, stripControl(raw)]) {
    if (!text) break;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") { EBAY_APPS = parsed; break; }
    } catch { /* try the control-stripped copy */ }
  }
}

async function ebayToken(row: EbayStoreRow): Promise<string> {
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
      grant_type: "refresh_token", refresh_token: row.refresh_token, scope: row.scopes || "",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ebay token refresh failed: ${res.status} ${text.slice(0, 300)}`);
  const tok = JSON.parse(text);
  await sb(`ebay_stores?store_code=eq.${encodeURIComponent(row.store_code)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      access_token: tok.access_token,
      access_token_expires_at: new Date(Date.now() + (tok.expires_in ?? 7200) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  return tok.access_token;
}

type Browse = (q: string, categoryId?: string, limit?: number) => Promise<any[] | null>;

// Null means "could not ask", which is NOT the same as "found nothing" — a
// finding built on an empty sample would read as evidence when it is silence.
// Every caller checks for null before drawing a conclusion.
async function browseFor(store: string): Promise<Browse> {
  const row: EbayStoreRow | undefined =
    (await rows(`ebay_stores?store_code=eq.${encodeURIComponent(store)}&select=*`))[0];
  if (!row) return async () => null;
  let token = "";
  try { token = await ebayToken(row); } catch { return async () => null; }
  const host = EBAY_HOSTS[row.environment] || EBAY_HOSTS.production;
  return async (q, categoryId, limit = 25) => {
    if (!q.trim()) return null;
    const params = new URLSearchParams({ q, limit: String(limit) });
    // ⚠️ THE CATEGORY FILTER IS NOT OPTIONAL POLISH. Without it a popular device
    // comes back ~70% accessories, because every case and every charger names
    // the device it fits — measured at 70% on an iPad Air and 44% on a USB
    // drive (see [[ebay-channel-ui]]). Mining keywords from that sample puts
    // "Case Cover Folio" into the title of an actual iPad.
    if (categoryId) params.set("category_ids", categoryId);
    try {
      const res = await fetch(`${host}/buy/browse/v1/item_summary/search?${params}`,
        { headers: { Authorization: `Bearer ${token}`, "Accept-Language": "en-US" } });
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      return body?.itemSummaries || [];
    } catch { return null; }
  };
}

// --- the analyser -----------------------------------------------------------

type Finding = {
  code: string;
  // A sentence a manager can read. Never a rule name — the house rule for
  // anything alert-shaped is that it says what it means and who fixes it.
  says: string;
  // 3 the listing is WRONG. 2 it cannot be FOUND. 1 it is leaving money on the
  // table. The panel sorts on the row's max, so a $1,499 camera named after a
  // model that does not exist cannot sit below forty merely-short titles.
  severity: 1 | 2 | 3;
  // Report-only findings contribute no edit and are the reason a row can arrive
  // with no suggestion at all.
  fixable: boolean;
  // A caution the reviewer must read BEFORE approving, rendered apart from
  // `says` so it cannot be skimmed past. Only for edits where our data is a
  // proxy for something a human has to confirm against the item in their hand.
  warn?: string;
};

// ⚠️ ENTITIES MUST BE DECODED BEFORE NORMALISING, and forgetting it produced a
// false drift finding on the very first real sweep. `norm` strips punctuation to
// spaces, so `&amp;` does not vanish — it becomes the WORD "amp", and
// "Auto & Manual Lens" vs "Auto &amp; Manual Lens" compares as different. That
// is the exact difference the migration header says accounts for 25 of the 29
// title mismatches across the estate, so getting it wrong buries the three that
// matter under the noise.
const decodeEnt = (s: string) => (s || "")
  .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
  .replace(/&#0*39;|&apos;/gi, "'").replace(/&nbsp;/gi, " ")
  .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");

const norm = (s: string) =>
  decodeEnt(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Whole days since an ISO timestamp, or null if it is unreadable. Used only to
// tell a reviewer how old the eBay snapshot behind a drift finding is.
function _daysAgo(iso: string): number | null {
  const ms = Date.now() - Date.parse(iso);
  if (!isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86400000);
}
const tokens = (s: string) => norm(s).split(" ").filter(Boolean);

// Titles that are not listings. Internal ops equipment and placeholders, six of
// which were live to the public at $3,454.94 when this was written. There is no
// title that fixes these — the fix is to unpublish — so the finding is
// report-only and the row arrives with no suggestion on purpose.
const NOT_A_LISTING = [
  /\bwip(e|ing)\s*stations?\b/i,
  /\bfor\s+lee'?s?(\s+summit)?\s*\d*$/i,
  /^(OVL|LEE|WSP|MPL|BAL)\s*\d/i,
  /\b(test\s+(item|product|listing)|placeholder|do\s+not\s+(buy|list|sell)|internal\s+use)\b/i,
  // A title with no spaces at all that mixes letters and digits is a code
  // somebody typed into the wrong box ("OVL4Wiping1"), not a product name.
  /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9._-]{6,}$/,
];

// THE TITLE ASSERTS HARDWARE THE MODEL CONTRADICTS.
// Every rule here came from a real row, not from imagination — a Nikon Z 6 sold
// as a "Digital SLR DSLR", a ZV-E10 sold as L-Mount when it is E-mount. Adding
// one is a single entry, and the shape is deliberately narrow: `when` has to
// match a model family confidently before `claims` is allowed to mean anything.
// ⚠️ EVERY PATTERN HERE NEEDS A NEGATIVE LOOKAHEAD, and both of the ones below
// were caught by the first dry run proposing a SEVERITY 3 LIE.
//   `canon\s+eos\s+r`  matched "Canon EOS **R**ebel T2i" and offered to relabel
//                      a DSLR as mirrorless. Fixed with (?![a-z]).
//   `a[1379]`          matched "Sony Alpha **A1**00", an A-mount DSLR, and would
//                      have done the same. A700/A200 too. Fixed with (?!\d).
// A false positive at severity 3 is worse than no rule: it spends the credibility
// that makes somebody read the true ones. Any rule added here must be tested
// against a real sweep before it ships.
const MIRRORLESS =
  /\b(nikon\s+z\s?\d|canon\s+eos\s+rp?(?![a-z])|sony\s+(alpha\s+)?(a(?:1|7|9)(?:r|s)?(?!\d)|a6\d{3}|zv-?e|nex)|fuji(film)?\s+x-(t|s|pro|e|h)|lumix\s+(s|gh|g)\d|om-?d\b|e-m\d)/i;

const CONFLICTS: { when: RegExp; claims: RegExp; replace?: [RegExp, string]; says: string }[] = [
  {
    // Nikon Z, Canon R/RP, Sony a7/a9/a1/a6xxx/ZV-E/NEX, Fujifilm X-T/X-S/X-Pro,
    // Panasonic S/GH/G, OM System / Olympus E-M — all mirrorless.
    when: MIRRORLESS,
    claims: /\b(dslr|digital\s+slr)\b/i,
    replace: [/\s*\b(digital\s+slr\s+dslr|dslr\s+digital\s+slr|digital\s+slr|dslr)\b/gi, " Mirrorless"],
    says: "The title calls this a DSLR, but this model is a mirrorless camera. A buyer searching DSLR does not want it, and a buyer searching mirrorless cannot find it.",
  },
  {
    // Sony bodies are E-mount. L-Mount is the Panasonic, Sigma and Leica
    // alliance, so this is a factual error about which lenses fit. Scoped to a
    // Sony BODY rather than the word "Sony", so a third-party L-mount lens that
    // happens to name Sony in its title is not caught.
    when: new RegExp(`\\bsony\\b(?=.*${MIRRORLESS.source})|${MIRRORLESS.source}(?=.*\\bsony\\b)`, "i"),
    claims: /\bl-?mount\b/i,
    replace: [/\bl-?mount\b/gi, "E-Mount"],
    says: "The title says L-Mount. Sony bodies are E-mount — L-Mount is the Panasonic, Sigma and Leica alliance, so this tells a buyer the wrong lenses fit.",
  },
];

// TWO DISTINCT MAJOR PRODUCTS IN ONE LISTING IS A BUNDLE. One product plus its
// own charging cable is not.
//
// ⚠️ THIS DELIBERATELY DOES NOT READ `whats_include`. The first version did, and
// proposed adding "Bundle" to 21 of 25 titles including a single Xbox 360 game —
// because that metafield is an ACCESSORY CHECKLIST, not a bundle manifest. Real
// values: a speaker's is "USB Cable, Original Box, Power Cord"; a monitor's is
// "HDMI Cable, Power Adapter"; a game's is "Case, Manual, Inserts". None of
// those is a second product. The real bundles in the estate announce themselves
// in the title instead — "GeForce RTX 4060 Ti 1TB SSD MSI" (a GPU and an SSD),
// "Core i9-13900k and 2x16GB DDR5 FlareX" (a CPU and RAM) — so distinct major
// categories in the title is the signal, and the accessory list stays out of it.
const MAJOR_CATEGORIES: [string, RegExp][] = [
  ["graphics card", /\b(gpu|graphics\s+card|geforce|radeon|rtx|gtx|quadro)\b/i],
  ["storage", /\b(ssd|hdd|nvme|hard\s+drive|solid\s+state)\b/i],
  ["processor", /\b(cpu|processor|core\s+i[3579]|ryzen|xeon|threadripper)\b/i],
  ["memory", /\b(\d+gb\s+(ddr\d|ram)|ddr\d\b|\bram\b)/i],
  ["monitor", /\b(monitor|display)\b/i],
  ["laptop", /\b(laptop|notebook|macbook|chromebook)\b/i],
  ["console", /\b(playstation|ps[345]\b|xbox|nintendo\s+switch|wii)\b/i],
  ["phone", /\b(iphone|galaxy\s+s\d|pixel\s+\d|smartphone)\b/i],
  ["camera body", /\b(camera|dslr|mirrorless)\b/i],
  ["lens", /\b(lens|nikkor|\d+-\d+mm)\b/i],
  ["printer", /\b(printer|scanner)\b/i],
  ["tablet", /\b(ipad|tablet)\b/i],
];

// A bundle word already present. `set`, `lot` and `kit` count as "already said"
// but are NEVER written by the fixer — they carry specific promises to a buyer
// that only the person holding the item can make.
const BUNDLE_WORDS = /\b(bundle|kit|lot|set|combo)\b/i;

// Redundant synonym runs the listing tool emits by category. "Digital SLR DSLR
// Camera" says the same thing twice and spends 12 of 80 characters doing it.
// ⚠️ RETIRED 2026-08-28, and NOT because it was inaccurate.
// "Digital SLR DSLR Camera" really is redundant — but Ethan: "that's just the
// name of one of the Type category options" in PayMore's listing software. So it
// is a CORP VOCABULARY choice reaching 21 titles, not 21 mistakes, and a store
// manager approving 21 rewrites does not stop the 22nd being generated tomorrow.
// The fix is one Type value at corp; queueing the symptom would spend a
// manager's attention on something they cannot actually fix.
//
// Kept as data rather than deleted so the list is here the day corp changes the
// vocabulary and somebody wants to clean up the back catalogue in one pass.
const REDUNDANT_RETIRED: [RegExp, string][] = [
  [/\bdigital\s+slr\s+dslr\b/gi, "DSLR"],
  [/\bdslr\s+digital\s+slr\b/gi, "DSLR"],
  [/\bssd\s+solid\s+state\s+drive\b/gi, "SSD"],
  [/\bhdd\s+hard\s+drive\b/gi, "HDD"],
];

// A title with none of these names no product at all. Drawn from what the five
// catalogues actually sell — a monitor with no "Monitor" in it ("Codi 34"
// MO34H-UC 4K LED Mini-LED Ultra Wide") is invisible to the search that would
// have bought it.
const PRODUCT_NOUNS = [
  "monitor", "laptop", "notebook", "desktop", "computer", "pc", "camera", "lens",
  "console", "phone", "smartphone", "tablet", "watch", "headphones", "headphone",
  "earbuds", "headset", "speaker", "soundbar", "receiver", "amplifier", "amp",
  "keyboard", "mouse", "router", "modem", "switch", "server", "tv", "television",
  "projector", "printer", "scanner", "drive", "ssd", "hdd", "card", "gpu",
  "processor", "cpu", "motherboard", "ram", "memory", "controller", "game",
  "guitar", "bass", "drum", "piano", "keyboard", "microphone", "mixer",
  "turntable", "radio", "charger", "adapter", "cable", "battery", "case",
  "bag", "tripod", "gimbal", "drone", "scooter", "bike", "vacuum", "blender",
  "kit", "bundle", "lot", "set", "system", "player", "recorder", "deck",
  "telescope", "binoculars", "airpods", "ipad", "iphone", "macbook",
  // Added after the first full sweep named them as gaps, each one a title that
  // was falsely accused of not saying what it is.
  "supply", "glasses", "subwoofer", "equalizer", "amplifier", "smartwatch",
  // Power tools — a whole department at MPL that had none of its nouns listed.
  "stick", "streamer", "dongle", "remote", "soundbar", "turntable", "mixer",
  "level", "wrench", "driver", "drill", "grinder", "sander", "saw", "ratchet",
  "impact", "bandfile", "nailer", "stapler", "blower", "trimmer", "doorbell",
  "multimeter", "inflator", "gauge", "light", "flashlight", "heater", "pump",
  "base", "servo", "console", "figure", "card", "wheel", "pedal", "stand",
  "motherboard", "headphones", "webcam", "dock", "hub", "lamp", "fan", "chair",
  // Named by the 2026-09-03 shelf census as titles that DO say what they are
  // and were being accused anyway: "TI-84+ CE" (Graphing Calculator),
  // "Nintendo Wii U Gamepad", "1000W Modular PSU", "CPU & Motherboard Combos".
  "calculator", "gamepad", "psu", "combo",
];

// ⚠️ PLURALS. The list is singular and the match used to be exact, so "Bargain
// Bin Monitors", "Bargain Bin Keyboards" and "Bargain Tech Bags" were all
// accused of never saying what they are — while saying it plainly. Singularise
// the token before testing: cards→card, lenses→lens, switches→switch,
// batteries→battery.
const singularToken = (t: string): string =>
  /ies$/.test(t) && t.length > 4 ? t.slice(0, -3) + "y"
    : /(s|x|z|ch|sh)es$/.test(t) ? t.slice(0, -2)
      : /[^s]s$/.test(t) && t.length > 3 ? t.slice(0, -1)
        : t;

// A token counts as naming the product when it IS a listed noun, or when it
// ENDS with a listed noun of five or more characters — long enough that
// "smartwatch"/"watch" and "smartphone"/"phone" match while "briefcase"/"case"
// and "keycard"/"card" (both four) cannot.
const isProductNoun = (t: string): boolean => {
  const one = singularToken(t);
  return [t, one].some(w =>
    PRODUCT_NOUNS.includes(w)
    || PRODUCT_NOUNS.some(n => n.length >= 5 && w.length > n.length && w.endsWith(n)));
};

// Words whose final "s" is not a plural we may strip. Two kinds: product words
// that ARE plural (nobody searches for "a headphone"), and singulars that merely
// end in s — "Other Camera Lens" became "Camera Len" the first time this ran,
// which is the whole reason the list is written down rather than reasoned about.
const KEEP_PLURAL = new Set([
  "headphones", "glasses", "airpods", "binoculars", "earbuds",
  "lens", "bass", "windows", "plus",
]);

// Shelves are named in the plural ("Nintendo Consoles", "Microphones"); a title
// wants the singular. Only the LAST word changes — "Windows Laptops" becomes
// "Windows Laptop", not "Window Laptop".
// ⚠️ NOT A BARE TRAILING "s". That version turned "Cameras/Lenses" into
// "Cameras/Lense" and shipped it as a live GoPro suggestion, and would have made
// "Switches" → "Switche" and "Glasses" → "Glasse".
function depluralise(v: string): string {
  const parts = v.split(" ");
  const last = parts[parts.length - 1] || "";
  if (KEEP_PLURAL.has(last.toLowerCase())) return v;
  let one = last;
  if (/ies$/i.test(last) && last.length > 4) one = last.slice(0, -3) + "y";
  else if (/(s|x|z|ch|sh)es$/i.test(last)) one = last.slice(0, -2);
  else if (/[^sS]s$/.test(last) && last.length > 3) one = last.slice(0, -1);
  parts[parts.length - 1] = one;
  return parts.join(" ");
}

// ⚠️ DEPARTMENT NAMES ARE NOT PRODUCT WORDS. Shopify's Type for an Intel CPU is
// literally "Computer Part"; appending it makes a title worse, not findable.
// "Tool", "Equipment" and "Device" are departments too — proposing Collection
// "Tool" produced "Milwaukee 3622-20 M12 12V Laser Level Tool" across ten MPL
// rows. The 2026-09-03 census found "General/Other" and "Video Gaming" reaching
// live one-click suggestions on six rows across OVL, MPL and WSP.
const GENERIC_SHELF =
  /^(computer\s+part|pc\s+part|part|component|accessory|misc(ellaneous)?|general|electronics?|item|tool|equipment|device|hardware|gear|supply|goods|merchandise|unit|video\s+gaming|gaming|aftermarket\s+gaming|smart\s+home|home)$/i;

// A shelf name is not automatically a title word. PayMore files stock on three
// levels and only the bottom two reliably name the product:
//     Collection      "Computer Part"          the DEPARTMENT
//     Sub-Collection  "Graphics Card (GPU)"    the SHELF — the product word
//     Type            "Gaming Keyboard"        the item, when a lister typed one
// Measured over 4,034 products on 2026-09-03: 1,457 carry a Sub-Collection and
// its vocabulary is 111 values that are overwhelmingly real product words
// ("RAM", "Motherboard", "Hard Drive", "Power Supply", "Camera Lens"). Nothing
// read Sub-Collection before, so a graphics card shelved as "Graphics Card
// (GPU)" was told "no safe automatic fix" while the answer sat in the listing.
//
// Returns the words to append, or null for "we have nothing to propose".
// ⚠️ NULL IS ALWAYS SAFE AND A BAD WORD NEVER IS — this feeds a one-click
// button over a live listing, so every rule below fails closed.
function shelfNoun(value: string, title: string, shelfLevel = false): string | null {
  let v = (value || "").trim();
  if (!v || PLACEHOLDER.test(v)) return null;
  // ⚠️ A SLASH MEANS "ONE OF THESE" AND WE DO NOT KNOW WHICH. "Printer/Scanner",
  // "Keyboard/Mouse", "Routers/Modems" describe the shelf, not the item. This is
  // also what was putting "General/Other" on the end of five live titles.
  if (v.includes("/")) return null;
  // A parenthetical is a disambiguator, and only an ACRONYM earns title space:
  // "Graphics Card (GPU)" → "Graphics Card GPU" (buyers search both),
  // "Apple MacBook (Intel)" → "MacBook", "Hard Drive (HDD, SSD)" → "Hard Drive".
  v = v.replace(/\s*\(([^)]*)\)/g, (_m: string, inner: string) =>
    /^[A-Z]{2,5}$/.test(String(inner).trim()) ? ` ${String(inner).trim()}` : "");
  // ⚠️ THE AMPERSAND IS THE TELL — BUT ONLY AT THE DEPARTMENT LEVEL.
  // PayMore's DEPARTMENTS are named "Audio & Video", "Cameras & Photo"; products
  // are not, and proposing one gives a title a department label ("New Roku
  // Streaming Stick 4K Audio & Video"). The product-word test below does not
  // catch "Cameras & Photo" on its own, because "Cameras" really is a product
  // word. So the character is only tolerated one level down, on the SHELF, where
  // the whole 111-value vocabulary contains exactly one: "CPU & Motherboard
  // Combos", which is a real thing a buyer types.
  if (v.includes("&")) {
    if (!shelfLevel) return null;
    v = v.replace(/\s*&\s*/g, " ");
  }
  // Shelf bookkeeping, not words a buyer types.
  v = v.replace(/^others?\s+/i, "").replace(/\s+brands?$/i, "")
       .replace(/\s+/g, " ").trim();
  if (!v) return null;
  v = depluralise(v);
  // ⚠️ THE BRAND IS ALREADY IN THE TITLE. "Canon Digital Camera" on a Canon
  // listing must append "Digital Camera", and "Milwaukee Tool" on a Milwaukee
  // listing collapses to "Tool" — a department word, which then dies below
  // exactly as it should.
  const have = new Set(tokens(title));
  v = v.split(" ").filter(w => w && !have.has(norm(w))).join(" ").trim();
  if (!v || GENERIC_SHELF.test(v)) return null;
  // ⚠️ THE LIST GATES WHAT WE ADD, NOT WHAT WE ACCUSE. `isProductNoun` must
  // never depend on PRODUCT_NOUNS being complete — a gap there is a false
  // accusation against a fine title. Here a gap is only silence, so requiring
  // the PROPOSAL to contain a known product word is safe, and it is what stops a
  // department name nobody has thought of from being appended to a live listing.
  if (!tokens(v).some(isProductNoun)) return null;
  if (v.length > 32) return null;
  return v;
}


// Measurements and capacities are not model numbers. Without this, "33MP" and
// "1TB" get sent to Browse as if they were a model name and every camera in the
// estate comes back as a nonexistent model.
const NOT_A_MODEL = /^(\d+(\.\d+)?(mp|tb|gb|mb|kb|ghz|mhz|hz|k|w|v|mm|cm|in|inch|oz|lb|ml|l|fps|bit|core|p)|\d{1,4}|[ivx]+|4k|8k|1080p|720p|hd|uhd|fhd|usb|hdmi|wifi|bt|led|lcd|oled|qled|ddr\d?|nvme|sata|pcie)$/i;

// A model-shaped token: has a digit, is long enough to be distinctive, and is
// not a measurement. "SM-G781U", "MO34H-UC", "DDJ-SZ", "K-1".
// ⚠️ THE MODEL TO CHECK COMES FROM THE SPEC TABLE, NOT FROM THE TITLE, and
// guessing it from the title is what made the first version of this check
// useless. Measured over 450 items across the five stores it produced 13
// severity-3 findings of which roughly two were real:
//
//   "New Ultimate Ears WONDERBOOM 4 ... SR0192"  brand read as "New", and the
//                                                MPN checked as a model
//   "WiFi Only Apple iPad Pro ... MTFL2VC/A"     brand read as "WiFi"
//   "Corsair RM850x 80 Plus Gold 850W"           letter-stripping "RM850x" and
//                                                pairing it with 80 invented the
//                                                model "RMx 80"
//
// Every one of those is a title that is perfectly fine being accused, at the
// highest severity, of naming a product that does not exist. Shopify already
// records Brand and Model as their own fields — "Ultimate Ears" / "WONDERBOOM
// 4", "Sony" / "OX 7 IV" — so there is nothing to guess and no MPN to trip over.
//
// (The spec table carries the SAME wrong model as the bad title, "OX 7 IV", so
// comparing the two offline would catch nothing: the mistake is made upstream in
// PayMore's listing tool, in both fields at once. Asking the market is the only
// way to see it.)
function specModel(specs: Record<string, string> | undefined): { brand: string; model: string } | null {
  const brand = String(specs?.["Brand"] || "").trim();
  const model = String(specs?.["Model"] || "").trim();
  if (!brand || !model || PLACEHOLDER.test(brand) || PLACEHOLDER.test(model)) return null;
  // A one-character model is not distinctive enough to judge by, and a very long
  // one is prose somebody pasted into the wrong field.
  if (norm(model).replace(/ /g, "").length < 2 || model.length > 40) return null;
  return { brand, model };
}

function modelTokens(title: string): string[] {
  const single = (title.match(/\b[A-Za-z][A-Za-z0-9]*(?:[-/][A-Za-z0-9]+)*\b/g) || [])
    .filter(t => /\d/.test(t) && t.replace(/[^A-Za-z0-9]/g, "").length >= 2)
    .filter(t => !NOT_A_MODEL.test(t.replace(/[^A-Za-z0-9]/g, "")));

  // ⚠️ THE MODEL IS OFTEN TWO WORDS, AND THE CASE THIS FEATURE WAS BUILT FOR IS
  // ONE OF THEM. OVL's $1,499.99 camera is titled "Sony OX 7 IV 33MP Mirrorless
  // Digital Camera" — the alpha of an a7 IV mangled into "OX". Tokenised one
  // word at a time that yields "OX" (no digit), "7" (no leading letter) and
  // "33MP" (a measurement), so the single-token pass finds NOTHING to check and
  // the one title in the estate that most needs checking sails through. Verified
  // exactly that way before this was added.
  //
  // PayMore's own convention writes these spaced — "Nikon Z 6", "Sony Alpha A7
  // II" — so a short letter run followed by a bare number is a model name.
  //
  // ONLY IN THE FIRST FOUR WORDS. A model sits at the front of a title, right
  // after the brand; further along, the same shape is a socket or a spec ("LGA
  // 1700", "Thread 32") and asking eBay about those would raise a severity-3
  // finding about a title that is perfectly fine.
  const words = title.trim().split(/\s+/).slice(0, 4);
  const pairs: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i].replace(/[^A-Za-z]/g, "");
    if (a.length < 1 || a.length > 3) continue;
    // ⚠️ THE NUMBER MUST BE A BARE NUMBER, punctuation and all. `LG 34"` is a
    // brand and a SCREEN SIZE, and a loose test that stripped the inch mark
    // turned it into the model "LG 34" — a query eBay would answer with nothing,
    // raising a severity-3 "this model does not exist" against a monitor whose
    // title is perfectly good. Same shape as `24GB`, `2TB`, `100Hz`.
    if (!/^\d{1,4}[,)\].]?$/.test(words[i + 1])) continue;
    // And skip brand + number for the same reason: the first word is the brand,
    // so a number straight after it is a size or a capacity far more often than
    // it is a model.
    if (i === 0) continue;
    pairs.push(`${a} ${words[i + 1].replace(/[^0-9]/g, "")}`);
  }
  return [...new Set([...single, ...pairs])].slice(0, 4);
}

// ⚠️ "BROWSE RETURNED NOTHING" IS NOT A TEST FOR A MODEL THAT DOES NOT EXIST.
// That was this check's first design and it is simply wrong: eBay's Browse
// search is FUZZY, not exact. Querying "Sony OX 7" — a model that has never
// existed, the alpha of an a7 IV mangled into "OX" — returns three live
// listings, because Browse happily matches "Sony" and "7" and ranks something.
// Measured on the exact title this feature was built for, which is the only
// reason it was caught.
//
// So Browse is used as a CORPUS, not as an oracle: ask for listings, then look
// for the model string in the titles that come back. A real model is named by
// the listings selling it; a mangled one is named by none of them.
// ⚠️⚠️ AND OUR OWN LISTINGS MUST BE THROWN OUT OF THE CORPUS FIRST, or the check
// validates every mistake it exists to catch. We share the eBay account, our
// items are live, and Browse returns them: the FIRST result for "Sony OX 7" is
// PayMore's own "Sony OX 7 IV 33MP Mirrorless Digital Camera". A bad title is
// therefore its own proof that the model is real. Measured, again on the one
// title this was built for — the corpus test looked like it worked until the hit
// titles were printed.
//
// Excluded two ways because neither is sufficient alone: by eBay item id (which
// Browse returns as "v1|123456789|0", so the numeric middle is what matches
// ebay_live), and by an identical title (which catches a listing of ours that
// the sweep has not seen yet, and MC's copies of the same product).
// OTHER SELLERS' LISTINGS ONLY.
function otherSellers(hits: any[], ownIds: Set<string>, ourTitle: string): any[] {
  const mine = norm(ourTitle);
  return hits.filter(h => {
    const id = String(h?.itemId || "").split("|")[1] || "";
    if (id && ownIds.has(id)) return false;
    return norm(String(h?.title || "")) !== mine;
  });
}

// How many other sellers' listings we insist on before we are willing to say a
// model does not exist. Below this the answer is "we could not tell", which is a
// different thing and must not be reported as a finding — a severity-3 accusation
// resting on one or two unrelated results is exactly what teaches a reviewer to
// stop reading the reasons.
// ============================ TITLE STRENGTH ================================
// "If we believe the title is like 90%+ strength we don't need to change
// anything. I'm looking for the lazy titles" — Ethan, 2026-08-28.
//
// Strength = how much of what THE LISTING ITSELF ALREADY KNOWS the title uses.
// No eBay, no guessing, and the fix is never invented: the missing value is
// sitting in the spec table.
//
// Measured over the whole OVL storefront (831 products with a spec table):
//   734 titles are at 100% — they already carry every title-worthy spec
//     38 sit at 60-69%
//      6 fall under 60% with room to spare, and ALL SIX are real:
//        "ANTEC 520W HIGH CURRENT GAMER POWER SUPPLY"  Brand is PowerSpec, MPN PS 650BSM
//        "Philips Shockbox … Speaker"                  Model is Shockbox 7200
//        "KIOXIA 2280mm 512GB M.2 NVMe"                MPN KBG5AZNV512G
//        "DJI Zenmuse X9-6K …"                         MPN VDCDJZX96KGM
//        "Xbox Elite Controller Series 2 ModdedZone"   MPN 1797
//        "Vintage Kaypro 286i Desktop Computer"        MPN MODEL C, 80286 6MHz
//
// ⚠️ THE FIELD LIST IS THE WHOLE BALLGAME. With Condition, Genre, Publisher and
// Release Year counted, 224 titles looked lazy and almost none were — those
// belong in eBay's own condition field or nowhere ("Acceptable" in a title
// repels a buyer). Narrowing it to what somebody actually TYPES took 224 -> 6
// with no loss of a real finding. Add a field here only after re-measuring.
// ⚠️ MPN IS NOT IN HERE, and that is Ethan's DJI question answered: the tool
// proposed "DJI Zenmuse X9-6K for Ronin 4D Gimbal Camera with Counterweight
// VDCDJZX96KGM" — nobody searches a 12-character part number, so it spends 13 of
// the 80 characters on a string no buyer will ever type. Dropping MPN removes the
// DJI and Xbox rows entirely and leaves the ones that name something real
// ("Shockbox 7200", a processor).
const TITLE_SPECS = ["Brand", "Model", "Storage", "Capacity", "Storage 1",
  "Memory (RAM)", "Processor", "Screen Size", "Color", "Platform", "Carrier",
  "Lock Status", "Maximum Resolution", "GPU/Graphics Card", "Wattage", "Size"];

const squash = (v: string) => norm(v).replace(/ /g, "");

// ⚠️ THE TWO RULES BELOW WERE BURIED INSIDE strengthOf AND ARE NOW SHARED.
// They are what took the lazy-title check from 224 findings to 6, so anything
// that proposes a spec value has to obey them or it re-introduces every one of
// those mistakes under a new name.

// Is this value the kind of thing that belongs in a title at all?
function titleWorthy(k: string, v: string, specs: Record<string, string>): boolean {
  if (!v || PLACEHOLDER.test(v) || squash(v).length < 2) return false;
  // ⚠️ A DEPARTMENT NAME IS NOT A DETAIL. Shopify's Collection leaks into Model
  // and Type for some products — a Roku's read "Audio & Video" — and appending
  // those gives a title a shelf label rather than a fact. The ampersand is the
  // tell: PayMore's shelves are named that way, products are not.
  const coll = String(specs["Collection"] || "").trim().toLowerCase();
  const sub = String(specs["Sub-Collection"] || "").trim().toLowerCase();
  const lv = v.toLowerCase();
  if (lv === coll || lv === sub || / & /.test(v)) return false;
  // ⚠️ AN OPAQUE PART CODE IS NOT A SEARCH TERM. A single unbroken run of 8+
  // mixed letters and digits ("FWANJA1102", "VDCDJZX96KGM") is a factory code,
  // not something a buyer types.
  //
  // ⚠️⚠️ THIS TEST WAS DEAD UNTIL 2026-08-28. It read /d/ and /s/ — the
  // LETTERS d and s — because a patch script ate the backslashes off \d and
  // \s. So it demanded the value contain a lower-case "d" and contain no
  // lower-case "s", which almost no upper-case part number does either way, and
  // the guard never fired. It looked correct in review for three days. Any regex
  // written through a script gets read back out of the file afterwards.
  // ⚠️ UNDERSCORES AND SHORT RUNS COUNT TOO. "3994_JP-SGS8P-BLK" walked through
  // the first version because `_` was not in the character class, and "G3AL9"
  // because it is only five characters. A single unbroken run with no vowel is
  // a part number whatever its length.
  const solid = /^[A-Za-z0-9][A-Za-z0-9_\-/.]*$/.test(v) && !/\s/.test(v);
  if (solid && /\d/.test(v) && /[A-Za-z]/.test(v)
      && (squash(v).length >= 8 || !/[aeiou]/i.test(v.replace(/[^A-Za-z]/g, "")))) return false;
  return true;
}

// Is it ALREADY in the title? Exactly, or near enough that repeating it would
// restate the title inside itself:
//   "HP Prodesk 600 G5 Mini i5-9500T 8GB 500GB"
//        + "HP Prodesk 600 G5 Desktop Mini 8GB RAM"
// ⚠️ STEM THE PLURAL. "…Wireless Earbuds" against the spec "…in-Ear Earbud"
// overlapped at 50% for one trailing "s", and the tool proposed appending the
// title to itself.
function valuePresent(title: string, v: string): boolean {
  if (squash(title).includes(squash(v))) return true;
  const stem = (w: string) => w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
  const vw = tokens(v).filter(w => w.length > 1).map(stem);
  const tw = new Set(tokens(title).map(stem));
  return vw.length > 0 && vw.filter(w => tw.has(w)).length / vw.length >= 0.6;
}

// ============== WHAT THIS KIND OF THING IS NORMALLY CALLED ==================
// Ethan, 2026-08-28: "it should just be comparable by type … as long as our
// title has the same type of information as comparable sold and active items."
//
// ⚠️ LEARNED FROM OUR OWN CATALOGUE, NOT FROM EBAY, AND THAT IS THE POINT.
// He also asked whether active listings are safe to learn from: "I just don't
// want to copy titles of items that may not ever sell." Exactly right — an
// active sample contains everything that has NOT sold, and wording copied from
// it is as likely to come from a dud as from a winner.
//
// Our own storefront dodges that entirely. PayMore's listing software writes
// these titles from what sells, so the house convention is already the
// sales-informed one — and it needs no eBay call, no scope we do not hold, and
// carries no other seller's phrasing into our listing.
//
// It learns the SHAPE, never the words: "9 in 10 Custom Gaming PC titles name
// the GPU" is a fact about which KIND of detail belongs, and the value filled in
// comes from this listing's own spec table. That is also why shape survives dead
// listings where wording does not — a gaming PC that never sold still names its
// GPU.
type Bucket = { n: number; keys: Map<string, { has: number; inTitle: number }> };
type Convention = Map<string, Bucket>;

// Thresholds: a collection needs 8 products before its habits mean anything, a
// field needs to exist on 8 of them, and 70% of those must put it in the title.
// Below that it is one person's preference, not a convention.
// ⚠️⚠️ OFF BY DEFAULT. MEASURED AT ~60% PRECISION OVER ALL FIVE STORES, AND
// TWO OF THE 55 WOULD HAVE MADE A CORRECT TITLE WRONG:
//
//   "Nikon Z 6 24.5MP Mirrorless Camera"  + "Digital SLR DSLR Camera"
//   "Milwaukee 3485-20 M12 Right Angle Die Grinder"
//                                        + "3/8\" Stubby Impact Wrench"
//
// The first is the exact severity-3 error CONFLICTS exists to catch, proposed
// by us. A check that can turn a correct listing into a misdescribed one is
// worse than no check, whatever its hit rate elsewhere.
//
// WHAT IT GOT RIGHT, and why it is kept rather than deleted: it is very good on
// titles that say almost nothing — "JVC XL-R86BK" -> + Compact Disc Player,
// "Nikon SB-600" -> + Camera Flash, "Mophie JP-SGS8P" -> + Battery Case,
// "649532018505" (a bare barcode) -> + Bosch Laser Level, and every bare-part-
// number RAM listing at MPL gaining its capacity. It is also the only check that
// found the motherboard chipsets (AMD B550, Intel B560, AMD X870), which are
// real search terms nothing else proposes.
//
// WHERE IT FAILS is the mirror image: titles that are ALREADY rich, where the
// category habit adds something redundant ("Soundbar" + "Bluetooth Sound Bar"),
// contradictory (the Nikon), or simply wrong for the item (the Milwaukee). The
// mechanism has no idea what the product IS — it knows only that listings on
// this shelf usually name their Type, and a Type field can be wrong.
//
// The next version needs the value checked against the item, not just against
// the shelf: run the proposed title back through CONFLICTS and refuse anything
// that would raise one, and never propose a product noun into a title that
// already names its own. Both are real work, not tuning, so it ships off.
const CONV_ENABLED = false;

const CONV_MIN_PRODUCTS = 8;
const CONV_MIN_SHARE = 0.7;

// ⚠️ MEASURED, THEN TIGHTENED. The first version of this check produced 25
// findings at OVL of which about four were real — the same shape of failure the
// TITLE_SPECS header warns about, re-created under a new name. Every rule below
// comes from one of those bad rows, and the check is worth nothing without them.
//
// 1. NEVER APPEND A BARE NUMBER. "New Diablo III (PC, 2012) 1989" and
//    "SpongeBob … Rehydrated - Disc Only 2020". Games conventionally carry the
//    year INSIDE the parenthetical, so co-occurrence made Release Year look like
//    a house convention — and then appended it bare, in the wrong place, and on
//    Diablo with the wrong year. A convention about PLACEMENT cannot be honoured
//    by sticking the value on the end.
// 2. NEVER APPEND A VALUE THAT FIGHTS THE TITLE'S OWN NUMBERS.
//    "Micron … 16GB (1x16GB) RAM DDR4 2666MHz" + "32GB (2x16GB) RAM" put two
//    different capacities in one title. Same unit, different number, from the
//    spec-conflict check — that row needs a person, not an append.
// 3. NEVER APPEND WHEN EVERYTHING NEW IS SHORT OR GENERIC.
//    "Polaroid OneStep 600 …" + "Polaroid PDC", "Canon mini dv …" + "Canon ZR
//    Series", "Kaypro …" + "MODEL C", "… Solid State Drive" + "SSD". In each the
//    only genuinely new token is an abbreviation or a filler word, so the title
//    gets longer and says nothing more.
//
// Fields that are never title material whatever the corpus says. These are the
// same ones that took the lazy-title check from 224 findings to 6: they belong
// in eBay's own item specifics, or nowhere ("Acceptable" in a title repels a
// buyer).
const CONV_NEVER = /^(release\s*year|year|publisher|developer|genre|condition|rating|esrb|region|country|serial|sku|upc|ean|isbn|weight|dimensions|notes?)$/i;
const CONV_FILLER = new Set(["series", "model", "type", "edition", "version",
  "system", "device", "unit", "item", "gen", "generation", "the", "and", "with"]);

// At least one genuinely new word that is long enough to be a search term.
function convWorthAdding(title: string, v: string): boolean {
  const have = new Set(tokens(title));
  const fresh = tokens(v).filter(t => !have.has(t) && !CONV_FILLER.has(t));
  return fresh.some(t => t.length >= 4 && /[a-z]/.test(t));
}

// Same unit, different number, in the title and in the value.
function convContradicts(title: string, v: string): boolean {
  const units = (text: string) => {
    const out = new Map<string, Set<string>>();
    for (const m of String(text).matchAll(/\b(\d+(?:\.\d+)?)\s?(w|watt|watts|gb|tb|mb|mhz|ghz|mp|in|inch|hz)\b/gi)) {
      const u = m[2].toLowerCase().replace(/^watts?$/, "w").replace(/^inch$/, "in");
      if (!out.has(u)) out.set(u, new Set());
      out.get(u)!.add(m[1]);
    }
    return out;
  };
  const a = units(title), b = units(v);
  for (const [u, vals] of b) {
    const mine = a.get(u);
    if (mine && mine.size && ![...vals].some(x => mine.has(x))) return true;
  }
  return false;
}

function learnConvention(cands: Row[], extras: Record<string, Extra>): Convention {
  const out: Convention = new Map();
  for (const row of cands) {
    const specs = extras[row.product_id]?.specs;
    if (!specs) continue;
    const coll = String(specs["Collection"] || "").trim().toLowerCase();
    if (!coll) continue;
    let b = out.get(coll);
    if (!b) { b = { n: 0, keys: new Map() }; out.set(coll, b); }
    b.n += 1;
    for (const [k, raw] of Object.entries(specs)) {
      const v = String(raw || "").trim();
      if (!titleWorthy(k, v, specs)) continue;
      const c = b.keys.get(k) || { has: 0, inTitle: 0 };
      c.has += 1;
      if (valuePresent(row.title || "", v)) c.inTitle += 1;
      b.keys.set(k, c);
    }
  }
  return out;
}

// ⚠️ A CARRIER NAME IS A LOCK STATUS. Ethan, 2026-08-31: "Verizon and T-Mobile
// are in fact stating it is a T-Mobile device." He is right, and we were scoring
// those titles as though they had left the fact out — "Verizon Apple iPhone 13
// 128GB Midnight" was being counted as MISSING `Lock Status: Network Locked`,
// which drags its strength down and makes a complete title look lazy.
//
// Only satisfies a LOCKED status. A title that says "Verizon" over a spec
// reading `Unlocked` is a contradiction, not a statement, and stays missing.
//
// ⚠️ MVNOs COUNT AND THE OBVIOUS LIST MISSES THEM. The first version had the
// four big networks and would have failed on BAL's real row, "Consumer Cellular
// Apple iPad 1st Gen". Written against the raw title rather than norm() because
// norm turns "AT&T" into "at t".
const CARRIERS = /\b(verizon|t\s*-?\s*mobile|at\s*&\s*t|at\s*and\s*t|\bat&t\b|sprint|metro\s*by\s*t|metro\s*pcs|metropcs|boost\s*(mobile|infinite)?|cricket|us\s*cellular|consumer\s*cellular|straight\s*talk|tracfone|net\s*10|simple\s*mobile|total\s*(wireless|by\s*verizon)|page\s*plus|xfinity|spectrum|visible|mint\s*mobile|google\s*fi|h2o|lycamobile|ultra\s*mobile|red\s*pocket|safelink|assurance)\b/i;

function lockStatedByCarrier(title: string, v: string): boolean {
  return /lock/i.test(v) && !/unlock/i.test(v) && CARRIERS.test(title);
}

// ================== THE SCREEN A PHONE OR TABLET IS SOLD BY ==================
// Ethan, 2026-08-31, on the measured gap: "If you feel it is important to add the
// screen size for things like tablets and mobile devices, then we should."
//
// This is the one field that earns a rule of its own, because the lazy-title
// RATIO can never reach it: a phone title carrying brand, model, capacity and
// colour and omitting only the screen scores 80%, and 80% is a title we leave
// alone by policy. Measured over all five storefronts, Screen Size is recorded
// on 181 in-scope products and the omission is not spread evenly:
//
//   Monitor                     53 recorded,  0 omitted   <- already perfect
//   Laptops / MacBooks / AIO    66 recorded,  4 omitted
//   Apple iPhone                12 recorded, 11 omitted   <- the gap
//   Android Phones               8 recorded,  7 omitted
//   iPad / Android Tablet       22 recorded,  6 omitted
//
// So this fires on roughly 30 rows estate-wide, ~6 a store, and almost all of
// them are phones and tablets. Monitors and laptops are gated IN deliberately
// even though they are near-perfect: including a shelf that is already complete
// costs nothing and means a regression there is caught.
const SCREEN_SHELVES = /\b(iphones?|phones?|smartphones?|ipads?|tablets?|laptops?|notebooks?|chromebooks?|macbook|imac|monitors?|aio|all[\s-]?in[\s-]?one|televisions?|tvs?|handheld\s+gaming)\b/i;
// ⚠️ A SHELF OF PARTS IS NOT A SHELF OF SCREENS. "Phone Cases" and "Laptop
// Chargers" both satisfy the list above, and a replacement screen assembly can
// legitimately carry a Screen Size spec — but nobody wants 6.1" welded onto the
// title of a case. Checked second so it always wins.
const SCREEN_NOT = /\b(case|cover|charger|cable|adapter|protector|stand|mount|dock|bag|sleeve|part|parts|repair|replacement|accessor)/i;

// ⚠️ "6.1" IS TWO CHARACTERS AFTER squash(), AND TWO CHARACTERS FIND THEMSELVES
// ANYWHERE. valuePresent() squashes both sides and asks for a substring, so it
// reported 6.1" as ALREADY PRESENT in "Factory Unlocked Apple iPhone 16 128GB
// Black MYAP3LL/A" — the "61" it found is the tail of "16" and the head of
// "128". Two live rows at two stores. A measurement is only worth as much as
// its presence test, so this one is written for numbers.
//
// ⚠️ AND IT DELIBERATELY ACCEPTS A BARE NUMBER. `13` matching "iPhone 13" is a
// false PRESENT, which costs us one quiet row; demanding the inch mark would
// give a false MISSING, which puts a wrong suggestion in front of a manager.
// Between a rule that stays quiet and a rule that is wrong out loud, take quiet.
function screenSizePresent(title: string, v: string): boolean {
  const m = String(v).match(/(\d+(?:\.\d+)?)/);
  if (!m) return true;                       // no number to look for: say nothing
  const n = m[1].replace(".", "\\.");
  return new RegExp(`(^|[^\\d.])${n}\\s*(?:"|”|''|-?\\s*in(ch(es)?)?\\b)`, "i").test(title)
      || new RegExp(`(^|[^\\d.])${n}(?![\\d.])`).test(title);
}

// ⚠️ THE NUMBER IS THE LISTING'S, THE UNIT MARK IS OURS. BAL's HP Chromebook
// records `14in`, and "HP Chromebook … 14in" reads like a typo next to every
// other title on the shelf. Normalising the unit to an inch mark is the only
// liberty taken with a spec value anywhere in this file, and it is confined to
// the unit — the digits are never touched, so the tool still cannot invent a
// measurement it was not given.
function screenSizeText(v: string): string | null {
  const m = String(v).match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!isFinite(n) || n < 3 || n > 120) return null;   // not a screen measurement
  return `${m[1]}"`;
}

type Strength = { pct: number; present: number; total: number;
                  missing: { k: string; v: string }[] };

function strengthOf(title: string, specs: Record<string, string> | undefined): Strength | null {
  if (!specs) return null;
  const t = squash(title);
  const present: string[] = [], missing: { k: string; v: string }[] = [];
  for (const k of TITLE_SPECS) {
    const v = String(specs[k] || "").trim();
    if (!titleWorthy(k, v, specs)) continue;
    if (t.includes(squash(v))) { present.push(k); continue; }
    // A carrier name in the title already says the device is locked. See CARRIERS.
    if (k === "Lock Status" && lockStatedByCarrier(title, v)) { present.push(k); continue; }
    // ⚠️ MOSTLY-PRESENT IS PRESENT. The exact-substring test treats a value as
    // wholly missing when nearly all of it is already in the title, and the
    // suggestions it produced were embarrassing:
    //   "HP Prodesk 600 G5 Mini i5-9500T 8GB 500GB"
    //        + "HP Prodesk 600 G5 Desktop Mini 8GB RAM"
    //   "Skullcandy Push True Wireless Earbuds"
    //        + "Push True Wireless in-Ear Earbud Black"
    // Both restate the title inside itself. A value counts as present when most
    // of its words are already there, so only a genuinely NEW detail — the
    // iPhone's 6.1" and Pink, the Higround's HG68 — is ever proposed.
    // ⚠️ STEM THE PLURAL. "Skullcandy Push True Wireless Earbuds" versus the spec
    // "Push True Wireless in-Ear Earbud" overlapped at only 50% because earbuds
    // and earbud are different strings — so the tool proposed appending the title
    // to itself. One trailing "s" was the entire difference.
    if (valuePresent(title, v)) { present.push(k); continue; }
    // ⚠️ A DEPARTMENT NAME IS NOT A DETAIL. Shopify's Collection leaks into Model
    // and Type for some products — a Roku's read "Audio & Video", a custom build's
    // "Custom PC" — and appending those gives a title a shelf label rather than a
    // fact ("New Roku Streaming Stick 4K Audio & Video Black 2160p (4K)"). The
    // ampersand is the tell: PayMore's shelves are named that way, products are not.
    missing.push({ k, v });
  }
  const total = present.length + missing.length;
  if (!total) return null;
  return { pct: Math.round(100 * present.length / total), present: present.length, total, missing };
}

// ⚠️ THE LISTING CAN SETTLE ITS OWN ARGUMENT. Ethan, 2026-08-28: "remember to
// read the HTML, meta fields, etc. to determine if our title is correct to our
// listing then we compare to eBay."
//
// He is right, and the row that prompted it proves it. BAL MO04-1726A-E10:
//     Shopify   "…1TB SSD GeForce RTX 3050"
//     eBay      "…1TB SSD GeForce GTX 1060"
//     spec table `GPU/Graphics Card Model: GeForce RTX 3050`   <- settles it
// The GPU was upgraded, the title and the spec table were both updated, and TWO
// stale copies were left behind — the eBay listing, and the `whats_include`
// metafield, which still reads "…Nvidia GeForce GTX 1060". eBay is not
// disagreeing at random; it is showing the same stale string the metafield has.
//
// Asking a manager "one of these is wrong, you pick" when the listing already
// answers is work we are creating, not work we are finding.
//
// ⚠️ ONLY ADJUDICATES A REAL CONFLICT, never a truncation. Both sides must carry
// words the other does not: "…16GB RAM 1TB SSD" versus a shortened "…16GB RAM"
// is one title being cut off, and declaring the longer one "backed by the spec
// table" would be true and useless. A spec value counts only when it is made of
// the words actually in dispute.
type Verdict = { side: "ours" | "theirs"; field: string; value: string } | null;

function adjudicate(ours: string, theirs: string,
                    specs: Record<string, string> | undefined): Verdict {
  if (!specs) return null;
  const a = new Set(tokens(ours)), b = new Set(tokens(theirs));
  const ourOnly = [...a].filter(t => !b.has(t));
  const theirOnly = [...b].filter(t => !a.has(t));
  if (!ourOnly.length || !theirOnly.length) return null;
  const so = squash(ours), st = squash(theirs);
  let backsUs: Verdict = null, backsThem: Verdict = null;
  // EVERY spec key, not just the title-worthy ones. This is not proposing an
  // edit — it is asking which side the listing's own record agrees with — and
  // the deciding field is often one nobody would put in a title
  // ("GPU/Graphics Card Model", "Storage Type 1").
  for (const [k, raw] of Object.entries(specs)) {
    const v = String(raw || "").trim();
    if (!v || PLACEHOLDER.test(v) || squash(v).length < 3) continue;
    const vt = tokens(v);
    if (!vt.length) continue;
    const inOurs = so.includes(squash(v)), inTheirs = st.includes(squash(v));
    if (inOurs === inTheirs) continue;
    if (inOurs && vt.some(t => ourOnly.includes(t)) && !backsUs) {
      backsUs = { side: "ours", field: k, value: v };
    }
    if (inTheirs && vt.some(t => theirOnly.includes(t)) && !backsThem) {
      backsThem = { side: "theirs", field: k, value: v };
    }
  }
  // Both supported means the spec table is inconsistent with itself and is no
  // longer a referee — fall back to asking the person.
  if (backsUs && backsThem) return null;
  return backsUs || backsThem;
}

const MODEL_MIN_CORPUS = 8;
// A brand is named by thousands of listings or it is not a brand. Raised from the
// model's threshold because this one carries a severity-3 accusation.
const BRAND_MIN_CORPUS = 10;

// ⚠️ FINDINGS ONLY THE MARKET HALF CAN PRODUCE, AND WHICH A RULES-ONLY SWEEP MUST
// THEREFORE NOT ERASE.
//
// Caught by testing the cron body rather than the endpoint: the twice-daily
// rules-only sweep upserts the same primary key, so it overwrote every row the
// market pass had found and `model-not-found` went 12 -> 0. OVL's $1,499.99
// "Sony OX 7 IV" — the whole reason the market half exists — dropped out of the
// queue completely and was stamped clean. Twice a day, silently, forever.
//
// A rules-only pass is not evidence that a market finding is resolved; it is
// evidence that nobody asked. So it carries them forward untouched for as long as
// the title has not changed — and the moment it HAS changed the market answer is
// about a title that no longer exists and is dropped, which is the same staleness
// rule the queue view enforces.
// ⚠️ THE NAME CHECKS ARE NOT IN HERE, and must not be added back while they are
// off by default: preserving a finding the analyser will no longer produce would
// freeze the low-precision rows into the queue permanently, which is the exact
// opposite of switching them off. Only the keyword half (short-title, built from
// category comps) is carried forward.
// Nothing left to carry forward: the name checks are gated off and the
// comps-keyword finding is retired. Kept (empty) rather than deleted because the
// merge it feeds is the right shape the moment a market-only finding earns its
// place again — and because an empty set makes the intent explicit.
const MARKET_CODES = new Set<string>([]);

function modelNamed(model: string, hits: any[]): boolean {
  const want = norm(model).replace(/ /g, "");
  if (want.length < 2) return true;
  // Separators removed, so "Z 6" matches "Z6" and "Z-6" — how sellers actually
  // write them. Without it every spaced model in the estate looks fabricated.
  return hits.some(h => norm(String(h?.title || "")).replace(/ /g, "").includes(want));
}

// ⚠️ A QUERY CAN BE TOO SPECIFIC TO JUDGE BY, and the one case this check exists
// for is the case that proves it: "Sony OX 7 IV" returns exactly ONE live
// listing — ours — so after excluding our own there is nothing left to compare
// against and the check has to abstain. Broadening to "Sony OX 7" returns other
// sellers, none of whom mention it, which is the actual finding.
//
// So the model is shortened a token at a time until enough OTHER sellers answer,
// and the full model string is what we then look for. Returns null for "could
// not tell" — never false on a thin corpus.
// Returns an EXAMPLE of what other sellers call it alongside the verdict, because
// "this model name looks wrong" is a puzzle and "the market calls it X" is an
// errand. It also keeps the finding honest about what it really detects: not only
// invented models but near-misses, which turn out to be the common case. Our
// "Mesa/Boogie Simul 395 Stereo" is a real amplifier — the market spells it
// "Simul-Class 395", and our title is missing the word that buyers search.
// ⚠️ THE BRAND IS THE PRECISE HALF OF THIS CHECK, AND THE MODEL IS THE VAGUE ONE.
// Discovered by finally running the market pass over a WHOLE store instead of a
// sample: 798 items at OVL produced 25 severity-3 model findings of which most
// were plainly wrong — "Xbox Elite Controller Series 2", "HoverAir X1 Travel
// Combo", "Minolta 100-300 f/4.5-5.6" are all real products that eBay simply has
// few or no other listings of. The earlier 75–85% precision came from a lucky
// 350-item sample. A tier full of wrong severity-3 rows is exactly the
// credibility drain every other rule in this file is written to avoid.
//
// But the TRUE positives had one thing in common — a misspelled BRAND:
//   "New Vivant outdoor camera pro"      -> Vivint
//   "Steeleseries Apex 3 TKL"            -> SteelSeries
//   "Bose Waves Music System III"        -> Wave
//   "nemko Focusrite MOSC0012"           -> nemko is a CERTIFICATION MARK
// A brand is named by thousands of listings or it is not a brand, so absence
// from a healthy sample is strong evidence. A model can legitimately be absent
// because we own the only one on the site.
//
// So they are separate findings with separate severities: a wrong brand is
// severity 3 (the listing is wrong), an unconfirmable model is severity 2 (it
// cannot be found) and says out loud that it might just be rare.
async function brandIsReal(brand: string, browse: Browse, ownIds: Set<string>,
                           ourTitle: string): Promise<boolean | null> {
  const b = brand.trim();
  if (norm(b).replace(/ /g, "").length < 3) return null;   // too short to judge
  const hits = await browse(b, undefined, 20);
  if (hits === null) return null;
  const others = otherSellers(hits, ownIds, ourTitle);
  // A real brand brings back a full page. Anything less and eBay is telling us
  // about its own catalogue, not about the brand.
  if (others.length < BRAND_MIN_CORPUS) return null;
  return modelNamed(b, others);
}

async function modelIsReal(brand: string, model: string, browse: Browse, ownIds: Set<string>,
                           ourTitle: string): Promise<{ real: boolean | null; example: string | null }> {
  const parts = model.trim().split(/\s+/);
  for (let take = parts.length; take >= 1; take--) {
    const q = `${brand} ${parts.slice(0, take).join(" ")}`.trim();
    const hits = await browse(q, undefined, 20);
    if (hits === null) return { real: null, example: null };   // could not ask at all
    const others = otherSellers(hits, ownIds, ourTitle);
    if (others.length < MODEL_MIN_CORPUS) continue;            // too thin — broaden
    // ⚠️ ONLY QUOTE AN EXAMPLE FROM A QUERY THAT BARELY BROADENED. The verdict
    // survives heavy broadening — the model still is not named by anybody — but
    // the EXAMPLE stops being about our product. Two rungs down, "Sony OX 7 IV"
    // became the query "Sony OX", whose first result is a laptop DC power jack;
    // quoting that as what the market calls our camera makes a correct finding
    // look ridiculous, and a finding nobody believes is worse than none.
    const dropped = parts.length - take;
    return { real: modelNamed(model, others),
             example: dropped <= 1 ? (String(others[0]?.title || "").slice(0, 90) || null) : null };
  }
  return { real: null, example: null };
}

// Words that must never be lifted out of a comp title into ours. Seller
// boilerplate, condition claims we have not verified, and shipping promises we
// cannot keep — copying any of these would be a claim about OUR item made on
// somebody else's authority.
const COMP_STOPWORDS = new Set([
  ...("the a an and or for with of in on to from by is are be new used open box "
    + "excellent very good fair poor mint sealed refurbished refurb renewed "
    + "tested working works fully functional untested as parts repair broken "
    + "read description see photos pictures fast free shipping ship returns "
    + "warranty guaranteed genuine original authentic oem lot bundle set kit "
    + "great condition nice clean perfect excellent+ pristine flawless top "
    + "rare htf vintage retro collectible must see look wow l k no reserve "
    + "same day usa us ca uk eu bin buy now sale deal cheap best price").split(" "),
]);

// ======================= THE NAME CHECK (Claude) ============================
// The ONE question in this file that code cannot answer, and the reason is
// written down in five failed designs above: eBay Browse is a fuzzy SEARCH, not
// a product catalogue, and half our estate is items we own the only copy of. So
// "no results" proves nothing and "some results" proves nothing.
//
// ⚠️ AND THE SPEC TABLE CANNOT SETTLE IT EITHER. OVL's $1,499.99
// "Sony OX 7 IV 33MP Mirrorless Digital Camera" is an α7 IV whose α was mangled
// into "OX" — and the spec table says "OX 7 IV" too, because PayMore's listing
// software made the same mistake in both fields. The listing agrees with itself
// perfectly. Every offline rule passes it. Nobody will ever search for it.
//
// Ethan, 2026-08-31: "If doing the same sweep can be systematic/coded, let's not
// use usage." Agreed, and that is why this is the ONLY model-backed check —
// everything else in this file stays rules, which are free, repeatable and
// auditable. This is scoped to names and nothing else.
//
// Known real ones this exists to catch, all found by hand: "Sony OX 7 IV"
// (α7 IV), "Vivant" (Vivint), "Steeleseries" (SteelSeries), "Bose Waves Music
// System" (Wave), and an AsRock B650M titled Intel when B650M is AMD.

const NAME_MODEL = "claude-opus-5";
// Per store per run. Mirrors MARKET_MAX and exists for the same reason: the
// 150s edge wall cuts the RESPONSE while the function keeps executing, so an
// over-long run reports IDLE_TIMEOUT and nobody can tell how much was saved.
const NAME_MAX = 100;
const NAME_BATCH = 25;          // products per request
const NAME_CONCURRENCY = 4;     // batches in flight — 100 items in one round trip

// ⚠️ BUMP THIS WHEN WHAT WE SEND CHANGES. It is stored next to every answer, so
// changing it re-asks about every listing automatically instead of leaving old
// answers that were given less to look at. This is the whole reason the column
// exists: adding metafields later costs one backfill, not a wiped table.
const ASK_RECIPE = "v1:title+brand+model";

// Carried forward on a rules-only pass, exactly as MARKET_CODES is — otherwise
// the twice-daily cron shares a primary key with these rows and stamps them
// `clean`, which is precisely how the market's findings were erased twice a day
// until 2026-08-28.
const NAME_CODES = new Set<string>(["name-garbled", "name-wrong"]);

type NameVerdict = {
  verdict: "ok" | "garbled" | "wrong";
  wrong_text?: string;
  correct_text?: string;
  why?: string;
};

// ⚠️ EVERY FAILED DESIGN FAILED THE SAME WAY: it flagged real products that are
// merely rare. "Xbox Elite Controller Series 2", "HoverAir X1 Travel Combo" and
// "Minolta 100-300 f/4.5-5.6" are all real, and a check that cannot tell rare
// from wrong produces 25 findings per 798 of which almost none are true. The
// abstention rules below are that lesson written as instructions.
const NAME_SYSTEM = `You are checking product titles for a used-electronics and
video-game reseller. Each title was written by store staff and may contain a
mangled product name.

Report a title ONLY when one of these is true:

  "garbled" — the product name as written is not a real product name. It is a
  typo, a misspelling, or a mangled rendering of a real product. Example: a
  camera titled "Sony OX 7 IV" where the real product is the Sony a7 IV.

  "wrong"   — the title states something factually untrue about the product it
  names. Example: a motherboard titled "AsRock B650M ... LGA1700 Intel" when the
  B650M is an AMD board.

Otherwise return "ok".

ABSTAIN unless you are confident. Returning "ok" is always the safe answer and
is never penalised. In particular:

- This inventory is USED and often obscure, rare, regional, discontinued, or
  low-volume. A product being unfamiliar or rarely sold is NOT an error. If you
  are not sure a product exists, return "ok".
- YOUR KNOWLEDGE HAS A CUTOFF AND THIS SHOP SELLS THINGS RELEASED AFTER IT.
  THE TEST IS WHETHER A WORD IS MISSPELLED, NOT WHETHER YOU RECOGNISE IT.

    * An unfamiliar but WELL-FORMED variant in a line you know — "MacBook Neo",
      a Galaxy model you have not seen, a GeForce number you do not recognise —
      is almost certainly a product released after your cutoff. Return "ok", and
      NEVER correct it to the nearest variant you do know. "Neo" is a real word
      spelled correctly; it is not a mangling of "Air".

    * A word that is MISSPELLED — letters wrong, transposed, doubled or missing
      — is still an error however new the product is, and you should still
      report it: "Harmon Kardon" for Harman Kardon, "Assasins Creed" for
      Assassin's Creed, "Steeleseries" for SteelSeries, "Vivant" for Vivint,
      "Amaxon" for Amazon, "DGI" for DJI.

  And a stated specification that contradicts a part number in the same title is
  always reportable — "PC3-14900" is 1866MHz whatever the title says. That is
  arithmetic, not recognition.
- Do NOT report a title for being short, vague, incomplete, badly punctuated,
  oddly capitalised, or for missing details. Other checks handle all of that.
- Do NOT report condition or handling words: Broken, For Parts, Read, No Power,
  Cracked, Scratched, New, Refurbished, Factory Unlocked, WiFi Only, GSM.
- Do NOT report manufacturer part numbers, SKUs, or model codes that look like
  gibberish (MK8F3LL/A, SM-A156U, GA10052-US). Those are real and correct.
- Do NOT report carrier names, storage sizes, colours, or screen sizes.
- A brand written in the wrong case ("google Pixel", "AsRock") is NOT an error.

When you do report one, you must quote the wrong text EXACTLY as it appears in
the title, character for character, in "wrong_text" — and give the correction in
"correct_text" as it should replace that exact text. Quote the smallest span
that contains the error. If you cannot quote the error verbatim from the title,
return "ok" instead.

Keep "why" to one short sentence a shop manager can act on.`;

// A stable, human-readable stamp of the exact title we asked about. Compared
// against the live title to decide whether a listing still has an answer.
// ⚠️ Deliberately NOT a hash — the value is readable in the table, and when a
// verdict looks wrong you can see what it was given.
const askedStamp = (title: string) => `${ASK_RECIPE}|${(title || "").trim()}`;

async function checkNamesBatch(
  client: any,
  items: { id: string; title: string; brand: string; model: string; shelf: string }[],
): Promise<{ verdicts: Record<string, NameVerdict>; input: number; output: number }> {
  const out: Record<string, NameVerdict> = {};
  if (!items.length) return { verdicts: out, input: 0, output: 0 };

  const res = await client.messages.parse({
    model: NAME_MODEL,
    max_tokens: 8000,
    system: NAME_SYSTEM,
    messages: [{
      role: "user",
      content: "Check these listings:\n\n" + JSON.stringify(
        items.map(i => ({
          id: i.id, title: i.title,
          spec_brand: i.brand || undefined,
          spec_model: i.model || undefined,
          shelf: i.shelf || undefined,
        })), null, 1),
    }],
    output_config: { format: zodOutputFormat(NameReportSchema) },
  });

  const parsed = res?.parsed_output;
  // ⚠️ NULL MEANS THE ANSWER DID NOT VALIDATE. Treat it as "did not ask", never
  // as "everything is fine" — a silent all-clear is the one answer this check
  // must never invent, and the caller declines to stamp the clock on a throw.
  if (!parsed || !Array.isArray(parsed.results)) {
    throw new Error("the name check returned nothing that matched its schema");
  }
  for (const r of parsed.results) {
    if (r && typeof r.id === "string") out[r.id] = r as NameVerdict;
  }
  // Reported all the way out to the sweep response so the bill is a number
  // somebody can read after a run, not an estimate in a commit message.
  return {
    verdicts: out,
    input: Number(res?.usage?.input_tokens || 0),
    output: Number(res?.usage?.output_tokens || 0),
  };
}

type Row = {
  store_code: string; product_id: string; sku: string; title: string;
  product_handle: string | null; price: number | null; quantity: number;
  category_id?: string | null; category_name?: string | null;
  ebay_title?: string | null;
  // Whether the (low-precision, opt-in) brand/model name checks may report.
  wantNames?: boolean;
  // When our eBay snapshot for this SKU was taken. The drift finding quotes it,
  // because the sweeps that fill ebay_live are paused and a stale comparison
  // presented as current is worse than no comparison.
  ebay_seen_at?: string | null;
  // The last title WE applied to this listing, if any. Present so the drift
  // finding can tell "these two systems disagree" apart from "we corrected this
  // and eBay has not caught up yet" — opposite errands with the same symptom.
  ourMove?: { after_title: string; applied_at: string } | null;
};

// ⚠️ HOW LONG EBAY GETS TO CATCH UP BEFORE WE CALL IT A PROBLEM.
// Approving a title makes eBay stale by definition — that is a CONSEQUENCE of
// the fix, not a discovery, and reporting it the next morning made the tool
// manufacture its own backlog: three of the seven drift rows in the queue on
// 2026-09-01 were titles we had corrected ourselves. So the first few days are
// silent. After that the silence would be the lie — Marketplace Connect owns
// these listings now, and one that never syncs is a real problem wearing a
// title-drift costume, which is why the message changes rather than staying off.
const DRIFT_GRACE_DAYS = 5;

type Analysis = {
  findings: Finding[];
  suggested: string | null;
  basis: string;
  confidence: string;
  comps: { title: string; price: string | null; itemId: string | null }[];
};

// Cut on a word boundary so a listing never ends mid-word. eBay refuses over 80
// outright, and Shopify would happily store a 140-character title that then
// fails to publish — so the cap is applied here, not left to the channel.
function capTitle(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length <= EBAY_TITLE_MAX) return t;
  const cut = t.slice(0, EBAY_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
}

// The house rule: every word capitalised. Applied only to words the fixer
// ITSELF adds — an author-typed title is left exactly as the person wrote it,
// and acronyms are already upper case in the sources we draw from.
const titleWord = (w: string) =>
  /^[A-Z0-9/-]+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

// modelReal: true it exists, false the market has never heard of it, null not
// asked. Null and false must never be conflated — silence is not evidence.
function analyse(row: Row, extra: Extra | undefined, comps: any[] | null,
                 modelReal: boolean | null, modelExample?: string | null,
                 brandReal?: boolean | null, convention?: Convention,
                 nameVerdict?: NameVerdict | null): Analysis {
  const findings: Finding[] = [];
  const original = (row.title || "").trim();
  let title = original;
  let fixable = false;

  // ⚠️ NEVER TRUNCATE TO MAKE ROOM FOR AN ADDITION.
  // capTitle cuts on a word boundary, which is right when a title arrives too
  // long — and catastrophic as a way of fitting an addition in. Appending
  // " Bundle" to a 79-character Asus title produced
  // "…32GB RAM 1TB SSD GeForce RTX", silently dropping the 4050 to buy room for
  // a word we chose to add. The suggestion was different from the original, so
  // it shipped as a proposal to make the listing worse.
  //
  // An addition that does not fit is simply not made: the finding still reports
  // (it is true — the title really does not say it is a bundle) but as
  // report-only, so the reviewer decides what to shorten. Never a silent trade.
  const tryAppend = (word: string): boolean => {
    if (title.length + 1 + word.length > EBAY_TITLE_MAX) return false;
    title = `${title} ${word}`; fixable = true; return true;
  };
  // The length rule is the closure's; WHERE the word goes is placeAfter, which
  // lives at module scope so the estate's own titles can be asserted against it.
  const tryPlace = (word: string, after: string): boolean => {
    if (title.length + 1 + word.length > EBAY_TITLE_MAX) return false;
    const placed = placeAfter(title, word, after);
    if (placed === null) return tryAppend(word);
    title = placed; fixable = true; return true;
  };


  // --- 3: the listing is wrong ---------------------------------------------

  if (NOT_A_LISTING.some(re => re.test(original))) {
    findings.push({
      code: "not-a-listing",
      says: "This does not look like a product for sale — it reads as internal equipment or a placeholder, and it is live on the online store. Unpublish it in Shopify rather than renaming it.",
      severity: 3, fixable: false,
    });
    // Nothing else is worth saying about a title that should not exist, and a
    // suggestion here would invite somebody to Approve their way past the real
    // problem.
    return { findings, suggested: null, basis: "rules", confidence: "high", comps: [] };
  }

  // eBay's live title disagrees with Shopify's. Entities and whitespace are
  // normalised away first: 25 of the 29 differences measured across the estate
  // were only `&` vs `&amp;` from our own sweep, and reporting those would bury
  // the three real ones.
  // ⚠️ A LOW-OVERLAP PAIR IS NOT A TITLE PROBLEM — IT IS TWO DIFFERENT ITEMS.
  // Ethan, seeing the first queue: "the 1st and 3rd one are different entirely.
  // one is 8Gb when you show 16Gb and the games aren't the same at all."
  // He is right, and "one of these titles is wrong, pick one" was the wrong
  // question: nobody should retitle either. Measured on all six drift pairs the
  // split is clean —
  //     18%  Nuvo AM/FM Tuner        vs Six-Zone Audio Distribution System
  //     44%  SK Hynix 8GB            vs 16GB, different part number
  //     50%  Super C (NES 1990)      vs Tecmo Super Bowl (NES 1991)
  //   -------------------------------- 65% cut ------------------------------
  //     69%  same part number, "PC4-2666V-SE1-11" vs "SODIMM"
  //     85%  "Factory Unlocked"      vs "T-Mobile"
  //     86%  "GeForce RTX 3050"      vs "GTX 1060"
  // Above the cut it is one item whose listings disagree about a detail, which is
  // worth a manager's attention. Below it the eBay item mapped to this SKU is a
  // DIFFERENT PRODUCT — a mapping problem for the dupe/order tooling, not a title
  // to rewrite — so it is counted and reported by the sweep, never queued here.
  const driftOverlap = (a: string, b: string): number => {
    const wa = norm(a).split(" ").filter(w => w.length > 1);
    const wb = new Set(norm(b).split(" ").filter(w => w.length > 1));
    if (!wa.length || !wb.size) return 0;
    const shared = wa.filter(w => wb.has(w)).length;
    return Math.round(100 * shared / Math.max(wa.length, wb.size));
  };
  const sameItem = row.ebay_title
    ? driftOverlap(original, row.ebay_title) >= 65 : false;
  if (row.ebay_title && norm(row.ebay_title) !== norm(original) && sameItem) {
    // ⚠️ THIS IS THE ONE FINDING THAT DOES NOT READ LIVE DATA, and it has to say
    // so. `ebay_live` is filled by the five `ebay-live-sweep-*` crons, which are
    // PAUSED (see [[ebay-exposure-false-positives]]) — 73 hours stale when this
    // was written, and getting staler. Every other finding here reads
    // ebay_catalog, which a Shopify sweep refreshes six times a day.
    //
    // So the age goes in the sentence. Without it the row reads as "eBay is
    // showing this right now", which is a claim we cannot make: the listing may
    // have been fixed since, and NEW drift is invisible until the sweeps resume.
    // Saying "as of N days ago" costs nothing and is the difference between a
    // finding somebody can act on and one that quietly misleads.
    const age = row.ebay_seen_at ? _daysAgo(row.ebay_seen_at) : null;
    const when = age === null ? "when we last looked"
      : age < 1 ? "as of today"
      : `as of our last eBay snapshot, ${age} day${age === 1 ? "" : "s"} ago`;
    // The listing's own record decides it wherever it can, and the sentence
    // changes completely with the answer — because so does WHO FIXES IT and
    // WHERE. "Correct the eBay listing" and "correct Shopify" are opposite
    // errands, and the old copy sent somebody to work it out for themselves.
    // Did WE put this title here, and is eBay still showing what it replaced?
    // Then this is not two systems disagreeing about the truth — we know the
    // truth, we wrote it — it is one system that has not been told yet.
    const mine = row.ourMove && norm(row.ourMove.after_title) === norm(original)
      ? row.ourMove : null;
    const mineAge = mine ? _daysAgo(mine.applied_at) : null;
    if (mine && mineAge !== null && mineAge < DRIFT_GRACE_DAYS) {
      // Silent, and deliberately not even a low-severity note: there is nothing
      // for a reviewer to decide while the sync still has time to happen.
    } else if (mine) {
      findings.push({
        code: "ebay-not-synced",
        says: `We corrected this title on ${new Date(mine.applied_at).toLocaleDateString("en-US",
                { month: "short", day: "numeric" })} and eBay is still showing the old one ${when} `
          + `— "${row.ebay_title}". ${mineAge} days is past any normal sync, so this is not a title `
          + `to rewrite: the Shopify title here is already right. The eBay listing is the copy that `
          + `needs correcting, and it is owned by Marketplace Connect.`,
        severity: 3, fixable: false,
      });
    } else {
    const verdict = adjudicate(original, row.ebay_title, extra?.specs);
    const stale = age !== null && age >= 2
      ? ` ⚠️ Our eBay snapshot is ${age} days old, so confirm on eBay itself rather than trusting this line.`
      : "";
    findings.push({
      code: "title-drift",
      says: verdict?.side === "ours"
        ? `eBay is showing "${row.ebay_title}" ${when}, but this listing's own ${verdict.field} field says "${verdict.value}" — which is what the Shopify title says. OUR TITLE IS RIGHT AND THE EBAY ONE IS STALE, so do not change anything here: the eBay listing is the copy that needs correcting.`
        : verdict?.side === "theirs"
          ? `eBay is showing "${row.ebay_title}" ${when}, and this listing's own ${verdict.field} field says "${verdict.value}" — which agrees with eBay, not with the Shopify title. THE SHOPIFY TITLE LOOKS LIKE THE WRONG ONE. Check the unit, then correct the title here.`
          : `eBay showed "${row.ebay_title}" ${when}, while Shopify says "${original}". One of the two is wrong in front of a buyer, and this listing's spec table does not settle which. Check which is the real item before changing anything — a wrong title here is a misdescribed sale, not a missed one.`,
      severity: 3, fixable: false,
    });
    if (stale) findings[findings.length - 1].says += stale;
    }
  }

  // THE TITLE CONTRADICTS THE LISTING'S OWN SPEC TABLE. Severity 3: this is not
  // a missing keyword, it is the listing disagreeing with itself, and one of the
  // two numbers is being shown to a buyer as fact.
  //
  // Real, from OVL: "ANTEC 520W HIGH CURRENT GAMER POWER SUPPLY" whose spec table
  // says Brand PowerSpec and MPN "PS 650BSM" — wrong maker AND wrong wattage.
  // "Lot of 21 HMT42GR7BFR4A-PB" whose Brand field reads "15x SK Hynix".
  //
  // Matched on NUMBER + UNIT so it cannot fire on wording: the same unit carrying
  // a different number in the two places is a factual disagreement, whereas a
  // spec the title simply omits is laziness and handled below.
  {
    const sp = extra?.specs || {};
    const unitsIn = (text: string) => {
      const out = new Map<string, Set<string>>();
      for (const m of String(text).matchAll(/\b(\d+(?:\.\d+)?)\s?(w|watt|watts|gb|tb|mb|mhz|ghz|mp|in|inch|"|hz)\b/gi)) {
        const unit = m[2].toLowerCase().replace(/^watts?$/, "w").replace(/^inch$/, "in").replace(/^"$/, "in");
        if (!out.has(unit)) out.set(unit, new Set());
        out.get(unit)!.add(m[1]);
      }
      return out;
    };
    const tUnits = unitsIn(original);
    for (const k of TITLE_SPECS) {
      const v = String(sp[k] || "").trim();
      if (!v || PLACEHOLDER.test(v)) continue;
      for (const [unit, vals] of unitsIn(v)) {
        const mine = tUnits.get(unit);
        if (!mine || !mine.size) continue;
        // Only when they share NO value for that unit at all. A title listing
        // both 8GB RAM and 512GB storage must not fight a spec naming one.
        const agrees = [...vals].some(x => mine.has(x));
        if (agrees) continue;
        findings.push({
          code: "spec-conflict",
          says: `The title says ${[...mine].join("/")}${unit === "in" ? '"' : unit.toUpperCase()} but this listing's own ${k} field says ${v}. One of the two is wrong, and a buyer is being shown a number the listing does not agree with. Check the unit and correct whichever is wrong.`,
          severity: 3, fixable: false,
        });
        break;
      }
      if (findings.some(f => f.code === "spec-conflict")) break;
    }
  }

  // A TITLE THAT STOPS MID-PHRASE. "Minecraft: Story Mode Complete Adventure
  // (Nintendo Wii U," and "Batman: The Enemy Within (Playstation 4," are both
  // live — an unclosed bracket is a title somebody's tooling truncated, and it
  // reads as broken to a shopper.
  {
    const opens = (original.match(/[([]/g) || []).length;
    const closes = (original.match(/[)\]]/g) || []).length;
    const dangling = /[,\-–/(]\s*$/.test(original.trim());
    // ⚠️ A TITLE CAN BE CUT OFF WITH ITS BRACKETS BALANCED. "Nintendo Switch
    // OLED The Legend of Zelda Tears of the" ends on a joining word — there is
    // no punctuation to notice, and it was reaching the queue as a title worth
    // ADDING WORDS TO rather than one that had lost them.
    // WARN: REQUIRE A SPACE, AND NEVER SINGLE LETTERS. The first version used a
    // word boundary and matched the "A" in every Apple part number - a slash is
    // a word boundary, so "MFXH4LL/A", "MYL92LL/A" and even "N/A" read as titles
    // cut off mid-phrase. 48 of the 49 it caught were false; the one real one was
    // "...Zelda Tears of the". Dropped "a", "an" and "plus" as well: "Atari 2600
    // Console System CX-2600 A" is a model number and "Wii Fit Plus" is a name.
    const hanging = /\s(of|the|and|for|with|in|on|to|by|from)\s*$/i
      .test(original.trim());
    if (opens !== closes || dangling || hanging) {
      findings.push({
        code: "truncated-title",
        says: opens !== closes
          ? "The title has an unclosed bracket, so it was cut off before it finished. A shopper sees a title that stops mid-phrase."
          : hanging
            ? "The title ends on a joining word, so it was cut off mid-phrase — the rest of the name is missing."
            : "The title ends on a comma or dash, so something was meant to follow it and did not.",
        severity: 2, fixable: false,
      });
    }
  }

  // ⚠️ ONE FLAG, COMPUTED HERE, GUARDING EVERY APPEND BELOW.
  // A title that is broken or that contradicts its own spec table must be
  // repaired by a person before anything is added to it: appending to it produces
  // a suggestion strictly worse than the title it replaces, and this file's whole
  // premise is that a suggestion can be trusted.
  // ================== THE NAME THE LISTING GOT WRONG ========================
  // The only model-backed finding in the file. See NAME_SYSTEM for why code
  // cannot reach it and what the model is told to abstain on.
  //
  // ⚠️⚠️ THE QUOTE IS VERIFIED, NEVER TRUSTED. The model must hand back the
  // wrong text exactly as it appears in the title; we find that span ourselves
  // and swap it. If the span is not in the title character for character the
  // finding is DROPPED ENTIRELY — not downgraded, not reported without a fix.
  // That is what keeps the house rule intact: every suggestion is the current
  // title plus NAMED edits, and a model cannot write a title here even if it
  // tries. It is also the only defence against a confident wrong answer.
  //
  // ⚠️ A REPLACEMENT, NEVER AN APPEND. capTitle is not involved and tryAppend is
  // not used: a name fix substitutes one span for another, so it cannot push a
  // title past 80 characters unless the correction is longer than the error —
  // and in that one case it goes report-only rather than truncating, for the
  // same reason "…GeForce RTX" was never acceptable.
  if (nameVerdict && nameVerdict.verdict !== "ok") {
    const wrong = String(nameVerdict.wrong_text || "");
    const right = String(nameVerdict.correct_text || "").trim();
    const at = wrong ? title.indexOf(wrong) : -1;
    // ⚠️ A CORRECTION CAN BE A PLACEHOLDER, AND THE QUOTE CHECK CANNOT SEE IT.
    // WSP's truncated `"v (Neo Geo MVS,"` came back with the replacement
    // "[actual game title]" — the quoted wrong text really was in the title, so
    // every existing guard passed, and approving it would have written the
    // literal words "[actual game title]" onto a live storefront. The quote
    // check proves the model read the title; it proves nothing about whether the
    // model KNOWS the answer. This is the other half.
    const placeholder = /[\[\]<>{}]|\b(actual|correct|real|proper|insert|unknown|tbd|xxx+)\b/i
      .test(right);
    // No finding is pushed, so the sweep's own check — a non-ok verdict that
    // produced no name finding — counts it as `unverified`, exactly like a quote
    // that could not be located. Same failure, same counter, one rate to watch.
    if (!placeholder && at >= 0 && right && right !== wrong) {
      const swapped = (title.slice(0, at) + right + title.slice(at + wrong.length))
        .replace(/\s+/g, " ").trim();
      const wrongIsWrong = nameVerdict.verdict === "wrong";
      const why = String(nameVerdict.why || "").trim();
      const fits = swapped.length <= EBAY_TITLE_MAX;
      if (fits) { title = swapped; fixable = true; }
      // ⚠️ THE REASON LEADS WITH THE FACT, and the instruction is a SEPARATE
      // line. This used to be one four-sentence paragraph — what the title
      // says, what it should say, why, where the judgement came from, and what
      // to do about it — and a reviewer working through a hundred rows read
      // the first clause and skipped the rest. The `why` is the part that
      // settles it ("Hero11 Black is not a 360 camera"), so it goes first and
      // the correction follows; everything about HOW we know moves to `warn`,
      // which the page renders as its own red bullet underneath.
      const tidyWhy = why ? why.replace(/\s+$/, "").replace(/[.;,]$/, "") : "";
      findings.push({
        code: wrongIsWrong ? "name-wrong" : "name-garbled",
        severity: wrongIsWrong ? 3 : 2,
        fixable: fits,
        says: (wrongIsWrong
          ? (tidyWhy
              ? `${tidyWhy} — "${wrong}" should be "${right}".`
              : `The title says "${wrong}"; it should be "${right}".`)
          : `"${wrong}" is not a real product name — it looks like "${right}" typed wrong`
            + (tidyWhy ? `. ${tidyWhy}.` : `, so nobody searching for it will find this listing.`))
          + (fits ? "" : ` The correction does not fit in 80 characters, so it needs editing by hand.`),
        // Only where we genuinely cannot settle it from the listing. Every other
        // finding on this page is read off the title and the spec table, and
        // saying so on those rows too would train people to ignore the line.
        warn: "Checked against outside product knowledge, not against your own listing — verify this one against the product before approving.",
      });
    }
    // Quote not found in the title: the model described an error it could not
    // point at. Silently dropped, and counted by the sweep as `unverified` so
    // the rate is visible rather than invisible.
  }

  const brokenTitle = findings.some(f =>
    f.code === "truncated-title" || f.code === "spec-conflict");

  for (const c of CONFLICTS) {
    if (!c.when.test(original) || !c.claims.test(original)) continue;
    findings.push({ code: "hardware-conflict", says: c.says, severity: 3, fixable: !!c.replace });
    if (c.replace) { title = title.replace(c.replace[0], c.replace[1]); fixable = true; }
  }

  // --- 2: the listing cannot be found --------------------------------------

  // A MODEL NAME THE MARKET HAS NEVER HEARD OF. This is the finding that pays
  // for the eBay half. OVL's $1,499.99 KS01-7548G-E7 was "Sony OX 7 IV 33MP
  // Mirrorless Digital Camera" — the alpha of an a7 IV mangled into "OX". There
  // is no Sony OX 7, so nobody will ever search for it, and no rule that reads
  // only our own catalogue can know that.
  //
  // The test is a Browse query for brand + the model token: an existing model
  // returns hundreds of live listings, a nonexistent one returns nothing. We
  // only trust a zero when the control query proved Browse was answering —
  // `modelSeen` is undefined for "never asked", which is not the same as false.
  const sm = specModel(extra?.specs);

  // ⚠️⚠️ THE NAME CHECKS ARE OFF BY DEFAULT AND MUST STAY OFF UNTIL SOMEBODY
  // IMPROVES THEIR PRECISION. `names=1` on the sweep turns them on.
  //
  // FIVE designs were measured against real data and none reached a precision
  // this queue can carry:
  //   1. "Browse returned nothing"      — Browse is FUZZY; a fabricated model
  //                                       still returns listings
  //   2. corpus test, model from title  — 13 findings per 450 items, ~2 real
  //                                       (brand read as "New"/"WiFi", MPNs
  //                                       checked as models, "RMx 80" invented)
  //   3. corpus test, model from specs  — clean on a 350-item sample, then 25
  //                                       findings per 798 at OVL of which most
  //                                       were real products eBay just has few
  //                                       listings of (Xbox Elite Controller
  //                                       Series 2, HoverAir X1, Minolta 100-300)
  //   4. brand check instead            — Browse's fuzzy match returns *Vivint*
  //                                       listings for the query "Vivant", so it
  //                                       CONFIRMS the typo it exists to catch
  //   5. brand + bigger corpus          — abstains on the real cases
  //                                       ("Steeleseries" -> corpus too thin)
  //
  // The root cause is not fixable by tuning: absence from a sample is weak
  // evidence when the search is fuzzy AND the catalogue has a long tail of items
  // we own the only copy of. It needs a different source — an actual product
  // catalogue to match against, or eBay's own catalogue/EPID lookup.
  //
  // The reasoning is KEPT, and `?peek=…&market=1` still reports both verdicts,
  // because it is genuinely useful for investigating ONE suspicious title by
  // hand. What it may not do is write rows into a review queue whose only asset
  // is that every row is worth reading. The real ones it did find are worth
  // fixing directly: "Sony OX 7 IV" (an a7 IV), "Vivant" (Vivint),
  // "Steeleseries" (SteelSeries), "Bose Waves" (Wave), "nemko Focusrite".
  const wantNames = !!row.wantNames;

  // THE BRAND IS NOT A BRAND. Severity 3: a misspelled maker is wrong on the
  // listing, not merely unhelpful, and it is the worst thing for findability
  // because brand is the first filter most buyers touch.
  if (wantNames && brandReal === false && sm) {
    findings.push({
      code: "brand-not-found",
      says: `No other seller's live eBay listing uses the brand "${sm.brand}", and a real brand appears on thousands of them. It is probably misspelled, or it is not the maker's name at all — a certification mark, or a reseller. Brand is the first thing most buyers filter on, so this hides the item completely. Check the name printed on the unit.`,
      severity: 3, fixable: false,
    });
  }

  // ⚠️ A MODEL WE CANNOT CONFIRM IS SEVERITY 2, NOT 3, AND IT SAYS SO.
  // Over a WHOLE store this fires on plenty of real products that eBay simply
  // has few listings of, so it is framed as "could not confirm" rather than "is
  // wrong", and it sits in Hard To Find, where an unsearchable title belongs.
  //
  // Suppressed when the BRAND is the thing that is wrong: blaming the model for
  // a misspelled maker sends somebody to check the wrong field.
  if (wantNames && modelReal === false && sm && brandReal !== false) {
    const m = sm.model;
    findings.push({
      code: "model-not-found",
      says: `We could not confirm the model "${m}" — no other live eBay listing for this brand mentions it.`
        + (modelExample ? ` One of them is titled "${modelExample}".` : "")
        + ` That is often a mistyped or in-house name, in which case nobody searching for the real one will find this. It can also just mean we have the only one on eBay, so check the model printed on the unit before changing anything.`,
      severity: 2, fixable: false,
    });
  }

  // THE TITLE NEVER SAYS WHAT THE ITEM IS. Real example: "Codi 34" MO34H-UC 4K
  // LED Mini-LED Ultra Wide" — a monitor with no "Monitor" in it, invisible to
  // the search that would have bought it.
  //
  // The noun comes from the listing's own filing (`Type`, then
  // `Sub-Collection`, then `Collection`), so the
  // finding can PROPOSE the missing word instead of only complaining that it is
  // missing — and so a category we have never thought about is handled without a
  // new rule.
  //
  // ⚠️ VIDEO GAMES ARE EXEMPT. "Asura's Wrath (Microsoft Xbox 360, 2012)" has no
  // product noun and needs none: title-then-platform-in-parentheses is eBay's
  // own convention for games and is exactly what buyers type. The first dry run
  // flagged every game at OVL, which is how this exemption got written.
  const collection = (extra?.specs?.["Collection"] || "").trim();
  const isGame = /video\s*game|\btcg\b|trading\s+card/i.test(collection);
  const specType = (extra?.specs?.["Type"] || "").trim();
  // ⚠️ THE SPEC TABLE IS THE SECOND OPINION, AND IT IS THE ONE THAT MATTERS.
  // A hand-kept noun list will never be complete — the first version missed
  // "Power Supply", "Glasses", "Subwoofer" and "Equalizer" inside eighty rows,
  // and every miss is a false accusation against a title that is fine. So a
  // title that already contains its own Type or Collection word passes, whatever
  // the list thinks. The list only has to catch the case where BOTH are silent.
  const saysItsOwnType = [specType, collection]
    .filter(v => v && !PLACEHOLDER.test(v))
    .some(v => {
      const words = tokens(v).filter(w => w.length > 2);
      return words.length > 0 && words.some(w => tokens(original).includes(w));
    });
  // ⚠️ COMPOUND NOUNS ARE ONE TOKEN, AND SHELF WORDS ARE OFTEN PLURAL —
  // `isProductNoun` owns both rules so the accusation and the proposal cannot
  // drift apart.
  const namesItself = tokens(original).some(isProductNoun);
  if (!brokenTitle && !isGame && !saysItsOwnType && !namesItself) {
    // ⚠️ MOST SPECIFIC FIRST, AND EVERY SOURCE IS ALLOWED TO SAY NO.
    // Type is what a lister typed about this unit, Sub-Collection is the shelf,
    // Collection is the department. `shelfNoun` is the gauntlet — a department
    // name reaching a live suggestion is the failure this whole path guards.
    let noun: string | null = null;
    let shelfSaid = "";
    for (const [v, shelfLevel] of [[specType, false],
                                   [extra?.specs?.["Sub-Collection"], true],
                                   [collection, false]] as [unknown, boolean][]) {
      const n = shelfNoun(String(v || "").trim(), title, shelfLevel);
      if (n) { noun = n; shelfSaid = String(v).trim(); break; }
    }
    // ⚠️ SEVERITY DEPENDS ON WHETHER ANYTHING ELSE MAKES IT FINDABLE.
    // "Codi 34\" MO34H-UC 4K LED Mini-LED Ultra Wide" carries a model number, so a
    // buyer CAN reach it — adding "Monitor" is an improvement, not a rescue. A
    // title with neither a product word nor a model is genuinely unreachable.
    // Grading these the same put 156 rows in Hard To Find, most of which were
    // findable, and that is what makes a tier stop being read.
    // Only ever read when we HAVE a word and it will not fit; computing it
    // there and then would bury the message in a nested conditional.
    const cuttable = noun ? alsoInSpecs(original, extra?.specs) : [];
    const findableAnyway = !!(extra?.specs?.["Model"] || extra?.specs?.["MPN"])
      && tokens(original).some(t => /\d/.test(t) && t.length >= 3);
    // ⚠️ THE 90% RULE APPLIES HERE TOO. Ethan, 2026-08-28: "if we believe the
    // title is like 90%+ strength we don't need to change anything." A title that
    // already carries every searchable detail the listing knows AND can be found
    // by its model number is not one anybody needs to open — the generic noun is
    // the last five percent, and queueing 156 rows for it buries the work that
    // matters. It still reports when the title is thin, or when nothing else
    // makes the item reachable at all.
    // ⚠️ ONLY WHERE NOTHING ELSE MAKES THE ITEM FINDABLE.
    // Ethan: "Don't need the missing noun at least for common items. Most people
    // know what phone brands they are, but some items definitely could use a
    // missing noun." Exactly right — nobody searches "Google Pixel 10 Pro XL
    // Android Phone", they search the model, so appending the noun is dead weight
    // on a title the listing software already built from what sells. But
    // "Thrustmaster TS-XW Servo Base" or "Mobile Pixels Duex Pro" name nothing a
    // shopper would type.
    //
    // `findableAnyway` already separates the two: a title carrying a real model
    // number can be reached, so the noun is polish. Only the unreachable case is
    // queued now, which is the severity-2 half — the severity-1 half (24 rows of
    // phones and the like) is dropped entirely rather than demoted.
    const strong = strengthOf(original, extra?.specs);
    const alreadyStrong = (!!strong && strong.pct >= 90 && findableAnyway) || findableAnyway;
    // ⚠️ APPEND ONLY IF WE ARE GOING TO REPORT. tryAppend mutates the title and
    // sets `fixable`, so calling it before this gate produced a suggested title
    // with no finding beside it — a diff on the row that nothing explained.
    let applied = !alreadyStrong && !!noun && tryAppend(noun);
    // ⚠️ ONLY WHEN APPENDING OUTRIGHT HAS ALREADY FAILED. The straight append is
    // always preferred — a title that loses nothing is better than one that
    // trades, however good the trade.
    let trimmed: string[] = [];
    if (!alreadyStrong && !applied && noun) {
      const room = trimToFit(title, noun, extra?.specs);
      if (room) {
        title = room.title; trimmed = room.gone;
        applied = tryAppend(noun);
        // Belt and braces: if the append still refuses, put the title back. A
        // suggestion that only DELETED words would be a title made worse.
        if (!applied) { title = original; trimmed = []; }
      }
    }
    if (!alreadyStrong) findings.push({
      code: "missing-noun",
      // ⚠️ THE TRADE IS NAMED IN FULL OR IT IS NOT OFFERED. The reviewer is
      // approving a DELETION as well as an addition, so the sentence has to say
      // what went, why it was safe, and where it still lives.
      ...(trimmed.length ? { trimmed } : {}),
      says: (applied && trimmed.length
        ? `The title never says what the item IS. This listing is filed under "${shelfSaid}", so "${noun}" is the word a buyer would type. There was no room for it, so ${trimmed.join(" and ")} ${trimmed.length === 1 ? "comes" : "come"} out to make space — the spec table still states ${trimmed.length === 1 ? "it" : "them"}, so the listing keeps ${trimmed.length === 1 ? "it" : "them"} and only the title is shorter.`
        : applied
        ? `The title never says what the item IS. This listing is filed under "${shelfSaid}", so "${noun}" is the word a buyer would type — most people search for the kind of thing they want, and those words never match this listing.`
        // ⚠️ WE KNOW THE WORD, AND EVEN TRADING WOULD NOT FIT IT. The last
        // resort, reached only when trimToFit refused: nothing in the title is a
        // fact the spec table also holds, or three removals still were not
        // enough. Saying "no safe automatic fix" here would throw away the
        // answer the listing was holding all along, so name the word instead and
        // let the reviewer decide what a machine may not.
        : noun
          ? `The title never says what the item IS. This listing is filed under "${shelfSaid}", so "${noun}" is the missing word — but the title is already ${original.length} of ${EBAY_TITLE_MAX} characters, so something has to come out before it will fit.`
            // Name what is safe to lose. Every value here is stated in the
            // spec table, so the title is the only place it would disappear
            // from — the fact a reviewer would otherwise go and check by hand.
            // On this branch trimToFit has already declined to spend them, so
            // this is a shortlist for a person, not a plan we could not execute.
            + (cuttable.length
                ? ` The spec table already states ${cuttable.join(", ")}, so cutting ${cuttable.length === 1 ? "that" : "any of those"} from the title takes nothing out of the listing.`
                : "")
          : "The title never says what the item IS. Most buyers type the kind of thing they want, so the words they use never match this listing.")
        + (findableAnyway ? " It can still be found by its model number, so this is an improvement rather than a rescue." : ""),
      severity: findableAnyway ? 1 : 2, fixable: applied,
    });
  }

  // --- 1: money on the table ----------------------------------------------

  for (const [re, to] of ([] as [RegExp, string][])) {   // see REDUNDANT_RETIRED
    if (!re.test(title)) continue;
    findings.push({
      code: "redundant-phrase",
      says: `"${(title.match(re) || [""])[0]}" says the same thing twice and spends characters doing it. Shortening it frees room for a word a buyer might actually search.`,
      severity: 1, fixable: true,
    });
    title = title.replace(re, to); fixable = true;
  }

  // An exactly repeated run: "18-55mm f/5.6 18-55mm f/5.6", or a brand typed
  // twice at the front ("3DR 3DR Solo S110A"). Longest run first, so a two-word
  // repeat is one finding rather than two single-word ones.
  //
  // ⚠️ THE SINGLE-WORD RULE IS ANCHORED TO THE START OF THE TITLE, and it has to
  // be. Unanchored, it proposed turning "Disney Tsum Tsum Festival (Nintendo
  // Switch, 2019)" into "Disney Tsum Festival" — the repetition IS the product's
  // name. Anchoring it targets the artifact this was written for, a brand
  // prepended twice by the listing tool, and leaves real names alone.
  // WARN: A REPEAT FOLLOWED BY AN APOSTROPHE IS PART OF THE NAME, NOT A MISTAKE.
  // "Pokemon TCG The Glory of Team Rocket Team Rocket's Mewtwo EX" is a SET
  // called The Glory of Team Rocket holding a CARD called Team Rocket's Mewtwo.
  // Collapsing it produced "The Glory of Team Rocket's Mewtwo EX" - a different,
  // non-existent set, on a PSA 10 graded card. Caught in a dry run, never shipped.
  const dupRaw = original.match(/\b(\S+\s+\S+(?:\s+\S+)?)\s+\1\b/i)
    || original.match(/^(\S{2,})\s+\1\b/i);
  const dup = dupRaw && !/^['’]/.test(
    original.slice((dupRaw.index || 0) + dupRaw[0].length)) ? dupRaw : null;
  if (dup) {
    findings.push({
      code: "repeated-phrase",
      says: `"${dup[1]}" appears twice in a row. It reads as a mistake to a buyer and costs ${dup[1].length + 1} characters.`,
      severity: 1, fixable: true,
    });
    title = title.replace(new RegExp(`\\b(${dup[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s+\\1\\b`, "i"), "$1");
    fixable = true;
  }

  // UNDECLARED BUNDLE — two distinct MAJOR product categories named in one
  // title, and no word that says so. See MAJOR_CATEGORIES for why this reads the
  // title rather than the accessory metafield.
  let cats = MAJOR_CATEGORIES.filter(([, re]) => re.test(original)).map(([n]) => n);
  // ⚠️ A COMPUTER RECITING ITS OWN PARTS IS ONE PRODUCT, NOT A BUNDLE. "Dell
  // Inspiron 3910 D32M Core i5-12400 2.50GHz 12GB RAM 256GB SSD 1TB HDD" names
  // three component categories and is a single desktop; the first version of
  // this rule offered to call it a bundle. So a component only counts as a
  // separate product when there is no HOST device in the title to belong to.
  //
  // That is what leaves the real ones standing: "GeForce RTX 4060 Ti 1TB SSD
  // MSI" has no host, so the GPU and the SSD really are two things, and "Core
  // i9-13900k and 2x16GB DDR5 FlareX" is a CPU and RAM sold together.
  const COMPONENTS = ["storage", "processor", "memory", "graphics card"];
  const HOSTS = ["laptop", "console", "phone", "tablet", "camera body", "printer", "monitor"];
  // The SPEC TABLE decides this wherever it can, for the same reason
  // missing-noun defers to it: a keyword list will never know every device that
  // recites its own RAM. The first version missed a Lenovo Legion Go, a
  // Minisforum mini PC, a Yoga laptop and a Valve Steam Deck — four single
  // devices it offered to call bundles. Shopify already files all four under a
  // computing Collection.
  // ⚠️ `s?` IS LOAD-BEARING. Shopify's collections are plural — a gaming laptop's
  // is literally "Windows Laptops" — so `\blaptop\b` matched none of them and
  // every RTX gaming laptop in the estate came back as a bundle.
  const hostSpec = `${collection} ${specType}`;
  const hasHost = cats.some(c => HOSTS.includes(c))
    || /\b(laptop|notebook|computer|desktop|handheld|console|tablet|phone|monitor|camera|printer|pc)s?\b/i.test(hostSpec)
    || /\b(desktop|inspiron|optiplex|thinkpad|thinkcentre|pavilion|elitedesk|prodesk|imac|mac\s*mini|mac\s*pro|all-?in-?one|tower|workstation|custom\s+pc|gaming\s+pc|mini\s*pc|steam\s*deck|legion\s+go|rog\s+ally|yoga\s+\d|\bpc\b)\b/i.test(original);
  // ⚠️ A HOST DEVICE MEANS THIS IS ONE PRODUCT, FULL STOP — not merely that its
  // components do not count. The intermediate version only dropped components
  // and still called a "Graphics/Drawing Tablet" a bundle (tablet + display) and
  // a "Laptop Screen Extender" a bundle (laptop + monitor): several device nouns
  // describing ONE device. All eight bundle findings in the first five-store
  // sweep were false, and seven of the eight were filed by Shopify under a
  // device collection that said so ("Custom Gaming PC", "Graphics/Drawing
  // Tablet").
  //
  // So the rule now fires ONLY where there is no host at all, which is exactly
  // the shape of the real ones: "GeForce RTX 4060 Ti 1TB SSD MSI" (a graphics
  // card and a drive, filed under neither) and "Core i9-13900k and 2x16GB DDR5
  // FlareX" (a processor and memory). A genuine two-DEVICE bundle would be
  // missed; that is the right trade at this precision, and the reviewer can
  // still add the word by hand.
  if (hasHost) cats = cats.slice(0, 1);
  // A camera body and a lens together is simply how a camera is sold.
  const oneProduct = (a: string[]) =>
    a.length === 2 && a.includes("camera body") && a.includes("lens");
  if (!brokenTitle && cats.length >= 2 && !oneProduct(cats) && !BUNDLE_WORDS.test(title)) {
    const room = tryAppend("Bundle");
    findings.push({
      code: "undeclared-bundle",
      says: `The title names ${cats.length} separate things (${cats.join(" + ")}) but never says it is a bundle. "Bundle" is a word buyers search for, and it sets the expectation that justifies the price of two items in one listing.`
        + (room ? "" : ` There is no room for the word without cutting something — shorten the title first.`),
      severity: 1, fixable: room,
    });
  }

  // ⚠️⚠️ RETIRED 2026-08-28, AND NOT BECAUSE IT WAS INACCURATE.
  // Ethan, after seeing the retro-only version: "I think we ditch the CIB. Too
  // many variables there." He is right, and the variables are worth writing down
  // because they are what a future version has to beat:
  //
  //   1. THE TERM IS PLATFORM-DEPENDENT. Solved — see the retro/modern split
  //      below, which cut 106 of 368 rows. But solving it proved the check needs
  //      a judgement call the DATA cannot make, which is the real problem.
  //   2. `Inserts` IS ONE CHECKBOX standing in for the dust sleeve, poster,
  //      registration card and tray. A collector's definition of CIB is stricter
  //      than three ticks can express, and nothing anywhere writes down what the
  //      tick is supposed to mean — so the claim is only as good as five stores'
  //      unwritten intake habits. BAL alone produced 88 of the 257 rows off 574
  //      products, roughly double everyone else's rate: either a more retro
  //      catalogue or one person's ticking, and we cannot tell which.
  //   3. GETTING IT WRONG COSTS MORE THAN GETTING IT RIGHT EARNS. An
  //      over-claimed CIB is an INAD return eBay decides against us; a missing
  //      CIB is only a listing that sells slower.
  //   4. IT WAS 257 OF THE 334 QUEUED ROWS — 77% of the workload for the one
  //      finding a reviewer could not settle from the screen, against Ethan's
  //      whole constraint: "I don't want to add a ton of daily work to the
  //      managers' plates … but I do want to catch all the bad titles."
  //
  // THE FIX BELONGS UPSTREAM, not in a review queue: PayMore's listing software
  // already has the three fields, so it can append CIB itself at the moment of
  // listing, where the person is holding the game. Same shape as the retired
  // redundant-phrase rule (see REDUNDANT_RETIRED) — a corp vocabulary change
  // reaching thousands of titles beats a manager approving them one at a time.
  //
  // Everything below is KEPT AND CORRECT, gated off by one constant, so the day
  // that conversation happens this is a one-word change rather than a rebuild.
  // The `warn` field it introduced stays in the Finding type and the panel: it is
  // the right home for any future finding that asserts something about the
  // physical item rather than about the words. NOTHING PRODUCES ONE TODAY.
  const CIB_ENABLED = false;

  // COMPLETE IN BOX, for games. `Case/Box`, `Manual` and `Inserts` all Yes is
  // what CIB means, so the keyword is earned by the data rather than added as a
  // garnish — and "CIB" is one of the highest-intent searches there is for a
  // used game. The accessory metafield finally pays for itself here.
  //
  // ⚠️ RETRO ONLY, and never silently. Ethan, 2026-08-28: "even if it has manual,
  // case/box, and inserts, in the gaming community would that always mean CIB?"
  // No — the term does not carry the same meaning on every platform:
  //
  //   • Retro (carts, PS1/PS2, Sega, GameCube, PC big box, TG16, handhelds):
  //     the box is scarce, CIB is the searched term and it carries a premium.
  //     150 of our rows. A loose cart fails Case/Box and is never stamped, which
  //     is why NES/SNES/N64 produced ZERO rows — we hold those loose.
  //   • Modern (PS4/PS5, Xbox One/Series, Switch): the case shipped with every
  //     copy so "complete in box" claims almost nothing, and MOST OF THOSE GAMES
  //     NEVER HAD A PRINTED MANUAL. A Manual:Yes there is a DLC code slip, an ad
  //     insert or a mis-tick — a claim in the title with nothing behind it, and
  //     an INAD return eBay decides against us. 106 rows, all cut.
  //
  // The platform is read from the trailing parenthetical the listing software
  // writes — "(Sony PlayStation 4, 2016)" — because a bare word match is unsafe:
  // "Switch" is a plausible substring of a game NAME, and 4 of 368 titles carry
  // the parenthetical with no year at all, so the year is not required.
  const MODERN_CONSOLE =
    /\b(playstation\s?[45]\b|ps\s?[45]\b|xbox\s+one|xbox\s+series|nintendo\s+switch|\bswitch\b)/i;
  const platformSaid = (t: string) => {
    const parens = [...t.matchAll(/\(([^)]*)\)/g)].map(m => m[1]);
    return parens.length ? parens[parens.length - 1] : t;
  };
  if (CIB_ENABLED && !brokenTitle && isGame && !/\b(cib|complete\s+in\s+box)\b/i.test(title)
      && !MODERN_CONSOLE.test(platformSaid(original))) {
    const yes = (k: string) => /^y(es)?$/i.test((extra?.specs?.[k] || "").trim());
    if (yes("Case/Box") && yes("Manual") && yes("Inserts")) {
      // Both spellings when they fit — buyers search "CIB" and "Complete In Box"
      // in roughly equal measure — and just the acronym when they do not.
      const room = tryAppend("CIB Complete In Box") || tryAppend("CIB");
      findings.push({
        code: "game-complete",
        says: `Shopify says this game has its case, manual and inserts — that is Complete In Box, and "CIB" is one of the highest-intent things a game buyer searches. The title does not say it.`
          + (room ? "" : ` There is no room for it without cutting something.`),
        // ⚠️ THE ONLY EDIT IN THIS FILE THAT MAKES A CLAIM ABOUT THE PHYSICAL
        // ITEM rather than about the words. Everything else is checkable from
        // the screen; this one is three ticks somebody made at intake standing
        // in for a collector's definition — and "Inserts: Yes" is a SINGLE box
        // covering the dust sleeve, poster, registration card and tray. If the
        // ticks are optimistic the buyer opens an INAD case and eBay finds for
        // them. So the reviewer confirms against the item, not against us.
        warn: "Confirm this one is actually CIB before approving — check the case, manual and all inserts are really with the game. These three ticks were made at intake, and \"Inserts\" is one box covering the sleeve, poster and card. If it is not complete, Deny.",
        severity: 1, fixable: room,
      });
    }
  }

  // --- the market half: words the comps agree on ---------------------------

  const compRows = (comps || []).slice(0, 25).map((c: any) => ({
    title: String(c?.title || ""),
    price: c?.price?.value ? String(c.price.value) : null,
    itemId: c?.itemId ? String(c.itemId) : null,
  })).filter(c => c.title);

  let basis = "rules";
  let confidence: string = findings.length ? "high" : "low";

  if (compRows.length >= 6) {
    basis = "category";
    // A word only counts if MOST of the market uses it. Below that it is one
    // seller's habit, and importing it is how a title starts sounding like
    // somebody else's listing.
    const mine = new Set(tokens(title));
    const freq = new Map<string, number>();
    for (const c of compRows) {
      for (const t of new Set(tokens(c.title))) {
        if (t.length < 3 || COMP_STOPWORDS.has(t) || mine.has(t)) continue;
        freq.set(t, (freq.get(t) || 0) + 1);
      }
    }
    // ⚠️ RETIRED, 2026-08-28. Superseded by lazy-title, which reads the
    // listing's OWN spec table: a value we already recorded beats a word other
    // sellers happen to share, it needs no eBay call, and it cannot import
    // somebody else's phrasing. The tally is kept because the comps themselves
    // are still shown on the row as evidence, and because a future check may want
    // it — but it no longer produces a finding, so `agreed` stays empty.
    const agreed: string[] = [];
    void freq;

    // ⚠️ SUPERSEDED AS THE PRIMARY "this title is thin" CHECK by lazy-title
    // below, which reads the listing's own spec table instead of other sellers'
    // wording. Kept because a word MOST of the category uses and we do not is
    // still worth offering — but it now only runs on a title that is already
    // strong, so it adds polish and never competes with a concrete missing spec.
    const room = EBAY_TITLE_MAX - title.length;
    if (agreed.length && room >= 12) {
      const add: string[] = [];
      let used = 0;
      for (const w of agreed) {
        if (used + w.length + 1 > room - 2) continue;
        add.push(titleWord(w)); used += w.length + 1;
      }
      if (add.length) {
        findings.push({
          code: "short-title",
          says: `The title uses ${original.length} of eBay's 80 characters. ${add.length === 1 ? "This word appears" : "These words appear"} in most live listings for the same kind of item and ${add.length === 1 ? "is" : "are"} missing here: ${add.join(", ")}.`,
          severity: 1, fixable: true,
        });
        title = `${title} ${add.join(" ")}`; fixable = true;
        confidence = "medium";
      }
    }
  } else if (comps === null) {
    // Said out loud rather than silently degrading to rules-only. A reader
    // seeing no market words should know whether the market was asked.
    basis = "rules";
  }

  // ======================= THE LAZY TITLE =================================
  // The check Ethan actually asked for: the listing already knows something
  // searchable and the title does not say it. The fix is never invented — it is
  // the value out of the spec table — so this is both the highest-precision and
  // the most actionable finding in the file.
  //
  // Thresholds are measured, not chosen (see TITLE_SPECS): under 60% strength
  // with two or more missing values that FIT and 12+ characters spare gives 6
  // findings across 831 OVL products, all six real. 734 of those products are at
  // 100% and are never touched, which is the "90%+ means leave it alone" rule
  // expressed as data rather than a character count.
  // ⚠️ NEVER APPEND WHEN THE LISTING CONTRADICTS ITSELF. "ANTEC 520W HIGH
  // CURRENT GAMER POWER SUPPLY" plus its spec Brand gave
  // "…POWER SUPPLY PowerSpec PS 650BSM" — a title carrying TWO brands and two
  // wattages, worse than the one it replaced. Where a spec-conflict has fired the
  // row already says the listing disagrees with itself, and the fix is to correct
  // one side by hand, not to bolt the other side on the end.
  // Which fields lazy-title has already spent, so the category check below
  // cannot propose the same value twice under a different sentence.
  const lazyUsed = new Set<string>();
  // ⚠️ NEVER APPEND A SPEC VALUE ONTO A NAME WE ARE MID-WAY THROUGH CORRECTING.
  // OVL's "Philips Shockbox … Speaker" got both rules at once and came out as
  // "Philips ShoqBox Wireless Portable Bluetooth Speaker Shockbox 7200 Black" —
  // the name fix corrected the spelling at the front while lazy-title appended
  // the Model field, which still carries the OLD spelling. One title, both
  // spellings, and it reads like nonsense.
  //
  // This is the same rule the convention check already obeys ("never stack a
  // convention on top of a repair"); lazy-title was the one append site without
  // it. The spec table is not a second opinion on a name the listing itself got
  // wrong — fix the name, let the next sweep add the detail.
  const conflicted = brokenTitle || findings.some(f => NAME_CODES.has(f.code));
  const strength = strengthOf(original, extra?.specs);
  if (!conflicted && strength && strength.pct < 60) {
    const room = EBAY_TITLE_MAX - title.length;
    const fits = strength.missing.filter(m => m.v.length + 1 <= room);
    if (fits.length >= 2 && room >= 12) {
      const added: string[] = [];
      for (const m of fits) if (tryAppend(m.v)) { added.push(`${m.k} ${m.v}`); lazyUsed.add(m.k); }
      if (added.length) {
        findings.push({
          code: "lazy-title",
          says: `The title uses only ${strength.present} of the ${strength.total} searchable details this listing already records, and there are ${room} characters spare. Missing: ${added.join(", ")}. These are the words a buyer filters on, taken from the listing's own spec table — not invented.`,
          severity: 1, fixable: true,
        });
      }
    }
  }

  // ==================== THE SCREEN SIZE, ON ITS OWN =========================
  // The one field allowed to fire without the ratio. See SCREEN_SHELVES for the
  // measurement that earned it and for why monitors and laptops are in the gate
  // even though they are already clean.
  //
  // ⚠️ NOT ON A TITLE THAT IS ALREADY WRONG. Same house rule the convention
  // check obeys: a row with something WRONG with it gets that fixed and nothing
  // else, or the reviewer is reading a diff that repairs and polishes at once.
  // Polish can wait for the next sweep, when the title is sound.
  const shelf = `${collection} ${extra?.specs?.["Sub-Collection"] || ""}`.trim();
  const screenSpec = String(extra?.specs?.["Screen Size"] || "").trim();
  if (!brokenTitle && !findings.some(f => f.severity >= 2) && !lazyUsed.has("Screen Size")
      && screenSpec && !PLACEHOLDER.test(screenSpec)
      && SCREEN_SHELVES.test(shelf) && !SCREEN_NOT.test(shelf)
      && !screenSizePresent(title, screenSpec)) {
    const text = screenSizeText(screenSpec);
    // After the model, which is where every title in the estate that already
    // carries one puts it. See tryPlace.
    if (text && tryPlace(text, String(extra?.specs?.["Model"] || "").trim())) {
      findings.push({
        code: "missing-screen-size",
        says: `This listing records a ${text} screen and the title does not say so. Screen size is one of the first things a buyer filters a phone or tablet by, so a title without it is missing from those results entirely. The measurement is the listing's own — only the inch mark is ours.`,
        severity: 1, fixable: true,
      });
    }
  }

  // ============ THE DETAIL THIS KIND OF THING NORMALLY CARRIES =============
  // See learnConvention for why the corpus is our own storefront and not eBay.
  // This is the "comparable by type" check: not "copy these words" but "titles
  // for this kind of item name the GPU, and this one does not."
  //
  // ⚠️ AT MOST TWO, MOST-CONVENTIONAL FIRST. A title carrying five appended
  // fields is not a better title, and the reviewer stops reading a diff that
  // long. Whatever the category names most consistently gets the room.
  // ⚠️ NEVER STACK A CONVENTION ON TOP OF A REPAIR. WSP's "Canon EOS R100
  // 24.1MP Digital SLR DSLR Camera" had already been corrected to "Mirrorless
  // Camera" by the hardware-conflict rule; the convention check then appended
  // its Type field on the end and produced "…24.1MP Mirrorless Camera Digital
  // SLR DSLR Camera" — a suggestion worse than either fix alone. A row that
  // already has something WRONG with it gets that fixed and nothing else; the
  // polish can wait for the next sweep, when the title is sound.
  const beingRepaired = findings.some(f => f.severity >= 2);
  const convBucket = convention?.get(collection.trim().toLowerCase());
  if (CONV_ENABLED && !brokenTitle && !beingRepaired && convBucket
      && convBucket.n >= CONV_MIN_PRODUCTS && extra?.specs) {
    const gaps: { k: string; v: string; share: number }[] = [];
    for (const [k, c] of convBucket.keys) {
      if (c.has < CONV_MIN_PRODUCTS) continue;
      const share = c.inTitle / c.has;
      if (share < CONV_MIN_SHARE) continue;
      if (lazyUsed.has(k)) continue;
      if (CONV_NEVER.test(k.trim())) continue;
      const v = String(extra.specs[k] || "").trim();
      if (!titleWorthy(k, v, extra.specs)) continue;
      // Against the WORKING title, not the original — an earlier fix may have
      // added it already.
      if (valuePresent(title, v)) continue;
      // A value with no letters in it is a year or a bare measurement, and the
      // convention that produced it was about placement, not presence.
      if (!/[A-Za-z]/.test(v)) continue;
      if (convContradicts(title, v)) continue;
      if (!convWorthAdding(title, v)) continue;
      gaps.push({ k, v, share });
    }
    gaps.sort((a, b) => b.share - a.share);
    const added: string[] = [];
    for (const g of gaps.slice(0, 2)) {
      if (tryAppend(g.v)) {
        added.push(`${g.k} ${g.v} — ${Math.round(g.share * 100)}% of our ${collection} titles say it`);
      }
    }
    if (added.length) {
      findings.push({
        code: "missing-for-category",
        says: `Nearly every ${collection} listing we write names ${added.length === 1 ? "this detail" : "these details"} in the title, and this one does not: ${added.join("; ")}. The values come from this listing's own spec table — nothing is invented and no wording is copied from another seller.`,
        severity: 1, fixable: true,
      });
    }
  }

  // ⚠️ "THIS TITLE IS SHORT" WITH NOTHING TO ADD IS NOT A QUEUE ROW.
  // The first dry run put 16 of 44 rows on the queue saying only that, with no
  // suggestion — a fact the reviewer can read off the title themselves, padding
  // out a list whose whole value is that every row is worth acting on. So bare
  // headroom is only reported when the market half actually ran and still had
  // nothing to offer, which is a different and much rarer statement.
  //
  // The consequence, stated plainly: a rules-only sweep finds DEFECTS. Finding
  // the unused 28 characters an average title is carrying needs market=1.
  if (!findings.length && comps !== null && comps.length >= 6 && original.length <= 45
      && (!strength || strength.pct < 100)) {
    findings.push({
      code: "short-title",
      says: `The title uses only ${original.length} of eBay's 80 characters, and no word the live market agrees on is missing. There may still be room for the capacity, colour or condition buyers filter on.`,
      severity: 1, fixable: false,
    });
  }

  // THE LAST LINE OF DEFENCE AGAINST A LOSSY SUGGESTION. tryAppend keeps every
  // addition inside the cap, but a REPLACEMENT can still grow a title — "DSLR"
  // becoming "Mirrorless" adds six characters — so a title that was already near
  // 80 can end up over it. Truncating here would drop a real word to fit a fix,
  // so an over-length result withdraws the suggestion instead and leaves the
  // findings to be read. capTitle stays for the genuinely-too-long original,
  // where cutting is the only option there has ever been.
  const tidy = title.replace(/\s+/g, " ").trim();
  const suggested = fixable && tidy.length <= EBAY_TITLE_MAX && tidy !== original
    ? tidy : null;
  return {
    findings, suggested, basis,
    confidence: findings.some(f => f.severity === 3) ? "high" : confidence,
    comps: compRows.slice(0, 8),
  };
}

// --- the sweep --------------------------------------------------------------

// Oldest-looked-at first, so repeated cron runs walk the whole estate instead of
// re-examining the same head of the list forever. A product with no review row
// has never been looked at and sorts first.
// ⚠️ TWO CLOCKS, AND THE MARKET PASS MUST USE ITS OWN.
// `swept_at` is stamped by the twice-daily rules-only cron on every row, so it
// says nothing about when eBay was last asked — ordering the market pass by it
// made it re-examine the SAME 120 rows every run while ~680 products per store
// were never asked about at all. `market_at` (migration 0068b) is the market's
// own clock, nulls first, so "run it again to walk further" is actually true.
// ⚠️ THE NAME PASS HAS A THIRD CLOCK, AND IT IS NOT A TIMESTAMP. `asked_title`
// stores the exact title the model was shown, prefixed by ASK_RECIPE. A listing
// needs asking when that stamp does not match the title it has now — which
// makes the ordering self-managing: a new listing has no stamp and sorts first,
// an edited title stops matching and comes back round, and an untouched listing
// is never asked about twice however often the sweep runs. It is also why
// bumping ASK_RECIPE re-asks the whole estate on its own.
async function candidatesFor(store: string, limit: number, byMarket = false,
                             byNames = false): Promise<Row[]> {
  // Paged, and ORDERED — an unordered paged read can repeat or skip rows
  // between pages, because Postgres makes no promise about row order without it.
  const cat: any[] = await allRows(
    `ebay_catalog?store_code=eq.${store}&quantity=gt.0&online_published=is.true`
    + `&select=store_code,sku,product_id,title,price,quantity&order=sku`);
  const seen: any[] = await allRows(
    `listing_title_reviews?store_code=eq.${store}`
    + `&select=product_id,swept_at,market_at,asked_at,asked_title,status,current_title`
    + `&order=product_id`);
  const bySeen = new Map(seen.map(r => [r.product_id, r]));
  const scored = cat.map(c => {
    const s = bySeen.get(c.product_id);
    // A row whose title has CHANGED since we looked is new work again, whatever
    // it was decided last time — which is how a denial stops being permanent.
    const stale = s && s.current_title !== c.title;
    // The name pass asks a different question: not "how long since we looked"
    // but "has this exact title ever been shown to the model". Anything whose
    // stamp does not match is unasked, whenever it was last swept.
    const unasked = byNames && s?.asked_title !== askedStamp(c.title || "");
    const clock = byNames ? s?.asked_at : byMarket ? s?.market_at : s?.swept_at;
    // Never looked at, or looked at under a title that no longer exists: first.
    return { c, at: !s || stale || unasked || !clock ? 0 : Date.parse(clock) || 0,
             unasked: byNames ? !!unasked : true };
  });
  scored.sort((a, b) => a.at - b.at);
  // ⚠️ THE NAME PASS TAKES ONLY WHAT IT HAS NOT ASKED. Every other pass re-walks
  // the whole estate oldest-first, which is right for a free rules check and
  // wrong for a paid one: without this it would re-ask about the same 100
  // listings every morning and bill for an answer it already has.
  const pool = byNames ? scored.filter(s => s.unasked) : scored;
  // ⚠️ ONE PRODUCT CAN HOLD SEVERAL SKUs. ebay_catalog is keyed (store_code, sku)
  // and a multi-variant product contributes one row per variant, so without this
  // the upsert sends two rows with the same product_id and Postgres refuses the
  // whole batch: "ON CONFLICT DO UPDATE command cannot affect row a second
  // time". It killed WSP's save while the other four stores succeeded, which is
  // exactly how a bug like this hides.
  //
  // Deduping is also the CORRECT shape, not just a workaround: a title belongs
  // to the product, not the variant, so there is one decision to make however
  // many SKUs hang off it. The kept SKU is the first — it is what the row shows
  // somebody so they can find the unit, and any variant leads to the same
  // product page.
  const byProduct = new Map<string, typeof scored[number]>();
  for (const s of pool) if (!byProduct.has(s.c.product_id)) byProduct.set(s.c.product_id, s);
  return [...byProduct.values()].slice(0, limit).map(s => ({
    store_code: s.c.store_code, product_id: s.c.product_id, sku: s.c.sku,
    title: s.c.title || "", product_handle: null,
    price: s.c.price == null ? null : Number(s.c.price),
    quantity: s.c.quantity || 0,
  }));
}

async function sweep(store: string, limit: number, wantMarket: boolean, save: boolean,
                     wantNames = false, wantLlm = false) {
  const cands = await candidatesFor(store, limit, wantMarket, wantLlm);
  if (!cands.length) return { store, examined: 0, queued: 0, rows: [] as any[] };
  // ONE stamp for the whole run. Stamping per row made the findings batch land a
  // few milliseconds before the clean batch, so the next run's "least recently
  // swept" ordering put the queue back at the head of the list every time.
  const stampedAt = new Date().toISOString();

  // What eBay is showing right now, for the drift finding. One read, not one per
  // item; ebay_live is keyed (store_code, sku) exactly as ebay_catalog is.
  const live: any[] = await rows(
    `ebay_live?store_code=eq.${store}&select=sku,title,item_id,seen_at`);
  const liveBy = new Map(live.map(r => [r.sku, r]));
  // Every title this tool has applied in this store, newest first, so the drift
  // finding can recognise its own handiwork. One read for the store, not one
  // per row.
  const moveRows: any[] = await allRows(
    `listing_title_moves?store_code=eq.${store}`
    + `&select=product_id,after_title,applied_at&order=applied_at.desc`);
  const moveBy = new Map<string, any>();
  for (const m of moveRows) if (!moveBy.has(m.product_id)) moveBy.set(m.product_id, m);
  // What the LAST sweep concluded, so a rules-only run can carry the market's
  // half forward instead of stamping over it. Keyed by product_id, and only
  // trusted while current_title still matches.
  const priorRows: any[] = await allRows(
    `listing_title_reviews?store_code=eq.${store}`
    + `&select=product_id,current_title,suggested_title,findings,basis,confidence,comps`
    + `,asked_title,asked_at,status,ebay_title,decided_at`
    + `&order=product_id`);
  const prior = new Map(priorRows.map(r => [r.product_id, r]));

  // ⚠️ EVERY OBJECT IN A POSTGREST BULK UPSERT MUST CARRY THE SAME KEYS — a
  // mixed batch is refused outright with "All object keys must match", which
  // would kill the whole save, not the one row. So on a name pass every row gets
  // both columns: the new stamp if the model answered for it, and otherwise the
  // stamp it already had, so a failed batch neither wipes an old answer nor
  // claims a new one. On any other pass the keys are absent entirely, which
  // leaves the stored values alone.
  const askedCols = (productId: string, title: string) => {
    if (!wantLlm) return {};
    if (nameBy[productId]) return { asked_title: askedStamp(title), asked_at: stampedAt };
    const p = prior.get(productId);
    return { asked_title: p?.asked_title ?? null, asked_at: p?.asked_at ?? null };
  };

  // ⚠️ A DENIAL HAS TO SURVIVE THE NEXT SWEEP, OR IT IS NOT A DECISION.
  // The rules cron re-walks the whole estate twice a day and the upsert wrote
  // status:"open" unconditionally, so every Deny came back within hours — a
  // reviewer's afternoon undone by a cron. candidatesFor already documents the
  // rule this restores: "a row whose title has CHANGED since we looked is new
  // work again, whatever it was decided last time".
  //
  // What makes it new work again, precisely:
  //   * the Shopify title changed — it is a different title, never decided
  //   * for a drift finding, the EBAY title changed — the disagreement the
  //     reviewer looked at is not the disagreement we have now
  //   * a finding code appeared that was not on the row when it was denied —
  //     they dismissed what they were shown, not everything we might ever find
  // Anything else keeps the decision, and decided_by/at/note are untouched
  // because the upsert does not carry those columns.
  const deniedStill = (productId: string, title: string, ebayTitle: string | null,
                       codes: string[]): boolean => {
    const p = prior.get(productId);
    if (!p || p.status !== "denied") return false;
    if (p.current_title !== title) return false;
    const priorCodes = new Set((p.findings || []).map((f: any) => String(f?.code || "")));
    // Note the test is on the drift we have NOW, not the drift it had then: a
    // listing whose eBay copy has since CAUGHT UP has lost its drift finding,
    // and nothing new has happened for a reviewer to look at.
    if ((codes.includes("title-drift") || codes.includes("ebay-not-synced"))
        && String(p.ebay_title ?? "") !== String(ebayTitle ?? "")) {
      return false;
    }
    return codes.every(c => priorCodes.has(c));
  };

  // Our OWN live eBay item ids, for the model check's corpus exclusion. Every
  // active listing on the shared account is in here whoever put it there, which
  // is exactly what is needed — an MC copy of our product is no more evidence
  // that a model exists than our own listing is.
  const ownIds = new Set<string>(live.map(r => String(r.item_id || "")).filter(Boolean));

  // The stored category per listing, which is what keeps comp sampling inside
  // the right leaf. Absent for anything never uploaded through SPEEKS Connect,
  // and in that case the market half is skipped rather than sampled blind.
  const listed: any[] = await rows(
    `ebay_listings?store_code=eq.${store}&select=sku,category_id,category_name`);
  const catBy = new Map(listed.map(r => [r.sku, r]));

  let extras: Record<string, Extra> = {};
  let extrasNote: string | null = null;
  try {
    const { shop, token } = await shopFor(store);
    extras = await extrasFor(shop, token, cands.map(c => c.product_id));
  } catch (e) {
    // Bundle detection is a nice-to-have; a Shopify hiccup must not stop the
    // correctness findings, which need nothing but the title.
    extrasNote = `Shopify extras unavailable: ${String(e).slice(0, 160)}`;
  }

  // ===================== THE NAME PASS ====================================
  // Runs BEFORE the per-row loop so the whole page goes out in a few parallel
  // requests instead of one round trip per listing — 100 listings in roughly one
  // round trip's latency, which is what keeps this inside the 150s wall.
  const nameBy: Record<string, NameVerdict> = {};
  const nameUnverified: { sku: string; title: string; claimed: string; correction: string }[] = [];
  let nameNote: string | null = null;
  let nameUsage = { input: 0, output: 0, asked: 0, batches: 0 };
  if (wantLlm) {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      // Plain English, and it names who fixes it — the house rule for anything
      // alert-shaped. A missing key must never read as "no bad names found".
      nameNote = "ANTHROPIC_API_KEY is not set on this project, so no titles were "
        + "checked for mangled product names. Nothing is wrong with the listings; "
        + "the check did not run. Claude fixes this by setting the key.";
    } else {
      const client = new Anthropic({ apiKey });
      const items = cands.map(c => ({
        id: c.product_id,
        title: c.title,
        brand: String(extras[c.product_id]?.specs?.["Brand"] || "").trim(),
        model: String(extras[c.product_id]?.specs?.["Model"] || "").trim(),
        shelf: [extras[c.product_id]?.specs?.["Collection"],
                extras[c.product_id]?.specs?.["Sub-Collection"]]
          .filter(Boolean).join(" / "),
      }));
      const batches: typeof items[] = [];
      for (let i = 0; i < items.length; i += NAME_BATCH) batches.push(items.slice(i, i + NAME_BATCH));
      const failed: string[] = [];
      for (let i = 0; i < batches.length; i += NAME_CONCURRENCY) {
        const wave = batches.slice(i, i + NAME_CONCURRENCY);
        const settled = await Promise.allSettled(
          wave.map(b => checkNamesBatch(client, b).then(r => ({ r, n: b.length }))));
        for (const s of settled) {
          if (s.status === "fulfilled") {
            Object.assign(nameBy, s.value.r.verdicts);
            nameUsage.asked += s.value.n;
            nameUsage.batches += 1;
            nameUsage.input += s.value.r.input;
            nameUsage.output += s.value.r.output;
          } else {
            // ⚠️ A FAILED BATCH IS NOT A CLEAN BATCH. Its listings keep no stamp,
            // so the next run picks them up again rather than recording silence
            // as an all-clear.
            failed.push(String(s.reason).slice(0, 120));
          }
        }
      }
      if (failed.length) {
        nameNote = `${failed.length} of ${batches.length} name-check batches failed and `
          + `those listings were left unasked, so the next run will pick them up. `
          + `First error: ${failed[0]}`;
      }
    }
  }

  // Which model tokens the market has heard of. Cached across the whole sweep —
  // the same brand and model recur, and this is the expensive call.
  const modelSeen: Record<string, { real: boolean | null; example: string | null }> = {};
  const brandSeen: Record<string, boolean> = {};
  let browse: Browse = async () => null;
  let marketNote: string | null = null;
  if (wantMarket) {
    browse = await browseFor(store);
    const control = await browse("laptop", undefined, 1);
    if (control === null) {
      marketNote = "eBay Browse did not answer, so nothing here used market data.";
      browse = async () => null;
    }
  }

  // ⚠️ LEARNED FROM THE WHOLE RUN, BEFORE ANY ROW IS JUDGED. The convention is
  // a fact about a COLLECTION, so it needs every product in it — which is why
  // the default sweep limit covers a whole store. A small `limit` gives a
  // convention learned from a slice, and the thresholds (8 products, 8 with the
  // field) are what stop that slice inventing a house style from three items.
  const convention = learnConvention(cands, extras);

  const out: any[] = [];
  // Pairs where the eBay listing mapped to this SKU is a DIFFERENT PRODUCT. Not
  // queued (they are not titles to rewrite) but counted, because silently
  // dropping them would hide a real mapping problem.
  const mismatched: { sku: string; shopify: string; ebay: string }[] = [];
  for (const row of cands) {
    row.wantNames = wantNames;
    const lv = liveBy.get(row.sku);
    row.ebay_title = lv?.title || null;
    row.ebay_seen_at = lv?.seen_at || null;
    row.ourMove = moveBy.get(row.product_id) || null;
    const c = catBy.get(row.sku);
    row.category_id = c?.category_id || null;
    row.category_name = c?.category_name || null;

    let comps: any[] | null = null;
    let modelReal: boolean | null = null;
    let modelExample: string | null = null;
    let brandReal: boolean | null = null;
    if (wantMarket && !marketNote) {
      // One question per brand+model, cached across the sweep — the same model
      // recurs (two identical WONDERBOOMs at OVL) and this is the expensive call.
      // No point paying for up to four Browse calls per row to compute a verdict
      // nothing may report.
      const sm = wantNames ? specModel(extras[row.product_id]?.specs) : null;
      if (sm) {
        // One question per BRAND across the whole sweep — brands repeat far more
        // than models do, so this is nearly free after the first few rows.
        const bkey = sm.brand.toLowerCase();
        if (bkey in brandSeen) {
          brandReal = brandSeen[bkey];
        } else {
          brandReal = await brandIsReal(sm.brand, browse, ownIds, row.title);
          if (brandReal !== null) brandSeen[bkey] = brandReal;
        }
        const key = `${sm.brand}|${sm.model}`.toLowerCase();
        if (key in modelSeen) {
          modelReal = modelSeen[key].real;
          modelExample = modelSeen[key].example;
        } else {
          // Null is "could not tell" and must never be cached or read as "not
          // found" — modelIsReal broadens the query itself and abstains rather
          // than judging on a thin corpus.
          const v = await modelIsReal(sm.brand, sm.model, browse, ownIds, row.title);
          modelReal = v.real; modelExample = v.example;
          if (v.real !== null) modelSeen[key] = v;
        }
      }
      if (row.category_id) {
        const q = marketQuery(row.title);
        comps = await browse(q, row.category_id, 25);
      }
    }

    if (row.ebay_title) {
      const wa = norm(row.title).split(" ").filter(w => w.length > 1);
      const wb = new Set(norm(row.ebay_title).split(" ").filter(w => w.length > 1));
      const shared = wa.filter(w => wb.has(w)).length;
      const pct = wa.length && wb.size
        ? Math.round(100 * shared / Math.max(wa.length, wb.size)) : 100;
      if (pct < 65) mismatched.push({ sku: row.sku, shopify: row.title, ebay: row.ebay_title });
    }
    const nv = nameBy[row.product_id] || null;
    const a = analyse(row, extras[row.product_id], comps, modelReal, modelExample,
                      brandReal, convention, nv);
    // The model claimed an error it could not quote out of the title, so analyse
    // dropped it. Counted rather than hidden: this rate is how we find out the
    // check has started inventing, and it is the number to watch after any
    // change to NAME_SYSTEM.
    if (nv && nv.verdict !== "ok" && !a.findings.some(f => NAME_CODES.has(f.code))) {
      nameUnverified.push({ sku: row.sku, title: row.title,
                            claimed: String(nv.wrong_text || ""),
                            correction: String(nv.correct_text || "") });
    }

    // Carry the market's findings forward on a rules-only pass. Not merged when
    // the market DID run — then the fresh answer is the whole answer, including
    // a market finding that has stopped applying.
    if (!wantMarket || !wantLlm) {
      const p = prior.get(row.product_id);
      if (p && p.current_title === row.title) {
        const codes = new Set<string>([
          ...(wantMarket ? [] : [...MARKET_CODES]),
          // ⚠️ SAME TRAP, DIFFERENT CHECK. The twice-daily rules cron shares a
          // primary key with these rows, so without carrying them it would stamp
          // a paid-for verdict `clean` every morning — exactly what happened to
          // the market's findings until 2026-08-28. A rules pass is not evidence
          // a name is fine, only that nobody asked.
          ...(wantLlm ? [] : [...NAME_CODES]),
        ]);
        const keep = (p.findings || []).filter((f: any) => codes.has(f?.code));
        if (keep.length) {
          const have = new Set(a.findings.map(f => f.code));
          for (const f of keep) if (!have.has(f.code)) a.findings.push(f);
          // ⚠️ A NAME FIX LIVES INSIDE THE SUGGESTION, NOT BESIDE IT. Carrying
          // the finding forward without the suggestion that contains it leaves a
          // row saying "this name is wrong" next to a suggested title that does
          // not fix the name — and worse, a rules-only suggestion computed from
          // the WRONG name. The earlier pass had both halves, so its suggestion
          // is strictly better than anything the rules can produce alone.
          if (keep.some((f: any) => NAME_CODES.has(f?.code)) && p.suggested_title) {
            a.suggested = p.suggested_title;
            a.basis = p.basis || a.basis;
            a.confidence = p.confidence || a.confidence;
          }
          // The market's suggestion outranks a rules-only one only where the
          // rules had nothing to offer — a rules fix is a named edit to this
          // exact title and is never worth discarding for a keyword list.
          if (!a.suggested && p.suggested_title && p.basis === "category") {
            a.suggested = p.suggested_title;
            a.basis = p.basis;
            a.confidence = p.confidence || a.confidence;
            a.comps = p.comps || a.comps;
          } else if (a.basis === "rules" && p.basis === "category" && (p.comps || []).length) {
            // Keep the evidence on the row even when the suggestion is ours, so
            // the reviewer can still see what the market said.
            a.comps = p.comps;
          }
        }
      }
    }

    if (!a.findings.length) continue;
    out.push({
      store_code: store, product_id: row.product_id, sku: row.sku,
      product_handle: row.product_handle,
      current_title: row.title, suggested_title: a.suggested,
      findings: a.findings, basis: a.basis, confidence: a.confidence,
      comps: a.comps,
      category_id: row.category_id, category_name: row.category_name,
      price: row.price, quantity: row.quantity,
      // Only stored when it actually disagrees — the column IS the finding.
      ebay_title: a.findings.some(f => f.code === "title-drift" || f.code === "ebay-not-synced")
        ? row.ebay_title : null,
      severity: Math.max(...a.findings.map(f => f.severity)),
      status: deniedStill(row.product_id, row.title,
                          a.findings.some(f => f.code === "title-drift" || f.code === "ebay-not-synced")
                            ? row.ebay_title ?? null : null,
                          a.findings.map(f => f.code)) ? "denied" : "open",
      swept_at: stampedAt,
      // Only the market pass may move the market's clock. A rules-only run that
      // stamped it would make eBay look freshly asked when it was not.
      ...(wantMarket ? { market_at: stampedAt } : {}),
      ...askedCols(row.product_id, row.title),
    });
  }

  if (save) {
    // Stamp everything examined, not just what had a finding — otherwise a
    // clean product is re-examined on every single run and the sweep never
    // walks past the first `limit` items.
    const withFinding = new Set(out.map(o => o.product_id));
    const clean = cands.filter(c => !withFinding.has(c.product_id)).map(c => ({
      store_code: store, product_id: c.product_id, sku: c.sku,
      current_title: c.title, suggested_title: null, findings: [],
      basis: "rules", confidence: "high", comps: [],
      price: c.price, quantity: c.quantity,
      severity: 1, status: "clean", swept_at: stampedAt,
      ...(wantMarket ? { market_at: stampedAt } : {}),
      ...askedCols(c.product_id, c.title || ""),
    }));
    for (const batch of [out, clean]) {
      if (!batch.length) continue;
      await sb("listing_title_reviews", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(batch),
      });
    }
  }

  return {
    store, examined: cands.length, queued: out.length,
    ...(mismatched.length ? { differentItemOnEbay: mismatched } : {}),
    ...(extrasNote ? { extrasNote } : {}),
    ...(marketNote ? { marketNote } : {}),
    ...(nameNote ? { nameNote } : {}),
    ...(wantLlm ? { nameCheck: {
      asked: nameUsage.asked, batches: nameUsage.batches,
      inputTokens: nameUsage.input, outputTokens: nameUsage.output,
      // Claude Opus 5 list price, $5/M in and $25/M out. Rounded to cents so a
      // run that "felt expensive" can be checked instead of argued about.
      estCostUsd: Math.round(
        (nameUsage.input / 1e6 * 5 + nameUsage.output / 1e6 * 25) * 100) / 100,
      flagged: Object.values(nameBy).filter(v => v?.verdict !== "ok").length,
      // The rate to watch. A model that starts quoting text which is not in the
      // title is a model that has started inventing, and these are the rows that
      // were dropped for it.
      unverified: nameUnverified.length,
      ...(nameUnverified.length ? { unverifiedRows: nameUnverified.slice(0, 10) } : {}),
    } } : {}),
    saved: save,
    rows: out.map(o => ({
      sku: o.sku, current: o.current_title, suggested: o.suggested_title,
      severity: o.severity, basis: o.basis,
      findings: o.findings.map((f: Finding) => f.code),
    })),
  };
}

// Browse rewards a short query and returns nothing past about eight words.
// Condition words, carrier and lock status are noise here for the same reason
// ebay-sync strips them.
const MARKET_NOISE =
  /\b(new|used|open\s*box|sealed|refurb(ished)?|renewed|tested|working|works|for\s+parts|broken|flawless|good|fair|mint|excellent|unlocked|factory\s+unlocked|locked|verizon|at&t|t-?mobile|sprint|gsm|cdma|bundle|lot|kit|read|see\s+photos)\b/gi;

function marketQuery(title: string): string {
  const cleaned = title
    .replace(MARKET_NOISE, " ")
    // A precise model number returns nothing at all, which is the opposite of
    // what a market sample needs. The model gets its OWN query, above.
    .replace(/\b[A-Z0-9]{3,}[-/][A-Z0-9-/]{2,}\b/g, " ")
    .replace(/[^\w\s.&'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.split(" ").slice(0, 8).join(" ") || title.split(" ").slice(0, 6).join(" ");
}

// --- the panel --------------------------------------------------------------

async function queueFor(store: string) {
  const q: any[] = await rows(
    `listing_title_queue?store_code=eq.${store}`
    + `&select=product_id,sku,current_title,suggested_title,findings,basis,confidence,`
    + `comps,category_name,ebay_title,severity,price,quantity,swept_at`
    + `&order=severity.desc,price.desc.nullslast&limit=250`);
  return q.map(r => ({
    productId: r.product_id, sku: r.sku,
    current: r.current_title, suggested: r.suggested_title,
    findings: r.findings || [], basis: r.basis, confidence: r.confidence,
    comps: r.comps || [], category: r.category_name, ebayTitle: r.ebay_title,
    severity: r.severity, price: r.price, quantity: r.quantity,
    sweptAt: r.swept_at, shop: SHOP_BY_STORE[store],
  }));
}

// WHAT WAS DISMISSED, AND WHY — the half of Deny that never existed.
//
// The dialog told reviewers their reason "is how we find out a rule is wrong",
// and then wrote it to a column nothing read. A note nobody reads is worse than
// no note: it asks somebody to do work and quietly discards it.
//
// Two things come back. The rows, so a dismissal can be seen and taken back —
// a decision you cannot undo is one people hesitate over, and hesitation is how
// a review queue stops being worked. And a tally BY FINDING CODE, which is the
// actual feedback loop: one dismissal is a listing, four dismissals of the same
// code is a rule that needs looking at.
//
// ⚠️ ONLY 'not-a-problem' COUNTS TOWARDS THE TALLY. An 'ebay-stale' dismissal
// says the rule was RIGHT and the fix lives in Marketplace Connect, so folding
// those in would make title-drift look like our worst rule precisely when it
// was doing its job.
async function deniedFor(store: string) {
  const d: any[] = await rows(
    `listing_title_reviews?store_code=eq.${store}&status=eq.denied`
    + `&select=product_id,sku,current_title,ebay_title,findings,severity,`
    + `decided_by,decided_at,decided_as,decided_note,feedback_triaged_at`
    + `&order=decided_at.desc&limit=100`);
  const tally: Record<string, number> = {};
  for (const r of d) {
    if (r.decided_as === "ebay-stale") continue;
    for (const f of (r.findings || [])) {
      const c = String(f?.code || "");
      if (c) tally[c] = (tally[c] || 0) + 1;
    }
  }
  return {
    rows: d.map(r => ({
      productId: r.product_id, sku: r.sku,
      current: r.current_title, ebayTitle: r.ebay_title,
      findings: r.findings || [], severity: r.severity,
      by: r.decided_by, at: r.decided_at,
      as: r.decided_as, note: r.decided_note,
      // So the drawer's "N dismissals explained a rule was wrong" counts what is
      // still un-answered rather than everything ever written.
      triagedAt: r.feedback_triaged_at || null,
    })),
    // Sorted so the rule most often dismissed is the first thing read.
    tally: Object.entries(tally).sort((a, b) => b[1] - a[1])
      .map(([code, n]) => ({ code, n })),
  };
}

// --- rule feedback: the denials that carry a note ---------------------------
// A denial with a note is the ONLY evidence a rule is wrong, and until now it
// landed in a drawer that nobody reads on a schedule. This turns that pile into
// one thing to ask for: grouped by the RULE that fired, with the listing's own
// fields beside each note, and the mechanical half of the triage already done.
//
// ⚠️ GROUPED BY RULE, NOT BY ROW. One denial is an anecdote; three of the same
// code is a rule to go and fix. A per-row list hands over the same amount of
// text and none of the signal.
//
// ⚠️ 'ebay-stale' IS NOT FEEDBACK ABOUT A RULE. It says the rule was RIGHT and
// the stale copy is on eBay. deniedFor's tally already refuses to count those,
// and folding them in here would ask for a fix to the one thing working.
//
// ⚠️ THE MECHANICAL HALF ONLY. `saysItself` compares the words the suggestion
// CHANGED against the values the listing already records, which is a lookup and
// not a reading of the note. Nothing here interprets the reviewer's English:
// free text written fast at a counter is not a safe input to a rule change, and
// a tool that quietly rewrote its own rules from a misread sentence would get
// worse in a way nobody could see.

// The fields that identify an item, in the order a person would check them.
// Anything else is pulled in only when it holds the words under dispute.
const IDENTITY_SPECS = [
  "Brand", "Model", "MPN", "Platform", "Type", "Sub-Collection", "Collection",
  "Release Year", "Storage Capacity", "Screen Size", "Processor", "Color",
];

// ⚠️ MIRRORS _LT_CODE_SAYS IN speeks.js. Same words the panel shows a reviewer,
// so the ask names a rule the way the person denying it saw it named. A code
// missing from here still works: the heading falls back to the code itself.
//
// ⚠️ NOT THE FINDING'S OWN `says`. That is written per ROW — the name checks
// produce a paragraph about one product ("Black Ops II released on Xbox 360 in
// 2012…") — so using it as the heading named the whole rule after whichever row
// happened to be first. It belongs under the row, which is where it now goes.
const CODE_LABEL: Record<string, string> = {
  "name-wrong": "Name checked against outside knowledge",
  "name-garbled": "Name looks misspelled",
  "missing-screen-size": "Screen size missing from the title",
  "repeated-phrase": "A phrase repeated in the title",
  "title-drift": "Shopify and eBay disagree",
  "ebay-not-synced": "eBay has not picked up our fix",
  "missing-noun": "No noun saying what the thing is",
  "truncated-title": "Title cut off mid-word",
  "lazy-title": "Specs in the listing but not the title",
  "spec-conflict": "Title contradicts the spec table",
  "hardware-conflict": "Two impossible specs together",
  "brand-not-found": "Brand not found on eBay",
  "model-not-found": "Model not confirmed on eBay",
};

type FbRow = {
  store: string; sku: string | null; productId: string;
  current: string; suggested: string | null;
  note: string; by: string | null; at: string | null;
  codes: string[]; said: string[]; was: string; now: string; takenAt?: string | null;
  specs: Record<string, string>;
  saysItself: { field: string; value: string } | null;
};

// Does the listing itself already state the words the suggestion took out?
//
// ⚠️ NOT A WHOLE-RUN TEST. The changed run is whatever sits between the matching
// head and tail, and that is regularly TWO FACTS GLUED TOGETHER by punctuation:
// "Black Ops II (Xbox One, 2018)" against "(Xbox 360, 2012)" leaves a run of
// `One, 2018)`, which no single field can contain even though the listing states
// both halves (Platform = Microsoft Xbox One, Release Year = 2018). Testing the
// whole run found the Lenovo case, whose run happened to be one token, and
// silently missed the Xbox one. So every contiguous window of the run is tried,
// longest first, and the longest fragment any field states wins.
//
// ⚠️ WHOLE TOKENS, NOT SUBSTRINGS. A normalised `includes` makes "one" match
// "iPhone" and "pro" match "processor" — every short window would find a field
// somewhere and the hint would fire on coincidences. The comparison is a
// contiguous run of whole tokens inside the field's own tokens.
//
// ⚠️ A ONE-TOKEN WINDOW MUST BE 3+ CHARACTERS. "4K" or "II" alone is in half the
// catalogue and is never evidence that a rule overruled the listing.
function listingSaysItself(was: string, specs: Record<string, string>) {
  const w = tokens(was);
  if (!w.length) return null;
  const fields = Object.entries(specs)
    .map(([field, value]) => ({ field, value: String(value || ""), t: tokens(String(value || "")) }))
    .filter(f => f.t.length);
  if (!fields.length) return null;
  const holds = (hay: string[], needle: string[]) => {
    for (let i = 0; i + needle.length <= hay.length; i++) {
      let hit = true;
      for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { hit = false; break; }
      if (hit) return true;
    }
    return false;
  };
  for (let len = w.length; len >= 1; len--) {
    for (let i = 0; i + len <= w.length; i++) {
      const frag = w.slice(i, i + len);
      if (len === 1 && frag[0].length < 3) continue;
      for (const f of fields) {
        if (holds(f.t, frag)) return { field: f.field, value: f.value, matched: frag.join(" ") };
      }
    }
  }
  return null;
}

// How many notes nobody has carried into an ask yet. The deck's card is built
// on this and nothing else, so it must stay a single cheap count.
async function notedCount(stores: string[]) {
  let n = 0;
  for (const store of stores) {
    const d: any[] = await rows(
      `listing_title_reviews?store_code=eq.${store}&status=eq.denied`
      + `&decided_as=eq.not-a-problem&decided_note=not.is.null`
      + `&feedback_triaged_at=is.null&select=product_id&limit=200`);
    n += d.length;
  }
  return n;
}

async function feedbackFor(stores: string[], days: number) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const out: FbRow[] = [];
  // Notes already carried into an ask. They are NOT thrown away when they are
  // taken: a note that vanishes cannot be re-copied when a paste is lost, cannot
  // be matched to the answer that eventually comes back, and tells the person
  // who wrote it that explaining themselves led nowhere. Ethan asked whether
  // removing them was right (2026-09-04); this is the answer — they move, they
  // do not disappear.
  const done: FbRow[] = [];
  // The rule's own sentence, kept from the first finding that carries it, so the
  // ask names the rule the way the panel named it to the person who denied it.
  for (const store of stores) {
    const d: any[] = await rows(
      `listing_title_reviews?store_code=eq.${store}&status=eq.denied`
      + `&decided_as=eq.not-a-problem&decided_note=not.is.null`
      + `&decided_at=gte.${since}`
      + `&select=product_id,sku,current_title,suggested_title,findings,`
      + `decided_by,decided_at,decided_note,feedback_triaged_at`
      + `&order=decided_at.desc&limit=60`);
    if (!d.length) continue;
    // The listing's own fields, which is the whole point — the note says "it is
    // an Xbox One version" and the answer is sitting in the spec table.
    let extras: Record<string, Extra> = {};
    try {
      const { shop, token } = await shopFor(store);
      extras = await extrasFor(shop, token, d.map((r: any) => r.product_id));
    } catch (_e) { /* the notes are still worth reading without them */ }
    for (const r of d) {
      const specs = extras[r.product_id]?.specs || {};
      const run = titleRun(String(r.current_title || ""), String(r.suggested_title || ""));
      const keep: Record<string, string> = {};
      for (const k of IDENTITY_SPECS) if (specs[k]) keep[k] = specs[k];
      // Plus whatever field holds the words in dispute, wherever it lives.
      for (const [k, v] of Object.entries(specs)) {
        if (keep[k]) continue;
        const nv = norm(String(v || ""));
        if (!nv) continue;
        if ((run.was && nv.includes(norm(run.was)))
            || (run.now && nv.includes(norm(run.now)))) keep[k] = v;
      }
      // ⚠️ ONE QUERY, PARTITIONED HERE. Fetching the taken ones separately would
      // double the Shopify read this route already pays for per store.
      (r.feedback_triaged_at ? done : out).push({
        store, sku: r.sku, productId: r.product_id,
        takenAt: r.feedback_triaged_at || null,
        current: String(r.current_title || ""),
        suggested: r.suggested_title || null,
        note: String(r.decided_note || ""), by: r.decided_by, at: r.decided_at,
        codes: (r.findings || []).map((f: any) => String(f?.code || "")).filter(Boolean),
        // What the tool told the reviewer about THIS row, which is the half of
        // the disagreement the note is answering.
        said: (r.findings || []).map((f: any) => String(f?.says || "")).filter(Boolean),
        was: run.was, now: run.now,
        specs: keep,
        saysItself: listingSaysItself(run.was, specs),
      });
    }
  }
  // Group by the rule that fired. A row with two findings appears under both:
  // which of them the reviewer was answering cannot be known from here, and
  // dropping it from one would hide the evidence under the other.
  const groups: Record<string, FbRow[]> = {};
  for (const r of out) {
    for (const c of (r.codes.length ? r.codes : ["(no code)"])) {
      (groups[c] = groups[c] || []).push(r);
    }
  }
  return {
    days, stores,
    // What to stamp when the ask is taken. Exactly the rows that were shown —
    // stamping by a time window instead would swallow a note written while the
    // reviewer was reading.
    keys: out.map(r => ({ store: r.store, productId: r.productId })),
    total: out.length,
    settled: out.filter(r => r.saysItself).length,
    // Already taken, newest first, so the tool can show them without letting
    // them crowd out the ones still waiting.
    done: done.sort((a, b) => String(b.takenAt || "").localeCompare(String(a.takenAt || ""))).slice(0, 25),
    groups: Object.entries(groups)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([code, rws]) => ({ code, n: rws.length, rows: rws })),
  };
}

// The ask itself — plain text, built HERE rather than in the panel so the
// wording lives in one place and can be improved without a cache bust.
//
// ⚠️ IT HAS TO STAND ON ITS OWN. This gets pasted into a fresh session that has
// never seen this function, so it says what tool it is about, what is being
// asked, and what every line of evidence means. A prompt that assumes context
// is a prompt that gets a confident answer about the wrong thing.
function buildAsk(fb: Awaited<ReturnType<typeof feedbackFor>>): string {
  const L: string[] = [];
  const when = (t: string | null) => {
    const d = t ? new Date(t) : null;
    return d && !isNaN(d.getTime())
      ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  };
  L.push(`SPEEKS Listing Titles — rule feedback from the review queue`);
  L.push(`${fb.stores.join(", ")} · last ${fb.days} days · ${fb.total} denial${fb.total === 1 ? "" : "s"} with a note`);
  L.push(``);
  L.push(`A reviewer read each of these titles, decided our suggestion was wrong,`);
  L.push(`and wrote why. For each RULE below, read the notes against the listing's`);
  L.push(`own fields and tell me which it is:`);
  L.push(``);
  L.push(`  A. THE RULE IS WRONG — change it in supabase/functions/listing-titles/`);
  L.push(`     index.ts, add the case to the offline harness, and deploy.`);
  L.push(`  B. THE LISTING CONTRADICTS ITSELF — two of its own fields disagree, so`);
  L.push(`     no rule can settle it. Say which fields, and it goes on the list for`);
  L.push(`     a person (photo review, when that exists).`);
  L.push(`  C. THE REVIEWER WAS MISTAKEN — the rule was right. Say so plainly and`);
  L.push(`     say what would have made the suggestion easier to trust.`);
  L.push(``);
  L.push(`The "THE LISTING ITSELF ALREADY SAYS THIS" line is a mechanical check already`);
  L.push(`run for you: the words the suggestion took OUT, found as whole words in one`);
  L.push(`of the listing's own spec fields. Where it appears, the rule very likely`);
  L.push(`overruled the listing from outside knowledge — but it is a hint, not a verdict.`);
  L.push(``);
  L.push(`Nothing here has been changed. Do not approve or write any title.`);
  for (const g of fb.groups) {
    L.push(``);
    L.push(`${"=".repeat(72)}`);
    L.push(`RULE: ${g.code}${CODE_LABEL[g.code] ? ` — ${CODE_LABEL[g.code]}` : ""}`);
    L.push(`${g.n} denial${g.n === 1 ? "" : "s"}`);
    L.push(`${"=".repeat(72)}`);
    let i = 0;
    for (const r of g.rows) {
      i++;
      L.push(``);
      L.push(`${i}. ${r.store} · ${r.sku || "(no sku)"}${r.by ? ` · denied by ${r.by}` : ""}${r.at ? ` on ${when(r.at)}` : ""}`);
      L.push(`   NOTE:       "${r.note}"`);
      for (const said of (r.said || [])) L.push(`   WE SAID:    ${said}`);
      L.push(`   TITLE NOW:  ${r.current}`);
      if (r.suggested) L.push(`   SUGGESTED:  ${r.suggested}`);
      if (r.was || r.now) {
        L.push(`   CHANGED:    "${r.was || "(nothing)"}" -> "${r.now || "(removed)"}"`);
      }
      if (r.saysItself) {
        L.push(`   ⚠ THE LISTING ITSELF ALREADY SAYS THIS — ${r.saysItself.field} = ${r.saysItself.value}`);
      } else if (r.was) {
        L.push(`   (no field in the listing states "${r.was}" — nothing here settles it)`);
      }
      const keys = Object.keys(r.specs);
      if (keys.length) {
        L.push(`   THE LISTING'S OWN FIELDS:`);
        const pad = Math.min(Math.max(...keys.map(k => k.length)), 20);
        for (const k of keys) L.push(`     ${k.padEnd(pad)} = ${r.specs[k]}`);
      } else {
        L.push(`   THE LISTING'S OWN FIELDS: none readable (no spec table on this product)`);
      }
    }
  }
  L.push(``);
  L.push(`${"=".repeat(72)}`);
  L.push(`When you have decided, say which bucket each rule fell in before changing`);
  L.push(`anything, so the call can be argued with.`);
  return L.join("\n");
}

// ⚠️ THE QUEUE'S THIRD SCOPE RULE IS CONDITIONAL, AND THE PANEL HAS TO SAY SO.
// listing_title_queue (migration 0070) requires in stock + published + LIVE ON
// EBAY — but only while the store's `ebay_live` snapshot is fresh, because the
// five sweeps that fill it are paused and a hard filter on a decaying snapshot
// empties the queue instead of narrowing it. A filter that silently stopped
// filtering is a lie about coverage, so the panel reads this and prints which
// state it is in.
//
// ⚠️ 36 HOURS IS DUPLICATED IN MIGRATION 0070 AND MUST NOT DRIFT. If they
// disagree the panel describes a scope the view is not applying. Same class of
// two-places rule as the NET PROFIT close calendar.
const EBAY_LIVE_MAX_AGE_H = 36;

async function ebayScope(store: string) {
  const r: any[] = await rows(
    `ebay_live?store_code=eq.${store}&select=seen_at&order=seen_at.desc&limit=1`);
  const lastSeen = r[0]?.seen_at || null;
  const hours = lastSeen
    ? Math.floor((Date.now() - Date.parse(lastSeen)) / 3600000) : null;
  return {
    active: hours !== null && hours < EBAY_LIVE_MAX_AGE_H,
    lastSeen, hours, maxAgeHours: EBAY_LIVE_MAX_AGE_H,
  };
}

async function totals(stores: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const s of stores) {
    // Head-only count: the queue payload is up to 250 rows and this runs on a
    // timer on every dashboard load.
    const res = await sb(`listing_title_queue?store_code=eq.${s}&select=product_id`, {
      headers: { Prefer: "count=exact", Range: "0-0" },
    });
    const cr = res.headers.get("content-range") || "";
    out[s] = Number(cr.split("/")[1] || 0) || 0;
  }
  return out;
}

// Worst-first is the whole point of the number: a store with one wrong listing
// and forty short ones should not read the same as a store with forty short ones.
async function worstFor(stores: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const s of stores) {
    const r: any[] = await rows(
      `listing_title_queue?store_code=eq.${s}&select=severity&order=severity.desc&limit=1`);
    out[s] = r[0]?.severity || 0;
  }
  return out;
}

// --- the description's own copy of the title -------------------------------

// HTML SPELLS THE TITLE DIFFERENTLY THAN SHOPIFY DOES, and that quietly broke
// the description swap for a fifth of the queue. The title field holds the
// characters a person typed; descriptionHtml holds them ENTITY-ENCODED, so
// "Zoom Lens,Auto & Manual Lens" is stored as "Zoom Lens,Auto &amp; Manual
// Lens". A literal includes() of the title therefore found nothing, wrote
// nothing, and reported nothing — the title changed and the heading two
// paragraphs below it did not. Caught on OVL KS01-7548N-E6, where the title
// was fixed to f/4-5.6 and the <h1> and the included-items list both kept
// saying f/1.4-5.6.
//
// Rather than guess which entities a title might contain (&amp; today, &quot;
// the moment a screen size like 10.5" is added, &#39; on any possessive), we
// decode the document ONCE, keeping a map from each decoded character back to
// the span of source it came from. A match in the decoded text can then be
// spliced out of the ORIGINAL html by offset. One mechanism, every entity
// form, and the markup around the match is never touched.
const HTML_ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g;
const NAMED_ENTITY: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: "\u00a0",
};

function decodeWithMap(html: string): { text: string; from: number[]; to: number[] } {
  const text: string[] = []; const from: number[] = []; const to: number[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === '&') {
      HTML_ENTITY.lastIndex = i;
      const m = HTML_ENTITY.exec(html);
      if (m && m.index === i) {
        const body = m[1];
        let ch: string | null = null;
        if (body[0] === '#') {
          const code = body[1] === 'x' || body[1] === 'X'
            ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
          // Only the Basic Multilingual Plane, and never a lone surrogate: a
          // half character in the decoded stream would misalign every offset
          // after it, and offsets are the whole point of this map.
          if (Number.isFinite(code) && code > 0 && code <= 0xffff
              && !(code >= 0xd800 && code <= 0xdfff)) ch = String.fromCharCode(code);
        } else {
          ch = NAMED_ENTITY[body] ?? NAMED_ENTITY[body.toLowerCase()] ?? null;
        }
        if (ch !== null) {
          text.push(ch); from.push(i); to.push(i + m[0].length);
          i += m[0].length;
          continue;
        }
      }
    }
    text.push(html[i]); from.push(i); to.push(i + 1);
    i++;
  }
  return { text: text.join(''), from, to };
}

// What goes BACK in is escaped, because it is being written into markup. The
// new title arrives as plain text off a form field; dropping a bare & into a
// document is how the next reader of this html inherits the same bug.
//
// ⚠️ THE QUOTES ARE ESCAPED TOO, and that is not fussiness. A match can land
// inside an ATTRIBUTE — an alt= or title= on the listing image — and a raw "
// written there ends the attribute early and spills the rest of the title into
// the markup as junk attributes. Thirteen of the titles waiting in the queue
// right now carry an inch mark, so this is the common case, not the exotic one.
// Inside a text node &quot; renders exactly as a quote does, so escaping costs
// nothing and closes the only way this function could damage a page.
function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Every occurrence, not the first: the listing template writes the title twice
// (the <h1> and the first line of "Items included in this sale"), and a fix
// that repaired one of them would be harder to notice than one that repaired
// neither. Spliced back to front so the earlier offsets stay valid.
function swapTitleInHtml(html: string, oldTitle: string, newTitle: string):
    { html: string; hits: number } {
  if (!html || !oldTitle || oldTitle === newTitle) return { html, hits: 0 };
  const d = decodeWithMap(html);
  const at: number[] = [];
  for (let i = d.text.indexOf(oldTitle); i >= 0; i = d.text.indexOf(oldTitle, i + oldTitle.length)) {
    at.push(i);
  }
  if (!at.length) return { html, hits: 0 };
  const rep = escapeHtml(newTitle);
  let out = html;
  for (let k = at.length - 1; k >= 0; k--) {
    const i = at[k];
    out = out.slice(0, d.from[i]) + rep + out.slice(d.to[i + oldTitle.length - 1]);
  }
  return { html: out, hits: at.length };
}

// --- THE REST OF THE LISTING SAYS IT TOO -------------------------------------
//
// Ethan, 2026-09-03: "if we change something in the title and that change is
// something in the HTML spec table or the listing metafields, that needs to be
// changed there too so the listing remains consistent from the title to the
// rest. Example would be if we change the model number in the title, we need to
// change it everywhere in the listing."
//
// A title is not the only place a listing states a fact about itself. MPL's
// Sony ZV-E10 says "L-Mount" in FOUR places: the title, the Mount Type row of
// the description's spec table, the `custom.mount_type` metafield, and again
// inside `custom.title_attributes` — the JSON array PayMore's lister BUILDS the
// title from. Correcting the title alone leaves three copies of the error
// standing, and the spec table is exactly where a buyer looks to check what the
// title just told them.
//
// ⚠️ IT ONLY EVER CHANGES THE WORDS THE REVIEWER SAW MARKED. The changed run is
// computed with the SAME word-level head/tail diff the row draws on screen
// (`_ltRun` in speeks.js), so what this rewrites can never be wider than the
// green words somebody just read and approved. Nothing is inferred from the
// product and nothing is guessed: a title edit whose words cannot be found in a
// spec field changes the title and nothing else, and says so.
//
// ⚠️ ONE RUN, NOT A WORD-BY-WORD ALIGNMENT. "8 Core SR3QR 8 Thread" becomes
// "6 Core SR3QR 12 Thread" as ONE run with an unchanged middle, and it will not
// match the short value "8" that a Core Count field holds. That miss is
// deliberate: pairing "8"->"6" and "8"->"12" onto separate fields means deciding
// which bare number belongs to which key, and a bare number matches everything.
// A missed propagation is reported as "still says"; a wrong one is silent damage
// to the only description a buyer reads.

type SpecField = { k: string; v: string; at: string[] };
type Echo = { field: string; was: string; now: string; where: string[] };

// Prose, checklists and identifiers — none of them a statement of spec, and all
// three are ways to damage a listing quietly. A serial number that happens to
// contain the changed run is not a claim about the model, it is the identity of
// the unit in the box; `whats_include` is the accessory checklist (already
// carried, where it quotes the title, by the whole-title swap above); the
// condition fields are two paragraphs of English about scratches.
const ECHO_SKIP_KEY =
  /serial|barcode|\bupc\b|\bean\b|\bsku\b|\bqty\b|quantit|condition|descript|cosmetic|functional|includ|\bnote|categor|handle|\btag|image|photo|price|weight/i;

// A spec value is short, flat, and not a stand-in. The length cap keeps a
// paragraph out; the tag test keeps markup out of a string we are about to
// compare and rewrite; PLACEHOLDER is the same list the suggestion builder uses
// to refuse "VARIOUS" as a model.
function specish(v: string): boolean {
  const t = (v || "").trim();
  return !!t && t.length <= 120 && !/[<>\r\n]/.test(t) && !PLACEHOLDER.test(t);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ⚠️ NOT \b. The runs this matches start and end on punctuation as often as not
// — "f/3.5-5.6", "(2x8GB)", "24.2MP" — and \b in front of "(" is a boundary in
// the wrong place. The rule actually wanted is: not glued to a letter or a
// digit, so "SATA" never matches inside "eSATA" and "8GB" never inside "128GB".
const runRe = (was: string) =>
  new RegExp(`(?<![A-Za-z0-9])${escapeRe(was)}(?![A-Za-z0-9])`, "gi");

// ============ WHICH WORDS THE TITLE IS *NOT* THE ONLY PLACE FOR ==============
// Ethan, on a CPU/motherboard combo with no room for the words that name it:
// *"can you not safely give a recommendation on what can be subbed out — clock
// speed might not be as important as CPU Motherboard combo right?"*
//
// Right about the ranking, and the tool already holds it: `TITLE_SPECS` is the
// measured list of what earns title space, and Processor Speed is not on it.
// ⚠️ BUT ABSENCE FROM `TITLE_SPECS` MEANS "NOBODY MEASURED THAT FIELD", NOT
// "WORTHLESS". That list was built against phones, laptops and cameras; "LGA
// 1700 motherboard" is a real search. Deleting everything not on it would cut
// the socket to buy room — a worse title wearing a fix's clothes. And on the row
// that raised the question the trade does not even work: the gap is 22
// characters and the clock speed is 8.
//
// So this NAMES CANDIDATES AND EDITS NOTHING. The reviewer has to decide what
// comes out; the one thing they would otherwise go and check by hand is which of
// these words the LISTING still says on its own, and that is exactly what this
// answers. Cutting one of these loses it from the title only.
//
// ⚠️ AN ALLOW-LIST, NOT A DENY-LIST — the same one-directional safety as the
// noun gate. A field missing from here means we name one fewer candidate; a
// deny-list with a gap would name the BRAND. ("Motherboard Brand" and "CPU
// Model" do not appear in TITLE_SPECS verbatim, so "not in TITLE_SPECS" would
// have offered up "Gigabyte" and "Core I5-13600KF" as things to cut.)
const SECONDARY_SPEC =
  /^((processor|clock|memory|bus|write|read)\s+)?speed$|^socket$|^chipset$|^form\s+factor$|^cores?$|^thread\s+count$|^cache$|^interface$|^voltage$|^rpm$|^memory\s+(type|slots?)$|^expansion|^bus$/i;

// ⚠️ THE ORDER IS THE ONLY OPINION IN HERE, SO IT IS WRITTEN DOWN.
// Dropped cheapest-first and THE SOCKET IS LAST: "LGA 1700 motherboard" is a
// real search, while a clock speed is implied by the CPU model number standing
// next to it and a core count by the same. Ethan's own hand-typed fix for the
// OVL combo dropped the speed and the form factor and kept the socket, which is
// what this order produces.
const TRIM_RANK: [RegExp, number][] = [
  [/speed$/i, 1], [/^cores?$/i, 2], [/^thread\s+count$/i, 3], [/^cache$/i, 4],
  [/^voltage$/i, 5], [/^rpm$/i, 6], [/^memory\s+(type|slots?)$/i, 7],
  [/^interface$/i, 8], [/^expansion/i, 9], [/^bus$/i, 10],
  [/^form\s+factor$/i, 11], [/^chipset$/i, 12], [/^socket$/i, 13],
];
const trimRank = (k: string) =>
  (TRIM_RANK.find(([re]) => re.test(k.trim())) || [null, 99])[1] as number;

// Values the spec table states AND the title repeats, limited to the fields
// above, CHEAPEST FIRST. Uses `runRe` so the boundary rule is the one the rest
// of the tool uses — "ATX" must not match inside "microATX", "8GB" not inside
// "128GB".
// ⚠️ WHERE A MEASUREMENT GOES IS PART OF WHETHER IT WORKS.
// Ethan, on three phones with the size stuck on the end: *"do you think this
// is the best spot in the title for them?"* No — and PayMore's own catalogue
// settles it without ambiguity. EVERY phone and tablet title in the estate
// that already carries a screen size puts it IMMEDIATELY AFTER THE MODEL, and
// so does every laptop and every monitor:
//     WiFi Only Apple iPad Pro 12.9" 6th Gen 128GB Space Gray MP5X3LL/A
//     T-Mobile Samsung Galaxy Tab S9 FE 10.9" 128GB Gray SM-X518U
//     Dell Inspiron 3521 15.6" i3-3227U 1.9GHz 6GB RAM 500GB HDD
//
// Appending put it after the PART NUMBER — behind the one string in the title
// nobody searches, first to be cut when a search result truncates, and reading
// like a piece of the SKU. The rows it was actually producing:
//     Broken Unlocked Apple iPhone 14 128GB 26.2 MPUX3LL/A (Bad Battery 77%) 6.1"
//     T-Mobile Google Pixel 10a 128GB Obsidian GA10052-US NO SIM TRAY 6.3"
//     Apple MacBook Air L2RN2LDT9 Gold 15"
//
// ⚠️ NOT "BEFORE THE STORAGE", which looks equivalent on an iPhone and is not:
// "TracFone Samsung Galaxy A14 5G 4GB RAM 64GB" has TWO capacities and the
// Storage one is the second, so that rule lands the screen size in the middle
// of the memory. The model is the anchor, and the spec table's `Model` matches
// these titles verbatim ("iPhone Air", "Galaxy A14 5G", "iPad 1st Gen",
// "Kindle Colorsoft") because the same lister writes both.
//
// Falls back to appending — what it has always done — when there is no model
// to anchor to. Same length rule either way: an addition that does not fit is
// not made.
function placeAfter(title: string, word: string, after: string): string | null {
  const m = after ? runRe(after).exec(title) : null;
  if (!m) return null;
  const end = m.index + m[0].length;
  return `${title.slice(0, end)} ${word}${title.slice(end)}`;
}

function alsoInSpecs(title: string, specs: Record<string, string> | undefined): string[] {
  if (!specs) return [];
  const hits: { v: string; rank: number }[] = [];
  for (const [k, raw] of Object.entries(specs)) {
    if (!SECONDARY_SPEC.test(String(k).trim())) continue;
    const v = String(raw || "").trim();
    // Long values are I/O port lists and the like — never a word somebody would
    // trim by hand, and they are not in the title anyway.
    if (!v || PLACEHOLDER.test(v) || v.length < 3 || v.length > 24) continue;
    if (!runRe(v).test(title)) continue;
    if (!hits.some(h => h.v === v)) hits.push({ v, rank: trimRank(k) });
  }
  return hits.sort((a, b) => a.rank - b.rank).map(h => h.v).slice(0, 4);
}

// ⚠️ MAKING ROOM IS ALLOWED ONLY BY DELETING A NAMED FACT THE LISTING STILL
// STATES — NEVER BY TRUNCATING.
// Ethan, having typed the fix by hand rather than being handed it: *"Can you
// give the actual recommended title to approve. I still feel for something I
// want simple and easy, stuff like this is too complicated and manual."* He is
// right — a finding that describes the edit and leaves you to make it is a
// worksheet, not a tool.
//
// The distinction from the old banned behaviour is the whole safety argument.
// `capTitle` cut on a word boundary from the END and once dropped the "4050"
// out of an Asus title to buy room for " Bundle" — it did not know what it was
// deleting. This deletes a value the SPEC TABLE STATES, chosen by name, in a
// fixed published order, the fewest that will do, and reports every one of them
// back so the row can print them in red. Nothing leaves the LISTING; the words
// leave the TITLE only, and the spec-echo subtraction rule already refuses to
// follow a trim into the fields (shortening is not correcting).
//
// Returns the shortened title and what came out, or null when it cannot be done
// inside the rules — in which case the finding goes back to naming the word and
// letting the reviewer choose.
function trimToFit(title: string, add: string,
                   specs: Record<string, string> | undefined) {
  const want = EBAY_TITLE_MAX - (add.length + 1);
  if (title.length <= want) return null;          // it already fits; not our job
  let t = title;
  const gone: string[] = [];
  for (const v of alsoInSpecs(title, specs)) {
    // ⚠️ THREE IS THE CAP. A title needing four facts removed to name itself is
    // not a title with a spacing problem, it is a listing somebody should look
    // at — and a suggestion that deletes half a title is one nobody will trust
    // enough to read the next one.
    if (gone.length >= 3) break;
    const next = t.replace(runRe(v), " ").replace(/\s+/g, " ").trim();
    if (!next || next.length >= t.length) continue;
    // Never leave a stub. Brand plus model is the floor.
    if (next.split(" ").length < 3) continue;
    t = next; gone.push(v);
    if (t.length <= want) return { title: t, gone };
  }
  return null;
}

// Matched case-insensitively, but what goes IN is written exactly as the
// reviewer approved it. The title is the sentence somebody just checked, and a
// spec table quietly Title-Casing it differently is a third version of the truth.
function replaceRun(v: string, was: string, now: string): string | null {
  if (!v || !was || !now) return null;
  if (!runRe(was).test(v)) return null;
  const out = v.replace(runRe(was), now).replace(/\s+/g, " ").trim();
  if (!out || out === v.trim() || PLACEHOLDER.test(out)) return null;
  return out;
}

// ⚠️ TAKING WORDS OUT IS ONLY SAFE WHEN THEY WERE WRONG.
// Ethan, 2026-09-03: "subtraction only needs to occur if it's truly changing
// something to be correct. If we are just shortening the title, but not
// correcting a mistake, we shouldn't subtract from within the listing."
//
// That is the whole rule, and it is decidable from the finding that raised the
// row rather than guessed at. A name-wrong deletion means the words were untrue
// of the item — the Dell that says IPS when the panel is TN, the Micron whose
// (4x1GB) contradicts its own part number — and a field still stating them is
// stating something false. A repeated-phrase or truncated-title deletion means
// the words were merely redundant IN A TITLE; the spec field that holds them
// once is correct, and cutting them there would delete real information to make
// a title fit. "Factory Unlocked" trimmed off an 80-character title must never
// disappear out of the Network field where it belongs.
const CORRECTING_CODES = new Set<string>([
  "name-wrong", "name-garbled", "spec-conflict", "hardware-conflict",
]);

// The field with the run taken out, or null when what is left is not a value.
// ⚠️ A FIELD MUST NEVER BE EMPTIED. "Canon" removed from a Brand of "Canon" is
// not a correction, it is a deletion of the field, and the reviewer would have
// no way of knowing it happened from a line that says "Brand: Canon -> ".
function subtractRun(v: string, was: string): string | null {
  if (!v || !was || !runRe(was).test(v)) return null;
  const out = v.replace(runRe(was), " ")
    .replace(/\s+/g, " ").trim()
    // The spacing the removal left behind, not a rewrite: a run cut from inside
    // "For Canon MFT Mount" must not leave "For  MFT Mount" or " ,".
    .replace(/\s+([,;:)\]])/g, "$1").replace(/([(\[])\s+/g, "$1")
    .replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, "").trim();
  if (!out || out === v.trim() || out.length < 2) return null;
  if (PLACEHOLDER.test(out)) return null;
  // Two adjacent alphanumerics somewhere: "(" or "-" alone is not a value.
  if (!/[A-Za-z0-9]{2}/.test(out)) return null;
  return out;
}

// The lister's JSON attribute arrays: [{key,value}, ...]. ⚠️ ANY OTHER SHAPE IS
// LEFT ALONE. `custom.condition` is a list of bare strings, and other fields may
// hold objects nobody here has seen; a shape we do not understand is one we do
// not edit.
function jsonPairs(raw: string): { key: string; value: string }[] | null {
  const t = (raw || "").trim();
  if (!t.startsWith("[")) return null;
  let j: unknown;
  try { j = JSON.parse(t); } catch { return null; }
  if (!Array.isArray(j) || !j.length) return null;
  const out: { key: string; value: string }[] = [];
  for (const e of j) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return null;
    const o = e as Record<string, unknown>;
    if (typeof o.value !== "string" || typeof o.key !== "string") return null;
    out.push({ key: o.key, value: o.value });
  }
  return out;
}

// Every <td> pair in the description, with the VALUE cell's span in the original
// html. parseSpecs answers "what does it say"; this answers "where does it say
// it", which is what a rewrite needs. Same two-cell rule, so the two can never
// disagree about which rows are spec rows.
function specCells(html: string):
    { key: string; value: string; start: number; end: number }[] {
  const out: { key: string; value: string; start: number; end: number }[] = [];
  const tr = /<tr\b[\s\S]*?<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = tr.exec(html))) {
    const rowHtml = m[0], base = m.index;
    const td = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: { inner: string; start: number; end: number }[] = [];
    let c: RegExpExecArray | null;
    while ((c = td.exec(rowHtml))) {
      const openLen = c[0].length - c[1].length - "</td>".length;
      cells.push({ inner: c[1],
                   start: base + c.index + openLen,
                   end: base + c.index + openLen + c[1].length });
    }
    if (cells.length !== 2) continue;
    const key = stripTags(cells[0].inner).replace(/[?:]+$/, "").trim();
    const value = stripTags(cells[1].inner);
    if (key && value) out.push({ key, value, start: cells[1].start, end: cells[1].end });
  }
  return out;
}

// Everywhere this listing writes a fact down, grouped by the VALUE rather than
// by the field name — the spec table calls it "Mount Type" and the metafield
// calls it `mount_type`, and they are one fact in two places. The name shown is
// the spec table's when it has one, because that is the name on the page the
// reviewer is looking at.
function collectSpecFields(html: string, mf: Record<string, string>): SpecField[] {
  const by = new Map<string, SpecField>();
  const add = (k: string, v: string, at: string, tabled: boolean) => {
    if (!k || ECHO_SKIP_KEY.test(k) || !specish(v)) return;
    const id = v.trim().toLowerCase();
    const f = by.get(id) || { k, v: v.trim(), at: [] };
    if (tabled) f.k = k;
    if (!f.at.includes(at)) f.at.push(at);
    by.set(id, f);
  };
  for (const cell of specCells(html)) add(cell.key, cell.value, "spec table", true);
  for (const [key, raw] of Object.entries(mf || {})) {
    if (ECHO_SKIP_KEY.test(key)) continue;
    const pairs = jsonPairs(raw);
    if (pairs) { for (const p of pairs) add(p.key || key, p.value, key, false); continue; }
    add(key, raw, key, false);
  }
  return [...by.values()];
}

// Mirror of `_ltRun` in speeks.js — deliberately the same diff, so the words
// this goes looking for are the words the reviewer saw marked.
function titleRun(from: string, to: string): { was: string; now: string } {
  const a = String(from || "").trim().split(/\s+/);
  const b = String(to || "").trim().split(/\s+/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
         && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { was: a.slice(head, a.length - tail).join(" "),
           now: b.slice(head, b.length - tail).join(" ") };
}

type EchoPlan = {
  html: string;
  cellHits: number;
  mfUpdates: { id: string; value: string }[];
  echoes: Echo[];
  stillSays: { field: string; value: string; where: string[] }[];
};

// What the rest of the listing should say once this title lands — and what it
// will go on saying that the title no longer does.
//
// ⚠️ THE DESCRIPTION IS SPLICED, NEVER REBUILT. Each write is bounded to the
// inside of one value <td>, and inside that cell the entity-aware map from
// swapTitleInHtml does the work — so a cell reading `Sony<div style="color:
// red"><br></div>` keeps its marker div, its attributes and its bytes, and only
// the run changes. A cell whose value is broken across a tag ("Alpha
// <span>A7C</span>") simply does not match, and is reported as still saying it.
// Whether the words being cut were WRONG, rather than merely surplus in a
// title. Read off the findings that raised the row — see CORRECTING_CODES.
function isCorrecting(findings: unknown): boolean {
  return Array.isArray(findings)
    && findings.some((f: any) => CORRECTING_CODES.has(String(f?.code || "")));
}

function planEchoes(html: string, mfs: { id: string; key: string; value: string }[],
                    was: string, now: string, nextTitle = "",
                    correcting = false): EchoPlan {
  const plan: EchoPlan = { html, cellHits: 0, mfUpdates: [], echoes: [], stillSays: [] };
  if (!was) return plan;
  const found = new Map<string, Echo>();
  const note = (field: string, oldV: string, newV: string, at: string) => {
    const id = oldV.trim().toLowerCase();
    const e = found.get(id) || { field, was: oldV.trim(), now: newV.trim(), where: [] };
    if (!e.where.includes(at)) e.where.push(at);
    found.set(id, e);
  };
  // ⚠️ A DELETION IS USUALLY A DE-DUPLICATION, AND THE SPEC FIELD IS RIGHT.
  // The commonest fix this tool makes is cutting a phrase the title said twice
  // — "PENTAX 50-200mm f/4-5.6 50-200mm f/4-5.6 DAL" — and the Model field says
  // it exactly ONCE, which is correct and must not be touched. Measured over the
  // live queue, reporting every deletion put 22 rows on the leftover list of
  // which 19 were de-duplications; the reviewer would have learned to ignore the
  // line, which is the same as not printing it. So a field is only "still
  // saying" it when the new title HAS STOPPED saying it.
  const lost = !!was && !runRe(was).test(nextTitle || "");
  // now === "" is a deletion. It is applied to the fields ONLY when the row was
  // raised by a finding that says the words were wrong (see CORRECTING_CODES);
  // otherwise the field keeps them and the reviewer is told, which is the
  // difference between fixing a listing and trimming one to fit.
  const nextFor = (v: string) =>
    now ? replaceRun(v, was, now)
        : (correcting && lost ? subtractRun(v, was) : null);
  // ⚠️ EVERY PLACE, NOT THE FIRST ONE. A leftover is grouped by value exactly as
  // a rewrite is, because it is the same fact in the same several places — the
  // Canon T2i states its Type in the spec table AND `custom.type` AND
  // `filter_attributes` AND `title_attributes`, and a line naming only the spec
  // table understates the work by three fields.
  const left = (field: string, value: string, at: string) => {
    if (!lost) return;
    const v = value.trim();
    const had = plan.stillSays.find(s => s.value.toLowerCase() === v.toLowerCase());
    if (had) { if (!had.where.includes(at)) had.where.push(at); return; }
    plan.stillSays.push({ field, value: v, where: [at] });
  };

  // The description, back to front so the earlier offsets stay valid — the same
  // reason swapTitleInHtml splices in reverse.
  const cells = specCells(plan.html);
  for (let i = cells.length - 1; i >= 0; i--) {
    const cell = cells[i];
    if (ECHO_SKIP_KEY.test(cell.key) || !specish(cell.value)) continue;
    if (!runRe(was).test(cell.value)) continue;
    const next = nextFor(cell.value);
    if (!next) { left(cell.key, cell.value, "spec table"); continue; }
    // Locate the run INSIDE the cell, entity-aware, and splice by offset.
    const inner = plan.html.slice(cell.start, cell.end);
    const d = decodeWithMap(inner);
    const at: number[] = [];
    const re = runRe(was);
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(d.text))) at.push(mm.index);
    if (!at.length) { left(cell.key, cell.value, "spec table"); continue; }
    let outInner = inner;
    for (let k = at.length - 1; k >= 0; k--) {
      const s = at[k];
      // ⚠️ A SUBTRACTION TAKES ONE SPACE WITH IT. Splicing "" out of
      // "Digital SLR DSLR Camera" otherwise leaves " DSLR Camera" in the cell —
      // invisible in a browser, but it is what the next sweep reads back and
      // compares, and a value that gains a leading space every time it is edited
      // is a value that stops matching itself.
      let end = s + was.length - 1;
      if (!now && d.text[end + 1] === " ") end += 1;
      else if (!now && s > 0 && d.text[s - 1] === " ") {
        outInner = outInner.slice(0, d.from[s - 1]) + escapeHtml(now)
                 + outInner.slice(d.to[end]);
        continue;
      }
      outInner = outInner.slice(0, d.from[s])
               + escapeHtml(now)
               + outInner.slice(d.to[end]);
    }
    plan.html = plan.html.slice(0, cell.start) + outInner + plan.html.slice(cell.end);
    plan.cellHits += at.length;
    note(cell.key, cell.value, next, "spec table");
  }

  for (const f of mfs) {
    if (!f.id || ECHO_SKIP_KEY.test(f.key)) continue;
    const pairs = jsonPairs(f.value);
    if (pairs) {
      let touched = false;
      const outPairs = pairs.map(p => {
        if (ECHO_SKIP_KEY.test(p.key) || !specish(p.value)) return p;
        if (!runRe(was).test(p.value)) return p;
        const next = nextFor(p.value);
        if (!next) { left(p.key || f.key, p.value, f.key); return p; }
        touched = true;
        note(p.key || f.key, p.value, next, f.key);
        return { ...p, value: next };
      });
      if (touched) plan.mfUpdates.push({ id: f.id, value: JSON.stringify(outPairs) });
      continue;
    }
    if (!specish(f.value) || !runRe(was).test(f.value)) continue;
    const next = nextFor(f.value);
    if (!next) { left(f.key, f.value, f.key); continue; }
    plan.mfUpdates.push({ id: f.id, value: next });
    note(f.key, f.value, next, f.key);
  }

  plan.echoes = [...found.values()];
  return plan;
}

// The changed bytes and nothing else, for reading a splice back. A whole
// description is 6KB of markup nobody will check by eye, which is the same as
// not checking it.
function htmlDelta(a: string, b: string): { before: string; after: string } | null {
  if (a === b) return null;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i
         && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const pad = 60;
  return { before: a.slice(Math.max(0, i - pad), a.length - j + pad),
           after: b.slice(Math.max(0, i - pad), b.length - j + pad) };
}

// WHAT THE ECHOES WOULD DO TO THE WHOLE QUEUE, WITHOUT TOUCHING ANYTHING.
// ?echoes=1&store=ALL&secret= — every open row that has a suggestion, with the
// spec fields that suggestion would carry the change into and the ones it would
// leave saying the old thing.
//
// The sweep has been dry by default since the day it was written, and the spec
// echoes are the half that writes into the description a customer reads. This is
// how a rule change gets measured over 100 real listings before a reviewer meets
// it, which is exactly how the eight false-positive classes were found.
async function echoSweep(store: string, limit: number) {
  const q: any[] = await allRows(
    `listing_title_queue?store_code=eq.${store}&suggested_title=not.is.null`
    + `&select=sku,product_id,current_title,suggested_title,findings&limit=${limit}`);
  if (!q.length) return { store, examined: 0, rows: [] as any[] };
  const { shop, token } = await shopFor(store);
  const ids = [...new Set(q.map(r => String(r.product_id)))];
  const raw: Record<string, { html: string; mfs: { id: string; key: string; value: string }[] }> = {};
  const CHUNK = 25;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const data = await shopifyGql(shop, token, `
      query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product {
        id descriptionHtml
        metafields(first: 60) { edges { node { id key value } } }
      } } }`, { ids: ids.slice(i, i + CHUNK) });
    for (const n of (data?.nodes || [])) {
      if (!n?.id) continue;
      raw[String(n.id)] = {
        html: String(n.descriptionHtml || ""),
        mfs: (n.metafields?.edges || []).map((e: any) => ({
          id: String(e?.node?.id || ""), key: String(e?.node?.key || ""),
          value: String(e?.node?.value ?? ""),
        })),
      };
    }
  }
  const rows = q.map(r => {
    const x = raw[String(r.product_id)];
    if (!x) return { sku: r.sku, error: "product not readable in Shopify" };
    const run = titleRun(r.current_title || "", r.suggested_title || "");
    const plan = planEchoes(x.html, x.mfs, run.was, run.now, r.suggested_title || "",
                            isCorrecting(r.findings));
    return {
      sku: r.sku, from: r.current_title, to: r.suggested_title, run,
      specRows: plan.cellHits, metafields: plan.mfUpdates.length,
      alsoUpdated: plan.echoes, stillSays: plan.stillSays,
    };
  });
  return {
    store, examined: rows.length,
    withEcho: rows.filter((r: any) => (r.alsoUpdated || []).length).length,
    withLeftover: rows.filter((r: any) => (r.stillSays || []).length).length,
    rows,
  };
}

async function handlePost(req: Request, scope: Scope) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  // --- the notes have been carried into an ask ------------------------------
  // ⚠️ BEFORE THE store / productId GATES BELOW, because this acts on a LIST
  // spanning every store the reviewer holds — one ask covers the whole estate,
  // which is the point of grouping by rule rather than by row.
  //
  // ⚠️ IT MARKS THE NOTE READ, NOT THE RULE FIXED. Whether the rule then changed
  // is decided in a conversation this function cannot see. Stamping anything
  // stronger would let the panel claim a fix that never happened.
  if (action === "triaged") {
    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (!keys.length) return json({ error: "keys required" }, 400);
    const stamp = { feedback_triaged_at: new Date().toISOString(),
                    feedback_triaged_by: scope.name };
    let n = 0;
    for (const k of keys.slice(0, 60)) {
      const st = String(k?.store || "").toUpperCase();
      const pid = String(k?.productId || "");
      // A store outside the reviewer's scope is skipped rather than refused: the
      // ask they were shown was built from their own scope, so a mismatch means
      // a stale tab, and failing the whole batch would leave the card up with no
      // way to clear it.
      if (!st || !pid || !scope.stores.includes(st)) continue;
      await sb(`listing_title_reviews?store_code=eq.${st}&product_id=eq.${encodeURIComponent(pid)}`
               + `&status=eq.denied`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify(stamp),
      });
      n++;
    }
    return json({ ok: true, triaged: n });
  }

  const store = String(body.store || "").toUpperCase();
  if (!scope.stores.includes(store)) {
    return json({ error: "forbidden", detail: `not your store: ${store}` }, 403);
  }
  const productId = String(body.productId || "");
  if (!productId) return json({ error: "productId required" }, 400);

  // ⚠️ ONLY EVER ACT ON WHAT THE QUEUE SAYS. A product id posted by a browser is
  // a request to act on a queued row, not a licence to retitle anything in the
  // catalogue. The view already refuses a row whose title moved under us.
  // ⚠️ REOPEN READS THE TABLE, NOT THE QUEUE VIEW. The view is status='open' by
  // definition, so looking a denied row up in it always fails — the one row
  // reopen exists to act on is the one row the queue cannot see.
  const q: any[] = action === "reopen"
    ? await rows(
        `listing_title_reviews?store_code=eq.${store}&product_id=eq.${encodeURIComponent(productId)}`
        + `&status=eq.denied&select=product_id,sku,current_title,suggested_title,findings,basis&limit=1`)
    : await rows(
        `listing_title_queue?store_code=eq.${store}&product_id=eq.${encodeURIComponent(productId)}`
        + `&select=product_id,sku,current_title,suggested_title,findings,basis&limit=1`);
  const item = q[0];
  if (!item) {
    return json({ error: "not in the queue",
                  detail: "This row is no longer waiting on a decision — its title may have been changed in Shopify since the list was drawn. Reload the queue." }, 409);
  }

  if (action === "deny") {
    // ⚠️ WHICH ANSWER, NOT JUST THAT ONE WAS GIVEN. "The rule is wrong" and
    // "our title is right, eBay's copy is stale" both empty the row out of the
    // queue and mean opposite things about this tool. Counted together, every
    // rule would look broken in proportion to how often Marketplace Connect
    // failed to sync. The client says which; anything it does not recognise
    // falls back to the ordinary reading rather than being refused, because a
    // decision a reviewer has already made should never be lost to a typo.
    const asRaw = String(body.as || "").trim();
    const decidedAs = asRaw === "ebay-stale" ? "ebay-stale" : "not-a-problem";
    await sb(`listing_title_reviews?store_code=eq.${store}&product_id=eq.${encodeURIComponent(productId)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "denied", decided_by: scope.name, decided_at: new Date().toISOString(),
        decided_as: decidedAs,
        decided_note: String(body.reason || "").slice(0, 300) || null,
      }),
    });
    return json({ ok: true, denied: productId, decidedAs });
  }

  // Undo. A denial that cannot be taken back is a decision people hesitate over,
  // and hesitation is how a review queue stops being worked. Clearing the whole
  // decision rather than only the status: a row put back in the queue carrying
  // somebody's old note and timestamp would read as still decided.
  if (action === "reopen") {
    await sb(`listing_title_reviews?store_code=eq.${store}&product_id=eq.${encodeURIComponent(productId)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "open", decided_by: null, decided_at: null,
        decided_as: null, decided_note: null,
      }),
    });
    return json({ ok: true, reopened: productId });
  }

  // "preview" is approve's own reading half, stopped one line before it writes.
  // It exists so the confirm box can name the OTHER fields this will rewrite —
  // and it runs the same code the write runs, against the same live listing, a
  // second before it. A preview computed from a stored snapshot, or by a second
  // implementation on the client, would eventually describe a change that is not
  // the change being made, which is worse than showing nothing.
  if (action !== "approve" && action !== "preview") {
    return json({ error: `unknown action: ${action}` }, 400);
  }

  // An edited title beats the suggestion always — the person is holding the
  // item. A row that arrived with no suggestion can ONLY be approved with one
  // typed, which is the point of leaving it null.
  const typed = String(body.title || "").replace(/\s+/g, " ").trim();
  const next = typed || String(item.suggested_title || "");
  if (!next) {
    return json({ error: "a title is required",
                  detail: "This row has no suggested title — it needs one typed in before it can be approved." }, 400);
  }
  if (next.length > EBAY_TITLE_MAX) {
    return json({ error: "title too long",
                  detail: `eBay refuses a title over ${EBAY_TITLE_MAX} characters; this one is ${next.length}.` }, 400);
  }
  if (next === item.current_title) {
    return json({ error: "nothing to change",
                  detail: "That is the title the listing already has." }, 400);
  }

  const { shop, token } = await shopFor(store);

  // ⚠️ THE DESCRIPTION CARRIES ITS OWN COPY OF THE TITLE.
  // PayMore's listing tool writes the title into the description body too — as
  // an <h1> at the top and again under "Items included in this sale". Caught on
  // the very first real approve: the product page showed the corrected title in
  // the title field and the old one in its own heading, two paragraphs apart.
  // Marketplace Connect renders that description verbatim inside its eBay
  // wrapper, so the stale copy would be on the eBay listing as well.
  //
  // The replacement is a LITERAL string swap of the exact old title, never HTML
  // surgery: we know precisely which characters to look for, so there is no
  // parsing to get wrong and no way to touch markup that does not contain it.
  // If the old title does not appear, nothing is written.
  // ⚠️ AND A THIRD COPY LIVES IN A METAFIELD. `whats_include` on BAL
  // MO04-1726A-E10 reads "Fractal Custom PC … Nvidia GeForce GTX 1060" — the
  // whole title, one GPU out of date, in a field the description swap below
  // cannot reach because it is not in descriptionHtml at all. Left alone, a
  // manager fixes the title and the tool's own `included` list still quotes the
  // old one back at them.
  let descriptionHtml: string | null = null;
  let descHits = 0;
  let specRows = 0;
  let html = "";
  const mfList: { id: string; key: string; namespace: string; type: string;
                  value: string }[] = [];
  // id -> the value to write. One map, so the title swap and the spec echoes
  // below cannot each send their own half of the same metafield.
  const mfChanged = new Map<string, string>();
  let alsoUpdated: Echo[] = [];
  let stillSays: EchoPlan["stillSays"] = [];
  // ⚠️ TWO READS, NOT ONE. These used to share a query, and shopifyGql throws on
  // ANY error in the response — so a metafields half that failed for its own
  // reasons (a throttle, a permission, a product with an awkward field) took the
  // descriptionHtml half down with it, into a catch that says nothing. The
  // description is the copy a customer reads; it does not get to depend on the
  // metafields call succeeding. Same lesson the Live Dashboard learned when one
  // store's ShopifyQL fault silently killed its orders query too.
  try {
    const cur = await shopifyGql(shop, token,
      `query($id: ID!) { product(id: $id) { descriptionHtml } }`, { id: productId });
    html = String(cur?.product?.descriptionHtml || "");
    if (html && item.current_title) {
      const swap = swapTitleInHtml(html, item.current_title, next);
      if (swap.hits) { html = swap.html; descHits = swap.hits; }
    }
  } catch {
    // A title fix that lands is worth more than one that fails over its own
    // footnote. The description staying stale is visible and recoverable; a
    // refused title change is the thing somebody came here to do.
  }
  try {
    // ⚠️ NAMESPACE AND TYPE ARE READ BECAUSE THE WRITE NEEDS THEM, NOT FOR
    // information. `metafieldsSet` identifies a metafield by ownerId +
    // namespace + key — there is NO `id` field on MetafieldsSetInput (asked of
    // the live API: ownerId, namespace, key, value, compareDigest, type). We
    // were sending `id`, which is a GraphQL VALIDATION error, so Shopify
    // rejected the whole mutation before touching anything and the catch below
    // swallowed it. Every metafield write this tool has ever made silently did
    // nothing until 2026-09-03.
    const cur = await shopifyGql(shop, token,
      `query($id: ID!) { product(id: $id) {
         metafields(first: 60) { edges { node { id namespace key type value } } }
       } }`, { id: productId });
    for (const e of (cur?.product?.metafields?.edges || [])) {
      const id = String(e?.node?.id || "");
      if (!id) continue;
      mfList.push({ id, key: String(e?.node?.key || ""),
                    namespace: String(e?.node?.namespace || ""),
                    type: String(e?.node?.type || ""),
                    value: String(e?.node?.value ?? "") });
    }
    if (item.current_title) {
      for (const f of mfList) {
        // A LITERAL swap here, deliberately unlike the description's. A
        // metafield holds plain text or JSON, not markup: there are no entities
        // to decode, and escaping what goes back in would write a literal
        // "&amp;" into a field that should hold an ampersand.
        if (f.value.includes(item.current_title)) {
          f.value = f.value.split(item.current_title).join(next);
          mfChanged.set(f.id, f.value);
        }
      }
    }
  } catch { /* the footnote's footnote */ }

  // ⚠️ AND THE SAME FACT IS WRITTEN DOWN AGAIN IN FIELDS THAT NEVER QUOTE THE
  // TITLE. The two swaps above only find a WHOLE copy of the old title. When a
  // title says "L-Mount" and so do the Mount Type row of the spec table, the
  // `mount_type` metafield and the `title_attributes` array the lister builds
  // titles from, fixing the title leaves the listing arguing with itself — and
  // the spec table is where a buyer goes to check what the title told them.
  // planEchoes carries the reviewer's own changed words into every field that
  // states them. Computed AFTER the swaps above so the two never write the same
  // field twice, and reported either way: what it changed, and what it could not
  // place and has left saying the old thing.
  {
    const run = titleRun(item.current_title || "", next);
    const plan = planEchoes(html, mfList, run.was, run.now, next,
                            isCorrecting(item.findings));
    if (plan.cellHits) { html = plan.html; specRows = plan.cellHits; }
    for (const u of plan.mfUpdates) mfChanged.set(u.id, u.value);
    alsoUpdated = plan.echoes;
    stillSays = plan.stillSays;
  }
  if (descHits || specRows) descriptionHtml = html;
  // Back to the field the id belongs to, because the write is addressed by
  // namespace + key. `type` is passed through unchanged: a metafield that has a
  // definition will be validated against it, and re-stating the type it already
  // has is the only way to be sure we are not proposing a new one.
  const mfById = new Map(mfList.map(f => [f.id, f]));
  const staleMetafields = [...mfChanged].map(([id, value]) => {
    const f = mfById.get(id);
    return f ? { namespace: f.namespace, key: f.key, type: f.type, value } : null;
  }).filter(Boolean) as { namespace: string; key: string; type: string; value: string }[];

  if (action === "preview") {
    return json({ ok: true, preview: true, title: next,
                  descriptionCopies: descHits, specRows,
                  metafields: staleMetafields.length,
                  alsoUpdated, stillSays });
  }

  const data = await shopifyGql(shop, token, `
    mutation($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id title }
        userErrors { field message }
      }
    }`, { input: { id: productId, title: next,
                   ...(descriptionHtml ? { descriptionHtml } : {}) } });
  const errs = data?.productUpdate?.userErrors || [];
  if (errs.length) {
    return json({ error: "shopify refused the change",
                  detail: errs.map((e: any) => `${(e.field || []).join(".")}: ${e.message}`).join("; ") }, 422);
  }
  const saved = data?.productUpdate?.product?.title || next;

  // ⚠️ A SEPARATE MUTATION, AFTER the title has landed, and its failure is
  // swallowed. Same rule the descriptionHtml read follows: a title fix that
  // lands is worth more than one that fails over its own footnote. Folding these
  // into the productUpdate input would let a metafield the API refuses take the
  // title change down with it.
  let metafieldsFixed = 0;
  // ⚠️ AND WHEN IT DOES NOT LAND, SAY SO. The reviewer was shown these fields in
  // the confirm box and clicked yes to all of them; a swallowed failure would
  // leave the listing half-corrected while the screen said it was done, which is
  // the silent no-op that hid the &amp; bug for a week.
  let metafieldsLeft = 0;
  // ⚠️ AND THE REASON IS KEPT. "Could not be saved" with no cause is how the
  // `id` bug survived: the message read as bad luck rather than as a mutation
  // that had never been valid.
  let metafieldsWhy = "";
  if (staleMetafields.length) {
    try {
      const res = await shopifyGql(shop, token, `
        mutation($mf: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $mf) { userErrors { field message } }
        }`, {
        mf: staleMetafields.map(m => ({ ownerId: productId, namespace: m.namespace,
                                        key: m.key, type: m.type, value: m.value })),
      });
      const ue = res?.metafieldsSet?.userErrors || [];
      if (!ue.length) {
        metafieldsFixed = staleMetafields.length;
      } else {
        metafieldsLeft = staleMetafields.length;
        metafieldsWhy = ue.map((e: any) => e.message).join("; ").slice(0, 300);
      }
    } catch (e) {
      metafieldsLeft = staleMetafields.length;
      metafieldsWhy = String((e as Error)?.message || e).slice(0, 300);
    }
  }

  // The ledger first, then the queue row. `current_title` is overwritten by the
  // next sweep, so without the move row there would be no record anywhere of
  // what the listing used to be called.
  await sb("listing_title_moves", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      store_code: store, product_id: productId, sku: item.sku,
      before_title: item.current_title, after_title: saved,
      edited: !!typed && typed !== String(item.suggested_title || ""),
      basis: item.basis, findings: item.findings || [], applied_by: scope.name,
      // Which spec fields moved with the title. Without this the ledger says
      // a title changed on Sep 3 and nothing about the four other places on
      // the same listing that changed with it.
      spec_changes: alsoUpdated,
    }),
  });
  await sb(`listing_title_reviews?store_code=eq.${store}&product_id=eq.${encodeURIComponent(productId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "applied", applied_title: saved,
      decided_by: scope.name, decided_at: new Date().toISOString(),
    }),
  });
  // ebay_catalog still holds the old title until the next catalogue sweep, and
  // the queue view keys off it — so patch it here too, or the row sits in the
  // queue looking undone until that sweep runs.
  await sb(`ebay_catalog?store_code=eq.${store}&product_id=eq.${encodeURIComponent(productId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ title: saved, updated_at: new Date().toISOString() }),
  }).catch(() => { /* cosmetic only; the next sweep fixes it */ });

  // descHits is reported because a SILENT no-op is what hid this for weeks: the
  // approve said ok, the title changed, and nobody could tell from the answer
  // whether the description had been carried along or quietly skipped.
  return json({ ok: true, applied: productId, title: saved,
                descriptionCopies: descHits,
                ...(specRows ? { specRows } : {}),
                ...(metafieldsFixed ? { metafieldsFixed } : {}),
                ...(metafieldsLeft ? { metafieldsLeft, metafieldsWhy } : {}),
                ...(alsoUpdated.length ? { alsoUpdated } : {}),
                // ⚠️ REPORTED EVEN THOUGH NOTHING WAS DONE ABOUT IT. A field
                // still stating what the title just stopped stating is the one
                // outcome a reviewer has to hear about — it is the case this
                // whole feature exists to end, and the case it cannot settle
                // on its own (a deletion has no replacement value to write).
                ...(stillSays.length ? { stillSays } : {}) });
}

// --- routing ----------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const pin = req.headers.get("x-user-pin") || "";
    const view = url.searchParams.get("view") || "";

    if (req.method === "POST" || view === "review" || view === "counts"
        || view === "feedback") {
      const scope = await scopeFor(pin);
      // A stale sessionStorage PIN outlives a PIN change and lands exactly here.
      if (!scope) {
        return json({ error: "unauthorized",
                      detail: "no matching user, or title review is not switched on for you" }, 401);
      }
      if (req.method === "POST") return await handlePost(req, scope);

      if (view === "counts") {
        // ⚠️ COUNT ONLY, NO SHOPIFY READ. This runs on a timer on the deck; the
        // gathering half (?view=feedback) costs a product read per store and is
        // fetched only when somebody asks for the ask.
        const [open, worst, noted] = await Promise.all([
          totals(scope.stores), worstFor(scope.stores), notedCount(scope.stores)]);
        return json({
          scope: { name: scope.name, role: scope.role, stores: scope.stores, corp: scope.corp },
          titles: open, titlesWorst: worst, noted,
        });
      }

      // ?view=feedback — the denials that carry a note, grouped by rule, with
      // the listing's own fields and a ready-to-paste ask. Read-only, and
      // deliberately NOT part of the review payload: it costs a Shopify read per
      // store and the panel loads it only when somebody asks for it.
      if (view === "feedback") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days") || 30), 1), 180);
        const fb = await feedbackFor(scope.stores, days);
        return json({ scope: { name: scope.name, role: scope.role, stores: scope.stores },
                      ...fb, ask: buildAsk(fb) });
      }

      const asked = (url.searchParams.get("store") || "").toUpperCase();
      const store = scope.stores.includes(asked) ? asked : scope.stores[0];
      const [queue, counts, ebay, denied] = await Promise.all([
        queueFor(store), totals(scope.stores), ebayScope(store), deniedFor(store)]);
      return json({
        scope: { name: scope.name, role: scope.role, stores: scope.stores, corp: scope.corp },
        store, queue, counts, ebayScope: ebay, denied,
      });
    }

    // --- what the analyser actually sees, for one SKU ------------------------
    // ?peek=1&store=OVL&sku=...&secret= — the spec table and the What's Included
    // list exactly as parseIncluded resolves them, plus the analysis.
    //
    // This exists because the FIRST dry run of this function proposed adding
    // "Bundle" to 21 of 25 titles, including a single video game. Reading the
    // real metafield is the only way to tell a bundle from a box that mentions
    // its own charging cable, and guessing at it from the outside is what
    // produced the bad rule.
    // --- CARRY A CHANGE INTO THE SPEC FIELDS OF A TITLE ALREADY CHANGED ------
    // ?respec=1&store=OVL&sku=…&was=1TB&now=960GB&secret=   (dry run)
    // …&apply=1                                             (writes)
    //
    // The approve does this as part of saving a title. This is the same work for
    // a title that has ALREADY moved — because the approve's metafield half
    // failed (the `id` bug above), or because somebody edited the title in
    // Shopify by hand, which happens constantly. Without it a half-corrected
    // listing has no route back: the row has left the queue, and approve refuses
    // a title the product already has.
    //
    // ⚠️ DRY BY DEFAULT, like every other sweep in this function. `apply=1` is
    // the only thing here that writes, and it never touches the title.
    if (url.searchParams.get("respec")) {
      if (url.searchParams.get("secret") !== SECRET) return json({ error: "forbidden" }, 403);
      const st = (url.searchParams.get("store") || "").toUpperCase();
      const sku = url.searchParams.get("sku") || "";
      const was = (url.searchParams.get("was") || "").trim();
      const now = (url.searchParams.get("now") || "").trim();
      if (!STORES.includes(st) || !sku || !was) {
        return json({ error: "store, sku and was are required" }, 400);
      }
      const cat: any[] = await rows(
        `ebay_catalog?store_code=eq.${st}&sku=eq.${encodeURIComponent(sku)}`
        + `&select=product_id,title&limit=1`);
      if (!cat[0]) return json({ error: `no catalog row for ${st} ${sku}` }, 404);
      const { shop, token } = await shopFor(st);
      const productId = String(cat[0].product_id);
      const d = await shopifyGql(shop, token,
        `query($id: ID!) { product(id: $id) { title descriptionHtml
           metafields(first: 60) { edges { node { id namespace key type value } } } } }`,
        { id: productId });
      const html = String(d?.product?.descriptionHtml || "");
      const mfs = (d?.product?.metafields?.edges || []).map((e: any) => ({
        id: String(e?.node?.id || ""), key: String(e?.node?.key || ""),
        namespace: String(e?.node?.namespace || ""), type: String(e?.node?.type || ""),
        value: String(e?.node?.value ?? ""),
      }));
      const byId = new Map(mfs.map((f: any) => [f.id, f]));
      const plan = planEchoes(html, mfs, was, now, String(d?.product?.title || ""),
                              url.searchParams.get("correcting") === "1");
      const writes = plan.mfUpdates.map(u => {
        const f: any = byId.get(u.id);
        return f ? { namespace: f.namespace, key: f.key, type: f.type, value: u.value } : null;
      }).filter(Boolean) as any[];
      const out: Record<string, unknown> = {
        store: st, sku, title: d?.product?.title,
        was, now, specRows: plan.cellHits, metafields: writes.length,
        alsoUpdated: plan.echoes, stillSays: plan.stillSays,
        applied: false,
      };
      if (url.searchParams.get("apply") === "1") {
        if (plan.cellHits) {
          const r1 = await shopifyGql(shop, token, `
            mutation($input: ProductInput!) {
              productUpdate(input: $input) { userErrors { field message } }
            }`, { input: { id: productId, descriptionHtml: plan.html } });
          out.descriptionErrors = r1?.productUpdate?.userErrors || [];
        }
        if (writes.length) {
          const r2 = await shopifyGql(shop, token, `
            mutation($mf: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $mf) { userErrors { field message } }
            }`, { mf: writes.map(w => ({ ownerId: productId, ...w })) });
          out.metafieldErrors = r2?.metafieldsSet?.userErrors || [];
        }
        out.applied = true;
      }
      return json(out);
    }

    // --- WHAT SHOPIFY WILL ACTUALLY ACCEPT FOR A METAFIELD WRITE -------------
    // ?mfschema=1&store=OVL&secret= — introspection, writes nothing.
    //
    // Here because the metafield half of an approve failed on the first real one
    // and a swallowed error tells nobody WHY. `MetafieldsSetInput` identifies a
    // metafield by ownerId + namespace + key, and whether it also takes an `id`
    // has changed between API versions — which is exactly the kind of thing to
    // ask the API rather than remember.
    if (url.searchParams.get("mfschema")) {
      if (url.searchParams.get("secret") !== SECRET) return json({ error: "forbidden" }, 403);
      const st = (url.searchParams.get("store") || "OVL").toUpperCase();
      const { shop, token } = await shopFor(st);
      const d = await shopifyGql(shop, token,
        `{ __type(name: "MetafieldsSetInput") { inputFields {
             name type { kind name ofType { kind name } } } } }`);
      return json({ apiVersion: SHOPIFY_API_VERSION, shop,
                    inputFields: (d?.__type?.inputFields || []).map((f: any) => ({
                      name: f.name,
                      type: f.type?.name || f.type?.ofType?.name,
                      required: f.type?.kind === "NON_NULL",
                    })) });
    }

    // --- what the spec echoes would do, over the whole queue ----------------
    if (url.searchParams.get("echoes")) {
      if (url.searchParams.get("secret") !== SECRET) {
        return json({ error: "forbidden" }, 403);
      }
      const asked = (url.searchParams.get("store") || "").toUpperCase();
      const list = asked === "ALL" ? STORES : STORES.includes(asked) ? [asked] : [];
      if (!list.length) return json({ error: "store required" }, 400);
      const limit = Math.min(Number(url.searchParams.get("limit") || 300), 1000);
      const out = [];
      for (const st of list) out.push(await echoSweep(st, limit));
      return json({ stores: out });
    }

    // ?nouns=1&store=ALL&secret=[&limit=400][&offset=0] — READ-ONLY CENSUS
    // behind the missing-noun check. It answers one question: when the tool says
    // "the title never says what the item IS" and then offers no fix, IS THE
    // WORD SITTING IN THE LISTING ALL ALONG? `Collection` is the DEPARTMENT
    // ("Computer Part") and is deliberately barred as a suggestion;
    // `Sub-Collection` is the SHELF ("CPU & Motherboard Combos"), and the shelf
    // is where PayMore keeps the product word. This prints the whole
    // Sub-Collection vocabulary per store so that answer is measured across five
    // catalogues rather than inferred from the one row that raised the question.
    // --- the same ask, dry, without a PIN -----------------------------------
    // ?feedback=1&store=OVL,LEE&secret=[&days=]  — READ ONLY, and deliberately
    // separate from ?view=feedback: the panel route is what a reviewer presses
    // and it STAMPS the notes as read afterwards. This one never writes, so the
    // gathering half can be dry-run against live data the way every other half
    // of this function was measured before it was allowed near a catalogue.
    if (url.searchParams.get("feedback")) {
      if (url.searchParams.get("secret") !== SECRET) {
        return json({ error: "forbidden" }, 403);
      }
      const asked = (url.searchParams.get("store") || "").toUpperCase();
      const stores = asked && asked !== "ALL"
        ? asked.split(",").map(x => x.trim()).filter(Boolean)
        : ["OVL", "LEE", "WSP", "MPL", "BAL"];
      const days = Math.min(Math.max(Number(url.searchParams.get("days") || 30), 1), 180);
      const fb = await feedbackFor(stores, days);
      // &text=1 prints the ask itself rather than the JSON around it, which is
      // the whole thing being checked.
      if (url.searchParams.get("text")) {
        return new Response(buildAsk(fb),
          { headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } });
      }
      return json({ ...fb, ask: buildAsk(fb) });
    }

    if (url.searchParams.get("nouns")) {
      if (url.searchParams.get("secret") !== SECRET) {
        return json({ error: "forbidden" }, 403);
      }
      const asked = (url.searchParams.get("store") || "").toUpperCase();
      const list = asked === "ALL" ? STORES : STORES.includes(asked) ? [asked] : [];
      if (!list.length) return json({ error: "store required" }, 400);
      // ⚠️ Bounded on purpose. OVL alone is 1376 products = 56 Shopify calls at
      // CHUNK 25, and the runtime kills a request long before the catalogue ends.
      // Page it with &offset= rather than raising this.
      const limit = Math.min(Number(url.searchParams.get("limit") || 400), 600);
      const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
      const out = [];
      for (const st of list) {
        const cat: any[] = await rows(
          `ebay_catalog?store_code=eq.${st}&select=sku,product_id,title`
          + `&order=sku&limit=${limit}&offset=${offset}`);
        const { shop, token } = await shopFor(st);
        const ids = [...new Set(cat.map(c => String(c.product_id)).filter(Boolean))];
        const extras = await extrasFor(shop, token, ids);
        const vocab: Record<string, number> = {};
        const flagged: any[] = [];
        for (const c of cat) {
          const e = extras[String(c.product_id)];
          const sub = String(e?.specs?.["Sub-Collection"] || "").trim();
          if (sub) vocab[sub] = (vocab[sub] || 0) + 1;
          // The REAL analyser, on the rules basis — a census that reimplemented
          // the predicate would measure something the product does not do.
          const a = analyse({
            store_code: st, product_id: String(c.product_id), sku: String(c.sku),
            title: String(c.title || ""), product_handle: null, price: null,
            quantity: 0,
          } as Row, e, null, null);
          const f = a.findings.find(x => x.code === "missing-noun");
          if (!f) continue;
          flagged.push({
            sku: c.sku, title: c.title, severity: f.severity, fixable: f.fixable,
            suggested: a.suggested,
            collection: String(e?.specs?.["Collection"] || ""),
            sub, type: String(e?.specs?.["Type"] || ""),
          });
        }
        out.push({
          store: st, examined: cat.length,
          missingNoun: flagged.length,
          noFixOffered: flagged.filter(f => !f.fixable).length,
          subCollectionKnown: Object.values(vocab).reduce((a, b) => a + b, 0),
          subCollections: Object.entries(vocab).sort((a, b) => b[1] - a[1])
            .map(([v, n]) => `${n} x ${v}`),
          flagged,
        });
      }
      return json({ stores: out });
    }

    if (url.searchParams.get("peek")) {
      if (url.searchParams.get("secret") !== SECRET) {
        return json({ error: "forbidden" }, 403);
      }
      const store = (url.searchParams.get("store") || "").toUpperCase();
      const sku = url.searchParams.get("sku") || "";
      const cat: any[] = await rows(
        `ebay_catalog?store_code=eq.${store}&sku=eq.${encodeURIComponent(sku)}`
        + `&select=store_code,sku,product_id,title,price,quantity&limit=1`);
      if (!cat[0]) return json({ error: `no catalog row for ${store} ${sku}` }, 404);
      const { shop, token } = await shopFor(store);
      const extras = await extrasFor(shop, token, [cat[0].product_id]);
      const e = extras[cat[0].product_id];
      // ?peek=…&raw=1 — the metafields and the description verbatim, which
      // extrasFor deliberately throws away (it keeps only what the analyser
      // needs). This is the view for "where else does this value live", which
      // is a different question from "what does the analyser think".
      //
      // ?peek=…&echo=<a title> — WHAT APPROVING THAT TITLE WOULD REWRITE in the
      // rest of the listing, and what it would leave saying the old thing.
      // Reads only: it runs the same planEchoes the approve runs and prints the
      // plan. Dry running is how every other half of this tool was measured
      // before it was allowed near a live catalogue, and the spec echoes are the
      // half that writes to the description a customer reads.
      let rawMf: Record<string, string> | null = null;
      let rawDesc = "";
      let echoPlan: Record<string, unknown> | null = null;
      const wantEcho = (url.searchParams.get("echo") || "").trim();
      if (url.searchParams.get("raw") || wantEcho) {
        const d = await shopifyGql(shop, token,
          `query($id: ID!) { product(id: $id) { descriptionHtml
             metafields(first: 60) { edges { node { id namespace key type value } } } } }`,
          { id: cat[0].product_id });
        const html = String(d?.product?.descriptionHtml || "");
        const mfs: { id: string; key: string; value: string }[] = [];
        rawMf = {};
        for (const eg of (d?.product?.metafields?.edges || [])) {
          const n = eg?.node; if (!n) continue;
          rawMf[`${n.namespace}.${n.key} (${n.type})`] = String(n.value ?? "").slice(0, 600);
          if (n.id) mfs.push({ id: String(n.id), key: String(n.key || ""),
                               value: String(n.value ?? "") });
        }
        if (url.searchParams.get("raw")) rawDesc = html;
        if (wantEcho) {
          const cur = String(cat[0].title || "");
          const run = titleRun(cur, wantEcho);
          const plan = planEchoes(html, mfs, run.was, run.now, wantEcho,
            url.searchParams.get("correcting") === "1"
              || isCorrecting(analyse({
                   store_code: store, product_id: cat[0].product_id, sku: cat[0].sku,
                   title: cur, product_handle: null,
                   price: cat[0].price == null ? null : Number(cat[0].price),
                   quantity: cat[0].quantity || 0, wantNames: true,
                 }, e, null, null, null, null).findings));
          echoPlan = {
            from: cur, to: wantEcho, run,
            alsoUpdated: plan.echoes,
            stillSays: plan.stillSays,
            specRows: plan.cellHits,
            metafields: plan.mfUpdates.length,
            // The bytes that would change in the description, so a splice can be
            // read rather than trusted.
            descriptionDiff: plan.cellHits
              ? htmlDelta(html, plan.html) : null,
          };
        }
      }
      // &market=1 exercises the eBay half for ONE item, which the sweep cannot
      // be aimed at (it walks oldest-swept-first by design). This is how the
      // model-not-found check gets tested against a known-bad title rather than
      // against whatever happened to be at the head of the queue.
      const wantMkt = url.searchParams.get("market") === "1";
      let modelReal: boolean | null = null;
      let modelExample: string | null = null;
      let brandReal: boolean | null = null;
      const probe: Record<string, unknown> = {};
      if (wantMkt) {
        const browse = await browseFor(store);
        const ownRows: any[] = await rows(
          `ebay_live?store_code=eq.${store}&select=item_id`);
        const ownIds = new Set<string>(
          ownRows.map((r: any) => String(r.item_id || "")).filter(Boolean));
        const sm = specModel(e?.specs);
        const title = cat[0].title || "";
        if (!sm) {
          probe.skipped = "no Brand + Model in the Shopify spec table, so nothing to ask about";
        } else {
          brandReal = await brandIsReal(sm.brand, browse, ownIds, title);
          const v = await modelIsReal(sm.brand, sm.model, browse, ownIds, title);
          modelReal = v.real; modelExample = v.example;
          // Every rung of the broadening ladder, so a verdict can be argued with
          // rather than just believed.
          const ladder: unknown[] = [];
          const parts = sm.model.trim().split(/\s+/);
          for (let take = parts.length; take >= 1; take--) {
            const q = `${sm.brand} ${parts.slice(0, take).join(" ")}`.trim();
            const hits = await browse(q, undefined, 20);
            const others = hits === null ? [] : otherSellers(hits, ownIds, title);
            ladder.push({ q, hits: hits === null ? "could not ask" : hits.length,
                          others: others.length,
                          enough: others.length >= MODEL_MIN_CORPUS,
                          named: others.length ? modelNamed(sm.model, others) : null,
                          sample: others.slice(0, 3).map((h: any) => String(h?.title || "").slice(0, 70)) });
            if (others.length >= MODEL_MIN_CORPUS) break;
          }
          probe[`${sm.brand} ${sm.model}`] = { modelVerdict: modelReal, brandVerdict: brandReal, ladder };
        }
      }
      return json({
        store, sku, title: cat[0].title,
        ...(rawMf && rawDesc ? { metafields: rawMf, descriptionHtml: rawDesc } : rawMf && !wantEcho ? { metafields: rawMf } : {}),
        ...(echoPlan ? { echo: echoPlan } : {}),
        specKeys: Object.keys(e?.specs || {}),
        specs: e?.specs || {},
        included: e?.included || [],
        ...(wantMkt ? { modelProbe: probe } : {}),
        analysis: analyse({
          store_code: store, product_id: cat[0].product_id, sku: cat[0].sku,
          title: cat[0].title || "", product_handle: null,
          price: cat[0].price == null ? null : Number(cat[0].price),
          quantity: cat[0].quantity || 0,
          // peek is the investigation route, so the name checks always report
          // here — that is what it is for.
          wantNames: true,
        }, e, null, modelReal, modelExample, brandReal),
      });
    }

    // --- the sweep ----------------------------------------------------------
    // DRY RUN IS THE DEFAULT. `save=1` writes queue rows and needs the secret;
    // no path here ever writes a listing.
    if (url.searchParams.get("sweep")) {
      const save = url.searchParams.get("save") === "1";
      if (save && url.searchParams.get("secret") !== SECRET) {
        return json({ error: "forbidden", detail: "saving the queue needs the sweep secret" }, 403);
      }
      const asked = (url.searchParams.get("store") || "").toUpperCase();
      const list = asked === "ALL" ? STORES : STORES.includes(asked) ? [asked] : [];
      if (!list.length) {
        return json({ error: "store required", detail: `one of ${STORES.join(", ")}, or ALL` }, 400);
      }
      // The biggest store holds 798 in-scope products and a rules-only pass over
      // 400 of them takes ~6 seconds, so a cap that cannot cover one store in one
      // run only means half a store is always out of date for no saving. 1500
      // leaves room for growth and is still well inside the function's wall.
      // (market=1 is far slower — a Browse call per model — so a cron using it
      // should pass a small limit explicitly.)
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 60, 1), 1500);
      // ⚠️ THE MARKET PASS CANNOT COVER A WHOLE STORE IN ONE REQUEST, and letting
      // it try is worse than refusing: the edge runtime cuts the response at 150
      // seconds while the function KEEPS EXECUTING, so the caller sees
      // IDLE_TIMEOUT and has no idea how much was saved. `market=1&limit=1200`
      // did exactly that here — a run that looked like it had covered 798 items
      // and had not. A rules pass over 798 takes ~10s; the market pass makes up
      // to three Browse calls per distinct model, which is the whole difference.
      //
      // So the limit is CLAMPED and the clamp is REPORTED. The sweep walks
      // oldest-swept-first, so repeated small market runs still cover the estate
      // — that is the intended way to use it.
      const MARKET_MAX = 120;
      const market = url.searchParams.get("market") === "1";
      // ⚠️ THE ONLY PASS THAT SPENDS MONEY. Capped for the same reason market=1
      // is — the 150s wall truncates the RESPONSE while the function keeps
      // running, so an over-long run reports a timeout and nobody can tell how
      // much was saved or how much was billed.
      const llm = url.searchParams.get("llm") === "1";
      const used = llm ? Math.min(limit, NAME_MAX)
                 : market ? Math.min(limit, MARKET_MAX) : limit;
      const clamped = used !== limit;
      // Opt-in, and only meaningful with market=1 since both verdicts come from
      // eBay. See the block in analyse() for the five measured designs and why
      // this is not on.
      const names = url.searchParams.get("names") === "1";
      const out = [];
      for (const s of list) out.push(await sweep(s, used, market, save, names && market, llm));
      return json({
        ok: true, market, llm, saved: save, limit: used,
        nameChecks: (url.searchParams.get("names") === "1" && market)
          ? "ON — brand/model name checks are opt-in and LOW PRECISION; see analyse() in the source"
          : "off (default)",
        // Said out loud. A silently reduced limit reads as full coverage, which
        // is the same class of lie as a queue that stops refreshing.
        ...(clamped ? { limitClamped: llm
          ? `llm=1 is capped at ${NAME_MAX} listings per store per run so the request finishes inside the 150s function limit; asked for ${limit}. Run it again to walk further — the name pass takes only listings whose exact title it has never been shown, so repeated runs move forward and a finished store returns 0 examined.`
          : `market=1 is capped at ${MARKET_MAX} items per store per run so the request finishes inside the 150s function limit; asked for ${limit}. Run it again to walk further — the sweep takes the least-recently-checked items first.` } : {}),
        stores: out,
      });
    }

    return json({ error: "nothing to do",
                  detail: "try ?view=review&store=OVL, ?view=counts, or ?sweep=1&store=OVL" }, 400);
  } catch (e) {
    return json({ error: "failed", detail: String(e).slice(0, 600) }, 500);
  }
});
