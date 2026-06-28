import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// SPEEKS Store Audit Checklist  —  PayMore audit-readiness, weekly, per store.
// A fixed master list (audit_items, DM/CEO-managed) that each store checks off
// through the week (audit_completions, shared across that store's managers).
// Resets every Monday (America/Chicago). Powers the "Audit Checklist" stat on
// the weekly CEO/DM report.
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// District Managers and CEO may manage the audit item master list.
function isAdminRole(role?: string): boolean {
  const r = (role || "").toLowerCase().trim();
  return r === "district manager" || r === "district-manager" || r === "ceo";
}

function pad(x: number) { return x < 10 ? "0" + x : "" + x; }

// Monday of the current week in America/Chicago, as YYYY-MM-DD.
function mondayCentral(): string {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const dow = now.getDay() === 0 ? 6 : now.getDay() - 1; // 0=Mon … 6=Sun
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  return monday.getFullYear() + "-" + pad(monday.getMonth() + 1) + "-" + pad(monday.getDate());
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const url = new URL(req.url);

  // -------------------- GET --------------------
  if (req.method === "GET") {
    const action = url.searchParams.get("action") || "";

    // DM/CEO management view: the full master list (active + inactive).
    if (action === "listItems") {
      const { data, error } = await supabase
        .from("audit_items")
        .select("*")
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) return json({ error: error.message }, 500);
      return json({ items: (data || []).map((t: any) => ({
        id: t.id, section: t.section, text: t.task_text, sortOrder: t.sort_order, active: t.active,
      })) });
    }

    // Manager-facing read: active items + this week's checked state for a store.
    const store = (url.searchParams.get("store") || "").toUpperCase();
    const weekStart = mondayCentral();

    const { data: items, error } = await supabase
      .from("audit_items")
      .select("*")
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) return json({ error: error.message }, 500);

    const { data: comps } = await supabase
      .from("audit_completions")
      .select("item_id")
      .eq("store", store)
      .eq("week_start", weekStart);
    const done = new Set((comps || []).map((c: any) => c.item_id));

    const list = (items || []).map((t: any) => ({
      id: t.id,
      section: t.section || "General",
      text: t.task_text,
      checked: done.has(t.id),
    }));

    return json({
      weekStart,
      items: list,
      total: list.length,
      completed: list.filter((i) => i.checked).length,
    });
  }

  // -------------------- POST --------------------
  if (req.method === "POST") {
    const body = await req.json();
    const action = body.action || "";

    // Manager: toggle an item for this store + week (shared across the store).
    if (action === "toggle") {
      const itemId = body.id;
      const store = (body.store || "").toUpperCase();
      if (!itemId || !store) return json({ error: "Missing id or store" }, 400);
      const weekStart = mondayCentral();

      if (body.checked) {
        const { error } = await supabase.from("audit_completions").upsert({
          item_id: itemId,
          store,
          week_start: weekStart,
          user_name: body.user || null,
          completed_at: new Date().toISOString(),
        }, { onConflict: "item_id,store,week_start" });
        if (error) return json({ error: error.message }, 500);
      } else {
        await supabase.from("audit_completions")
          .delete()
          .eq("item_id", itemId)
          .eq("store", store)
          .eq("week_start", weekStart);
      }
      return json({ success: true });
    }

    // ===== DM/CEO: master-list management =====
    if (action === "addItem") {
      if (!isAdminRole(body.role)) return json({ error: "Not authorized" }, 403);
      const text = (body.text || "").trim();
      if (!text) return json({ error: "Missing item text" }, 400);
      const newId = `audit_${Date.now()}`;
      const { error } = await supabase.from("audit_items").insert({
        id: newId,
        section: (body.section || "General").trim() || "General",
        task_text: text,
        sort_order: Number.isFinite(body.sortOrder) ? body.sortOrder : 0,
        active: true,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ success: true, id: newId });
    }

    if (action === "editItem") {
      if (!isAdminRole(body.role)) return json({ error: "Not authorized" }, 403);
      if (!body.id) return json({ error: "Missing id" }, 400);
      const patch: Record<string, unknown> = {};
      if (typeof body.text === "string" && body.text.trim()) patch.task_text = body.text.trim();
      if (typeof body.section === "string" && body.section.trim()) patch.section = body.section.trim();
      if (Number.isFinite(body.sortOrder)) patch.sort_order = body.sortOrder;
      if (typeof body.active === "boolean") patch.active = body.active;
      if (Object.keys(patch).length === 0) return json({ error: "Nothing to update" }, 400);
      const { error } = await supabase.from("audit_items").update(patch).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    if (action === "deleteItem") {
      if (!isAdminRole(body.role)) return json({ error: "Not authorized" }, 403);
      if (!body.id) return json({ error: "Missing id" }, 400);
      // completions cascade-delete via FK
      const { error } = await supabase.from("audit_items").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    return json({ error: "Unknown action" }, 400);
  }

  return json({ error: "Method not allowed" }, 405);
});
