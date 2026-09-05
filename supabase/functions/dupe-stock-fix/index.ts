// ============================================================================
// dupe-stock-fix — put the six duplicate-deleted SKUs back to zero on hand.
//
//   ?secret=<ops>                          read-only report (default)
//   ?secret=<ops>&confirm=SET-DUPE-STOCK-0 apply
//
// WHY: deleting the duplicate Shopify order does not restock, and neither did
// the sale before it. The real sale took the unit to 0 and the duplicate took
// it to -1, so removing the duplicate left the -1 behind. The item shipped once
// and is genuinely gone: 0 is the true figure, not 1.
//
// ⚠️ THE TARGET IS ALWAYS ZERO, NEVER +1. This corrects a count; it does not
// give stock back. A unit added here is a unit the shelf does not have, which
// is how an item gets sold twice for real.
//
// Every write is gated three ways and each gate is re-checked at write time:
//   - the SKU must be one of the six named below;
//   - it must currently read exactly -1, so a store that has already fixed it
//     by hand is left alone rather than overwritten;
//   - compareQuantity is sent, so a concurrent change makes Shopify reject the
//     write instead of silently clobbering it.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const CONFIRM = "SET-DUPE-STOCK-0";

const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};

// The six from dupe-delete-verify, 2026-08-26. Pinned rather than re-derived:
// the duplicate orders no longer exist, so nothing can re-find these by scan.
const TARGETS = [
  { store: "WSP", sku: "MO02-4566A-E10", what: "iBuyPower PC" },
  { store: "WSP", sku: "MO02-4627A-E2", what: "Ray-Ban Meta" },
  { store: "WSP", sku: "MO02-4544B-E5", what: "Seagate Xbox card" },
  { store: "WSP", sku: "MO02-4612B-E8", what: "AsRock RX 6500 XT" },
  { store: "MPL", sku: "MO03-2501A-R3R3", what: "Nikon D750" },
  { store: "MPL", sku: "MO03-2590A-E10", what: "iPad Mini" },
];

const EXPECT_NOW = -1;
const TARGET = 0;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${path}: ${r.status}`);
  return await r.json();
}

const qty = (levels: any[], name: string) => {
  const q = (levels || []).find((x: any) => x.name === name);
  return q ? Number(q.quantity) : null;
};

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorised" }, 401);
  const apply = url.searchParams.get("confirm") === CONFIRM;

  const tokRows = await sbGet(`shopify_stores?select=shop,store_code,access_token`);

  async function gql(store: string, query: string, variables: unknown = {}) {
    const shop = SHOP_BY_STORE[store];
    const t = tokRows.find((x: any) => x.store_code === store)
      || tokRows.find((x: any) => x.shop === shop);
    if (!t) throw new Error(`no shopify token for ${store}`);
    const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t.access_token },
      body: JSON.stringify({ query, variables }),
    });
    const body = await r.json().catch(() => null);
    if (!body) throw new Error(`Shopify non-JSON (HTTP ${r.status})`);
    if (body.errors?.length) throw new Error(JSON.stringify(body.errors).slice(0, 400));
    return body;
  }

  const rows: any[] = [];

  for (const t of TARGETS) {
    const row: any = { store: t.store, sku: t.sku, item: t.what };
    try {
      const b = await gql(t.store,
        `query($q: String!) {
           productVariants(first: 5, query: $q) {
             edges { node {
               id sku inventoryQuantity
               product { title status }
               inventoryItem {
                 id tracked
                 inventoryLevels(first: 10) {
                   edges { node {
                     id
                     location { id name }
                     quantities(names: ["available","on_hand","committed","incoming"]) {
                       name quantity
                     }
                   } }
                 }
               }
             } }
           }
         }`, { q: `sku:${t.sku}` });

      const v = (b.data.productVariants.edges || [])
        .map((e: any) => e.node).find((x: any) => x.sku === t.sku);
      if (!v) { row.skipped = "no variant with this SKU"; rows.push(row); continue; }

      row.product = v.product?.title ?? null;
      row.product_status = v.product?.status ?? null;
      row.tracked = v.inventoryItem?.tracked ?? null;
      row.available_before = v.inventoryQuantity;

      // A variant can be stocked at more than one location. Only the one
      // actually holding the negative is touched.
      const levels = (v.inventoryItem?.inventoryLevels?.edges || []).map((e: any) => e.node);
      row.locations = levels.map((l: any) => ({
        location: l.location?.name ?? null,
        available: qty(l.quantities, "available"),
        on_hand: qty(l.quantities, "on_hand"),
        committed: qty(l.quantities, "committed"),
        incoming: qty(l.quantities, "incoming"),
      }));

      const bad = levels.find((l: any) => qty(l.quantities, "on_hand") === EXPECT_NOW);
      if (!bad) {
        row.skipped = `nothing at on_hand ${EXPECT_NOW} — already corrected, or a different figure`;
        rows.push(row);
        continue;
      }

      row.location_to_fix = bad.location?.name ?? null;
      row.on_hand_before = qty(bad.quantities, "on_hand");
      row.committed = qty(bad.quantities, "committed");
      row.would_set_on_hand_to = TARGET;

      if (!apply) { row.action = "would set to 0 (dry run)"; rows.push(row); continue; }

      // on_hand is the physical count; available follows from it. Setting
      // `available` directly would leave on_hand at -1 and the two disagreeing.
      // ⚠️ 2026-07 REQUIRES @idempotent on this mutation, and it goes on the
      // FIELD, not the operation — the same shape refundCreate needed. The key
      // is per SKU and fixed, so a retry after a timeout cannot apply twice.
      const idem = JSON.stringify(`dupe-stock-zero-${t.store}-${t.sku}`);
      const m = await gql(t.store,
        `mutation($input: InventorySetQuantitiesInput!) {
           inventorySetQuantities(input: $input) @idempotent(key: ${idem}) {
             inventoryAdjustmentGroup { createdAt reason }
             userErrors { field message }
           }
         }`, {
        input: {
          name: "on_hand",
          reason: "correction",
          referenceDocumentUri: "speeks://dupe-delete-stock-correction/2026-08-26",
          quantities: [{
            inventoryItemId: v.inventoryItem.id,
            locationId: bad.location.id,
            quantity: TARGET,
            // Shopify rejects the write if someone changed it since the read.
            // ⚠️ This field is `changeFromQuantity` in 2026-07, NOT the
            // `compareQuantity` the older docs show, and there is no longer an
            // `ignoreCompareQuantity` flag — supplying the value IS the opt-in.
            // The old names are rejected at variable level, so the whole
            // mutation fails before touching anything, which is the good case.
            changeFromQuantity: qty(bad.quantities, "on_hand"),
          }],
        },
      });

      const errs = m.data.inventorySetQuantities?.userErrors || [];
      if (errs.length) {
        row.error = errs.map((e: any) => `${(e.field || []).join(".")}: ${e.message}`).join("; ");
        rows.push(row);
        continue;
      }

      // Read it back rather than trusting the mutation's own success.
      const after = await gql(t.store,
        `query($q: String!) {
           productVariants(first: 5, query: $q) {
             edges { node { sku inventoryQuantity } }
           }
         }`, { q: `sku:${t.sku}` });
      const av = (after.data.productVariants.edges || [])
        .map((e: any) => e.node).find((x: any) => x.sku === t.sku);

      row.action = "set";
      row.available_after = av ? av.inventoryQuantity : null;
      row.verified = av ? av.inventoryQuantity === TARGET : false;
    } catch (e) {
      row.error = String(e);
    }
    rows.push(row);
  }

  const set = rows.filter((r) => r.action === "set");
  const verified = set.filter((r) => r.verified);
  const failed = rows.filter((r) => r.error);

  return json({
    ran_at: new Date().toISOString(),
    mode: apply ? "APPLIED" : "dry run — nothing written",
    ...(apply ? {} : { to_apply: `add &confirm=${CONFIRM}` }),
    verdict: !apply
      ? `${rows.filter((r) => r.would_set_on_hand_to === TARGET).length} of ${TARGETS.length} would be set to 0`
      : failed.length
      ? `⚠️ ${failed.length} failed — see rows`
      : verified.length === set.length && set.length
      ? `All ${verified.length} corrected to 0 and verified by read-back`
      : "see rows",
    totals: {
      targets: TARGETS.length,
      set: set.length,
      verified_at_zero: verified.length,
      skipped: rows.filter((r) => r.skipped).length,
      failed: failed.length,
    },
    rows,
  });
});
