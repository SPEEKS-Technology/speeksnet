// ============================================================================
// dupe-restate — what each store ACTUALLY sold per day, with the duplicate
// Marketplace Connect orders (and their reversals) taken back out.
//
//   ?secret=<ops>&store=OVL[&from=2026-08-01&to=2026-08-26]
//
// READ-ONLY. Computes and reports; writes nothing, to Shopify or to the sheet.
//
// METHOD (identical to the Aug-16-20 restatement in mpc-dupe-fix.gs, which
// reproduced BAL's pre-contamination figures 8/8 to the cent):
//   corrected(day) = FROM sales GROUP BY day
//                  − the same query GROUP BY day, order_name restricted to the
//                    orders named in dup_order_cleanup
//
// ⚠️ Subtract by SHOPIFY'S OWN day attribution, never by ebay_orders.sold_at —
// the two disagree for back-dated copies. Grouping by order_name also means the
// phantom sale AND its refund are both removed wherever Shopify happened to book
// them, so this needs no theory about which day a refund lands on.
//
// The `mc-backfill-2026-08-20` batch is EXCLUDED by default: those days (Aug
// 16-20, BAL/MPL) were already corrected and pinned as bare-number formulas.
// Subtracting them again would double-correct.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";

const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};

const DEFAULT_BATCHES = [
  "new-mc-adoption-2026-08-24",
  "newmc-stragglers-2026-08-25",
  "wsp-new-mc-adoption-2026-08-25",
  "ovl-new-mc-adoption-2026-08-25",
];

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
// Order names are compared loosely on purpose: the ledger stores "#MO01-9003"
// and a stray leading "#" or case difference must never silently fail to match,
// because an unmatched duplicate is money left in the corrected figure.
const key = (s: unknown) => String(s ?? "").trim().replace(/^#/, "").toUpperCase();

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  const store = (url.searchParams.get("store") || "").toUpperCase().trim();
  const from = (url.searchParams.get("from") || "2026-08-01").trim();
  const to = (url.searchParams.get("to") || "2026-08-26").trim();
  if (!SHOP_BY_STORE[store]) return json({ error: `unknown store "${store}"` }, 400);

  const batches = (url.searchParams.get("batches") || DEFAULT_BATCHES.join(","))
    .split(",").map((s) => s.trim()).filter(Boolean);

  const sbGet = async (path: string) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!r.ok) throw new Error(`supabase ${path}: ${r.status}`);
    return await r.json();
  };

  const shop = SHOP_BY_STORE[store];
  const tokRows = await sbGet(`shopify_stores?select=shop,store_code,access_token`);
  const t = tokRows.find((x: any) => x.store_code === store) || tokRows.find((x: any) => x.shop === shop);
  if (!t) return json({ error: `no shopify_stores row for ${store}` }, 404);

  const ql = async (q: string) => {
    const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t.access_token },
      body: JSON.stringify({
        query: `{ shopifyqlQuery(query: ${JSON.stringify(q)}) { parseErrors tableData { rows } } }`,
      }),
    });
    const b = await r.json();
    if (b.errors?.length) throw new Error(JSON.stringify(b.errors));
    const pe = b?.data?.shopifyqlQuery?.parseErrors;
    if (pe?.length) throw new Error(`shopifyql: ${pe.join("; ")}`);
    return b?.data?.shopifyqlQuery?.tableData?.rows || [];
  };

  // --- the duplicates ---------------------------------------------------------
  const inList = batches.map((b) => `"${b}"`).join(",");
  const dups = await sbGet(
    `dup_order_cleanup?select=order_name,total,batch&store_code=eq.${encodeURIComponent(store)}`
    + `&batch=in.(${encodeURIComponent(inList)})`);
  const dupKeys = new Set(dups.map((d: any) => key(d.order_name)));

  // --- current vs per-order ---------------------------------------------------
  const byDay = await ql(
    `FROM sales SHOW net_sales, cost_of_goods_sold GROUP BY day SINCE ${from} UNTIL ${to} ORDER BY day`);
  // ⚠️ ONE QUERY PER DAY, never `GROUP BY day, order_name` across the range.
  // ShopifyQL silently truncates a large result: OVL (the busiest store, ~1200
  // order-days in August) came back short, and because the dropped rows included
  // the big negative refund rows the per-order sums read HIGHER than the per-day
  // totals — a $27k phantom "correction" that would have been written into the
  // sheet as fact. Smaller stores reconciled fine, so this only shows up where
  // the money is largest. Per-day keeps every result well under the cap.
  const byOrder: any[] = [];
  for (const d of Object.keys(days).sort()) {
    const rows = await ql(
      `FROM sales SHOW net_sales, cost_of_goods_sold GROUP BY order_name SINCE ${d} UNTIL ${d}`);
    for (const r of rows) byOrder.push({ ...r, day: d });
  }

  const days: Record<string, any> = {};
  for (const row of byDay) {
    const d = String(row.day).slice(0, 10);
    days[d] = {
      day: d,
      sheet_now_sales: r2(Number(row.net_sales) || 0),
      sheet_now_cost: r2(Number(row.cost_of_goods_sold) || 0),
      dup_sales: 0, dup_cost: 0, dup_orders: 0,
    };
  }

  // Reconciliation guard: the per-order query is the one that could silently
  // truncate, and a short read would UNDER-subtract, leaving phantom money in a
  // "corrected" figure. Summing it back to the per-day totals proves it whole.
  const recon: Record<string, { s: number; c: number }> = {};
  const matched = new Set<string>();
  for (const row of byOrder) {
    const d = String(row.day).slice(0, 10);
    const s = Number(row.net_sales) || 0;
    const c = Number(row.cost_of_goods_sold) || 0;
    recon[d] = recon[d] || { s: 0, c: 0 };
    recon[d].s += s; recon[d].c += c;
    const k = key(row.order_name);
    if (!dupKeys.has(k) || !days[d]) continue;
    matched.add(k);
    days[d].dup_sales = r2(days[d].dup_sales + s);
    days[d].dup_cost = r2(days[d].dup_cost + c);
    days[d].dup_orders++;
  }

  const reconIssues: string[] = [];
  for (const d of Object.keys(days)) {
    const a = days[d], b = recon[d] || { s: 0, c: 0 };
    if (Math.abs(r2(b.s) - a.sheet_now_sales) > 0.02 || Math.abs(r2(b.c) - a.sheet_now_cost) > 0.02) {
      reconIssues.push(`${d}: per-order sums to ${r2(b.s)}/${r2(b.c)} but per-day says ${a.sheet_now_sales}/${a.sheet_now_cost}`);
    }
  }

  const list = Object.values(days)
    .map((d: any) => ({
      ...d,
      correct_sales: r2(d.sheet_now_sales - d.dup_sales),
      correct_cost: r2(d.sheet_now_cost - d.dup_cost),
    }))
    .sort((a: any, b: any) => (a.day < b.day ? -1 : 1));

  const changed = list.filter((d: any) => Math.abs(d.dup_sales) > 0.005 || Math.abs(d.dup_cost) > 0.005);
  const sum = (arr: any[], k: string) => r2(arr.reduce((a, r) => a + (Number(r[k]) || 0), 0));

  // An unmatched duplicate is money the correction misses. Name them.
  const unmatched = [...dupKeys].filter((k) => !matched.has(k));

  return json({
    store, from, to, batches,
    duplicates_in_ledger: dups.length,
    duplicates_matched_in_shopify: matched.size,
    // Expected to be non-empty and harmless: an order fully cancelled or falling
    // outside the window contributes nothing to any day, so it cannot be matched.
    duplicates_unmatched: unmatched,
    reconciliation: reconIssues.length ? reconIssues : "per-order sums match per-day totals on every day",
    month_totals: {
      sales_now: sum(list, "sheet_now_sales"), sales_correct: sum(list, "correct_sales"),
      cost_now: sum(list, "cost_now" in (list[0] || {}) ? "cost_now" : "sheet_now_cost"),
      cost_correct: sum(list, "correct_cost"),
      // Phantom sale and its reversal cancel, so a NON-zero delta here means the
      // reversal has not landed in the window and the month total really moves.
      sales_delta: r2(sum(list, "correct_sales") - sum(list, "sheet_now_sales")),
      cost_delta: r2(sum(list, "correct_cost") - sum(list, "sheet_now_cost")),
    },
    days_needing_correction: changed,
  });
});
