import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Variance Replies. The DM uploads the ≤ -10% variance line items per store
// per period (parsed client-side from their Excel sheet); store managers
// explain each line (gm_note), the DM responds (dm_note), managers reply back
// (mgr_reply). Tables: variance_reply_periods + variance_reply_items.

const NOTE_FIELDS = new Set(["gm_note", "dm_note", "mgr_reply"]);
const MANAGER_REPLY_DAYS = 7; // managers get a week from upload

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseNum(v: unknown): number | null {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

      // ---- DM uploads a period: header + all its line items in one call ----
      if (action === "upload_period") {
        const store = String(body.store || "").toUpperCase();
        const dateFrom = String(body.date_from || "");
        const dateTo = String(body.date_to || "");
        const items = Array.isArray(body.items) ? body.items : [];
        if (!store || !dateFrom || !dateTo) {
          return jsonResponse({ success: false, error: "store, date_from and date_to are required" }, 400);
        }
        if (!items.length) {
          return jsonResponse({ success: false, error: "No line items to upload" }, 400);
        }
        const due = new Date();
        due.setDate(due.getDate() + MANAGER_REPLY_DAYS);
        const { data: period, error: pErr } = await supabase.from("variance_reply_periods").insert({
          store,
          date_from: dateFrom,
          date_to: dateTo,
          timeframe: body.timeframe ? String(body.timeframe) : null,
          uploaded_by: body.uploaded_by ? String(body.uploaded_by).trim() : null,
          manager_due_at: due.toISOString(),
        }).select().single();
        if (pErr) return jsonResponse({ success: false, error: pErr.message }, 500);

        const rows = items.map((it: any, i: number) => ({
          period_id: period.id,
          sort_order: i,
          order_number: it.order_number ? String(it.order_number).trim() : null,
          sku: it.sku ? String(it.sku).trim() : null,
          item_title: it.item_title ? String(it.item_title).trim() : null,
          buyer_name: it.buyer_name ? String(it.buyer_name).trim() : null,
          lister_name: it.lister_name ? String(it.lister_name).trim() : null,
          variance_pct: parseNum(it.variance_pct),
          // allow pre-filled notes so the current spreadsheet cycle can be ported
          gm_note: it.gm_note ? String(it.gm_note).trim() : null,
          dm_note: it.dm_note ? String(it.dm_note).trim() : null,
          mgr_reply: it.mgr_reply ? String(it.mgr_reply).trim() : null,
        }));
        const { error: iErr } = await supabase.from("variance_reply_items").insert(rows);
        if (iErr) {
          // don't leave a header without lines
          await supabase.from("variance_reply_periods").delete().eq("id", period.id);
          return jsonResponse({ success: false, error: iErr.message }, 500);
        }
        return jsonResponse({ success: true, period_id: period.id, count: rows.length });
      }

      // ---- Save one note cell (manager gm_note / DM dm_note / manager mgr_reply) ----
      if (action === "save_note") {
        const id = String(body.item_id || "");
        const field = String(body.field || "");
        if (!id || !NOTE_FIELDS.has(field)) {
          return jsonResponse({ success: false, error: "Valid item_id and field required" }, 400);
        }
        const text = body.text === null || body.text === undefined ? "" : String(body.text).trim();
        const by = body.by ? String(body.by).trim() : null;
        const now = new Date().toISOString();
        const patch: Record<string, unknown> = {
          [field]: text || null,
          [`${field}_by`]: text ? by : null,
          [`${field}_at`]: text ? now : null,
        };
        const { data: item, error } = await supabase.from("variance_reply_items")
          .update(patch).eq("id", id).select("period_id").single();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        // First DM note on a period starts the manager "review DM notes" cycle.
        if (field === "dm_note" && text) {
          const { data: period } = await supabase.from("variance_reply_periods")
            .select("dm_notes_at").eq("id", item.period_id).maybeSingle();
          if (period && !period.dm_notes_at) {
            await supabase.from("variance_reply_periods")
              .update({ dm_notes_at: now }).eq("id", item.period_id);
          }
        }
        return jsonResponse({ success: true });
      }

      // ---- DM deletes an upload (mistake fix; items cascade) ----
      if (action === "delete_period") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const { error } = await supabase.from("variance_reply_periods").delete().eq("id", id);
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

  // ?period_id=… → the period header + every line item
  const periodId = url.searchParams.get("period_id");
  if (periodId) {
    const { data: period, error: pErr } = await supabase.from("variance_reply_periods")
      .select("*").eq("id", periodId).maybeSingle();
    if (pErr) return jsonResponse({ success: false, error: pErr.message }, 500);
    if (!period) return jsonResponse({ success: false, error: "Period not found" }, 404);
    const { data: items, error: iErr } = await supabase.from("variance_reply_items")
      .select("*").eq("period_id", periodId).order("sort_order", { ascending: true });
    if (iErr) return jsonResponse({ success: false, error: iErr.message }, 500);
    return jsonResponse({ success: true, period, items: items || [] });
  }

  // [?stores=A,B] → period list (newest first) with reply-progress counts,
  // which also powers the pulsing dots and reminder popups client-side.
  const storesParam = url.searchParams.get("stores") || "";
  const stores = storesParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  let pq = supabase.from("variance_reply_periods").select("*")
    .order("uploaded_at", { ascending: false }).limit(40);
  if (stores.length) pq = pq.in("store", stores);
  const { data: periods, error: pErr } = await pq;
  if (pErr) return jsonResponse({ success: false, error: pErr.message }, 500);

  const ids = (periods || []).map((p: any) => p.id);
  const counts: Record<string, { items: number; answered: number; awaiting_reply: number }> = {};
  if (ids.length) {
    const { data: items, error: iErr } = await supabase.from("variance_reply_items")
      .select("period_id, gm_note, dm_note, mgr_reply").in("period_id", ids);
    if (iErr) return jsonResponse({ success: false, error: iErr.message }, 500);
    (items || []).forEach((it: any) => {
      const c = (counts[it.period_id] = counts[it.period_id] || { items: 0, answered: 0, awaiting_reply: 0 });
      c.items++;
      if (it.gm_note) c.answered++;
      if (it.dm_note && !it.mgr_reply) c.awaiting_reply++; // DM asked / advised, manager hasn't replied
    });
  }
  const data = (periods || []).map((p: any) => ({
    ...p,
    ...(counts[p.id] || { items: 0, answered: 0, awaiting_reply: 0 }),
  }));
  return jsonResponse({ success: true, data });
});
