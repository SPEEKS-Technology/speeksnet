import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// SPEEKS Store Audit Checklist  —  PayMore audit-readiness, per store.
// Two lists: DAILY (resets each day) and WEEKLY (resets each Monday). A fixed
// master list (audit_items, DM/CEO-managed) checked off per store, shared
// across that store's managers (audit_completions). All dates America/Chicago.
// Powers the "Audit Checklist" stat on the weekly CEO/DM report.
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
function ymd(d: Date) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

// "Now" as a Date in America/Chicago wall-clock.
function nowCentral(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
}
// Today (Central), YYYY-MM-DD.
function todayCentral(): string {
  const n = nowCentral();
  return ymd(new Date(n.getFullYear(), n.getMonth(), n.getDate()));
}
// Monday of the current week (Central), YYYY-MM-DD.
function mondayCentral(): string {
  const n = nowCentral();
  const dow = n.getDay() === 0 ? 6 : n.getDay() - 1; // 0=Mon … 6=Sun
  return ymd(new Date(n.getFullYear(), n.getMonth(), n.getDate() - dow));
}
// The period_start a given period resets on.
function periodStartFor(period: string): string {
  return period === "daily" ? todayCentral() : mondayCentral();
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
        .order("period", { ascending: true })
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) return json({ error: error.message }, 500);
      return json({ items: (data || []).map((t: any) => ({
        id: t.id, period: t.period, section: t.section, text: t.task_text, sortOrder: t.sort_order, active: t.active,
      })) });
    }

    // DM/CEO overview: every store's daily + weekly progress (item-level) in one
    // call, so leadership can track audit readiness live through the week.
    if (action === "overview") {
      const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
      const dStart = todayCentral();
      const wStart = mondayCentral();

      const { data: items, error: iErr } = await supabase
        .from("audit_items")
        .select("*")
        .eq("active", true)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (iErr) return json({ error: iErr.message }, 500);

      const { data: comps } = await supabase
        .from("audit_completions")
        .select("item_id, store, period_start")
        .in("store", STORES)
        .in("period_start", [dStart, wStart]);
      const done = new Set(
        (comps || []).map((c: any) => `${c.store}|${c.item_id}|${c.period_start}`),
      );

      const buildFor = (st: string, period: string, periodStart: string) => {
        const list = (items || [])
          .filter((t: any) => (t.period || "weekly") === period)
          .map((t: any) => ({
            id: t.id,
            section: t.section || "General",
            text: t.task_text,
            checked: done.has(`${st}|${t.id}|${periodStart}`),
          }));
        return { items: list, total: list.length, completed: list.filter((i) => i.checked).length };
      };

      const stores: Record<string, unknown> = {};
      for (const st of STORES) {
        stores[st] = {
          daily: buildFor(st, "daily", dStart),
          weekly: buildFor(st, "weekly", wStart),
        };
      }
      return json({ dayStart: dStart, weekStart: wStart, stores });
    }

    // Manager-facing read: active items + checked state for a store, both periods.
    const store = (url.searchParams.get("store") || "").toUpperCase();
    const dayStart = todayCentral();
    const weekStart = mondayCentral();

    const { data: items, error } = await supabase
      .from("audit_items")
      .select("*")
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) return json({ error: error.message }, 500);

    // Completions that matter right now: this day's and this week's.
    const { data: comps } = await supabase
      .from("audit_completions")
      .select("item_id, period_start")
      .eq("store", store)
      .in("period_start", [dayStart, weekStart]);
    const done = new Set((comps || []).map((c: any) => `${c.item_id}|${c.period_start}`));

    const build = (period: string, periodStart: string) => {
      const list = (items || [])
        .filter((t: any) => (t.period || "weekly") === period)
        .map((t: any) => ({
          id: t.id,
          section: t.section || "General",
          text: t.task_text,
          checked: done.has(`${t.id}|${periodStart}`),
        }));
      return { periodStart, items: list, total: list.length, completed: list.filter((i) => i.checked).length };
    };

    return json({ daily: build("daily", dayStart), weekly: build("weekly", weekStart) });
  }

  // -------------------- POST --------------------
  if (req.method === "POST") {
    const body = await req.json();
    const action = body.action || "";

    // Manager: toggle an item for this store + its period window (shared per store).
    if (action === "toggle") {
      const itemId = body.id;
      const store = (body.store || "").toUpperCase();
      if (!itemId || !store) return json({ error: "Missing id or store" }, 400);

      // Resolve the item's period from the DB so the period_start can't be spoofed.
      const { data: item } = await supabase
        .from("audit_items").select("period").eq("id", itemId).single();
      const period = (item?.period as string) || (body.period === "daily" ? "daily" : "weekly");
      const periodStart = periodStartFor(period);

      if (body.checked) {
        const { error } = await supabase.from("audit_completions").upsert({
          item_id: itemId,
          store,
          period_start: periodStart,
          user_name: body.user || null,
          completed_at: new Date().toISOString(),
        }, { onConflict: "item_id,store,period_start" });
        if (error) return json({ error: error.message }, 500);
      } else {
        await supabase.from("audit_completions")
          .delete()
          .eq("item_id", itemId)
          .eq("store", store)
          .eq("period_start", periodStart);
      }
      return json({ success: true });
    }

    // ===== DM/CEO: master-list management =====
    if (action === "addItem") {
      if (!isAdminRole(body.role)) return json({ error: "Not authorized" }, 403);
      const text = (body.text || "").trim();
      if (!text) return json({ error: "Missing item text" }, 400);
      const period = body.period === "daily" ? "daily" : "weekly";
      const newId = `audit_${Date.now()}`;
      const { error } = await supabase.from("audit_items").insert({
        id: newId,
        period,
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
      if (body.period === "daily" || body.period === "weekly") patch.period = body.period;
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
      const { error } = await supabase.from("audit_items").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    return json({ error: "Unknown action" }, 400);
  }

  return json({ error: "Method not allowed" }, 405);
});
