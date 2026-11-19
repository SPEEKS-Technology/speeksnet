import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// GITHUB-IMPORT — Development tracker Phase 2: move GitHub's issues,
// milestones and releases into the tracker (migration 0188). One-off.
// Plan: docs/plans/dev-tracker-HANDOFF.md (Phase 2, D1, Q5, Q6).
// ----------------------------------------------------------------------------
//   GET  + x-user-pin [?open_in_closed=done|backlog][&full=1]
//        DRY RUN. Reads GitHub, writes nothing but a github_sync_log row, and
//        returns what an import would do: counts, the label → type and
//        login → person mapping, statuses, release matching, and anything
//        already imported. full=1 adds the per-ticket preview.
//   POST + x-user-pin {apply: true, open_in_closed?: 'done'|'backlog'}
//        THE IMPORT. Same plan as the dry run, then written.
//
// WHO: holders of dev-tracker (Feature Access, D2). A test account (0160) that
// has been granted it may run the dry run — it only reads the public repo —
// but never the import: POST resolves only real users, and the actor on every
// imported event is the person whose PIN ran it.
//
// SAFE TO RE-RUN. A ticket whose id already exists is skipped, never
// overwritten (it may have been worked in SPEEKSNET since); comments are keyed
// on github_comment_id, releases on github_milestone / github_release_id. A
// second run imports only what's new on GitHub — which is how issues raised
// between the dry run and switching Issues off still get across.
//
// GITHUB AUTH: the SPEEKSNET GitHub App (Phase 0). A JWT signed with the App's
// private key buys a one-hour installation token. GitHub hands out the key as
// PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto only imports PKCS#8, so pkcs8()
// wraps it. The key also arrives with its newlines however the dashboard kept
// them — real, or literal "\n" — so the PEM is rebuilt from its base64 alone.
// A 401 from GitHub here means the stored key is wrong, not this code.
//
// DECISIONS IN THE MAPPING (shown in every dry run so they can be changed
// before the import, not after):
//   type    Bug/Fix → bug · Feature Update → suggestion · Minor Update →
//           improvement · no label → task
//   status  closed (completed) → done · closed (not planned) → wont_do ·
//           open → backlog — EXCEPT an open issue in a milestone that has
//           already closed (an update that shipped; ~190 of the 211 open on
//           2026-11-18 — issues were left open when their update went out).
//           Those follow open_in_closed: 'done' or 'backlog'. No default is
//           assumed for the import: POST must say which.
//   area    left blank — GitHub has no equivalent; set it in the tracker.
//   people  github_people (login → users.id); anyone unmapped keeps their
//           GitHub login as the name, with no id.
//   release a milestone and a GitHub release are ONE row when the release's
//           name contains the milestone's title (the version prefix aside),
//           e.g. "v3.9.0 Main October Update" ⇄ "Main October Update".
//           Anything unmatched is a row of its own.
// ============================================================================

const REPO = "SPEEKS-Technology/speeksnet";
const GH = "https://api.github.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Same defaults as dev-tickets and FEATURE_CATALOG.
const DEFAULTS: Record<string, string[]> = { "dev-tracker": [] };
const roleSlug = (role: string) =>
  String(role || "").toLowerCase().trim().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-");
const lc = (v: unknown) => String(v ?? "").toLowerCase().trim();

const LABEL_TYPE: [string, string][] = [   // first match wins, in this order
  ["bug/fix", "bug"],
  ["feature update", "suggestion"],
  ["minor update", "improvement"],
];
const NO_LABEL_TYPE = "task";

type Sb = ReturnType<typeof createClient>;

// ---- the GitHub App -------------------------------------------------------
const b64url = (bytes: Uint8Array | string) => {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
// DER length, then wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo.
const derLen = (n: number) => n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255];
function pkcs8(pkcs1: Uint8Array): Uint8Array {
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]; // rsaEncryption, NULL
  const octet = [0x04, ...derLen(pkcs1.length)];
  const inner = [0x02, 0x01, 0x00, ...algo, ...octet];
  const total = inner.length + pkcs1.length;
  const out = new Uint8Array(1 + derLen(total).length + total);
  out.set([0x30, ...derLen(total), ...inner]);
  out.set(pkcs1, out.length - pkcs1.length);
  return out;
}
async function appToken(): Promise<string> {
  const appId = Deno.env.get("GITHUB_APP_ID");
  const inst = Deno.env.get("GITHUB_APP_INSTALLATION_ID");
  const pem = Deno.env.get("GITHUB_APP_PRIVATE_KEY");
  if (!appId || !inst || !pem) throw new Error("The GitHub App secrets aren't all set (GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY).");
  const body = pem.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  // Tell the formats apart by the DER itself, not the header line (the stored
  // key's header didn't say RSA though the key was PKCS#1 — found on the first
  // dry run, 2026-11-18). Both open SEQUENCE { INTEGER 0, … }; PKCS#8 follows
  // with the algorithm SEQUENCE (0x30), PKCS#1 with the modulus INTEGER (0x02).
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
    headers: { Authorization: `Bearer ${unsigned}.${b64url(sig)}`, Accept: "application/vnd.github+json", "User-Agent": "speeksnet-github-import" },
  });
  if (!r.ok) throw new Error(`GitHub refused the App (${r.status}): ${(await r.text()).slice(0, 300)}${r.status === 401 ? " — the stored private key is probably wrong." : ""}`);
  return (await r.json()).token;
}
// Every page of a list endpoint, following GitHub's Link header.
async function ghAll(token: string, path: string): Promise<any[]> {
  const out: any[] = [];
  let url: string | null = `${GH}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "speeksnet-github-import" } });
    if (!r.ok) throw new Error(`GitHub ${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
    out.push(...(await r.json()));
    const next = (r.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return out;
}

// ---- helpers --------------------------------------------------------------
const clip = (v: unknown, max: number) => String(v ?? "").replace(/\r\n/g, "\n").slice(0, max);
const norm = (s: string) => lc(s).replace(/^v?[\d.]+[\w-]*\s*[-—:]?\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
const tally = (xs: string[]) => xs.reduce((m: Record<string, number>, x) => (m[x] = (m[x] || 0) + 1, m), {});
async function chunked(sb: Sb, table: string, rows: any[]) {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from(table).insert(rows.slice(i, i + 200));
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return json({ success: false, error: "GET (dry run) or POST (import)." }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const apply = req.method === "POST";

  // ---- who ----
  const pin = req.headers.get("x-user-pin") || "";
  if (!pin) return json({ success: false, error: "No PIN." }, 401);
  let { data: u } = await sb.from("users").select("id, name, role").eq("pin", pin).maybeSingle();
  let test = false;
  if (!u && !apply) {
    ({ data: u } = await sb.from("test_users").select("name, role").eq("pin", pin).maybeSingle());
    test = !!u;
  }
  if (!u) return json({ success: false, error: "That PIN isn't recognised." }, 401);
  const me = { id: (u as any).id ? String((u as any).id) : null, name: String(u.name || "").trim(), role: String(u.role || "") };
  const { data: ov } = await sb.from("feature_overrides").select("subject_type, subject, enabled").eq("feature_key", "dev-tracker");
  const uo = (ov || []).find((r: any) => lc(r.subject_type) === "user" && lc(r.subject) === lc(me.name));
  const ro = (ov || []).find((r: any) => lc(r.subject_type) === "role" && lc(r.subject) === roleSlug(me.role));
  const dev = uo ? !!uo.enabled : ro ? !!ro.enabled : DEFAULTS["dev-tracker"].includes(roleSlug(me.role));
  if (!dev) return json({ success: false, error: "The development tracker isn't switched on for you." }, 403);

  // ---- options ----
  const url = new URL(req.url);
  let opts: any = {};
  if (apply) { try { opts = await req.json(); } catch (_) { opts = {}; } }
  if (apply && opts.apply !== true) return json({ success: false, error: "POST imports for real — send {apply: true} to mean it." }, 400);
  const openInClosed = String((apply ? opts.open_in_closed : url.searchParams.get("open_in_closed")) || "");
  if (apply && !["done", "backlog"].includes(openInClosed))
    return json({ success: false, error: "Say what happens to open issues in closed milestones: open_in_closed 'done' or 'backlog'." }, 400);
  const full = url.searchParams.get("full") === "1";

  try {
    // ---- read GitHub ----
    const token = await appToken();
    const [items, milestones, releases, ghComments] = await Promise.all([
      ghAll(token, `/repos/${REPO}/issues?state=all&direction=asc`),
      ghAll(token, `/repos/${REPO}/milestones?state=all`),
      ghAll(token, `/repos/${REPO}/releases`),
      ghAll(token, `/repos/${REPO}/issues/comments`),
    ]);
    const issues = items.filter((i: any) => !i.pull_request);   // the issues list includes PRs; PRs aren't tickets
    const tooHigh = issues.filter((i: any) => i.number >= 1000).map((i: any) => i.number);
    if (tooHigh.length) throw new Error(`Issue numbers at or past 1000 would collide with SN-1000+: ${tooHigh.join(", ")}`);

    // ---- what's already here ----
    const [{ data: people }, { data: types }, { data: haveT }, { data: haveC }, { data: haveR }] = await Promise.all([
      sb.from("github_people").select("login, user_id, name"),
      sb.from("dev_ticket_types").select("key"),
      sb.from("dev_tickets").select("id").lt("id", 1000),
      sb.from("dev_ticket_comments").select("github_comment_id").not("github_comment_id", "is", null),
      sb.from("dev_releases").select("id, version, github_milestone, github_release_id"),
    ]);
    const typeKeys = new Set((types || []).map((t: any) => t.key));
    for (const [, t] of LABEL_TYPE) if (!typeKeys.has(t)) throw new Error(`Ticket type '${t}' is missing from dev_ticket_types.`);
    const who = new Map((people || []).map((p: any) => [lc(p.login), p]));
    const person = (login: string | undefined) => {
      if (!login) return { id: null, name: null as string | null, mapped: false };
      const p: any = who.get(lc(login));
      return p ? { id: p.user_id, name: p.name, mapped: true } : { id: null, name: login, mapped: false };
    };
    const haveTicket = new Set((haveT || []).map((r: any) => Number(r.id)));
    const haveComment = new Set((haveC || []).map((r: any) => Number(r.github_comment_id)));

    // ---- releases: milestones and GitHub releases, paired by name ----
    const pubReleases = releases.filter((r: any) => !r.draft);
    const used = new Set<number>();
    const pairs: { milestone: any; release: any | null }[] = milestones.map((m: any) => {
      const t = norm(m.title);
      const rel = pubReleases.find((r: any) => !used.has(r.id) && t && norm(r.name || "").includes(t)) || null;
      if (rel) used.add(rel.id);
      return { milestone: m, release: rel };
    });
    const loneReleases = pubReleases.filter((r: any) => !used.has(r.id));
    const haveMs = new Set((haveR || []).filter((r: any) => r.github_milestone != null).map((r: any) => Number(r.github_milestone)));
    const haveRel = new Set((haveR || []).filter((r: any) => r.github_release_id != null).map((r: any) => Number(r.github_release_id)));
    const haveVer = new Set((haveR || []).filter((r: any) => r.version).map((r: any) => String(r.version)));
    const relRows: any[] = [];
    for (const { milestone: m, release: r } of pairs) {
      if (haveMs.has(m.number) || (r && haveRel.has(r.id))) continue;
      relRows.push({
        version: r && !haveVer.has(r.tag_name) ? r.tag_name : null,
        title: clip(m.title, 200),
        notes: [m.description, r?.body].filter(Boolean).join("\n\n---\n\n") || null,
        status: m.state === "open" ? "in_progress" : "published",
        target_date: m.due_on ? String(m.due_on).slice(0, 10) : null,
        published_at: r ? r.published_at : m.state === "closed" ? m.closed_at : null,
        published_by: r ? (person(r.author?.login).name || null) : null,
        published_by_id: r ? person(r.author?.login).id : null,
        github_milestone: m.number,
        github_release_id: r ? r.id : null,
        created_at: m.created_at,
      });
    }
    for (const r of loneReleases) {
      if (haveRel.has(r.id) || haveVer.has(r.tag_name)) continue;
      relRows.push({
        version: r.tag_name,
        title: clip(r.name || r.tag_name, 200),
        notes: r.body || null,
        status: "published",
        published_at: r.published_at,
        published_by: person(r.author?.login).name || null,
        published_by_id: person(r.author?.login).id,
        github_release_id: r.id,
        created_at: r.created_at,
      });
    }

    // ---- tickets ----
    const msByNumber = new Map(milestones.map((m: any) => [m.number, m]));
    const plan = issues.map((i: any) => {
      const labels = (i.labels || []).map((l: any) => lc(typeof l === "string" ? l : l.name));
      const type = (LABEL_TYPE.find(([l]) => labels.includes(l)) || [null, NO_LABEL_TYPE])[1];
      const ms: any = i.milestone ? msByNumber.get(i.milestone.number) || i.milestone : null;
      const openInShipped = i.state === "open" && ms && ms.state === "closed";
      const status = i.state === "closed"
        ? (i.state_reason === "not_planned" ? "wont_do" : "done")
        : openInShipped ? (openInClosed === "done" ? "done" : "backlog") : "backlog";
      const closedAt = i.state === "closed" ? i.closed_at : (openInShipped && status === "done" ? (ms.closed_at || ms.due_on) : null);
      const rep = person(i.user?.login);
      const asg = person((i.assignees || [])[0]?.login || i.assignee?.login);
      return {
        i, ms, openInShipped, labels,
        row: {
          id: i.number, github_number: i.number,
          title: clip(i.title, 200).trim() || `GitHub issue #${i.number}`,
          description: clip(i.body, 20000),
          type, area: null, priority: "normal", status,
          assignee_id: asg.id, assignee_name: asg.name,
          reporter_id: rep.id, reporter_name: rep.name || "GitHub",
          stores: [], source: "github_import",
          closed_at: closedAt, created_at: i.created_at, updated_at: i.updated_at,
        },
        truncated: String(i.body || "").length > 20000 || String(i.title || "").length > 200,
        unmappedLogins: [i.user?.login, ...(i.assignees || []).map((a: any) => a.login)].filter((l) => l && !who.has(lc(l))),
        extraAssignees: (i.assignees || []).slice(1).map((a: any) => a.login),
      };
    });
    const fresh = plan.filter((p) => !haveTicket.has(p.row.id));
    const issueNums = new Set(issues.map((i: any) => i.number));
    const commentPlan = ghComments
      .map((c: any) => ({ c, n: Number(String(c.issue_url || "").split("/").pop()) }))
      .filter(({ c, n }) => issueNums.has(n) && !haveComment.has(Number(c.id)) && String(c.body || "").trim());

    const report = {
      mode: apply ? "IMPORT" : "DRY RUN — nothing written",
      ran_by: me.name + (test ? " (test account)" : ""),
      open_in_closed_milestone: openInClosed || "(not chosen — previewed as backlog)",
      github: {
        issues: issues.length,
        open: issues.filter((i: any) => i.state === "open").length,
        closed: issues.filter((i: any) => i.state === "closed").length,
        prs_skipped: items.length - issues.length,
        issue_comments: commentPlan.length + ghComments.filter((c: any) => haveComment.has(Number(c.id))).length,
        milestones: milestones.length,
        releases: pubReleases.length,
        highest_issue: Math.max(0, ...issues.map((i: any) => i.number)),
      },
      already_imported: { tickets: plan.length - fresh.length, releases: (haveR || []).length },
      will_create: { tickets: fresh.length, comments: commentPlan.length, releases: relRows.length },
      tickets: {
        by_type: tally(fresh.map((p) => p.row.type)),
        by_status: tally(fresh.map((p) => p.row.status)),
        open_in_closed_milestones: fresh.filter((p) => p.openInShipped).length,
        by_label: tally(fresh.map((p) => p.labels.join("+") || "(none)")),
        by_assignee: tally(fresh.map((p) => p.row.assignee_name || "(nobody)")),
        by_reporter: tally(fresh.map((p) => p.row.reporter_name)),
        with_release: fresh.filter((p) => p.ms).length,
        extra_assignees_dropped: fresh.filter((p) => p.extraAssignees.length).map((p) => ({ id: p.row.id, dropped: p.extraAssignees })),
        truncated: fresh.filter((p) => p.truncated).map((p) => p.row.id),
        unmapped_logins: tally(fresh.flatMap((p) => p.unmappedLogins)),
      },
      releases: {
        paired: pairs.filter((p) => p.release).map((p) => `${p.milestone.title}  ⇄  ${p.release.tag_name} ${p.release.name || ""}`.trim()),
        milestone_only: pairs.filter((p) => !p.release).map((p) => `${p.milestone.title} (${p.milestone.state})`),
        release_only: loneReleases.map((r: any) => `${r.tag_name}${r.name && r.name !== r.tag_name ? " — " + r.name : ""}`),
      },
      preview: full ? fresh.map((p) => ({ sn: p.row.id, title: p.row.title, type: p.row.type, status: p.row.status, assignee: p.row.assignee_name, milestone: p.ms?.title || null })) : undefined,
    };

    if (!apply) {
      await sb.from("github_sync_log").insert({ kind: "import", event: "dry_run", ok: true, detail: { will_create: report.will_create, open_in_closed: openInClosed || null }, actor_name: me.name, actor_id: me.id });
      return json({ success: true, report });
    }

    // ---- write: releases first (tickets point at them) ----
    await chunked(sb, "dev_releases", relRows);
    const { data: rels } = await sb.from("dev_releases").select("id, github_milestone").not("github_milestone", "is", null);
    const relByMs = new Map((rels || []).map((r: any) => [Number(r.github_milestone), r.id]));
    await chunked(sb, "dev_tickets", fresh.map((p) => ({ ...p.row, release_id: p.ms ? relByMs.get(p.ms.number) ?? null : null })));

    // History: raised on GitHub (dated then), closed (dated then), imported (now, by whoever ran it).
    const events: any[] = [];
    for (const p of fresh) {
      events.push({ ticket_id: p.row.id, kind: "created", actor_name: p.row.reporter_name, actor_id: p.row.reporter_id, to_value: "backlog", note: `Raised on GitHub as #${p.row.id}`, created_at: p.i.created_at });
      if (p.row.status === "done" || p.row.status === "wont_do") {
        events.push({
          ticket_id: p.row.id, kind: "status", actor_name: "GitHub", from_value: "backlog", to_value: p.row.status,
          note: p.i.state === "closed" ? `Closed on GitHub${p.i.state_reason === "not_planned" ? " as not planned" : ""}` : `Still open on GitHub, but its update (${p.ms.title}) had shipped`,
          created_at: p.row.closed_at || p.i.updated_at,
        });
      }
      events.push({ ticket_id: p.row.id, kind: "imported", actor_name: me.name, actor_id: me.id, to_value: p.row.status, note: `Imported from GitHub issue #${p.row.id}` });
    }
    await chunked(sb, "dev_ticket_events", events);

    await chunked(sb, "dev_ticket_comments", commentPlan.map(({ c, n }) => {
      const a = person(c.user?.login);
      return {
        ticket_id: n, body: clip(c.body, 20000), author_name: a.name || "GitHub", author_id: a.id, source: "github",
        github_comment_id: c.id, created_at: c.created_at, edited_at: c.updated_at !== c.created_at ? c.updated_at : null,
      };
    }).filter((c) => haveTicket.has(c.ticket_id) || fresh.some((p) => p.row.id === c.ticket_id)));

    await sb.from("github_sync_log").insert({ kind: "import", event: "import", ok: true, detail: { created: report.will_create, open_in_closed: openInClosed }, actor_name: me.name, actor_id: me.id });
    try {
      const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      await fetch(`${Deno.env.get("SUPABASE_URL")}/realtime/v1/api/broadcast`, {
        method: "POST", headers: { "Content-Type": "application/json", apikey: k, Authorization: `Bearer ${k}` },
        body: JSON.stringify({ messages: [{ topic: "speeks-notify", event: "changed", payload: { tool: "dev-tickets", store: null, ts: Date.now() } }] }),
      });
    } catch (_) { /* best-effort */ }
    return json({ success: true, report });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from("github_sync_log").insert({ kind: "import", event: apply ? "import" : "dry_run", ok: false, detail: { error: msg }, actor_name: me.name, actor_id: me.id });
    return json({ success: false, error: msg }, 502);
  }
});
