// ============================================================================
// ebay-oauth — one-time consent flow per store, mirroring shopify-oauth.
//
// eBay's authorization code grant, with two differences from Shopify that cause
// most of the pain:
//
//   1. redirect_uri is a RuName, not a URL. You register the real URL in the
//      developer portal under "Get a Token from eBay via Your Application" and
//      eBay hands back an opaque RuName. That RuName is what goes in both the
//      consent URL and the token exchange. Sending the actual URL fails with a
//      bare invalid_request.
//
//   2. The refresh token is the prize, not the access token. Access tokens last
//      2 hours; the refresh token lasts ~18 months and is what we store. Every
//      other eBay function mints short-lived access tokens from it.
//
// SECRETS
//   EBAY_APPS — JSON, SPEEKS store_code -> credentials. One secret for all
//   stores, matching the SHOPIFY_APPS pattern. Each store has its own eBay
//   seller account, so each gets its own keyset:
//     {
//       "OP":  { "clientId": "...", "clientSecret": "...", "ruName": "...", "env": "sandbox" },
//       "LEE": { "clientId": "...", "clientSecret": "...", "ruName": "..." }
//     }
//   "env" is "production" unless stated. Do the first store in sandbox.
//
// Then open, once per store:
//   https://<project>.supabase.co/functions/v1/ebay-oauth?store=OP
//
// Add &debug=1 to see exactly what would be sent, without following the
// redirect and without revealing a secret.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Full-replacement scope set: inventory (listings), account (business policies
// and merchant locations), fulfillment (orders and shipping). The bare
// api_scope is required alongside them for the taxonomy calls.
const SCOPES = Deno.env.get("EBAY_SCOPES") || [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
].join(" ");

const STATE_TTL_MS = 10 * 60 * 1000;

// Store codes are ours, not user input from eBay, but this still runs on a
// query parameter — keep it to an obvious shape so it can never be smuggled
// into a URL we build.
const STORE_RE = /^[A-Z0-9_-]{1,16}$/;

const HOSTS = {
  production: { auth: "https://auth.ebay.com", api: "https://api.ebay.com" },
  sandbox: { auth: "https://auth.sandbox.ebay.com", api: "https://api.sandbox.ebay.com" },
};

// --- credentials ------------------------------------------------------------

type Creds = {
  clientId: string;
  clientSecret: string;
  ruName: string;
  env: "production" | "sandbox";
};

// Same defensive parse as shopify-oauth: a pretty-printed paste into a
// single-line secret field wraps long values and puts a raw newline inside a
// string literal, which JSON.parse rejects with an unhelpful position error.
// Filtering by char code rather than a regex range keeps this file free of
// literal control characters.
const stripControl = (s: string) =>
  Array.from(s).filter(ch => ch.charCodeAt(0) >= 32).join("");

let APPS: Record<string, Partial<Creds>> = {};
let APPS_ERROR = "";
let APPS_REPAIRED = false;
{
  const raw = (Deno.env.get("EBAY_APPS") || "").trim();
  if (raw) {
    const attempts: [string, string][] = [
      ["as-is", raw],
      ["control-characters-stripped", stripControl(raw)],
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
        lastErr = "EBAY_APPS is not a JSON object";
      } catch (err) {
        lastErr = String(err instanceof Error ? err.message : err);
      }
    }
    APPS_ERROR = lastErr;
  }
}

function credsFor(store: string): Creds | null {
  const entry = APPS[store];
  if (!entry?.clientId || !entry?.clientSecret || !entry?.ruName) return null;
  return {
    clientId: entry.clientId,
    clientSecret: entry.clientSecret,
    ruName: entry.ruName,
    env: entry.env === "sandbox" ? "sandbox" : "production",
  };
}

// --- state ------------------------------------------------------------------

// Signed rather than stored: the function is stateless between the two legs, and
// a signed timestamp is enough to prove we started this flow and that it's fresh.
async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SERVICE_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function makeState(store: string): Promise<string> {
  const payload = `${store}.${Date.now()}`;
  return `${payload}.${(await hmac(payload)).slice(0, 32)}`;
}

async function readState(state: string): Promise<{ store: string; error?: string }> {
  const parts = (state || "").split(".");
  if (parts.length !== 3) return { store: "", error: "malformed state" };
  const [store, ts, sig] = parts;
  const expected = (await hmac(`${store}.${ts}`)).slice(0, 32);
  if (sig !== expected) return { store: "", error: "state signature mismatch" };
  if (Date.now() - Number(ts) > STATE_TTL_MS) return { store: "", error: "state expired" };
  return { store };
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

async function saveTokens(store: string, env: string, tok: {
  refresh_token: string;
  refresh_token_expires_in?: number;
  access_token: string;
  expires_in?: number;
}) {
  const now = Date.now();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ebay_stores?on_conflict=store_code`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      // Re-running consent after a scope change should update, not 409.
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{
      store_code: store,
      environment: env,
      refresh_token: tok.refresh_token,
      refresh_token_expires_at: tok.refresh_token_expires_in
        ? new Date(now + tok.refresh_token_expires_in * 1000).toISOString()
        : null,
      access_token: tok.access_token,
      access_token_expires_at: tok.expires_in
        ? new Date(now + tok.expires_in * 1000).toISOString()
        : null,
      scopes: SCOPES,
      updated_at: new Date(now).toISOString(),
    }]),
  });
  if (!res.ok) throw new Error(`storing tokens failed: ${res.status} ${await res.text()}`);
}

// --- handler ----------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const debug = url.searchParams.get("debug") === "1";

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return page("Not configured yet",
      "<p>Service role credentials are missing from the function environment.</p>", 500);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  // --- leg 2: eBay handed us an authorization code --------------------------
  if (code) {
    const { store, error } = await readState(state || "");
    if (error) return page("Consent could not be verified", `<p>${esc(error)}.</p>`, 400);

    const creds = credsFor(store);
    if (!creds) return page("Unknown store", `<p>No credentials for <code>${esc(store)}</code>.</p>`, 400);

    const host = HOSTS[creds.env];
    const basic = btoa(`${creds.clientId}:${creds.clientSecret}`);

    const res = await fetch(`${host.api}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        // The RuName again, not a URL — and it must match the consent leg exactly.
        redirect_uri: creds.ruName,
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error("ebay-oauth: token exchange failed", res.status, text);
      return page("Token exchange failed",
        `<p>eBay returned <code>${res.status}</code>.</p><p><code>${esc(text.slice(0, 500))}</code></p>`, 502);
    }

    const tok = JSON.parse(text);
    if (!tok.refresh_token) {
      return page("No refresh token returned",
        "<p>eBay accepted the code but returned no refresh token. This usually means the "
        + "consent was for an application token rather than a user token.</p>", 502);
    }

    await saveTokens(store, creds.env, tok);

    const months = tok.refresh_token_expires_in
      ? Math.round(tok.refresh_token_expires_in / 2592000)
      : null;
    return page("Connected",
      `<p>Store <code>${esc(store)}</code> is linked to eBay (<code>${creds.env}</code>).</p>`
      + (months ? `<p>Refresh token valid for about ${months} months.</p>` : "")
      + "<p>You can close this tab.</p>");
  }

  // --- leg 1: start consent -------------------------------------------------
  const store = (url.searchParams.get("store") || "").toUpperCase().trim();

  if (!store) {
    return page("eBay connect helper",
      "<p>Open this URL with a store code to begin:</p>"
      + "<p><code>?store=OP</code></p>"
      + `<p>Stores currently configured: <code>${esc(Object.keys(APPS).join(", ") || "none in EBAY_APPS")}</code></p>`
      + (APPS_ERROR ? `<p><strong>EBAY_APPS failed to parse: ${esc(APPS_ERROR)}</strong></p>` : "")
      + (APPS_REPAIRED ? "<p><em>EBAY_APPS parsed only after stripping line breaks — re-paste it as one line.</em></p>" : ""));
  }

  if (!STORE_RE.test(store)) {
    return page("Bad store code", "<p>Expected something like <code>OP</code>.</p>", 400);
  }

  const creds = credsFor(store);
  if (!creds) {
    return page("Store not configured",
      `<p>No usable entry for <code>${esc(store)}</code> in <code>EBAY_APPS</code>. `
      + "Each store needs <code>clientId</code>, <code>clientSecret</code> and <code>ruName</code>.</p>"
      + (APPS_ERROR ? `<p><strong>Parse error: ${esc(APPS_ERROR)}</strong></p>` : ""), 400);
  }

  const host = HOSTS[creds.env];
  const consent = `${host.auth}/oauth2/authorize`
    + `?client_id=${encodeURIComponent(creds.clientId)}`
    + `&response_type=code`
    + `&redirect_uri=${encodeURIComponent(creds.ruName)}`
    + `&scope=${encodeURIComponent(SCOPES)}`
    + `&state=${encodeURIComponent(await makeState(store))}`;

  if (debug) {
    return json({
      store,
      environment: creds.env,
      ruNameSent: creds.ruName,
      clientIdTail: creds.clientId.slice(-6),
      scopes: SCOPES.split(" "),
      consentUrl: consent,
      note: "redirect_uri must be the RuName, not this function's URL. The URL itself "
        + "is what you register in the developer portal to obtain that RuName.",
    });
  }

  return Response.redirect(consent, 302);
});
