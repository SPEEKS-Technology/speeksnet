// ============================================================================
// dupe-risk-list — the duplicate orders that have NOT been refunded on eBay.
//
//   ?secret=<ops>                JSON (default)
//   ?secret=<ops>&format=csv     CSV, one row per eBay order — every column
//   ?secret=<ops>&format=master  CSV in the master workbook's own 10 columns,
//                                the same shape dupe-newly-surfaced emits, so
//                                the two files stack in one sheet
//   ?secret=<ops>&format=master&scope=all
//                                RECONCILIATION: every duplicate order we know
//                                of, lost and at-risk alike, with a State and
//                                an Our Loss column. This is the whole universe
//                                and its total is the answer — a hand-kept
//                                workbook that disagrees is diffed against
//                                this, not the other way round.
//
// The master shape deliberately carries an EMPTY "eBay Refunded (Central)".
// That blank is the entire point of this list: these are the rows where eBay
// has not moved. Do not fill it in to make the columns look tidy.
//
// READ-ONLY. Reads the newest row per eBay order out of `refund_reprobe` and
// keeps only those still showing no refund on eBay. Touches neither Shopify nor
// eBay: run ebay-refund-reprobe first if the state needs to be current.
//
// THE SHAPE OF THE PROBLEM: Marketplace Connect duplicated eBay sales into
// Shopify. We refunded the duplicate. For 220 orders PayMore's reconciler then
// replayed that refund onto the REAL eBay order — buyer keeps the item AND the
// money. The orders listed here are the ones where that has NOT happened. They
// are exposure, not loss: the money is still ours unless something moves it.
//
// ⚠️ DO NOT REFUND THESE IN SHOPIFY. A Shopify refund is the event believed to
// trigger the propagation, so refunding here is the one action capable of
// converting this whole list from exposure into loss.
//
// `days_open` runs from the eBay sale date because eBay's own refund and
// dispute clocks run from there, not from when we noticed.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";

const STORES: Record<string, { label: string; manager: string }> = {
  OVL: { label: "Overland Park", manager: "Nick" },
  LEE: { label: "Lee's Summit", manager: "Jurell" },
  WSP: { label: "Westport", manager: "Eli" },
  MPL: { label: "Maplewood", manager: "Joseph" },
  BAL: { label: "Ballwin", manager: "Joseph" },
};

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
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Paged: refund_reprobe carries a whole eBay order body per row and there are
// several probes' worth. PostgREST caps a page at 1000 rows and does it
// silently, which would quietly drop stores off the end of the list.
async function sbAll(path: string) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Range: `${from}-${from + 999}`,
        "Range-Unit": "items",
      },
    });
    if (!r.ok) throw new Error(`supabase ${path}: ${r.status} ${await r.text()}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// The store's clock, not the server's — the edge runtime is UTC, so a 7pm
// Central refund would otherwise print as the following day. Same format as
// dupe-newly-surfaced so the two exports sort together in one column.
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

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  // Ordered so the FIRST row seen for an order id is its newest probe.
  const rows = await sbAll(
    "refund_reprobe?select=run_at,store_code,order_name,ebay_order_id,shopify_refund,"
      + "ebay_order_total,ebay_refund_total,ebay_refund_date,ebay_payment_status,ebay_fulfillment_status,body"
      + "&order=ebay_order_id.asc,run_at.desc",
  );

  const newest: Record<string, any> = {};
  for (const r of rows) if (!newest[r.ebay_order_id]) newest[r.ebay_order_id] = r;
  const all = Object.values(newest) as any[];

  const now = Date.now();
  const out: any[] = [];
  let probedAt = "";

  // scope=all keeps the orders eBay HAS refunded as well, so the file is the
  // whole universe rather than the open half of it. Only the reconciliation
  // export asks for this; every other caller wants the at-risk list.
  const keepAll = (url.searchParams.get("scope") || "").toLowerCase() === "all";

  for (const r of all) {
    if (r.run_at > probedAt) probedAt = r.run_at;
    // The whole filter. A refund of any size means eBay has already moved.
    if (!keepAll && num(r.ebay_refund_total) > 0) continue;

    const b = r.body || {};
    const lines = Array.isArray(b.lineItems) ? b.lineItems : [];
    const sold = b.creationDate ? new Date(b.creationDate) : null;
    const legacy = lines.map((l: any) => l.legacyItemId).filter(Boolean);

    out.push({
      store: r.store_code,
      store_label: STORES[r.store_code]?.label ?? r.store_code,
      manager: STORES[r.store_code]?.manager ?? null,
      ebay_order_id: r.ebay_order_id,
      sale_date: sold ? sold.toISOString().slice(0, 10) : null,
      days_open: sold ? Math.floor((now - sold.getTime()) / 86400000) : null,
      // What we refunded in Shopify. This row IS the pending trigger — the
      // thing PayMore's reconciler would replay onto the eBay order.
      shopify_dupe_refunded: r.order_name,
      shopify_refund: r2(num(r.shopify_refund)),
      ebay_order_total: r2(num(r.ebay_order_total)),
      // What eBay actually took back. Zero means still exposure, not loss —
      // the one column that must never be conflated with the order total.
      ebay_refund_total: r2(num(r.ebay_refund_total)),
      state: num(r.ebay_refund_total) > 0 ? "Lost" : "At Risk",
      ebay_refund_date: r.ebay_refund_date ?? null,
      // What we would actually lose: buyer price less eBay fees and tax.
      due_seller: r2(num(b?.paymentSummary?.totalDueSeller?.value)),
      ebay_payment_status: b.orderPaymentStatus ?? r.ebay_payment_status ?? null,
      ebay_fulfillment_status: b.orderFulfillmentStatus ?? null,
      cancel_state: b?.cancelStatus?.cancelState ?? null,
      buyer: b?.buyer?.username ?? null,
      buyer_name: b?.buyer?.buyerRegistrationAddress?.fullName ?? null,
      buyer_state: b?.buyer?.taxAddress?.stateOrProvince ?? null,
      line_count: lines.length,
      items: lines.map((l: any) => l.title).filter(Boolean).join(" | "),
      skus: lines.map((l: any) => l.sku).filter(Boolean).join(" | "),
      legacy_item_ids: legacy.join(" | "),
      listing_urls: legacy.map((id: string) => "https://www.ebay.com/itm/" + id).join(" | "),
      ebay_order_url:
        "https://www.ebay.com/sh/ord/details?orderid=" + encodeURIComponent(r.ebay_order_id),
    });
  }

  out.sort((a, b) =>
    a.store === b.store
      ? (a.sale_date || "").localeCompare(b.sale_date || "")
      : a.store.localeCompare(b.store),
  );

  const by_store: Record<string, any> = {};
  for (const o of out) {
    const s = (by_store[o.store] ||= {
      label: o.store_label,
      manager: o.manager,
      orders: 0,
      ebay_total: 0,
      due_seller: 0,
      shopify_refund: 0,
      shipped: 0,
      not_shipped: 0,
    });
    s.orders++;
    s.ebay_total = r2(s.ebay_total + o.ebay_order_total);
    s.due_seller = r2(s.due_seller + o.due_seller);
    s.shopify_refund = r2(s.shopify_refund + o.shopify_refund);
    if (o.ebay_fulfillment_status === "FULFILLED") s.shipped++;
    else s.not_shipped++;
  }

  const format = (url.searchParams.get("format") || "").toLowerCase();

  // The master workbook's columns, C onward. SKU and the Shopify refund
  // timestamp are not on refund_reprobe — they belong to refund_damage, which
  // is the row that records what WE did, so it is joined rather than read off
  // the eBay body. An id missing from refund_damage keeps its row and shows a
  // blank cell: dropping it would quietly shrink an exposure list.
  if (format === "master") {
    const dmg = await sbAll("refund_damage?select=ebay_order_id,sku,shopify_refunded_at");
    const byId: Record<string, any> = {};
    for (const d of dmg) byId[String(d.ebay_order_id)] = d;

    // scope=all is a reconciliation, so it carries the two columns that make
    // the arithmetic checkable: which side of the line a row is on, and the
    // single number that should be summed. Without them a reader has to guess
    // whether "eBay Order Total" means money lost, and that guess is exactly
    // how a hand-kept total drifts.
    const HEAD = [
      "Store", "Shopify Order", "SKU", "eBay Order ID", "eBay Order Total",
      "Shopify Refund Amount", "Shipped To Buyer", "Buyer Requested Refund",
      "Shopify Refunded (Central)", "eBay Refunded (Central)",
    ].concat(keepAll ? ["State", "Our Loss"] : []);
    const body = [HEAD.join(",")].concat(out.map((o) => {
      const d = byId[o.ebay_order_id] || {};
      return [
        o.store,
        o.shopify_dupe_refunded,
        d.sku ?? "",
        o.ebay_order_id,
        o.ebay_order_total,
        o.shopify_refund,
        o.ebay_fulfillment_status === "FULFILLED" ? "Yes" : "No",
        o.cancel_state === "NONE_REQUESTED" ? "No" : (o.cancel_state ?? ""),
        central(d.shopify_refunded_at ?? null),
        // Blank while eBay has not moved — that blank is what puts a row on the
        // at-risk side, so it is never filled in to tidy the column.
        o.state === "Lost" ? central(o.ebay_refund_date ?? null) : "",
      ].concat(keepAll ? [o.state, o.state === "Lost" ? o.ebay_refund_total : 0] : [])
       .map(csvCell).join(",");
    })).join("\n");

    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="dupe-still-at-risk-master.csv"',
      },
    });
  }

  if (format === "csv") {
    const cols = [
      "store", "store_label", "manager", "ebay_order_id", "sale_date", "days_open",
      "shopify_dupe_refunded", "shopify_refund", "ebay_order_total", "due_seller",
      "ebay_payment_status", "ebay_fulfillment_status", "cancel_state",
      "buyer", "buyer_name", "buyer_state", "line_count", "items", "skus",
      "legacy_item_ids", "listing_urls", "ebay_order_url",
    ];
    const csv = [cols.join(",")]
      .concat(out.map((o) => cols.map((c) => csvCell((o as any)[c])).join(",")))
      .join("\n");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="dupe-still-at-risk.csv"',
      },
    });
  }

  return json({
    generated_at: new Date().toISOString(),
    ebay_state_probed_at: probedAt,
    readOnly: "reads refund_reprobe only; nothing written, no Shopify or eBay call",
    warning: "DO NOT refund these in Shopify — that is the event believed to propagate to eBay.",
    totals: {
      duplicate_orders_probed: all.length,
      already_refunded_on_ebay: all.length - out.length,
      still_at_risk: out.length,
      at_risk_ebay_total: r2(out.reduce((a, o) => a + o.ebay_order_total, 0)),
      at_risk_due_seller: r2(out.reduce((a, o) => a + o.due_seller, 0)),
    },
    by_store,
    rows: out,
  });
});
