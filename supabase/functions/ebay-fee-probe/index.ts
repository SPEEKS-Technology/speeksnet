// ============================================================================
// ebay-fee-probe — read-only reconnaissance against eBay's Finances API.
//
//   ?secret=<ops>&store=OVL&from=2026-07-01&to=2026-07-31[&type=SALE][&raw=1]
//
// Two jobs, both one-off:
//   1. PROVE the sell.finances grant actually works. `ebay_stores.scopes` records
//      what we ASKED for (ebay-oauth writes its own SCOPES constant, not the
//      token response), so a row reading "sell.finances" is not evidence. Only a
//      200 from this endpoint is.
//   2. Learn the real response shape before wiring fees into netprofit-collect.
//
// ⚠️ READ-ONLY, ENFORCED NOT ASSUMED — same guard as ebay-refund-reprobe, and for
// the same reason. sell.finances is the scope that gates issueRefund
// (POST /sell/fulfillment/v1/order/{id}/issue_refund). Having it is the whole
// risk we accepted, so every call out of this file goes through ebayGet(), which
// refuses anything that is not a GET on /sell/finances/v1/transaction.
//
// The access token is minted in memory and never persisted. This function writes
// NOTHING — not to eBay, not to Supabase.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";

// The Finances API does NOT live on api.ebay.com — it is served from apiz.
// Getting this wrong returns a 404 that reads exactly like "no transactions".
const FIN_HOST: Record<string, string> = {
  production: "https://apiz.ebay.com",
  sandbox: "https://apiz.sandbox.ebay.com",
};
const AUTH_HOST: Record<string, string> = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};

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

// --- the only door to eBay ---------------------------------------------------
const FIN_URL_RE = /^https:\/\/apiz(?:\.sandbox)?\.ebay\.com\/sell\/finances\/v1\/transaction(?:\?.*)?$/;

async function ebayGet(url: string, token: string): Promise<Response> {
  if (!FIN_URL_RE.test(url)) {
    throw new Error(`refused: not a read-only eBay finances URL -> ${url}`);
  }
  return await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
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
    // If the consent did NOT actually grant sell.finances, this is where it
    // shows up — asking for a scope the refresh token does not carry is
    // refused here, not at the API call. Surface it verbatim.
    throw new Error(`token refresh failed for ${row.store_code}: ${res.status} ${text.slice(0, 400)}`);
  }
  return tok.access_token;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  const store = (url.searchParams.get("store") || "").toUpperCase().trim();
  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || "").trim();
  const wantType = (url.searchParams.get("type") || "").trim().toUpperCase();
  const raw = url.searchParams.get("raw") === "1";
  if (!store || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return json({ error: "pass ?store=OVL&from=YYYY-MM-DD&to=YYYY-MM-DD" }, 400);
  }

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/ebay_stores?select=store_code,environment,refresh_token,scopes`
    + `&store_code=eq.${encodeURIComponent(store)}`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  const rows = await r.json();
  if (!rows.length) return json({ error: `no ebay_stores row for ${store}` }, 404);
  const st = rows[0];

  let token: string;
  try { token = await mintToken(st); }
  catch (e) { return json({ store, stage: "token", grantWorks: false, error: String(e) }, 502); }

  const host = FIN_HOST[st.environment as string] || FIN_HOST.production;
  // eBay wants an exclusive upper bound as an instant, so `to` is pushed to the
  // start of the NEXT day rather than 23:59:59 — a same-day upper bound of
  // midnight would silently drop the last day of the range.
  const toExclusive = new Date(`${to}T00:00:00.000Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  const filters = [
    `transactionDate:[${from}T00:00:00.000Z..${toExclusive.toISOString().slice(0, 23)}Z]`,
  ];
  if (wantType) filters.push(`transactionType:{${wantType}}`);

  const pageUrl = (offset: number) => `${host}/sell/finances/v1/transaction`
    + `?limit=200&offset=${offset}&filter=${encodeURIComponent(filters.join(","))}`;

  const first = pageUrl(0);
  let res: Response;
  try { res = await ebayGet(first, token); }
  catch (e) { return json({ store, stage: "guard", error: String(e) }, 500); }

  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* reported below */ }

  if (res.status !== 200) {
    return json({
      store, stage: "finances", grantWorks: false,
      status: res.status,
      // A 403 here with errorId 1100 means the token is fine but the keyset is
      // not entitled to the Finances API — a developer-portal problem, not ours.
      body: body ?? text.slice(0, 800),
      urlShape: first.replace(/filter=.*/, "filter=<...>"),
    }, 502);
  }

  const txs: any[] = body?.transactions || [];

  // Page the WHOLE range when asked. A 200-row first page out of 655 tallies to
  // a confident, wrong answer — and the types are not evenly distributed through
  // the month, so page 1 is not a sample you can scale up.
  if (url.searchParams.get("all") === "1") {
    const total = Number(body?.total) || txs.length;
    for (let off = 200; off < total && off < 20000; off += 200) {
      const r2 = await ebayGet(pageUrl(off), token);
      if (r2.status !== 200) {
        return json({ store, stage: "paging", offset: off, status: r2.status,
          body: (await r2.text()).slice(0, 400) }, 502);
      }
      const b2 = await r2.json();
      for (const t of b2?.transactions || []) txs.push(t);
    }
  }
  // bookingEntry (CREDIT / DEBIT) is tallied per type because it is what decides
  // the SIGN. Assuming a REFUND fee is negative because refunds feel negative is
  // how a fee credit gets double-counted as a charge.
  const byType: Record<string, any> = {};
  for (const t of txs) {
    const k = String(t.transactionType || "?");
    const be = String(t.bookingEntry || "?");
    byType[k] = byType[k] || { n: 0, amount: 0, fees: 0, bookingEntry: {} };
    byType[k].n++;
    byType[k].amount += Number(t?.amount?.value) || 0;
    byType[k].fees += Number(t?.totalFeeAmount?.value) || 0;
    byType[k].bookingEntry[be] = (byType[k].bookingEntry[be] || 0) + 1;
  }
  for (const k of Object.keys(byType)) {
    byType[k].amount = Math.round(byType[k].amount * 100) / 100;
    byType[k].fees = Math.round(byType[k].fees * 100) / 100;
  }

  // ---------------------------------------------------------------------------
  // Fee types, because "eBay Fee" is not one number to Finance.
  // ---------------------------------------------------------------------------
  // The CFO builds his column off the Selling → Payments report, split two ways:
  //   "eBay New"   = Final Value Fee - fixed + Final Value Fee - variable
  //   "eBay Other" = regulatory operating, "item not as described", below-standard
  //                  performance, international, charity donation, deposit processing
  // Those are the report's LABELS. The API's equivalents live at
  // orderLineItems[].marketplaceFees[].feeType, which the collector never looked
  // at — it only ever summed totalFeeAmount. Tallying them here is what makes the
  // two sources comparable line for line instead of "the totals are close".
  //
  // ⚠️ Also tally the DIFFERENCE between totalFeeAmount and the sum of the line
  // fees. If a fee kind is charged at order level rather than per line item it
  // shows up here and nowhere else, and it would be invisible to a feeType tally
  // that trusted the parts to add up to the whole.
  const byFeeType: Record<string, { n: number; amount: number; onTxTypes: Record<string, number> }> = {};
  let lineFeeSum = 0, totalFeeSum = 0, txsWithFeeGap = 0, feeGap = 0;
  for (const t of txs) {
    const txType = String(t.transactionType || "?");
    const tot = Number(t?.totalFeeAmount?.value) || 0;
    let mine = 0;
    for (const li of t?.orderLineItems || []) {
      for (const f of li?.marketplaceFees || []) {
        const ft = String(f?.feeType || "?");
        const amt = Number(f?.amount?.value) || 0;
        byFeeType[ft] = byFeeType[ft] || { n: 0, amount: 0, onTxTypes: {} };
        byFeeType[ft].n++;
        byFeeType[ft].amount += amt;
        byFeeType[ft].onTxTypes[txType] = (byFeeType[ft].onTxTypes[txType] || 0) + 1;
        mine += amt;
      }
    }
    lineFeeSum += mine;
    totalFeeSum += tot;
    if (Math.abs(mine - tot) > 0.005) { txsWithFeeGap++; feeGap += tot - mine; }
  }
  for (const k of Object.keys(byFeeType)) {
    byFeeType[k].amount = Math.round(byFeeType[k].amount * 100) / 100;
  }
  const money = (n: number) => Math.round(n * 100) / 100;

  const sale = txs.find((t) => t.transactionType === "SALE");

  return json({
    store,
    grantWorks: true,
    range: { from, to },
    reportedTotal: body?.total ?? null,
    returnedOnThisPage: txs.length,
    // `total` is the whole result set; anything above `limit` needs paging in the
    // real collector. Stated explicitly so a 200-row page is never mistaken for
    // the whole month.
    needsPaging: (Number(body?.total) || 0) > txs.length,
    byType,
    // Every fee kind eBay actually charged, so the CFO's two buckets can be
    // rebuilt from the API instead of taken on trust.
    byFeeType,
    feeReconciliation: {
      sum_of_line_item_fees: money(lineFeeSum),
      sum_of_totalFeeAmount: money(totalFeeSum),
      // Non-zero means some fee is charged outside orderLineItems[].marketplaceFees
      // and a feeType tally alone would under-report it.
      unexplained: money(totalFeeSum - lineFeeSum),
      transactions_where_they_disagree: txsWithFeeGap,
      gap: money(feeGap),
    },
    fieldsOnFirstSale: sale ? Object.keys(sale) : null,
    sampleSale: sale ?? null,
    // One of each non-SALE type, so the sign and shape of every row that could
    // land in the fee or shipping column is visible rather than inferred.
    samplesByType: Object.fromEntries(
      [...new Set(txs.map((t) => String(t.transactionType)))]
        .filter((k) => k !== "SALE")
        .map((k) => [k, txs.find((t) => t.transactionType === k)])),
    ...(raw ? { firstThreeRaw: txs.slice(0, 3) } : {}),
  });
});
