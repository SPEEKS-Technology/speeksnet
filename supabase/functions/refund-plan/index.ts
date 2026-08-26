// ============================================================================
// refund-plan — work out WHICH Shopify orders correspond to eBay orders that
// have already been refunded, so their Shopify sale can be reversed to match.
//
//   ?secret=<ops>&store=OVL           one store
//   ?secret=<ops>&store=ALL           every store
//
// READ-ONLY. This function decides nothing and writes nothing; it produces a
// plan for a human to approve. The apply step is a separate function.
//
// THE SITUATION (verified 2026-08-26, BAL 08-15066-00533):
//   Marketplace Connect created DUPLICATE Shopify orders for eBay sales that
//   were already in Shopify. We refunded the duplicates. PayMore's reconciler
//   saw those refunds and pushed them to eBay — against the REAL eBay order.
//   So the buyer got their money back and kept the item, while the REAL Shopify
//   order still reads as a completed sale:
//     #MO04-2797  Aug 21  PAID      249.99  refunded 0.00    <- real, to refund
//     #MO04-2827  Aug 24  REFUNDED  249.99  refunded 249.99  <- phantom, done
//   Both carry eBay Order Id 08-15066-00533.
//
// ⚠️ SCOPE IS DELIBERATELY NARROW. Only eBay orders whose CURRENT probed state
// shows a refund are considered. Orders still showing PAID on eBay ("at risk")
// are NOT included: refunding those in Shopify could be the very thing that
// propagates a refund to eBay and turns an exposure into a loss.
//
// ⚠️ THE PHANTOM IS NEVER THE TARGET. It is identified by its presence in
// dup_order_cleanup and excluded by name. Refunding a phantom again would do
// nothing useful and would re-run the exact event that caused this.
//
// Every order this cannot resolve cleanly is reported under `problems` rather
// than guessed at — a wrong order here is a real refund to a real customer.
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
const nameKey = (s: unknown) => String(s ?? "").trim().replace(/^#/, "").toUpperCase();

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${path}: ${r.status} ${await r.text()}`);
  return await r.json();
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  const want = (url.searchParams.get("store") || "").toUpperCase().trim();
  if (!want) return json({ error: "pass ?store=OVL or ?store=ALL" }, 400);
  const stores = want === "ALL" ? Object.keys(SHOP_BY_STORE) : [want];
  if (stores.some((s) => !SHOP_BY_STORE[s])) return json({ error: `unknown store "${want}"` }, 400);

  const tokRows = await sbGet(`shopify_stores?select=shop,store_code,access_token`);
  const report: any[] = [];

  for (const store of stores) {
    const shop = SHOP_BY_STORE[store];
    const t = tokRows.find((x: any) => x.store_code === store) || tokRows.find((x: any) => x.shop === shop);
    if (!t) { report.push({ store, error: "no shopify_stores row" }); continue; }

    // The CURRENT eBay state, newest probe per order. Not the Aug-25 baseline:
    // the set has grown since, and a stale list would both miss orders that are
    // now refunded and include ones that never were.
    const rows = await sbGet(
      `refund_reprobe?select=run_at,store_code,order_name,ebay_order_id,ebay_refund_total,ebay_order_total,ebay_payment_status`
      + `&store_code=eq.${encodeURIComponent(store)}&order=ebay_order_id.asc,run_at.desc`);
    const newest: Record<string, any> = {};
    for (const r of rows) if (!newest[r.ebay_order_id]) newest[r.ebay_order_id] = r;
    const refunded = Object.values(newest).filter((r: any) => Number(r.ebay_refund_total) > 0);

    // Every phantom this store has, by name, so one can never be chosen.
    const dups = await sbGet(
      `dup_order_cleanup?select=order_name&store_code=eq.${encodeURIComponent(store)}`);
    const phantomNames = new Set(dups.map((d: any) => nameKey(d.order_name)));

    async function gql(query: string, variables: unknown = {}) {
      for (let attempt = 0; ; attempt++) {
        const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t.access_token },
          body: JSON.stringify({ query, variables }),
        });
        const body = await r.json().catch(() => null);
        const throttled = body?.errors?.some((e: any) =>
          e?.extensions?.code === "THROTTLED" || /throttl/i.test(e?.message || ""));
        if (throttled && attempt < 5) {
          await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
          continue;
        }
        if (!body) throw new Error(`Shopify non-JSON (HTTP ${r.status})`);
        return body;
      }
    }

    const plan: any[] = [];
    const problems: any[] = [];

    // Searching by the eBay Order Id text finds BOTH copies regardless of date,
    // which a created_at window would not guarantee — the real sale can predate
    // the duplicate by weeks. Verified to return exactly the pair.
    const queue = [...refunded];
    const worker = async () => {
      for (;;) {
        const row: any = queue.shift();
        if (!row) return;
        const eid = String(row.ebay_order_id);
        let body: any;
        try {
          body = await gql(
            `query($q: String!) {
               orders(first: 20, query: $q) {
                 edges { node {
                   id name createdAt displayFinancialStatus cancelledAt
                   tags sourceIdentifier
                   app { name }
                   totalPriceSet { shopMoney { amount } }
                   totalRefundedSet { shopMoney { amount } }
                   customAttributes { key value }
                 } }
               }
             }`, { q: eid });
        } catch (e) {
          problems.push({ ebay_order_id: eid, issue: `shopify search failed: ${String(e)}` });
          continue;
        }
        if (body.errors?.length) {
          problems.push({ ebay_order_id: eid, issue: `shopify errors: ${JSON.stringify(body.errors).slice(0, 200)}` });
          continue;
        }

        // The text search is a keyword match, so confirm the order really
        // carries this eBay order id rather than trusting the hit. The two apps
        // record it DIFFERENTLY, which is why three forms are accepted:
        //   SPEEKS Connect -> tag "ebay-<id>", customAttribute, sourceIdentifier NULL
        //   new MC ("PayMore") -> sourceIdentifier = <id>, customAttribute
        const tagForId = ("ebay-" + eid).toLowerCase();
        const carriesId = (o: any) =>
          (o.customAttributes || []).some((a: any) =>
            /ebay order id/i.test(String(a.key)) && String(a.value).trim() === eid)
          || String(o.sourceIdentifier || "").trim() === eid
          || (o.tags || []).some((tg: any) => String(tg).trim().toLowerCase() === tagForId);
        const hits = (body.data.orders.edges || []).map((e: any) => e.node).filter(carriesId);

        // ⚠️ TWO INDEPENDENT CLASSIFIERS, AND THEY MUST AGREE.
        //   (a) APP — we kept the SPEEKS Connect copy and refunded the new-MC
        //       one, whose app name is "PayMore". Verified on BAL 08-15066-00533.
        //   (b) LEDGER — the copy we refunded is named in dup_order_cleanup.
        // Either alone could mislead: the ledger says nothing about which app
        // wrote an order, and a store can hold a SPEEKS Connect order that was
        // never duplicated at all. Where they disagree this is not a judgement
        // call — it is a row a human looks at, because the cost of being wrong
        // is refunding a real customer who was never refunded on eBay.
        const isSpeeks = (o: any) =>
          String(o.app?.name || "").trim().toUpperCase() === "SPEEKS CONNECT";
        const real = hits.filter(isSpeeks);
        const phantom = hits.filter((o: any) => !isSpeeks(o));

        const byLedgerReal = hits.filter((o: any) => !phantomNames.has(nameKey(o.name)));
        const sameSet = real.length === byLedgerReal.length
          && real.every((o: any) => byLedgerReal.some((x: any) => x.name === o.name));
        if (!sameSet) {
          problems.push({
            ebay_order_id: eid, phantom_order: row.order_name,
            issue: "app and dup-ledger classifiers DISAGREE on which copy is ours",
            by_app: real.map((o: any) => o.name + " (" + (o.app?.name || "?") + ")"),
            by_ledger: byLedgerReal.map((o: any) => o.name),
          });
          continue;
        }

        const base = {
          ebay_order_id: eid,
          phantom_order: row.order_name,
          ebay_refund_total: Number(row.ebay_refund_total) || 0,
          ebay_order_total: Number(row.ebay_order_total) || 0,
          matches: hits.length, phantoms_found: phantom.length, real_found: real.length,
        };

        if (real.length !== 1) {
          // 0 = the real sale is not in Shopify (or the attribute differs);
          // 2+ = more than one non-phantom copy, which needs a human.
          problems.push({ ...base, issue: real.length === 0
            ? "no SPEEKS Connect order carries this eBay Order Id"
            : `${real.length} SPEEKS Connect orders carry this eBay Order Id`,
            candidates: hits.map((o: any) =>
              `${o.name} (${o.app?.name || "?"}, ${o.displayFinancialStatus})`) });
          continue;
        }

        const o = real[0];
        const total = Number(o.totalPriceSet?.shopMoney?.amount) || 0;
        const already = Number(o.totalRefundedSet?.shopMoney?.amount) || 0;
        const rec = {
          ...base,
          shopify_order: o.name,
          app: o.app?.name || null,
          phantom_app: phantom.map((p: any) => p.app?.name || "?").join(",") || null,
          shopify_order_id: String(o.id).split("/").pop(),
          created_at: o.createdAt,
          financial_status: o.displayFinancialStatus,
          order_total: r2(total),
          already_refunded: r2(already),
          refundable: r2(total - already),
        };

        if (o.cancelledAt) { problems.push({ ...rec, issue: "order is cancelled" }); continue; }
        if (already > 0.005) {
          // Already reversed — possibly by hand, possibly a partial. Never
          // top up automatically; a human decides what the remainder means.
          problems.push({ ...rec, issue: "real order already carries a refund" });
          continue;
        }
        plan.push(rec);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    plan.sort((a, b) => (a.shopify_order < b.shopify_order ? -1 : 1));
    report.push({
      store,
      ebay_refunded_orders: refunded.length,
      to_refund: plan.length,
      to_refund_amount: r2(plan.reduce((a, r) => a + r.refundable, 0)),
      problems: problems.length,
      plan, problem_rows: problems,
    });
  }

  const sum = (k: string) => r2(report.reduce((a, r) => a + (Number(r[k]) || 0), 0));
  return json({
    generated_at: new Date().toISOString(),
    readOnly: "nothing was written; this is a proposal",
    scope: "eBay orders whose newest probe shows a refund. 'At risk' orders are excluded by design.",
    totals: {
      ebay_refunded_orders: sum("ebay_refunded_orders"),
      to_refund: sum("to_refund"),
      to_refund_amount: sum("to_refund_amount"),
      problems: sum("problems"),
    },
    report,
  });
});
