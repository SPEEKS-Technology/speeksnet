import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// GITHUB-WEBHOOK — dev tracker Phase 4: GitHub → SPEEKSNET, read only (D6).
// Plan: docs/plans/dev-tracker-HANDOFF.md (Phase 4). Data: 0188, 0192.
// ----------------------------------------------------------------------------
//   POST from GitHub (X-GitHub-Event)    a webhook delivery from the speeksnet
//                                        GitHub App, signature-checked against
//                                        GITHUB_WEBHOOK_SECRET
//   POST ?trigger=cron&secret=…          the nightly reconcile (0192's cron):
//                                        catches anything a delivery missed
//   POST + x-user-pin {action:'reconcile'}  the same, from the Development
//                                        page's "Sync with GitHub" (dev-tracker
//                                        holders, real people only)
//
// WHAT IT DOES
//   LINKS — "SN-1012" (or "sn-1012", "SN1012") in a branch name, a commit
//   message, or a PR's title, body or branch attaches that branch / commit / PR
//   to ticket SN-1012 (dev_ticket_links). "Fixes #573"-style closing keywords
//   also link, but only to an IMPORTED ticket (github_number = 573): GitHub
//   shares one counter between issues and PRs, so a bare #1005 later on could
//   just as well be a PR.
//
//   STATUS — moves tickets on its own, as 'GitHub' in the history. Nick's
//   calls, 2026-11-19:
//     branch with SN-n pushed/created           → In progress
//     PR opened / reopened / ready for review   → In review   (a draft → In progress)
//     PR merged into pre-release                → On pre-release
//     the work reaches main (= live, GitHub Pages serves main) → Done
//     PR closed WITHOUT merging, ticket In review, no other open PR → back to In progress
//   FORWARD ONLY otherwise: it never moves a ticket back (except that last
//   rule, and only on the live delivery, not the reconcile — replaying an old
//   closed PR must not undo a person's move), and never touches Won't do.
//   PRs merged into anything other than pre-release or main (an update branch,
//   the dev-tracker umbrella) are linked and logged but move nothing.
//
//   CHECKS — on every PR that touches a ticket, from its changed files, shown
//   on the ticket (and, Phase 6, on the release checklist):
//     a NEW supabase/migrations/NNNN_*.sql → applied already? number taken in
//       the database by a different name, or on another open branch? (CLAUDE.md
//       trap 4 — the database is the authority, via dev_applied_migrations())
//     speeks.js / styles.css changed but no .html bumped a ?v= → flag (trap 3)
//     supabase/functions/<name>/ changed → "deploy <name>"
//
// Every delivery and reconcile writes a github_sync_log row.
//
// SECURITY (public repo, §7 risk 1): the cron's ?secret= is the shared sync
// secret, readable in the source. That only lets someone trigger a reconcile —
// a read of GitHub and an idempotent, forward-only write here — never a write
// to GitHub. Webhook deliveries are trusted only with a valid signature.
// ============================================================================

const REPO = "SPEEKS-Technology/speeksnet";
const GH = "https://api.github.com";
const SYNC_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const UA = "speeksnet-github-webhook";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type Sb = ReturnType<typeof createClient>;
type Check = { kind: "migration" | "buster" | "function"; level: "ok" | "todo" | "warn" | "error"; text: string };

const RANK: Record<string, number> = { triage: 0, backlog: 1, in_progress: 2, in_review: 3, on_prerelease: 4, done: 5 };
const lc = (v: unknown) => String(v ?? "").toLowerCase().trim();
const roleSlug = (role: string) => lc(role).replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-");

// ---- the GitHub App (same signing as github-import) ------------------------
const b64url = (bytes: Uint8Array | string) => {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const derLen = (n: number) => n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255];
function pkcs8(pkcs1: Uint8Array): Uint8Array {
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLen(pkcs1.length)];
  const inner = [0x02, 0x01, 0x00, ...algo, ...octet];
  const total = inner.length + pkcs1.length;
  const out = new Uint8Array(1 + derLen(total).length + total);
  out.set([0x30, ...derLen(total), ...inner]);
  out.set(pkcs1, out.length - pkcs1.length);
  return out;
}
let _token: { value: string; until: number } | null = null;
async function appToken(): Promise<string> {
  if (_token && _token.until > Date.now()) return _token.value;
  const appId = Deno.env.get("GITHUB_APP_ID");
  const inst = Deno.env.get("GITHUB_APP_INSTALLATION_ID");
  const pem = Deno.env.get("GITHUB_APP_PRIVATE_KEY");
  if (!appId || !inst || !pem) throw new Error("The GitHub App secrets aren't all set.");
  const body = pem.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  // PKCS#1 vs PKCS#8 from the DER itself — the stored key's header lies (github-import).
  const hdr = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const isPkcs1 = der[hdr] === 0x02 && der[hdr + 3] === 0x02;
  const key = await crypto.subtle.importKey("pkcs8", isPkcs1 ? pkcs8(der) : der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." +
    b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const r = await fetch(`${GH}/app/installations/${inst}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${unsigned}.${b64url(sig)}`, Accept: "application/vnd.github+json", "User-Agent": UA },
  });
  if (!r.ok) throw new Error(`GitHub refused the App (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  _token = { value: j.token, until: Date.now() + 50 * 60 * 1000 };
  return j.token;
}
async function gh(path: string): Promise<any> {
  const token = await appToken();
  const r = await fetch(`${GH}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": UA } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function ghAll(path: string, stop?: (item: any) => boolean): Promise<any[]> {
  const token = await appToken();
  const out: any[] = [];
  let url: string | null = `${GH}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": UA } });
    if (!r.ok) throw new Error(`GitHub ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const page = await r.json();
    for (const x of page) { if (stop && stop(x)) return out; out.push(x); }
    const next = (r.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return out;
}

// ---- signature -------------------------------------------------------------
async function signatureOk(raw: string, header: string | null): Promise<boolean> {
  const secret = Deno.env.get("GITHUB_WEBHOOK_SECRET");
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const want = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  const got = header.slice(7);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// ---- the work --------------------------------------------------------------
// One run (a delivery or a reconcile): its own caches and a summary of what it
// changed, which goes into github_sync_log.
class Run {
  sb: Sb;
  live: boolean;
  summary = { linked: 0, moved: [] as string[], checked: 0, errors: [] as string[] };
  private tickets = new Map<number, any>();
  private applied: string[] | null = null;
  private branchMigs = new Map<string, string[]>();
  private inMain = new Map<string, boolean>();
  constructor(sb: Sb, live: boolean) { this.sb = sb; this.live = live; }

  // A title, a branch name, a commit message: SN-n anywhere. A PR BODY
  // (keyworded): only after a keyword — "Fixes SN-1012", "Refs SN-1012", "Part
  // of SN-1012". Bodies mention tickets in passing (PR #580's lists SN-573 and
  // SN-65…SN-575 as examples), and a link moves a status. "Fixes #n" either
  // way, but only for an imported ticket.
  refs(text: string, keyworded = false): { sn: number[]; closes: number[] } {
    const sn = new Set<number>(), closes = new Set<number>();
    const s = String(text || "");
    const re = keyworded
      ? /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|part of|ticket)\s*:?\s+sn-?(\d{2,6})(?!\d)/gi
      : /(?<![A-Za-z0-9])sn-?(\d{2,6})(?!\d)/gi;
    for (const m of s.matchAll(re)) sn.add(Number(m[1]));
    for (const m of s.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d{1,5})\b/gi)) closes.add(Number(m[1]));
    return { sn: [...sn], closes: [...closes] };
  }
  async ticketsFor(text: string, keyworded = false): Promise<any[]> {
    const { sn, closes } = this.refs(text, keyworded);
    const want = [...new Set([...sn, ...closes])].filter((n) => !this.tickets.has(n));
    if (want.length) {
      const { data } = await this.sb.from("dev_tickets").select("id, status, github_number").in("id", want);
      for (const n of want) this.tickets.set(n, null);
      for (const t of data || []) this.tickets.set(Number(t.id), t);
    }
    const out: any[] = [];
    for (const n of sn) { const t = this.tickets.get(n); if (t) out.push(t); }
    for (const n of closes) { const t = this.tickets.get(n); if (t && Number(t.github_number) === n && !out.includes(t)) out.push(t); }
    return out;
  }

  async link(ticket: any, kind: "branch" | "commit" | "pr", ref: string, fields: Record<string, unknown>, note: string) {
    const { data: had } = await this.sb.from("dev_ticket_links").select("id").eq("ticket_id", ticket.id).eq("kind", kind).eq("ref", ref).maybeSingle();
    if (had) {
      await this.sb.from("dev_ticket_links").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", had.id);
      return;
    }
    const { error } = await this.sb.from("dev_ticket_links").insert({ ticket_id: ticket.id, kind, ref, ...fields });
    if (error && !/duplicate key/i.test(error.message)) { this.summary.errors.push(error.message); return; }
    if (error) return; // a concurrent delivery got there first
    await this.sb.from("dev_ticket_events").insert({ ticket_id: ticket.id, kind: "linked", actor_name: "GitHub", to_value: kind, note });
    this.summary.linked++;
  }

  // Forward only, never out of Won't do; `back` is the one sanctioned retreat.
  async move(ticket: any, to: string, note: string, back = false) {
    const from = String(ticket.status);
    if (from === "wont_do" || from === to) return;
    if (!back && !(RANK[to] > (RANK[from] ?? 99))) return;
    const now = new Date().toISOString();
    const { data: row } = await this.sb.from("dev_tickets")
      .update({ status: to, closed_at: to === "done" ? now : null, updated_at: now })
      .eq("id", ticket.id).eq("status", from).select("id, status, github_number").maybeSingle();
    if (!row) return; // someone moved it at the same moment — theirs stands
    await this.sb.from("dev_ticket_events").insert({ ticket_id: ticket.id, kind: "status", actor_name: "GitHub", from_value: from, to_value: to, note });
    ticket.status = to;
    this.summary.moved.push(`SN-${ticket.id} ${from}→${to}`);
  }

  // ---- branches ----
  async branch(name: string, sha: string | null, deleted = false) {
    if (deleted) {
      await this.sb.from("dev_ticket_links").update({ state: "deleted", updated_at: new Date().toISOString() }).eq("kind", "branch").eq("ref", name);
      return;
    }
    for (const t of await this.ticketsFor(name)) {
      await this.link(t, "branch", name, { url: `https://github.com/${REPO}/tree/${name}`, title: name, state: "active", head_sha: sha }, `Branch ${name}`);
      await this.move(t, "in_progress", `Branch ${name} pushed`);
    }
  }

  // ---- commits (links only; the branch and the PR move the status) ----
  async commit(c: { id: string; message: string; url?: string; author?: string }) {
    const msg = String(c.message || "");
    // A merge commit names the branch it merged, SN number and all — noise.
    if (/^Merge (pull request|branch|remote-tracking)/.test(msg)) return;
    const first = msg.split("\n")[0].slice(0, 200);
    for (const t of await this.ticketsFor(msg)) {
      await this.link(t, "commit", c.id, { url: c.url || `https://github.com/${REPO}/commit/${c.id}`, title: first, sha: c.id, author: c.author || null }, `Commit ${c.id.slice(0, 7)}: ${first}`);
    }
  }

  // ---- pull requests ----
  async pr(pr: any, action: string | null) {
    const tickets = await this.ticketsFor(`${pr.title}\n${pr.head?.ref || ""}`);
    for (const t of await this.ticketsFor(String(pr.body || ""), true)) if (!tickets.includes(t)) tickets.push(t);
    if (!tickets.length) return;
    const state = pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";
    const base = String(pr.base?.ref || "");
    const fields: Record<string, unknown> = {
      url: pr.html_url, title: String(pr.title || "").slice(0, 300), state, base, head: pr.head?.ref || null,
      author: pr.user?.login || null, merged_at: pr.merged_at || null,
      sha: pr.merged_at ? (pr.merge_commit_sha || null) : null, head_sha: pr.head?.sha || null,
    };
    // Checks only when the code changed since we last looked (or never looked).
    const { data: prev } = await this.sb.from("dev_ticket_links").select("head_sha, checks")
      .eq("kind", "pr").eq("ref", String(pr.number)).limit(1).maybeSingle();
    if (state !== "closed" && (!prev || prev.head_sha !== pr.head?.sha || !Array.isArray(prev.checks))) {
      try { fields.checks = await this.checks(pr); this.summary.checked++; }
      catch (e) { this.summary.errors.push(`checks #${pr.number}: ${(e as Error).message}`); }
    }
    for (const t of tickets) {
      await this.link(t, "pr", String(pr.number), fields, `PR #${pr.number}: ${String(pr.title || "").slice(0, 160)}`);
      if (state === "open") await this.move(t, "in_review", `PR #${pr.number} ${action === "ready_for_review" ? "ready for review" : "opened"}`);
      else if (state === "draft") await this.move(t, "in_progress", `Draft PR #${pr.number} opened`);
      else if (state === "merged" && base === "pre-release") await this.move(t, "on_prerelease", `PR #${pr.number} merged into pre-release`);
      else if (state === "merged" && base === "main") await this.move(t, "done", `PR #${pr.number} merged into main — live`);
      else if (state === "closed" && this.live && action === "closed" && t.status === "in_review") {
        const { data: open } = await this.sb.from("dev_ticket_links").select("ref")
          .eq("ticket_id", t.id).eq("kind", "pr").in("state", ["open", "draft"]).neq("ref", String(pr.number));
        if (!(open || []).length) await this.move(t, "in_progress", `PR #${pr.number} closed without merging`, true);
      }
    }
  }

  // ---- the changed-file checks ----
  async appliedMigrations(): Promise<string[]> {
    if (this.applied) return this.applied;
    const { data, error } = await this.sb.rpc("dev_applied_migrations");
    if (error) throw new Error(`dev_applied_migrations: ${error.message}`);
    this.applied = (data || []).map((r: any) => String(r.name || ""));
    return this.applied;
  }
  async migrationsOn(ref: string): Promise<string[]> {
    if (this.branchMigs.has(ref)) return this.branchMigs.get(ref)!;
    const list = await gh(`/repos/${REPO}/contents/supabase/migrations?ref=${encodeURIComponent(ref)}`).catch(() => null);
    const names = Array.isArray(list) ? list.map((f: any) => String(f.name || "").replace(/\.sql$/, "")) : [];
    this.branchMigs.set(ref, names);
    return names;
  }
  async checks(pr: any): Promise<Check[]> {
    const files = await ghAll(`/repos/${REPO}/pulls/${pr.number}/files`);
    const out: Check[] = [];
    const num = (n: string) => n.split("_")[0];

    const migs = files.filter((f: any) => ["added", "renamed", "copied"].includes(f.status) && /^supabase\/migrations\/\d{4}[a-z]?_.+\.sql$/.test(f.filename))
      .map((f: any) => f.filename.split("/").pop().replace(/\.sql$/, ""));
    if (migs.length) {
      const applied = await this.appliedMigrations();
      // Every other open PR's branch, plus pre-release and main.
      const open = await ghAll(`/repos/${REPO}/pulls?state=open`);
      const refs = [...new Set(["pre-release", "main", ...open.map((p: any) => p.head?.ref).filter(Boolean)])].filter((r) => r !== pr.head?.ref);
      for (const m of migs) {
        if (applied.includes(m)) { out.push({ kind: "migration", level: "ok", text: `${m} — applied` }); continue; }
        const inDb = applied.find((a) => num(a) === num(m));
        if (inDb) { out.push({ kind: "migration", level: "error", text: `${num(m)} is already used in the database by ${inDb} — renumber before applying` }); continue; }
        let clash = "";
        for (const r of refs) {
          const other = (await this.migrationsOn(r)).find((a) => num(a) === num(m) && a !== m);
          if (other) { clash = `${num(m)} is also used on ${r} (${other}) — renumber one of them`; break; }
        }
        out.push(clash ? { kind: "migration", level: "error", text: clash } : { kind: "migration", level: "todo", text: `${m} — apply it (not in the database yet)` });
      }
    }

    const code = files.filter((f: any) => f.status !== "removed" && /^(speeks\.js|styles\.css)$/.test(f.filename)).map((f: any) => f.filename);
    if (code.length) {
      const bumped = files.some((f: any) => /\.html$/.test(f.filename) && /^\+.*(speeks\.js|styles\.css)\?v=/m.test(String(f.patch || "")));
      out.push(bumped
        ? { kind: "buster", level: "ok", text: `${code.join(" and ")} changed; cache-buster bumped` }
        : { kind: "buster", level: "warn", text: `${code.join(" and ")} changed but no page's cache-buster (?v=) was bumped` });
    }

    const fns = [...new Set(files.map((f: any) => (String(f.filename).match(/^supabase\/functions\/([^/_][^/]*)\//) || [])[1]).filter(Boolean))];
    for (const f of fns) out.push({ kind: "function", level: "todo", text: `Deploy the ${f} function` });
    return out;
  }

  // ---- Done: the work has reached main ----
  async included(sha: string): Promise<boolean> {
    if (this.inMain.has(sha)) return this.inMain.get(sha)!;
    const c = await gh(`/repos/${REPO}/compare/${sha}...main`).catch(() => null);
    const yes = !!c && (c.status === "ahead" || c.status === "identical");
    this.inMain.set(sha, yes);
    return yes;
  }
  async reachedMain() {
    const { data: waiting } = await this.sb.from("dev_tickets").select("id, status, github_number").eq("status", "on_prerelease");
    if (!(waiting || []).length) return;
    const { data: links } = await this.sb.from("dev_ticket_links").select("ticket_id, kind, ref, sha, state")
      .in("ticket_id", (waiting || []).map((t: any) => t.id)).not("sha", "is", null);
    for (const t of waiting || []) {
      const mine = (links || []).filter((l: any) => Number(l.ticket_id) === Number(t.id) && (l.kind !== "pr" || l.state === "merged"));
      for (const l of mine) {
        if (await this.included(l.sha)) { await this.move(t, "done", `Reached main — live on speeksnet.com (${l.kind === "pr" ? "PR #" + l.ref : l.sha.slice(0, 7)})`); break; }
      }
    }
  }

  // ---- releases: keep dev_releases in step (Phase 6 will create them) ----
  async release(r: any) {
    if (!r || r.draft) return;
    const row = { version: r.tag_name || null, title: r.name || r.tag_name || "Release", status: "published",
      published_at: r.published_at || new Date().toISOString(), github_release_id: r.id, updated_at: new Date().toISOString() };
    const { data: had } = await this.sb.from("dev_releases").select("id").or(`github_release_id.eq.${Number(r.id)},version.eq."${String(r.tag_name || "").replace(/"/g, "")}"`).limit(1).maybeSingle();
    if (had) await this.sb.from("dev_releases").update(row).eq("id", had.id);
    else await this.sb.from("dev_releases").insert(row);
  }

  // ---- the reconcile: everything a missed delivery would have done ----
  async reconcile(sinceIso: string) {
    const since = Date.parse(sinceIso);
    const prs = await ghAll(`/repos/${REPO}/pulls?state=all&sort=updated&direction=desc`, (p) => Date.parse(p.updated_at) < since);
    for (const p of prs) await this.pr(p, null);
    const branches = await ghAll(`/repos/${REPO}/branches`);
    const live = new Set(branches.map((b: any) => b.name));
    for (const b of branches) await this.branch(b.name, b.commit?.sha || null);
    const { data: known } = await this.sb.from("dev_ticket_links").select("ref").eq("kind", "branch").neq("state", "deleted");
    for (const k of known || []) if (!live.has(k.ref)) await this.branch(k.ref, null, true);
    for (const ref of ["pre-release", "main"]) {
      const commits = await ghAll(`/repos/${REPO}/commits?sha=${ref}&since=${encodeURIComponent(new Date(since).toISOString())}`);
      for (const c of commits) await this.commit({ id: c.sha, message: c.commit?.message || "", url: c.html_url, author: c.author?.login || c.commit?.author?.name });
    }
    await this.reachedMain();
    return { prs: prs.length, branches: branches.length };
  }
}

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

async function handleDelivery(sb: Sb, event: string, delivery: string | null, p: any) {
  const run = new Run(sb, true);
  let ok = true;
  try {
    if (event === "push") {
      const ref = String(p.ref || "");
      if (ref.startsWith("refs/heads/")) {
        const branch = ref.slice(11);
        await run.branch(branch, p.after || null, !!p.deleted);
        if (!p.deleted) for (const c of p.commits || []) await run.commit({ id: c.id, message: c.message, url: c.url, author: c.author?.username || c.author?.name });
        if (branch === "main" && !p.deleted) await run.reachedMain();
      }
    } else if (event === "create" && p.ref_type === "branch") {
      await run.branch(String(p.ref), null);
    } else if (event === "delete" && p.ref_type === "branch") {
      await run.branch(String(p.ref), null, true);
    } else if (event === "pull_request" && p.pull_request) {
      await run.pr(p.pull_request, String(p.action || ""));
    } else if (event === "release" && ["published", "released", "edited"].includes(String(p.action))) {
      await run.release(p.release);
    }
  } catch (e) {
    ok = false;
    run.summary.errors.push((e as Error).message);
  }
  await sb.from("github_sync_log").insert({
    kind: "webhook", event: p.action ? `${event}.${p.action}` : event, delivery_id: delivery,
    ok: ok && !run.summary.errors.length,
    detail: { ref: p.ref || p.pull_request?.number || null, ...run.summary },
  });
  if (run.summary.linked || run.summary.moved.length) await broadcastChange();
}

async function runReconcile(sb: Sb, who: { name: string; id: string | null }, days?: number) {
  const run = new Run(sb, false);
  // From the last good reconcile (with an hour's overlap), else three days.
  let since = new Date(Date.now() - (days || 3) * 86400000).toISOString();
  if (!days) {
    const { data: last } = await sb.from("github_sync_log").select("created_at").eq("kind", "reconcile").eq("ok", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (last) since = new Date(Date.parse(last.created_at) - 3600000).toISOString();
  }
  let counts: unknown = null, ok = true;
  try { counts = await run.reconcile(since); }
  catch (e) { ok = false; run.summary.errors.push((e as Error).message); }
  await sb.from("github_sync_log").insert({
    kind: "reconcile", event: who.id ? "manual" : "cron", ok: ok && !run.summary.errors.length,
    detail: { since, counts, ...run.summary }, actor_name: who.name, actor_id: who.id,
  });
  if (run.summary.linked || run.summary.moved.length) await broadcastChange();
  return { ok, since, counts, ...run.summary };
}

// Same user > role > default rule as dev-tickets; dev-tracker is off for every role.
async function holdsDevTracker(sb: Sb, name: string, role: string) {
  const { data } = await sb.from("feature_overrides").select("subject_type, subject, enabled").eq("feature_key", "dev-tracker");
  const u = (data || []).find((r: any) => lc(r.subject_type) === "user" && lc(r.subject) === lc(name));
  if (u) return !!u.enabled;
  const r = (data || []).find((r: any) => lc(r.subject_type) === "role" && lc(r.subject) === roleSlug(role));
  return r ? !!r.enabled : false;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST only" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);

  // ---- a GitHub delivery ----
  const event = req.headers.get("x-github-event");
  if (event) {
    const raw = await req.text();
    const delivery = req.headers.get("x-github-delivery");
    if (!(await signatureOk(raw, req.headers.get("x-hub-signature-256")))) {
      await sb.from("github_sync_log").insert({ kind: "webhook", event, delivery_id: delivery, ok: false, detail: { error: "bad or missing signature" } });
      return json({ success: false, error: "bad signature" }, 401);
    }
    if (event === "ping") return json({ success: true, pong: true });
    let p: any;
    try { p = JSON.parse(raw); } catch { return json({ success: false, error: "bad JSON" }, 400); }
    // Answer GitHub at once (it gives up after 10 s); the work carries on.
    const work = handleDelivery(sb, event, delivery, p);
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt && typeof rt.waitUntil === "function") { rt.waitUntil(work); return json({ success: true, queued: true }, 202); }
    await work;
    return json({ success: true });
  }

  // ---- the nightly reconcile ----
  if (url.searchParams.get("trigger") === "cron") {
    if (url.searchParams.get("secret") !== SYNC_SECRET) return json({ success: false, error: "forbidden" }, 403);
    const r = await runReconcile(sb, { name: "GitHub (nightly)", id: null });
    return json({ success: r.ok, ...r });
  }

  // ---- "Sync with GitHub" from the Development page ----
  const pin = req.headers.get("x-user-pin") || "";
  if (!pin) return json({ success: false, error: "Sign in again — your session has no PIN." }, 401);
  const { data: u } = await sb.from("users").select("id, name, role").eq("pin", pin).maybeSingle();
  if (!u) return json({ success: false, error: "Only a real account can sync (test accounts can't)." }, 403);
  if (!(await holdsDevTracker(sb, String(u.name || ""), String(u.role || "")))) {
    return json({ success: false, error: "The development tracker isn't switched on for you." }, 403);
  }
  let b: any = {};
  try { b = await req.json(); } catch { /* empty body is fine */ }
  if (String(b.action || "reconcile") !== "reconcile") return json({ success: false, error: "Unknown action" }, 400);
  const days = Number(b.days) > 0 && Number(b.days) <= 30 ? Number(b.days) : undefined;
  const r = await runReconcile(sb, { name: String(u.name), id: String(u.id) }, days);
  return json({ success: r.ok, ...r });
});
