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

// Realtime "ping": after a successful write, tell signed-in clients this tool
// changed so they re-run their check (which re-fetches through the edge fn — no
// table data travels over realtime). Wrapped so it can never break the write.
async function broadcastChange(tool: string, store: string | null) {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ topic: "speeks-notify", event: "changed", payload: { tool, store: store ? String(store).toUpperCase() : null, ts: Date.now() } }],
      }),
    });
  } catch (_) { /* best-effort */ }
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
        await broadcastChange("recycle", store);
        return jsonResponse({ success: true, data });
      }

      // ---- DM review: approve/classify a line (or clear the review).
      //      "against" = truly recycled out of inventory, "for" = recycled item
      //      was a tool for store use, "ignore" = cost was consolidated into
      //      another SKU (excluded from cost totals client-side), "denied" =
      //      the DM rejected the request — do NOT recycle the item. Any verdict
      //      other than "denied" reads as approved on the manager's side. ----
      if (action === "set_reviewed") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const reviewed = !!body.reviewed;
        const verdict = ["for", "against", "ignore", "denied"].includes(body.verdict) ? body.verdict : null;
        if (reviewed && !verdict) {
          return jsonResponse({ success: false, error: "Verdict must be 'for', 'against', 'ignore' or 'denied'" }, 400);
        }
        const { error } = await supabase.from("recycle_requests")
          .update({
            reviewed_at: reviewed ? new Date().toISOString() : null,
            reviewed_by: reviewed ? (body.reviewed_by ? String(body.reviewed_by).trim() : null) : null,
            review_verdict: reviewed ? verdict : null,
          })
          .eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", null);
        return jsonResponse({ success: true });
      }

      // ---- DM note on a line (empty note clears it). The note timestamp also
      //      drives the manager-side "new activity" alert. ----
      if (action === "save_dm_note") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const note = body.note ? String(body.note).trim() : "";
        const { error } = await supabase.from("recycle_requests")
          .update({
            dm_note: note || null,
            dm_note_by: note ? (body.by ? String(body.by).trim() : null) : null,
            dm_note_at: note ? new Date().toISOString() : null,
          })
          .eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", null);
        return jsonResponse({ success: true });
      }

      // ---- Append a note to a line's back-and-forth thread (DM or manager).
      //      Notes are never overwritten: each message is a thread entry. The
      //      latest message per side is mirrored into dm_note*/mgr_reply* so
      //      the alert logic (dm_note_at / mgr_reply_at) keeps working. ----
      if (action === "add_note") {
        const id = String(body.id || "");
        const text = body.text ? String(body.text).trim() : "";
        const role = body.role === "dm" ? "dm" : "mgr";
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        if (!text) return jsonResponse({ success: false, error: "Empty note" }, 400);
        const { data: row, error: selErr } = await supabase.from("recycle_requests")
          .select("note_thread").eq("id", id).single();
        if (selErr) return jsonResponse({ success: false, error: selErr.message }, 500);
        const thread = Array.isArray(row?.note_thread) ? row.note_thread : [];
        const at = new Date().toISOString();
        const by = body.by ? String(body.by).trim() : null;
        thread.push({ role, text, by, at });
        const patch: Record<string, unknown> = { note_thread: thread };
        if (role === "dm") { patch.dm_note = text; patch.dm_note_by = by; patch.dm_note_at = at; }
        else { patch.mgr_reply = text; patch.mgr_reply_by = by; patch.mgr_reply_at = at; }
        const { error } = await supabase.from("recycle_requests").update(patch).eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", null);
        return jsonResponse({ success: true, entry: { role, text, by, at } });
      }

      // ---- Manager replies to the DM's note (empty reply clears it). The
      //      reply timestamp drives the DM-side "manager replied" alert. ----
      if (action === "save_mgr_reply") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const reply = body.reply ? String(body.reply).trim() : "";
        const { error } = await supabase.from("recycle_requests")
          .update({
            mgr_reply: reply || null,
            mgr_reply_by: reply ? (body.by ? String(body.by).trim() : null) : null,
            mgr_reply_at: reply ? new Date().toISOString() : null,
          })
          .eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", null);
        return jsonResponse({ success: true });
      }

      // ---- Viewer opened their requests: stamp the lines as seen so the
      //      NEW dots / alerts stop for them. role 'dm' stamps the DM's side;
      //      anything else stamps the manager's (backward compatible). ----
      if (action === "mark_seen") {
        const ids = Array.isArray(body.ids) ? body.ids.map((x: unknown) => String(x)).filter(Boolean) : [];
        if (!ids.length) return jsonResponse({ success: true });
        const patch = body.role === "dm"
          ? { dm_seen_at: new Date().toISOString() }
          : { manager_seen_at: new Date().toISOString() };
        const { error } = await supabase.from("recycle_requests")
          .update(patch)
          .in("id", ids);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- Manager asks for a line to be removed. Nothing is deleted here —
      //      the flag puts it in the DM/CEO approval queue (same model as the
      //      insurance-claims delete requests). ----
      if (action === "request_delete") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const { error } = await supabase.from("recycle_requests")
          .update({
            delete_requested_at: new Date().toISOString(),
            delete_requested_by: body.requested_by ? String(body.requested_by).trim() : null,
          })
          .eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", null);
        return jsonResponse({ success: true });
      }

      // ---- DM/CEO denies a pending delete request: keep the line, clear the flag. ----
      if (action === "deny_delete") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const { error } = await supabase.from("recycle_requests")
          .update({ delete_requested_at: null, delete_requested_by: null })
          .eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", null);
        return jsonResponse({ success: true });
      }

      // ---- Actually delete a line — DM/CEO only (frontend-gated): directly
      //      via their trash button, or by approving a manager's request. ----
      if (action === "delete_request") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const { error } = await supabase.from("recycle_requests").delete().eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", null);
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
