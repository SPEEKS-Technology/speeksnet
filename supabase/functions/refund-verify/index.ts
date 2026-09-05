// ============================================================================
// refund-verify — prove, per line item, that the 2026-08-26 reversal refunds
// did NOT put stock back.
//
//   ?secret=<ops>&store=OVL   (or ALL)
//
// READ-ONLY.
//
// WHY THIS EXISTS: the refunds were sent with restockType NO_RESTOCK, but that
// is what we ASKED for. `RefundLineItem.restocked` is what Shopify actually DID,
// and those are not the same claim. The items were shipped and kept by buyers,
// so a single restocked line would be phantom inventory — stock the system
// thinks exists and the shelf does not have.
//
// Reads the order ids out of refund_apply_log rather than re-deriving them, so
// it checks exactly what was written and nothing else.
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

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${path}: ${r.status}`);
  return await r.json();
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);
  const want = (url.searchParams.get("store") || "").toUpperCase().trim();
  if (!want) return json({ error: "pass ?store=OVL or ?store=ALL" }, 400);
  const stores = want === "ALL" ? Object.keys(SHOP_BY_STORE) : [want];

  const tokRows = await sbGet(`shopify_stores?select=shop,store_code,access_token`);
  const report: any[] = [];

  for (const store of stores) {
    const shop = SHOP_BY_STORE[store];
    const t = tokRows.find((x: any) => x.store_code === store) || tokRows.find((x: any) => x.shop === shop);
    if (!t) { report.push({ store, error: "no shopify_stores row" }); continue; }

    const logged = await sbGet(
      `refund_apply_log?select=shopify_order,shopify_order_id,amount&outcome=eq.refunded`
      + `&store_code=eq.${encodeURIComponent(store)}`);
    const ids = [...new Set(logged.map((l: any) => String(l.shopify_order_id)))];

    let checkedOrders = 0, checkedLines = 0, restockedLines = 0, unitsRestocked = 0;
    let noRestockType = 0, otherRestockType = 0, refundedMoney = 0;
    const offenders: any[] = [];
    const inventoryNow: any[] = [];

    for (let i = 0; i < ids.length; i += 40) {
      const batch = ids.slice(i, i + 40).map((x) => `"gid://shopify/Order/${x}"`).join(",");
      const q = `{ nodes(ids: [${batch}]) { ... on Order {
            id name totalRefundedSet { shopMoney { amount } }
            refunds(first: 10) {
              id
              refundLineItems(first: 50) { edges { node {
                quantity restocked restockType
                lineItem { sku title
                  variant { id inventoryQuantity sku } }
              } } }
            }
          } } }`;
      const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t.access_token },
        body: JSON.stringify({ query: q }),
      });
      const body = await r.json();
      if (body.errors?.length) {
        report.push({ store, error: JSON.stringify(body.errors).slice(0, 300) });
        break;
      }
      for (const o of body.data.nodes || []) {
        if (!o) continue;
        checkedOrders++;
        refundedMoney += Number(o.totalRefundedSet?.shopMoney?.amount) || 0;
        for (const rf of o.refunds || []) {
          for (const e of rf.refundLineItems?.edges || []) {
            const li = e.node;
            checkedLines++;
            if (li.restockType === "NO_RESTOCK") noRestockType++; else otherRestockType++;
            if (li.restocked) {
              restockedLines++;
              unitsRestocked += Number(li.quantity) || 0;
              if (offenders.length < 20) {
                offenders.push({
                  order: o.name, sku: li.lineItem?.sku ?? null,
                  title: li.lineItem?.title ?? null,
                  quantity: li.quantity, restockType: li.restockType,
                });
              }
            } else if (inventoryNow.length < 5) {
              // A few live inventory readings, so "not restocked" is backed by a
              // number on the variant and not only by Shopify's own flag.
              inventoryNow.push({
                order: o.name, sku: li.lineItem?.variant?.sku ?? li.lineItem?.sku ?? null,
                inventoryQuantity: li.lineItem?.variant?.inventoryQuantity ?? null,
              });
            }
          }
        }
      }
    }

    report.push({
      store,
      orders_in_log: ids.length,
      orders_checked: checkedOrders,
      refund_line_items_checked: checkedLines,
      restockType_NO_RESTOCK: noRestockType,
      restockType_other: otherRestockType,
      // The one that matters: what Shopify actually did.
      lines_actually_restocked: restockedLines,
      units_put_back_into_stock: unitsRestocked,
      money_refunded_on_these_orders: r2(refundedMoney),
      offenders,
      sample_variant_inventory: inventoryNow,
    });
  }

  const sum = (k: string) => report.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return json({
    checked_at: new Date().toISOString(),
    verdict: sum("lines_actually_restocked") === 0
      ? "NO stock was put back: every refund line reports restocked=false"
      : "⚠️ SOME LINES WERE RESTOCKED — see offenders; that is phantom inventory",
    totals: {
      orders_checked: sum("orders_checked"),
      refund_line_items_checked: sum("refund_line_items_checked"),
      restockType_NO_RESTOCK: sum("restockType_NO_RESTOCK"),
      restockType_other: sum("restockType_other"),
      lines_actually_restocked: sum("lines_actually_restocked"),
      units_put_back_into_stock: sum("units_put_back_into_stock"),
      money_refunded_on_these_orders: r2(sum("money_refunded_on_these_orders")),
    },
    report,
  });
});
