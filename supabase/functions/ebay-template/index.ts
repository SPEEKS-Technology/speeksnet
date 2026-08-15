// ============================================================================
// ebay-template — owns the PayMore branded listing wrapper.
//
//   ?store=OVL&import=1[&item=<legacyItemId>][&dry=1]
//   ?store=OVL&status=1        what we have stored
//   ?store=OVL&raw=1           dump the stored template
//
// Marketplace Connect is Codisto underneath, and Codisto renders every listing
// through a branded wrapper: store banner, nav, gallery, price, warranty copy,
// footer. The Shopify description sits inside it verbatim, in
// <div class="shopify-auto">. So the wrapper can be LEARNED from any live MC
// listing rather than rebuilt by eye — which also means each store imports its
// own before MC is switched off, instead of hardcoding one store's markup.
//
// Deliberately NOT kept: Codisto's "eBay integration by Codisto" footer. Their
// terms require that attribution on listings THEY publish; carrying it on ours
// would be a false claim about who produced the listing.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const HOSTS = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};

const stripControl = (s: string) =>
  Array.from(s).filter(ch => ch.charCodeAt(0) >= 32).join("");

let EBAY_APPS: Record<string, any> = {};
{
  const raw = (Deno.env.get("EBAY_APPS") || "").trim();
  for (const text of [raw, stripControl(raw)]) {
    if (!text) break;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") { EBAY_APPS = parsed; break; }
    } catch { /* try stripped */ }
  }
}

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
  if (!res.ok) throw new Error(`supabase ${path}: ${res.status} ${await res.text()}`);
  return res;
}

async function accessToken(row: any): Promise<string> {
  const expiresAt = row.access_token_expires_at ? Date.parse(row.access_token_expires_at) : 0;
  if (row.access_token && expiresAt - Date.now() > 60000) return row.access_token;
  const creds = EBAY_APPS[row.store_code];
  const res = await fetch(
    `${HOSTS[row.environment as "production" | "sandbox"]}/identity/v1/oauth2/token`, {
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
  const tok = JSON.parse(await res.text());
  if (!tok.access_token) throw new Error("token refresh failed");
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

// --- turning one rendered listing back into a template ----------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Finds the end of the element starting at `start`, counting nested <div>.
function divEnd(html: string, start: number): number {
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

// Counts <div> balance outside <style> and comments. The template must be as
// balanced as the listing it was learned from: {{THUMBNAILS}} and
// {{DESCRIPTION}} both expand to balanced markup, so any drift is damage we
// introduced while parameterising.
function divBalance(html: string): number {
  // No backslash escapes here on purpose: [^] means "any character including
  // newline", and [/] avoids escaping the slash. Keeps the source resilient to
  // being edited through shell heredocs, which silently eat backslashes.
  const strip = html.replace(/<style[^]*?<[/]style>/gi, "").replace(/<!--[^]*?-->/g, "");
  const opens = (strip.match(/<div[ >]/gi) || []).length;
  const closes = (strip.match(/<[/]div>/gi) || []).length;
  return opens - closes;
}

type Learned = {
  html: string;
  found: Record<string, boolean>;
  seller: string | null;
  storeName: string | null;
  logoUrl: string | null;
};

function learnTemplate(src: string, itemId: string): Learned {
  let h = src;
  const found: Record<string, boolean> = {};

  // 1. The hidden plain-text block eBay uses for indexing. Item specific in
  //    full; reduced to the title so we never ship another item's copy.
  if (h.startsWith('<div style="display: none;">')) {
    const end = divEnd(h, 0);
    if (end > 0) {
      h = '<div style="display: none;"><h1>{{TITLE}}</h1></div>' + h.slice(end);
      found.plainText = true;
    }
  }

  // 2. The Shopify description, verbatim, inside .shopify-auto. The single most
  //    important capture — it is the slot our descriptionHtml goes into.
  const sa = h.indexOf('<div class="shopify-auto">');
  if (sa >= 0) {
    const end = divEnd(h, sa);
    if (end > 0) {
      h = h.slice(0, sa) + '<div class="shopify-auto">{{DESCRIPTION}}</div>' + h.slice(end);
      found.description = true;
    }
  }

  // 3. Title — read it out of the rendered markup, then blank every occurrence.
  const titleM = h.match(/<h2 class="product-title">([\s\S]*?)<\/h2>/i);
  const title = titleM ? titleM[1].trim() : "";
  if (title) {
    h = h.split(title).join("{{TITLE}}");
    found.title = true;
  }

  // 4. Price.
  const priceM = h.match(/<p class="product-price">([\s\S]*?)<\/p>/i);
  if (priceM) {
    h = h.replace(priceM[0], '<p class="product-price">{{PRICE}}</p>');
    found.price = true;
  }

  // 5. Gallery: the main image, then the repeated thumbnail blocks.
  const ls = h.indexOf('<div class="left-section">');
  if (ls >= 0) {
    const firstImg = h.slice(ls).match(/src="([^"]+)"/);
    if (firstImg) {
      h = h.replace(firstImg[0], 'src="{{MAIN_IMAGE}}"');
      found.mainImage = true;
    }
  }
  // Remove each thumbnail-item by COUNTING its tags, never by regex. A lazy
  // match that ends at the second </div> also eats the closing tag of
  // .thumbnail-group, and a single unclosed div collapses the whole flex
  // layout while every piece of content is still present — the hardest kind
  // of breakage to spot, because nothing looks missing.
  if (h.includes('<div class="thumbnail-item">')) {
    let idx: number;
    while ((idx = h.indexOf('<div class="thumbnail-item">')) >= 0) {
      const end = divEnd(h, idx);
      if (end < 0) break;
      h = h.slice(0, idx) + h.slice(end);
    }
    h = h.replace('<div class="thumbnail-group">', '<div class="thumbnail-group">{{THUMBNAILS}}');
    found.thumbnails = true;
  }

  // 6. The item id appears in the Buy It Now and Contact Us links. We only know
  //    the real one AFTER publishing, so ebay-sync fills it on a second pass.
  if (itemId) {
    h = h.split("item=" + itemId).join("item={{ITEM_ID}}");
    h = h.split("iid=" + itemId).join("iid={{ITEM_ID}}");
    found.itemId = true;
  }

  // 7. Seller handle and store name, so one template shape serves every store.
  const sellerM = h.match(/ebay\.com\/usr\/([A-Za-z0-9_.-]+)/);
  const seller = sellerM ? sellerM[1] : null;
  if (seller) {
    h = h.split(seller).join("{{SELLER}}");
    found.seller = true;
  }

  const bannerM = h.match(/Welcome to the ([^,]+?) eBay store/i);
  const storeName = bannerM ? bannerM[1].trim() : null;
  if (storeName) {
    h = h.split(storeName).join("{{STORE_NAME}}");
    found.storeName = true;
  }

  // 8. The wordmark is served from Codisto's own CDN. If MC is cancelled that
  //    host may stop serving it and every listing we published would show a
  //    broken header, so it becomes a variable rather than a baked-in URL.
  const logoM = h.match(/src="(https:\/\/[^"]*cloudfront[^"]*logo\.png[^"]*)"/i);
  const logoUrl = logoM ? logoM[1].replace(/&amp;/g, "&") : null;
  if (logoM) {
    h = h.replace(new RegExp('src="' + escapeRe(logoM[1]) + '"', "g"), 'src="{{LOGO_URL}}"');
    found.logo = true;
  }

  // 9. Drop Codisto's required attribution — it must not appear on ours.
  const ci = h.indexOf('<div class="codisto-logo"');
  if (ci >= 0) {
    const end = divEnd(h, ci);
    h = h.slice(0, ci) + (end > 0 ? h.slice(end) : "");
    found.codistoAttributionRemoved = true;
  }
  h = h.replace("<!-- Codisto Logo Footer -->", "");
  h = h.replace(/&#169; Copyright \d{4}\./, "&#169; Copyright {{YEAR}}.");

  return { html: h, found, seller, storeName, logoUrl };
}

// Machine auth, same secret and reasoning as shopify-live. This one overwrites
// the branded wrapper every listing for a store is published with.
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";

function opsAuthed(url: URL): boolean {
  const given = url.searchParams.get("secret") || "";
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

  if (url.searchParams.get("status") === "1" || url.searchParams.get("raw") === "1") {
    const rows = await (await sb(
      `ebay_listing_templates?store_code=eq.${encodeURIComponent(store)}&select=*`)).json();
    const t = rows[0];
    if (!t) return json({ store, template: null, note: "none stored; run &import=1" }, 404);
    return json({
      store, storeName: t.store_name, seller: t.seller, logoUrl: t.logo_url,
      enabled: t.enabled, chars: (t.html || "").length, updatedAt: t.updated_at,
      placeholders: [...new Set((t.html.match(/\{\{[A-Z_]+\}\}/g) || []))],
      html: url.searchParams.get("raw") === "1" ? t.html : undefined,
    });
  }

  if (url.searchParams.get("import") !== "1") {
    return json({ error: "pass &import=1, &status=1 or &raw=1" }, 400);
  }

  const row = (await (await sb(
    `ebay_stores?store_code=eq.${encodeURIComponent(store)}&select=*`)).json())[0];
  if (!row) return json({ error: `no ebay_stores row for ${store}` }, 404);

  const host = HOSTS[row.environment as "production" | "sandbox"];
  const token = await accessToken(row);

  // Pick a listing to learn from. An explicit id wins; otherwise any live one
  // from the seller. It must be a listing MC created, not one of ours.
  let itemId = (url.searchParams.get("item") || "").trim();
  const sellerHint = url.searchParams.get("seller") || row.ebay_user_id || "";
  if (!itemId) {
    const r = await fetch(
      `${host}/buy/browse/v1/item_summary/search?limit=10`
      + `&filter=sellers:{${encodeURIComponent(sellerHint)}}`
      + `&q=${encodeURIComponent(url.searchParams.get("q") || "tech")}`,
      { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } },
    );
    const b = await r.json().catch(() => ({}));
    itemId = String((b.itemSummaries || [])[0]?.itemId || "").split("|")[1] || "";
    if (!itemId) {
      return json({
        error: "no live listing found to learn from — pass &item=<legacyItemId>",
        searchStatus: r.status, seller: sellerHint,
      }, 404);
    }
  }

  const itemRes = await fetch(
    `${host}/buy/browse/v1/item/${encodeURIComponent(`v1|${itemId}|0`)}`,
    { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } },
  );
  const item = await itemRes.json().catch(() => ({}));
  const description: string = item.description || "";
  if (!description) {
    return json({ error: "listing has no description html", itemId, status: itemRes.status }, 502);
  }
  if (!description.includes('class="shopify-auto"')) {
    // Refuse rather than store a wrapper with no slot for our description —
    // every listing rendered from it would silently lose the product copy.
    return json({
      error: "this listing is not a Marketplace Connect template (no .shopify-auto block)",
      itemId, chars: description.length,
      fix: "pick a listing that MC published, via &item=<legacyItemId>",
    }, 422);
  }

  const learned = learnTemplate(description, itemId);
  const sourceBalance = divBalance(description);
  const templateBalance = divBalance(learned.html);
  if (!learned.found.description) {
    return json({ error: "could not isolate the description slot", itemId, found: learned.found }, 502);
  }

  // Refuse to store a structurally broken wrapper. An unbalanced template still
  // renders every word of content and still passes a character-count check — it
  // only shows up as a collapsed layout on the live listing, after it is public.
  if (templateBalance !== sourceBalance) {
    return json({
      error: "learned template has unbalanced <div> tags — refusing to store",
      itemId, sourceBalance, templateBalance,
      note: "one unclosed div collapses the flex layout while all content still renders",
    }, 500);
  }

  const dry = url.searchParams.get("dry") === "1";
  if (!dry) {
    await sb("ebay_listing_templates?on_conflict=store_code", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{
        store_code: store,
        html: learned.html,
        store_name: learned.storeName || store,
        seller: learned.seller || sellerHint,
        logo_url: learned.logoUrl || "",
        enabled: true,
        updated_at: new Date().toISOString(),
      }]),
    });
  }

  return json({
    store, learnedFrom: itemId, dryRun: dry,
    sourceChars: description.length,
    templateChars: learned.html.length,
    storeName: learned.storeName, seller: learned.seller, logoUrl: learned.logoUrl,
    found: learned.found,
    sourceBalance, templateBalance,
    placeholders: [...new Set((learned.html.match(/\{\{[A-Z_]+\}\}/g) || []))],
    warnings: [
      learned.logoUrl && /cloudfront/.test(learned.logoUrl)
        ? "logo_url points at Codisto's CDN; set it to a PayMore-controlled URL before MC is cancelled"
        : null,
    ].filter(Boolean),
  });
});
