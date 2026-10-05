// ============================================================================
// ebay-fee-mix — what eBay charged each store, by kind of fee, this month.
//
//   ?secret=<ops>[&ym=2026-09][&store=BAL][&dry=1]
//
// Fills ebay_fee_month (see 0132 for why). Default: the current Central month,
// plus last month on days 1–5 (refund credits keep landing against it). Run at
// 3pm Central by np-fee-mix-3pm, after the 2pm Net Profit pass. It takes no
// Apps Script lock and writes nothing the NP chain reads.
//
// ⚠️ READ-ONLY AGAINST EBAY, ENFORCED NOT ASSUMED. sell.finances is the scope
// that also gates issueRefund, so — exactly as in ebay-fee-probe — every call out
// of this file goes through ebayGet(), which refuses anything that is not a GET
// on /sell/finances/v1/transaction. The token is minted in memory, never kept.
//
// MONTH WINDOW. Finances filters on transactionDate as a UTC instant. A Central
// month starts at 05:00Z in daylight time and 06:00Z in standard time, so the
// window is built from the real Chicago offset on each boundary. The NP tab books
// eBay fees to the SALE day through the order; this tallies by the day eBay
// posted the transaction. The two can differ by the odd order at a month edge,
// which is why this table explains the NP fee rather than replacing it.
// ============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const OPS_SECRET = Deno.env.get("SYNC_SECRET") || "sp33ks-sync-k3y-2026-x9mq";
const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const FIN_HOST: Record<string, string> = {
  production: "https://apiz.ebay.com", sandbox: "https://apiz.sandbox.ebay.com",
};
const AUTH_HOST: Record<string, string> = {
  production: "https://api.ebay.com", sandbox: "https://api.sandbox.ebay.com",
};

const stripControl = (s: string) => Array.from(s).filter((ch) => ch.charCodeAt(0) >= 32).join("");
let EBAY_APPS: Record<string, any> = {};
{
  const raw = (Deno.env.get("EBAY_APPS") || "").trim();
  for (const text of [raw, stripControl(raw)]) {
    if (!text) break;
    try { const p = JSON.parse(text); if (p && typeof p === "object") { EBAY_APPS = p; break; } } catch { /* next */ }
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

// --- the only door to eBay ---------------------------------------------------
const FIN_URL_RE = /^https:\/\/apiz(?:\.sandbox)?\.ebay\.com\/sell\/finances\/v1\/transaction(?:\?.*)?$/;
async function ebayGet(url: string, token: string): Promise<Response> {
  if (!FIN_URL_RE.test(url)) throw new Error(`refused: not a read-only eBay finances URL -> ${url}`);
  return await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
}

async function mintToken(row: any): Promise<string> {
  const creds = EBAY_APPS[row.store_code];
  if (!creds) throw new Error(`no EBAY_APPS entry for ${row.store_code}`);
  const host = AUTH_HOST[row.environment as string] || AUTH_HOST.production;
  const res = await fetch(`${host}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: row.refresh_token, scope: row.scopes || "" }),
  });
  const text = await res.text();
  let tok: any = null;
  try { tok = JSON.parse(text); } catch { /* below */ }
  if (!tok?.access_token) throw new Error(`token refresh failed for ${row.store_code}: ${res.status} ${text.slice(0, 300)}`);
  return tok.access_token;
}

// The UTC instant of Central midnight starting a given day.
function centralMidnightUtc(y: number, m: number, d: number): string {
  // Probe noon UTC that day for Chicago's offset; noon is never near a DST jump.
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  const chi = new Date(probe.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const utc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
  const offH = Math.round((utc.getTime() - chi.getTime()) / 3600000);   // 5 or 6
  return new Date(Date.UTC(y, m - 1, d, offH)).toISOString().slice(0, 23) + "Z";
}
function centralYm(): { ym: string; day: number } {
  const d = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  return { ym: d.slice(0, 7), day: Number(d.slice(8, 10)) };
}
const prevYm = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

async function tallyMonth(st: any, token: string, ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const from = centralMidnightUtc(y, m, 1);
  const to = m === 12 ? centralMidnightUtc(y + 1, 1, 1) : centralMidnightUtc(y, m + 1, 1);
  const host = FIN_HOST[st.environment as string] || FIN_HOST.production;
  // SALE and REFUND only: a refund is where a fee credit comes back. Payouts,
  // disputes and account-level charges are not fees on a sale (netprofit-collect
  // excludes them from NP for the same reason).
  const filter = `transactionDate:[${from}..${to}],transactionType:{SALE|REFUND}`;
  const pageUrl = (off: number) => `${host}/sell/finances/v1/transaction?limit=200&offset=${off}`
    + `&filter=${encodeURIComponent(filter)}`;

  const txs: any[] = [];
  let total = Infinity;
  for (let off = 0; off < total && off < 20000; off += 200) {
    let res = await ebayGet(pageUrl(off), token);
    // eBay's Finances API throws the odd transient 500 (seen on OVL, Sep probe).
    if (res.status >= 500) { await new Promise((r) => setTimeout(r, 1500)); res = await ebayGet(pageUrl(off), token); }
    if (res.status !== 200) throw new Error(`finances HTTP ${res.status} at offset ${off}: ${(await res.text()).slice(0, 200)}`);
    const b = await res.json();
    total = Number(b?.total) || 0;
    for (const t of b?.transactions || []) txs.push(t);
    if (!(b?.transactions || []).length) break;
  }

  const byType: Record<string, number> = {};
  let ebaySales = 0, saleLines = 0, inadLines = 0;
  for (const t of txs) {
    const isSale = t.transactionType === "SALE";
    for (const li of t?.orderLineItems || []) {
      if (isSale) {
        saleLines++;
        ebaySales += Number(li?.feeBasisAmount?.value) || 0;
      }
      for (const f of li?.marketplaceFees || []) {
        const ft = String(f?.feeType || "UNKNOWN");
        const amt = Number(f?.amount?.value) || 0;
        // A SALE's line fees are what eBay kept from it; a REFUND's line fees are
        // what eBay handed back (the fee credit), so they come off the same kind.
        // Same convention as netprofit-collect's SALE-minus-REFUND fee.
        const signed = isSale ? amt : -amt;
        byType[ft] = (byType[ft] || 0) + signed;
        if (isSale && ft === "HIGH_ITEM_NOT_AS_DESCRIBED_FEE") inadLines++;
      }
    }
  }
  for (const k of Object.keys(byType)) byType[k] = r2(byType[k]);
  const pick = (k: string) => byType[k] || 0;
  const known = ["FINAL_VALUE_FEE", "FINAL_VALUE_FEE_FIXED_PER_ORDER", "HIGH_ITEM_NOT_AS_DESCRIBED_FEE", "INTERNATIONAL_FEE"];
  const other = r2(Object.entries(byType).filter(([k]) => !known.includes(k)).reduce((a, [, v]) => a + v, 0));
  const row = {
    store: st.store_code, ym,
    ebay_sales: r2(ebaySales), sale_lines: saleLines,
    fvf: pick("FINAL_VALUE_FEE"), fvf_fixed: pick("FINAL_VALUE_FEE_FIXED_PER_ORDER"),
    inad: pick("HIGH_ITEM_NOT_AS_DESCRIBED_FEE"), inad_lines: inadLines,
    intl: pick("INTERNATIONAL_FEE"), other, by_type: byType,
    total: r2(Object.values(byType).reduce((a, v) => a + v, 0)),
    synced_at: new Date().toISOString(),
  };
  return { row, transactions: txs.length, window: { from, to } };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);
  const dry = url.searchParams.get("dry") === "1";
  const askedYm = (url.searchParams.get("ym") || "").trim();
  const now = centralYm();
  const months = /^\d{4}-\d{2}$/.test(askedYm) ? [askedYm] : (now.day <= 5 ? [prevYm(now.ym), now.ym] : [now.ym]);
  const onlyStore = (url.searchParams.get("store") || "").toUpperCase().trim();
  const codes = onlyStore ? [onlyStore] : STORES;

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: stores, error } = await sb.from("ebay_stores")
    .select("store_code, environment, refresh_token, scopes").in("store_code", codes);
  if (error) return json({ ok: false, error: error.message }, 500);

  // Stores in parallel: each is its own eBay account, so they do not share a
  // rate limit, and one store failing must not cost the others their row.
  const results = await Promise.all((stores || []).map(async (st: any) => {
    const out: any = { store: st.store_code, months: [] };
    try {
      const token = await mintToken(st);
      for (const ym of months) {
        const t = await tallyMonth(st, token, ym);
        out.months.push({ ym, transactions: t.transactions, ...t.row, by_type: t.row.by_type });
        if (!dry) {
          const { error: e } = await sb.from("ebay_fee_month").upsert(t.row, { onConflict: "store,ym" });
          if (e) throw new Error("upsert: " + e.message);
        }
      }
    } catch (e) {
      out.error = String((e as Error)?.message || e);
    }
    return out;
  }));
  return json({ ok: results.every((r) => !r.error), dry, months, results });
});
