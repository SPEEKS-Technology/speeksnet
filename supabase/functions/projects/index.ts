import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// PROJECTS — approval and tracking for work next to SPEEKSNET (migration 0186).
// The Projects tab of the Analytics Workspace (workspace.html#projects).
// ----------------------------------------------------------------------------
// Claude-built tools, extensions, scripts. No project starts until the DM
// approves it; approving IS starting (requested → in_progress). Only the DM
// completes one and records what happens to it afterwards.
//
// SIGN-OFF (0187, Ethan's feedback, 2026-11-18). The people doing the work say
// when it is finished (request_signoff → awaiting_signoff) and the DM approves
// it as complete or sends it back with a note (return_signoff → in_progress).
// He can still complete a running project directly: he is who signs off.
//
//   GET   + x-user-pin                       the list + history — EVERY project for
//                                            DM, CEO and MOCD (always, by role),
//                                            only the ones you asked for or are
//                                            on for everyone else
//   POST  + x-user-pin  {action, id?, ...}   one change, see ACTIONS below
//
// WHO. Three Feature Access keys, resolved here exactly as the browser resolves
// them (user override > role override > built-in default), because hiding a
// button is not a boundary and a server list that disagrees with the Feature
// Access tool is how a tool ends up 403-ing a save the UI offered (see the
// daily-brief note on the Weekly/Monthly KPI tool):
//   nav-projects       see the tab        (Nick, 2026-11-17: "store managers and up")
//                                         — and in it, only your own projects
//   projects-request   ask for a project  ("store managers and MOCD", + the DM)
//   projects-approve   decide             (DM only)
// The defaults below MUST match the FEATURE_CATALOG entries in speeks.js.
// Seeing EVERY project is not a key: it is the DM, CEO and MOCD, always
// (SEES_ALL_ROLES), plus whoever holds projects-approve.
//
// The name on every row comes from the PIN, never from the request body —
// unlike most of the site, nothing here trusts a name the browser asserts.
//
// A TEST ACCOUNT (0160) can read the board with its own role; any write with
// its PIN finds no users row and is refused — and the browser refuses the POST
// before it gets here anyway (TEST SESSION, top of speeks.js).
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

const SITE = "https://speeksnet.com";

// Built-in defaults, by role slug. Keep in step with FEATURE_CATALOG.
const DEFAULTS: Record<string, string[]> = {
  "nav-projects":     ["district-manager", "ceo", "mocd", "manager", "owner-manager"],
  "projects-request": ["district-manager", "mocd", "manager", "owner-manager"],
  "projects-approve": ["district-manager"],
};

// The roles that always see EVERY project, not just their own (Nick,
// 2026-11-17: the DM, "Yes, CEO sees all", "and MOCD sees all" — then "not a
// switch. They just always see everyones"). Deliberately NOT a Feature Access
// key: nobody can be given it, and these three can't lose it. 'tom' is MOCD's
// old name (0028); a row still carrying it is the same job.
const SEES_ALL_ROLES = ["district-manager", "ceo", "mocd", "tom"];

const OUTCOMES = ["incorporate", "standalone", "retire"];

// Same normalisation as the browser's role classes, so the slug matched here is
// the slug the Feature Access tool writes.
const roleSlug = (role: string) =>
  String(role || "").toLowerCase().trim().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-");
const lc = (v: unknown) => String(v ?? "").toLowerCase().trim();

type Viewer = { id: string | null; name: string; role: string; store: string; test: boolean };
type Perms = { view: boolean; request: boolean; approve: boolean; seesAll: boolean };

// The overrides are read once per request and handed to permsFrom, so the
// roster filter below (pickable) can resolve every person's access without a
// query each.
type Overrides = any[];
async function loadOverrides(sb: ReturnType<typeof createClient>): Promise<Overrides> {
  const { data } = await sb.from("feature_overrides")
    .select("feature_key, subject_type, subject, enabled")
    .in("feature_key", Object.keys(DEFAULTS));
  return data || [];
}
function permsFrom(data: Overrides, v: { name: string; role: string }): Perms {
  const slug = roleSlug(v.role);
  const allowed = (key: string) => {
    const rows = (data || []).filter((r: any) => r.feature_key === key);
    const u = rows.find((r: any) => lc(r.subject_type) === "user" && lc(r.subject) === lc(v.name));
    if (u) return !!u.enabled;
    const r = rows.find((r: any) => lc(r.subject_type) === "role" && lc(r.subject) === slug);
    if (r) return !!r.enabled;
    return DEFAULTS[key].includes(slug);
  };
  const approve = allowed("projects-approve");
  // Whoever decides has to be able to see what they are deciding on — the tab
  // AND every project in it — so someone covering approvals for Ethan sees
  // everything too, whatever their role.
  return {
    view: approve || allowed("nav-projects"),
    request: allowed("projects-request"),
    approve,
    seesAll: approve || SEES_ALL_ROLES.includes(slug),
  };
}

// Realtime ping: open boards re-fetch through this function. No row data
// travels over realtime. Best-effort; never fails the write.
async function broadcastChange(tool: string) {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ topic: "speeks-notify", event: "changed", payload: { tool, store: null, ts: Date.now() } }] }),
    });
  } catch (_) { /* best-effort */ }
}

// Email, through the notify queue (0033). Category 'requests' already exists —
// a project waiting on the DM is a request — so no constraint change. Best-effort.
async function queueNotification(sb: ReturnType<typeof createClient>, n: {
  kind: string; title: string; body?: string; audienceUser?: string | null;
  audienceRoles?: string[] | null; audienceFeature?: string | null;
  excludeUser?: string | null; priority?: "normal" | "high";
}) {
  try {
    await sb.from("notify_queue").insert({
      category: "requests", kind: n.kind, title: n.title, body: n.body ?? null,
      // A Workspace tab, not a page of its own (Nick, 2026-11-17: "in
      // workspace for now is fine"). initWorkspace honours the #projects hash.
      link: `${SITE}/workspace.html#projects`, store: null, audience_stores: null,
      audience_roles: n.audienceRoles ?? null,
      // notify applies Feature Access on top of the role (0148), so handing
      // projects-approve to someone while the DM is away routes the mail too.
      audience_feature: n.audienceFeature ?? null,
      audience_user: n.audienceUser ? lc(n.audienceUser) : null,
      exclude_user: n.excludeUser ? lc(n.excludeUser) : null,
      priority: n.priority ?? "normal",
    });
  } catch (_) { /* best-effort */ }
}

// ---- input cleaning -------------------------------------------------------
const clip = (v: unknown, max: number) => {
  const s = String(v ?? "").replace(/\r\n/g, "\n").trim();
  return s ? s.slice(0, max) : null;
};
// ---- the roster -------------------------------------------------------------
// Who's involved is picked from the real roster (Nick, 2026-11-17: "from a token
// list of the employees at the company so we can … have actual users
// attached"), so the browser sends users.id values and this resolves them. The
// shop-floor board accounts (role 'store') are not people and are left out;
// test accounts live in test_users and so are never in here at all.
//
// ONLY PEOPLE WHO CAN OPEN PROJECTS (Ethan, 2026-11-21: Projects is for the
// store managers, MOCD and him, "and no one else"). The roster used to leave
// out only the 'store' accounts, so a manager could put their ASM on a project
// the ASM could never open — every read 403s without the tab. Now the picker
// offers exactly the people whose Feature Access lets them see the tab, so
// handing someone nav-projects is also what puts them in the picker.
//
// Two lists, so: the ROSTER (everyone but the store accounts) is what names
// and ids are resolved against — a current name for someone already on a
// project, the PIN-reset heal below — and the PICKABLE people are the roster
// filtered to who can open Projects, which is all the picker offers and all
// that create/edit will attach.
type Person = { id: string; name: string; store: string; role: string };
async function loadRoster(sb: ReturnType<typeof createClient>): Promise<Person[]> {
  const { data } = await sb.from("users").select("id, name, store, role").order("name");
  return (data || [])
    .filter((r: any) => lc(r.role) !== "store")
    .map((r: any) => ({ id: String(r.id), name: String(r.name || "").trim(), store: String(r.store || ""), role: String(r.role || "") }));
}
function pickable(roster: Person[], overrides: Overrides): Person[] {
  return roster.filter((r) => permsFrom(overrides, r).view);
}
type Ref = { id: string | null; name: string };
// Ids → [{id, name}] against the roster. Unknown ids are dropped (a stale tab
// can't attach someone who has left); empty means the fallback — the requester
// — because a project always has somebody on it. At most 12.
function cleanInvolved(v: unknown, people: Person[], fallback: Ref): Ref[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const out: Ref[] = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const p = byId.get(String(raw));
    if (p && !out.some((x) => x.id === p.id)) out.push({ id: p.id, name: p.name });
  }
  return out.length ? out.slice(0, 12) : [fallback];
}
// Show the CURRENT name for anyone still on the roster, so a rename follows
// the person; someone who has left keeps the name stored with them.
function freshen(refs: unknown, byId: Map<string, Person>): Ref[] {
  return (Array.isArray(refs) ? refs : []).map((r: any) => {
    const p = r?.id ? byId.get(String(r.id)) : undefined;
    return { id: r?.id ? String(r.id) : null, name: p ? p.name : String(r?.name || "") };
  });
}
// Is this person the requester / one of the people involved? By users.id —
// that is the point of picking from the roster — and by name only for a row
// or a viewer with no id (written before ids were kept stable, or a test
// account reading).
function isMine(p: any, v: Viewer): boolean {
  if (p.requested_by_id && v.id) return String(p.requested_by_id) === v.id;
  return lc(p.requested_by) === lc(v.name);
}
function isInvolved(p: any, v: Viewer): boolean {
  return (Array.isArray(p.involved) ? p.involved : []).some((r: any) =>
    (r?.id && v.id) ? String(r.id) === v.id : lc(r?.name) === lc(v.name));
}

// A PIN RESET KEEPS YOUR PROJECTS (Ethan, 2026-11-21). auth keeps a person's
// users.id only while they keep their PIN, so a PIN reset in Manage Users hands
// them a NEW id — and the id-only match above then locked them out of every
// project they had asked for or were on: no list, no edit, no sign-off.
//
// Not fixed by loosening the match to names: the browser's own check
// (_prjIsRequester) is id-only on purpose, so two people who share a name can't
// act on each other's projects (projects-check.js, "a namesake is NOT the
// requester"). Instead an ORPHANED id — one no users row carries any more — is
// re-pointed at the one person on the roster with that stored name. A live id
// is never touched, so namesakes stay apart; an orphan with no single owner
// (two people of that name, or the person has left) stays as it was. Done on
// the read and before every write, so the browser receives ids that compare.
function heal(p: any, roster: Person[]): any {
  const live = new Set(roster.map((r) => r.id));
  const owner = (id: unknown, name: unknown): string | null => {
    if (!id || live.has(String(id))) return null;
    const same = roster.filter((r) => lc(r.name) === lc(name));
    return same.length === 1 ? same[0].id : null;
  };
  const reqId = owner(p.requested_by_id, p.requested_by);
  return {
    ...p,
    requested_by_id: reqId ?? p.requested_by_id,
    involved: (Array.isArray(p.involved) ? p.involved : []).map((r: any) => {
      const nid = owner(r?.id, r?.name);
      return nid ? { ...r, id: nid } : r;
    }),
  };
}
// The three fields a project carries (Nick, 2026-11-17: "as simple as Project
// Title, Project Description, and Who's involved"). Used by create and edit.
function fields(b: any, people: Person[], fallback: Ref) {
  return {
    title: clip(b.title, 120),
    description: clip(b.description, 4000),
    involved: cleanInvolved(b.involved, people, fallback),
  };
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
  const overrides = await loadOverrides(sb);
  const perms = permsFrom(overrides, viewer);
  if (!perms.view && !perms.request) return json({ success: false, error: "Projects isn't switched on for you." }, 403);

  // ---- read: the list ----
  if (req.method === "GET") {
    const [p, e, roster] = await Promise.all([
      sb.from("projects").select("*").order("created_at", { ascending: false }),
      sb.from("project_events").select("*").order("created_at", { ascending: true }),
      loadRoster(sb),
    ]);
    if (p.error) return json({ success: false, error: p.error.message }, 500);
    const people = pickable(roster, overrides);
    const byId = new Map(roster.map((x) => [x.id, x]));
    let projects = (p.data || []).map((raw: any) => {
      const x = heal(raw, roster);
      const req = x.requested_by_id ? byId.get(String(x.requested_by_id)) : undefined;
      return { ...x, involved: freshen(x.involved, byId), requested_by: req ? req.name : x.requested_by };
    });
    // WHO SEES WHAT (Nick, 2026-11-17): "DM can see all of the projects.
    // Everyone else can only see projects they are involved in" — then "Yes,
    // CEO sees all", "and MOCD sees all" — "not a switch. They just always see
    // everyones". So the DM, CEO and MOCD (SEES_ALL_ROLES), plus whoever holds
    // projects-approve (e.g. covering for Ethan), get every project; everyone
    // else gets the ones they asked for or are listed on. Done HERE, not in
    // the browser, so another manager's project never leaves the server.
    if (!perms.seesAll) projects = projects.filter((x: any) => isMine(x, viewer) || isInvolved(x, viewer));
    const ids = new Set(projects.map((x: any) => x.id));
    return json({
      success: true,
      me: { id: viewer.id, name: viewer.name, role: viewer.role, test },
      // can.seesAll: the list is the whole district's, not just this person's.
      can: perms,
      // The roster for the "Who's involved" picker. id, name, store and role
      // only — never a PIN.
      people: perms.request || perms.approve ? people : [],
      projects,
      events: (e.data || []).filter((x: any) => ids.has(x.project_id)),
    });
  }

  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  let b: any;
  try { b = await req.json(); } catch { return json({ success: false, error: "Invalid JSON" }, 400); }
  const action = String(b.action || "");
  const note = clip(b.note, 2000);
  const now = new Date().toISOString();
  const me = viewer.name;

  const meRef: Ref = { id: viewer.id, name: me };

  // ---- create ----
  if (action === "create") {
    if (!perms.request && !perms.approve) return json({ success: false, error: "Requesting projects isn't switched on for you." }, 403);
    const f = fields(b, pickable(await loadRoster(sb), overrides), meRef);
    if (!f.title) return json({ success: false, error: "Give the project a title." }, 400);
    if (!f.description) return json({ success: false, error: "Describe the project." }, 400);
    // THE DM ADDS, HE DOESN'T REQUEST (Ethan, 2026-11-21). Whoever holds
    // projects-approve would only be asking themselves, so their project is
    // approved as it's made: straight to in_progress, decided and started now,
    // and no "waiting for approval" email to themselves.
    const direct = perms.approve;
    const { data: row, error } = await sb.from("projects").insert({
      ...f, status: direct ? "in_progress" : "requested",
      requested_by: me, requested_by_id: viewer.id, requested_store: viewer.store || null,
      ...(direct ? { decided_by: me, decided_at: now, started_at: now } : {}),
    }).select().single();
    if (error) return json({ success: false, error: error.message }, 500);
    await sb.from("project_events").insert({ project_id: row.id, kind: "created", actor: me, to_status: row.status });
    if (direct) {
      await broadcastChange("projects");
      return json({ success: true, project: row });
    }
    const blurb = f.description!.length > 160 ? f.description!.slice(0, 157) + "…" : f.description;
    await queueNotification(sb, {
      kind: "project_request", priority: "high",
      title: `Project waiting for approval: ${row.title}`,
      body: `${me} asked to start PRJ-${row.id}: ${blurb}`,
      audienceRoles: ["district manager"], audienceFeature: "projects-approve", excludeUser: me,
    });
    await broadcastChange("projects");
    return json({ success: true, project: row });
  }

  // Everything else acts on one project.
  const id = Number(b.id);
  if (!Number.isFinite(id)) return json({ success: false, error: "Missing project id" }, 400);
  const [{ data: raw, error: pErr }, roster] = await Promise.all([
    sb.from("projects").select("*").eq("id", id).maybeSingle(),
    loadRoster(sb),
  ]);
  if (pErr) return json({ success: false, error: pErr.message }, 500);
  if (!raw) return json({ success: false, error: "That project no longer exists." }, 404);
  // Same heal as the read, so a PIN-reset requester is still the requester here.
  const p = heal(raw, roster);

  const mine = isMine(p, viewer);
  // Anyone listed as involved is on the project: they post its updates.
  const owns = mine || isInvolved(p, viewer);
  const from = p.status as string;

  // One transition: check the state, write the row and its history, tell the
  // people who care, ping open boards.
  async function move(opts: {
    allowedFrom: string[]; to: string; kind: string; patch?: Record<string, unknown>;
    tell?: { kind: string; title: string; body?: string; user?: string | null; roles?: string[]; feature?: string };
    noteRequired?: string;
  }) {
    if (!opts.allowedFrom.includes(from)) {
      return json({ success: false, error: `PRJ-${id} is ${from.replace("_", " ")} — it can't be ${opts.kind.replace("_", " ")} from there.` }, 409);
    }
    if (opts.noteRequired && !note) return json({ success: false, error: opts.noteRequired }, 400);
    const { data: row, error } = await sb.from("projects")
      .update({ ...(opts.patch || {}), status: opts.to, updated_at: now })
      .eq("id", id).eq("status", from)   // lose a race rather than overwrite one
      .select().maybeSingle();
    if (error) return json({ success: false, error: error.message }, 500);
    if (!row) return json({ success: false, error: "Someone changed this project at the same moment — reload and try again." }, 409);
    await sb.from("project_events").insert({ project_id: id, kind: opts.kind, actor: me, note, from_status: from, to_status: opts.to });
    if (opts.tell) {
      await queueNotification(sb, {
        kind: opts.tell.kind, title: opts.tell.title, body: opts.tell.body,
        audienceUser: opts.tell.user ?? null, audienceRoles: opts.tell.roles ?? null,
        audienceFeature: opts.tell.feature ?? null, excludeUser: me,
      });
    }
    await broadcastChange("projects");
    return json({ success: true, project: row });
  }

  // notify addresses people by name, so use the requester's CURRENT name — the
  // one stored on the row is from when they asked, and a rename since would
  // send the decision to nobody.
  let requesterName = p.requested_by as string;
  if (p.requested_by_id) {
    const { data: r } = await sb.from("users").select("name").eq("id", p.requested_by_id).maybeSingle();
    if (r?.name) requesterName = String(r.name);
  }
  const forRequester = (verb: string) => ({
    kind: "project_decision", user: requesterName,
    title: `PRJ-${id} ${verb}: ${p.title}`,
    body: note ? `${me}: ${note}` : `${me} ${verb} it.`,
  });

  switch (action) {
    // -- requester --
    // Editable while the project is alive, not only while it waits: who's
    // involved changes as the work goes on. Closed ones (completed, declined,
    // withdrawn) are the record and stay as they were.
    case "edit": {
      if (!mine && !perms.approve) return json({ success: false, error: "Only the person who asked, or the DM, can edit a project." }, 403);
      if (!["requested", "changes_requested", "in_progress", "parked", "awaiting_signoff"].includes(from)) {
        return json({ success: false, error: "A finished or closed project can't be edited." }, 409);
      }
      // Empty falls back to whoever asked, as it did on create.
      const f = fields(b, pickable(roster, overrides), { id: p.requested_by_id ? String(p.requested_by_id) : null, name: p.requested_by });
      if (!f.title || !f.description) return json({ success: false, error: "A project needs a title and a description." }, 400);
      // Editing a request that was sent back IS resubmitting it.
      if (from === "changes_requested") {
        return move({ allowedFrom: ["changes_requested"], to: "requested", kind: "resubmitted", patch: f,
          tell: { kind: "project_request", title: `Project resubmitted: ${f.title}`, body: `${me} updated PRJ-${id} after your notes.`, roles: ["district manager"], feature: "projects-approve" } });
      }
      const { data: row, error } = await sb.from("projects").update({ ...f, updated_at: now }).eq("id", id).select().single();
      if (error) return json({ success: false, error: error.message }, 500);
      await sb.from("project_events").insert({ project_id: id, kind: "edited", actor: me });
      await broadcastChange("projects");
      return json({ success: true, project: row });
    }
    case "withdraw":
      if (!mine) return json({ success: false, error: "Only the person who asked can withdraw a request." }, 403);
      return move({ allowedFrom: ["requested", "changes_requested"], to: "withdrawn", kind: "withdrawn" });

    // -- whoever is involved (or the approver): progress notes while it runs --
    case "update": {
      if (!owns && !perms.approve) return json({ success: false, error: "Only people working on the project can post updates." }, 403);
      // Waiting on sign-off still takes updates: "here's where to find it".
      if (!["in_progress", "parked", "awaiting_signoff"].includes(from)) return json({ success: false, error: "Updates go on projects that are under way." }, 409);
      if (!note) return json({ success: false, error: "Write the update first." }, 400);
      await sb.from("projects").update({ updated_at: now }).eq("id", id);
      await sb.from("project_events").insert({ project_id: id, kind: "update", actor: me, note });
      await broadcastChange("projects");
      return json({ success: true });
    }

    // "It's finished — please sign it off." Anyone on the project. A parked
    // project has to be resumed first: parked means nobody is working on it.
    case "request_signoff": {
      if (!owns) return json({ success: false, error: "Only people working on the project can send it for sign-off." }, 403);
      return move({ allowedFrom: ["in_progress"], to: "awaiting_signoff", kind: "signoff_requested",
        tell: { kind: "project_request", title: `Project ready for sign-off: ${p.title}`,
          body: note ? `${me} says PRJ-${id} is finished: ${note}` : `${me} says PRJ-${id} is finished and needs your sign-off.`,
          roles: ["district manager"], feature: "projects-approve" } });
    }
  }

  // -- approver --
  if (!perms.approve) return json({ success: false, error: "Only the DM can decide on projects." }, 403);
  switch (action) {
    // DELETE (Ethan, 2026-11-21). A junk or test request used to have no way
    // out but Closed forever. The DM only, from any state, behind a
    // press-twice confirm in the browser. Its history goes with it
    // (project_events cascades, 0186) — deleting is for things that should never
    // have been on the board; a real project that ended is Declined, Withdrawn
    // or Completed and stays as the record.
    case "delete": {
      const { error } = await sb.from("projects").delete().eq("id", id);
      if (error) return json({ success: false, error: error.message }, 500);
      await broadcastChange("projects");
      return json({ success: true, deleted: id });
    }
    case "approve":
      return move({ allowedFrom: ["requested"], to: "in_progress", kind: "approved",
        patch: { decided_by: me, decided_at: now, decision_note: note, started_at: now },
        tell: forRequester("approved") });
    case "decline":
      return move({ allowedFrom: ["requested", "changes_requested"], to: "declined", kind: "declined",
        patch: { decided_by: me, decided_at: now, decision_note: note },
        noteRequired: "Say why it's declined — the requester sees this.",
        tell: forRequester("declined") });
    case "request_changes":
      return move({ allowedFrom: ["requested"], to: "changes_requested", kind: "changes_requested",
        patch: { decided_by: me, decided_at: now, decision_note: note },
        noteRequired: "Say what needs to change.",
        tell: forRequester("needs changes") });
    case "park":
      return move({ allowedFrom: ["in_progress"], to: "parked", kind: "parked", tell: forRequester("parked") });
    case "resume":
      return move({ allowedFrom: ["parked"], to: "in_progress", kind: "resumed", tell: forRequester("resumed") });
    // From awaiting_signoff this is the sign-off; from in_progress / parked the
    // DM is completing it himself, which is the same decision.
    case "complete":
      return move({ allowedFrom: ["in_progress", "parked", "awaiting_signoff"], to: "completed", kind: "completed",
        patch: { completed_at: now },
        tell: forRequester(from === "awaiting_signoff" ? "approved as complete" : "marked complete") });
    // Not finished yet: back to work, with a note saying what's left. The note
    // goes in decision_note too, so the project's popup leads with it.
    case "return_signoff":
      return move({ allowedFrom: ["awaiting_signoff"], to: "in_progress", kind: "signoff_returned",
        patch: { decided_by: me, decided_at: now, decision_note: note },
        noteRequired: "Say what still needs doing.",
        tell: forRequester("sent back") });
    case "outcome": {
      const outcome = String(b.outcome || "");
      if (!OUTCOMES.includes(outcome)) return json({ success: false, error: "Pick what happens to the project." }, 400);
      if (from !== "completed") return json({ success: false, error: "Decide what happens to a project once it's completed." }, 409);
      const { data: row, error } = await sb.from("projects")
        .update({ outcome, outcome_note: note, outcome_at: now, updated_at: now }).eq("id", id).select().single();
      if (error) return json({ success: false, error: error.message }, 500);
      await sb.from("project_events").insert({ project_id: id, kind: "outcome", actor: me, note: `${outcome}${note ? ` — ${note}` : ""}` });
      await broadcastChange("projects");
      return json({ success: true, project: row });
    }
  }
  return json({ success: false, error: `Unknown action: ${action}` }, 400);
});
