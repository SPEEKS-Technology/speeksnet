import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// store-calendar — the Store Calendar (replaces the Google Calendar embed).
// Table and the reasoning behind its shape: migration 0125.
//
//   GET                    every event, both scopes. The client filters to the
//                          store on screen; the whole table is a few hundred
//                          rows a year, and the district view needs all of it.
//   POST {action:'save'}   create (no id) or update (id) one event.
//   POST {action:'delete'} remove one event by id.
//
// WHO MAY WRITE is resolved from body.pin against users — never from a role
// or store the browser sends (CLAUDE.md, Identity). Ethan, 2026-10-01:
//   * store events: only that store's manager. An MSM manages both BAL and MPL.
//     ASMs, buyers, employees and the store TV account read only.
//   * company events: the district roles — DM, CEO, MOCD.
// Corporate does not edit a store's own events; they see them in the district
// view, and that store's manager owns them.
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const STORE_CODES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
// Mirrors MULTISTORE_MANAGER_STORES in speeks.js — the MSM's users.store is
// only their home store, so the second one has to be known here too.
const MULTISTORE_MANAGER_STORES = ["BAL", "MPL"];
const STORE_MANAGER_ROLES = ["manager", "owner (manager)"];
const DISTRICT_ROLES = ["district manager", "ceo", "mocd"];
// Event types live in store_calendar_categories (0128), managed by the DM.
// The corporate roles add, edit and remove them. First the DM alone (Ethan,
// 2026-10-01: "only give DM access"); widened 2026-10-05: "CEO and MOCD can
// have access to event types too".
const TYPE_ADMIN_ROLES = ["district manager", "ceo", "mocd"];
const CAT_COLS = "key, label, color, sort, active";
const REPEATS = ["none", "daily", "weekly", "monthly", "quarterly", "yearly"];

// Every word starts with a capital (Ethan, 2026-10-01: "Store Opening"). Only
// the FIRST letter is touched, so an acronym typed in capitals (PTO, B2B) stays.
// Words split on spaces, slashes and hyphens: "holiday/hour changes" ->
// "Holiday/Hour Changes".
const titleCase = (s: string) => s.trim().replace(/\s+/g, " ")
  .replace(/(^|[\s\/-])(\p{L})/gu, (_m, sep, ch) => sep + ch.toUpperCase());

const COLS = "id, scope, store, stores, title, event_date, end_date, all_day, start_time, end_time, category, notes, repeats_yearly, repeat, source, created_by, updated_by, created_at, updated_at";

const isISODate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s: unknown) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

// Which stores this person may write store events for, and whether they may
// write company events. Unknown PIN → nothing.
function powersOf(user: { role?: string; store?: string } | null) {
  if (!user) return { stores: [] as string[], company: false };
  const role = String(user.role || "").toLowerCase().trim();
  const home = String(user.store || "").toUpperCase().trim();
  if (DISTRICT_ROLES.includes(role) || role === "tom") return { stores: [], company: true };
  if (role === "multi-store manager") return { stores: MULTISTORE_MANAGER_STORES.slice(), company: false };
  if (STORE_MANAGER_ROLES.includes(role) && STORE_CODES.includes(home)) return { stores: [home], company: false };
  return { stores: [], company: false };
}

const mayWrite = (p: { stores: string[]; company: boolean }, row: { scope: string; store?: string | null }) =>
  row.scope === "company" ? p.company : p.stores.includes(String(row.store || "").toUpperCase());

// Build the row to write from what the client sent, or say what is wrong with it.
// `allowed` is the active type keys, plus the event's current type when editing
// one filed under a type that has since been removed — so it can still be saved.
function cleanEvent(e: any, allowed: Set<string>): { row?: Record<string, unknown>; error?: string } {
  const scope = e?.scope === "company" ? "company" : e?.scope === "store" ? "store" : "";
  if (!scope) return { error: "Missing scope" };
  const title = String(e.title ?? "").trim().slice(0, 140);
  if (!title) return { error: "Give the event a title" };
  if (!isISODate(e.event_date)) return { error: "Pick a date" };
  // A timed event is one day (Ethan, 2026-10-05: the end DATE is greyed out
  // unless All day is on), so an end date only counts on an all-day event.
  const end_date = e.all_day !== false && e.end_date && e.end_date !== e.event_date ? e.end_date : null;
  if (end_date && (!isISODate(end_date) || end_date < e.event_date)) return { error: "The end date is before the start date" };
  const all_day = e.all_day !== false;
  let start_time: string | null = null, end_time: string | null = null;
  if (!all_day) {
    if (!isTime(e.start_time)) return { error: "Pick a start time, or make it all day" };
    start_time = e.start_time;
    if (e.end_time) {
      if (!isTime(e.end_time)) return { error: "That end time isn't valid" };
      if (!end_date && e.end_time <= e.start_time) return { error: "The end time is before the start time" };
      end_time = e.end_time;
    }
  }
  const category = allowed.has(String(e.category)) ? String(e.category) : "other";
  const notes = String(e.notes ?? "").trim().slice(0, 2000) || null;
  // 0138. An older client sends only repeats_yearly; honour it.
  const repeat = REPEATS.includes(String(e.repeat)) ? String(e.repeat) : (e.repeats_yearly ? "yearly" : "none");
  const row: Record<string, unknown> = {
    scope, title, event_date: e.event_date, end_date, all_day, start_time, end_time,
    category, notes, repeat, repeats_yearly: repeat === "yearly",
  };
  if (scope === "store") {
    const store = String(e.store || "").toUpperCase();
    if (!STORE_CODES.includes(store)) return { error: "Unknown store" };
    row.store = store; row.stores = null;
  } else {
    const stores = Array.from(new Set((Array.isArray(e.stores) ? e.stores : [])
      .map((s: unknown) => String(s).toUpperCase())
      .filter((s: string) => STORE_CODES.includes(s))));
    if (!stores.length) return { error: "Pick at least one store" };
    // Kept in roster order so "all five" always reads the same way.
    row.stores = STORE_CODES.filter((s) => stores.includes(s));
    row.store = null;
  }
  return { row };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (req.method === "GET") {
    // PostgREST caps a response at 1000 rows without saying so; page past it.
    const events: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from("store_calendar_events").select(COLS)
        .order("event_date", { ascending: true }).order("start_time", { ascending: true, nullsFirst: true })
        .range(from, from + 999);
      if (error) return json({ success: false, error: error.message }, 500);
      events.push(...(data || []));
      if ((data || []).length < 1000) break;
    }
    const { data: categories, error: cErr } = await supabase.from("store_calendar_categories").select(CAT_COLS)
      .order("sort", { ascending: true }).order("label", { ascending: true });
    if (cErr) return json({ success: false, error: cErr.message }, 500);
    return json({ success: true, events, categories });
  }

  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  let body: any = {};
  try { body = JSON.parse(await req.text()); } catch (_) { return json({ success: false, error: "Bad request" }, 400); }

  const pin = String(body.pin || "").trim();
  if (!pin) return json({ success: false, error: "Sign in again to make changes" }, 401);
  const { data: user } = await supabase.from("users").select("name, role, store").eq("pin", pin).maybeSingle();
  // ---- event types: the DM alone ----
  if (body.action === "type_add" || body.action === "type_remove" || body.action === "type_edit") {
    if (!user || !TYPE_ADMIN_ROLES.includes(String(user.role || "").toLowerCase().trim())) {
      return json({ success: false, error: "Only corporate can change the event types" }, 403);
    }
    if (body.action === "type_remove") {
      const key = String(body.key || "");
      if (key === "other") return json({ success: false, error: "Other can't be removed — it's where everything else goes" }, 400);
      const { data, error } = await supabase.from("store_calendar_categories")
        .update({ active: false, updated_at: new Date().toISOString() }).eq("key", key).select(CAT_COLS).maybeSingle();
      if (error) return json({ success: false, error: error.message }, 500);
      if (!data) return json({ success: false, error: "That type no longer exists" }, 404);
      return json({ success: true, category: data });
    }
    const label = titleCase(String(body.label || "")).slice(0, 40);
    if (!label) return json({ success: false, error: "Give the type a name" }, 400);
    const color = /^#[0-9a-fA-F]{6}$/.test(String(body.color || "")) ? String(body.color).toLowerCase() : "#94a3b8";
    const { data: all } = await supabase.from("store_calendar_categories").select(CAT_COLS);

    // EDIT (Ethan, 2026-10-04: "edit an existing type not just remove it").
    // Rename and/or recolour. The key never changes, so every event filed under
    // the type follows it to the new name and colour — nothing is re-filed.
    // Other can be recoloured but keeps its name: it's the fallback, and a
    // store looking for somewhere to put an odd event looks for "Other".
    if (body.action === "type_edit") {
      const key = String(body.key || "");
      const cur = (all || []).find((c: any) => c.key === key);
      if (!cur) return json({ success: false, error: "That type no longer exists" }, 404);
      const newLabel = key === "other" ? cur.label : label;
      const clash = (all || []).find((c: any) => c.key !== key && c.active && String(c.label).toLowerCase() === newLabel.toLowerCase());
      if (clash) return json({ success: false, error: `${clash.label} is already a type` }, 400);
      const { data, error } = await supabase.from("store_calendar_categories")
        .update({ label: newLabel, color, updated_at: new Date().toISOString() }).eq("key", key).select(CAT_COLS).single();
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, category: data });
    }

    // Adding a name that was removed brings that one back (same key, so its
    // old events rejoin it) rather than making a twin.
    const same = (all || []).find((c: any) => String(c.label).toLowerCase() === label.toLowerCase());
    if (same && same.active) return json({ success: false, error: `${same.label} is already a type` }, 400);
    if (same) {
      const { data, error } = await supabase.from("store_calendar_categories")
        .update({ active: true, label, color, updated_at: new Date().toISOString() }).eq("key", same.key).select(CAT_COLS).single();
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, category: data });
    }
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "type";
    let key = base;
    for (let n = 2; (all || []).some((c: any) => c.key === key); n++) key = `${base}_${n}`;
    // New types go after the others, just before Other.
    const sort = Math.max(0, ...(all || []).filter((c: any) => c.key !== "other").map((c: any) => Number(c.sort) || 0)) + 10;
    const { data, error } = await supabase.from("store_calendar_categories")
      .insert({ key, label, color, sort, created_by: String(user.name || "").trim() || null }).select(CAT_COLS).single();
    if (error) return json({ success: false, error: error.message }, 500);
    return json({ success: true, category: data });
  }

  const powers = powersOf(user);
  if (!user || (!powers.company && !powers.stores.length)) {
    return json({ success: false, error: "Only the store manager can change this calendar" }, 403);
  }
  const who = String(user.name || "").trim() || null;

  // An update or delete is checked against the row AS IT IS NOW, not as the
  // client describes it — otherwise relabelling someone else's event as your
  // store's would pass the check on its way to being edited.
  let existing: any = null;
  if (body.id) {
    const { data } = await supabase.from("store_calendar_events").select(COLS).eq("id", body.id).maybeSingle();
    if (!data) return json({ success: false, error: "That event no longer exists" }, 404);
    if (!mayWrite(powers, data)) return json({ success: false, error: "You can't change this event" }, 403);
    existing = data;
  }

  if (body.action === "delete") {
    if (!existing) return json({ success: false, error: "Missing event id" }, 400);
    const { error } = await supabase.from("store_calendar_events").delete().eq("id", existing.id);
    if (error) return json({ success: false, error: error.message }, 500);
    return json({ success: true, id: existing.id });
  }

  if (body.action !== "save") return json({ success: false, error: "Unknown action" }, 400);

  const { data: cats } = await supabase.from("store_calendar_categories").select("key").eq("active", true);
  const allowed = new Set<string>((cats || []).map((c: any) => String(c.key)));
  if (existing) allowed.add(String(existing.category));
  allowed.add("other");
  const { row, error: bad } = cleanEvent(body.event, allowed);
  if (bad || !row) return json({ success: false, error: bad }, 400);
  if (!mayWrite(powers, row as any)) return json({ success: false, error: "You can't post to that calendar" }, 403);
  if (existing && existing.scope !== row.scope) return json({ success: false, error: "An event can't switch between store and company" }, 400);
  // A PAST event is a record, not a plan (Ethan, 2026-10-05: "You shouldn't be
  // able to edit a past event"). Past = its last day is before today in Central
  // and it doesn't repeat (a repeating one always has an instance coming).
  // Deleting it is still allowed — that's a clean-up, not a rewrite.
  if (existing) {
    const todayCT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    const rep = existing.repeat && existing.repeat !== "none" ? existing.repeat : (existing.repeats_yearly ? "yearly" : "none");
    if (rep === "none" && String(existing.end_date || existing.event_date) < todayCT) {
      return json({ success: false, error: "Past events can't be edited" }, 403);
    }
  }

  if (existing) {
    const { data, error } = await supabase.from("store_calendar_events")
      .update({ ...row, updated_by: who, updated_at: new Date().toISOString() })
      .eq("id", existing.id).select(COLS).single();
    if (error) return json({ success: false, error: error.message }, 500);
    return json({ success: true, event: data });
  }
  const { data, error } = await supabase.from("store_calendar_events")
    .insert({ ...row, created_by: who, updated_by: who }).select(COLS).single();
  if (error) return json({ success: false, error: error.message }, 500);
  return json({ success: true, event: data });
});
