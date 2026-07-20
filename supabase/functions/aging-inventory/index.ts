import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Aging Inventory. Each week the DM hand-picks the most valuable 30-day-plus
// items from the POS and adds them here with an opening note (what to fix or
// answer on the listing). The store (manager/ASM) has a week to reply; the DM
// can keep following up (each DM note restarts the week clock) until the item
// sells (green) or gets recycled out (red). Notes are an unlimited alternating
// thread per item. Tables: aging_items + aging_notes.

const STORE_REPLY_DAYS = 7; // the store gets a week from every DM note

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

function replyDue(): string {
  const d = new Date();
  d.setDate(d.getDate() + STORE_REPLY_DAYS);
  return d.toISOString();
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

      // ---- DM adds an item, with an optional opening note ----
      // (The DM often quick-adds the week's items back-to-back and posts the
      // notes into each thread afterwards, so the note may come later.)
      if (action === "add_item") {
        const store = String(body.store || "").toUpperCase();
        const note = String(body.note || "").trim();
        if (!store) return jsonResponse({ success: false, error: "store is required" }, 400);
        const by = body.by ? String(body.by).trim() : null;
        const { data: item, error: iErr } = await supabase.from("aging_items").insert({
          store,
          sku: body.sku ? String(body.sku).trim() : null,
          title: body.title ? String(body.title).trim() : null,
          date_created: body.date_created ? String(body.date_created) : null,
          est_value: parseNum(body.est_value),
          cost: parseNum(body.cost),
          created_by: by,
          due_at: replyDue(),
        }).select().single();
        if (iErr) return jsonResponse({ success: false, error: iErr.message }, 500);
        if (note) {
          const { error: nErr } = await supabase.from("aging_notes").insert({
            item_id: item.id, author_name: by, author_side: "dm", body: note,
          });
          if (nErr) {
            // don't leave a half-created item behind
            await supabase.from("aging_items").delete().eq("id", item.id);
            return jsonResponse({ success: false, error: nErr.message }, 500);
          }
        }
        return jsonResponse({ success: true, item_id: item.id });
      }

      // ---- Either side appends to an item's note thread ----
      if (action === "add_note") {
        const itemId = String(body.item_id || "");
        const side = String(body.side || "");
        const text = String(body.body || "").trim();
        if (!itemId || !text || (side !== "dm" && side !== "store")) {
          return jsonResponse({ success: false, error: "item_id, side (dm|store) and body are required" }, 400);
        }
        const { data: item, error: gErr } = await supabase.from("aging_items")
          .select("id, status").eq("id", itemId).maybeSingle();
        if (gErr) return jsonResponse({ success: false, error: gErr.message }, 500);
        if (!item) return jsonResponse({ success: false, error: "Item not found" }, 404);
        if (item.status !== "open") {
          return jsonResponse({ success: false, error: "This item is closed" }, 400);
        }
        const { data: note, error: nErr } = await supabase.from("aging_notes").insert({
          item_id: itemId,
          author_name: body.by ? String(body.by).trim() : null,
          author_side: side,
          body: text,
        }).select().single();
        if (nErr) return jsonResponse({ success: false, error: nErr.message }, 500);
        // A DM note (opening or follow-up) restarts the store's one-week clock.
        if (side === "dm") {
          await supabase.from("aging_items").update({ due_at: replyDue() }).eq("id", itemId);
        }
        return jsonResponse({ success: true, note_id: note.id });
      }

      // ---- DM closes (sold/recycled) or reopens an item ----
      if (action === "set_status") {
        const itemId = String(body.item_id || "");
        const status = String(body.status || "");
        if (!itemId || !["open", "sold", "recycled"].includes(status)) {
          return jsonResponse({ success: false, error: "item_id and status (open|sold|recycled) required" }, 400);
        }
        const closed = status !== "open";
        const { error } = await supabase.from("aging_items").update({
          status,
          closed_by: closed ? (body.by ? String(body.by).trim() : null) : null,
          closed_at: closed ? new Date().toISOString() : null,
        }).eq("id", itemId);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- DM edits one of their own notes (typo fix; the row-edit mode
      // only exposes DM-side notes as editable, so no side check needed) ----
      if (action === "update_note") {
        const noteId = String(body.note_id || "");
        const text = String(body.body || "").trim();
        if (!noteId || !text) return jsonResponse({ success: false, error: "note_id and body required" }, 400);
        const by = body.by ? String(body.by).trim() : null;
        const { data: note, error } = await supabase.from("aging_notes")
          .update({ body: text, edited_by: by, edited_at: new Date().toISOString() })
          .eq("id", noteId).select("edited_at").single();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true, edited_at: note?.edited_at });
      }

      // ---- DM fixes a typo in the item fields ----
      if (action === "update_item") {
        const itemId = String(body.item_id || "");
        if (!itemId) return jsonResponse({ success: false, error: "item_id required" }, 400);
        const patch: Record<string, unknown> = {};
        if ("sku" in body) patch.sku = body.sku ? String(body.sku).trim() : null;
        if ("title" in body) patch.title = body.title ? String(body.title).trim() : null;
        if ("date_created" in body) patch.date_created = body.date_created ? String(body.date_created) : null;
        if ("est_value" in body) patch.est_value = parseNum(body.est_value);
        if ("cost" in body) patch.cost = parseNum(body.cost);
        if (!Object.keys(patch).length) return jsonResponse({ success: false, error: "Nothing to update" }, 400);
        const { error } = await supabase.from("aging_items").update(patch).eq("id", itemId);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- DM deletes an item added by mistake (notes cascade) ----
      if (action === "delete_item") {
        const itemId = String(body.item_id || "");
        if (!itemId) return jsonResponse({ success: false, error: "item_id required" }, 400);
        const { error } = await supabase.from("aging_items").delete().eq("id", itemId);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      return jsonResponse({ success: false, error: "Unknown action" }, 400);
    } catch (err: any) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // ---- GET [?stores=A,B] → items with their full note threads ----
  // Open items always; closed ones only from the last 45 days (they stay
  // visible in the tab's "closed" section for a while, then age out of the
  // payload — keeps egress flat as history accumulates).
  const url = new URL(req.url);
  const storesParam = url.searchParams.get("stores") || "";
  const stores = storesParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const closedCutoff = new Date(Date.now() - 45 * 86400000).toISOString();

  let q = supabase.from("aging_items").select("*")
    .or(`status.eq.open,closed_at.gt.${closedCutoff}`)
    .order("created_at", { ascending: false })
    .limit(400);
  if (stores.length) q = q.in("store", stores);
  const { data: items, error: iErr } = await q;
  if (iErr) return jsonResponse({ success: false, error: iErr.message }, 500);

  const ids = (items || []).map((it: any) => it.id);
  const notesByItem: Record<string, any[]> = {};
  if (ids.length) {
    const { data: notes, error: nErr } = await supabase.from("aging_notes")
      .select("*").in("item_id", ids).order("created_at", { ascending: true });
    if (nErr) return jsonResponse({ success: false, error: nErr.message }, 500);
    (notes || []).forEach((n: any) => {
      (notesByItem[n.item_id] = notesByItem[n.item_id] || []).push(n);
    });
  }
  const data = (items || []).map((it: any) => ({ ...it, notes: notesByItem[it.id] || [] }));
  return jsonResponse({ success: true, data });
});
