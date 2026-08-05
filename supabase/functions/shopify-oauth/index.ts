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
// SETUP
//   Supabase -> Project Settings -> Edge Functions -> Secrets:
//     SHOPIFY_CLIENT_ID      = app's Client ID      (Dev Dashboard -> Settings)
//     SHOPIFY_CLIENT_SECRET  = app's Client Secret  (same page — treat as a password)
//   Dev Dashboard -> Live Dashboard -> new version:
//     App URL       = https://<project>.supabase.co/functions/v1/shopify-oauth
//     Redirect URLs = https://<project>.supabase.co/functions/v1/shopify-oauth
//     (both the same — this function handles both halves)
//   Release, then open:
//     https://<project>.supabase.co/functions/v1/shopify-oauth?shop=<store>.myshopify.com
//   Repeat that last URL once per store. Each install stores its own token.
// ============================================================================

const CLIENT_ID = Deno.env.get("SHOPIFY_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET") || "";

// Overridable so trimming a scope Shopify refuses to grant needs no redeploy —
// /admin/oauth/authorize hard-errors on a scope the app is not configured for.
const SCOPES = Deno.env.get("SHOPIFY_SCOPES")
  || "read_orders,read_products,read_inventory,read_analytics,read_reports";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Built from SUPABASE_URL rather than from req.url. Behind the edge gateway the
// inbound request can carry an internal host and path, so `new URL(req.url).origin`
// is not necessarily the public URL — and Shopify string-matches redirect_uri
// against the app's whitelist, so being off by a host or a path segment fails with
// a bare "redirect_uri is not whitelisted" and no hint as to what was sent.
// Override if the function is ever fronted by a custom domain.
const REDIRECT_URI = Deno.env.get("SHOPIFY_REDIRECT_URI")
  || `${SUPABASE_URL}/functions/v1/shopify-oauth`;

// Anchored, and no dots allowed in the handle. Without this an attacker could
// hand us ?shop=evil.com and turn our function into an open redirect, or worse,
// get us to POST the client secret to a host of their choosing.
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

const STATE_TTL_MS = 10 * 60 * 1000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset=utf-8><title>${title}</title>`
    + `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#1f2937}`
    + `h1{font-size:1.35rem;margin:0 0 .75rem}code{background:#f3f4f6;padding:.15em .4em;border-radius:4px}</style>`
    + `<h1>${title}</h1>${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

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
 * Verify Shopify's `hmac` over the request's query parameters.
 *
 * Shopify's own examples disagree on whether the signed message uses decoded or
 * re-encoded values, and `host` is base64 (so it carries `=` padding) which is
 * exactly where the two forms diverge. Rather than bet on one reading, build
 * both and accept either — neither is weaker, they are the same digest over the
 * same data with different escaping.
 */
async function hmacCandidates(url: URL) {
  const pairs: [string, string][] = [];
  url.searchParams.forEach((v, k) => {
    // `debug` is ours, not Shopify's — including it would corrupt the message.
    if (k !== "hmac" && k !== "signature" && k !== "debug") pairs.push([k, v]);
  });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const messages = [
    // The documented form: decoded values, joined verbatim.
    pairs.map(([k, v]) => `${k}=${v}`).join("&"),
    // Fully re-encoded. Differs from the above only where a value contains
    // reserved characters — `host` is base64 and can carry `=` padding.
    pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"),
    // Shopify's partial-escaping rule, used in their proxy-signature docs.
    pairs.map(([k, v]) =>
      `${k.replace(/%/g, "%25")}=${v.replace(/%/g, "%25").replace(/&/g, "%26").replace(/=/g, "%3D")}`
    ).join("&"),
  ];
  return { pairs, messages: [...new Set(messages)] };
}

/**
 * Candidate signing keys, newest first.
 *
 * Rotating the client secret in the Dev Dashboard does not switch Shopify's
 * signing key over immediately — measured here, Shopify kept signing OAuth
 * callbacks with the pre-rotation secret while the dashboard displayed the new
 * one. Accepting both for the overlap is Shopify's documented guidance and the
 * only way a rotation doesn't mean downtime.
 *
 * Clear SHOPIFY_CLIENT_SECRET_PREV once the changeover has settled; leaving a
 * retired secret on the accept-list indefinitely is what makes rotation
 * meaningless.
 */
const PREV_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET_PREV") || "";

function keyCandidates(): { label: string; key: string }[] {
  const out = [{ label: "current", key: CLIENT_SECRET }];
  if (PREV_SECRET && PREV_SECRET !== CLIENT_SECRET) {
    out.push({ label: "previous", key: PREV_SECRET });
  }
  return out;
}

async function verifyQueryHmac(url: URL): Promise<boolean> {
  const given = url.searchParams.get("hmac");
  if (!given) return false;
  const { messages } = await hmacCandidates(url);
  for (const { key } of keyCandidates()) {
    for (const msg of messages) {
      if (safeEqual(await hmacHex(key, msg), given)) return true;
    }
  }
  return false;
}

// State is self-describing and signed, so no table and no cleanup job: the
// callback can prove the request came from an install WE started, and that it
// started recently, using only the client secret.
async function makeState(shop: string, nowMs: number): Promise<string> {
  const payload = `${shop}|${nowMs}`;
  const sig = await hmacHex(CLIENT_SECRET, payload);
  return btoa(`${payload}|${sig}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function checkState(state: string, shop: string, nowMs: number): Promise<string | null> {
  let raw: string;
  try {
    raw = atob(state.replace(/-/g, "+").replace(/_/g, "/"));
  } catch (_) {
    return "state is not decodable";
  }
  const parts = raw.split("|");
  if (parts.length !== 3) return "state is malformed";
  const [stateShop, tsStr, sig] = parts;
  if (!safeEqual(await hmacHex(CLIENT_SECRET, `${stateShop}|${tsStr}`), sig)) {
    return "state signature does not match";
  }
  if (stateShop !== shop) return "state was issued for a different shop";
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || nowMs - ts > STATE_TTL_MS) return "state has expired — start the install again";
  return null;
}

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

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return page("Not configured yet", "<p>Set <code>SHOPIFY_CLIENT_ID</code> and "
      + "<code>SHOPIFY_CLIENT_SECRET</code> in Supabase edge function secrets.</p>", 500);
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return page("Not configured yet", "<p>Service role credentials are missing from the "
      + "function environment.</p>", 500);
  }

  const shop = (url.searchParams.get("shop") || "").toLowerCase().trim();
  const code = url.searchParams.get("code");

  if (!shop) {
    return page("Shopify install helper", "<p>Open this URL with a shop to begin:</p>"
      + "<p><code>?shop=your-store.myshopify.com</code></p>");
  }
  if (!SHOP_RE.test(shop)) {
    return page("Bad shop domain", `<p>Refusing <code>${shop}</code> — must look like `
      + "<code>your-store.myshopify.com</code>.</p>", 400);
  }

  // ---- leg 2: callback, swap code for a token ------------------------------
  if (code) {
    const signed = await verifyQueryHmac(url);

    // A failed signature has two very different causes — a wrong CLIENT_SECRET,
    // or our message being assembled differently to Shopify's. Showing the
    // candidate messages and their digests distinguishes them in one look. None
    // of this exposes the secret: the params are public, and an HMAC output does
    // not reveal its key.
    if (!signed && url.searchParams.get("debug")) {
      const { pairs, messages } = await hmacCandidates(url);
      const computed = [];
      for (const { label, key } of keyCandidates()) {
        for (const m of messages) {
          computed.push({ keyVariant: label, message: m, digest: await hmacHex(key, m) });
        }
      }
      return json({
        verdict: "hmac mismatch",
        givenHmac: url.searchParams.get("hmac"),
        paramKeysUsed: pairs.map(([k]) => k),
        candidates: computed,
        // If none of the digests match and the message list looks right, the
        // secret is the problem — re-paste it from the Dev Dashboard.
        secretConfigured: CLIENT_SECRET.length > 0,
        secretLength: CLIENT_SECRET.length,
        secretHasShpssPrefix: CLIENT_SECRET.startsWith("shpss_"),
        note: "Digests are derived from the secret but do not reveal it.",
      }, 401);
    }

    if (!signed) {
      return page("Signature check failed", "<p>That callback was not signed by Shopify "
        + "with this app's secret. Nothing was stored.</p>"
        + "<p>Most often this means the Client Secret stored server-side is not the "
        + "app's current one — re-copy it from the Dev Dashboard, then run the install "
        + "link again. Add <code>&amp;debug=1</code> to this URL for the comparison.</p>", 401);
    }
    const stateProblem = await checkState(url.searchParams.get("state") || "", shop, nowMs);
    if (stateProblem) {
      return page("Install could not be verified", `<p>${stateProblem}.</p>`, 400);
    }

    // If Shopify is still signing with the previous secret, it may also still
    // expect that secret to authenticate the exchange. Try each in turn rather
    // than burning the (single-use) code on a guess.
    let body: { access_token?: string; scope?: string } | null = null;
    let lastStatus = 0;
    let lastError = "";
    for (const { key } of keyCandidates()) {
      const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: key, code }),
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
        + (lastError
            ? `<p>Shopify said:</p><p><code>${lastError.replace(/[<&]/g, ch => ch === "<" ? "&lt;" : "&amp;")}</code></p>`
            : "")
        + "<p>A code is single-use, so if this says the code was already used or not "
        + "found, just run the install link again from the start rather than reloading "
        + "this page.</p>", 502);
    }

    try {
      await saveToken(shop, body.access_token, body.scope || "");
    } catch (err) {
      console.error("saveToken failed", String(err));   // message only — no token
      return page("Installed, but not stored", "<p>Shopify issued a token but writing it to the "
        + "database failed. Check the function logs, then run the install link again.</p>", 500);
    }

    return page("Installed", `<p><strong>${shop}</strong> is connected.</p>`
      + `<p>Granted scopes: <code>${(body.scope || "none reported").replace(/</g, "&lt;")}</code></p>`
      + "<p>The access token is stored server-side and was never shown here. "
      + "Repeat this install link for the remaining stores.</p>");
  }

  // ---- leg 1: install start -----------------------------------------------
  // Shopify also lands here (with hmac/host/shop but no code) whenever the app is
  // opened from the admin, so this doubles as the App URL.
  const authorize = `https://${shop}/admin/oauth/authorize`
    + `?client_id=${encodeURIComponent(CLIENT_ID)}`
    + `&scope=${encodeURIComponent(SCOPES)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&state=${encodeURIComponent(await makeState(shop, nowMs))}`;

  // &debug=1 shows exactly what we would hand Shopify, without following the
  // redirect. "redirect_uri is not whitelisted" is otherwise unfalsifiable from
  // the outside: Shopify will not tell you what it received.
  if (url.searchParams.get("debug")) {
    return json({
      redirectUriSent: REDIRECT_URI,
      mustMatchExactlyInDevDashboard: REDIRECT_URI,
      scopesRequested: SCOPES,
      clientIdLast6: CLIENT_ID.slice(-6),      // enough to spot a stale/mismatched app
      authorizeUrl: authorize,
      // What req.url actually looked like, to confirm whether deriving from it
      // was the original bug.
      inboundRequestUrl: req.url,
      inboundOrigin: url.origin,
    });
  }

  return new Response(null, { status: 302, headers: { Location: authorize } });
});
