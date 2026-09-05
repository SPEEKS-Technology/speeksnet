// ============================================================================
// resale-check — did a recovered item sell again?
//
//   ?secret=<ops>&store=MPL&ebay=06-15074-80333,23-15044-02481
//   ?secret=<ops>&store=MPL&skus=MO03-2482A-R2R2,MO03-2605A-R2R3
//
// READ ONLY. Shopify GraphQL queries and PostgREST selects; nothing is written
// anywhere, and eBay is never contacted at all.
//
// WHY THIS EXISTS. When a store catches a duplicate-refund order before the
// parcel ships, eBay has already paid the buyer back but the goods are still on
// our shelf. That is a genuine return: the sale reverses, the item goes back
// into inventory, and it earns its margin again when it is re-listed and
// re-sold. Every one of those facts has to be recorded, and the last one — did
// it actually sell again, for how much, on what day — was being answered by
// hand. The three OVL recoveries were looked up one at a time in the admin,
// which is how you end up with one refund_recovered row carrying a resale, two
// carrying nothing, and no way to tell whether those two are unsold or merely
// unchecked.
//
// ⚠️ THE ORIGINAL ORDER IS ALWAYS A MATCH FOR ITS OWN SKU. Every hit is
// filtered against the recovery date AND the eBay order's own Shopify copies
// are excluded by name — otherwise the duplicate pair reads as a resale of
// itself and the store gets credited twice for one item.
//
// ⚠️ A REFUNDED HIT IS NOT A RESALE. An item that was re-listed, sold, and came
// back again is still sitting on the shelf. Refunded and cancelled orders are
// reported in their own bucket rather than counted, so the ambiguity stays
// visible instead of being resolved silently in the direction that flatters the
// store.
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

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 1), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

async function sbAll(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

interface Target {
  sku: string;
  ebay_order_id: string | null;
  exclude: Set<string>;
  after: string;
  order_total: number;
  refunded: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  if ((url.searchParams.get("secret") || "") !== OPS_SECRET) {
    return json({ error: "unauthorised" }, 401);
  }
  // ⚠️ GET ONLY, and this function must never grow a write path. Recording a
  // resale is a deliberate act against refund_recovered, done knowingly — not a
  // side effect of asking a question.
  if (req.method !== "GET") return json({ error: "read-only: GET" }, 405);

  const store = (url.searchParams.get("store") || "").toUpperCase().trim();
  if (!SHOP_BY_STORE[store]) return json({ error: `unknown store "${store}"` }, 400);

  const ebayIds = (url.searchParams.get("ebay") || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const skus = (url.searchParams.get("skus") || "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const targets: Record<string, Target> = {};

  // ⚠️ A RE-CREATED LISTING GETS A NEW SKU. When a store rebuilds the product
  // instead of correcting its stock, the SKU in refund_damage is dead and every
  // check keyed on it goes blind — the item can sell and nothing notices.
  // refund_recovered.current_sku overrides it. OVL's Ray-Bans came back as
  // KS01-7521A-R1R3 having been KS01-7521A-E10.
  const skuOverride: Record<string, string> = {};
  if (ebayIds.length) {
    const rec = await sbAll(
      "refund_recovered?select=ebay_order_id,current_sku"
      + `&ebay_order_id=in.(${ebayIds.map((x) => `"${x}"`).join(",")})`);
    for (const r of rec as any[]) {
      if (r.current_sku) skuOverride[String(r.ebay_order_id)] = String(r.current_sku);
    }
  }

  // Resolve eBay order ids to a SKU, the Shopify copies to exclude, and the date
  // after which a sale of that SKU counts as a re-sale.
  if (ebayIds.length) {
    const rows = await sbAll(
      "refund_damage?select=ebay_order_id,store_code,order_name,sku,ebay_order_total,"
      + "ebay_refund_total,shopify_refunded_at"
      + `&ebay_order_id=in.(${ebayIds.map((x) => `"${x}"`).join(",")})`);
    for (const r of rows as any[]) {
      const sku = (skuOverride[String(r.ebay_order_id)] || String(r.sku || "")).trim();
      if (!sku) continue;
      const t: Target = targets[sku] || {
        sku,
        ebay_order_id: r.ebay_order_id ? String(r.ebay_order_id) : null,
        exclude: new Set<string>(),
        after: "",
        order_total: 0,
        refunded: 0,
      };
      if (r.order_name) t.exclude.add(String(r.order_name));
      t.order_total = Math.max(t.order_total, Number(r.ebay_order_total) || 0);
      t.refunded = Math.max(t.refunded, Number(r.ebay_refund_total) || 0);
      // Earliest refund across the duplicate pair: anything sold after that is
      // a genuine second sale.
      if (r.shopify_refunded_at && (!t.after || String(r.shopify_refunded_at) < t.after)) {
        t.after = String(r.shopify_refunded_at);
      }
      targets[sku] = t;
    }
  }
  for (const s of skus) {
    if (!targets[s]) {
      targets[s] = {
        sku: s, ebay_order_id: null, exclude: new Set<string>(),
        after: "", order_total: 0, refunded: 0,
      };
    }
  }
  const wanted = Object.keys(targets);
  if (!wanted.length) {
    return json({ error: "pass ebay=<ids> or skus=<skus>; no SKU resolved" }, 400);
  }

  // ⚠️ store_code is NULL on every shopify_stores row — the shop domain is the
  // only reliable key. Filtering on store_code returns nothing and reads as
  // "store not connected", which is a lie. Same fallback netprofit-collect uses.
  const rows = await sbAll("shopify_stores?select=shop,store_code,access_token");
  const t = (rows as any[]).find((x) => x.store_code === store)
    || (rows as any[]).find((x) => x.shop === SHOP_BY_STORE[store]);
  if (!t) return json({ error: `no shopify_stores row for ${store}` }, 404);

  async function gql(query: string, variables: unknown = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await fetch(`https://${t.shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": t.access_token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
      if (r.status === 429) { await new Promise((x) => setTimeout(x, 1200)); continue; }
      if (!r.ok) throw new Error(`shopify ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const b = await r.json();
      if (b.errors) {
        if (JSON.stringify(b.errors).includes("THROTTLED")) {
          await new Promise((x) => setTimeout(x, 1200));
          continue;
        }
        throw new Error(`shopify graphql: ${JSON.stringify(b.errors).slice(0, 300)}`);
      }
      return b.data;
    }
    throw new Error("shopify throttled after 5 attempts");
  }

  const results: any[] = [];
  for (const sku of wanted) {
    const tg = targets[sku];
    // Shopify's order search indexes line-item SKU. Quoted so a SKU carrying
    // hyphens is one term rather than several.
    const d = await gql(
      `query($q: String!) {
         orders(first: 30, query: $q, sortKey: CREATED_AT, reverse: true) {
           edges { node {
             name createdAt cancelledAt
             displayFinancialStatus displayFulfillmentStatus
             currentTotalPriceSet { shopMoney { amount } }
             app { name }
             lineItems(first: 25) { edges { node { sku quantity title
               originalTotalSet { shopMoney { amount } } } } }
           } }
         }
       }`,
      { q: `sku:"${sku}"` });

    const hits: any[] = [];
    for (const e of (d?.orders?.edges || [])) {
      const n = e.node;
      const li = (n.lineItems?.edges || [])
        .map((x: any) => x.node)
        .filter((x: any) => String(x.sku || "") === sku);
      if (!li.length) continue;
      hits.push({
        order: String(n.name),
        created_at: String(n.createdAt),
        app: n.app?.name || null,
        financial: String(n.displayFinancialStatus || ""),
        fulfillment: String(n.displayFulfillmentStatus || ""),
        cancelled: !!n.cancelledAt,
        line_total: round2(li.reduce(
          (a: number, x: any) => a + Number(x.originalTotalSet?.shopMoney?.amount || 0), 0)),
        order_total: round2(Number(n.currentTotalPriceSet?.shopMoney?.amount || 0)),
        title: li[0]?.title || null,
      });
    }

    // Can it actually be re-listed? A refund does NOT restock unless it was
    // taken with RESTOCK, and the cleanup path hard-codes NO_RESTOCK on the
    // reasoning that the buyer kept the goods — true for a shipped order, false
    // for exactly these. An item sitting on the shelf at 0 on hand cannot be
    // listed, so "we saved it" and "we can sell it" are separate facts and both
    // have to be checked.
    const inv = await gql(
      `query($q: String!) {
         productVariants(first: 10, query: $q) {
           edges { node { sku inventoryQuantity
             product { title status } } }
         }
       }`,
      { q: `sku:"${sku}"` });
    const variants = (inv?.productVariants?.edges || [])
      .map((x: any) => x.node)
      .filter((x: any) => String(x.sku || "") === sku)
      .map((x: any) => ({
        on_hand: Number(x.inventoryQuantity) || 0,
        product_status: x.product?.status || null,
        title: x.product?.title || null,
      }));
    // ⚠️ NO VARIANT IS NOT ZERO STOCK. Reducing an empty list gives 0, which
    // reads as "on the shelf, none left" when the truth is "this SKU no longer
    // exists in Shopify" — a different problem with a different fix. Report it
    // as unknown and let it be seen.
    const onHand: number | null = variants.length
      ? variants.reduce((a: number, v: any) => a + v.on_hand, 0)
      : null;

    const isOriginal = (h: any) => tg.exclude.has(h.order);
    const isLater = (h: any) => !tg.after || h.created_at > tg.after;
    const stands = (h: any) =>
      !h.cancelled && !/REFUNDED|VOIDED/i.test(h.financial);

    const resales = hits.filter((h) => !isOriginal(h) && isLater(h) && stands(h));
    const ambiguous = hits.filter((h) => !isOriginal(h) && isLater(h) && !stands(h));
    resales.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

    results.push({
      sku,
      ebay_order_id: tg.ebay_order_id,
      original_value: tg.order_total || null,
      refunded_to_buyer: tg.refunded || null,
      counts_as_resale_after: tg.after || null,
      on_hand: onHand,
      product_status: variants[0]?.product_status ?? null,
      relistable: onHand !== null && onHand > 0,
      stock_note: onHand === null
        ? "no variant carries this SKU in Shopify — the listing itself is gone, not just the stock"
        : onHand > 0
          ? null
          : `${onHand} on hand — the refund did not restock it, so it cannot be `
            + "listed until stock is corrected to what is physically on the shelf",
      verdict: resales.length
        ? "RESOLD"
        : (ambiguous.length
          ? "SOLD AGAIN THEN REFUNDED/CANCELLED — treat as still on the shelf"
          : "NOT RESOLD"),
      resale: resales.length
        ? {
          order: resales[0].order,
          at: resales[0].created_at,
          amount: resales[0].line_total || resales[0].order_total,
        }
        : null,
      original_copies: hits.filter(isOriginal).map((h) => h.order),
      all_hits: hits,
      ambiguous,
    });
  }

  const resold = results.filter((r) => r.verdict === "RESOLD");
  return json({
    readOnly:
      "Shopify GraphQL queries and PostgREST selects only; nothing written, eBay not contacted",
    store,
    checked: results.length,
    resold: resold.length,
    not_resold: results.length - resold.length,
    recovered_value: round2(resold.reduce((a, r) => a + (r.resale?.amount || 0), 0)),
    results,
  });
});
