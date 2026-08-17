// ============================================================================
// ebay-setup — resolve a store's eBay business policies and merchant location.
//
//   ?store=OVL&list=1     read-only: every policy on the account, by name + id
//   ?store=OVL            match policies by name, save the IDs
//   ?store=OVL&dry=1      show what it would match/save, change nothing
//   ?store=OVL&create=1   ALSO create missing policies from built-in defaults
//
// MATCH BY NAME, DO NOT GUESS.
// The first version took whichever policy eBay listed first. On a real account
// with several shipping policies that silently attaches the wrong carrier — or
// charges shipping on a listing meant to be free. Policies are now looked up by
// exact name and anything missing is reported rather than substituted.
//
// CREATION IS OPT-IN. A production account already has the policies the
// business actually uses; inventing more is noise at best and wrong at worst.
// &create=1 exists for a fresh account (the sandbox case) only.
//
// PayMore runs two profiles:
//   standard — ships, free shipping, 30-day returns
//   pickup   — local collection only, its own shipping AND payment policy
// Names are overridable per store in EBAY_APPS:
//   "OVL": { ..., "policyNames": { "standard": { "fulfillment": "...", ... } } }
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const MARKETPLACE = "EBAY_US";
const CATEGORY_TYPE = "ALL_EXCLUDING_MOTORS_VEHICLES";

const HOSTS = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};

// PayMore's actual policy names. The pickup profile has no return policy of its
// own, so it reuses the standard one — collection items are still returnable.
const DEFAULT_POLICY_NAMES: Record<string, Record<string, string>> = {
  standard: {
    fulfillment: "Shipping Default",
    payment: "Payment Default",
    return: "Return Default",
  },
  pickup: {
    // Verified against the live paymore_overland_park account 2026-08-15. The
    // name has no "(Shipping)" suffix despite being the shipping policy — and
    // getting it wrong means pickup-only items publish as shippable, which is
    // why this matches exactly rather than falling back to anything.
    fulfillment: "Local Pickup Only",
    payment: "Local Pickup Only Payment Policy",
    return: "Return Default",
  },
};

const KINDS = [
  { kind: "fulfillment", path: "fulfillment_policy", idField: "fulfillmentPolicyId", listKey: "fulfillmentPolicies", column: "fulfillment_policy_id" },
  { kind: "payment", path: "payment_policy", idField: "paymentPolicyId", listKey: "paymentPolicies", column: "payment_policy_id" },
  { kind: "return", path: "return_policy", idField: "returnPolicyId", listKey: "returnPolicies", column: "return_policy_id" },
] as const;

const stripControl = (s: string) =>
  Array.from(s).filter(ch => ch.charCodeAt(0) >= 32).join("");

type LocationCfg = {
  name?: string; addressLine1?: string; city?: string;
  stateOrProvince?: string; postalCode?: string;
};

let APPS: Record<string, {
  clientId?: string; clientSecret?: string;
  location?: LocationCfg;
  policyNames?: Record<string, Record<string, string>>;
}> = {};
let APPS_ERROR = "";
{
  const raw = (Deno.env.get("EBAY_APPS") || "").trim();
  if (raw) {
    for (const text of [raw, stripControl(raw)]) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          APPS = parsed; APPS_ERROR = ""; break;
        }
      } catch (err) {
        APPS_ERROR = String(err instanceof Error ? err.message : err);
      }
    }
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status, headers: { "Content-Type": "application/json" },
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

async function loadStore(store: string) {
  const res = await sb(`ebay_stores?store_code=eq.${encodeURIComponent(store)}&select=*`);
  return (await res.json())[0] || null;
}

async function patchStore(store: string, patch: Record<string, unknown>) {
  await sb(`ebay_stores?store_code=eq.${encodeURIComponent(store)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

// --- tokens -----------------------------------------------------------------

async function accessTokenFor(row: any): Promise<string> {
  const expiresAt = row.access_token_expires_at ? Date.parse(row.access_token_expires_at) : 0;
  if (row.access_token && expiresAt - Date.now() > 60000) return row.access_token;

  const creds = APPS[row.store_code];
  if (!creds?.clientId || !creds?.clientSecret) {
    throw new Error(`no clientId/clientSecret in EBAY_APPS for ${row.store_code}`);
  }
  const res = await fetch(`${HOSTS[row.environment as "production" | "sandbox"]}/identity/v1/oauth2/token`, {
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
  await patchStore(row.store_code, {
    access_token: tok.access_token,
    access_token_expires_at: new Date(Date.now() + (tok.expires_in ?? 7200) * 1000).toISOString(),
  });
  return tok.access_token;
}

// --- eBay -------------------------------------------------------------------

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
    ? body.errors.map((e: any) => `${e.errorId}: ${e.message}`).join("; ")
    : typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);

// Defaults used only by &create=1 on an account with nothing set up.
const CREATE_BODIES: Record<string, any> = {
  fulfillment: {
    name: "Shipping Default",
    marketplaceId: MARKETPLACE,
    categoryTypes: [{ name: CATEGORY_TYPE }],
    handlingTime: { value: 2, unit: "DAY" },
    shippingOptions: [{
      optionType: "DOMESTIC",
      costType: "FLAT_RATE",
      shippingServices: [{
        sortOrder: 1,
        shippingCarrierCode: "USPS",
        shippingServiceCode: "USPSGroundAdvantage",
        shippingCost: { value: "0.00", currency: "USD" },
        freeShipping: true,
      }],
    }],
  },
  payment: {
    name: "Payment Default",
    marketplaceId: MARKETPLACE,
    categoryTypes: [{ name: CATEGORY_TYPE }],
    immediatePay: true,
  },
  return: {
    name: "Return Default",
    marketplaceId: MARKETPLACE,
    categoryTypes: [{ name: CATEGORY_TYPE }],
    returnsAccepted: true,
    returnPeriod: { value: 30, unit: "DAY" },
    returnShippingCostPayer: "BUYER",
    refundMethod: "MONEY_BACK",
  },
};

const SANDBOX_PLACEHOLDER: Required<LocationCfg> = {
  name: "SPEEKS Sandbox Location",
  addressLine1: "1 Test Street",
  city: "Overland Park",
  stateOrProvince: "KS",
  postalCode: "66210",
};

// Machine auth, same secret and reasoning as shopify-live. This one creates
// merchant locations and binds business policies — config that every listing
// then inherits.
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
  const dry = url.searchParams.get("dry") === "1";
  const create = url.searchParams.get("create") === "1";

  if (!store) return json({ error: "pass ?store=OVL" }, 400);
  if (APPS_ERROR) return json({ error: `EBAY_APPS failed to parse: ${APPS_ERROR}` }, 500);

  const row = await loadStore(store);
  if (!row) return json({ error: `no ebay_stores row for ${store} — run ebay-oauth first` }, 404);

  const host = HOSTS[row.environment as "production" | "sandbox"];
  const api = ebayClient(host, await accessTokenFor(row));

  // Fetch every policy once; both list mode and matching work off this.
  const found: Record<string, { name: string; id: string }[]> = {};
  for (const k of KINDS) {
    const res = await api(`/sell/account/v1/${k.path}?marketplace_id=${MARKETPLACE}`);
    found[k.kind] = (res.body?.[k.listKey] || [])
      .map((p: any) => ({ name: p.name, id: p[k.idField] }));
  }

  // --- read-only inventory of what the account actually has -----------------
  if (url.searchParams.get("list") === "1") {
    return json({
      store,
      environment: row.environment,
      policies: found,
      expectedNames: APPS[store]?.policyNames || DEFAULT_POLICY_NAMES,
      hint: "compare these names against expectedNames; mismatches are why a "
        + "profile would fail to resolve",
    });
  }

  const names = APPS[store]?.policyNames || DEFAULT_POLICY_NAMES;
  const profiles: Record<string, Record<string, string>> = {};
  const report: Record<string, any> = {};
  const missing: string[] = [];

  for (const [profile, wanted] of Object.entries(names)) {
    const resolved: Record<string, string> = {};
    const detail: Record<string, string> = {};

    for (const k of KINDS) {
      const wantName = wanted[k.kind];
      if (!wantName) { detail[k.kind] = "not configured for this profile"; continue; }

      const hit = found[k.kind].find(p => p.name === wantName);
      if (hit) {
        resolved[k.kind] = hit.id;
        detail[k.kind] = `"${wantName}" -> ${hit.id}`;
        continue;
      }

      if (!create) {
        detail[k.kind] = `NOT FOUND: no ${k.kind} policy named "${wantName}"`;
        missing.push(`${profile}.${k.kind} ("${wantName}")`);
        continue;
      }
      if (dry) { detail[k.kind] = `would create "${wantName}"`; continue; }

      const made = await api(`/sell/account/v1/${k.path}`, {
        method: "POST",
        body: JSON.stringify({ ...CREATE_BODIES[k.kind], name: wantName }),
      });
      if (made.status >= 300) {
        detail[k.kind] = `create failed: ${errText(made.body)}`;
        missing.push(`${profile}.${k.kind}`);
        continue;
      }
      resolved[k.kind] = made.body?.[k.idField];
      detail[k.kind] = `created "${wantName}" -> ${made.body?.[k.idField]}`;
    }

    profiles[profile] = resolved;
    report[profile] = detail;
  }

  // --- merchant location ----------------------------------------------------
  const patch: Record<string, unknown> = {};
  if (row.merchant_location_key) {
    report.location = `already set (${row.merchant_location_key})`;
  } else {
    const cfg = APPS[store]?.location;
    const haveReal = cfg?.addressLine1 && cfg?.city && cfg?.stateOrProvince && cfg?.postalCode;

    if (!haveReal && row.environment === "production") {
      report.location = "refused: production needs a real address in EBAY_APPS.location "
        + "(ship-from drives buyer shipping estimates and sales tax)";
    } else {
      const addr = haveReal ? { ...SANDBOX_PLACEHOLDER, ...cfg } : SANDBOX_PLACEHOLDER;
      const key = `${store}-STORE`;
      const existing = await api("/sell/inventory/v1/location");
      const match = (existing.body?.locations || [])
        .find((l: any) => l.merchantLocationKey === key);

      if (match) {
        report.location = `found existing (${key})`;
        patch.merchant_location_key = key;
      } else if (dry) {
        report.location = `would create (${key})`;
      } else {
        const made = await api(`/sell/inventory/v1/location/${encodeURIComponent(key)}`, {
          method: "POST",
          body: JSON.stringify({
            name: addr.name,
            merchantLocationStatus: "ENABLED",
            locationTypes: ["STORE"],
            location: {
              address: {
                addressLine1: addr.addressLine1, city: addr.city,
                stateOrProvince: addr.stateOrProvince, postalCode: addr.postalCode,
                country: "US",
              },
            },
          }),
        });
        report.location = made.status < 300 ? `created (${key})`
          : `create failed: ${errText(made.body)}`;
        if (made.status < 300) patch.merchant_location_key = key;
      }
    }
  }

  // --- persist --------------------------------------------------------------
  if (!dry) {
    patch.policy_profiles = profiles;
    // The flat columns mirror the standard profile so the existing sync and
    // inventory functions keep working unchanged.
    const std = profiles.standard || {};
    for (const k of KINDS) if (std[k.kind]) patch[k.column] = std[k.kind];
    await patchStore(store, patch);
  }

  const standardComplete = KINDS.every(k => (profiles.standard || {})[k.kind]);

  return json({
    store,
    environment: row.environment,
    dryRun: dry,
    createEnabled: create,
    profiles: report,
    resolvedIds: profiles,
    missing,
    readyToPublish: standardComplete
      && Boolean(patch.merchant_location_key ?? row.merchant_location_key),
    note: missing.length
      ? "run ?list=1 to see the exact policy names on the account"
      : undefined,
  });
});
