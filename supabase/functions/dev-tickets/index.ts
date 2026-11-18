import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// DEV-TICKETS — the Development tracker's tickets (migration 0187).
// Plan: docs/plans/dev-tracker-HANDOFF.md (Phase 1). The page that uses this is
// Phase 3 (dev.html, behind a green header button right of the settings cog).
// ----------------------------------------------------------------------------
//   GET   + x-user-pin                       everything the tracker shows: tickets,
//                                            comments, history, links, releases,
//                                            the type/area lists, the roster
//   POST  + x-user-pin  {action, id?, ...}   one change, see ACTIONS below
//
// WHO (D2): dev access is a per-person Feature Access switch, not a role.
//   dev-tracker          see and work tickets       default: nobody — granted
//                                                   per person (Nick, Ethan; 0187)
//   dev-release-publish  ship a release (Phase 6)   default: nobody — Q3 open
// Resolved here exactly as the browser resolves them (user override > role
// override > built-in default) — the Projects pattern. The DEFAULTS below MUST
// match the FEATURE_CATALOG entries in speeks.js.
//
// Every name written comes from the PIN, never from the request body.
//
// A TEST ACCOUNT (0160) can read if its name or role has been granted
// dev-tracker; any write finds no users row and is refused.
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Built-in defaults, by role slug. Keep in step with FEATURE_CATALOG.
const DEFAULTS: Record<string, string[]> = {
  "dev-tracker": [],
  "dev-release-publish": [],
};

const STATUSES = ["triage", "backlog", "in_progress", "in_review", "on_prerelease", "done", "wont_do"];
const CLOSED = ["done", "wont_do"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL", "CORP"];

const roleSlug = (role: string) =>
  String(role || "").toLowerCase().trim().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-");
const lc = (v: unknown) => String(v ?? "").toLowerCase().trim();

type Sb = ReturnType<typeof createClient>;
type Viewer = { id: string | null; name: string; role: string; store: string; test: boolean };
type Person = { id: string; name: string; store: string; role: string };
type Ref = { id: string | null; name: string };

// One read of the overrides answers the question for anybody: the viewer now,
// and every person on the roster (who can be assigned a ticket).
async function accessResolver(sb: Sb) {
  const { data } = await sb.from("feature_overrides")
    .select("feature_key, subject_type, subject, enabled")
    .in("feature_key", Object.keys(DEFAULTS));
  return (key: string, name: string, role: string) => {
    const rows = (data || []).filter((r: any) => r.feature_key === key);
    const u = rows.find((r: any) => lc(r.subject_type) === "user" && lc(r.subject) === lc(name));
    if (u) return !!u.enabled;
    const r = rows.find((r: any) => lc(r.subject_type) === "role" && lc(r.subject) === roleSlug(role));
    if (r) return !!r.enabled;
    return DEFAULTS[key].includes(roleSlug(role));
  };
}

// Realtime ping: open trackers re-fetch through this function. No row data
// travels over realtime. Best-effort; never fails the write.
async function broadcastChange() {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ topic: "speeks-notify", event: "changed", payload: { tool: "dev-tickets", store: null, ts: Date.now() } }] }),
    });
  } catch (_) { /* best-effort */ }
}

// ---- input cleaning -------------------------------------------------------
const clip = (v: unknown, max: number) => {
  const s = String(v ?? "").replace(/\r\n/g, "\n").trim();
  return s ? s.slice(0, max) : null;
};
// A date input's 'YYYY-MM-DD', or null. Anything else is a mistake, not a date.
const day = (v: unknown) => {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : null;
};
const storeList = (v: unknown) =>
  [...new Set((Array.isArray(v) ? v : []).map((s) => String(s).toUpperCase().trim()).filter((s) => STORES.includes(s)))];

// The roster, without the shop-floor board accounts (role 'store'); test
// accounts live in test_users and are never here.
async function loadPeople(sb: Sb): Promise<Person[]> {
  const { data } = await sb.from("users").select("id, name, store, role").order("name");
  return (data || [])
    .filter((r: any) => lc(r.role) !== "store")
    .map((r: any) => ({ id: String(r.id), name: String(r.name || "").trim(), store: String(r.store || ""), role: String(r.role || "") }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ---- who is asking ----
  const pin = req.headers.get("x-user-pin") || "";
  if (!pin) return json({ success: false, error: "Sign in again — your session has no PIN." }, 401);
  let { data: u } = await sb.from("users").select("id, name, role, store").eq("pin", pin).maybeSingle();
  let test = false;
  if (!u && req.method === "GET") {
    ({ data: u } = await sb.from("test_users").select("name, role, store").eq("pin", pin).maybeSingle());
    test = !!u;
  }
  if (!u) return json({ success: false, error: "That PIN isn't recognised." }, 401);
  const viewer: Viewer = { id: (u as any).id ? String((u as any).id) : null, name: String(u.name || "").trim(), role: String(u.role || ""), store: String(u.store || ""), test };
  const allowed = await accessResolver(sb);
  const can = {
    dev: allowed("dev-tracker", viewer.name, viewer.role),
    publish: allowed("dev-release-publish", viewer.name, viewer.role),
  };
  if (!can.dev) return json({ success: false, error: "The development tracker isn't switched on for you." }, 403);

  const people = await loadPeople(sb);
  const byId = new Map(people.map((p) => [p.id, p]));
  // Who can be given a ticket: anyone who holds dev-tracker. Assigning work to
  // someone who can't open the tracker hands them something they can't see.
  const devs = people.filter((p) => allowed("dev-tracker", p.name, p.role));
  // The CURRENT name for anyone still on the roster, so a rename follows them.
  const nameOf = (id: unknown, stored: unknown) => (id && byId.get(String(id))?.name) || String(stored ?? "");

  // ---- read ----
  if (req.method === "GET") {
    const [t, c, e, l, r, ty, ar] = await Promise.all([
      sb.from("dev_tickets").select("*").order("id", { ascending: false }),
      sb.from("dev_ticket_comments").select("*").order("created_at", { ascending: true }),
      sb.from("dev_ticket_events").select("*").order("created_at", { ascending: true }),
      sb.from("dev_ticket_links").select("*").order("created_at", { ascending: true }),
      sb.from("dev_releases").select("*").order("created_at", { ascending: false }),
      sb.from("dev_ticket_types").select("*").order("sort"),
      sb.from("dev_ticket_areas").select("*").order("sort"),
    ]);
    const err = [t, c, e, l, r, ty, ar].find((x) => x.error)?.error;
    if (err) return json({ success: false, error: err.message }, 500);
    return json({
      success: true,
      me: { id: viewer.id, name: viewer.name, role: viewer.role, test },
      can,
      tickets: (t.data || []).map((x: any) => ({
        ...x,
        assignee_name: x.assignee_id ? nameOf(x.assignee_id, x.assignee_name) : x.assignee_name,
        reporter_name: nameOf(x.reporter_id, x.reporter_name),
      })),
      comments: (c.data || []).map((x: any) => ({ ...x, author_name: nameOf(x.author_id, x.author_name) })),
      events: e.data || [],
      links: l.data || [],
      releases: r.data || [],
      types: ty.data || [],
      areas: ar.data || [],
      // id, name, store and role only — never a PIN.
      devs: devs.map((p) => ({ id: p.id, name: p.name, store: p.store, role: p.role })),
    });
  }

  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  let b: any;
  try { b = await req.json(); } catch { return json({ success: false, error: "Invalid JSON" }, 400); }
  const action = String(b.action || "");
  const now = new Date().toISOString();
  const me: Ref = { id: viewer.id, name: viewer.name };

  // Writes need a real person: a test account never gets this far on a POST
  // (no users row), but be explicit about it.
  if (!viewer.id) return json({ success: false, error: "Test accounts can't change tickets." }, 403);

  const event = (ticket_id: number, kind: string, extra: Record<string, unknown> = {}) =>
    sb.from("dev_ticket_events").insert({ ticket_id, kind, actor_name: me.name, actor_id: me.id, ...extra });

  // type / area / release: the lookup row must exist and be in use. Devs may
  // use dev-only types; the Phase 3 intake form for everyone else may not.
  async function checkType(key: unknown) {
    const { data } = await sb.from("dev_ticket_types").select("key, active").eq("key", String(key ?? "")).maybeSingle();
    return data && data.active ? data.key as string : null;
  }
  async function checkArea(key: unknown) {
    if (key === null || key === undefined || key === "") return { ok: true, value: null };
    const { data } = await sb.from("dev_ticket_areas").select("key, active").eq("key", String(key)).maybeSingle();
    return data && data.active ? { ok: true, value: data.key as string } : { ok: false, value: null };
  }
  async function checkRelease(id: unknown) {
    if (id === null || id === undefined || id === "") return { ok: true, value: null };
    const { data } = await sb.from("dev_releases").select("id").eq("id", Number(id)).maybeSingle();
    return data ? { ok: true, value: data.id as number } : { ok: false, value: null };
  }
  function assignee(id: unknown): { ok: boolean; ref: Ref | null } {
    if (id === null || id === undefined || id === "") return { ok: true, ref: null };
    const p = devs.find((d) => d.id === String(id));
    return p ? { ok: true, ref: { id: p.id, name: p.name } } : { ok: false, ref: null };
  }

  // ---- create ----
  if (action === "create") {
    const title = clip(b.title, 200);
    if (!title) return json({ success: false, error: "Give the ticket a title." }, 400);
    const type = await checkType(b.type);
    if (!type) return json({ success: false, error: "Pick a type." }, 400);
    const area = await checkArea(b.area);
    if (!area.ok) return json({ success: false, error: "That area isn't on the list." }, 400);
    const rel = await checkRelease(b.release_id);
    if (!rel.ok) return json({ success: false, error: "That release no longer exists." }, 400);
    const who = assignee(b.assignee_id);
    if (!who.ok) return json({ success: false, error: "Tickets can only be assigned to someone with the development tracker." }, 400);
    const priority = PRIORITIES.includes(String(b.priority)) ? String(b.priority) : "normal";
    // A dev creating a ticket has already triaged it, so it starts in the
    // backlog unless they say otherwise. (Phase 3's intake lands in triage.)
    const status = STATUSES.includes(String(b.status)) ? String(b.status) : "backlog";
    const { data: row, error } = await sb.from("dev_tickets").insert({
      title, description: clip(b.description, 20000) || "", type, area: area.value, priority, status,
      assignee_id: who.ref?.id ?? null, assignee_name: who.ref?.name ?? null,
      reporter_id: me.id, reporter_name: me.name, reporter_store: viewer.store || null,
      stores: storeList(b.stores), release_id: rel.value, due: day(b.due), source: "dev",
      closed_at: CLOSED.includes(status) ? now : null,
    }).select().single();
    if (error) return json({ success: false, error: error.message }, 500);
    await event(row.id, "created", { to_value: status });
    await broadcastChange();
    return json({ success: true, ticket: row });
  }

  // Everything else acts on one ticket.
  const id = Number(b.id);
  if (!Number.isInteger(id)) return json({ success: false, error: "Missing ticket id" }, 400);
  const { data: tk, error: tErr } = await sb.from("dev_tickets").select("*").eq("id", id).maybeSingle();
  if (tErr) return json({ success: false, error: tErr.message }, 500);
  if (!tk) return json({ success: false, error: `SN-${id} doesn't exist.` }, 404);

  switch (action) {
    // -- the descriptive fields: only what was sent changes --
    case "edit": {
      const patch: Record<string, unknown> = {};
      const changed: string[] = [];
      const set = (field: string, value: unknown) => {
        if (JSON.stringify(value) !== JSON.stringify(tk[field])) { patch[field] = value; changed.push(field); }
      };
      if ("title" in b) {
        const title = clip(b.title, 200);
        if (!title) return json({ success: false, error: "A ticket needs a title." }, 400);
        set("title", title);
      }
      if ("description" in b) set("description", clip(b.description, 20000) || "");
      if ("type" in b) {
        const type = await checkType(b.type);
        if (!type) return json({ success: false, error: "Pick a type." }, 400);
        set("type", type);
      }
      if ("area" in b) {
        const area = await checkArea(b.area);
        if (!area.ok) return json({ success: false, error: "That area isn't on the list." }, 400);
        set("area", area.value);
      }
      if ("priority" in b) {
        if (!PRIORITIES.includes(String(b.priority))) return json({ success: false, error: "Pick a priority." }, 400);
        set("priority", String(b.priority));
      }
      if ("stores" in b) set("stores", storeList(b.stores));
      if ("due" in b) set("due", day(b.due));
      if ("release_id" in b) {
        const rel = await checkRelease(b.release_id);
        if (!rel.ok) return json({ success: false, error: "That release no longer exists." }, 400);
        set("release_id", rel.value);
      }
      if (!changed.length) return json({ success: true, ticket: tk, unchanged: true });
      const { data: row, error } = await sb.from("dev_tickets")
        .update({ ...patch, updated_at: now })
        .eq("id", id).eq("updated_at", tk.updated_at)   // lose a race rather than overwrite one
        .select().maybeSingle();
      if (error) return json({ success: false, error: error.message }, 500);
      if (!row) return json({ success: false, error: "Someone changed this ticket at the same moment — reload and try again." }, 409);
      // A release change is its own event, so the history reads "moved to v3.13.0".
      if (changed.includes("release_id")) await event(id, "release", { from_value: tk.release_id == null ? null : String(tk.release_id), to_value: row.release_id == null ? null : String(row.release_id) });
      const rest = changed.filter((f) => f !== "release_id");
      if (rest.length) await event(id, "edited", { note: rest.join(", ") });
      await broadcastChange();
      return json({ success: true, ticket: row });
    }

    case "status": {
      const to = String(b.to || "");
      if (!STATUSES.includes(to)) return json({ success: false, error: "Pick a status." }, 400);
      const from = tk.status as string;
      if (to === from) return json({ success: true, ticket: tk, unchanged: true });
      const note = clip(b.note, 2000);
      if (to === "wont_do" && !note) return json({ success: false, error: "Say why it won't be done — whoever raised it will read this." }, 400);
      const { data: row, error } = await sb.from("dev_tickets")
        .update({ status: to, closed_at: CLOSED.includes(to) ? now : null, updated_at: now })
        .eq("id", id).eq("status", from)
        .select().maybeSingle();
      if (error) return json({ success: false, error: error.message }, 500);
      if (!row) return json({ success: false, error: "Someone moved this ticket at the same moment — reload and try again." }, 409);
      await event(id, "status", { from_value: from, to_value: to, note });
      await broadcastChange();
      return json({ success: true, ticket: row });
    }

    case "assign": {
      const who = assignee(b.assignee_id);
      if (!who.ok) return json({ success: false, error: "Tickets can only be assigned to someone with the development tracker." }, 400);
      const toId = who.ref?.id ?? null;
      if (String(tk.assignee_id ?? "") === String(toId ?? "")) return json({ success: true, ticket: tk, unchanged: true });
      const { data: row, error } = await sb.from("dev_tickets")
        .update({ assignee_id: toId, assignee_name: who.ref?.name ?? null, updated_at: now })
        .eq("id", id).select().single();
      if (error) return json({ success: false, error: error.message }, 500);
      await event(id, "assigned", {
        from_value: tk.assignee_id ? nameOf(tk.assignee_id, tk.assignee_name) : null,
        to_value: who.ref?.name ?? null,
      });
      await broadcastChange();
      return json({ success: true, ticket: row });
    }

    case "comment": {
      const body = clip(b.body, 20000);
      if (!body) return json({ success: false, error: "Write the comment first." }, 400);
      const { data: row, error } = await sb.from("dev_ticket_comments")
        .insert({ ticket_id: id, body, author_name: me.name, author_id: me.id })
        .select().single();
      if (error) return json({ success: false, error: error.message }, 500);
      await sb.from("dev_tickets").update({ updated_at: now }).eq("id", id);
      await broadcastChange();
      return json({ success: true, comment: row });
    }

    // Only your own words, and only ones written here — an imported GitHub
    // comment is the record of what was said there.
    case "edit_comment": {
      const cid = Number(b.comment_id);
      const body = clip(b.body, 20000);
      if (!body) return json({ success: false, error: "A comment can't be empty." }, 400);
      const { data: cm } = await sb.from("dev_ticket_comments").select("*").eq("id", cid).eq("ticket_id", id).maybeSingle();
      if (!cm) return json({ success: false, error: "That comment no longer exists." }, 404);
      if (cm.source !== "speeksnet" || String(cm.author_id ?? "") !== me.id) {
        return json({ success: false, error: "You can only edit your own comments." }, 403);
      }
      const { data: row, error } = await sb.from("dev_ticket_comments")
        .update({ body, edited_at: now }).eq("id", cid).select().single();
      if (error) return json({ success: false, error: error.message }, 500);
      await broadcastChange();
      return json({ success: true, comment: row });
    }
  }
  return json({ success: false, error: `Unknown action: ${action}` }, 400);
});
