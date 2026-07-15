import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Recycle-out-of-inventory requests. Replaces the old email flow: stores log
// each recycled item here as a line item (SKU / qty / per-unit cost) and the
// DM reconciles per-store cost totals at month end, ticking lines as reviewed.
// Scoped by store, same model as shopify_claims.

function parseMoney(v: unknown): number | null {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (req.method === "POST") {
    try {
      const body = JSON.parse(await req.text());
      const action = body.action;

      // ---- Log a new recycle request ----
      if (action === "submit_request") {
        const store = String(body.store || "").toUpperCase();
        const sku = String(body.sku || "").trim();
        const quantity = Math.floor(Number(body.quantity));
        if (!store || !sku) {
          return jsonResponse({ success: false, error: "Store and SKU are required" }, 400);
        }
        if (!Number.isFinite(quantity) || quantity < 1) {
          return jsonResponse({ success: false, error: "Quantity must be at least 1" }, 400);
        }
        const record = {
          store,
          sku,
          description: body.description ? String(body.description).trim() : null,
          quantity,
          value: parseMoney(body.value), // resale value of the item (optional)
          cost: parseMoney(body.cost),   // store's cost PER UNIT
          created_by: body.created_by ? String(body.created_by).trim() : null,
        };
        const { data, error } = await supabase.from("recycle_requests").insert(record).select().single();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true, data });
      }

      // ---- DM month-end reconciliation: review a line (or clear the review).
      //      Reviewing also classifies the line: "against" = truly recycled out
      //      of inventory, "for" = recycled item was a tool for store use,
      //      "ignore" = cost was consolidated into another SKU (excluded from
      //      cost totals client-side). ----
      if (action === "set_reviewed") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const reviewed = !!body.reviewed;
        const verdict = ["for", "against", "ignore"].includes(body.verdict) ? body.verdict : null;
        if (reviewed && !verdict) {
          return jsonResponse({ success: false, error: "Verdict must be 'for', 'against' or 'ignore'" }, 400);
        }
        const { error } = await supabase.from("recycle_requests")
          .update({
            reviewed_at: reviewed ? new Date().toISOString() : null,
            reviewed_by: reviewed ? (body.reviewed_by ? String(body.reviewed_by).trim() : null) : null,
            review_verdict: reviewed ? verdict : null,
          })
          .eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- Delete a line (frontend gates who sees the button: the submitting
      //      store same-day for typo fixes, DM/CEO any time) ----
      if (action === "delete_request") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const { error } = await supabase.from("recycle_requests").delete().eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      return jsonResponse({ success: false, error: "Unknown action" }, 400);
    } catch (err: any) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // ---- GET: list requests for the requested store(s); no stores param = all
  //      stores (DM/CEO oversight). Month bucketing happens client-side; cap
  //      the window server-side so the payload stays bounded as history grows. ----
  const url = new URL(req.url);
  const storesParam = url.searchParams.get("stores") || url.searchParams.get("store") || "";
  const stores = storesParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  const since = new Date();
  since.setUTCDate(1);
  since.setUTCMonth(since.getUTCMonth() - 12); // current month + 12 prior
  let query = supabase.from("recycle_requests").select("*")
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false });
  if (stores.length) query = query.in("store", stores);

  const { data, error } = await query;
  if (error) return jsonResponse({ success: false, error: error.message }, 500);
  return jsonResponse({ success: true, data: data || [] });
});
