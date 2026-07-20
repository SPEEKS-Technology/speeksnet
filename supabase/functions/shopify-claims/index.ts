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

      // ---- Create a new case ----
      if (action === "submit_claim") {
        const store = String(body.store || "").toUpperCase();
        const caseNumber = String(body.case_number || "").trim();
        if (!store || !caseNumber) {
          return jsonResponse({ success: false, error: "Store and case number are required" }, 400);
        }
        const status = STATUSES.includes(body.status) ? body.status : "in_progress";
        // "Resolved" = no longer in progress. Stamp the resolve time if a case is
        // created already-resolved; an in-progress case has no resolved_at yet.
        const record = {
          store,
          case_number: caseNumber,
          item_sku: body.item_sku ? String(body.item_sku).trim() : null,
          price: parseMoney(body.price), // insured / claimed VALUE of the item
          cost: parseMoney(body.cost),   // store's actual cost of the item
          reason_type: body.reason_type ? String(body.reason_type).trim() : null,
          reason_detail: body.reason_detail ? String(body.reason_detail).trim() : null,
          status,
          resolved_at: status === "in_progress" ? null : new Date().toISOString(),
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
        const now = new Date().toISOString();
        // resolved_at tracks when the case left "in progress":
        //  - back to in_progress  -> clear it (e.g. marked resolved by mistake)
        //  - in_progress -> resolved -> stamp now
        //  - resolved -> other resolved (recovered<->denied) -> keep original stamp
        const { data: existing } = await supabase.from("shopify_claims")
          .select("resolved_at").eq("id", id).maybeSingle();
        let resolvedAt: string | null;
        if (body.status === "in_progress") resolvedAt = null;
        else resolvedAt = existing?.resolved_at || now;
        const { error } = await supabase.from("shopify_claims")
          .update({ status: body.status, resolved_at: resolvedAt, updated_at: now })
          .eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- Acknowledge "still in progress" (verifies the manager checked on it,
      //      resetting the 7-day aging clock without resolving the case) ----
      if (action === "ack_claim") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const now = new Date().toISOString();
        const { error } = await supabase.from("shopify_claims")
          .update({ last_checked_at: now, updated_at: now }).eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- Escalate an Item-Not-Received case: open a real loss claim as a CHILD
      //      claim linked to the parent ticket. It's a normal claim in every way
      //      (own status/value/cost/dates) — just nested under the INR it came from.
      //      Opening it also resets the parent's 7-day clock (the manager acted). ----
      if (action === "escalate_claim") {
        const parentId = String(body.id || "");
        if (!parentId) return jsonResponse({ success: false, error: "Missing parent id" }, 400);
        const { data: parent } = await supabase.from("shopify_claims")
          .select("store, item_sku, case_number").eq("id", parentId).maybeSingle();
        if (!parent) return jsonResponse({ success: false, error: "Parent case not found" }, 404);
        const now = new Date().toISOString();
        const child = {
          store: parent.store,
          case_number: body.case_number ? String(body.case_number).trim() : `${parent.case_number || "INR"} · claim`,
          item_sku: body.item_sku ? String(body.item_sku).trim() : parent.item_sku,
          price: parseMoney(body.price),
          cost: parseMoney(body.cost),
          reason_type: body.reason_type ? String(body.reason_type).trim() : null,
          reason_detail: body.reason_detail ? String(body.reason_detail).trim() : null,
          status: "in_progress",
          parent_id: parentId,
          created_by: body.created_by ? String(body.created_by).trim() : null,
        };
        const { error } = await supabase.from("shopify_claims").insert(child);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await supabase.from("shopify_claims")
          .update({ last_checked_at: now, updated_at: now }).eq("id", parentId);
        return jsonResponse({ success: true });
      }

      // ---- DM/CEO pushes a red review reminder to a store's manager(s) ----
      if (action === "send_reminder") {
        const store = String(body.store || "").toUpperCase();
        if (!store) return jsonResponse({ success: false, error: "Missing store" }, 400);
        const { error } = await supabase.from("claim_reminders").insert({
          store,
          message: body.message ? String(body.message).trim() : null,
          from_name: body.from ? String(body.from).trim() : null,
        });
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- Manager acknowledges a pushed reminder (the ✕ or "Review claims"
      //      button) — persists read state server-side so it never re-fires,
      //      even after clearing browsing data or on another device. Client
      //      localStorage alone couldn't survive that. ----
      if (action === "ack_reminder") {
        const ids = Array.isArray(body.ids)
          ? body.ids.map((x: unknown) => String(x)).filter(Boolean)
          : (body.id ? [String(body.id)] : []);
        if (!ids.length) return jsonResponse({ success: false, error: "Missing reminder id(s)" }, 400);
        const { error } = await supabase.from("claim_reminders")
          .update({
            acknowledged_at: new Date().toISOString(),
            acknowledged_by: body.by ? String(body.by).trim() : null,
          })
          .in("id", ids);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- Manager requests deletion — does NOT delete. Flags the claim as
      //      pending so a DM/CEO can approve or deny it (managers can't quietly
      //      remove claims). Stamps who asked + when. ----
      if (action === "request_delete") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const { error } = await supabase.from("shopify_claims")
          .update({
            delete_requested_at: new Date().toISOString(),
            delete_requested_by: body.requested_by ? String(body.requested_by).trim() : null,
          })
          .eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- DM/CEO denies a pending delete request — clears the flag, keeps the claim. ----
      if (action === "deny_delete") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const { error } = await supabase.from("shopify_claims")
          .update({ delete_requested_at: null, delete_requested_by: null })
          .eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- Delete a case (DM/CEO approval path; children cascade via parent_id FK).
      //      Managers reach this only by requesting → a DM/CEO approving. ----
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

  // ---- GET ----
  const url = new URL(req.url);
  const storesParam = url.searchParams.get("stores") || url.searchParams.get("store") || "";
  const stores = storesParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  // ?reminders=1[&stores=BAL,MPL] → UNACKNOWLEDGED review reminders for the
  // store(s). Once a manager acknowledges one it's filtered out here for good,
  // so it can't re-pop on a new session / device / after clearing browser data.
  if (url.searchParams.has("reminders")) {
    let rq = supabase.from("claim_reminders").select("*").is("acknowledged_at", null).order("created_at", { ascending: false }).limit(20);
    if (stores.length) rq = rq.in("store", stores);
    const { data, error } = await rq;
    if (error) return jsonResponse({ success: false, error: error.message }, 500);
    return jsonResponse({ success: true, data: data || [] });
  }

  // list cases for the requested store(s) — no stores param returns every store
  let query = supabase.from("shopify_claims").select("*").order("created_at", { ascending: false });
  if (stores.length) query = query.in("store", stores);

  const { data, error } = await query;
  if (error) return jsonResponse({ success: false, error: error.message }, 500);
  return jsonResponse({ success: true, data: data || [] });
});
