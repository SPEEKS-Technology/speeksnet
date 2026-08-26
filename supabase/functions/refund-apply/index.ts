// ============================================================================
// refund-apply — reverse the Shopify sale on SPEEKS Connect orders whose eBay
// twin has ALREADY been refunded by PayMore's reconciler.
//
//   ?secret=<ops>&store=BAL&confirm=REFUND-SPEEKS-CONNECT
//     &only=<#order-name>   refund exactly one order (the staged first run)
//     &limit=N              cap the batch
//     &dryRun=1             run every gate, write nothing (default OFF)
//
// WHY: MC created duplicate Shopify orders for eBay sales already in Shopify.
// We refunded the duplicates; PayMore's hourly reconciler pushed those refunds
// to the REAL eBay order. The buyer has their money and the item. The SPEEKS
// Connect order still reads as a completed sale, so the books overstate revenue
// by $41,825.72 across 216 orders. This reverses that, and nothing else.
//
// ⚠️ NO REAL MONEY MOVES, BUT THE REFUND MUST STILL CARRY A TRANSACTION.
// First attempt omitted `transactions`, reasoning that the buyer had already
// been paid by eBay. Staged on #KS01-14010 and it was WRONG: Shopify's analytics
// ignored the refund entirely — `returns` and `net_sales` did not move, while
// cost_of_goods_sold DID reverse. That removes the cost and keeps the revenue,
// inflating gross profit: the exact opposite of this correction. The `returns`
// metric is money-driven, so a transaction is required.
//
// It is safe because the gateway is the custom "eBay" gateway SPEEKS Connect
// invented on import. Shopify never held these funds and has no processor to
// call — proven by the MC twin #KS01-14155, whose identical refund records
// kind REFUND / gateway ebay / status SUCCESS with no processor involved.
// notify:false keeps the buyer from getting a second refund email for money
// they already have.
//
// ⚠️ NOTHING IS RESTOCKED. restockType NO_RESTOCK on every line: the item shipped
// and the buyer kept it. Restocking would invent inventory that does not exist.
//
// SEVEN GATES, ALL RE-CHECKED AT WRITE TIME against live Shopify — never against
// the plan this was built from, because the plan is minutes old and a refund is
// not reversible:
//   1. exactly one SPEEKS Connect order carries this eBay Order Id
//   2. that order's app really is SPEEKS Connect
//   3. it is not cancelled
//   4. it carries NO refund yet
//   5. its name is NOT in dup_order_cleanup (never refund a phantom)
//   6. a NON-SPEEKS twin exists AND is already refunded — proof this is half of
//      a duplicate pair that has been dealt with, not a lone order
//   7. the newest eBay probe for this order shows a refund > 0 — we only reverse
//      what we have actually LOST
// Gates 6 and 7 are the two the user asked for by name: never touch a pair where
// neither side is refunded, and never touch anything still unrefunded on eBay.
//
// Every attempt — refusal included — is written to refund_apply_log, which has a
// unique index on (shopify_order_id) where outcome='refunded'. A re-run cannot
// double-refund even if every gate above were wrong.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const CONFIRM_PHRASE = "REFUND-SPEEKS-CONNECT";

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

async function sbLog(row: Record<string, unknown>) {
  // A failure to LOG must never abort the run, but it must be visible.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/refund_apply_log`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
  } catch (_) { /* surfaced in the response body instead */ }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);

  const store = (url.searchParams.get("store") || "").toUpperCase().trim();
  const only = (url.searchParams.get("only") || "").trim();
  const limit = Math.max(0, parseInt(url.searchParams.get("limit") || "0", 10) || 0);
  const dryRun = url.searchParams.get("dryRun") === "1";
  // Explicit operator override for orders left half-done by the transaction-less
  // first attempt. Never set during a normal run.
  const repairTxOnly = url.searchParams.get("repairTxOnly") === "1";
  const confirm = url.searchParams.get("confirm") || "";

  if (!SHOP_BY_STORE[store]) return json({ error: `unknown store "${store}"` }, 400);
  if (!dryRun && confirm !== CONFIRM_PHRASE) {
    return json({
      error: "refusing to write without the confirm phrase",
      need: `&confirm=${CONFIRM_PHRASE}`,
      hint: "add &dryRun=1 to rehearse every gate without writing",
    }, 400);
  }

  const shop = SHOP_BY_STORE[store];
  const tokRows = await sbGet(`shopify_stores?select=shop,store_code,access_token`);
  const t = tokRows.find((x: any) => x.store_code === store) || tokRows.find((x: any) => x.shop === shop);
  if (!t) return json({ error: `no shopify_stores row for ${store}` }, 404);

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

  // --- the candidate set: eBay orders showing a refund on the NEWEST probe ----
  const rows = await sbGet(
    `refund_reprobe?select=run_at,store_code,order_name,ebay_order_id,ebay_refund_total`
    + `&store_code=eq.${encodeURIComponent(store)}&order=ebay_order_id.asc,run_at.desc`);
  const newest: Record<string, any> = {};
  for (const r of rows) if (!newest[r.ebay_order_id]) newest[r.ebay_order_id] = r;
  const candidates = Object.values(newest).filter((r: any) => Number(r.ebay_refund_total) > 0);

  const dups = await sbGet(`dup_order_cleanup?select=order_name&store_code=eq.${encodeURIComponent(store)}`);
  const phantomNames = new Set(dups.map((d: any) => nameKey(d.order_name)));

  // Orders already reversed by an earlier run of this function.
  const done = await sbGet(
    `refund_apply_log?select=shopify_order_id&outcome=eq.refunded&store_code=eq.${encodeURIComponent(store)}`);
  const alreadyDone = new Set(done.map((d: any) => String(d.shopify_order_id)));

  const results: any[] = [];
  let refundedCount = 0, refundedAmount = 0;

  // Sequential on purpose. These are financial writes; concurrency buys seconds
  // and costs the ability to say exactly where a failed run stopped.
  for (const row of candidates as any[]) {
    if (limit && refundedCount >= limit) break;
    const eid = String(row.ebay_order_id);

    let body: any;
    try {
      body = await gql(
        `query($q: String!) {
           orders(first: 20, query: $q) {
             edges { node {
               id name createdAt cancelledAt displayFinancialStatus
               tags sourceIdentifier
               app { name }
               totalPriceSet { shopMoney { amount } }
               totalRefundedSet { shopMoney { amount } }
               customAttributes { key value }
               transactions { id kind status gateway amountSet { shopMoney { amount } } }
               lineItems(first: 100) { edges { node { id quantity refundableQuantity } } }
             } }
           }
         }`, { q: eid });
    } catch (e) {
      results.push({ ebay_order_id: eid, outcome: "error", reason: String(e) });
      continue;
    }
    if (body.errors?.length) {
      results.push({ ebay_order_id: eid, outcome: "error", reason: JSON.stringify(body.errors).slice(0, 200) });
      continue;
    }

    const tagForId = ("ebay-" + eid).toLowerCase();
    const carriesId = (o: any) =>
      (o.customAttributes || []).some((a: any) =>
        /ebay order id/i.test(String(a.key)) && String(a.value).trim() === eid)
      || String(o.sourceIdentifier || "").trim() === eid
      || (o.tags || []).some((tg: any) => String(tg).trim().toLowerCase() === tagForId);
    const hits = (body.data.orders.edges || []).map((e: any) => e.node).filter(carriesId);

    const isSpeeks = (o: any) => String(o.app?.name || "").trim().toUpperCase() === "SPEEKS CONNECT";
    const mine = hits.filter(isSpeeks);
    const twins = hits.filter((o: any) => !isSpeeks(o));

    const base = {
      run_at: new Date().toISOString(),
      store_code: store,
      ebay_order_id: eid,
      twin_order: twins.map((x: any) => x.name).join(",") || null,
    };

    const refuse = async (reason: string, extra: Record<string, unknown> = {}) => {
      const rec = { ...base, ...extra, outcome: "refused", reason };
      results.push({ ebay_order_id: eid, outcome: "refused", reason, ...extra });
      if (!dryRun) await sbLog(rec);
    };

    // gate 1 + 2
    if (mine.length !== 1) {
      await refuse(mine.length === 0
        ? "no SPEEKS Connect order carries this eBay Order Id"
        : `${mine.length} SPEEKS Connect orders carry this eBay Order Id`);
      continue;
    }
    const o = mine[0];
    const oid = String(o.id).split("/").pop() as string;
    if (only && nameKey(o.name) !== nameKey(only)) continue;

    const rec = {
      ...base,
      shopify_order: o.name,
      shopify_order_id: oid,
      amount: r2(Number(o.totalPriceSet?.shopMoney?.amount) || 0),
    };

    if (alreadyDone.has(oid) && !repairTxOnly) {
      results.push({ ...rec, outcome: "skipped", reason: "already refunded by an earlier run" });
      continue;
    }
    // gate 3
    if (o.cancelledAt) { await refuse("order is cancelled", rec); continue; }
    // gate 4
    if ((Number(o.totalRefundedSet?.shopMoney?.amount) || 0) > 0.005) {
      await refuse("order already carries a refund", rec); continue;
    }
    // gate 5
    if (phantomNames.has(nameKey(o.name))) {
      await refuse("order is named in dup_order_cleanup — it is a phantom", rec); continue;
    }
    // gate 6 — the user's "never touch a pair where neither side is refunded"
    const refundedTwin = twins.find((x: any) =>
      (Number(x.totalRefundedSet?.shopMoney?.amount) || 0) > 0.005
      || String(x.displayFinancialStatus) === "REFUNDED");
    if (!refundedTwin) {
      await refuse(twins.length
        ? "duplicate twin exists but is NOT refunded — pair still open"
        : "no duplicate twin found for this order", rec);
      continue;
    }
    // gate 7 — belt and braces; the candidate list already filtered on this
    if (!(Number(row.ebay_refund_total) > 0)) {
      await refuse("eBay shows no refund on this order", rec); continue;
    }

    const lines = (o.lineItems?.edges || [])
      .map((e: any) => e.node)
      .filter((li: any) => Number(li.refundableQuantity) > 0)
      .map((li: any) => ({ lineItemId: li.id, quantity: Number(li.refundableQuantity), restockType: "NO_RESTOCK" }));
    // REPAIR PATH, deliberately opt-in. #KS01-14010 was refunded by the first,
    // transaction-less attempt: its line items are consumed (refundableQuantity
    // 0) but no money was recorded, so the sale still stands in the books. The
    // fix is a second refund carrying ONLY the transaction. Gated behind
    // &repairTxOnly=1 so it can never fire during a normal run — on a healthy
    // order "no refundable line items" means something is wrong, not something
    // to work around.
    const alreadyMoneyless = (Number(o.totalRefundedSet?.shopMoney?.amount) || 0) === 0
      && (o.lineItems?.edges || []).every((e: any) => Number(e.node.refundableQuantity) === 0);
    if (!lines.length && !(repairTxOnly && alreadyMoneyless)) {
      await refuse("no refundable line items", rec); continue;
    }

    // ⚠️ THE REFUND MUST CARRY A TRANSACTION, and this is the whole reason the
    // first attempt was staged. A refundCreate with line items but NO
    // transactions produces a refund that Shopify's analytics IGNORE: verified
    // live on #KS01-14010 — `returns` and `net_sales` did not move at all, while
    // cost_of_goods_sold DID reverse. That combination REMOVES THE COST AND
    // KEEPS THE REVENUE, i.e. it inflates gross profit, the exact opposite of
    // the correction being made here. The `returns` metric is money-driven.
    //
    // NO REAL MONEY MOVES. The gateway on these orders is the custom "eBay"
    // gateway SPEEKS Connect invented when it imported the order — Shopify never
    // held these funds and has no processor to call. Proven by the twin
    // #KS01-14155, whose identical refund shows kind REFUND / gateway ebay /
    // status SUCCESS with no payment processor involved.
    //
    // The gateway string is taken from the order's OWN sale transaction, never
    // hard-coded: SPEEKS Connect writes "eBay" and new MC writes "ebay", and a
    // mismatched gateway is rejected.
    const sale = (o.transactions || []).find((tx: any) =>
      tx.status === "SUCCESS" && (tx.kind === "SALE" || tx.kind === "CAPTURE"));
    if (!sale) { await refuse("no successful SALE/CAPTURE transaction to refund against", rec); continue; }

    const refundAmount = r2(Number(sale.amountSet?.shopMoney?.amount) || 0);
    if (!(refundAmount > 0)) { await refuse("sale transaction has no amount", rec); continue; }

    if (dryRun) {
      results.push({ ...rec, outcome: "would refund", lines: lines.length, twin: refundedTwin.name });
      refundedCount++; refundedAmount += rec.amount;
      continue;
    }

    let mut: any;
    try {
      // ⚠️ @idempotent(key:) is REQUIRED by Shopify on refundCreate, and the key
      // is derived from the ORDER — deliberately not from a timestamp or a random
      // value. A retry after a timeout, a re-run of this function, or a duplicate
      // HTTP request all reuse the same key, so Shopify returns the original
      // refund instead of creating a second one. This is the last line of defence
      // under the seven gates and the unique index on refund_apply_log.
      mut = await gql(
        `mutation($input: RefundInput!) {
           refundCreate(input: $input) @idempotent(key: ${JSON.stringify("dupe-reversal-" + oid + (lines.length ? "" : "-tx"))}) {
             refund { id totalRefundedSet { shopMoney { amount } } }
             userErrors { field message }
           }
         }`,
        {
          input: {
            orderId: o.id,
            // notify:false — the buyer already has their money from eBay and
            // must not receive a second refund email.
            notify: false,
            note: "Reversing sale: duplicate-order refund propagated to eBay by "
                + "Marketplace Connect. Buyer refunded on eBay " + eid
                + "; item not returned. Accounting reversal only, no funds moved.",
            ...(lines.length
              ? { refundLineItems: lines, shipping: { fullRefund: true } }
              : {}),
            transactions: [{
              orderId: o.id,
              parentId: sale.id,
              gateway: sale.gateway,
              kind: "REFUND",
              amount: String(refundAmount),
            }],
          },
        });
    } catch (e) {
      const bad = { ...rec, outcome: "error", reason: String(e) };
      results.push(bad); await sbLog(bad);
      continue;
    }

    const ue = mut?.data?.refundCreate?.userErrors || [];
    if (mut.errors?.length || ue.length) {
      const bad = {
        ...rec, outcome: "error",
        reason: JSON.stringify(mut.errors || ue).slice(0, 400),
        response: mut,
      };
      results.push({ ...bad, response: undefined }); await sbLog(bad);
      continue;
    }

    const refund = mut.data.refundCreate.refund;
    const good = {
      ...rec,
      outcome: "refunded",
      refund_id: String(refund?.id || "").split("/").pop(),
      response: { totalRefunded: refund?.totalRefundedSet?.shopMoney?.amount ?? null },
    };
    results.push({ ...good, response: undefined, refunded_total: refund?.totalRefundedSet?.shopMoney?.amount });
    await sbLog(good);
    refundedCount++; refundedAmount += rec.amount;

    if (only) break;
  }

  const byOutcome: Record<string, number> = {};
  for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;

  return json({
    store, dryRun,
    moneyMoved: false,
    restocked: false,
    candidates_considered: candidates.length,
    refunded: refundedCount,
    refunded_amount: r2(refundedAmount),
    byOutcome,
    results,
  });
});
