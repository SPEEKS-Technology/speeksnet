// ============================================================================
// ebay-category — ask a CATEGORY what it will accept, before a listing dies.
//
//   ?store=LEE&category=183454&secret=...
//
// Two SPEEKS Connect listings failed at PUBLISH for reasons nothing had asked
// the category about first:
//   * 25059 — condition 3000 rejected by "CCG Individual Cards" (183454)
//   * 25002 — "Compatible Brand is missing" in "Replacement Parts & Tools"
//
// ebay-sync already calls get_item_condition_policies through its
// allowedConditionIds() helper, but that helper returns null on an empty or
// failed answer and then lets the publish proceed unconstrained — which is
// exactly how a bad condition reaches eBay. This reports the RAW answer so the
// difference between "the category allows 3000" and "the category told us
// nothing" is visible instead of inferred.
//
// Read-only, and constrained to two metadata endpoints — not a general proxy.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const HOSTS: Record<string, string> = {
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

// Same refresh dance as ebay-peek: the stored access token is short-lived and a
// diagnostic that only works for two hours after someone last listed is not one.
async function accessToken(row: any): Promise<string> {
  const expiresAt = row.access_token_expires_at ? Date.parse(row.access_token_expires_at) : 0;
  if (row.access_token && expiresAt - Date.now() > 60000) return row.access_token;
  const creds = EBAY_APPS[row.store_code];
  if (!creds) throw new Error(`no EBAY_APPS entry for ${row.store_code}`);
  const res = await fetch(`${HOSTS[row.environment] || HOSTS.production}/identity/v1/oauth2/token`, {
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

const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
function opsAuthed(url: URL): boolean {
  const given = url.searchParams.get("secret") || "";
  if (given.length !== OPS_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) diff |= given.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!opsAuthed(url)) return json({ error: "unauthorised" }, 401);
  const store = (url.searchParams.get("store") || "").toUpperCase().trim();
  const category = (url.searchParams.get("category") || "").trim();
  // &all=1 — every aspect, not just the required ones.
  //
  // Some aspects are CONDITIONALLY required and do not appear in the required
  // list at all: a graded trading card must carry Professional Grader, Grade and
  // Certification Number, but only once its condition is Graded (2750). Asking
  // for the required set alone says the card needs nothing but Game, and then
  // publish fails with 25064 anyway.
  const wantAll = url.searchParams.get("all") === "1";
  if (!store || !category) return json({ error: "pass ?store=LEE&category=183454" }, 400);

  const row = (await (await sb(
    `ebay_stores?store_code=eq.${encodeURIComponent(store)}&select=*`)).json())[0];
  if (!row) return json({ error: `no ebay_stores row for ${store}` }, 404);

  const host = HOSTS[row.environment] || HOSTS.production;
  const token = await accessToken(row);
  const get = async (path: string) => {
    const r = await fetch(`${host}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Accept-Language": "en-US",
        "Content-Language": "en-US",
      },
    });
    const t = await r.text();
    try { return { status: r.status, body: t ? JSON.parse(t) : null }; }
    catch { return { status: r.status, body: t }; }
  };

  const cat = encodeURIComponent(category);
  // Marketplace is fixed: this integration only ever lists to EBAY_US.
  const cond = await get(
    `/sell/metadata/v1/marketplace/EBAY_US/get_item_condition_policies?filter=categoryIds:{${cat}}`);
  const asp = await get(
    `/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${cat}`);

  const policy = (cond.body?.itemConditionPolicies || [])[0] || null;
  const conditions = (policy?.itemConditions || [])
    .map((c: any) => ({ id: Number(c.conditionId), name: c.conditionDescription }));

  return json({
    store,
    category,
    condition: {
      status: cond.status,
      required: policy?.itemConditionRequired ?? null,
      allowed: conditions,
      // The distinction that matters: an empty list is NOT "anything goes", it
      // is "we were told nothing", and ebay-sync treats the two identically.
      note: conditions.length ? undefined
        : "EMPTY — allowedConditionIds() returns null here, so nothing constrains the condition we send",
      raw: conditions.length ? undefined : cond.body,
      // &all=1 dumps the WHOLE policy. Condition DESCRIPTORS live here, not in
      // the aspect list: a graded card is refused with "Professional Grader
      // (27501) is a required field" even though no aspect of that name exists.
      rawConditionPolicy: wantAll ? cond.body : undefined,
    },
    requiredAspects: (asp.body?.aspects || [])
      .filter((a: any) => a.aspectConstraint?.aspectRequired)
      .map((a: any) => ({
        name: a.localizedAspectName,
        mode: a.aspectConstraint?.aspectMode,          // FREE_TEXT vs SELECTION_ONLY
        sampleValues: (a.aspectValues || []).slice(0, 12).map((v: any) => v.localizedValue),
        valueCount: (a.aspectValues || []).length,
      })),
    aspectStatus: asp.status,
    allAspects: wantAll ? (asp.body?.aspects || []).map((a: any) => ({
      name: a.localizedAspectName,
      required: !!a.aspectConstraint?.aspectRequired,
      mode: a.aspectConstraint?.aspectMode,
      valueCount: (a.aspectValues || []).length,
      sampleValues: (a.aspectValues || []).slice(0, 14).map((v: any) => v.localizedValue),
    })) : undefined,
  });
});
