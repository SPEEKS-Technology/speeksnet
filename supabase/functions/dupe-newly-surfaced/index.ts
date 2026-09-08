// ============================================================================
// dupe-newly-surfaced — the duplicate orders eBay has STARTED showing as
// refunded since a given probe, in the master workbook's own column order.
//
//   ?secret=<ops>                       everything new since today 00:00 UTC
//   ?secret=<ops>&since=2026-08-27      new since that probe boundary
//   ?secret=<ops>&format=csv            CSV for pasting into the workbook
//
// READ ONLY. Reads refund_reprobe and refund_damage. No Shopify call, no eBay
// call, nothing written.
//
// WHY A DIFF AND NOT A LIST. eBay's order API does not show a refund until it
// settles, so an order reads PAID for a day or two after the money has actually
// gone. The 2026-08-27 sweep surfaced 83 orders that were all refunded back on
// Aug 25 — nothing new had happened, eBay had simply caught up. A plain list of
// refunded orders cannot tell those apart from a fresh incident; the diff can,
// which is the whole point of keeping every probe run instead of overwriting.
//
// The columns match the master workbook from column C onward (Store … eBay
// Refunded), so a paste lands in the right places without re-ordering.
// ============================================================================

const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 1), { status: s, headers: { "Content-Type": "application/json" } });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

// ⚠️ PostgREST caps a response at 1000 rows and says nothing about it, and
// refund_reprobe grows by ~400 rows on every sweep — it crossed the cap on the
// second run. Page it, always.
async function sbAll(path: string) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Range: `${from}-${from + 999}`,
      },
    });
    if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// The store's clock, not the server's. Written as the workbook writes it.
const CENTRAL = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
function central(iso: string | null) {
  if (!iso) return "";
  const p: any = {};
  for (const x of CENTRAL.formatToParts(new Date(iso))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const money = (v: any) => Math.round((Number(v) || 0) * 100) / 100;

const HEAD = [
  "Store", "Shopify Order", "SKU", "eBay Order ID", "eBay Order Total",
  "Shopify Refund Amount", "Shipped To Buyer", "Buyer Requested Refund",
  "Shopify Refunded (Central)", "eBay Refunded (Central)",
];

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  const since = (url.searchParams.get("since") || new Date().toISOString().slice(0, 10)).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return json({ error: "pass since=YYYY-MM-DD" }, 400);
  }

  const rows = await sbAll(
    `refund_reprobe?select=run_at,store_code,order_name,ebay_order_id,shopify_refund,`
    + `ebay_order_total,ebay_refund_total,ebay_refund_date,ebay_cancel_state,`
    + `ebay_fulfillment_status&order=ebay_order_id.asc,run_at.desc`);

  // Newest row overall, and newest row from BEFORE the boundary. An order counts
  // as newly surfaced when the first says refunded and the second said zero.
  const now: Record<string, any> = {};
  const before: Record<string, any> = {};
  for (const r of rows) {
    const id = String(r.ebay_order_id);
    if (!now[id]) now[id] = r;
    if (r.run_at < since && !before[id]) before[id] = r;
  }

  const damageRows = await sbAll(
    `refund_damage?select=ebay_order_id,sku,batch,shopify_refunded_at`);
  const damage: Record<string, any> = {};
  for (const d of damageRows) damage[String(d.ebay_order_id)] = d;

  const newly: any[] = [];
  let noPrior = 0;
  for (const [id, cur] of Object.entries(now)) {
    if (money((cur as any).ebay_refund_total) <= 0) continue;
    const was = before[id];
    // No earlier reading at all means we cannot say it is NEW — report the
    // count rather than quietly folding these in either direction.
    if (!was) { noPrior++; continue; }
    if (money(was.ebay_refund_total) > 0) continue;
    const d = damage[id] || {};
    newly.push({
      Store: (cur as any).store_code,
      "Shopify Order": (cur as any).order_name,
      SKU: d.sku ?? "",
      "eBay Order ID": id,
      "eBay Order Total": money((cur as any).ebay_order_total),
      "Shopify Refund Amount": money((cur as any).shopify_refund),
      "Shipped To Buyer": (cur as any).ebay_fulfillment_status === "FULFILLED" ? "Yes" : "No",
      "Buyer Requested Refund":
        (cur as any).ebay_cancel_state === "NONE_REQUESTED" ? "No" : (cur as any).ebay_cancel_state,
      "Shopify Refunded (Central)": central(d.shopify_refunded_at ?? null),
      "eBay Refunded (Central)": central((cur as any).ebay_refund_date),
      _batch: d.batch ?? "",
      _our_loss: money((cur as any).ebay_refund_total),
    });
  }

  // Biggest first: if only part of this list gets worked, it should be the part
  // that carries the money.
  newly.sort((a, b) => b._our_loss - a._our_loss);

  if ((url.searchParams.get("format") || "").toLowerCase() === "csv") {
    const esc = (v: any) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = [HEAD.join(",")]
      .concat(newly.map((r) => HEAD.map((h) => esc(r[h])).join(",")))
      .join("\n");
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="newly-surfaced-${since}.csv"`,
      },
    });
  }

  const byStore: Record<string, { orders: number; our_loss: number }> = {};
  for (const r of newly) {
    const b = byStore[r.Store] ||= { orders: 0, our_loss: 0 };
    b.orders++;
    b.our_loss = money(b.our_loss + r._our_loss);
  }

  return json({
    readOnly: "reads refund_reprobe and refund_damage; nothing written",
    since,
    newly_surfaced: newly.length,
    our_loss: money(newly.reduce((a, r) => a + r._our_loss, 0)),
    buyer_paid: money(newly.reduce((a, r) => a + r["eBay Order Total"], 0)),
    // Every one of these should be No. A Yes is a buyer who genuinely asked,
    // which is NOT this glitch and must not be chased for the money back.
    buyer_requested_refund_count: newly.filter((r) => r["Buyer Requested Refund"] !== "No").length,
    not_shipped_count: newly.filter((r) => r["Shipped To Buyer"] !== "Yes").length,
    orders_with_no_earlier_reading: noPrior,
    by_store: byStore,
    columns: HEAD,
    rows: newly,
  });
});
