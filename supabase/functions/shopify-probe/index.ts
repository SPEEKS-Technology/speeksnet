// ============================================================================
// shopify-probe — one-off capability check against a single Shopify store.
//
// Purpose: establish what the Admin API can actually give us on THIS plan, rather
// than designing a dashboard around what the docs imply. Every check runs
// independently and reports its own success or failure, so one unsupported field
// never hides the answers to the others. Same approach as the Gmail diagnostic
// that settled the sales-email parser in a single round trip.
//
// SETUP (no credential ever passes through chat):
//   1. In ONE store's admin: Settings -> Apps and sales channels -> Develop apps
//      -> Create an app -> Configure Admin API scopes:
//         read_orders, read_products, read_inventory
//      (add read_analytics / read_reports too if offered — it may gate ShopifyQL)
//   2. Install it, then reveal the Admin API access token (starts "shpat_").
//   3. Supabase Dashboard -> Project Settings -> Edge Functions -> Secrets, add:
//         SHOPIFY_PROBE_SHOP  = your-store.myshopify.com   (no https://)
//         SHOPIFY_PROBE_TOKEN = shpat_...
//   4. Call:  /shopify-probe?secret=<sync secret>
//
// The token lives only in Supabase secrets. It is never logged or returned — the
// response reports whether calls SUCCEEDED, never the credential itself.
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SECRET = "sp33ks-sync-k3y-2026-x9mq";

// Shopify supports each version for about 12 months and deprecates aggressively.
// Overridable so a version bump needs no redeploy.
// 2026-07 is what the app itself is pinned to in the Dev Dashboard, so probe the
// same version the real fetcher will use — a field renamed between versions would
// otherwise show as "works" here and fail in production.
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function gql(shop: string, token: string, query: string) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch (_) { /* non-JSON => surfaced below */ }
  return {
    httpStatus: res.status,
    // Shopify returns 200 with an `errors` array for a bad query, so HTTP status
    // alone does not tell us whether a check actually worked.
    ok: res.ok && !!parsed && !parsed.errors,
    errors: parsed?.errors ?? (parsed ? null : `non-JSON body: ${text.slice(0, 200)}`),
    data: parsed?.data ?? null,
    costExtension: parsed?.extensions?.cost ?? null,
  };
}

// Each check is { label, why, query }. `why` records what the answer decides, so
// the output explains itself when read back later.
const CHECKS: { key: string; why: string; query: string }[] = [
  {
    key: "shop",
    why: "Confirms auth works, and reveals the plan — ShopifyQL access may be Plus-gated.",
    query: `{ shop {
      name myshopifyDomain currencyCode ianaTimezone
      plan { displayName partnerDevelopment shopifyPlus }
    } }`,
  },
  {
    key: "scopes",
    why: "Which scopes were actually granted, vs which were requested.",
    query: `{ currentAppInstallation { accessScopes { handle } } }`,
  },
  {
    key: "recentOrders",
    why: "Proves orders are readable and shows which money fields are populated. "
       + "Net sales, order count and AOV all come from here.",
    query: `{ orders(first: 3, reverse: true, sortKey: CREATED_AT) { nodes {
      name createdAt displayFinancialStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      currentSubtotalPriceSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
      currentTotalTaxSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      lineItems(first: 2) { nodes { title quantity } }
    } } }`,
  },
  {
    key: "lineItemCost",
    why: "THE KEY QUESTION for gross margin. If unitCost comes back populated we can "
       + "compute COGS from line items — but it is CURRENT cost, not cost-at-time-of-sale, "
       + "so recomputing an old day could drift if a cost was edited since.",
    query: `{ orders(first: 2, reverse: true, sortKey: CREATED_AT) { nodes {
      name
      lineItems(first: 5) { nodes {
        title quantity
        variant { inventoryItem { unitCost { amount currencyCode } } }
      } }
    } } }`,
  },
  {
    key: "shopifyqlShape",
    why: "In 2026-07 the ShopifyQL response types changed (TableResponse is gone, "
       + "parseErrors is a String). Introspect the real shape before concluding "
       + "anything about availability — a malformed query fails identically to an "
       + "unavailable feature.",
    query: `{
      tableData: __type(name: "ShopifyqlTableData") {
        kind name
        fields { name type {
          kind name ofType { kind name ofType { kind name ofType { kind name } } }
        } }
      }
    }`,
  },
  {
    key: "shopifyqlData",
    why: "The payoff: real net sales / gross profit / order counts per day straight "
       + "from Shopify's analytics. If this returns rows, the dashboard's margin is "
       + "trustworthy and historical days stay correct through refunds.",
    query: `{ shopifyqlQuery(query: "FROM sales SHOW net_sales, gross_profit, orders GROUP BY day SINCE -7d UNTIL today ORDER BY day") {
      parseErrors
      tableData {
        rows
      }
    } }`,
  },
  {
    key: "shopifyqlMinimal",
    why: "THE COGS QUESTION. Selects only fields that must exist on any response — "
       + "__typename names the concrete type and parseErrors reports a bad query. "
       + "If this succeeds, ShopifyQL is available and gross_profit is reachable, "
       + "which means cost AT TIME OF SALE rather than current cost.",
    query: `{ shopifyqlQuery(query: "FROM sales SHOW net_sales, gross_profit, orders SINCE -7d UNTIL today") {
      __typename
      parseErrors
    } }`,
  },
  {
    key: "ordersCountToday",
    why: "Whether a server-side count is available, so the dashboard need not page "
       + "through every order just to show a total.",
    query: `{ ordersCount(query: "created_at:>=${new Date().toISOString().slice(0, 10)}") { count precision } }`,
  },
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  // Preferred source: the token shopify-oauth stored at install time, so nobody
  // ever copies a credential by hand. The env vars remain as a manual override
  // for a store that was connected some other way.
  let shop = Deno.env.get("SHOPIFY_PROBE_SHOP") || "";
  let token = Deno.env.get("SHOPIFY_PROBE_TOKEN") || "";
  let source = "env";

  if (!token) {
    const wanted = (url.searchParams.get("shop") || "").toLowerCase().trim();
    const rest = `${Deno.env.get("SUPABASE_URL")}/rest/v1/shopify_stores`
      + `?select=shop,access_token,scopes`
      + (wanted ? `&shop=eq.${encodeURIComponent(wanted)}` : "")
      + `&order=updated_at.desc&limit=1`;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const res = await fetch(rest, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = res.ok ? await res.json().catch(() => []) : [];
    if (rows.length) {
      shop = rows[0].shop;
      token = rows[0].access_token;
      source = "shopify_stores";
    }
  }

  if (!shop || !token) {
    return json({
      ok: false,
      error: "no Shopify token available",
      howToFix: "Run the install once: /shopify-oauth?shop=<store>.myshopify.com — it stores "
              + "the token in shopify_stores and this probe picks it up automatically. "
              + "Or set SHOPIFY_PROBE_SHOP / SHOPIFY_PROBE_TOKEN as edge function secrets "
              + "to override.",
      apiVersion: API_VERSION,
    }, 400);
  }

  const results: Record<string, unknown> = {};
  for (const check of CHECKS) {
    try {
      const r = await gql(shop, token, check.query);
      results[check.key] = {
        why: check.why,
        ok: r.ok,
        httpStatus: r.httpStatus,
        errors: r.errors,
        data: r.data,
        queryCost: r.costExtension,
      };
    } catch (err) {
      results[check.key] = { why: check.why, ok: false, thrown: String(err) };
    }
  }

  const passed = Object.keys(results).filter(k => (results[k] as any).ok);
  return json({
    ok: true,
    shop,                       // domain only — never the token
    tokenSource: source,
    apiVersion: API_VERSION,
    summary: {
      passed,
      failed: Object.keys(results).filter(k => !(results[k] as any).ok),
      // Plain-language read of the one answer that shapes the whole build.
      cogsVerdict:
        (results.shopifyqlMinimal as any)?.ok
          ? "ShopifyQL reachable — prefer it for COGS (cost at time of sale). "
            + "Check parseErrors in the payload before trusting gross_profit."
        : (results.lineItemCost as any)?.ok
          ? "No ShopifyQL; unitCost is readable — COGS computable from line items, "
            + "with the current-cost caveat (recomputing an old day can drift)"
        : "Neither path confirmed — gross margin may have to stay sheet-derived",
    },
    checks: results,
  });
});
