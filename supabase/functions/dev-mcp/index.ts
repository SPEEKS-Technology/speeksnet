import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// =============================================================================
// dev-mcp — the speeksnet-dev Claude connector (dev tracker §6b step 4, 0209)
// =============================================================================
// Both developers do most of their branching and merging through Claude (Nick,
// 2026-11-24). This lets Claude see the development pipeline and keep it true
// while it works: find the ticket, start a branch with tickets on it, move
// tickets, tick them done, comment. The rules it should follow are in
// docs/DEVELOPMENT-WORKFLOW.md, and the short form is in instructions() below.
//
// It deliberately CAN'T merge, Go live, delete, or change the next update's
// size or title. Merging happens on GitHub after the person says yes; Go live
// is a person's button in the suite.
//
// WHO: every developer has their own key, made in the suite (your menu →
// Claude connector), shown once, stored only as a SHA-256 (dev_mcp_keys).
// Claude Code sends it as a header from the developer's own environment —
// .mcp.json in the repo reads ${SPEEKSNET_DEV_KEY}, never the key itself (the
// repo is public). A claude.ai connector can't send a header, so there the key
// may be the last path segment: …/functions/v1/dev-mcp/<key>.
//
// HOW: this function holds no ticket rules at all. Every read and write goes to
// dev-tickets / github-webhook AS the key's owner (service-role bearer +
// x-act-as: users.id), so the suite and Claude can never disagree about what's
// allowed — including the dev-tracker Feature Access switch. Those functions
// sign Claude's writes "Claude, for <first name>".
//
// A missing or revoked key is NOT an HTTP 401 (that sends Claude Code looking
// for an OAuth sign-in). The tools list still loads, and every call answers
// with an error that says exactly how to fix it, which Claude can relay.
//
// Deploy with --no-verify-jwt (no Supabase JWT ever arrives here).
// =============================================================================

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FN = `${SB_URL}/functions/v1`;
const SUITE = "https://speeksnet.com/dev.html";
const REPO = "https://github.com/SPEEKS-Technology/speeksnet";
const sb = createClient(SB_URL, SVC);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, x-speeksnet-dev-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const OPEN = ["triage", "backlog", "in_progress", "in_review"];

// ---- who ---------------------------------------------------------------------
type Who = { userId: string; name: string };
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function keyFrom(req: Request, url: URL): string {
  const h = (req.headers.get("x-speeksnet-dev-key") || "").trim();
  if (h) return h;
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (bearer.startsWith("sndev_")) return bearer;
  const last = url.pathname.split("/").filter(Boolean).pop() || "";
  return last.startsWith("sndev_") ? last : "";
}
// null = no usable key; the string says why.
async function resolve(key: string): Promise<Who | string> {
  if (!key) return `No connector key was sent. Make one in the Development suite (${SUITE} → your avatar → Claude connector), then set it for Claude Code with: [Environment]::SetEnvironmentVariable('SPEEKSNET_DEV_KEY', '<your key>', 'User') and restart Claude.`;
  if (!/^sndev_[A-Za-z0-9_-]{20,}$/.test(key)) return "That isn't a SPEEKSNET connector key (they start with sndev_). Make one in the Development suite → your avatar → Claude connector.";
  const { data: k } = await sb.from("dev_mcp_keys").select("id, user_id, user_name, revoked_at, last_used_at").eq("secret_hash", await sha256Hex(key)).maybeSingle();
  if (!k) return "That connector key isn't recognised. Make a new one in the Development suite → your avatar → Claude connector.";
  if (k.revoked_at) return "That connector key was revoked. Make a new one in the Development suite → your avatar → Claude connector.";
  // Last used, at most every five minutes (it's shown next to the key).
  if (!k.last_used_at || Date.now() - Date.parse(k.last_used_at) > 300000) {
    await sb.from("dev_mcp_keys").update({ last_used_at: new Date().toISOString() }).eq("id", k.id);
  }
  return { userId: String(k.user_id), name: String(k.user_name || "") };
}

// ---- the suite's own functions, as the key's owner ------------------------------
async function call(fn: "dev-tickets" | "github-webhook", who: Who, body?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${FN}/${fn}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${SVC}`, apikey: SVC, "x-act-as": who.userId, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) throw new Error(j.error || `${fn} said HTTP ${res.status}`);
  return j;
}

// ---- shaping the answers ----------------------------------------------------------
const ref = (id: unknown) => `SN-${id}`;
const idOf = (v: unknown) => {
  const n = Number(String(v ?? "").trim().replace(/^sn-?/i, "").replace(/^#/, ""));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`"${v}" isn't a ticket number (SN-123 or 123).`);
  return n;
};
const idsOf = (v: unknown) => {
  const list = Array.isArray(v) ? v : [v];
  if (!list.length) throw new Error("Which tickets? Give ticket_ids, e.g. [\"SN-565\"].");
  return [...new Set(list.map(idOf))];
};
function stage(t: any): string {
  if (t.status === "done") return "live";
  if (t.status === "on_prerelease") return "pre_release";
  if (t.status === "wont_do") return "wont_do";
  return t.branch ? "on_branch" : "backlog";
}
const brief = (t: any) => ({
  id: ref(t.id), title: t.title, type: t.type, stage: stage(t),
  ...(t.branch ? { branch: t.branch } : {}), ...(t.branch && OPEN.includes(t.status) ? { done_on_branch: !!t.branch_done } : {}),
  ...(t.status === "triage" ? { new_from_submit_a_ticket: true } : {}),
  ...(t.assignee_name ? { assignee: t.assignee_name } : {}),
});
// Tickets have no priority (Nick, 2026-11-25): newest first.
const byPri = (a: any, b: any) => Number(b.id) - Number(a.id);

// PRs merged into pre-release, not on main, whose branch carries no ticket in
// the next update and that no such ticket links to (0210).
function untracked(d: any): any[] {
  const pre = (d.tickets || []).filter((t: any) => t.status === "on_prerelease");
  const linked = new Set((d.links || []).filter((l: any) => l.kind === "pr" && pre.some((t: any) => Number(t.id) === Number(l.ticket_id))).map((l: any) => String(l.ref)));
  return (d.prerelease_prs || []).filter((p: any) => !linked.has(String(p.pr_number)) && !pre.some((t: any) => p.head && t.branch === p.head));
}
function board(d: any) {
  const tickets: any[] = d.tickets || [];
  const cached: any[] = (d.branches || []).filter((b: any) => b.kind !== "base");
  const names = new Set<string>(cached.filter((b) => !b.merged).map((b) => b.name));
  for (const t of tickets) if (OPEN.includes(t.status) && t.branch) names.add(t.branch);
  const next = d.pipeline?.next;
  return {
    you: d.me?.name,
    live_version: d.pipeline?.live?.version || null,
    next_update: next ? {
      version: next.version, size: next.size, title: next.title || null,
      ...(next.needs_title && !String(next.title || "").trim() ? { warning: `A ${next.size} update needs a title before it can go live (set in the suite).` } : {}),
      merged_tickets: tickets.filter((t) => t.status === "on_prerelease").map((t) => ({ id: ref(t.id), title: t.title, type: t.type, ...(t.branch ? { from: t.branch } : {}) })),
      // Merged into pre-release with no ticket on its branch: it ships with no
      // patch note unless one is written (create_ticket with already_merged).
      merged_without_a_ticket: untracked(d).map((p: any) => ({ pr: p.pr_number, title: p.title, branch: p.head, merged: p.merged_at })),
    } : null,
    branches: [...names].map((n) => {
      const b = cached.find((x) => x.name === n) || { name: n };
      const ts = tickets.filter((t) => OPEN.includes(t.status) && t.branch === n).sort(byPri);
      return {
        name: n,
        ...(b.pr_number ? { pr: { number: b.pr_number, state: b.pr_state, url: b.pr_url || `${REPO}/pull/${b.pr_number}` } } : { pr: null }),
        ...(b.sha ? { ahead_of_pre_release: b.ahead ?? 0, behind_pre_release: b.behind ?? 0 } : { note: "not on GitHub (or not synced yet)" }),
        ...(b.merged ? { fully_merged: true } : {}),
        tickets: ts.map((t) => ({ id: ref(t.id), title: t.title, type: t.type, done: !!t.branch_done })),
      };
    }),
    backlog: tickets.filter((t) => OPEN.includes(t.status) && !t.branch).sort(byPri).map(brief),
    merged_branches_safe_to_delete: cached.filter((b) => b.merged && !tickets.some((t) => OPEN.includes(t.status) && t.branch === b.name)).map((b) => b.name),
  };
}
function matches(t: any, q: string, d: any) {
  const n = q.replace(/^(sn-?|#)/i, "");
  if (/^\d+$/.test(n)) return String(t.id) === n || String(t.github_number || "") === n;
  const area = ((d.areas || []).find((a: any) => a.key === t.area) || {}).label || "";
  const hay = `${t.title} ${t.description || ""} ${t.branch || ""} ${area}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

// ---- the tools ------------------------------------------------------------------
const TID = { type: "string", description: 'A ticket, e.g. "SN-565" or "565".' };
const TIDS = { type: "array", items: TID, minItems: 1, maxItems: 30, description: 'Tickets, e.g. ["SN-565", "SN-571"].' };
const TOOLS = [
  { name: "dev_board", description: "The whole pipeline in one call: what's live, the next update (version, size, title, the tickets already merged into it), every branch being built with its tickets and PR, the Backlog, and merged branches that can be tidied. Start here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "get_ticket", description: "One ticket in full: description, where it is, its branch, PR and commits (with the PR's migration / cache-buster / deploy checks), comments and history.",
    inputSchema: { type: "object", properties: { ticket_id: TID }, required: ["ticket_id"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "search_tickets", description: "Find tickets by number or words (title, description, branch, area). stage narrows it: open (default — Backlog and on a branch), backlog, on_branch, pre_release, live, wont_do, any.",
    inputSchema: { type: "object", properties: {
      query: { type: "string" },
      stage: { type: "string", enum: ["open", "backlog", "on_branch", "pre_release", "live", "wont_do", "any"] },
      type: { type: "string", description: "bug, suggestion, improvement or task" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "create_ticket", description: "Make a new ticket — in the Backlog, or straight onto a branch. The TITLE BECOMES THE PATCH NOTE word for word, so write it for a store manager reading \"what's new\" (\"Expense Tool Export Button\", not \"add csv handler\"). Tell the user the number you got.",
    inputSchema: { type: "object", properties: {
      title: { type: "string", maxLength: 200 },
      description: { type: "string", description: "What's wrong or wanted, and how to tell it's done." },
      type: { type: "string", enum: ["bug", "suggestion", "improvement", "task"], description: "bug → Fixed, suggestion → New, improvement → Improved, task → Behind the scenes (in the patch notes)." },
      branch: { type: "string", description: "Put it on this branch at once (optional)." },
      already_merged: { type: "boolean", description: "The work is ALREADY merged into pre-release with no ticket (dev_board lists these under merged_without_a_ticket): the ticket goes straight into the next update as its patch note. Give the merged branch as branch." },
    }, required: ["title", "type"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: "start_branch", description: "Create a branch on GitHub from pre-release and put tickets on it, in one step. Name it for the work (lower case, hyphens), not a ticket number: one branch can carry several tickets. Then check it out locally with: git fetch origin && git switch <kind>/<name>.",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["feat", "fix", "chore"], description: "fix for bugs, feat for new things and improvements, chore for behind-the-scenes work." },
      name: { type: "string", description: "What the work does, e.g. expense-export." },
      ticket_ids: { ...TIDS, minItems: 0 },
    }, required: ["kind", "name"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: "assign_to_branch", description: "Put tickets on a branch (it shows as In progress). A ticket on another branch moves. Tickets already merged into pre-release or live can't move.",
    inputSchema: { type: "object", properties: { ticket_ids: TIDS, branch: { type: "string" } }, required: ["ticket_ids", "branch"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  { name: "unassign", description: "Take tickets off their branch, back to the Backlog — for work that should wait for a later update. (Whatever is on a branch when it merges ships with it.)",
    inputSchema: { type: "object", properties: { ticket_ids: TIDS }, required: ["ticket_ids"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  { name: "mark_done", description: "Tick a ticket done on its branch when its part of the work is finished (or done: false to untick). It still ships only when the branch merges.",
    inputSchema: { type: "object", properties: { ticket_id: TID, done: { type: "boolean" } }, required: ["ticket_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  { name: "comment", description: "Add a comment to a ticket — e.g. what changed, a migration applied or a function deployed (with the user's OK), or what's left.",
    inputSchema: { type: "object", properties: { ticket_id: TID, body: { type: "string", maxLength: 20000 } }, required: ["ticket_id", "body"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false } },
];

function instructions(who: Who | string): string {
  const as = typeof who === "string" ? `NOT CONNECTED: ${who}` : `You are acting for ${who.name}. Everything you change shows in the ticket history as "Claude, for ${who.name.split(/\s+/)[0]}".`;
  return `speeksnet-dev is the SPEEKSNET Development suite: the tickets, branches and releases for speeksnet.com (repo SPEEKS-Technology/speeksnet). ${as}

The pipeline: Backlog → a branch → pre-release → live.
- PRE-RELEASE IS THE NEXT UPDATE. Whatever merges into pre-release ships in the next update, all of it. Merging is the decision to ship.
- A branch carries tickets. When its PR merges into pre-release, every ticket on it moves to the next update by itself — don't move them by hand.

Follow docs/DEVELOPMENT-WORKFLOW.md in the repo. In short:
1. Work starts from a ticket: find it (dev_board, search_tickets) or create_ticket and tell the user the number. Titles become the patch notes verbatim.
2. Branch from pre-release only: start_branch (kind feat|fix|chore, a name for the work). Put the tickets it's for on it.
3. Tick tickets done (mark_done) as their part is finished; mention SN-n in commit messages.
4. PRs go into pre-release, never main, with "Closes SN-n" per ticket in the body. NEVER merge without the user saying so — ask like: "Merging feat/x puts SN-565, SN-571 in the next update (v3.13.0). Merge it?"
5. Never push, merge or open a PR to main, tag, make a GitHub release, bump APP_VERSION, or go live. Go live is a person's button in the suite.
6. Migrations and edge functions go live when applied or deployed — only with the user's OK, and say so on the ticket (comment).

You can't merge, go live, delete branches, or set the next update's size or title from here — those are done on GitHub or in the suite (${SUITE}).`;
}

async function callTool(who: Who, name: string, a: Record<string, unknown>): Promise<unknown> {
  const read = () => call("dev-tickets", who);
  switch (name) {
    case "dev_board": return board(await read());
    case "get_ticket": {
      const id = idOf(a.ticket_id);
      const d = await read();
      const t = (d.tickets || []).find((x: any) => Number(x.id) === id);
      if (!t) throw new Error(`${ref(id)} doesn't exist.`);
      const rel = (d.releases || []).find((r: any) => Number(r.id) === Number(t.release_id));
      const typeLabel = ((d.types || []).find((x: any) => x.key === t.type) || {}).label || t.type;
      return {
        id: ref(t.id), title: t.title, description: t.description || "", type: typeLabel,
        stage: stage(t), status: t.status, branch: t.branch || null, ...(t.branch && OPEN.includes(t.status) ? { done_on_branch: !!t.branch_done } : {}),
        ...(t.status === "on_prerelease" ? { ships_in: d.pipeline?.next?.version || "the next update" } : {}),
        ...(t.status === "done" && rel ? { shipped_in: rel.version || rel.title } : {}),
        area: ((d.areas || []).find((x: any) => x.key === t.area) || {}).label || null,
        assignee: t.assignee_name || null, reporter: t.reporter_name, created: t.created_at,
        attachments: (t.attachments || []).map((x: any) => x.name),
        code: (d.links || []).filter((l: any) => Number(l.ticket_id) === id).map((l: any) => ({ kind: l.kind, ref: l.ref, url: l.url, title: l.title, state: l.state, base: l.base, checks: l.checks })),
        comments: (d.comments || []).filter((c: any) => Number(c.ticket_id) === id).map((c: any) => ({ by: c.author_name, at: c.created_at, body: c.body })),
        history: (d.events || []).filter((e: any) => Number(e.ticket_id) === id).slice(-25).map((e: any) => ({ by: e.actor_name, at: e.created_at, what: e.kind, from: e.from_value, to: e.to_value, note: e.note })),
        url: `${SUITE}#SN-${t.id}`,
      };
    }
    case "search_tickets": {
      const d = await read();
      const q = String(a.query || "").trim();
      const st = String(a.stage || (q && /^(sn-?|#)?\d+$/i.test(q) ? "any" : "open"));
      const limit = Math.min(Math.max(Number(a.limit) || 25, 1), 100);
      const list = (d.tickets || []).filter((t: any) => {
        const s = stage(t);
        if (st === "open" && !OPEN.includes(t.status)) return false;
        if (!["open", "any"].includes(st) && s !== st) return false;
        if (a.type && t.type !== a.type) return false;
        return !q || matches(t, q, d);
      }).sort(byPri);
      return { count: list.length, shown: Math.min(limit, list.length), tickets: list.slice(0, limit).map(brief) };
    }
    case "create_ticket": {
      const r = await call("dev-tickets", who, { action: "create", title: a.title, description: a.description || "", type: a.type, branch: a.branch || null, prerelease: a.already_merged === true });
      return { created: ref(r.ticket.id), title: r.ticket.title, where: r.ticket.status === "on_prerelease" ? "the next update (pre-release)" : r.ticket.branch ? `on ${r.ticket.branch}` : "Backlog", url: `${SUITE}#SN-${r.ticket.id}` };
    }
    case "start_branch": {
      const ids = Array.isArray(a.ticket_ids) && a.ticket_ids.length ? idsOf(a.ticket_ids) : [];
      const r = await call("github-webhook", who, { action: "start_branch", prefix: a.kind, slug: a.name, ticket_ids: ids });
      return { branch: r.branch, from: "pre-release", tickets: ids.map(ref), url: r.url, checkout: `git fetch origin && git switch ${r.branch}`, ...((r.skipped || []).length ? { not_moved: r.skipped } : {}) };
    }
    case "assign_to_branch": {
      const branch = String(a.branch || "").trim();
      if (!branch) throw new Error("Which branch?");
      const r = await call("dev-tickets", who, { action: "to_branch", ids: idsOf(a.ticket_ids), branch });
      return { branch, tickets: (r.tickets || []).map((t: any) => ref(t.id)) };
    }
    case "unassign": {
      const r = await call("dev-tickets", who, { action: "to_branch", ids: idsOf(a.ticket_ids), branch: null });
      return { backlog: (r.tickets || []).map((t: any) => ref(t.id)) };
    }
    case "mark_done": {
      const done = a.done === undefined ? true : !!a.done;
      const r = await call("dev-tickets", who, { action: "branch_done", id: idOf(a.ticket_id), done });
      return { ticket: ref(r.ticket.id), branch: r.ticket.branch, done: !!r.ticket.branch_done };
    }
    case "comment": {
      const body = String(a.body || "").trim();
      if (!body) throw new Error("Write the comment first.");
      await call("dev-tickets", who, { action: "comment", id: idOf(a.ticket_id), body });
      return { commented_on: ref(idOf(a.ticket_id)) };
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ---- MCP over Streamable HTTP (JSON responses, no SSE) — as speeks-mcp ----------
type RpcMsg = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

async function handle(msg: RpcMsg, who: Who | string): Promise<Record<string, unknown> | null> {
  const id = msg.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  if (msg.id === undefined || msg.id === null) return null;   // a notification
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "speeksnet-dev", version: "1.0.0" },
        instructions: instructions(who),
      });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof who === "string") return ok({ content: [{ type: "text", text: `Not connected — ${who}` }], isError: true });
      const t0 = Date.now();
      try {
        const out = await callTool(who, name, args);
        console.log(`dev-mcp ${name} ok ${Date.now() - t0}ms (${who.name})`);
        return ok({ content: [{ type: "text", text: JSON.stringify(out) }] });
      } catch (e) {
        console.log(`dev-mcp ${name} error ${Date.now() - t0}ms (${who.name}): ${(e as Error).message}`);
        return ok({ content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });
  const url = new URL(req.url);
  const who = await resolve(keyFrom(req, url));
  let body: RpcMsg | RpcMsg[];
  try { body = await req.json(); }
  catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: cors }); }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(m, who)))).filter(Boolean);
    return out.length ? Response.json(out, { headers: cors }) : new Response(null, { status: 202, headers: cors });
  }
  const out = await handle(body, who);
  return out ? Response.json(out, { headers: cors }) : new Response(null, { status: 202, headers: cors });
});
