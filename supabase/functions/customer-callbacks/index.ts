// ============================================================================
// customer-callbacks — the Call Back sheet's backend.
//
// RECOVERED FROM THE DEPLOYED FUNCTION, 2026-08-21. This ran in production from
// 2026-07-02 with no source in the repository, so there was nothing to edit and
// nothing to review. Pulled back down byte-for-byte before touching it; the only
// change in this commit is the existence of the file.
//
// Seventeen functions were in that state. If you are here to change one of the
// others, fetch it the same way rather than reconstructing it from the UI.
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const STORES = new Set(["OVL", "LEE", "WSP", "MPL", "BAL"]);
const MSM_STORES = new Set(["BAL", "MPL"]);
const CORP_ROLES = new Set(["district manager", "ceo", "tom"]);
const STATUSES = new Set(["open", "contacted", "completed"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function todayCentral(): string {
  // YYYY-MM-DD for America/Chicago
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
}

// Role gate mirrors cbCanModify in speeks.js: edit/delete/restore are scoped to
// the caller's own store; the MSM (role 'manager' + multi flag) covers BAL+MPL;
// corp roles cover everything. Status changes and notes are deliberately NOT
// gated — any store acting on a callback is the cross-store signal.
function canModify(entryStore: string, role: string, store: string, multi: boolean): boolean {
  const r = (role || "").toLowerCase().trim();
  const s = (store || "").toUpperCase();
  if (CORP_ROLES.has(r) || s === "ALL") return true;
  if (multi && MSM_STORES.has(entryStore)) return true;
  return entryStore === s;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  if (req.method === "GET") {
    const url = new URL(req.url);
    const view = url.searchParams.get("view") === "archived" ? "archived" : "active";
    const store = (url.searchParams.get("store") || "ALL").toUpperCase();

    let q = supabase.from("customer_callbacks").select("*");
    q = view === "archived" ? q.not("archived_at", "is", null) : q.is("archived_at", null);
    if (STORES.has(store)) q = q.eq("store", store);
    const { data, error } = await q.order("date_of_call", { ascending: false });
    if (error) return json({ error: error.message }, 500);
    return json(data || []);
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const { action, id } = body;
    const role = (body.role || "").toLowerCase().trim();
    const store = (body.store || "").toUpperCase();
    const multi = body.multi === true;

    // Fetch the target row once for actions that need it.
    async function getEntry() {
      if (!id) return null;
      const { data } = await supabase.from("customer_callbacks").select("*").eq("id", id).single();
      return data;
    }

    if (action === "add") {
      const e = body.entry || {};
      const targetStore = String(e.store || "").toUpperCase();
      if (!STORES.has(targetStore)) return json({ error: "Invalid store" }, 400);
      // Creation scoping: corp roles pick any store, MSM picks BAL/MPL, everyone else own store.
      const canCreate = CORP_ROLES.has(role) || store === "ALL"
        || (multi ? MSM_STORES.has(targetStore) : targetStore === store);
      if (!canCreate) return json({ error: "You can only log call backs for your own store" }, 403);

      const name = String(e.customer_name || "").trim();
      const phone = String(e.phone || "").replace(/\D/g, "");
      const item = String(e.item || "").trim();
      if (!name || !item) return json({ error: "Customer name and item are required" }, 400);
      if (phone.length !== 10) return json({ error: "Phone number must be exactly 10 digits" }, 400);

      const createdBy = String(e.created_by || body.user || "Unknown").trim();
      const note = (e.note || "").trim();
      const notes = note
        ? [{ text: note, user: createdBy, store: targetStore, at: todayCentral() }]
        : [];

      const { data, error } = await supabase
        .from("customer_callbacks")
        .insert({
          store: targetStore,
          customer_name: name,
          phone,
          item,
          created_by: createdBy,
          notes,
        })
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      return json({ success: true, entry: data });
    }

    if (action === "status") {
      if (!id) return json({ error: "Missing id" }, 400);
      const status = String(body.status || "").toLowerCase();
      if (!STATUSES.has(status)) return json({ error: "Invalid status" }, 400);
      const { error } = await supabase
        .from("customer_callbacks")
        .update({
          status,
          status_by: body.status_by || body.user || null,
          status_store: (body.status_store || store || null),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    if (action === "note") {
      if (!id) return json({ error: "Missing id" }, 400);
      const n = body.note || {};
      const text = String(n.text || "").trim();
      if (!text) return json({ error: "Empty note" }, 400);
      const entry = await getEntry();
      if (!entry) return json({ error: "Not found" }, 404);
      const notes = Array.isArray(entry.notes) ? entry.notes : [];
      notes.push({
        text,
        user: String(n.user || body.user || "Unknown"),
        store: String(n.store || store || "").toUpperCase(),
        at: n.at || todayCentral(),
      });
      const { error } = await supabase
        .from("customer_callbacks")
        .update({ notes, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    if (action === "edit") {
      if (!id) return json({ error: "Missing id" }, 400);
      const entry = await getEntry();
      if (!entry) return json({ error: "Not found" }, 404);
      if (!canModify(entry.store, role, store, multi)) {
        return json({ error: "You can only edit your own store's call backs" }, 403);
      }
      const f = body.fields || {};
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof f.customer_name === "string" && f.customer_name.trim()) patch.customer_name = f.customer_name.trim();
      if (typeof f.item === "string" && f.item.trim()) patch.item = f.item.trim();
      if (typeof f.phone === "string") {
        const d = f.phone.replace(/\D/g, "");
        if (d.length !== 10) return json({ error: "Phone number must be exactly 10 digits" }, 400);
        patch.phone = d;
      }
      if (typeof f.date_of_call === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.date_of_call)) patch.date_of_call = f.date_of_call;
      const { error } = await supabase.from("customer_callbacks").update(patch).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    if (action === "delete") {
      if (!id) return json({ error: "Missing id" }, 400);
      const entry = await getEntry();
      if (!entry) return json({ error: "Not found" }, 404);
      if (!canModify(entry.store, role, store, multi)) {
        return json({ error: "You can only delete your own store's call backs" }, 403);
      }
      const { error } = await supabase.from("customer_callbacks").delete().eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    if (action === "restore") {
      if (!id) return json({ error: "Missing id" }, 400);
      const entry = await getEntry();
      if (!entry) return json({ error: "Not found" }, 404);
      if (!canModify(entry.store, role, store, multi)) {
        return json({ error: "You can only restore your own store's call backs" }, 403);
      }
      const { error } = await supabase
        .from("customer_callbacks")
        .update({
          archived_at: null,
          date_of_call: todayCentral(),  // restart the 30-day timer
          status: "open",
          status_by: null,
          status_store: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    return json({ error: "Unknown action" }, 400);
  }

  return json({ error: "Method not allowed" }, 405);
});
