// ============================================================================
// dupe-delete-verify — did deleting the duplicate Shopify orders actually leave
// things in the right state?
//
//   ?secret=<ops>
//
// READ-ONLY everywhere: Shopify reads, eBay reads through a URL-anchored GET,
// nothing written.
//
// WHY THIS EXISTS: PayMore's advice was to DELETE the duplicate order rather
// than refund it (2026-08-26). That avoids the refund-propagation risk entirely,
// which is the right call — but deletion is not a quieter refund, it behaves
// differently in three places, and each is checked here:
//
//   1. THE DUPLICATE IS GONE, THE ORIGINAL IS NOT. Two orders with near-adjacent
//      numbers; deleting the wrong one destroys a real sale with no undo.
//   2. EBAY NEVER MOVED. The whole point of deleting instead of refunding. If a
//      refund shows up on any of these, deletion propagates too and every
//      remaining duplicate has to be handled another way.
//   3. STOCK. A Shopify refund can restock; a DELETE does not, and it also
//      never restocks. The duplicate consumed a unit that was never really
//      sold twice, so the on-hand figure has to be read rather than assumed.
//
// The six pairs are pinned below rather than re-derived: after a delete they
// cannot be found by scanning any more, and this has to check exactly what was
// reported, not whatever a fresh scan happens to return.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";

const HOSTS: Record<string, string> = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};

const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};

// EBAY_APPS is a hand-pasted JSON secret and has carried literal line breaks.
const stripControl = (s: string) =>
  Array.from(s).filter((ch) => ch.charCodeAt(0) >= 32).join("");
let EBAY_APPS: Record<string, any> = {};
{
  const raw = (Deno.env.get("EBAY_APPS") || "").trim();
  for (const text of [raw, stripControl(raw)]) {
    if (!text) break;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") { EBAY_APPS = parsed; break; }
    } catch { /* try the stripped form */ }
  }
}

// The state as reported by dupe-open-pairs at 2026-08-26 20:0x UTC, before any
// deletion. `duplicate` is the new-MC copy; `original` is the SPEEKS Connect
// sale that must survive.
const PAIRS = [
  { store: "WSP", ebay: "27-15032-84938", original: "6664..", originalName: "#MO02-6711",
    duplicateName: "#MO02-6816", sku: "MO02-4566A-E10", value: 499.99 },
  { store: "WSP", ebay: "17-15045-45436", original: "", originalName: "#MO02-6679",
    duplicateName: "#MO02-6809", sku: "MO02-4627A-E2", value: 249.99 },
  { store: "WSP", ebay: "10-15054-91821", original: "", originalName: "#MO02-6665",
    duplicateName: "#MO02-6802", sku: "MO02-4544B-E5", value: 129.99 },
  { store: "WSP", ebay: "27-15021-64472", original: "", originalName: "#MO02-6646",
    duplicateName: "#MO02-6801", sku: "MO02-4612B-E8", value: 74.99 },
  { store: "MPL", ebay: "08-15066-43117", original: "", originalName: "#MO03-2982",
    duplicateName: "#MO03-3089", sku: "MO03-2501A-R3R3", value: 799.99 },
  { store: "MPL", ebay: "04-15073-35798", original: "", originalName: "#MO03-2978",
    duplicateName: "#MO03-3088", sku: "MO03-2590A-E10", value: 439.99 },
];

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${path}: ${r.status}`);
  return await r.json();
}

// --- the only door to eBay ---------------------------------------------------
const ORDER_URL_RE = /^https:\/\/api(?:\.sandbox)?\.ebay\.com\/sell\/fulfillment\/v1\/order\/[^/]+$/;

async function ebayGet(url: string, token: string): Promise<Response> {
  // A trailing path segment is what turns a read into issue_refund, so the
  // pattern is anchored: exactly one order id and nothing after it.
  if (!ORDER_URL_RE.test(url)) throw new Error(`refused: not a read-only eBay order URL -> ${url}`);
  return await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

async function mintToken(row: any): Promise<string> {
  const creds = EBAY_APPS[row.store_code];
  if (!creds) throw new Error(`no EBAY_APPS entry for ${row.store_code}`);
  const host = HOSTS[row.environment as string] || HOSTS.production;
  const res = await fetch(`${host}/identity/v1/oauth2/token`, {
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
  let tok: any = null;
  try { tok = JSON.parse(text); } catch { /* reported below */ }
  if (!tok?.access_token) {
    // An expired refresh token returns 400 here. A 401 further down would read
    // as "no refund found", which is the most dangerous way this can fail.
    throw new Error(`token refresh failed for ${row.store_code}: ${res.status} ${text.slice(0, 200)}`);
  }
  return tok.access_token;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  const tokRows = await sbGet(`shopify_stores?select=shop,store_code,access_token`);
  const ebayRows = await sbGet(`ebay_stores?select=store_code,environment,refresh_token,scopes`);

  const shopFor = (store: string) => {
    const shop = SHOP_BY_STORE[store];
    const t = tokRows.find((x: any) => x.store_code === store)
      || tokRows.find((x: any) => x.shop === shop);
    return { shop, token: t?.access_token as string | undefined };
  };

  async function gql(store: string, query: string, variables: unknown = {}) {
    const { shop, token } = shopFor(store);
    if (!token) throw new Error(`no shopify token for ${store}`);
    const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    const body = await r.json().catch(() => null);
    if (!body) throw new Error(`Shopify non-JSON (HTTP ${r.status})`);
    if (body.errors?.length) throw new Error(JSON.stringify(body.errors).slice(0, 300));
    return body;
  }

  // One eBay token per store, minted once.
  const ebayTokens: Record<string, string> = {};
  const ebayTokenErrors: Record<string, string> = {};
  for (const store of [...new Set(PAIRS.map((p) => p.store))]) {
    const row = ebayRows.find((r: any) => r.store_code === store);
    if (!row) { ebayTokenErrors[store] = "no ebay_stores row"; continue; }
    try { ebayTokens[store] = await mintToken(row); }
    catch (e) { ebayTokenErrors[store] = String(e); }
  }

  const results: any[] = [];

  for (const p of PAIRS) {
    const row: any = {
      store: p.store, ebay_order_id: p.ebay, sku: p.sku, value: p.value,
      original_order: p.originalName, duplicate_order: p.duplicateName,
    };

    // --- 1 + 2: which copies still exist, by NAME ---------------------------
    // Searched by name rather than by the stored id: a deleted order's id
    // resolves to null, which is indistinguishable from a bad id. A name search
    // returning nothing is a positive statement that the order is not there.
    try {
      const b = await gql(p.store,
        `query($q: String!) {
           orders(first: 10, query: $q) {
             edges { node {
               id name createdAt cancelledAt
               displayFinancialStatus displayFulfillmentStatus
               app { name }
               totalPriceSet { shopMoney { amount } }
               totalRefundedSet { shopMoney { amount } }
             } }
           }
         }`, { q: `name:${p.originalName.replace(/^#/, "")}` });
      const hits = (b.data.orders.edges || []).map((e: any) => e.node)
        .filter((o: any) => o.name === p.originalName || o.name === p.duplicateName);
      const orig = hits.find((o: any) => o.name === p.originalName);
      const dup = hits.find((o: any) => o.name === p.duplicateName);

      row.original_still_there = !!orig;
      row.duplicate_deleted = !dup;
      row.original_state = orig
        ? {
          financial: orig.displayFinancialStatus,
          fulfillment: orig.displayFulfillmentStatus,
          app: orig.app?.name ?? null,
          total: r2(num(orig.totalPriceSet?.shopMoney?.amount)),
          refunded: r2(num(orig.totalRefundedSet?.shopMoney?.amount)),
          cancelled: !!orig.cancelledAt,
        }
        : null;
    } catch (e) {
      row.shopify_error = String(e);
    }

    // --- 3: stock ------------------------------------------------------------
    try {
      const b = await gql(p.store,
        `query($q: String!) {
           productVariants(first: 5, query: $q) {
             edges { node { sku inventoryQuantity product { title status } } }
           }
         }`, { q: `sku:${p.sku}` });
      const v = (b.data.productVariants.edges || [])
        .map((e: any) => e.node).find((x: any) => x.sku === p.sku);
      row.stock_now = v ? v.inventoryQuantity : null;
      row.product_status = v?.product?.status ?? null;
    } catch (e) {
      row.stock_error = String(e);
    }

    // --- the one that matters: did eBay move? -------------------------------
    const tok = ebayTokens[p.store];
    if (!tok) {
      row.ebay_error = ebayTokenErrors[p.store] || "no token";
    } else {
      try {
        const res = await ebayGet(
          `${HOSTS.production}/sell/fulfillment/v1/order/${encodeURIComponent(p.ebay)}`, tok);
        if (!res.ok) {
          row.ebay_error = `HTTP ${res.status}`;
        } else {
          const o = await res.json();
          const refunds = o?.paymentSummary?.refunds || [];
          row.ebay_payment_status = o?.orderPaymentStatus ?? null;
          row.ebay_refund_total = r2(refunds.reduce(
            (a: number, x: any) => a + num(x?.amount?.value), 0));
          row.ebay_refunded = row.ebay_refund_total > 0;
          row.ebay_cancel_state = o?.cancelStatus?.cancelState ?? null;
          row.ebay_due_seller = r2(num(o?.paymentSummary?.totalDueSeller?.value));
        }
      } catch (e) {
        row.ebay_error = String(e);
      }
    }

    results.push(row);
  }

  const clean = results.filter((r) =>
    r.duplicate_deleted && r.original_still_there && r.ebay_refunded === false);
  const propagated = results.filter((r) => r.ebay_refunded === true);
  const wrongCopy = results.filter((r) => r.original_still_there === false);
  const negativeStock = results.filter((r) => typeof r.stock_now === "number" && r.stock_now < 0);

  return json({
    checked_at: new Date().toISOString(),
    readOnly: "Shopify and eBay reads only; nothing written",
    verdict: propagated.length
      ? "⚠️ EBAY MOVED ON " + propagated.length
        + " OF THESE — deleting propagates too; stop and re-plan the rest"
      : wrongCopy.length
      ? "⚠️ AN ORIGINAL SALE IS MISSING — the wrong copy was deleted on "
        + wrongCopy.length + " pair(s)"
      : clean.length === PAIRS.length
      ? "Clean: every duplicate is gone, every original survived, and eBay did not move"
      : "Incomplete — see rows",
    totals: {
      pairs_checked: PAIRS.length,
      duplicates_deleted: results.filter((r) => r.duplicate_deleted).length,
      originals_intact: results.filter((r) => r.original_still_there).length,
      ebay_still_unrefunded: results.filter((r) => r.ebay_refunded === false).length,
      ebay_refunded: propagated.length,
      double_count_removed: r2(results
        .filter((r) => r.duplicate_deleted).reduce((a, r) => a + r.value, 0)),
      skus_at_negative_stock: negativeStock.length,
    },
    // Deletion removes the order from Shopify's reporting as well, so any day
    // figure already published for Aug 25-26 was computed against the larger
    // number and will not agree with a fresh read.
    note_on_reporting:
      "A deleted order leaves Shopify analytics entirely. Sales for the days the "
      + "duplicates were created (Aug 25-26) are now lower than anything reported "
      + "before the deletion.",
    rows: results,
  });
});
