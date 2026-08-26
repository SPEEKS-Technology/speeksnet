// ============================================================================
// ebay-refund-reprobe — re-measure the duplicate-refund damage against eBay's
// CURRENT state, without disturbing the Aug-25 baseline.
//
//   ?secret=<ops secret>&store=OVL        one store
//   ?secret=<ops secret>&store=ALL        all five (may run long; prefer per-store)
//
// WHY THIS EXISTS: `refund_damage` is a stored snapshot probed once at
// 2026-08-25 20:05 UTC. Reading it back proves nothing about today — it just
// returns what eBay said then. 227 of the 396 refunded orders were still PAID
// on eBay at that moment ($49,677.36), and whether that is permanent safety or
// merely a queue is an open question. Only a fresh probe answers it.
//
// Results land in `refund_reprobe`, a SECOND dated snapshot. The baseline tables
// are never written to: they are the evidence behind the corporate escalation,
// and growth is a DIFF, which is only possible if the baseline survives.
//
// ⚠️ READ-ONLY AGAINST EBAY, ENFORCED NOT ASSUMED. `ebayGet()` is the only path
// to eBay in this file and it refuses anything that is not a GET on a
// /sell/fulfillment/v1/order/ URL. That matters more than usual here: issueRefund
// is POST /sell/fulfillment/v1/order/{id}/issue_refund — same API, same path
// prefix, one verb away from re-inflicting the very damage being measured.
//
// The access token is minted in memory and deliberately NOT persisted, so this
// function writes nothing except its own results table.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";

const HOSTS: Record<string, string> = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};

// EBAY_APPS arrives as a hand-pasted JSON secret and has carried literal line
// breaks before, which JSON.parse rejects outright.
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

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

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

// --- the only door to eBay ---------------------------------------------------
const ORDER_URL_RE = /^https:\/\/api(?:\.sandbox)?\.ebay\.com\/sell\/fulfillment\/v1\/order\/[^/]+$/;

async function ebayGet(url: string, token: string): Promise<Response> {
  // A trailing path segment is what turns a read into issue_refund, so the
  // pattern is anchored: exactly one order id and nothing after it.
  if (!ORDER_URL_RE.test(url)) {
    throw new Error(`refused: not a read-only eBay order URL -> ${url}`);
  }
  return await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

// Minted per run, never written back to ebay_stores.
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
    // An expired refresh token returns 400 here. Surfacing it loudly matters:
    // a 401 further down reads as "no damage found", which is the single most
    // dangerous way this probe can fail.
    throw new Error(`token refresh failed for ${row.store_code}: ${res.status} ${text.slice(0, 200)}`);
  }
  return tok.access_token;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  const want = (url.searchParams.get("store") || "").toUpperCase().trim();
  if (!want) return json({ error: "pass ?store=OVL or ?store=ALL" }, 400);
  const runAt = new Date().toISOString();

  const storeRows = await (await sb("ebay_stores?select=store_code,environment,refresh_token,scopes")).json();
  const targets = want === "ALL"
    ? storeRows
    : storeRows.filter((s: any) => s.store_code === want);
  if (!targets.length) return json({ error: `no ebay_stores row for ${want}` }, 404);

  const report: any[] = [];

  for (const st of targets) {
    const baseline = await (await sb(
      `refund_damage?select=store_code,order_name,ebay_order_id,shopify_refund,ebay_refund_total,ebay_payment_status`
      + `&store_code=eq.${encodeURIComponent(st.store_code)}`)).json();

    let token: string;
    try {
      token = await mintToken(st);
    } catch (e) {
      report.push({ store: st.store_code, error: String(e), probed: 0 });
      continue;
    }

    const host = HOSTS[st.environment as string] || HOSTS.production;
    const out: any[] = [];

    // Bounded concurrency: 396 sequential round trips would run past the edge
    // wall clock, and an unbounded fan-out invites an eBay rate-limit block
    // whose 429 would then be recorded as "no refund".
    const queue = [...baseline];
    const worker = async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        let rec: any = {
          run_at: runAt,
          store_code: row.store_code,
          order_name: row.order_name,
          ebay_order_id: row.ebay_order_id,
          shopify_refund: row.shopify_refund,
          base_refund_total: row.ebay_refund_total,
          base_payment_status: row.ebay_payment_status,
        };
        try {
          const r = await ebayGet(
            `${host}/sell/fulfillment/v1/order/${encodeURIComponent(row.ebay_order_id)}`, token);
          rec.status_code = r.status;
          const body = await r.json().catch(() => null);
          rec.body = body;
          if (r.status === 200 && body) {
            const refunds = body?.paymentSummary?.refunds || [];
            let total = 0;
            let latest: string | null = null;
            for (const rf of refunds) {
              total += num(rf?.amount?.value) || 0;
              if (rf?.refundDate && (!latest || rf.refundDate > latest)) latest = rf.refundDate;
            }
            rec.ebay_payment_status = body?.orderPaymentStatus ?? null;
            rec.ebay_order_total = num(body?.pricingSummary?.total?.value);
            rec.ebay_refund_total = refunds.length ? Math.round(total * 100) / 100 : 0;
            rec.ebay_refund_date = latest;
            rec.ebay_cancel_state = body?.cancelStatus?.cancelState ?? null;
            rec.ebay_fulfillment_status = body?.orderFulfillmentStatus ?? null;
          }
        } catch (e) {
          rec.status_code = -1;
          rec.body = { error: String(e) };
        }
        out.push(rec);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));

    for (let i = 0; i < out.length; i += 100) {
      await sb("refund_reprobe", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(out.slice(i, i + 100)),
      });
    }

    const ok = out.filter((r) => r.status_code === 200);
    const newly = ok.filter((r) =>
      (Number(r.ebay_refund_total) || 0) > 0 && (Number(r.base_refund_total) || 0) === 0);
    report.push({
      store: st.store_code,
      probed: out.length,
      http_200: ok.length,
      non_200: out.length - ok.length,
      // The headline: rows that were clean at the baseline and are refunded now.
      newly_propagated: newly.length,
      newly_propagated_amount: Math.round(newly.reduce((a, r) => a + (Number(r.ebay_refund_total) || 0), 0) * 100) / 100,
      newly_propagated_orders: newly.map((r) => r.order_name),
      total_refunded_now: Math.round(ok.reduce((a, r) => a + (Number(r.ebay_refund_total) || 0), 0) * 100) / 100,
      still_paid: ok.filter((r) => (Number(r.ebay_refund_total) || 0) === 0).length,
    });
  }

  // A store that failed to mint a token, or any non-200, must not be read as
  // "clean" — say so in the response rather than leaving it to the reader.
  const unreliable = report.filter((r) => r.error || r.non_200 > 0).map((r) => r.store);
  return json({
    run_at: runAt,
    readOnly: "GET /sell/fulfillment/v1/order/{id} only; no token persisted",
    baselinePreserved: "refund_probe / refund_probe_lee untouched; results in refund_reprobe",
    unreliable: unreliable.length ? unreliable : null,
    report,
  });
});
