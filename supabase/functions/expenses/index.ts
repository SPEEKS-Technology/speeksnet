import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Who may use the tool at all. Unlike most functions here the GET is pin-gated
// too — these are people's reimbursement claims, not store operating data, so
// they should not be readable by an unauthenticated request.
const TOOL_ROLES = new Set(["ceo", "district manager", "multi-store manager"]);
// The CEO reviews everyone; a DM/MSM only ever sees their own report.
const REVIEWER_ROLES = new Set(["ceo"]);
// Who may rename/add/remove categories.
const CATALOG_ROLES = new Set(["ceo", "district manager"]);
// Who may change the mileage reimbursement rate.
const RATE_ROLES = new Set(["ceo"]);

const DEFAULT_RATE = 0.70;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// First of the month for a YYYY-MM-DD or YYYY-MM string. Everything is keyed on
// this so a report is unambiguous regardless of which day a line falls on.
function monthStart(s: string): string | null {
  const m = String(s || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

function isDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(new Date(s + "T00:00:00Z").getTime());
}

function money(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100) / 100;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const url = new URL(req.url);

  // ---- auth (both verbs) ----
  const pin = req.headers.get("x-user-pin") || "";
  if (!pin) return json({ error: "Missing x-user-pin header" }, 401);
  const { data: user } = await supabase
    .from("users").select("name, role").eq("pin", pin).single();
  if (!user) return json({ error: "Invalid PIN" }, 401);

  const role = String(user.role || "").toLowerCase().trim();
  const me = String(user.name || "").trim();
  if (!TOOL_ROLES.has(role)) return json({ error: "Insufficient role" }, 403);
  const isReviewer = REVIEWER_ROLES.has(role);

  async function currentRate(): Promise<number> {
    const { data } = await supabase
      .from("expense_settings").select("value").eq("key", "mileage_rate").maybeSingle();
    const n = Number(data?.value);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_RATE;
  }

  async function categories() {
    const { data } = await supabase
      .from("expense_categories").select("id, name, sort_order, active")
      .order("sort_order", { ascending: true }).order("name", { ascending: true });
    return data || [];
  }

  // A DM/MSM is pinned to their own report no matter what they ask for; only the
  // reviewer may name someone else.
  function scopePerson(requested: unknown): string {
    if (!isReviewer) return me;
    const p = String(requested || "").trim();
    return p || me;
  }

  if (req.method === "GET") {
    const month = monthStart(url.searchParams.get("month") || "") ||
      monthStart(new Date().toISOString().slice(0, 7))!;

    // Everyone who could file a report, so the reviewer's picker is populated
    // from the real roster rather than from whoever happens to have entries.
    const { data: staff } = await supabase
      .from("users").select("name, role")
      .in("role", ["CEO", "District Manager", "Multi-Store Manager"]);
    const people = (staff || []).map((u: any) => String(u.name)).filter(Boolean).sort();

    let q = supabase.from("expense_entries").select("*").eq("month_start", month);
    if (!isReviewer) q = q.eq("person", me);
    const { data: entries } = await q
      .order("entry_date", { ascending: true }).order("created_at", { ascending: true });

    // Which months already have anything, for the month picker.
    let mq = supabase.from("expense_entries").select("month_start");
    if (!isReviewer) mq = mq.eq("person", me);
    const { data: mrows } = await mq;
    const months = [...new Set((mrows || []).map((r: any) => r.month_start))].sort().reverse();

    return json({
      me, role, isReviewer, people, month, months,
      rate: await currentRate(),
      categories: await categories(),
      entries: entries || [],
    });
  }

  if (req.method === "POST") {
    let body: any;
    try { body = JSON.parse(await req.text()); } catch { return json({ error: "Invalid JSON" }, 400); }
    const action = String(body.action || "");

    // ---- entries ----
    if (action === "add_entry" || action === "update_entry") {
      const kind = String(body.kind || "");
      if (kind !== "expense" && kind !== "mileage") return json({ error: "Unknown entry type" }, 400);
      if (!isDate(body.entry_date)) return json({ error: "Pick a valid date." }, 400);

      const month = monthStart(String(body.entry_date));
      if (!month) return json({ error: "Pick a valid date." }, 400);

      const row: Record<string, unknown> = {
        person: scopePerson(body.person),
        month_start: month,
        kind,
        entry_date: body.entry_date,
        description: String(body.description || "").trim().slice(0, 500) || null,
        created_by: me,
        updated_at: new Date().toISOString(),
      };

      if (kind === "mileage") {
        const miles = Number(body.miles);
        if (!Number.isFinite(miles) || miles <= 0 || miles > 100000) {
          return json({ error: "Enter the miles driven." }, 400);
        }
        // The rate is snapshotted onto the line. Raising the rate later must not
        // restate a month that has already been filed.
        const rate = action === "update_entry" && Number(body.rate) > 0
          ? Number(body.rate) : await currentRate();
        row.miles = Math.round(miles * 10) / 10;
        row.rate = rate;
        row.amount = money((row.miles as number) * rate);
        row.from_loc = String(body.from_loc || "").trim().slice(0, 120) || null;
        row.to_loc = String(body.to_loc || "").trim().slice(0, 120) || null;
        row.category = null;
      } else {
        const amount = money(body.amount);
        if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
          return json({ error: "Enter an amount greater than zero." }, 400);
        }
        const cat = String(body.category || "").trim();
        if (!cat) return json({ error: "Pick a category." }, 400);
        row.amount = amount;
        row.category = cat.slice(0, 80);
        row.miles = null; row.rate = null; row.from_loc = null; row.to_loc = null;
      }

      if (action === "add_entry") {
        const { data, error } = await supabase.from("expense_entries").insert(row).select().single();
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, entry: data });
      }

      const id = String(body.id || "");
      if (!id) return json({ error: "Missing id" }, 400);
      // Re-check ownership: a DM must not be able to edit someone else's line by id.
      const { data: existing } = await supabase
        .from("expense_entries").select("person").eq("id", id).maybeSingle();
      if (!existing) return json({ error: "That line no longer exists." }, 404);
      if (!isReviewer && existing.person !== me) return json({ error: "Not your report." }, 403);
      delete row.created_by;
      const { data, error } = await supabase
        .from("expense_entries").update(row).eq("id", id).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, entry: data });
    }

    if (action === "delete_entry") {
      const id = String(body.id || "");
      if (!id) return json({ error: "Missing id" }, 400);
      const { data: existing } = await supabase
        .from("expense_entries").select("person").eq("id", id).maybeSingle();
      if (!existing) return json({ ok: true });
      if (!isReviewer && existing.person !== me) return json({ error: "Not your report." }, 403);
      const { error } = await supabase.from("expense_entries").delete().eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ---- mileage rate ----
    if (action === "set_rate") {
      if (!RATE_ROLES.has(role)) return json({ error: "Only the CEO can change the mileage rate." }, 403);
      const rate = Number(body.rate);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
        return json({ error: "Enter a rate between 0 and 100." }, 400);
      }
      const { error } = await supabase.from("expense_settings").upsert({
        key: "mileage_rate", value: String(Math.round(rate * 1000) / 1000),
        updated_by: me, updated_at: new Date().toISOString(),
      }, { onConflict: "key" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, rate: Math.round(rate * 1000) / 1000 });
    }

    // ---- category catalog ----
    if (action === "save_category") {
      if (!CATALOG_ROLES.has(role)) return json({ error: "Insufficient role" }, 403);
      const name = String(body.name || "").trim();
      if (!name || name.length > 80) return json({ error: "Enter a category name." }, 400);
      const id = String(body.id || "");
      if (id) {
        const { data: prev } = await supabase
          .from("expense_categories").select("name").eq("id", id).maybeSingle();
        const { error } = await supabase.from("expense_categories")
          .update({ name, active: body.active !== false }).eq("id", id);
        if (error) return json({ error: error.message }, 500);
        // A rename has to carry the history with it, or every line filed under the
        // old name falls out of its category.
        if (prev && prev.name && prev.name !== name) {
          await supabase.from("expense_entries").update({ category: name }).eq("category", prev.name);
        }
        return json({ ok: true, categories: await categories() });
      }
      const { data: maxRow } = await supabase
        .from("expense_categories").select("sort_order")
        .order("sort_order", { ascending: false }).limit(1).maybeSingle();
      const { error } = await supabase.from("expense_categories")
        .insert({ name, sort_order: (maxRow?.sort_order || 0) + 10 });
      if (error) {
        return json({ error: /duplicate|unique/i.test(error.message)
          ? "That category already exists." : error.message }, 400);
      }
      return json({ ok: true, categories: await categories() });
    }

    if (action === "delete_category") {
      if (!CATALOG_ROLES.has(role)) return json({ error: "Insufficient role" }, 403);
      const id = String(body.id || "");
      const { data: cat } = await supabase
        .from("expense_categories").select("name").eq("id", id).maybeSingle();
      if (!cat) return json({ ok: true, categories: await categories() });
      // Still referenced by filed lines → retire it instead of deleting, so old
      // reports keep their category label. Unused → remove it outright.
      const { count } = await supabase.from("expense_entries")
        .select("id", { count: "exact", head: true }).eq("category", cat.name);
      if ((count || 0) > 0) {
        await supabase.from("expense_categories").update({ active: false }).eq("id", id);
        return json({ ok: true, retired: true, used: count, categories: await categories() });
      }
      await supabase.from("expense_categories").delete().eq("id", id);
      return json({ ok: true, retired: false, categories: await categories() });
    }

    return json({ error: "Unknown action" }, 400);
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
});
