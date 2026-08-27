// ============================================================================
// sales-true-daily — what a store ACTUALLY sold on a day, with the duplicate
// incident taken back out.
//
//   ?secret=<ops>&from=2026-08-26&to=2026-08-26[&store=OVL][&format=csv]
//
// READ-ONLY. Reads Shopify (GETs and ShopifyQL) and two Supabase tables.
// Writes nothing, anywhere.
//
// WHY THIS EXISTS. Three separate things are hitting the daily sales figure and
// none of them is the store selling anything:
//
//   1. OUR duplicate refunds — we refunded 396 phantom Shopify orders on Aug
//      20, 24 and 25. Already pinned in the Sales Summary for those days.
//   2. THE MIRROR-BACK — the new Marketplace Connect is pushing the resulting
//      eBay refunds back into Shopify against the REAL orders. 237 of them
//      landed on Aug 26 alone, $43,992.52, on orders sold days earlier. This
//      is the one nobody had measured.
//   3. DRAFT-ORDER INVOICES — buyers accepting an invoice to pay back money
//      they were wrongly refunded. That is recovery of a loss, not selling,
//      and it inflates the day it is paid.
//
// ⚠️ ONLY REFUNDS ON A PROVEN DUPLICATE PAIR COME OUT (user, 2026-08-27).
// A refund is stripped only when its order carries an eBay order id that the
// duplicate ledger also knows about AND the ledger names a DIFFERENT Shopify
// order for that same eBay id — which is the two-copies-of-one-sale test
// stated directly. An ordinary customer return has no eBay twin and stays in
// the figure, because a store that took a real return really did lose that
// sale. Anything we cannot classify is reported as unknown, never silently
// stripped: an unexplained refund must not quietly improve a store's day.
//
// The eBay id lives in two different places depending on who made the copy —
// `sourceIdentifier` on Marketplace Connect's, a customAttribute on SPEEKS
// Connect's — so both are read. Matching on only one finds nothing, which is
// the trap recorded in [[mpc-dupe-sheet-restatement]].
// ============================================================================

const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";

const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 1), { status: s, headers: { "Content-Type": "application/json" } });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// The store's own calendar. The edge runtime is UTC, so a 7pm Central sale is
// tomorrow in UTC and a quarter of every evening would land on the wrong day.
const DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
});
const chicagoDay = (iso: string) => DAY.format(new Date(iso));

async function sbAll(path: string) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
                 Range: `${from}-${from + 999}`, "Range-Unit": "items" },
    });
    if (!r.ok) throw new Error(`supabase ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

const ORDER_Q = `query($q: String!, $after: String) {
  orders(first: 100, query: $q, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { cursor node {
      name createdAt processedAt sourceName sourceIdentifier
      customAttributes { key value }
      currentSubtotalPriceSet { shopMoney { amount } }
      refunds(first: 20) {
        createdAt
        refundLineItems(first: 100) { edges { node { subtotalSet { shopMoney { amount } } } } }
      }
    } }
  }
}`;

// A draft order that the buyer paid. Shopify reports these through sourceName;
// the exact token has varied across API versions, so match loosely and report
// every distinct sourceName seen so a new one cannot slip through unnoticed.
const isDraft = (s: unknown) => /draft/i.test(String(s || ""));

function ebayIdOf(o: any): string | null {
  const src = String(o.sourceIdentifier || "").trim();
  if (/^\d{2}-\d{5}-\d{5}$/.test(src)) return src;
  for (const a of (o.customAttributes || [])) {
    if (/ebay\s*order\s*id/i.test(String(a.key))) {
      const v = String(a.value || "").trim();
      if (v) return v;
    }
  }
  return null;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || from).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return json({ error: "pass from=YYYY-MM-DD[&to=YYYY-MM-DD]" }, 400);
  }
  const only = (url.searchParams.get("store") || "").toUpperCase();
  const stores = only ? [only] : Object.keys(SHOP_BY_STORE);
  for (const s of stores) if (!SHOP_BY_STORE[s]) return json({ error: `unknown store ${s}` }, 400);

  // Orders the store CAUGHT before the parcel shipped. eBay refunded the buyer
  // and we kept the goods — so the sale genuinely reversed and the refund on the
  // real Shopify order is CORRECT accounting, not glitch noise. Adding it back
  // would credit the store for an item still on its own shelf, and then credit
  // it a second time when that item is resold. These stay in the day.
  const recoveredRows = await sbAll("refund_recovered?select=ebay_order_id,reason");
  const recovered = new Set(recoveredRows.map((r: any) => String(r.ebay_order_id)));

  // ⚠️ NOT EVERY DRAFT ORDER IS A REPAYMENT. Stores use draft orders for
  // ordinary invoiced sales too, and stripping all of them understates real
  // selling: Aug 20 and Aug 24 carry drafts that PREDATE the first eBay refund
  // and so cannot possibly be repayment for one, and LEE #MO01-9161 ($1,549.99
  // on Aug 26) matches no refund at that store at all.
  //
  // A draft only comes out when BOTH hold: it is dated on or after the first
  // eBay refund, and its amount equals an eBay order total we actually refunded
  // at that store. Everything else stays in and is reported, because the cost of
  // wrongly stripping a real sale is a store blamed for a day it did not have.
  const reprobe = await sbAll(
    "refund_reprobe?select=run_at,store_code,ebay_order_id,ebay_order_total,ebay_refund_total,ebay_refund_date"
    + "&order=ebay_order_id.asc,run_at.desc");
  const newestProbe: Record<string, any> = {};
  for (const r of reprobe) if (!newestProbe[r.ebay_order_id]) newestProbe[r.ebay_order_id] = r;
  const refundedAmounts: Record<string, Set<number>> = {};
  let firstRefundDay = "9999-12-31";
  for (const r of Object.values(newestProbe) as any[]) {
    if (num(r.ebay_refund_total) <= 0) continue;
    (refundedAmounts[r.store_code] ||= new Set()).add(r2(num(r.ebay_order_total)));
    // ⚠️ The eBay REFUND date, not the probe run date. Using run_at put the
    // boundary at today, so every repayment invoice failed the test and was
    // counted as a real sale — the exact opposite of the intent.
    if (!r.ebay_refund_date) continue;
    const d = chicagoDay(r.ebay_refund_date);
    if (d < firstRefundDay) firstRefundDay = d;
  }
  const looksLikeRepayment = (st: string, day: string, amt: number) =>
    day >= firstRefundDay && !!refundedAmounts[st]?.has(r2(amt));

  // The duplicate ledger: eBay order id -> the Shopify copy WE refunded.
  const ledgerRows = await sbAll("refund_damage?select=ebay_order_id,order_name,store_code");
  const ledger: Record<string, string> = {};
  for (const d of ledgerRows) ledger[String(d.ebay_order_id)] = String(d.order_name || "");

  const tokRows = await sbAll("shopify_stores?select=shop,access_token");
  const tokenFor = (shop: string) => (tokRows.find((t: any) => t.shop === shop) || {}).access_token;

  const inRange = (d: string) => d >= from && d <= to;
  const out: any[] = [];
  const perStore: any = {};

  for (const store of stores) {
    const shop = SHOP_BY_STORE[store];
    const token = tokenFor(shop);
    if (!token) return json({ error: `no token for ${store}` }, 400);

    const gql = async (q: string, variables: any) => {
      const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query: q, variables }),
      });
      const b = await res.json();
      if (b.errors?.length) throw new Error(`${store}: ${JSON.stringify(b.errors).slice(0, 300)}`);
      return b.data;
    };

    // Reported net sales per day, straight from Shopify's own analytics — the
    // number the daily email and the sheet already carry. GROUP BY day only:
    // adding order_name silently truncates on a busy store, which once produced
    // a $27k phantom correction ([[mpc-dupe-sheet-restatement]]).
    // ⚠️ Use the proven ShopifyQL shape — `tableData { rows }`, rows keyed by
    // column name. The typed-fragment form (`... on TableResponse`) returns no
    // table at all here and would have read as "this store sold nothing".
    // GROUP BY day only: adding order_name silently truncates on a busy store,
    // which once produced a $27k phantom correction.
    const qlBody = await gql(
      `{ shopifyqlQuery(query: "FROM sales SHOW net_sales, gross_sales, returns, cost_of_goods_sold GROUP BY day SINCE ${from} UNTIL ${to}") {
           parseErrors tableData { rows } } }`, {});
    const qlRows = qlBody?.shopifyqlQuery?.tableData?.rows || [];
    if (!qlRows.length) {
      return json({ error: `shopifyql returned no sales rows for ${store} — refusing to report zeros`,
        store, from, to, parseErrors: qlBody?.shopifyqlQuery?.parseErrors ?? null }, 502);
    }
    const reported: Record<string, any> = {};
    for (const row of qlRows) {
      reported[String(row.day).slice(0, 10)] = {
        net_sales: r2(num(row.net_sales)),
        gross_sales: r2(num(row.gross_sales)),
        returns: r2(num(row.returns)),
        cost: r2(num(row.cost_of_goods_sold)),
      };
    }

    // The channel split is where draft orders show up as their own line, which
    // is both cheaper and steadier than inferring them from each order's
    // sourceName. Kept alongside the per-order pass so the two can disagree
    // out loud rather than silently.
    const chBody = await gql(
      `{ shopifyqlQuery(query: "FROM sales SHOW net_sales GROUP BY day, sales_channel SINCE ${from} UNTIL ${to}") {
           parseErrors tableData { rows } } }`, {});
    const norm = (v: unknown) => String(v).replace(/[^a-z0-9]/gi, "").toLowerCase();
    const draftByDay: Record<string, number> = {};
    const channels: Record<string, number> = {};
    for (const row of chBody?.shopifyqlQuery?.tableData?.rows || []) {
      const d = String(row.day).slice(0, 10);
      const ch = String(row.sales_channel ?? "(none)");
      channels[ch] = r2((channels[ch] || 0) + num(row.net_sales));
      if (norm(ch).includes("draft")) draftByDay[d] = r2((draftByDay[d] || 0) + num(row.net_sales));
    }

    // Two sweeps: orders CREATED in the range (draft invoices land here) and
    // older orders TOUCHED during it (a refund on a sale from three weeks ago
    // is exactly the case that matters here).
    const scans = [
      `created_at:>=${from} AND created_at:<=${to}T23:59:59Z`,
      `created_at:<${from} AND updated_at:>=${from}`,
    ];
    const seenOrder = new Set<string>();
    const sourceNames: Record<string, number> = {};
    const dayRows: Record<string, any> = {};
    const detail: any[] = [];
    // Order names per day per bucket, so the COGS half can be priced from
    // Shopify's own per-order cost rather than from unitCost — which is the
    // CURRENT cost of the SKU, not what it cost when it sold.
    const dayOrders: Record<string, { mirror: Set<string>; ourDupe: Set<string>; draft: Set<string> }> = {};
    const buckets = (d: string) => (dayOrders[d] ||= { mirror: new Set(), ourDupe: new Set(), draft: new Set() });
    const bump = (d: string) => (dayRows[d] ||= {
      day: d, store,
      mirror_refund: 0, mirror_orders: 0,
      our_dupe_refund: 0, our_dupe_orders: 0,
      genuine_refund: 0, genuine_orders: 0,
      unknown_refund: 0, unknown_orders: 0,
      draft_sales: 0, draft_orders: 0,
    });

    for (const q of scans) {
      let after: string | null = null, pages = 0;
      for (;;) {
        const d: any = await gql(ORDER_Q, { q, after });
        pages++;
        for (const e of d.orders.edges) {
          const o = e.node;
          if (seenOrder.has(o.name)) continue;
          seenOrder.add(o.name);
          sourceNames[String(o.sourceName || "(none)")] =
            (sourceNames[String(o.sourceName || "(none)")] || 0) + 1;

          // ---- draft-order invoices booked into this range ----
          const sold = chicagoDay(o.processedAt || o.createdAt);
          if (isDraft(o.sourceName) && inRange(sold)) {
            const amt = r2(num(o.currentSubtotalPriceSet?.shopMoney?.amount));
            const b = bump(sold);
            if (looksLikeRepayment(store, sold, amt)) {
              b.draft_sales = r2(b.draft_sales + amt);
              b.draft_orders++;
              buckets(sold).draft.add(o.name);
              detail.push({ day: sold, store, kind: "draft-order invoice (repayment)",
                            order: o.name, amount: amt });
            } else {
              // A real invoiced sale. Counted as selling, and listed so the
              // judgement is visible rather than buried in a total.
              b.draft_kept = r2((b.draft_kept || 0) + amt);
              b.draft_kept_orders = (b.draft_kept_orders || 0) + 1;
              detail.push({ day: sold, store, kind: "draft order KEPT as a real sale",
                            order: o.name, amount: amt });
            }
          }

          // ---- refunds booked into this range ----
          const eid = ebayIdOf(o);
          const ledgerName = eid ? ledger[eid] : undefined;
          for (const rf of (o.refunds || [])) {
            const rd = chicagoDay(rf.createdAt);
            if (!inRange(rd)) continue;
            const amt = r2((rf.refundLineItems?.edges || [])
              .reduce((a: number, x: any) => a + num(x.node.subtotalSet?.shopMoney?.amount), 0));
            if (!amt) continue;
            const b = bump(rd);

            let kind: string;
            if (eid && recovered.has(eid)) {
              // A real cancelled sale. Left in the store's figure on purpose.
              kind = "recovered — sale genuinely reversed";
              b.genuine_refund = r2(b.genuine_refund + amt); b.genuine_orders++;
            } else if (ledgerName && ledgerName !== o.name) {
              // The ledger names a DIFFERENT Shopify order for this same eBay
              // sale, so two copies of one sale provably exist. This is the
              // mirror-back landing on the copy we did NOT refund.
              kind = "mirror-back"; buckets(rd).mirror.add(o.name);
              b.mirror_refund = r2(b.mirror_refund + amt); b.mirror_orders++;
            } else if (ledgerName) {
              // The ledger names THIS order: our own duplicate refund.
              kind = "our duplicate refund"; buckets(rd).ourDupe.add(o.name);
              b.our_dupe_refund = r2(b.our_dupe_refund + amt); b.our_dupe_orders++;
            } else if (eid) {
              // Has an eBay id but no twin on record. Not provably a duplicate,
              // so it stays in the store's figure and is reported for review.
              kind = "eBay order, no duplicate on record";
              b.unknown_refund = r2(b.unknown_refund + amt); b.unknown_orders++;
            } else {
              kind = "genuine refund";
              b.genuine_refund = r2(b.genuine_refund + amt); b.genuine_orders++;
            }
            detail.push({ day: rd, store, kind, order: o.name, ebay_order_id: eid,
                          ledger_twin: ledgerName ?? null, sold_on: sold, amount: amt });
          }
        }
        if (!d.orders.pageInfo.hasNextPage) break;
        after = d.orders.pageInfo.endCursor;
        if (pages > 80) break; // a runaway page loop must not bill forever
      }
    }

    // ---- COGS for the same three buckets -----------------------------------
    // A refund reverses cost of goods as well as revenue, so a day carrying
    // mirror-back refunds understates cost too and its margin is nonsense.
    // Priced from ShopifyQL per order, ONE QUERY PER DAY: `GROUP BY order_name`
    // across a whole month silently truncates on a busy store, and the rows it
    // drops are the big negative ones — which reads as a plausible correction
    // rather than as a failure.
    const costBucket: Record<string, { mirror: number; ourDupe: number; draft: number }> = {};
    for (const day of Object.keys(dayOrders)) {
      const bk = dayOrders[day];
      if (!bk.mirror.size && !bk.ourDupe.size && !bk.draft.size) continue;
      const perOrder = await gql(
        `{ shopifyqlQuery(query: "FROM sales SHOW cost_of_goods_sold GROUP BY order_name SINCE ${day} UNTIL ${day}") {
             parseErrors tableData { rows } } }`, {});
      const c = (costBucket[day] ||= { mirror: 0, ourDupe: 0, draft: 0 });
      for (const row of perOrder?.shopifyqlQuery?.tableData?.rows || []) {
        const nm = String(row.order_name || "");
        const cost = num(row.cost_of_goods_sold);
        if (bk.mirror.has(nm)) c.mirror = r2(c.mirror + cost);
        if (bk.ourDupe.has(nm)) c.ourDupe = r2(c.ourDupe + cost);
        if (bk.draft.has(nm)) c.draft = r2(c.draft + cost);
      }
    }

    for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86400000) {
      const day = new Date(t).toISOString().slice(0, 10);
      const b = bump(day);
      const rep = reported[day] || { net_sales: 0, gross_sales: 0, returns: 0, cost: 0 };
      // The channel split counts EVERY draft order, including the ordinary
      // invoiced sales this function deliberately keeps, so it is a
      // cross-check and must never overwrite the filtered figure — doing so
      // silently reinstated the very drafts the repayment test had spared.
      const draftCh = r2(draftByDay[day] || 0);
      b.draft_all_channel = draftCh;
      // Add the incident refunds back (they are negative in net_sales) and take
      // the invoice recovery out. Genuine and unknown refunds are left alone.
      const trueSales = r2(rep.net_sales + b.mirror_refund + b.our_dupe_refund - b.draft_sales);
      // ⚠️ RECONCILE, OR DO NOT TRUST IT. Shopify's own returns figure for the
      // day must equal what the per-order pass classified. A residual means
      // refunds exist that this function never saw — an adjustment-only refund
      // carries no line items, so it contributes to the day and to no bucket.
      // Those stay in the store's figure (the safe direction) but the gap is
      // reported: a restatement derived from an unreconciled number is a guess.
      const classified = r2(b.mirror_refund + b.our_dupe_refund + b.genuine_refund + b.unknown_refund);
      const residual = r2(Math.abs(rep.returns) - classified);
      out.push({
        store, day,
        reported_net_sales: rep.net_sales,
        reported_gross_sales: rep.gross_sales,
        add_back_mirror_refunds: b.mirror_refund,
        add_back_our_duplicate_refunds: b.our_dupe_refund,
        less_draft_order_invoices: b.draft_sales,
        true_sales: trueSales,
        adjustment: r2(trueSales - rep.net_sales),
        reported_cost: rep.cost,
        // Mirror/our-duplicate costs come back NEGATIVE (a reversal), so
        // subtracting them adds the cost back. Draft cost is a real cost of a
        // real item leaving, but the sale is not selling — both legs come out.
        true_cost: r2(rep.cost - (costBucket[day]?.mirror || 0) - (costBucket[day]?.ourDupe || 0)
                      - (costBucket[day]?.draft || 0)),
        cost_parts: costBucket[day] || { mirror: 0, ourDupe: 0, draft: 0 },
        reported_returns: r2(Math.abs(rep.returns)),
        refunds_classified: classified,
        refunds_unreconciled: residual,
        draft_orders_kept_as_real_sales: r2(b.draft_kept || 0),
        all_draft_orders_channel: r2(b.draft_all_channel || 0),
        left_in_genuine_refunds: b.genuine_refund,
        left_in_unclassified_refunds: b.unknown_refund,
        counts: {
          mirror: b.mirror_orders, our_duplicate: b.our_dupe_orders,
          genuine: b.genuine_orders, unclassified: b.unknown_orders, draft: b.draft_orders,
        },
      });
    }
    perStore[store] = { orders_scanned: seenOrder.size, source_names: sourceNames,
      repayment_test: { first_refund_day: firstRefundDay,
                        refunded_amounts_known: (refundedAmounts[store] || new Set()).size },
      sales_channels: channels };
    if (url.searchParams.get("detail") === "1") perStore[store].detail = detail;
  }

  out.sort((a, b) => a.day.localeCompare(b.day) || a.store.localeCompare(b.store));

  if ((url.searchParams.get("format") || "").toLowerCase() === "csv") {
    const H = ["Store", "Day", "Reported Net Sales", "Add Back Mirror Refunds",
      "Add Back Our Duplicate Refunds", "Less Draft Order Invoices", "True Sales",
      "Adjustment", "Genuine Refunds Left In", "Unclassified Refunds Left In"];
    const esc = (v: any) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const body = [H.join(",")].concat(out.map((r) => [r.store, r.day, r.reported_net_sales,
      r.add_back_mirror_refunds, r.add_back_our_duplicate_refunds, r.less_draft_order_invoices,
      r.true_sales, r.adjustment, r.left_in_genuine_refunds, r.left_in_unclassified_refunds]
      .map(esc).join(","))).join("\n");
    return new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="true-daily-${from}_${to}.csv"` } });
  }

  const tot = (k: string) => r2(out.reduce((a, r) => a + num((r as any)[k]), 0));
  return json({
    readOnly: "queried Shopify with GETs and ShopifyQL; nothing written",
    from, to, stores,
    rule: "a refund is only stripped when the duplicate ledger names a DIFFERENT "
        + "Shopify order for the same eBay sale — two copies of one sale, proven. "
        + "Genuine and unclassified refunds stay in the store's figure.",
    totals: {
      reported_net_sales: tot("reported_net_sales"),
      refunds_unreconciled: tot("refunds_unreconciled"),
      add_back_mirror_refunds: tot("add_back_mirror_refunds"),
      add_back_our_duplicate_refunds: tot("add_back_our_duplicate_refunds"),
      less_draft_order_invoices: tot("less_draft_order_invoices"),
      draft_orders_kept_as_real_sales: tot("draft_orders_kept_as_real_sales"),
      true_sales: tot("true_sales"),
      left_in_genuine_refunds: tot("left_in_genuine_refunds"),
      left_in_unclassified_refunds: tot("left_in_unclassified_refunds"),
    },
    per_store: perStore,
    rows: out,
  });
});
