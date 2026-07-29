import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RETAIL_STORES = new Set(["OVL", "LEE", "WSP", "MPL", "BAL"]);

// Maps a store code to its applies_* column on checklist_tasks.
const STORE_COL: Record<string, string> = {
  OVL: "applies_ovl",
  LEE: "applies_lee",
  WSP: "applies_wsp",
  MPL: "applies_mpl",
  BAL: "applies_bal",
  CORP: "applies_corp",
};
const STORE_COL_ENTRIES = Object.entries(STORE_COL); // [code, col][]

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// District Managers (and CEO) may manage the required tasks managers see.
function isManagerRole(role?: string): boolean {
  const r = (role || "").toLowerCase().trim();
  return r === "district manager" || r === "district-manager" || r === "ceo";
}

// A task is a true "admin"/required task (non-deletable by managers) only when it's
// flagged is_global, OR it's a legacy RETAIL/CORP broadcast with NO assigned user.
// A personal task a manager added to a CORP/RETAIL store (assigned_user set,
// is_global false) is NOT admin — its owner (and DM/CEO) may delete it.
function isAdminTask(t: any): boolean {
  return (
    t?.is_global === true ||
    ((t?.store === "RETAIL" || t?.store === "CORP") && !t?.assigned_user)
  );
}

// Derive the list of store codes a required task targets, from both the
// applies_* columns (new tasks) and the legacy RETAIL/CORP sentinel (old tasks).
function storesForTask(t: any): string[] {
  const set = new Set<string>();
  for (const [code, col] of STORE_COL_ENTRIES) {
    if (t[col]) set.add(code);
  }
  if (t.store === "RETAIL") for (const s of RETAIL_STORES) set.add(s);
  if (t.store === "CORP") set.add("CORP");
  return [...set];
}

function applyFlags(stores: string[]) {
  const up = stores.map((s) => String(s).toUpperCase());
  return {
    applies_ovl: up.includes("OVL"),
    applies_lee: up.includes("LEE"),
    applies_wsp: up.includes("WSP"),
    applies_mpl: up.includes("MPL"),
    applies_bal: up.includes("BAL"),
    applies_corp: up.includes("CORP"),
  };
}

// --- Period boundaries, America/Chicago ---------------------------------
// The edge runtime is UTC, so a naive new Date() rolls the day over at 7pm
// Central and wipes checklists mid-shift. Everything below works off Central
// wall-clock dates and converts back to a real UTC instant for comparison
// against completed_at.

// "Now" as a Date whose UTC fields hold the America/Chicago wall clock.
function centralNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
}

// The UTC instant of midnight Central on a given Central calendar date.
// month is 0-based, matching Date. Starts from the naive UTC midnight and
// corrects by the offset actually in force there — a second pass settles the
// two DST changeover days, where the offset at the guess differs from the
// offset at the answer.
function centralMidnightUTC(year: number, month: number, day: number): Date {
  const target = Date.UTC(year, month, day);
  let ts = target;
  for (let i = 0; i < 2; i++) {
    const wall = new Date(new Date(ts).toLocaleString("en-US", { timeZone: "America/Chicago" })).getTime();
    ts += target - wall;
  }
  return new Date(ts);
}

function getPeriodStart(tab: string): Date {
  const now = centralNow();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();

  if (tab === "weekly") {
    const dow = now.getDay() === 0 ? 6 : now.getDay() - 1; // 0=Mon … 6=Sun
    return centralMidnightUTC(y, m, d - dow);
  }
  if (tab === "monthly") return centralMidnightUTC(y, m, 1);
  if (tab === "quarterly") return centralMidnightUTC(y, Math.floor(m / 3) * 3, 1);
  return centralMidnightUTC(y, m, d); // daily
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const url = new URL(req.url);

  if (req.method === "GET") {
    const action = url.searchParams.get("action") || "";

    // --- DM management view: list every required (global) task ---
    if (action === "listRequired") {
      const { data, error } = await supabase
        .from("checklist_tasks")
        .select("*")
        .eq("is_global", true)
        .order("created_at", { ascending: true });

      if (error) return json({ error: error.message }, 500);

      const tasks = (data || []).map((t: any) => ({
        id: t.id,
        tab: (t.tab || "daily").toLowerCase(),
        text: t.task_text,
        stores: storesForTask(t),
      }));
      return json({ tasks });
    }

    // --- Manager-facing read: personal + applicable required tasks ---
    const user = url.searchParams.get("user") || "";
    const store = (url.searchParams.get("store") || "").toUpperCase();
    // personal=1 (e.g. the TOM role): ONLY the user's own tasks — no store
    // broadcasts or required tasks. Their checklist starts blank until they
    // (or a DM) add something for them specifically.
    const personalOnly = url.searchParams.get("personal") === "1";

    const isRetailStore = RETAIL_STORES.has(store);
    const isCorpUser = store === "CORP" || store === "ALL";

    const orParts: string[] = [`assigned_user.ilike.${user}`];
    if (!personalOnly) {
      if (isRetailStore) orParts.push("store.eq.RETAIL");
      if (isCorpUser) orParts.push("store.eq.CORP");
      // Per-store required tasks: include any task flagged for this store.
      const col = STORE_COL[store];
      if (col) orParts.push(`${col}.eq.true`);
    }

    const { data: rawTasks, error } = await supabase
      .from("checklist_tasks")
      .select("*")
      .or(orParts.join(","));

    if (error) return json({ error: error.message }, 500);

    const seen = new Set<string>();
    const allTasks: any[] = [];
    for (const t of rawTasks || []) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        allTasks.push(t);
      }
    }

    const since = new Date();
    since.setDate(since.getDate() - 100);
    const { data: completions } = await supabase
      .from("checklist_completions")
      .select("task_id, completed_at")
      .ilike("user_name", user)
      .eq("store", store)
      .gte("completed_at", since.toISOString());

    const latestCompletion: Record<string, Date> = {};
    (completions || []).forEach((c: any) => {
      const d = new Date(c.completed_at);
      if (!latestCompletion[c.task_id] || d > latestCompletion[c.task_id]) {
        latestCompletion[c.task_id] = d;
      }
    });

    const result: Record<string, any[]> = { daily: [], weekly: [], monthly: [], quarterly: [] };

    allTasks.forEach((task: any) => {
      const tab = (task.tab || "daily").toLowerCase();
      if (!result[tab]) return;
      const completedAt = latestCompletion[task.id];
      const periodStart = getPeriodStart(tab);
      const checked = completedAt ? completedAt >= periodStart : false;
      result[tab].push({
        id: task.id,
        text: task.task_text,
        checked,
        isGlobal: isAdminTask(task),
      });
    });

    return json(result);
  }

  if (req.method === "POST") {
    const body = await req.json();
    const { action, id, user, store } = body;

    // ===== DM: create a required task targeting one or more stores =====
    if (action === "addRequired") {
      if (!isManagerRole(body.role)) return json({ error: "Not authorized" }, 403);
      const text = (body.text || "").trim();
      const tab = (body.tab || "daily").toLowerCase();
      const stores = Array.isArray(body.stores) ? body.stores : [];
      if (!text) return json({ error: "Missing task text" }, 400);
      if (!stores.length) return json({ error: "No stores selected" }, 400);

      const newId = `req_${Date.now()}`;
      const { error } = await supabase.from("checklist_tasks").insert({
        id: newId,
        tab,
        task_text: text,
        assigned_user: null,
        store: null,
        is_global: true,
        ...applyFlags(stores),
      });
      if (error) return json({ error: error.message }, 500);
      return json({ success: true, id: newId });
    }

    // ===== DM: edit a required task (text, period, and/or stores) =====
    if (action === "editRequired") {
      if (!isManagerRole(body.role)) return json({ error: "Not authorized" }, 403);
      if (!id) return json({ error: "Missing id" }, 400);
      const patch: Record<string, unknown> = {};
      if (typeof body.text === "string" && body.text.trim()) patch.task_text = body.text.trim();
      if (typeof body.tab === "string" && body.tab.trim()) patch.tab = body.tab.toLowerCase();
      if (Array.isArray(body.stores)) Object.assign(patch, applyFlags(body.stores));
      if (Object.keys(patch).length === 0) return json({ error: "Nothing to update" }, 400);

      const { error } = await supabase
        .from("checklist_tasks")
        .update(patch)
        .eq("id", id)
        .eq("is_global", true);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    // ===== DM: delete a required task (and its completions) =====
    if (action === "deleteRequired") {
      if (!isManagerRole(body.role)) return json({ error: "Not authorized" }, 403);
      if (!id) return json({ error: "Missing id" }, 400);
      await supabase.from("checklist_tasks").delete().eq("id", id).eq("is_global", true);
      await supabase.from("checklist_completions").delete().eq("task_id", id);
      return json({ success: true });
    }

    // ===== Manager: add a personal task =====
    if (action === "add") {
      const text = (body.text || "").trim();
      const tab = (body.tab || "daily").toLowerCase();
      if (!text || !user) return json({ error: "Missing text or user" }, 400);

      const newId = `task_${Date.now()}`;
      const { error } = await supabase.from("checklist_tasks").insert({
        id: newId,
        tab,
        task_text: text,
        assigned_user: user,
        store: (store || "").toUpperCase(),
        is_global: false,
        applies_ovl: false,
        applies_lee: false,
        applies_wsp: false,
        applies_mpl: false,
        applies_bal: false,
        applies_corp: false,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ success: true, id: newId });
    }

    // ===== Delete a personal task =====
    // A manager may delete only their own personal task. A District Manager / CEO
    // may delete ANY manager's personal task (e.g. one left behind by a previous
    // manager). True admin/global tasks are never removed here — use deleteRequired.
    if (action === "delete") {
      const { data: task } = await supabase
        .from("checklist_tasks")
        .select("store, assigned_user, is_global")
        .eq("id", id)
        .single();

      if (isAdminTask(task)) {
        return json({ error: "Cannot delete an admin task" }, 403);
      }

      const isAdmin = isManagerRole(body.role);
      if (
        !isAdmin &&
        task?.assigned_user &&
        task.assigned_user.toLowerCase() !== (user || "").toLowerCase()
      ) {
        return json({ error: "Cannot delete another user's task" }, 403);
      }

      await supabase.from("checklist_tasks").delete().eq("id", id);
      await supabase.from("checklist_completions").delete().eq("task_id", id);
      return json({ success: true });
    }

    // ===== Manager: toggle completion =====
    if (action === "toggle") {
      const checked = body.checked;
      if (checked) {
        const { error } = await supabase.from("checklist_completions").upsert({
          task_id: id,
          user_name: user,
          store: (store || "").toUpperCase(),
          completed_at: new Date().toISOString(),
        }, { onConflict: "task_id,user_name,store" });
        if (error) return json({ error: error.message }, 500);
      } else {
        await supabase
          .from("checklist_completions")
          .delete()
          .eq("task_id", id)
          .ilike("user_name", user)
          .eq("store", (store || "").toUpperCase());
      }
      return json({ success: true });
    }

    return json({ error: "Unknown action" }, 400);
  }

  return json({ error: "Method not allowed" }, 405);
});
