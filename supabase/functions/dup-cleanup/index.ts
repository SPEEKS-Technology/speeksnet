// ============================================================================
// dup-cleanup — ONE-OFF remediation for the 2026-08-20 Marketplace Connect
// duplicate-order back-fill. See memory note `mc-duplicate-imports`.
//
// This function does NOT rediscover the duplicates. `dup_order_cleanup` is the
// audit table written BEFORE anything was touched — it is the authority on what
// gets acted on, and money movement is not reversible, so the target list must
// never be recomputed at action time.
//
// MEASURED FACTS that decide the route (all verified against the live sales
// dataset via dup-probe, 2026-08-21):
//
//  1. A REFUND fully reverses BOTH net_sales AND cost_of_goods_sold. Grouped by
//     order_name over August, a staff-refunded duplicate reads net_sales 0 /
//     cogs 0. So refunding is what makes MTD revenue, COGS and GP correct.
//  2. CANCELLING does NOT remove the sale from its original day. #MO03-2951 was
//     cancelled AND refunded, and still reports net_sales 149.99 on Aug 19.
//     Cancelling is therefore cosmetic here — it tidies the order list and the
//     order count, and buys nothing financially.
//  3. Consequently `fulfillmentCancel` (which needs a fulfillment-order scope we
//     do not hold — write_fulfillments governs FulfillmentService, not
//     FulfillmentOrder) is NOT on the critical path. The `orders` phase stays for
//     the day that scope is granted.
//  4. The credit is dated to the day the refund is issued, not the sale day. MTD
//     therefore comes out exact while the day-level split stays skewed: Aug 16-19
//     overstated, the refund day carrying the whole offset. Nothing available to
//     us changes that, and MTD is what the goal chips read.
//
// Phases (each idempotent, each honouring ?dryRun=1):
//   report     — sales by day + per-order phantom (net_sales/cogs) + on_hand
//   refund     — full refund, NO restock, NO customer notification  <-- the fix
//   inventory  — raise negative on_hand UP TO 0 (never a blanket restock)
//   orders     — strip fulfillment then cancel; blocked on scope, kept for later
//
// Why never "restock": stock must end at 0, not +1. These units really sold and
// really shipped on the SPEEKS Connect side, and our own webhook re-lists on eBay
// the moment a variant goes positive — a restock would put shipped goods back on
// sale. Both the refund and the inventory phase are explicit about this.
//
// The gateway on these orders is `ebay`, a manual gateway: refunding is a
// bookkeeping entry, no card is charged back. Verified separately that MC does
// not propagate Shopify refunds to eBay, so no buyer is touched. notify is false
// everywhere regardless.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SECRET = "sp33ks-sync-k3y-2026-x9mq";
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";

const SHOP_TO_CODE: Record<string, string> = {
  "paymore-overland-park.myshopify.com": "OVL",
  "paymore-lees-summit.myshopify.com": "LEE",
  "paymore-westport.myshopify.com": "WSP",
  "paymore-maplewood.myshopify.com": "MPL",
  "paymore-ballwin.myshopify.com": "BAL",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gql(shop: string, token: string, query: string, variables?: unknown) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch (_) { /* surfaced below */ }
  // Shopify answers 200 with an `errors` array for a bad query.
  if (!res.ok || !parsed || parsed.errors) {
    throw new Error(`${res.status} ${JSON.stringify(parsed?.errors ?? text.slice(0, 200))}`);
  }
  return parsed.data;
}

const oid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/Order/${id}`);
const bare = (gid: string) => String(gid || "").split("/").pop() || "";

// ---------------------------------------------------------------------------
// Order state: what stands right now, the money already reversed, the payment
// transaction a refund must hang off, and the inventory items behind the lines.
// ---------------------------------------------------------------------------
async function orderStates(shop: string, token: string, ids: string[]) {
  const out: Record<string, any> = {};
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const d = await gql(shop, token, `{
      nodes(ids: [${chunk.map((x) => `"${oid(x)}"`).join(",")}]) {
        ... on Order {
          id name cancelledAt createdAt currencyCode
          displayFinancialStatus displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          totalRefundedSet { shopMoney { amount } }
          fulfillments(first: 10) { id status }
          transactions { id kind status gateway amountSet { shopMoney { amount } } }
          lineItems(first: 25) {
            nodes { id quantity sku variant { id inventoryItem { id } } }
          }
        }
      }
    }`);
    for (const n of (d?.nodes ?? [])) {
      if (!n?.id) continue;
      out[bare(n.id)] = n;
    }
  }
  return out;
}

// Every inventory item the duplicates touched, with its current on_hand.
async function levelsFor(shop: string, token: string, itemIds: string[]) {
  const levels: any[] = [];
  for (let i = 0; i < itemIds.length; i += 25) {
    const d = await gql(shop, token, `{
      nodes(ids: [${itemIds.slice(i, i + 25).map((x) => `"${x}"`).join(",")}]) {
        ... on InventoryItem {
          id sku
          inventoryLevels(first: 5) {
            nodes { location { id name } quantities(names: ["on_hand","available"]) { name quantity } }
          }
        }
      }
    }`);
    for (const n of (d?.nodes ?? [])) {
      if (!n?.id) continue;
      for (const lv of (n.inventoryLevels?.nodes ?? [])) {
        const q: Record<string, number> = {};
        for (const x of (lv.quantities ?? [])) q[x.name] = x.quantity;
        levels.push({
          inventoryItemId: n.id, sku: n.sku,
          locationId: lv.location?.id, location: lv.location?.name,
          onHand: q.on_hand ?? 0, available: q.available ?? 0,
        });
      }
    }
  }
  return levels;
}

function itemsFromOrders(states: Record<string, any>, ids: string[]) {
  const set = new Set<string>();
  for (const id of ids) {
    for (const li of (states[String(id)]?.lineItems?.nodes ?? [])) {
      const ii = li?.variant?.inventoryItem?.id;
      if (ii) set.add(ii);
    }
  }
  return [...set];
}

async function auditRows(sb: any, codes: string[], onlyOrders: string[]) {
  const { data } = await sb.from("dup_order_cleanup").select("*");
  let rows = (data ?? []).filter((a: any) => codes.includes(a.store_code));
  // A probe hook: money movement is not reversible, so the mechanics get proven
  // on one order before they are trusted on seventy-four.
  if (onlyOrders.length) {
    rows = rows.filter((a: any) => onlyOrders.includes(String(a.order_name).replace(/^#/, "")));
  }
  return rows;
}

// A deterministic idempotency key, required on refundCreate since API 2026-04.
// Derived from the order id rather than random, so a retry after a timeout — or a
// re-run of this phase — can never produce a second refund for the same order.
async function idemKey(orderId: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("dup-refund:" + orderId));
  const h = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join("-");
}

const note = (ebayId: string) =>
  `Duplicate of the SPEEKS Connect import (Marketplace Connect back-fill 2026-08-20). ` +
  `eBay order ${ebayId}. Not a second sale — reversing the phantom revenue. No restock: the unit shipped.`;

// ---------------------------------------------------------------------------
// Phase: report — the phantom, measured from the dataset the dashboard reads.
// ---------------------------------------------------------------------------
async function phaseReport(sb: any, stores: any[], codes: string[]) {
  const audit = await auditRows(sb, codes, []);
  const out: any = { stores: {} };

  for (const s of stores) {
    const code = SHOP_TO_CODE[s.shop];
    if (!codes.includes(code)) continue;
    const mine = audit.filter((a: any) => a.store_code === code);
    const entry: any = { code, auditRows: mine.length };

    try {
      const d = await gql(s.shop, s.access_token, `{
        byDay: shopifyqlQuery(query: "FROM sales SHOW net_sales, cost_of_goods_sold, orders, returns GROUP BY day SINCE -25d UNTIL today ORDER BY day") {
          parseErrors tableData { rows }
        }
        byOrder: shopifyqlQuery(query: "FROM sales SHOW net_sales, cost_of_goods_sold, returns GROUP BY order_name SINCE 2026-08-01 UNTIL today LIMIT 1000") {
          parseErrors tableData { rows }
        }
      }`);
      for (const k of ["byDay", "byOrder"]) {
        if (d?.[k]?.parseErrors?.length) throw new Error(`${k}: ${d[k].parseErrors.join("; ")}`);
      }

      entry.daily = (d.byDay?.tableData?.rows ?? []).map((r: any) => ({
        day: String(r.day).slice(0, 10),
        net: r2(num(r.net_sales)),
        cogs: r2(num(r.cost_of_goods_sold)),
        gp: r2(num(r.net_sales) - num(r.cost_of_goods_sold)),
        orders: num(r.orders),
        returns: r2(Math.abs(num(r.returns))),
      }));
      const aug = entry.daily.filter((x: any) => x.day.slice(0, 7) === "2026-08");
      entry.mtd = {
        net: r2(aug.reduce((t: number, x: any) => t + x.net, 0)),
        cogs: r2(aug.reduce((t: number, x: any) => t + x.cogs, 0)),
        gp: r2(aug.reduce((t: number, x: any) => t + x.gp, 0)),
        orders: aug.reduce((t: number, x: any) => t + x.orders, 0),
        returns: r2(aug.reduce((t: number, x: any) => t + x.returns, 0)),
      };

      // The phantom that is still in the books, per duplicate order. A refunded
      // duplicate nets to zero here, so this sums to exactly what remains wrong.
      const byOrder: Record<string, any> = {};
      for (const r of (d.byOrder?.tableData?.rows ?? [])) byOrder[String(r.order_name)] = r;
      let pn = 0, pc = 0, counted = 0, absent = 0;
      entry.phantomDetail = mine.map((a: any) => {
        const r = byOrder[String(a.order_name)];
        if (!r) { absent++; return { name: a.order_name, inDataset: false }; }
        const net = num(r.net_sales), cogs = num(r.cost_of_goods_sold);
        if (net !== 0 || cogs !== 0) counted++;
        pn += net; pc += cogs;
        return { name: a.order_name, net: r2(net), cogs: r2(cogs), gp: r2(net - cogs) };
      });
      entry.phantom = {
        ordersStillCounted: counted,
        notInDataset: absent,
        net: r2(pn), cogs: r2(pc), gp: r2(pn - pc),
      };
      entry.corrected = {
        net: r2(entry.mtd.net - pn),
        cogs: r2(entry.mtd.cogs - pc),
        gp: r2(entry.mtd.gp - (pn - pc)),
      };
    } catch (e) { entry.dailyError = String(e); }

    try {
      const ids = mine.map((a: any) => a.order_id);
      const st = await orderStates(s.shop, s.access_token, ids);
      entry.orders = mine.map((a: any) => {
        const o = st[String(a.order_id)];
        const total = num(o?.totalPriceSet?.shopMoney?.amount);
        const refunded = num(o?.totalRefundedSet?.shopMoney?.amount);
        return {
          name: a.order_name, id: a.order_id, total: r2(total), refunded: r2(refunded),
          outstanding: r2(total - refunded),
          live: !!o && !o.cancelledAt,
          cancelledAt: o?.cancelledAt ?? null,
          financial: o?.displayFinancialStatus ?? null,
          openFulfillments: (o?.fulfillments ?? []).filter((f: any) => f.status !== "CANCELLED").length,
        };
      });
      entry.outstandingCount = entry.orders.filter((o: any) => o.outstanding > 0.005).length;
      entry.outstandingValue = r2(entry.orders.reduce((t: number, o: any) => t + o.outstanding, 0));

      const levels = await levelsFor(s.shop, s.access_token, itemsFromOrders(st, ids));
      const neg = levels.filter((l) => l.onHand < 0);
      entry.inventory = {
        touched: levels.length,
        negative: neg.length,
        deficit: neg.reduce((t, l) => t + l.onHand, 0),
        positive: levels.filter((l) => l.onHand > 0).map((l) => ({ sku: l.sku, onHand: l.onHand })),
      };
    } catch (e) { entry.ordersError = String(e); }

    out.stores[code] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase: refund — the actual correction.
// ---------------------------------------------------------------------------
async function phaseRefund(sb: any, stores: any[], codes: string[], dryRun: boolean, onlyOrders: string[]) {
  const audit = await auditRows(sb, codes, onlyOrders);
  const out: any = { dryRun, stores: {} };

  for (const s of stores) {
    const code = SHOP_TO_CODE[s.shop];
    if (!codes.includes(code)) continue;
    const mine = audit.filter((a: any) => a.store_code === code);
    if (!mine.length) continue;

    const st = await orderStates(s.shop, s.access_token, mine.map((a: any) => a.order_id));
    const log: any[] = [];
    let refundedValue = 0;

    for (const a of mine) {
      const o = st[String(a.order_id)];
      const rec: any = { name: a.order_name, id: a.order_id };
      if (!o) { rec.outcome = "not found on Shopify"; log.push(rec); continue; }

      const total = num(o.totalPriceSet?.shopMoney?.amount);
      const already = num(o.totalRefundedSet?.shopMoney?.amount);
      const outstanding = r2(total - already);
      rec.total = r2(total); rec.alreadyRefunded = r2(already); rec.outstanding = outstanding;

      // Already reversed — by the staff earlier today, or by a previous run of
      // this phase. Nothing owed, and re-refunding would over-refund.
      if (outstanding <= 0.005) {
        rec.outcome = `already reversed (refunded ${r2(already)} of ${r2(total)})`;
        log.push(rec); continue;
      }

      // The payment to hang the reversal off. `ebay` is a manual gateway, so this
      // is a ledger entry, not a chargeback.
      const sale = (o.transactions ?? []).find((t: any) =>
        t.status === "SUCCESS" && (t.kind === "SALE" || t.kind === "CAPTURE"));
      if (!sale) { rec.outcome = "no successful SALE/CAPTURE transaction to refund against"; log.push(rec); continue; }
      rec.parentTransaction = sale.id;

      const lines = (o.lineItems?.nodes ?? []).filter((li: any) => li?.id && li.quantity > 0);
      if (!lines.length) { rec.outcome = "no refundable line items"; log.push(rec); continue; }
      rec.lines = lines.length;

      if (dryRun) {
        rec.outcome = `would refund ${outstanding} across ${lines.length} line item(s), NO_RESTOCK, notify off`;
        log.push(rec); continue;
      }

      try {
        const d = await gql(s.shop, s.access_token, `mutation($input: RefundInput!, $key: String!) {
          refundCreate(input: $input) @idempotent(key: $key) {
            refund { id createdAt totalRefundedSet { shopMoney { amount } } }
            userErrors { field message }
          }
        }`, {
          key: await idemKey(String(a.order_id)),
          input: {
            orderId: oid(a.order_id),
            currency: o.totalPriceSet?.shopMoney?.currencyCode || o.currencyCode || "USD",
            notify: false,
            note: note(a.ebay_order_id),
            // NO_RESTOCK is the whole point: the unit shipped on our own order.
            refundLineItems: lines.map((li: any) => ({
              lineItemId: li.id, quantity: li.quantity, restockType: "NO_RESTOCK",
            })),
            shipping: { fullRefund: true },
            transactions: [{
              orderId: oid(a.order_id),
              gateway: sale.gateway,
              kind: "REFUND",
              amount: String(outstanding),
              parentId: sale.id,
            }],
          },
        });
        const errs = d?.refundCreate?.userErrors ?? [];
        if (errs.length) {
          rec.outcome = `refund rejected: ${JSON.stringify(errs)}`;
        } else {
          const amt = num(d?.refundCreate?.refund?.totalRefundedSet?.shopMoney?.amount);
          refundedValue += amt;
          rec.outcome = `refunded ${r2(amt)}`;
          rec.refundId = d?.refundCreate?.refund?.id;
        }
      } catch (e) { rec.outcome = `refund threw: ${String(e)}`; }

      await sb.from("dup_order_cleanup")
        .update({ result: rec.outcome, acted_at: new Date().toISOString() }).eq("id", a.id);
      log.push(rec);
      await sleep(150);
    }

    // Prove it against Shopify rather than trusting the mutation's own word.
    let verified: any = null;
    if (!dryRun) {
      await sleep(2500);
      const after = await orderStates(s.shop, s.access_token, mine.map((a: any) => a.order_id));
      const still = mine.filter((a: any) => {
        const o = after[String(a.order_id)];
        if (!o) return false;
        return r2(num(o.totalPriceSet?.shopMoney?.amount) - num(o.totalRefundedSet?.shopMoney?.amount)) > 0.005;
      });
      verified = {
        refundedThisRun: r2(refundedValue),
        stillOutstanding: still.length,
        stillOutstandingOrders: still.map((a: any) => a.order_name),
      };
    }

    out.stores[code] = { attempted: mine.length, log, verified };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase: inventory — raise negatives UP TO 0. Nothing else moves.
// ---------------------------------------------------------------------------
async function phaseInventory(sb: any, stores: any[], codes: string[], dryRun: boolean) {
  const audit = await auditRows(sb, codes, []);
  const out: any = { dryRun, stores: {} };

  for (const s of stores) {
    const code = SHOP_TO_CODE[s.shop];
    if (!codes.includes(code)) continue;
    const mine = audit.filter((a: any) => a.store_code === code);
    if (!mine.length) continue;

    const ids = mine.map((a: any) => a.order_id);
    const st = await orderStates(s.shop, s.access_token, ids);
    const itemIds = itemsFromOrders(st, ids);
    const levels = await levelsFor(s.shop, s.access_token, itemIds);

    const neg = levels.filter((l) => l.onHand < 0);
    const entry: any = {
      touched: levels.length,
      negative: neg.length,
      deficit: neg.reduce((t, l) => t + l.onHand, 0),
      plan: neg.map((l) => ({ sku: l.sku, from: l.onHand, to: 0, location: l.location })),
      // Left alone deliberately: a variant already reading positive is either a
      // real multi-quantity SKU or was restocked by an earlier hand refund.
      // Pushing it DOWN is a different judgement call and not this pass's job.
      positiveLeftAlone: levels.filter((l) => l.onHand > 0).map((l) => ({ sku: l.sku, onHand: l.onHand })),
    };

    if (!dryRun && neg.length) {
      entry.results = [];
      for (let i = 0; i < neg.length; i += 40) {
        const chunk = neg.slice(i, i + 40);
        try {
          const d = await gql(s.shop, s.access_token, `mutation($input: InventorySetQuantitiesInput!, $key: String!) {
            inventorySetQuantities(input: $input) @idempotent(key: $key) {
              inventoryAdjustmentGroup { createdAt reason changes { name delta quantityAfterChange } }
              userErrors { field message code }
            }
          }`, {
            // Keyed on the batch's own contents, so a retry after a timeout
            // replays rather than double-adjusts.
            key: await idemKey(code + ":inv:" + chunk.map((l) => l.inventoryItemId).join(",")),
            input: {
              name: "on_hand",
              reason: "correction",
              referenceDocumentUri: "https://speeks.net/ops/mc-duplicate-backfill-2026-08-20",
              // `changeFromQuantity` is documented as optional but the mutation
              // rejects the input without it. It makes this a compare-and-set:
              // the value came from levelsFor() moments ago, so if a real sale
              // lands in between, that item is rejected rather than stamped over.
              quantities: chunk.map((l) => ({
                inventoryItemId: l.inventoryItemId, locationId: l.locationId,
                quantity: 0, changeFromQuantity: l.onHand,
              })),
            },
          });
          const errs = d?.inventorySetQuantities?.userErrors ?? [];
          entry.results.push({
            batch: chunk.length,
            errors: errs.length ? errs : null,
            changes: (d?.inventorySetQuantities?.inventoryAdjustmentGroup?.changes ?? []).length,
          });
        } catch (e) { entry.results.push({ batch: chunk.length, error: String(e) }); }
        await sleep(150);
      }
      const after = await levelsFor(s.shop, s.access_token, itemIds);
      entry.verified = {
        stillNegative: after.filter((l) => l.onHand < 0).map((l) => ({ sku: l.sku, onHand: l.onHand })),
        nowZero: after.filter((l) => l.onHand === 0).length,
      };
    }

    out.stores[code] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase: orders — cosmetic tidy-up, blocked on a fulfillment-order scope.
// Kept so that granting write_merchant_managed_fulfillment_orders is a one-call
// finish rather than a rebuild. Financially it changes nothing (fact 2 above).
// ---------------------------------------------------------------------------
async function phaseOrders(sb: any, stores: any[], codes: string[], dryRun: boolean, onlyOrders: string[]) {
  const audit = await auditRows(sb, codes, onlyOrders);
  const out: any = { dryRun, stores: {} };

  for (const s of stores) {
    const code = SHOP_TO_CODE[s.shop];
    if (!codes.includes(code)) continue;
    const mine = audit.filter((a: any) => a.store_code === code);
    if (!mine.length) continue;

    const st = await orderStates(s.shop, s.access_token, mine.map((a: any) => a.order_id));
    const log: any[] = [];

    for (const a of mine) {
      const o = st[String(a.order_id)];
      const rec: any = { name: a.order_name, id: a.order_id };
      if (!o) { rec.outcome = "not found on Shopify"; log.push(rec); continue; }
      if (o.cancelledAt) { rec.outcome = `already cancelled ${o.cancelledAt}`; log.push(rec); continue; }

      const open = (o.fulfillments ?? []).filter((f: any) => f.status !== "CANCELLED");
      rec.fulfillmentsToCancel = open.length;
      if (dryRun) {
        rec.outcome = `would cancel ${open.length} fulfillment(s), then cancel the order`;
        log.push(rec); continue;
      }

      let blocked = false;
      rec.fulfillmentResults = [];
      for (const f of open) {
        try {
          const d = await gql(s.shop, s.access_token, `mutation($id: ID!) {
            fulfillmentCancel(id: $id) { fulfillment { id status } userErrors { field message } }
          }`, { id: f.id });
          const errs = d?.fulfillmentCancel?.userErrors ?? [];
          if (errs.length) { blocked = true; rec.fulfillmentResults.push({ id: f.id, errors: errs }); }
          else rec.fulfillmentResults.push({ id: f.id, status: d?.fulfillmentCancel?.fulfillment?.status });
        } catch (e) { blocked = true; rec.fulfillmentResults.push({ id: f.id, error: String(e) }); }
      }
      if (blocked) { rec.outcome = "fulfillment cancel blocked — order left alone"; log.push(rec); continue; }

      try {
        // refund: false — the refund phase owns the money and has already run.
        const d = await gql(s.shop, s.access_token, `mutation($orderId: ID!, $note: String) {
          orderCancel(orderId: $orderId, reason: OTHER, refund: false, restock: false,
                      notifyCustomer: false, staffNote: $note) {
            job { id done }
            orderCancelUserErrors { field message code }
          }
        }`, { orderId: oid(a.order_id), note: note(a.ebay_order_id) });
        const errs = d?.orderCancel?.orderCancelUserErrors ?? [];
        rec.outcome = errs.length ? `cancel rejected: ${JSON.stringify(errs)}` : "cancel job queued";
      } catch (e) { rec.outcome = `cancel threw: ${String(e)}`; }

      log.push(rec);
      await sleep(120);
    }

    out.stores[code] = { attempted: mine.length, log };
  }
  return out;
}

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: stores } = await sb.from("shopify_stores").select("shop, access_token");
  if (!stores?.length) return json({ ok: false, error: "no stores" }, 500);

  const phase = url.searchParams.get("phase") || "report";
  const dryRun = url.searchParams.get("dryRun") === "1";
  const only = (url.searchParams.get("store") || "BAL,MPL")
    .split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  const orderFilter = (url.searchParams.get("order") || "")
    .split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean);

  try {
    if (phase === "report") return json({ ok: true, phase, ...(await phaseReport(sb, stores, only)) });
    if (phase === "refund") return json({ ok: true, phase, ...(await phaseRefund(sb, stores, only, dryRun, orderFilter)) });
    if (phase === "inventory") return json({ ok: true, phase, ...(await phaseInventory(sb, stores, only, dryRun)) });
    if (phase === "orders") return json({ ok: true, phase, ...(await phaseOrders(sb, stores, only, dryRun, orderFilter)) });
    return json({ ok: false, error: `unknown phase ${phase}` }, 400);
  } catch (e) {
    return json({ ok: false, phase, error: String(e) }, 500);
  }
});
