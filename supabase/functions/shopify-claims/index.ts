import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Shopify Insurance Claims / Item-Not-Received refund cases that store managers
// open. Stored in `shopify_claims`; scoped by store so a manager only sees their
// own store's cases and a Multi-Store Manager sees every store they manage.
const STATUSES = ["in_progress", "recovered", "denied"];

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

      // ---- Create a new case ----
      if (action === "submit_claim") {
        const store = String(body.store || "").toUpperCase();
        const caseNumber = String(body.case_number || "").trim();
        if (!store || !caseNumber) {
          return jsonResponse({ success: false, error: "Store and case number are required" }, 400);
        }
        const status = STATUSES.includes(body.status) ? body.status : "in_progress";
        let price: number | null = null;
        if (body.price !== null && body.price !== "" && body.price !== undefined) {
          const p = Number(body.price);
          price = Number.isFinite(p) ? p : null;
        }
        const record = {
          store,
          case_number: caseNumber,
          item_sku: body.item_sku ? String(body.item_sku).trim() : null,
          price,
          reason_type: body.reason_type ? String(body.reason_type).trim() : null,
          reason_detail: body.reason_detail ? String(body.reason_detail).trim() : null,
          status,
          created_by: body.created_by ? String(body.created_by).trim() : null,
        };
        const { error } = await supabase.from("shopify_claims").insert(record);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- Update a case's status ----
      if (action === "update_status") {
        const id = String(body.id || "");
        if (!id || !STATUSES.includes(body.status)) {
          return jsonResponse({ success: false, error: "Valid id and status required" }, 400);
        }
        const { error } = await supabase.from("shopify_claims")
          .update({ status: body.status, updated_at: new Date().toISOString() }).eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- Delete a case ----
      if (action === "delete_claim") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const { error } = await supabase.from("shopify_claims").delete().eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      return jsonResponse({ success: false, error: "Unknown action" }, 400);
    } catch (err: any) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // ---- GET: list cases for the requested store(s) ----
  const url = new URL(req.url);
  const storesParam = url.searchParams.get("stores") || url.searchParams.get("store") || "";
  const stores = storesParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  let query = supabase.from("shopify_claims").select("*").order("created_at", { ascending: false });
  if (stores.length) query = query.in("store", stores);

  const { data, error } = await query;
  if (error) return jsonResponse({ success: false, error: error.message }, 500);
  return jsonResponse({ success: true, data: data || [] });
});
