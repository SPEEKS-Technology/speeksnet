// ============================================================================
// ebay-autolist — puts eligible in-stock items onto eBay without being asked.
//
//   ?store=OVL&run=1        list up to auto_list_per_run items
//   ?store=OVL&run=1&dry=1  show exactly who would be picked, change nothing
//
// Marketplace Connect listed every new product automatically. Nothing on our
// side did: PRODUCTS_UPDATE only reprices items already on eBay, so a product
// created today would sit in Shopify forever unless a person typed its SKU into
// the Operations panel. This is the piece that closes that gap.
//
// OFF BY DEFAULT, PER STORE (ebay_stores.auto_list_enabled). OVL alone has 724
// eligible unlisted items; a cron that assumed "on" would push all of them the
// first time it fired, onto an account MC is still managing. Switching it on is
// a decision somebody makes while watching.
//
// ELIGIBILITY, and every rule here is eBay's refusal rather than our taste:
//   in stock                 nothing to sell otherwise
//   not already live         checked against ebay_live, which sees MC's
//                            listings — see the note in ebay-channel
//   has at least one photo    eBay rejects a listing with no picture
//   has a price               nothing to sell it for
//   past its retry backoff    a failure that will fail again should not be
//                             retried every five minutes
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const FN_BASE = `${SUPABASE_URL}/functions/v1`;

// RETRY BACKOFF. The user's rule is "show it and keep retrying" — nothing gets
// silently dropped. But a missing item specific is not fixed by asking eBay
// again a minute later; it is fixed by someone editing the product in Shopify.
// So the gap doubles and then holds at a day: quick enough that a fix lands the
// same shift, slow enough that a permanently broken SKU costs one call a day
// instead of 288.
const BACKOFF_BASE_MIN = 30;
const BACKOFF_MAX_MIN = 24 * 60;

const backoffMinutes = (attempts: number) =>
  Math.min(BACKOFF_MAX_MIN, BACKOFF_BASE_MIN * Math.pow(2, Math.max(0, attempts - 1)));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status, headers: { "Content-Type": "application/json" },
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
  if (!res.ok) throw new Error(`supabase ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

// PostgREST returns at most 1000 rows and does not mention it. See the same
// note in ebay-channel — this is the table that outgrew it first.
const PAGE_ROWS = 1000;
async function allRows(path: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const res = await sb(path, {
      headers: { "Range-Unit": "items", Range: `${from}-${from + PAGE_ROWS - 1}` },
    });
    const page = await res.json();
    out.push(...page);
    if (page.length < PAGE_ROWS || out.length >= 50000) return out;
  }
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

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!opsAuthed(url)) return json({ error: "unauthorised" }, 401);

  const store = (url.searchParams.get("store") || "").toUpperCase().trim();
  if (!store) return json({ error: "pass ?store=OVL" }, 400);
  if (url.searchParams.get("run") !== "1") return json({ error: "pass &run=1" }, 400);

  const dry = url.searchParams.get("dry") === "1";

  const st = (await (await sb(
    `ebay_stores?store_code=eq.${encodeURIComponent(store)}`
    + `&select=auto_list_enabled,auto_list_per_run`)).json())[0];
  if (!st) return json({ store, error: "no ebay_stores row" }, 404);
  if (!st.auto_list_enabled && !dry) {
    // Not an error. The cron runs for every store and most of them are off.
    return json({ store, enabled: false, listed: 0, note: "auto-listing is off for this store" });
  }

  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || st.auto_list_per_run || 8), 50));

  const [catalog, liveRows, mineRows] = await Promise.all([
    allRows(`ebay_catalog?store_code=eq.${encodeURIComponent(store)}&quantity=gt.0`
          + `&select=sku,title,price,quantity,image_count,product_created_at`
          + `&order=product_created_at.desc.nullslast`),
    allRows(`ebay_live?store_code=eq.${encodeURIComponent(store)}&select=sku`),
    allRows(`ebay_listings?store_code=eq.${encodeURIComponent(store)}`
          + `&select=sku,status,attempts,last_attempt_at`),
  ]);

  const live = new Set<string>(liveRows.map((r: any) => r.sku));
  const mine: Record<string, any> = {};
  for (const m of mineRows) mine[m.sku] = m;

  const now = Date.now();
  const skipped = { alreadyLive: 0, noPhoto: 0, noPrice: 0, backoff: 0 };

  const eligible = catalog.filter((c: any) => {
    if (live.has(c.sku)) { skipped.alreadyLive += 1; return false; }
    if (!c.image_count) { skipped.noPhoto += 1; return false; }
    if (!(Number(c.price) > 0)) { skipped.noPrice += 1; return false; }
    const own = mine[c.sku];
    if (own?.last_attempt_at) {
      const due = Date.parse(own.last_attempt_at) + backoffMinutes(own.attempts || 1) * 60000;
      if (now < due) { skipped.backoff += 1; return false; }
    }
    return true;
  });

  // Never tried beats tried-and-failed, and within each group the item that has
  // been sitting longest goes first. A store's oldest stock is the stock most
  // worth getting in front of a buyer.
  eligible.sort((a: any, b: any) => {
    const aTried = mine[a.sku]?.attempts || 0;
    const bTried = mine[b.sku]?.attempts || 0;
    if (aTried !== bTried) return aTried - bTried;
    return Date.parse(a.product_created_at || 0) - Date.parse(b.product_created_at || 0);
  });

  const batch = eligible.slice(0, limit);

  if (dry) {
    return json({
      store, enabled: !!st.auto_list_enabled, dryRun: true,
      eligible: eligible.length, wouldList: batch.length, skipped,
      items: batch.map((c: any) => ({ sku: c.sku, title: c.title, price: c.price, images: c.image_count })),
    });
  }

  const results: any[] = [];
  for (const c of batch) {
    // Sequential on purpose. Each publish is three eBay calls plus a Shopify
    // read, and eBay rate-limits per account — a parallel burst would trade a
    // slightly faster run for failures that look like bugs.
    const res = await fetch(
      `${FN_BASE}/ebay-sync?store=${store}&sku=${encodeURIComponent(c.sku)}&secret=${OPS_SECRET}`,
      { headers: { Authorization: `Bearer ${SERVICE_KEY}` } });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text.slice(0, 400); }

    const ok = res.status < 300 && body?.published;
    await stampAttempt(store, c.sku, mine[c.sku]?.attempts || 0,
      ok ? null : (body?.error ? String(body.error) : `eBay refused with ${res.status}`));

    results.push({
      sku: c.sku, ok,
      listingId: ok ? body?.listingId : null,
      error: ok ? null : String(body?.error || `status ${res.status}`).slice(0, 300),
    });
  }

  // A run that lists nothing because everything failed must not read the same
  // as a run that had nothing to do.
  const listed = results.filter(r => r.ok).length;
  return json({
    store, enabled: true,
    eligible: eligible.length, attempted: results.length, listed,
    failed: results.length - listed,
    remaining: Math.max(0, eligible.length - listed),
    skipped, results,
  });
});

// ebay-sync writes status and last_error itself. attempts and last_attempt_at
// are the backoff's, and they have to be stamped on success too — otherwise a
// SKU that publishes and later ends would come back with a stale attempt count.
async function stampAttempt(store: string, sku: string, was: number, error: string | null) {
  await sb("ebay_listings?on_conflict=store_code,sku", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      store_code: store, sku,
      attempts: Number(was || 0) + 1,
      last_attempt_at: new Date().toISOString(),
      ...(error ? { status: "failed", last_error: error.slice(0, 1000) } : {}),
    }]),
  });
}
