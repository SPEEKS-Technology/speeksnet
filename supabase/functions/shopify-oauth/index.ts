// ============================================================================
// shopify-oauth — completes the Shopify app install for a store we own.
//
// Why this exists: Shopify stopped allowing new legacy custom apps on 2026-01-01,
// and Dev Dashboard apps assume a real hosted app that performs OAuth and holds
// the token itself. There is no "reveal token" button any more. So this function
// IS that hosted app — the smallest possible one. It does two things and nothing
// else:
//
//   1. Install start.  Shopify sends the merchant to our App URL with ?shop=...
//      We redirect on to that shop's /admin/oauth/authorize.
//   2. Callback.       Shopify redirects back with ?code=...  We swap the code for
//      a permanent offline access token and store it in shopify_stores.
//
// The token is written straight to the database by the service role. It is never
// displayed, logged, returned in a response, or copied by hand — which is the
// point: with five stores to onboard, a token that no human ever sees cannot be
// pasted somewhere it shouldn't be.
//
// ONE APP PER STORE. A Dev Dashboard app installs cleanly on the store it was
// created from, but installing it on a SIBLING store in the same organization
// returns a Shopify 500 at /app/grant with no distribution setting available to
// fix it (reproduced on three separate stores). So each store gets its own app,
// created from that store's own admin, and this function looks up which
// credentials to use by shop domain.
//
// SETUP — per store
//   In that store's admin: Settings -> Apps and sales channels -> Develop apps
//     -> Build apps in Dev Dashboard -> create an app -> new version with:
//        App URL       = https://<project>.supabase.co/functions/v1/shopify-oauth
//        Redirect URLs = https://<project>.supabase.co/functions/v1/shopify-oauth
//        Scopes        = read_orders,read_products,read_inventory,read_analytics,read_reports
//        "Use legacy install flow" CHECKED (this function is the OAuth server)
//        "Embed app in Shopify admin" UNCHECKED (there is no UI to embed)
//     -> Release, then copy its Client ID and Secret into SHOPIFY_APPS below.
//
// SECRETS
//   SHOPIFY_APPS — JSON, shop domain -> credentials. The whole config in one
//   secret so adding a store is one edit rather than two new env vars:
//     {
//       "paymore-overland-park.myshopify.com": { "clientId": "...", "clientSecret": "..." },
//       "paymore-lees-summit.myshopify.com":   { "clientId": "...", "clientSecret": "..." }
//     }
//   An optional "prevSecret" per store is honoured during a rotation overlap.
//
//   SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET — fallback for any shop absent
//   from SHOPIFY_APPS. Keeps the first store working without a config migration.
//
// Then open, once per store:
//   https://<project>.supabase.co/functions/v1/shopify-oauth?shop=<store>.myshopify.com
//
// Add &debug=1 to either leg to see what is actually being sent or compared,
// without following the redirect and without revealing any credential.
// ============================================================================

// Trimmed per-scope, not just end to end: the secret is pasted by hand into a
// single-line field and arrived with a trailing newline, which was being
// URL-encoded onto the last scope as "read_locations%0A". Shopify happened to
// tolerate it, but a scope list that depends on the other side being forgiving
// is not something to leave in place — and the same paste habit put literal
// line breaks inside SHOPIFY_APPS.
const SCOPES = (Deno.env.get("SHOPIFY_SCOPES")
  || "read_orders,read_products,read_inventory,read_analytics,read_reports")
  .split(",").map(s => s.trim()).filter(Boolean).join(",");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Built from SUPABASE_URL rather than from req.url. Behind the edge gateway the
// inbound request arrives as http with the /functions/v1 prefix stripped, so
// `new URL(req.url).origin` is NOT the public URL — and Shopify string-matches
// redirect_uri against the app's whitelist, failing with a bare "redirect_uri is
// not whitelisted" and no hint as to what was sent. (This was a real bug here.)
const REDIRECT_URI = Deno.env.get("SHOPIFY_REDIRECT_URI")
  || `${SUPABASE_URL}/functions/v1/shopify-oauth`;

// Anchored, and no dots allowed in the handle. Without this an attacker could
// hand us ?shop=evil.com and turn our function into an open redirect, or worse,
// get us to POST a client secret to a host of their choosing.
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

const STATE_TTL_MS = 10 * 60 * 1000;

// --- credentials ------------------------------------------------------------

type Creds = {
  clientId: string;
  clientSecret: string;
  prevSecret: string;
  source: string;
};

// Parsed once, with the failure captured rather than swallowed: a typo in the
// JSON would otherwise fall silently back to the default app and produce a
// confusing "signature check failed" on a store that looked configured.
let APPS: Record<string, { clientId?: string; clientSecret?: string; prevSecret?: string }> = {};
let APPS_ERROR = "";
let APPS_REPAIRED = false;
{
  const raw = (Deno.env.get("SHOPIFY_APPS") || "").trim();
  if (raw) {
    // Pasting pretty-printed JSON into a single-line secret field wraps long
    // values, which puts a raw newline INSIDE a string literal — invalid JSON,
    // and the error ("bad control character at position 444") gives no hint that
    // a line break is the culprit. No client ID or secret legitimately contains
    // whitespace, so retrying with control characters stripped is safe and makes
    // the config survive a wrapped paste rather than silently falling back to
    // the default app.
    const attempts: [string, string][] = [
      ["as-is", raw],
      ["control-characters-stripped", raw.replace(/[\u0000-\u001F]/g, "")],
    ];
    let lastErr = "";
    for (const [label, text] of attempts) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          APPS = parsed;
          APPS_REPAIRED = label !== "as-is";
          lastErr = "";
          break;
        }
        lastErr = "valid JSON but not an object of shop -> credentials";
      } catch (err) {
        lastErr = String(err);
      }
    }
    if (lastErr) APPS_ERROR = `SHOPIFY_APPS could not be parsed: ${lastErr}`;
  }
}

function credsFor(shop: string): Creds | null {
  const entry = APPS[shop];
  if (entry?.clientId && entry?.clientSecret) {
    return {
      clientId: entry.clientId,
      clientSecret: entry.clientSecret,
      prevSecret: entry.prevSecret || "",
      source: "SHOPIFY_APPS",
    };
  }
  const id = Deno.env.get("SHOPIFY_CLIENT_ID") || "";
  const secret = Deno.env.get("SHOPIFY_CLIENT_SECRET") || "";
  if (id && secret) {
    return {
      clientId: id,
      clientSecret: secret,
      prevSecret: Deno.env.get("SHOPIFY_CLIENT_SECRET_PREV") || "",
      source: "env-default",
    };
  }
  return null;
}

/**
 * Candidate signing keys for one store, newest first.
 *
 * Rotating a client secret does not switch Shopify's signing key over
 * immediately — measured here, Shopify kept signing OAuth callbacks with the
 * pre-rotation secret while the dashboard displayed the new one, until the old
 * secret was explicitly revoked. Accepting both across the overlap is the only
 * way a rotation doesn't mean downtime. Drop `prevSecret` once it has settled;
 * a retired secret left on the accept-list makes rotation meaningless.
 */
function keyCandidates(c: Creds): { label: string; key: string }[] {
  const out = [{ label: "current", key: c.clientSecret }];
  if (c.prevSecret && c.prevSecret !== c.clientSecret) {
    out.push({ label: "previous", key: c.prevSecret });
  }
  return out;
}

// --- crypto helpers ---------------------------------------------------------

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time compare. A length-dependent early return would leak the digest
// one byte at a time to anyone willing to measure.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Build every plausible form of the message Shopify signed.
 *
 * Shopify's own examples disagree on whether the signed message uses decoded or
 * re-encoded values, and `host` is base64 (so it can carry `=` padding) which is
 * exactly where the forms diverge. Verified against a live callback: the first
 * form, keyed with the full `shpss_`-prefixed secret, is the one Shopify uses.
 * The others cost nothing and cover a future change of mind.
 */
function hmacCandidates(url: URL) {
  const pairs: [string, string][] = [];
  url.searchParams.forEach((v, k) => {
    // `debug` is ours, not Shopify's — including it would corrupt the message.
    if (k !== "hmac" && k !== "signature" && k !== "debug") pairs.push([k, v]);
  });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const messages = [
    pairs.map(([k, v]) => `${k}=${v}`).join("&"),
    pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"),
    pairs.map(([k, v]) =>
      `${k.replace(/%/g, "%25")}=${v.replace(/%/g, "%25").replace(/&/g, "%26").replace(/=/g, "%3D")}`
    ).join("&"),
  ];
  return { pairs, messages: [...new Set(messages)] };
}

async function verifyQueryHmac(url: URL, c: Creds): Promise<boolean> {
  const given = url.searchParams.get("hmac");
  if (!given) return false;
  const { messages } = hmacCandidates(url);
  for (const { key } of keyCandidates(c)) {
    for (const msg of messages) {
      if (safeEqual(await hmacHex(key, msg), given)) return true;
    }
  }
  return false;
}

// State is self-describing and signed, so no table and no cleanup job: the
// callback can prove the request came from an install WE started, and that it
// started recently, using only that store's client secret.
async function makeState(shop: string, nowMs: number, c: Creds): Promise<string> {
  const payload = `${shop}|${nowMs}`;
  const sig = await hmacHex(c.clientSecret, payload);
  return btoa(`${payload}|${sig}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function checkState(state: string, shop: string, nowMs: number, c: Creds): Promise<string | null> {
  let raw: string;
  try {
    raw = atob(state.replace(/-/g, "+").replace(/_/g, "/"));
  } catch (_) {
    return "state is not decodable";
  }
  const parts = raw.split("|");
  if (parts.length !== 3) return "state is malformed";
  const [stateShop, tsStr, sig] = parts;
  if (!safeEqual(await hmacHex(c.clientSecret, `${stateShop}|${tsStr}`), sig)) {
    return "state signature does not match";
  }
  if (stateShop !== shop) return "state was issued for a different shop";
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || nowMs - ts > STATE_TTL_MS) {
    return "state has expired — start the install again";
  }
  return null;
}

// --- responses --------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset=utf-8><title>${title}</title>`
    + `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#1f2937}`
    + `h1{font-size:1.35rem;margin:0 0 .75rem}code{background:#f3f4f6;padding:.15em .4em;border-radius:4px;word-break:break-all}</style>`
    + `<h1>${title}</h1>${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

const esc = (s: string) => s.replace(/[<&]/g, ch => (ch === "<" ? "&lt;" : "&amp;"));

// --- store the token --------------------------------------------------------

async function saveToken(shop: string, token: string, scopes: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/shopify_stores?on_conflict=shop`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      // merge-duplicates makes a re-install an update rather than a 409, so
      // re-running the install after a scope change is safe and idempotent.
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{
      shop,
      access_token: token,
      scopes,
      updated_at: new Date().toISOString(),
    }]),
  });
  if (!res.ok) throw new Error(`storing token failed: ${res.status} ${await res.text()}`);
}

// --- handler ----------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const nowMs = Date.now();

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return page("Not configured yet", "<p>Service role credentials are missing from the "
      + "function environment.</p>", 500);
  }

  const shop = (url.searchParams.get("shop") || "").toLowerCase().trim();
  const code = url.searchParams.get("code");

  if (!shop) {
    return page("Shopify install helper",
      "<p>Open this URL with a shop to begin:</p>"
      + "<p><code>?shop=your-store.myshopify.com</code></p>"
      + `<p>Stores currently configured: <code>${esc(Object.keys(APPS).join(", ") || "none in SHOPIFY_APPS")}</code></p>`
      + (APPS_ERROR ? `<p><strong>${esc(APPS_ERROR)}</strong></p>` : ""));
  }
  if (!SHOP_RE.test(shop)) {
    return page("Bad shop domain", `<p>Refusing <code>${esc(shop)}</code> — must look like `
      + "<code>your-store.myshopify.com</code>.</p>", 400);
  }

  const creds = credsFor(shop);
  if (!creds) {
    return page("No credentials for this store",
      `<p>Nothing configured for <code>${esc(shop)}</code>.</p>`
      + "<p>Add it to the <code>SHOPIFY_APPS</code> secret as "
      + "<code>{\"shop\": {\"clientId\": \"...\", \"clientSecret\": \"...\"}}</code>, "
      + "or set <code>SHOPIFY_CLIENT_ID</code> / <code>SHOPIFY_CLIENT_SECRET</code> "
      + "as the default.</p>"
      + (APPS_ERROR ? `<p><strong>${esc(APPS_ERROR)}</strong></p>` : ""), 500);
  }

  // ---- leg 2: callback, swap code for a token ------------------------------
  if (code) {
    const signed = await verifyQueryHmac(url, creds);

    // A failed signature has two very different causes — the wrong client secret
    // for this store, or our message being assembled differently to Shopify's.
    // Showing the candidate messages and their digests distinguishes them in one
    // look. None of this exposes a secret: the params are public, and an HMAC
    // output does not reveal its key.
    if (!signed && url.searchParams.get("debug")) {
      const { pairs, messages } = hmacCandidates(url);
      const computed = [];
      for (const { label, key } of keyCandidates(creds)) {
        for (const m of messages) {
          computed.push({ keyVariant: label, message: m, digest: await hmacHex(key, m) });
        }
      }
      return json({
        verdict: "hmac mismatch",
        shop,
        credsSource: creds.source,
        clientIdLast6: creds.clientId.slice(-6),
        givenHmac: url.searchParams.get("hmac"),
        paramKeysUsed: pairs.map(([k]) => k),
        candidates: computed,
        secretLength: creds.clientSecret.length,
        secretHasShpssPrefix: creds.clientSecret.startsWith("shpss_"),
        prevSecretConfigured: creds.prevSecret.length > 0,
        appsConfigured: Object.keys(APPS),
        appsError: APPS_ERROR || null,
        note: "Digests are derived from the secret but do not reveal it.",
      }, 401);
    }

    if (!signed) {
      return page("Signature check failed",
        "<p>That callback was not signed by Shopify with this app's secret. "
        + "Nothing was stored.</p>"
        + `<p>Credentials used came from <code>${esc(creds.source)}</code>. If this store `
        + "has its own app, make sure that app's Client ID and Secret are the ones in "
        + "<code>SHOPIFY_APPS</code> — falling back to the default app's credentials "
        + "fails exactly like this.</p>"
        + "<p>Add <code>&amp;debug=1</code> to this URL for the comparison.</p>", 401);
    }

    const stateProblem = await checkState(url.searchParams.get("state") || "", shop, nowMs, creds);
    if (stateProblem) {
      return page("Install could not be verified", `<p>${esc(stateProblem)}.</p>`, 400);
    }

    // If Shopify is still honouring the previous secret, it may also still expect
    // that secret to authenticate the exchange. Try each in turn rather than
    // burning the (single-use) code on a guess.
    let body: { access_token?: string; scope?: string } | null = null;
    let lastStatus = 0;
    let lastError = "";
    for (const { key } of keyCandidates(creds)) {
      const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: creds.clientId, client_secret: key, code }),
      });
      lastStatus = res.status;
      if (!res.ok) {
        // Safe to read and surface: a FAILED exchange carries no access token,
        // only Shopify's own error text, and "HTTP 400" alone cannot distinguish
        // a spent code from a rejected credential.
        lastError = (await res.text().catch(() => "")).slice(0, 300);
        continue;
      }
      // Never echo a SUCCESSFUL body: it contains the access token.
      body = await res.json().catch(() => null);
      if (body?.access_token) break;
    }

    if (!body?.access_token) {
      return page("Token exchange failed",
        `<p>Shopify returned HTTP ${lastStatus}.</p>`
        + (lastError ? `<p>Shopify said:</p><p><code>${esc(lastError)}</code></p>` : "")
        + "<p>A code is single-use, so if this says the code was already used or not "
        + "found, run the install link again from the start rather than reloading "
        + "this page.</p>", 502);
    }

    try {
      await saveToken(shop, body.access_token, body.scope || "");
    } catch (err) {
      console.error("saveToken failed", String(err));   // message only — no token
      return page("Installed, but not stored", "<p>Shopify issued a token but writing it to the "
        + "database failed. Check the function logs, then run the install link again.</p>", 500);
    }

    return page("Installed", `<p><strong>${esc(shop)}</strong> is connected.</p>`
      + `<p>Granted scopes: <code>${esc(body.scope || "none reported")}</code></p>`
      + "<p>The access token is stored server-side and was never shown here. "
      + "Repeat this install link for the remaining stores.</p>");
  }

  // ---- leg 1: install start -----------------------------------------------
  // Shopify also lands here (with hmac/host/shop but no code) whenever the app is
  // opened from the admin, so this doubles as the App URL.
  const authorize = `https://${shop}/admin/oauth/authorize`
    + `?client_id=${encodeURIComponent(creds.clientId)}`
    + `&scope=${encodeURIComponent(SCOPES)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&state=${encodeURIComponent(await makeState(shop, nowMs, creds))}`;

  // &debug=1 shows exactly what we would hand Shopify, without following the
  // redirect. "redirect_uri is not whitelisted" is otherwise unfalsifiable from
  // the outside: Shopify will not tell you what it received.
  if (url.searchParams.get("debug")) {
    return json({
      shop,
      credsSource: creds.source,
      clientIdLast6: creds.clientId.slice(-6),
      // A store using "env-default" when it has its own app is the mistake this
      // field exists to catch.
      warning: creds.source === "env-default" && Object.keys(APPS).length
        ? "This shop is not in SHOPIFY_APPS and is falling back to the default app"
        : null,
      redirectUriSent: REDIRECT_URI,
      mustMatchExactlyInDevDashboard: REDIRECT_URI,
      scopesRequested: SCOPES,
      authorizeUrl: authorize,
      appsConfigured: Object.keys(APPS),
      appsError: APPS_ERROR || null,
      // True when the secret only parsed after stripping line breaks. Harmless,
      // but worth tidying so the stored value is real JSON.
      appsNeededRepair: APPS_REPAIRED,
      inboundRequestUrl: req.url,
    });
  }

  return new Response(null, { status: 302, headers: { Location: authorize } });
});
