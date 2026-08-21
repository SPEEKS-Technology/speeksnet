// ============================================================================
// shopify-recat — files the `other` pile onto the right shelf.
//
//   ?store=OVL                       DRY RUN: what would move, and by which rule
//   ?store=OVL&apply=1&secret=...    do it
//   ?apply=1&secret=...              every store
//   ?limit=25                        cap the products touched in one run
//
// DRY RUN IS THE DEFAULT AND `apply=1` NEEDS THE SECRET, because this is the
// only function in the estate that writes to somebody's product catalogue.
//
// WHAT IT MOVES. `collection_proposals` (the view) is the whole decision: it
// scores a title against `collection_rules`, longest keyword first, and only
// ever considers a product whose ONLY real collection is `other`. So this can
// put something on the wrong shelf, but it can never take a product out of a
// collection a human chose. Every add and remove lands in `collection_moves`.
//
// HOW SHOPIFY DOES IT NOW. `collectionAddProducts` / `collectionRemoveProducts`
// are gone in 2026-07 — checked by introspection rather than assumed, because
// the obvious mutation names still appear all over the docs. What exists is
// `productUpdate(product: {id, collectionsToJoin, collectionsToLeave})`, which
// is better for us anyway: joining the new shelf and leaving `other` are one
// mutation on one product, so a product can never end up on both or neither.
//
// Mutations are aliased BATCH_SIZE to a request. Shopify prices a mutation at
// ~10 cost points against a 2000-point bucket refilling at 100/s, so ten at a
// time keeps a request cheap enough to retry and slow enough not to drain the
// bucket. Throttling comes back as a 200 with an `errors` array — the same
// trap ebay-catalog documents — so a failed batch is reported, never silently
// counted as done.
//
// See [[shopify-product-taxonomy]] for why collections are the taxonomy at all,
// and [[callback-shopify-match]] for what depends on this being right.
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";
const SECRET = "sp33ks-sync-k3y-2026-x9mq";

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const SHOP_BY_STORE: Record<string, string> = {
  OVL: "paymore-overland-park.myshopify.com",
  LEE: "paymore-lees-summit.myshopify.com",
  WSP: "paymore-westport.myshopify.com",
  MPL: "paymore-maplewood.myshopify.com",
  BAL: "paymore-ballwin.myshopify.com",
};

// The junk drawer we are emptying. A proposal always leaves this one.
const FROM_HANDLE = "other";
const BATCH_SIZE = 10;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function sb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`supabase ${path}: ${res.status} ${await res.text()}`);
  return res;
}

async function shopFor(store: string): Promise<{ shop: string; token: string }> {
  const res = await sb(`shopify_stores?select=shop,store_code,access_token`);
  const rows: { shop: string; store_code: string | null; access_token: string }[] = await res.json();
  const target = rows.find(r => r.store_code === store)
    || rows.find(r => r.shop === SHOP_BY_STORE[store]);
  if (!target) throw new Error(`no shopify_stores row for ${store}`);
  return { shop: target.shop, token: target.access_token };
}

async function shopifyGql(shop: string, token: string, query: string, variables?: unknown) {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`shopify: ${JSON.stringify(body.errors).slice(0, 400)}`);
  return body.data;
}

// Collection ids are per store — the 63 collections are byte-identical across
// the five shops by franchise standard, but they are still different rows with
// different ids, so the handle→id map has to be built per shop.
async function collectionIds(shop: string, token: string): Promise<Record<string, string>> {
  const data = await shopifyGql(shop, token,
    `{ collections(first: 250) { edges { node { id handle } } } }`);
  const out: Record<string, string> = {};
  for (const e of (data?.collections?.edges ?? [])) out[e.node.handle] = e.node.id;
  return out;
}

type Proposal = {
  store_code: string; product_id: string; sku: string | null;
  title: string; keyword: string; target_handle: string;
};

async function proposalsFor(store: string): Promise<Proposal[]> {
  const res = await sb(
    `collection_proposals?store_code=eq.${store}` +
    `&select=store_code,product_id,sku,title,keyword,target_handle&order=target_handle,title`);
  return await res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const apply = url.searchParams.get("apply") === "1";
    const wanted = (url.searchParams.get("store") || "").toUpperCase();
    const limit = Math.max(0, parseInt(url.searchParams.get("limit") || "0", 10)) || 0;
    const stores = STORES.includes(wanted) ? [wanted] : STORES;

    if (apply && url.searchParams.get("secret") !== SECRET) {
      return json({ error: "apply=1 needs the secret" }, 403);
    }

    const report: Record<string, unknown> = {};
    let movedTotal = 0, proposedTotal = 0;

    for (const store of stores) {
      const proposals = await proposalsFor(store);
      proposedTotal += proposals.length;

      // What this store would do, by shelf — the useful shape for a human
      // reading a dry run, and cheap enough to include in an apply too.
      const byShelf: Record<string, number> = {};
      for (const p of proposals) byShelf[p.target_handle] = (byShelf[p.target_handle] ?? 0) + 1;

      if (!apply) {
        report[store] = {
          proposed: proposals.length,
          by_shelf: byShelf,
          sample: proposals.slice(0, 10).map(p => ({
            title: p.title, rule: p.keyword, to: p.target_handle,
          })),
        };
        continue;
      }

      const { shop, token } = await shopFor(store);
      const ids = await collectionIds(shop, token);
      const fromId = ids[FROM_HANDLE];
      if (!fromId) throw new Error(`${store}: no '${FROM_HANDLE}' collection`);

      const todo = limit ? proposals.slice(0, limit) : proposals;
      const moved: Proposal[] = [];
      const failed: { title: string; why: string }[] = [];

      for (let i = 0; i < todo.length; i += BATCH_SIZE) {
        const batch = todo.slice(i, i + BATCH_SIZE);
        const parts: string[] = [];
        const usable: Proposal[] = [];

        batch.forEach((p, n) => {
          const toId = ids[p.target_handle];
          if (!toId) { failed.push({ title: p.title, why: `no collection ${p.target_handle}` }); return; }
          usable.push(p);
          parts.push(
            `m${n}: productUpdate(product: { id: "${p.product_id}", ` +
            `collectionsToJoin: ["${toId}"], collectionsToLeave: ["${fromId}"] }) ` +
            `{ userErrors { field message } }`);
        });
        if (!parts.length) continue;

        const data = await shopifyGql(shop, token, `mutation { ${parts.join("\n")} }`);

        // A userErrors array is Shopify saying no while answering 200. Each
        // alias is its own product, so one refusal must not discredit the nine
        // that worked — hence the per-alias read rather than a batch verdict.
        usable.forEach((p, n) => {
          const errs = data?.[`m${n}`]?.userErrors ?? [];
          if (errs.length) failed.push({ title: p.title, why: errs.map((e: any) => e.message).join("; ") });
          else moved.push(p);
        });
      }

      if (moved.length) {
        await sb("collection_moves", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(moved.map(p => ({
            store_code: store, product_id: p.product_id, sku: p.sku, title: p.title,
            added_handle: p.target_handle, removed_handle: FROM_HANDLE, rule_keyword: p.keyword,
          }))),
        });
      }

      movedTotal += moved.length;
      report[store] = {
        proposed: proposals.length, moved: moved.length, failed: failed.length,
        by_shelf: byShelf, errors: failed.slice(0, 20),
      };
    }

    return json({
      ok: true, mode: apply ? "applied" : "dry-run",
      proposed: proposedTotal, moved: movedTotal, stores: report,
      // ebay_catalog still holds the old collection list until the catalogue is
      // swept again; the Call Back matcher reads that table, not Shopify.
      note: apply
        ? "run ebay-catalog?store=X&sweep=1&full=1 for each store so ebay_catalog.collections catches up"
        : "nothing was written",
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
