import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// =============================================================================
// fb-lister — the back end of the SPEEKS Marketplace Lister Chrome extension
// =============================================================================
//
// The extension fills in a Facebook Marketplace listing from one of OUR Shopify
// products; a person reviews it and clicks Publish themselves. This function is
// everything the extension knows about the item. READ-ONLY: nothing here writes
// to Shopify, and the only thing it writes in SPEEKSNET is nothing at all.
//
// WHY THIS EXISTS: the store manager's first version scraped the public store
// websites (*.paymore.com). Those are PayMore's, not ours, and they show what
// PayMore's site shows rather than what our Shopify holds. Everything now comes
// from each store's own Shopify admin, using the tokens SPEEKSNET already keeps
// in `shopify_stores` (the same ones ten other functions read — no new Shopify
// app, no new secrets), plus `ebay_catalog` for the store's browsable list.
//
// POST JSON { action, ... }:
//   login   { pin }                  -> { token, name, store, role }
//   me      { token }                -> { name, store, role }
//   catalog { token, store, q? }     -> in-stock, published items for a store
//   item    { token, sku, product_id? } -> everything needed to fill the form
//   status  { token, skus[] (<=200) }-> per SKU: instock / sold / unknown
//
// ── SIGN-IN, and why it is not the website's ────────────────────────────────
// The website checks a PIN in the browser and never gets a server session, so
// there is no "user access token" for an extension to borrow. Here the PIN is
// checked SERVER-SIDE, once, and the extension gets back a signed token
// (HMAC-SHA256, key derived from the service-role key so there is no extra
// secret to set). The token carries a fingerprint of the PIN: change a
// person's PIN, or delete them, and every token they hold stops working on its
// next call. It also expires after 30 days.
//
// Every call re-checks Feature Access ('fb-lister'), so switching the tool off
// for a person or a role in the Feature Access tool cuts the extension off too,
// without waiting for the token to expire. FB_LISTER_DEF below MUST match the
// 'fb-lister' entry's def in FEATURE_CATALOG (speeks.js) — the browser resolves
// the same rule from the same overrides table, and the two must not disagree
// about who has the tool.
//
// DEPLOY WITH --no-verify-jwt: the extension has no Supabase JWT to send.
// =============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FEATURE_KEY = "fb-lister";
const FB_LISTER_DEF = ["ceo", "district-manager", "mocd", "owner-manager", "manager", "assistant-manager"];
const TOKEN_DAYS = 30;
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";
const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
// The store is always the SKU prefix — the same five every other tool uses.
const PREFIX_TO_STORE: Record<string, string> = {
  KS01: "OVL", MO01: "LEE", MO02: "WSP", MO03: "MPL", MO04: "BAL",
};
// Facebook allows 10 photos on an item listing (more on vehicles/rentals only).
const MAX_PHOTOS = 10;

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

class Http extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

// ── token ────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
let _keyP: Promise<CryptoKey> | null = null;
function hmacKey(): Promise<CryptoKey> {
  if (!_keyP) {
    _keyP = (async () => {
      const root = await crypto.subtle.importKey(
        "raw", enc.encode(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
      );
      const derived = await crypto.subtle.sign("HMAC", root, enc.encode("fb-lister-token-v1"));
      return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    })();
  }
  return _keyP;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

async function pinPrint(name: string, pin: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(`fb-lister|${name}|${pin}`));
  return b64url(new Uint8Array(d)).slice(0, 16);
}

async function makeToken(name: string, isTest: boolean, pin: string): Promise<string> {
  const payload = { n: name, t: isTest ? 1 : 0, f: await pinPrint(name, pin), e: Date.now() + TOKEN_DAYS * 864e5 };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

type Who = { name: string; store: string | null; role: string; isTest: boolean };

function roleSlug(role: string): string {
  // Same transform as _b2bRoleClass() in speeks.js, minus the 'role-' prefix.
  return String(role || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().replace(/\s+/g, "-");
}

// user override > role override > built-in default — _featureEffectiveVisible's
// order. A shop-floor board ('store') never gets it: the tool is for a person.
async function allowed(who: Who): Promise<boolean> {
  const slug = roleSlug(who.role);
  if (slug === "store") return false;
  const { data } = await sb.from("feature_overrides")
    .select("subject_type, subject, enabled").eq("feature_key", FEATURE_KEY);
  const rows = data || [];
  const u = rows.find((r: any) => r.subject_type === "user" && r.subject === who.name.trim().toLowerCase());
  if (u) return !!u.enabled;
  const r = rows.find((r: any) => r.subject_type === "role" && r.subject === slug);
  if (r) return !!r.enabled;
  if (FB_LISTER_DEF.includes(slug)) return true;
  return slug === "assistant-manager" && FB_LISTER_DEF.includes("employee");
}

async function verify(token: unknown): Promise<Who> {
  const t = String(token || "");
  const [body, sig] = t.split(".");
  if (!body || !sig) throw new Http(401, "Sign in again.");
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", await hmacKey(), unb64url(sig), enc.encode(body)); } catch { ok = false; }
  if (!ok) throw new Http(401, "Sign in again.");
  let p: any;
  try { p = JSON.parse(new TextDecoder().decode(unb64url(body))); } catch { throw new Http(401, "Sign in again."); }
  if (!p || Date.now() > Number(p.e)) throw new Http(401, "Your sign-in expired. Sign in again.");
  const table = p.t ? "test_users" : "users";
  const { data } = await sb.from(table).select("name, pin, store, role").eq("name", p.n).maybeSingle();
  if (!data || (await pinPrint(data.name, String(data.pin))) !== p.f) {
    throw new Http(401, "Your PIN changed or your account was removed. Sign in again.");
  }
  const who: Who = { name: data.name, store: data.store || null, role: data.role || "", isTest: !!p.t };
  if (!(await allowed(who))) throw new Http(403, "The Marketplace Lister isn't switched on for you in SPEEKSNET.");
  return who;
}

// A 4-digit PIN is a small space. This is a per-isolate brake, not a lock —
// enough to make a scripted sweep slow and noisy rather than instant.
const _fails = new Map<string, { n: number; at: number }>();
function brake(ip: string) {
  const f = _fails.get(ip);
  if (f && f.n >= 8 && Date.now() - f.at < 10 * 60e3) {
    throw new Http(429, "Too many wrong PINs. Wait ten minutes and try again.");
  }
}
function failed(ip: string) {
  const f = _fails.get(ip);
  const fresh = !f || Date.now() - f.at > 10 * 60e3;
  _fails.set(ip, { n: fresh ? 1 : f!.n + 1, at: Date.now() });
}

// ── Shopify ──────────────────────────────────────────────────────────────────

type Shop = { shop: string; token: string };
// shopify_stores.store_code is NULL on every row (checked 2026-11-13) — the
// rows are keyed by shop domain, and every other function carries this same
// map (claims-disputes, dup-cleanup, cogs-restock-probe…). store_code wins if
// it is ever filled in.
const SHOP_TO_STORE: Record<string, string> = {
  "paymore-overland-park.myshopify.com": "OVL",
  "paymore-lees-summit.myshopify.com": "LEE",
  "paymore-westport.myshopify.com": "WSP",
  "paymore-maplewood.myshopify.com": "MPL",
  "paymore-ballwin.myshopify.com": "BAL",
};
let _shops: Promise<Record<string, Shop>> | null = null;
function shops(): Promise<Record<string, Shop>> {
  if (!_shops) {
    _shops = (async () => {
      const { data, error } = await sb.from("shopify_stores").select("shop, store_code, access_token");
      if (error) { _shops = null; throw new Http(500, "Couldn't read the store connections."); }
      const out: Record<string, Shop> = {};
      for (const r of data || []) {
        const code = r.store_code || SHOP_TO_STORE[String(r.shop || "").toLowerCase()];
        if (code && r.access_token) out[code] = { shop: r.shop, token: r.access_token };
      }
      return out;
    })();
  }
  return _shops;
}

async function gql(store: string, query: string, variables: Record<string, unknown> = {}) {
  const s = (await shops())[store];
  if (!s) throw new Http(500, `SPEEKSNET has no Shopify connection for ${store}.`);
  const r = await fetch(`https://${s.shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": s.token },
    body: JSON.stringify({ query, variables }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok || out.errors) {
    console.error("shopify", store, r.status, JSON.stringify(out.errors || out).slice(0, 500));
    throw new Http(502, `${store}'s Shopify didn't answer properly (HTTP ${r.status}).`);
  }
  return out.data;
}

function storeOfSku(sku: string): string | null {
  return PREFIX_TO_STORE[String(sku).trim().toUpperCase().split("-")[0]] || null;
}

// Shopify's sku: search is not strictly exact, so every hit is re-checked for
// an exact (case-insensitive) SKU match before it counts.
function skuQuery(skus: string[]): string {
  return skus.map((s) => `sku:"${s.replace(/["\\]/g, "")}"`).join(" OR ");
}

function htmlToText(html: string): string {
  return String(html || "")
    // The Specifications table: one "Label: value" line per row. Cells hold
    // their own <p>s, so flatten each cell to one line before joining them.
    .replace(/<t([dh])[^>]*>([\s\S]*?)<\/t\1\s*>/gi, (_m, k, inner) =>
      `<t${k}>${inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}</t${k}>`)
    .replace(/<\/\s*t[dh]\s*>\s*<\s*t[dh][^>]*>/gi, ": ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    .replace(/<\/\s*(p|div|h[1-6]|li|tr|ul|ol)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    // Shopify descriptions carry the template's indentation; Facebook shows it.
    .split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
}

// Our condition words → Facebook's four. Kept here, not in the extension, so a
// mapping fix ships with a deploy instead of a new zip on every computer.
function fbCondition(c: string | null): string | null {
  const s = String(c || "").toLowerCase();
  if (!s) return null;
  if (s === "new") return "New";
  if (/flawless|like new|near mint|mint/.test(s)) return "Used - Like New";
  if (/very good|good|used|lightly/.test(s)) return "Used - Good";
  if (/acceptable|fair|moderately|heavily|poor|cosmetic|broken|parts/.test(s)) return "Used - Fair";
  return null;
}

// ── actions ──────────────────────────────────────────────────────────────────

async function login(pin: unknown, ip: string) {
  brake(ip);
  const p = String(pin || "").trim();
  if (!/^\d{4,8}$/.test(p)) { failed(ip); throw new Http(400, "Enter your SPEEKSNET PIN."); }
  let row: any = null, isTest = false;
  const { data: u } = await sb.from("users").select("name, pin, store, role").eq("pin", p).limit(2);
  if (u && u.length === 1) row = u[0];
  if (!row) {
    const { data: t } = await sb.from("test_users").select("name, pin, store, role").eq("pin", p).limit(2);
    if (t && t.length === 1) { row = t[0]; isTest = true; }
  }
  if (!row) { failed(ip); throw new Http(401, "That PIN didn't match anyone."); }
  const who: Who = { name: row.name, store: row.store || null, role: row.role || "", isTest };
  if (!(await allowed(who))) throw new Http(403, "The Marketplace Lister isn't switched on for you in SPEEKSNET. Ask your DM.");
  return { token: await makeToken(row.name, isTest, p), name: who.name, store: homeStore(who), role: who.role };
}

function homeStore(who: Who): string | null {
  const s = String(who.store || "").toUpperCase();
  return STORES.includes(s) ? s : null;
}

async function catalog(store: unknown, q: unknown) {
  const st = String(store || "").toUpperCase();
  if (!STORES.includes(st)) throw new Http(400, "Pick a store.");
  const term = String(q || "").trim().toLowerCase();
  // PostgREST stops at 1,000 rows whatever limit= says — page it.
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("ebay_catalog")
      .select("sku, product_id, title, price, quantity, condition, image_count, product_handle, collections, product_created_at")
      .eq("store_code", st).gt("quantity", 0).eq("online_published", true)
      .order("product_created_at", { ascending: false })
      .range(from, from + 999);
    if (error) throw new Http(500, "Couldn't read the catalog.");
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const items = rows
    .filter((r) => !term || `${r.title} ${r.sku}`.toLowerCase().includes(term))
    .map((r) => ({
      sku: r.sku, product_id: r.product_id, title: r.title, price: r.price, quantity: r.quantity,
      condition: r.condition, photos: r.image_count, handle: r.product_handle,
      collections: r.collections || [], added: r.product_created_at,
    }));
  return { store: st, count: items.length, items };
}

const ITEM_Q = `query($q: String!) {
  productVariants(first: 20, query: $q) {
    nodes {
      sku price inventoryQuantity
      product {
        id legacyResourceId title handle status descriptionHtml onlineStoreUrl
        media(first: 20) { nodes { ... on MediaImage { image { url width height } } } }
      }
    }
  }
}`;

async function item(sku: unknown, productId: unknown) {
  const s = String(sku || "").trim();
  const store = storeOfSku(s);
  if (!store) throw new Http(400, "That SKU doesn't start with one of our store prefixes.");
  const data = await gql(store, ITEM_Q, { q: skuQuery([s]) });
  const hits = (data?.productVariants?.nodes || [])
    .filter((v: any) => String(v.sku || "").toUpperCase() === s.toUpperCase());
  if (!hits.length) throw new Http(404, `${s} isn't in ${store}'s Shopify.`);

  // BAL reuses one SKU across several products (the -CB1R1 video games). With
  // more than one match and no product_id to pick by, hand back the choices
  // rather than guess — guessing lists the wrong game.
  const pid = String(productId || "").replace(/\D/g, "");
  const picked = pid ? hits.filter((v: any) => String(v.product.legacyResourceId) === pid) : hits;
  if (!picked.length) throw new Http(404, `${s} exists, but not on that product any more.`);
  if (picked.length > 1) {
    return {
      choose: picked.map((v: any) => ({
        sku: v.sku, product_id: String(v.product.legacyResourceId), title: v.product.title,
        price: Number(v.price), quantity: v.inventoryQuantity, status: v.product.status,
      })),
    };
  }
  const v = picked[0], p = v.product;
  const productIdStr = String(p.legacyResourceId);
  const { data: cat } = await sb.from("ebay_catalog")
    .select("condition, collections").eq("store_code", store).eq("sku", v.sku).maybeSingle();
  const photos = (p.media?.nodes || []).map((m: any) => m?.image?.url).filter(Boolean);
  const descriptionText = htmlToText(p.descriptionHtml);
  const condition = cat?.condition || null;

  const warnings: string[] = [];
  if (Number(v.inventoryQuantity) <= 0) warnings.push("Shopify shows 0 in stock — it may already be sold.");
  if (p.status !== "ACTIVE") warnings.push(`The Shopify product is ${String(p.status).toLowerCase()}, not active.`);
  if (!photos.length) warnings.push("No photos on the Shopify product.");
  if (photos.length > MAX_PHOTOS) warnings.push(`${photos.length} photos — Facebook takes the first ${MAX_PHOTOS}.`);
  if (!fbCondition(condition)) warnings.push("No condition on file — pick it on Facebook.");

  return {
    item: {
      store, sku: v.sku, product_id: productIdStr, handle: p.handle, status: p.status,
      title: p.title, price: Number(v.price), quantity: v.inventoryQuantity,
      condition, collections: cat?.collections || [],
      description_html: p.descriptionHtml || "", photos, online_url: p.onlineStoreUrl || null,
    },
    // Exactly what goes into Facebook's form. The extension types these in and
    // stops; a person checks them and clicks Publish.
    fb: {
      title: String(p.title || "").slice(0, 100),
      price: Math.round(Number(v.price) || 0),
      condition: fbCondition(condition),
      description: descriptionText,
      photos: photos.slice(0, MAX_PHOTOS),
    },
    warnings,
  };
}

const STATUS_Q = `query($q: String!) {
  productVariants(first: 100, query: $q) { nodes { sku inventoryQuantity product { status } } }
}`;

async function status(skusIn: unknown) {
  const skus = Array.from(new Set((Array.isArray(skusIn) ? skusIn : []).map((s) => String(s || "").trim()).filter(Boolean)));
  if (!skus.length) return { results: {} };
  if (skus.length > 200) throw new Http(400, "Check 200 SKUs at a time at most.");
  const results: Record<string, { status: string; reason: string; quantity?: number }> = {};
  const byStore: Record<string, string[]> = {};
  for (const s of skus) {
    const st = storeOfSku(s);
    if (!st) { results[s] = { status: "unknown", reason: "Not one of our SKU prefixes." }; continue; }
    (byStore[st] ||= []).push(s);
  }

  // Shopify inventory counts every channel at once — POS, the website and eBay
  // all draw it down — so a 0 here means sold wherever it sold.
  const seen: Record<string, { qty: number; active: boolean }> = {};
  await Promise.all(Object.entries(byStore).map(async ([st, list]) => {
    for (let i = 0; i < list.length; i += 25) {
      const chunk = list.slice(i, i + 25);
      const data = await gql(st, STATUS_Q, { q: skuQuery(chunk) });
      const want = new Set(chunk.map((s) => s.toUpperCase()));
      for (const v of data?.productVariants?.nodes || []) {
        const k = String(v.sku || "").toUpperCase();
        if (!want.has(k)) continue;
        const cur = seen[k] || { qty: 0, active: false };
        cur.qty += Math.max(0, Number(v.inventoryQuantity) || 0);
        cur.active = cur.active || v.product?.status === "ACTIVE";
        seen[k] = cur;
      }
    }
  }));

  // Not in Shopify at all: if SPEEKSNET has ever seen the SKU, the product was
  // sold and deleted; if it never has, it's a typo or not ours — say unknown.
  const missing = skus.filter((s) => !results[s] && !seen[s.toUpperCase()]);
  const known = new Set<string>();
  if (missing.length) {
    for (const t of ["ebay_catalog", "listing_title_reviews", "ebay_live", "ebay_handover"]) {
      const { data } = await sb.from(t).select("sku").in("sku", missing);
      for (const r of data || []) known.add(String(r.sku).toUpperCase());
    }
  }

  for (const s of skus) {
    if (results[s]) continue;
    const hit = seen[s.toUpperCase()];
    if (hit) {
      if (hit.qty > 0 && hit.active) results[s] = { status: "instock", reason: `${hit.qty} in stock in Shopify.`, quantity: hit.qty };
      else if (hit.qty > 0) results[s] = { status: "unknown", reason: "In stock, but the Shopify product isn't active.", quantity: hit.qty };
      else results[s] = { status: "sold", reason: "0 in stock in Shopify.", quantity: 0 };
    } else if (known.has(s.toUpperCase())) {
      results[s] = { status: "sold", reason: "No longer in Shopify; SPEEKSNET has it on record." };
    } else {
      results[s] = { status: "unknown", reason: "Not in Shopify and never seen by SPEEKSNET." };
    }
  }
  return { results };
}

// ── entry ────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST only." }, 405);
  try {
    const body = JSON.parse((await req.text()).replace(/^\uFEFF/, "") || "{}");
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "?";
    const action = String(body.action || "");
    if (action === "login") return json({ success: true, ...(await login(body.pin, ip)) });

    const who = await verify(body.token);
    if (action === "me") return json({ success: true, name: who.name, store: homeStore(who), role: who.role });
    if (action === "catalog") return json({ success: true, ...(await catalog(body.store || homeStore(who), body.q)) });
    if (action === "item") return json({ success: true, ...(await item(body.sku, body.product_id)) });
    if (action === "status") return json({ success: true, ...(await status(body.skus)) });
    return json({ success: false, error: "Unknown action." }, 400);
  } catch (e) {
    if (e instanceof Http) return json({ success: false, error: e.message }, e.status);
    console.error(e);
    return json({ success: false, error: "Something went wrong on the SPEEKSNET side." }, 500);
  }
});
