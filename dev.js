/* ============================================================================
   THE DEVELOPMENT SUITE — dev.html's app (docs/plans/dev-tracker-HANDOFF.md).

   Nick, 2026-11-19: "the whole reason we are doing this is to have everything
   nice and simple. I want the UI to be PERFECT. Polished, snappy, fluid …"
   Nick, 2026-11-24: "I really want this UI to be SIMPLE and INTUITIVE. If its
   not easy to use and easy to look at then there's no point."

   THE PIPELINE (§6b, migration 0205, prototypes/dev-pipeline-mock.html):
     Backlog  →  a branch  →  pre-release  →  live
     - BACKLOG (left): every open ticket on no branch. New ones from Submit a
       Ticket (status triage) sit at the top.
     - BRANCHES (middle): one column per branch being built. Tickets are dragged
       onto the branch building them and ticked done as their part is finished.
     - PRE-RELEASE (right) IS THE NEXT UPDATE. When a branch merges on GitHub,
       every ticket on it lands here (github-webhook does that). Its size —
       Minor / Major / Overhaul — decides the version, worked out from the live
       one; Major and Overhaul need a title. The patch notes write themselves
       from the ticket titles.
     - LIVE: the pill in the top bar, with what shipped in each update.
   There are no tabs and no status picker: where a ticket SITS is its status.
   "Go live" is drawn but not wired — it's step 5 of §6b.

   What carried over from the Phase-3 suite: one GET brings everything and every
   filter after it is local; writes are OPTIMISTIC (the screen changes first,
   a failure puts it back and says why); the ticket side panel; keyboard
   (press ?); realtime on the 'speeks-notify' broadcast (tool 'dev-tickets').

   The rules all live on the server: dev-tickets (to_branch, branch_done,
   set_next, comments, fields — every name from the PIN) and github-webhook
   (sync, start_branch, delete_branch). Access is the dev-tracker Feature
   Access switch, enforced by both; a 403 here shows the gate, not the app.

   Plain script in an IIFE. The only global is window.Dev, for the checks
   (scripts/dev-tracker-check.js, run with -Js dev.js -Css dev.css).
   ============================================================================ */
(function () {
'use strict';

const BASE = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1';
const TICKETS_URL = `${BASE}/dev-tickets`;
const GITHUB_URL = `${BASE}/github-webhook`;
// The public anon key (the same one speeks.js carries) — realtime only.
const SB_URL = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqemFxbXl4eHJrbXh2emJqZXVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwNzA2NjAsImV4cCI6MjA5NDY0NjY2MH0.-SrbSaF-n8WkNW6tieDiA2FhGHB7qP4b6XrEyy2JF74';
const REPO_URL = 'https://github.com/SPEEKS-Technology/speeksnet';

// ---- vocabulary ------------------------------------------------------------
// Statuses stay the data model (and the history's words); the board shows
// them as places, not as a picker.
const STATUS = {
    triage:        { label: 'New',            color: 'var(--s-triage)' },
    backlog:       { label: 'Backlog',        color: 'var(--s-backlog)' },
    in_progress:   { label: 'On a Branch',    color: 'var(--s-progress)' },
    in_review:     { label: 'In Review',      color: 'var(--s-review)' },
    on_prerelease: { label: 'Pre-release',    color: 'var(--s-pre)' },
    done:          { label: 'Live',           color: 'var(--s-done)' },
    wont_do:       { label: "Won't Do",       color: 'var(--s-wont)' },
};
const OPEN = ['triage', 'backlog', 'in_progress', 'in_review'];
const CLOSED = ['done', 'wont_do'];
const PRIORITY = {
    urgent: { label: 'Urgent', rank: 0 },
    high:   { label: 'High',   rank: 1 },
    normal: { label: 'Normal', rank: 2 },
    low:    { label: 'Low',    rank: 3 },
};
const PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'];
const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL', 'CORP'];
const PREFIXES = ['feat', 'fix', 'chore'];
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
// The patch notes' headings, by ticket type, in the order they read.
const gi = (d) => `<svg class="dv-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const NOTE_GROUPS = [
    { type: 'suggestion',  label: 'New',               color: 'var(--violet)', icon: gi('<path d="M8 2.5l1.4 3.6 3.6 1.4-3.6 1.4L8 12.5 6.6 8.9 3 7.5l3.6-1.4z"/>') },
    { type: 'improvement', label: 'Improved',          color: 'var(--blue)',   icon: gi('<path d="M8 13V3.5M4 7.5l4-4 4 4"/>') },
    { type: 'bug',         label: 'Fixed',             color: 'var(--danger)', icon: gi('<path d="M3.5 8.5l3 3 6-7"/>') },
    { type: 'task',        label: 'Behind the scenes', color: 'var(--grey)',   icon: gi('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>') },
];
const typeColor = (k) => (NOTE_GROUPS.find((g) => g.type === k) || { color: 'var(--grey)' }).color;
// The notes' sections, in reading order, each with its tickets; an unknown type goes under "Other".
const noteGroups = (list) => NOTE_GROUPS.concat([{ type: null, label: 'Other', color: 'var(--grey)', icon: gi('<circle cx="8" cy="8" r="1.5"/>') }])
    .map((g) => Object.assign({}, g, { list: list.filter((t) => g.type ? t.type === g.type : !NOTE_GROUPS.some((x) => x.type === t.type)) }))
    .filter((g) => g.list.length);
const SIZES = [
    { key: 'minor',    label: 'Minor' },
    { key: 'major',    label: 'Major' },
    { key: 'overhaul', label: 'Overhaul' },
];
const STAGES = ['Backlog', 'On a branch', 'Pre-release', 'Live'];

// ---- state -----------------------------------------------------------------
const S = {
    data: null,          // the dev-tickets GET
    query: '',
    openId: null,        // the ticket in the side panel
    editingDesc: false,
    editingComment: null,
    landed: new Set(),   // ticket ids to flash once (just moved)
    fresh: new Set(),    // branches just started here, not synced yet
    titleDraft: null,    // the next update's title while it's being typed
    live: false,
    loading: false,
    syncing: false,
    gate: null,
};
const idx = { byId: new Map(), events: new Map(), comments: new Map(), links: new Map() };

// ---- small helpers ---------------------------------------------------------
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cssq = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
const pin = () => { try { return sessionStorage.getItem('speeksUserPin') || ''; } catch (_) { return ''; } };
const me = () => (S.data && S.data.me) || { id: null, name: '', test: true };
const canWrite = () => !!(S.data && S.data.me && S.data.me.id && !S.data.me.test);
const ticket = (id) => idx.byId.get(Number(id)) || null;
const tickets = () => (S.data && S.data.tickets) || [];
const labelOf = (list, key) => { const x = ((S.data && S.data[list]) || []).find((r) => r.key === key); return x ? x.label : (key || ''); };
const release = (id) => ((S.data && S.data.releases) || []).find((r) => Number(r.id) === Number(id)) || null;
const plural = (n, w, pl) => `${n} ${n === 1 ? w : (pl || w + 's')}`;

function when(ts) {
    if (!ts) return '';
    const d = new Date(ts), s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
function fullDate(ts) {
    return ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
}
const shortDate = (ts) => ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
const AVATAR = ['#3fbf7f', '#a78bfa', '#2dd4bf', '#f0a83a', '#60a5fa', '#f472b6', '#facc15'];
function initials(name) { const p = String(name || '').trim().split(/\s+/); return ((p[0] || '')[0] || '?').toUpperCase() + ((p[1] || '')[0] || '').toUpperCase(); }
function avatar(name, cls) {
    if (!name) return `<span class="dv-avatar none ${cls || ''}" title="Unassigned">–</span>`;
    let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `<span class="dv-avatar ${cls || ''}" style="background:${AVATAR[h % AVATAR.length]}" title="${esc(name)}">${esc(initials(name))}</span>`;
}
// A GitHub login → the dev it belongs to ("Eckushnir" → Ethan Kushnir), else the login.
function personFor(login) {
    const l = String(login || '').toLowerCase();
    if (!l) return '';
    const d = ((S.data && S.data.devs) || []).find((p) => String(p.name || '').toLowerCase().split(/\s+/).some((part) => part.length > 2 && l.includes(part)));
    return d ? d.name : login;
}

// ---- icons -----------------------------------------------------------------
const sv = (body, vb) => `<svg class="dv-ico" viewBox="${vb || '0 0 24 24'}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
    code: sv('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
    search: sv('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    plus: sv('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
    back: sv('<polyline points="15 18 9 12 15 6"/>'),
    x: sv('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
    link: sv('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
    copy: sv('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    branch: sv('<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
    pr: sv('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>'),
    merge: sv('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>'),
    commit: sv('<circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/>'),
    file: sv('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
    sync: sv('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
    user: sv('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    layers: sv('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
    check: sv('<polyline points="20 6 9 17 4 12"/>'),
    keyboard: sv('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
    trash: sv('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
    tag: sv('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
    calendar: sv('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
    box: sv('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>'),
    store: sv('<path d="M3 9l1-5h16l1 5"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/>'),
    external: sv('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
    inbox: sv('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
    more: `<svg class="dv-ico" viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>`,
    tick: `<svg class="dv-ico" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    dash: `<svg class="dv-ico" viewBox="0 0 16 16"><path d="M4.5 8h7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
    bang: `<svg class="dv-ico" viewBox="0 0 16 16"><path d="M8 4v5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="8" cy="12" r="1.2" fill="currentColor"/></svg>`,
    rocket: `<svg class="dv-ico" viewBox="0 0 16 16"><path d="M9.5 2.5c2.2-.6 4-.5 4-.5s.1 1.8-.5 4L9 10 6 7l3.5-4.5zM6 7L3.5 7.3 2 9.5l3 .5M9 10l-.3 2.5L6.5 14l-.5-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="10.6" cy="5.4" r="1" fill="currentColor"/></svg>`,
    chev: `<svg class="dv-ico" viewBox="0 0 16 16"><path d="M4.5 6l3.5 3.5L11.5 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    pencil: `<svg class="dv-ico" viewBox="0 0 16 16"><path d="M10.5 2.8l2.7 2.7-7.4 7.4-3.3.6.6-3.3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    collapse: `<svg class="dv-ico" viewBox="0 0 16 16"><path d="M9.5 4L5.5 8l4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    expand: `<svg class="dv-ico" viewBox="0 0 16 16"><path d="M6.5 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

// Status: a ring that fills as the work moves along — used in the history.
function stIcon(status, extra) {
    const c = (STATUS[status] || STATUS.backlog).color;
    const ring = (dash) => `<circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.6"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
    const pie = (f) => `<circle cx="7" cy="7" r="2.5" fill="none" stroke="${c}" stroke-width="5" stroke-dasharray="${(f * 15.71).toFixed(2)} 15.71" transform="rotate(-90 7 7)"/>`;
    let body;
    switch (status) {
        case 'triage':        body = ring('2.2 1.6') + `<circle cx="7" cy="7" r="1.6" fill="${c}"/>`; break;
        case 'backlog':       body = ring('1.4 2.1'); break;
        case 'in_progress':   body = ring() + pie(.5); break;
        case 'in_review':     body = ring() + pie(.75); break;
        case 'on_prerelease': body = ring() + pie(.92); break;
        case 'done':          body = `<circle cx="7" cy="7" r="6.3" fill="${c}"/><polyline points="4.4 7.2 6.2 9 9.6 5.4" fill="none" stroke="#0c0f10" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`; break;
        case 'wont_do':       body = `<circle cx="7" cy="7" r="6.3" fill="${c}"/><path d="M5 5l4 4M9 5l-4 4" stroke="#0c0f10" stroke-width="1.6" stroke-linecap="round"/>`; break;
        default:              body = ring('1.4 2.1');
    }
    return `<svg class="dv-ico dv-st ${extra || ''}" viewBox="0 0 14 14" aria-label="${esc((STATUS[status] || {}).label || status)}">${body}</svg>`;
}
function priIcon(p) {
    if (p === 'urgent') return `<svg class="dv-ico dv-pri urgent" viewBox="0 0 14 14" aria-label="Urgent"><rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor"/><path d="M7 3.8v3.9" stroke="#0c0f10" stroke-width="1.8" stroke-linecap="round"/><circle cx="7" cy="10" r="1" fill="#0c0f10"/></svg>`;
    const n = p === 'high' ? 3 : p === 'normal' ? 2 : 1;
    const bar = (i, h) => `<rect x="${1.5 + i * 4}" y="${12 - h}" width="3" height="${h}" rx="1" fill="currentColor" opacity="${i < n ? 1 : .28}"/>`;
    return `<svg class="dv-ico dv-pri" viewBox="0 0 14 14" aria-label="${esc((PRIORITY[p] || {}).label || p)}">${bar(0, 5)}${bar(1, 8)}${bar(2, 11)}</svg>`;
}

// ---- server ----------------------------------------------------------------
// The checks swap the network for a stub (Dev.stub); the page never does.
let stub = null;
async function api(url, body) {
    if (stub) return stub(url, body);
    const opts = { headers: { 'x-user-pin': pin() } };
    if (body !== undefined) {
        opts.method = 'POST';
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(body === undefined ? `${url}?v=${Date.now()}` : url, opts);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
        const err = new Error(json.error || (json.errors || [])[0] || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return json;
}
// Our own writes come back as a realtime ping too; a refetch is already on its way.
let muteUntil = 0;
const post = (payload) => { muteUntil = Date.now() + 3000; return api(TICKETS_URL, payload); };
const ghPost = (payload) => { muteUntil = Date.now() + 3000; return api(GITHUB_URL, payload); };

function setData(json) {
    S.data = json;
    idx.byId = new Map((json.tickets || []).map((t) => [Number(t.id), t]));
    const group = (rows) => {
        const m = new Map();
        for (const r of rows || []) { const k = Number(r.ticket_id); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
        return m;
    };
    idx.events = group(json.events);
    idx.comments = group(json.comments);
    idx.links = group(json.links);
    // A branch started here shows as soon as GitHub sync has it.
    for (const n of Array.from(S.fresh)) if ((json.branches || []).some((b) => b.name === n)) S.fresh.delete(n);
}

async function load(quiet) {
    if (S.loading) return;
    S.loading = true;
    try {
        const json = await api(TICKETS_URL);
        setData(json);
        S.gate = null;
        renderAll();
    } catch (e) {
        if (e.status === 401) { location.replace('index.html'); return; }
        if (e.status === 403) { S.gate = 'off'; renderGate(); return; }
        if (!S.data) { S.gate = 'error'; renderGate(e.message); }
        else if (!quiet) toast(`Couldn't refresh — ${e.message}`, { bad: true });
    } finally {
        S.loading = false;
    }
}

// ---- the pipeline, from the tickets' own columns (0205) --------------------
//   Backlog       open, on no branch
//   a branch      open, branch = its name
//   Pre-release   on_prerelease
//   Live          done
const pipe = () => (S.data && S.data.pipeline) || { live: null, next: null };
const isOpen = (t) => OPEN.includes(t.status);
function stageOf(t) {
    if (t.status === 'done') return 3;
    if (t.status === 'on_prerelease') return 2;
    if (t.status === 'wont_do') return -1;
    return t.branch ? 1 : 0;
}
// "SN-573", "#573" and "573" find the number; anything else searches the words.
function matchesQuery(t, q) {
    const n = q.replace(/^(sn-?|#)/i, '');
    if (/^\d+$/.test(n)) return String(t.id).startsWith(n) || String(t.github_number || '') === n;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = `${t.title} ${t.description || ''} ${t.reporter_name || ''} ${t.assignee_name || ''} ${t.branch || ''} ${labelOf('areas', t.area)} ${labelOf('types', t.type)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
}
const shown = (t) => !S.query.trim() || matchesQuery(t, S.query.trim());
// Tickets have no priority (Nick, 2026-11-25 — the column stays in the data,
// unused). The Backlog reads newest first; a branch reads in the order its
// tickets were raised, like a to-do list.
const newestFirst = (a, b) => Number(b.id) - Number(a.id);
const backlogTickets = () => tickets().filter((t) => isOpen(t) && !t.branch).sort(newestFirst);
const laneTickets = (name) => tickets().filter((t) => isOpen(t) && t.branch === name).sort((a, b) => Number(a.id) - Number(b.id));
const preTickets = () => tickets().filter((t) => t.status === 'on_prerelease').sort((a, b) => Number(a.id) - Number(b.id));

// The columns: every branch that isn't fully merged, every branch a ticket is
// on (merged or not — its tickets need somewhere to be), and any started here
// that sync hasn't reported yet. Newest work first; the order doesn't jump
// when a ticket moves.
function lanes() {
    const cached = ((S.data && S.data.branches) || []).filter((b) => b.kind !== 'base');
    const byName = new Map(cached.map((b) => [b.name, b]));
    // "Merged" (0193) means nothing on it that pre-release lacks — which is also
    // true of a branch started a minute ago with no commits yet. That one is
    // work about to begin, so it keeps its column until a PR of it merges.
    const names = new Set(cached.filter((b) => !b.merged || !b.pr_number).map((b) => b.name));
    for (const t of tickets()) if (isOpen(t) && t.branch) names.add(t.branch);
    for (const n of S.fresh) names.add(n);
    return Array.from(names)
        .map((n) => byName.get(n) || { name: n, kind: 'untracked', ahead: 0, behind: 0, pending: S.fresh.has(n), unknown: !S.fresh.has(n) })
        .sort((a, b) => (a.pending ? 1 : 0) - (b.pending ? 1 : 0) || String(b.last_commit_at || '').localeCompare(String(a.last_commit_at || '')) || a.name.localeCompare(b.name));
}
// Its PR merged, nothing left on it, no tickets: safe to delete (the Phase 5
// rule). A brand-new empty branch isn't offered here — it has a column, and
// its own menu can delete it.
const tidyBranches = () => ((S.data && S.data.branches) || []).filter((b) => b.kind !== 'base' && b.merged && b.pr_number && !laneTickets(b.name).length);
// 0210: merged into pre-release, not on main, and no ticket in the next update
// covers it (none on its branch, none linked to the PR) — it would ship with
// no patch note.
function untrackedMerges() {
    const pre = preTickets();
    const linked = new Set(((S.data && S.data.links) || []).filter((l) => l.kind === 'pr' && pre.some((t) => Number(t.id) === Number(l.ticket_id))).map((l) => String(l.ref)));
    return ((S.data && S.data.prerelease_prs) || []).filter((p) => !linked.has(String(p.pr_number)) && !pre.some((t) => p.head && t.branch === p.head));
}
// What shipped in a release (or in any of the rows folded into it, below).
const shippedIn = (rid) => {
    const ids = [Number(rid)].concat(((S.data && S.data.releases) || []).filter((r) => Number(r._into) === Number(rid)).map((r) => Number(r.id)));
    return tickets().filter((t) => t.status === 'done' && ids.includes(Number(t.release_id)));
};
// The history before the pipeline kept an update's NAME and its VERSION as two
// releases published moments apart ("Main November Update" holds the tickets,
// "v3.11.0" 23 seconds earlier holds the number). Shown as the one update they
// were: a version-less release folds into a versioned one within 15 minutes.
function liveReleases() {
    const pub = ((S.data && S.data.releases) || []).filter((r) => r.status === 'published' && r.published_at);
    const versioned = pub.filter((r) => /^v?\d+\.\d+/.test(String(r.version || '')));
    const out = [];
    for (const r of pub) {
        if (r.version) { out.push(r); continue; }
        const twin = versioned.find((v) => Math.abs(Date.parse(v.published_at) - Date.parse(r.published_at)) < 15 * 60000);
        if (twin) { r._into = twin.id; if (!twin.title || twin.title === twin.version) twin._name = r.title; }
        else out.push(r);
    }
    return out.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
}

// ---- render: shell ---------------------------------------------------------
function renderShell() {
    const app = $('#dvApp');
    app.removeAttribute('aria-busy');
    document.body.classList.remove('dv-booting');
    app.innerHTML = `
        <header class="dv-top">
            <div class="dv-brand"><span class="dv-brand-mark">${ICON.code}</span><span class="dv-brand-name">Development<small>SPEEKSNET</small></span></div>
            <div class="dv-grow"></div>
            <button class="dv-livepill" id="dvLivePill" data-act="live-menu" title="What's on speeksnet.com"></button>
            <label class="dv-search">${ICON.search}<input id="dvSearch" type="search" placeholder="Search tickets" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>
            <button class="dv-btn dv-btn-primary" data-act="new" id="dvNewBtn">${ICON.plus}<span>New Ticket</span></button>
            <button class="dv-icon-btn" data-act="keys" title="Keyboard shortcuts (?)">${ICON.keyboard}</button>
            <a class="dv-back" href="index.html" title="Back to SPEEKSNET">${ICON.back}<span>SPEEKSNET</span></a>
            <span class="dv-live" id="dvLive" title="Changes appear without reloading"><i></i></span>
            <button class="dv-mebtn" id="dvMe" data-act="me-menu" title="${esc(me().name)}">${avatar(me().name, 'lg dv-me')}</button>
        </header>
        <main class="dv-pipe" id="dvPipe">
            <section class="dv-col dv-backlog" id="dvBacklog" aria-label="Backlog"></section>
            <section class="dv-lanes-wrap" aria-label="Branches"><div class="dv-lanes-k" id="dvLanesK"></div><div class="dv-lanes" id="dvLanes"></div></section>
            <section class="dv-col dv-pre" id="dvPre" aria-label="Pre-release"></section>
        </main>
        <div id="dvPanelHost"></div>`;
    const search = $('#dvSearch');
    search.value = S.query;
    search.addEventListener('input', () => { S.query = search.value; renderBoard(); });
    search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { search.value = ''; S.query = ''; renderBoard(); search.blur(); e.stopPropagation(); }
        if (e.key === 'Enter') {
            // A ticket number goes straight to the ticket, wherever it is — live ones too.
            const n = S.query.trim().replace(/^(sn-?|#)/i, '');
            const t = /^\d+$/.test(n) ? (ticket(n) || tickets().find((x) => String(x.github_number || '') === n)) : null;
            if (t) { e.preventDefault(); search.blur(); open(t.id); }
        }
    });
    $('#dvLanes').addEventListener('scroll', fadeEdge, { passive: true });
    const pipeEl = $('#dvPipe');
    pipeEl.addEventListener('pointerdown', (e) => { const h = e.target.closest && e.target.closest('.dv-resize'); if (h) startResize(h.dataset.resize, e); });
    pipeEl.addEventListener('dblclick', (e) => { const h = e.target.closest && e.target.closest('.dv-resize'); if (h) resetWidth(h.dataset.resize); });
    applyLayout();
    setLive(S.live);
}
function renderAll() {
    if (!$('#dvPipe')) renderShell();
    renderBoard();
    renderPanel();
    syncHash();
}
// The three columns, keeping every scroll position where it was.
function renderBoard() {
    if (!S.data || !$('#dvPipe')) return;
    const keep = $$('[data-scroll]').map((el) => [el.dataset.scroll, el.scrollTop, el.scrollLeft]);
    renderTop();
    renderBacklog();
    renderLanes();
    renderPre();
    for (const [k, top, left] of keep) {
        const el = $(`[data-scroll="${cssq(k)}"]`);
        if (el) { el.scrollTop = top; el.scrollLeft = left; }
    }
    fadeEdge();
    S.landed.clear();
}
function renderGate(msg) {
    const app = $('#dvApp');
    document.body.classList.remove('dv-booting');
    app.removeAttribute('aria-busy');
    app.innerHTML = S.gate === 'off'
        ? `<div class="dv-gate"><h1>The development suite isn't switched on for you</h1><p>It's for the people building SPEEKSNET. Ask Nick or Ethan if you need it.</p><p><a class="dv-btn" href="index.html">${ICON.back} Back to SPEEKSNET</a></p></div>`
        : `<div class="dv-gate"><h1>Couldn't load the tracker</h1><p>${esc(msg || 'Network error')}</p><p><button class="dv-btn" data-act="retry">${ICON.sync} Try again</button></p></div>`;
}
function renderTop() {
    const pill = $('#dvLivePill');
    if (!pill) return;
    const live = pipe().live;
    pill.innerHTML = `<span class="dv-ldot"></span><span>Live</span><b>${esc(live ? live.version : '—')}</b>${ICON.chev}`;
}

// ---- render: cards ---------------------------------------------------------
function cardHtml(t, onBranch) {
    const id = Number(t.id), w = canWrite();
    const comments = (idx.comments.get(id) || []).length;
    const cls = ['dv-card', onBranch ? 'task' : '', onBranch && t.branch_done ? 'done' : '', S.landed.has(id) ? 'land' : '', S.openId === id ? 'open' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" data-id="${id}" ${w ? 'draggable="true"' : ''} tabindex="0">
        ${onBranch ? `<button class="dv-chk" data-chk="${id}" ${w ? '' : 'disabled'} aria-pressed="${!!t.branch_done}" title="${t.branch_done ? 'Done on this branch — click to undo' : 'Mark done on this branch'}">${ICON.tick}</button>` : ''}
        <div class="dv-card-main">
            <div class="dv-card-title">${esc(t.title)}</div>
            <div class="dv-card-meta">
                <span class="dv-card-id">SN-${id}</span>
                <span class="dv-ty" style="--c:${typeColor(t.type)}"><i></i>${esc(labelOf('types', t.type))}</span>
                ${comments ? `<span class="dv-card-n" title="${plural(comments, 'comment')}">${comments}</span>` : ''}
                ${(t.attachments || []).length ? `<span class="dv-card-n" title="Attachments">${ICON.file}</span>` : ''}
            </div>
        </div>
        <div class="dv-card-side">${avatar(t.assignee_name)}${w ? `<button class="dv-more" data-more="${id}" title="Move" aria-label="Move SN-${id}">${ICON.more}</button>` : ''}</div>
    </div>`;
}

// ---- render: the Backlog ---------------------------------------------------
function renderBacklog() {
    const host = $('#dvBacklog');
    if (!host) return;
    const all = backlogTickets();
    const vis = all.filter(shown);
    const fresh = vis.filter((t) => t.status === 'triage');
    const rest = vis.filter((t) => t.status !== 'triage');
    const q = S.query.trim();
    // Searching also finds what has already moved on, so an old ticket is one search away.
    const gone = q ? tickets().filter((t) => !isOpen(t) && matchesQuery(t, q)).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 12) : [];
    // Collapsed: a slim rail that still takes a dropped card (back to the Backlog).
    if (layout.collapsed) {
        host.innerHTML = `<button class="dv-rail dv-drop" data-zone="backlog" data-act="bl-expand" title="Show the Backlog ( [ )">
            ${ICON.expand}<span class="dv-count">${all.length}</span>${fresh.length ? `<span class="dv-new">${fresh.length} new</span>` : ''}<span class="dv-rail-t">Backlog</span></button>`;
        return;
    }
    host.innerHTML = `
        <div class="dv-resize" data-resize="backlog" title="Drag to resize · double-click to reset" aria-hidden="true"></div>
        <div class="dv-col-h"><div class="dv-stagek">Waiting<button class="dv-icon-btn dv-push dv-collapse" data-act="bl-collapse" title="Hide the Backlog ( [ )" aria-label="Hide the Backlog">${ICON.collapse}</button></div><div class="dv-row-h"><h2>Backlog</h2><span class="dv-count">${all.length}</span></div><p>Drag a ticket onto a branch to start it</p></div>
        <div class="dv-col-b dv-drop" data-zone="backlog" data-scroll="backlog">
            ${fresh.length ? `<div class="dv-grp"><div class="dv-grp-h"><span class="dv-new">${fresh.length} new</span>From Submit a Ticket</div>${fresh.map((t) => cardHtml(t)).join('')}</div>` : ''}
            <div class="dv-grp"><div class="dv-grp-h">Ideas and requests<span class="dv-ct">${rest.length}</span></div>
                ${rest.map((t) => cardHtml(t)).join('') || `<div class="dv-emptybox">${q ? 'No matches' : 'Nothing waiting'}</div>`}</div>
            ${gone.length ? `<div class="dv-grp"><div class="dv-grp-h">Already moved on<span class="dv-ct">${gone.length}</span></div>${gone.map((t) => `<button class="dv-found" data-open="${t.id}">${stIcon(t.status)}<span class="dv-card-id">SN-${t.id}</span><span class="dv-found-t">${esc(t.title)}</span></button>`).join('')}</div>` : ''}
        </div>`;
}

// ---- render: the branches --------------------------------------------------
function laneHtml(b) {
    const ts = laneTickets(b.name);
    const vis = ts.filter(shown);
    const done = ts.filter((t) => t.branch_done).length;
    const who = personFor(b.last_commit_author);
    const state = b.pr_state || 'open';
    const pr = b.pr_number
        ? `<a class="dv-pill ${esc(state)}" href="${esc(b.pr_url || `${REPO_URL}/pull/${b.pr_number}`)}" target="_blank" rel="noopener" title="Open the pull request on GitHub">${ICON.pr}#${b.pr_number}${state !== 'open' ? ` · ${esc(state)}` : ''}</a>`
        : `<span class="dv-pill none">No PR yet</span>`;
    const behind = Number(b.behind) || 0;
    const meta = b.pending ? '<span class="dv-pill none">Being created…</span>'
        : b.unknown ? '<span class="dv-pill none" title="Not on GitHub, or not synced yet">Not on GitHub yet</span>'
        : !b.pr_number && !Number(b.ahead) && !behind ? '<span class="dv-ahead">Nothing committed yet</span>'
        : `<span class="dv-ahead" title="Commits on this branch that pre-release doesn't have">+${Number(b.ahead) || 0}</span>${behind ? `<span class="dv-behind${behind > 25 ? ' far' : ''}" title="Commits on pre-release this branch doesn't have yet">${behind} behind</span>` : ''}`;
    return `<div class="dv-lane${S.fresh.has(b.name) ? ' fresh' : ''}" data-lane="${esc(b.name)}">
        <div class="dv-lane-h">
            <div class="dv-row-h">${ICON.branch}<span class="dv-lane-nm" title="${esc(b.name)}">${esc(b.name)}</span>${who ? avatar(who) : ''}<button class="dv-more show" data-bmore="${esc(b.name)}" title="Branch" aria-label="Branch actions">${ICON.more}</button></div>
            <div class="dv-lane-m">${pr}${b.merged && b.pr_number ? '<span class="dv-pill merged" title="Everything on it is on pre-release">Merged</span>' : ''}${meta}</div>
            <div class="dv-lane-p"><div class="dv-prog"><b style="width:${ts.length ? (done / ts.length) * 100 : 0}%"></b></div><span>${done}/${ts.length} done</span></div>
        </div>
        <div class="dv-lane-b dv-drop" data-zone="branch" data-branch="${esc(b.name)}" data-scroll="lane:${esc(b.name)}">
            ${vis.map((t) => cardHtml(t, true)).join('') || `<div class="dv-emptybox">${S.query.trim() && ts.length ? 'No matches' : 'Drag tickets here from the Backlog'}</div>`}
        </div>
        <div class="dv-lane-f"><span>${ts.length ? plural(ts.length, 'ticket') : 'No tickets yet'}</span>${b.pr_number && state === 'open' ? '<span class="dv-lane-hint">Merging the PR ships these</span>' : ''}</div>
    </div>`;
}
function renderLanes() {
    const host = $('#dvLanes');
    if (!host) return;
    const list = lanes();
    const tidy = tidyBranches();
    $('#dvLanesK').innerHTML = `<span class="dv-stagek">In progress</span><span class="dv-count">${list.length}</span>
        <span class="dv-hint">One column per branch. Drag tickets onto the branch that's building them.</span>
        ${tidy.length && canWrite() ? `<button class="dv-btn dv-btn-ghost dv-btn-sm dv-push" data-act="tidy">${ICON.trash}${plural(tidy.length, 'merged branch', 'merged branches')} to tidy</button>` : ''}
        <button class="dv-btn dv-btn-ghost dv-btn-sm${tidy.length && canWrite() ? '' : ' dv-push'}" data-act="sync" ${S.syncing ? 'disabled' : ''} title="Read branches and PRs from GitHub now">${ICON.sync}<span>${S.syncing ? 'Syncing…' : 'Sync'}</span></button>`;
    host.dataset.scroll = 'lanes';
    host.innerHTML = list.map(laneHtml).join('')
        + (canWrite() ? `<button class="dv-addlane" data-act="new-branch"><i>${ICON.plus}</i>Start a branch<small>Created on GitHub from pre-release</small></button>` : '');
}
// The right-edge fade says "more branches this way" only while there are more.
function fadeEdge() {
    const l = $('#dvLanes');
    if (!l || !l.parentElement) return;
    l.parentElement.style.setProperty('--fade', l.scrollLeft + l.clientWidth < l.scrollWidth - 4 ? 1 : 0);
}

// ---- render: pre-release, the next update ----------------------------------
function renderPre() {
    const host = $('#dvPre');
    if (!host) return;
    const p = pipe(), next = p.next, live = p.live;
    const pre = preTickets();
    const pending = untrackedMerges();
    const building = tickets().filter((t) => isOpen(t) && t.branch).length;
    const w = canWrite();
    // Keep the title box's cursor if someone is typing in it.
    const typing = document.activeElement && document.activeElement.id === 'dvNextTitle' ? document.activeElement : null;
    const caret = typing ? [typing.selectionStart, typing.selectionEnd] : null;
    let hero = '<div class="dv-emptybox">No next update yet.</div>';
    if (next) {
        const title = S.titleDraft != null ? S.titleDraft : next.title;
        const missing = next.needs_title && !String(title || '').trim();
        hero = `<div class="dv-hero">
            <div class="dv-ver"><span class="dv-ver-now">${esc(next.version)}</span>${live ? `<span class="dv-ver-from">from <s>${esc(live.version)}</s></span>` : ''}</div>
            <div class="dv-htitle" id="dvHTitle">${next.needs_title ? esc(String(title || '').trim() || 'Untitled update') : `${esc((SIZES.find((s) => s.key === next.size) || SIZES[0]).label)} update`}</div>
            <div class="dv-sizes" role="radiogroup" aria-label="Update size">${SIZES.map((s) => `<button role="radio" aria-checked="${next.size === s.key}" class="${next.size === s.key ? 'on' : ''}" data-size="${s.key}" ${w ? '' : 'disabled'}><b>${s.label}</b><span>${esc((next.versions || {})[s.key] || '')}</span></button>`).join('')}</div>
            ${next.needs_title
                ? `<div class="dv-tfield"><input id="dvNextTitle" value="${esc(title || '')}" placeholder="Name this update" maxlength="120" ${w ? '' : 'disabled'} class="${missing ? 'need' : ''}" aria-label="Update title"></div>`
                : `<div class="dv-tnote">Minor updates don't need a title.</div>`}
            <div class="dv-ready">
                <div class="${pre.length ? 'ok' : 'wait'}"><i>${pre.length ? ICON.tick : ICON.dash}</i><span>${pre.length ? `<b>${plural(pre.length, 'ticket')}</b> merged and ready` : 'No tickets merged yet'}</span></div>
                ${pending.length ? `<div class="warn"><i>${ICON.bang}</i><span><b>${plural(pending.length, 'merge')}</b> without a patch note</span></div>` : ''}
                <div class="wait"><i>${ICON.dash}</i><span>${building ? `<b>${building}</b> still on branches. They join when their branch merges.` : 'Nothing else in progress'}</span></div>
                ${missing ? `<div class="warn"><i>${ICON.bang}</i><span>A ${esc(next.size)} update needs a title</span></div>` : ''}
            </div>
            <button class="dv-btn dv-btn-primary dv-golive" disabled title="Go live is being built (step 5) — releases are made by hand until then">${ICON.rocket}Go live with ${esc(next.version)}</button>
            <div class="dv-golive-note">Go live is the next piece being built. Until then, releases are made by hand.</div>
        </div>`;
    }
    // The patch notes, drawn the way they'll read: a card per update, a line per
    // ticket under New / Improved / Fixed / Behind the scenes. Each line is its
    // ticket's title — the pencil rewords it in place. Above it, anything merged
    // with no ticket at all (0210), which would otherwise ship unannounced.
    const groups = noteGroups(pre).map((g) => Object.assign({}, g, { list: g.list.filter(shown) })).filter((g) => g.list.length);
    const title = next ? String((S.titleDraft != null ? S.titleDraft : next.title) || '').trim() : '';
    const card = groups.length ? `<div class="dv-ncard">
            <div class="dv-ncard-top"><span class="dv-ncard-k">What's new in</span><span class="dv-ncard-v">${esc(next ? next.version : '')}</span></div>
            ${next && next.needs_title && title ? `<div class="dv-ncard-t">${esc(title)}</div>` : ''}
            <div class="dv-nsums">${groups.map((g) => `<span style="--c:${g.color}"><i></i>${g.list.length} ${esc(g.label.toLowerCase())}</span>`).join('')}</div>
            ${groups.map((g) => `<section class="dv-nsec" style="--c:${g.color}"><h4><i>${g.icon}</i>${esc(g.label)}</h4>
                ${g.list.map((t) => `<div class="dv-note${S.landed.has(Number(t.id)) ? ' land' : ''}" data-open="${t.id}" role="button" tabindex="0">
                    <span class="dv-note-dot"></span>
                    <span class="dv-note-t">${esc(t.title)}<span class="dv-via">SN-${t.id}${t.branch ? ` · ${esc(t.branch)}` : ''}</span></span>
                    ${w ? `<button class="dv-reword" data-reword="${t.id}" title="Reword this line (it's the ticket's title)" aria-label="Reword SN-${t.id}">${ICON.pencil}</button>` : ''}
                </div>`).join('')}</section>`).join('')}
        </div>` : '';
    const needs = pending.length ? `<div class="dv-needs">
            <div class="dv-needs-h"><i>${ICON.bang}</i>Merged without a patch note<span class="dv-ct">${pending.length}</span></div>
            <p>On pre-release, so ${esc(next ? next.version : 'the next update')} ships ${pending.length === 1 ? 'it' : 'them'} — but nothing says what ${pending.length === 1 ? 'it does' : 'they do'} yet.</p>
            ${pending.map((p) => `<div class="dv-need">
                <div class="dv-need-main"><a class="dv-need-t" href="${esc(p.url || `${REPO_URL}/pull/${p.pr_number}`)}" target="_blank" rel="noopener">${esc(p.title)}</a>
                    <span class="dv-via">PR #${p.pr_number}${p.head ? ` · ${esc(p.head)}` : ''} · merged ${esc(when(p.merged_at))}${/^\d+[mhd]$/.test(when(p.merged_at)) ? ' ago' : ''}</span></div>
                ${w ? `<button class="dv-btn dv-btn-sm" data-note-pr="${p.pr_number}">${ICON.pencil}Write the note</button>` : ''}
            </div>`).join('')}
        </div>` : '';
    host.innerHTML = `
        <div class="dv-resize" data-resize="pre" title="Drag to resize · double-click to reset" aria-hidden="true"></div>
        <div class="dv-col-h"><div class="dv-stagek"><i></i>Next update</div><div class="dv-row-h"><h2>Pre-release</h2><span class="dv-count">${pre.length + pending.length}</span></div><p>Everything merged here ships in the next update</p></div>
        <div class="dv-col-b" data-scroll="pre">
            ${hero}
            <div class="dv-notes-h">Patch notes<span class="dv-auto">Written automatically</span>${groups.length ? `<button class="dv-icon-btn dv-push" data-act="copy-notes" title="Copy the patch notes as text">${ICON.copy}</button>` : ''}</div>
            ${needs}
            ${card || (needs ? '' : '<div class="dv-emptybox">When a branch merges, its tickets show up here.</div>')}
        </div>`;
    if (typing) { const i = $('#dvNextTitle'); if (i) { i.focus(); try { i.setSelectionRange(caret[0], caret[1]); } catch (_) {} } }
}

// ---- render: the side panel -----------------------------------------------
function open(id) {
    const t = ticket(id);
    if (!t) return;
    if (S.openId !== Number(id)) { S.editingDesc = false; S.editingComment = null; }
    S.openId = Number(id);
    $$('.dv-card.open').forEach((c) => c.classList.remove('open'));
    const card = $(`.dv-card[data-id="${Number(id)}"]`);
    if (card) card.classList.add('open');
    renderPanel();
    syncHash();
}
function closePanel() {
    if (S.openId == null) return;
    S.openId = null; S.editingDesc = false;
    $$('.dv-card.open').forEach((c) => c.classList.remove('open'));
    renderPanel();
    syncHash();
}
function eventText(e) {
    const st = (k) => `<b>${esc((STATUS[k] || { label: k }).label)}</b>`;
    switch (e.kind) {
        case 'created':  return 'created the ticket';
        case 'imported': return 'imported it from GitHub';
        case 'edited':   return `changed ${esc(e.note || 'it')}`;
        case 'status':   return `moved it to ${st(e.to_value)}`;
        case 'assigned': return e.to_value ? `assigned it to <b>${esc(e.to_value)}</b>` : 'unassigned it';
        case 'release': { const r = release(e.to_value); return r ? `put it in <b>${esc(r.version || r.title)}</b>` : 'took it out of its release'; }
        case 'branch':   return e.to_value ? `put it on <b class="dv-mono">${esc(e.to_value)}</b>` : `took it off <b class="dv-mono">${esc(e.from_value || 'its branch')}</b>`;
        case 'branch_done': return e.to_value === 'done' ? 'marked it done on its branch' : 'marked it not done';
        case 'linked':   return `linked ${({ pr: 'a pull request', branch: 'a branch', commit: 'a commit' })[e.to_value] || 'code'}`;
        case 'unlinked': return `unlinked ${esc(e.from_value || 'code')}`;
        default:         return esc(e.kind);
    }
}
function prop(key, label, value, editable) {
    return `<dt>${label}</dt><dd><button class="dv-prop" data-pick="${key}" ${editable ? '' : 'disabled'}>${value}</button></dd>`;
}
// Where the ticket is in the pipeline, in words, with the one thing to do about it.
function whereHtml(t) {
    const w = canWrite();
    const next = pipe().next;
    const rel = release(t.release_id);
    const st = stageOf(t);
    let where;
    if (st === 0) where = `<span>Backlog${t.status === 'triage' ? ' <span class="dv-muted">· new from Submit a Ticket</span>' : ''}</span>`;
    else if (st === 1) where = `${ICON.branch}<span class="dv-mono">${esc(t.branch)}</span>${t.branch_done ? `<span class="dv-done-tag">${ICON.tick}Done</span>` : ''}`;
    else if (st === 2) where = `<span>Pre-release — ships in <b class="dv-mono">${esc(next ? next.version : 'the next update')}</b></span>`;
    else if (st === 3) {
        // An old name-only release reads as the version it was published with.
        if (rel && !rel.version) liveReleases();
        const shown = rel && rel._into ? (release(rel._into) || rel) : rel;
        where = `<span>Live in <b class="dv-mono">${esc(shown ? (shown.version || shown.title) : 'an update')}</b>${shown && shown.published_at ? ` <span class="dv-muted">· ${esc(shortDate(shown.published_at))}</span>` : ''}</span>`;
    }
    else where = `<span>Won't do</span>`;
    const canMove = w && (isOpen(t) || t.status === 'wont_do');
    return `<dt>Where</dt><dd class="dv-where">${where}${canMove ? `<button class="dv-btn dv-btn-sm" data-act="move">${st === 0 ? 'Put on a branch…' : 'Move…'}</button>` : ''}</dd>`;
}
function codeHtml(t) {
    const order = { pr: 0, branch: 1, commit: 2 };
    const links = (idx.links.get(Number(t.id)) || []).slice().sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || String(b.ref).localeCompare(String(a.ref)));
    const items = links.map((l) => {
        if (l.kind === 'pr') {
            const checks = Array.isArray(l.checks) ? l.checks : [];
            const mark = { ok: '✓', todo: '•', warn: '!', error: '✕' };
            return `<div class="dv-code-item">
                <div class="dv-code-line">${ICON.pr}<a href="${esc(l.url || '#')}" target="_blank" rel="noopener">#${esc(l.ref)} ${esc(l.title || '')}</a>${l.state ? `<span class="dv-pill ${esc(l.state)}">${esc(l.state[0].toUpperCase() + l.state.slice(1))}</span>` : ''}</div>
                ${l.base ? `<div class="dv-code-sub">into <span class="dv-mono">${esc(l.base)}</span>${l.author ? ` · ${esc(l.author)}` : ''}${l.merged_at ? ` · merged ${esc(when(l.merged_at))}` : ''}</div>` : ''}
                ${checks.length ? `<ul class="dv-checks">${checks.map((c) => `<li class="dv-check ${esc(c.level || 'todo')}"><b>${mark[c.level] || '•'}</b><span>${esc(c.text || '')}</span></li>`).join('')}</ul>` : ''}
            </div>`;
        }
        if (l.kind === 'branch') {
            return `<div class="dv-code-item"><div class="dv-code-line">${ICON.branch}<a class="dv-mono" href="${esc(l.url || '#')}" target="_blank" rel="noopener">${esc(l.ref)}</a>${l.state === 'deleted' ? '<span class="dv-pill deleted">Deleted</span>' : ''}
                ${l.state !== 'deleted' ? `<button class="dv-icon-btn" data-copy="git fetch origin &amp;&amp; git switch ${esc(l.ref)}" title="Copy the git command to check it out" style="margin-left:auto">${ICON.copy}</button>` : ''}</div></div>`;
        }
        return `<div class="dv-code-item"><div class="dv-code-line">${ICON.commit}<span class="dv-mono dv-muted">${esc(String(l.ref || '').slice(0, 7))}</span><a href="${esc(l.url || '#')}" target="_blank" rel="noopener">${esc(l.title || l.ref)}</a></div></div>`;
    }).join('');
    return `<div class="dv-sec">
        <div class="dv-sec-head"><h3>Code</h3></div>
        ${items ? `<div class="dv-code">${items}</div>` : `<div class="dv-muted" style="font-size:12px">Nothing linked yet. Put SN-${t.id} in a commit message or a PR and it appears here.</div>`}
    </div>`;
}
function activityHtml(t) {
    const events = (idx.events.get(Number(t.id)) || []).map((e) => ({ at: e.created_at, e }));
    const comments = (idx.comments.get(Number(t.id)) || []).map((c) => ({ at: c.created_at, c }));
    const all = events.concat(comments).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const items = all.map((x) => {
        if (x.e) {
            const e = x.e;
            const dot = e.kind === 'status' ? stIcon(e.to_value) : '<i></i>';
            return `<li class="dv-ev"><span class="dv-ev-dot">${dot}</span><span><b>${esc(e.actor_name)}</b> ${eventText(e)}<span class="dv-ev-when" title="${esc(fullDate(e.created_at))}">${esc(when(e.created_at))}</span>
                ${e.note && !['edited', 'branch', 'branch_done'].includes(e.kind) ? `<span class="dv-ev-note">${esc(e.note)}</span>` : ''}</span></li>`;
        }
        const c = x.c;
        const mine = c.source === 'speeksnet' && me().id && String(c.author_id || '') === String(me().id) && canWrite();
        const body = S.editingComment === Number(c.id)
            ? `<textarea class="dv-desc-edit" id="dvCommentEdit" style="min-height:70px">${esc(c.body)}</textarea>
               <div class="dv-desc-actions"><button class="dv-btn dv-btn-ghost dv-btn-sm" data-act="comment-cancel">Cancel</button><button class="dv-btn dv-btn-primary dv-btn-sm" data-act="comment-save" data-cid="${c.id}">Save</button></div>`
            : `<div class="dv-comment-body">${esc(c.body)}</div>`;
        return `<li class="dv-comment"><span class="dv-ev-dot" style="padding-top:8px">${avatar(c.author_name)}</span><div class="dv-comment-box">
            <div class="dv-comment-head"><b>${esc(c.author_name)}</b><span title="${esc(fullDate(c.created_at))}">${esc(when(c.created_at))}${c.edited_at ? ' · edited' : ''}${c.source === 'github' ? ' · on GitHub' : ''}</span>
            ${mine && S.editingComment !== Number(c.id) ? `<button class="dv-btn dv-btn-ghost dv-btn-sm" data-act="comment-edit" data-cid="${c.id}">Edit</button>` : ''}</div>${body}</div></li>`;
    }).join('');
    return `<div class="dv-sec"><div class="dv-sec-head"><h3>Activity</h3></div>
        <ul class="dv-activity">${items}</ul>
        ${canWrite() ? `<div class="dv-composer"><textarea id="dvComposer" placeholder="Leave a comment…" rows="2"></textarea>
            <div class="dv-composer-foot"><span><kbd>Ctrl</kbd> <kbd>Enter</kbd> to send</span><button class="dv-btn dv-btn-primary dv-btn-sm" data-act="comment">Comment</button></div></div>` : ''}
    </div>`;
}
function renderPanel() {
    const host = $('#dvPanelHost');
    if (!host) return;
    const t = S.openId != null ? ticket(S.openId) : null;
    if (!t) { host.innerHTML = ''; if (S.openId != null) S.openId = null; return; }
    const w = canWrite();
    const st = stageOf(t);
    const why = t.status === 'wont_do' ? ((idx.events.get(Number(t.id)) || []).filter((e) => e.kind === 'status' && e.to_value === 'wont_do').pop() || {}).note : '';
    const files = (t.attachments || []).length ? `<div class="dv-sec"><div class="dv-sec-head"><h3>Attachments</h3></div><div class="dv-files">${t.attachments.map((a) => a.url
        ? `<a class="dv-file" href="${esc(a.url)}" target="_blank" rel="noopener">${ICON.file}<span>${esc(a.name || 'attachment')}</span></a>`
        : `<span class="dv-file" title="The link expired — reload">${ICON.file}<span>${esc(a.name || 'attachment')}</span></span>`).join('')}</div></div>` : '';
    const desc = S.editingDesc
        ? `<textarea class="dv-desc-edit" id="dvDescEdit" placeholder="What's wrong, what's wanted, how to tell it's done.">${esc(t.description || '')}</textarea>
           <div class="dv-desc-actions"><span class="dv-muted" style="margin-right:auto;font-size:11.5px"><kbd>Ctrl</kbd> <kbd>Enter</kbd> to save</span><button class="dv-btn dv-btn-ghost dv-btn-sm" data-act="desc-cancel">Cancel</button><button class="dv-btn dv-btn-primary dv-btn-sm" data-act="desc-save">Save</button></div>`
        : `<div class="dv-desc${t.description ? '' : ' placeholder'}${w ? ' dv-editable' : ''}" ${w ? 'data-act="desc-edit" title="Click to edit"' : ''}>${t.description ? esc(t.description) : (w ? 'Add a description…' : 'No description.')}</div>`;
    host.innerHTML = `<aside class="dv-panel" aria-label="SN-${t.id}">
        <div class="dv-panel-top">
            <span class="dv-panel-id"><b>SN-${t.id}</b>${t.github_number ? `<span>· was #${t.github_number}</span>` : ''}${t.source === 'idea' ? '<span>· from Submit a Ticket</span>' : ''}</span>
            <button class="dv-icon-btn dv-push" data-act="copy-link" title="Copy a link to this ticket">${ICON.link}</button>
            ${t.github_number ? `<a class="dv-icon-btn" href="${REPO_URL}/issues/${t.github_number}" target="_blank" rel="noopener" title="The old GitHub issue">${ICON.external}</a>` : ''}
            <button class="dv-icon-btn" data-act="close" title="Close (Esc)">${ICON.x}</button>
        </div>
        <div class="dv-panel-body">
            ${me().test ? `<div style="margin-bottom:12px"><span class="dv-readonly">Read-only — test account</span></div>` : ''}
            ${st >= 0 ? `<div class="dv-stepper" aria-label="Where it is">${STAGES.map((s, i) => `<div class="${i < st ? 'past' : i === st ? 'cur' : ''}">${s}</div>`).join('')}</div>` : ''}
            ${why ? `<div class="dv-callout no"><b>Won't do:</b> ${esc(why)}</div>` : ''}
            <h2 class="dv-title${w ? ' dv-editable' : ''}" id="dvTitle" ${w ? 'contenteditable="plaintext-only" spellcheck="true"' : ''}>${esc(t.title)}</h2>
            ${desc}
            <dl class="dv-props">
                ${whereHtml(t)}
                ${prop('assignee', 'Assignee', `${avatar(t.assignee_name)}<span class="${t.assignee_name ? '' : 'placeholder'}">${esc(t.assignee_name || 'Unassigned')}</span>`, w)}
                ${prop('type', 'Type', `<span class="dv-ty" style="--c:${typeColor(t.type)}"><i></i></span><span>${esc(labelOf('types', t.type))}</span>`, w)}
                ${prop('area', 'Area', `${ICON.box}<span class="${t.area ? '' : 'placeholder'}">${esc(t.area ? labelOf('areas', t.area) : 'No area')}</span>`, w)}
                ${prop('due', 'Due', `${ICON.calendar}<span class="${t.due ? '' : 'placeholder'}">${esc(t.due ? new Date(t.due + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'No due date')}</span>`, w)}
                ${prop('stores', 'Stores', `${ICON.store}<span class="${(t.stores || []).length ? '' : 'placeholder'}">${esc((t.stores || []).length ? t.stores.join(', ') : 'None')}</span>`, w)}
                <dt>Reporter</dt><dd><span class="dv-prop" style="cursor:default">${avatar(t.reporter_name)}<span>${esc(t.reporter_name || '')}${t.reporter_store ? ` · ${esc(t.reporter_store)}` : ''}</span></span></dd>
                <dt>Created</dt><dd><span class="dv-prop" style="cursor:default"><span title="${esc(fullDate(t.created_at))}">${esc(fullDate(t.created_at))}</span></span></dd>
            </dl>
            ${files}
            ${codeHtml(t)}
            ${activityHtml(t)}
        </div>
    </aside>`;
    const title = $('#dvTitle');
    if (title && w) {
        title.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
            if (e.key === 'Escape') { e.stopPropagation(); title.textContent = t.title; title.blur(); }
        });
        title.addEventListener('blur', () => saveTitle(t, title.textContent));
    }
    const descEdit = $('#dvDescEdit');
    if (descEdit) { descEdit.focus(); descEdit.setSelectionRange(descEdit.value.length, descEdit.value.length); }
}

// ---- popovers ----------------------------------------------------------------
let pop = null;   // { el }
function closePop() { if (pop) { pop.el.remove(); pop = null; } }
// Against the VISIBLE width (clientWidth): innerWidth counts a scrollbar, and a
// menu placed by it can end up underneath one.
function place(el, anchor) {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    const vw = document.documentElement.clientWidth || innerWidth, vh = document.documentElement.clientHeight || innerHeight;
    let left = Math.min(r.left, vw - w - 8), top = r.bottom + 6;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
    el.style.left = Math.max(8, left) + 'px';
    el.style.top = top + 'px';
}
// A searchable list. items: [{value, label, html, hint, section}]; current: value or [values] (multi).
function picker(anchor, { items, current, onPick, multi, placeholder }) {
    closePop();
    const el = document.createElement('div');
    el.className = 'dv-pop';
    el.setAttribute('role', 'listbox');
    el.innerHTML = `<input class="dv-pop-search" placeholder="${esc(placeholder || 'Filter…')}" spellcheck="false"><div class="dv-pop-list"></div>`;
    $('#dvLayer').appendChild(el);
    const input = $('.dv-pop-search', el), listEl = $('.dv-pop-list', el);
    let act = 0, list = items;
    const isOn = (v) => multi ? (current || []).includes(v) : current === v;
    const draw = () => {
        const q = input.value.trim().toLowerCase();
        list = items.filter((i) => !q || String(i.label).toLowerCase().includes(q) || String(i.hint || '').toLowerCase().includes(q));
        act = Math.min(act, Math.max(0, list.length - 1));
        let lastSection = null;
        listEl.innerHTML = list.length ? list.map((i, n) => {
            const head = i.section && i.section !== lastSection ? `<div class="dv-pop-lbl">${esc(i.section)}</div>` : '';
            lastSection = i.section || lastSection;
            return `${head}<button class="dv-opt${n === act ? ' act' : ''}${i.danger ? ' danger' : ''}" data-n="${n}">${i.html || ''}<span class="${i.mono ? 'dv-mono' : ''}">${esc(i.label)}</span>${isOn(i.value) ? `<svg class="dv-opt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="20 6 9 17 4 12"/></svg>` : i.hint ? `<small>${esc(i.hint)}</small>` : ''}</button>`;
        }).join('') : `<div class="dv-pop-empty">No matches</div>`;
    };
    const choose = (n) => {
        const i = list[n];
        if (!i) return;
        if (multi) {
            current = isOn(i.value) ? current.filter((v) => v !== i.value) : current.concat([i.value]);
            onPick(current.slice(), i);
            draw();
        } else { closePop(); onPick(i.value, i); }
    };
    draw();
    place(el, anchor);
    input.focus();
    input.addEventListener('input', () => { act = 0; draw(); });
    listEl.addEventListener('mousemove', (e) => { const b = e.target.closest('.dv-opt'); if (b && Number(b.dataset.n) !== act) { act = Number(b.dataset.n); $$('.dv-opt', listEl).forEach((o) => o.classList.toggle('act', Number(o.dataset.n) === act)); } });
    listEl.addEventListener('click', (e) => { const b = e.target.closest('.dv-opt'); if (b) choose(Number(b.dataset.n)); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); act = Math.min(list.length - 1, act + 1); draw(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); act = Math.max(0, act - 1); draw(); }
        else if (e.key === 'Enter') { e.preventDefault(); choose(act); }
        else if (e.key === 'Escape' || (e.key === 'Tab')) { e.preventDefault(); e.stopPropagation(); closePop(); }
    });
    pop = { el };
    return el;
}
// A plain menu (no search): html made of .dv-opt buttons / links and .dv-pop-lbl labels.
function menu(anchor, html, cls) {
    closePop();
    const el = document.createElement('div');
    el.className = `dv-pop dv-menu ${cls || ''}`;
    el.innerHTML = `<div class="dv-pop-list">${html}</div>`;
    $('#dvLayer').appendChild(el);
    place(el, anchor);
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); } });
    pop = { el };
    return el;
}
// A tiny form popover (Won't do reason, due date).
function formPop(anchor, html, onReady) {
    closePop();
    const el = document.createElement('div');
    el.className = 'dv-pop';
    el.style.minWidth = '280px';
    el.innerHTML = `<div class="dv-pop-form">${html}</div>`;
    $('#dvLayer').appendChild(el);
    place(el, anchor);
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); } });
    pop = { el };
    onReady(el);
    return el;
}

// ---- modals: new ticket, new branch, confirm, shortcuts ---------------------
let modal = null;
function closeModal() { if (modal) { modal.remove(); modal = null; } }
function openModal(html, cls) {
    closePop(); closeModal();
    const scrim = document.createElement('div');
    scrim.className = 'dv-scrim';
    scrim.innerHTML = `<div class="dv-modal ${cls || ''}" role="dialog" aria-modal="true">${html}</div>`;
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeModal(); });
    $('#dvLayer').appendChild(scrim);
    modal = scrim;
    return scrim;
}
function confirmDialog({ title, body, ok, danger }) {
    return new Promise((resolve) => {
        const m = openModal(`<div class="dv-modal-body"><h2>${esc(title)}</h2><p>${body}</p></div>
            <div class="dv-modal-foot"><button class="dv-btn dv-btn-ghost" data-no>Cancel</button><button class="dv-btn ${danger ? 'dv-btn-danger' : 'dv-btn-primary'}" data-yes>${esc(ok || 'OK')}</button></div>`, 'dv-confirm');
        const done = (v) => { closeModal(); resolve(v); };
        $('[data-yes]', m).addEventListener('click', () => done(true));
        $('[data-no]', m).addEventListener('click', () => done(false));
        m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } if (e.key === 'Enter') { e.preventDefault(); done(true); } });
        $('[data-yes]', m).focus();
    });
}
function shortcuts() {
    const rows = [
        ['Search', ['/']], ['New ticket', ['C']], ['Start a branch', ['B']], ['Close', ['Esc']],
        ['Assignee (ticket open)', ['A']], ['Move (ticket open)', ['M']], ['Hide / show the Backlog', ['[']], ['Send comment', ['Ctrl', 'Enter']],
    ];
    openModal(`<div class="dv-modal-top">Keyboard shortcuts<button class="dv-icon-btn" data-act="modal-close">${ICON.x}</button></div>
        <div class="dv-modal-body">${rows.map(([l, k]) => `<div class="dv-key"><span>${l}</span><span>${k.map((x) => `<kbd>${x}</kbd>`).join('')}</span></div>`).join('')}
        <p class="dv-keys-tip">Drag a ticket onto a branch to start it, or back to the Backlog to put it off.</p></div>`, 'dv-keys');
}

const draft = { type: 'task', area: '', assignee_id: '', branch: '', prerelease: false };
// newTicket()            a new ticket in the Backlog
// newTicket('feat/x')    …straight onto that branch
// newTicket({ pr })      the patch note for a PR already merged into pre-release
//                        with no ticket (0210): made straight into the next update
function newTicket(arg) {
    if (!canWrite()) { toast('Test accounts can only read.', { bad: true }); return; }
    const types = (S.data.types || []).filter((t) => t.active !== false);
    if (!types.some((t) => t.key === draft.type)) draft.type = (types[0] || {}).key || 'task';
    const pr = arg && typeof arg === 'object' ? arg.pr : null;
    draft.branch = pr ? (pr.head || '') : typeof arg === 'string' ? arg : '';
    draft.prerelease = !!pr;
    const m = openModal(`<div class="dv-modal-top">${pr ? `${ICON.merge}Patch note for PR #${pr.pr_number}` : `${ICON.plus}New ticket`}<button class="dv-icon-btn" data-act="modal-close" title="Close (Esc)">${ICON.x}</button></div>
        <div class="dv-modal-body">
            <input class="dv-new-title" id="dvNewTitle" placeholder="${pr ? 'What changed, for a store manager' : 'Ticket title'}" maxlength="200" autocomplete="off" value="${pr ? esc(pr.title) : ''}">
            <div class="dv-new-hint">${pr
                ? `Already merged into pre-release${pr.head ? ` from <span class="dv-mono">${esc(pr.head)}</span>` : ''}. This goes straight into the next update's patch notes — reword the PR's title for a store manager.`
                : 'The title becomes the patch note, word for word — write it for a store manager.'}</div>
            <textarea class="dv-new-desc" id="dvNewDesc" placeholder="Add a description…"></textarea>
        </div>
        <div class="dv-new-props" id="dvNewProps"></div>
        <div class="dv-modal-foot"><span><kbd>Ctrl</kbd> <kbd>Enter</kbd> to create</span>
            <button class="dv-btn dv-btn-ghost" data-act="modal-close">Cancel</button>
            <button class="dv-btn dv-btn-primary" data-act="new-create" id="dvNewCreate">Create ticket</button></div>`);
    drawDraftProps();
    const title = $('#dvNewTitle', m), desc = $('#dvNewDesc', m);
    title.focus();
    if (pr) title.select();
    const grow = () => { desc.style.height = 'auto'; desc.style.height = Math.min(desc.scrollHeight, innerHeight * .4) + 'px'; };
    desc.addEventListener('input', grow);
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); desc.focus(); } });
    m.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); createTicket(); }
        if (e.key === 'Escape' && !pop) { e.stopPropagation(); closeModal(); }
    });
}
function drawDraftProps() {
    const host = $('#dvNewProps');
    if (!host) return;
    const dev = (S.data.devs || []).find((d) => d.id === draft.assignee_id);
    host.innerHTML = `
        ${draft.prerelease
            ? `<span class="dv-chipsel dv-chip-pre">${ICON.merge}<span>Next update</span></span>`
            : `<button class="dv-chipsel" data-npick="branch">${draft.branch ? ICON.branch : ICON.inbox}<span class="${draft.branch ? 'dv-mono' : ''}">${esc(draft.branch || 'Backlog')}</span></button>`}
        <button class="dv-chipsel" data-npick="type"><span class="dv-ty" style="--c:${typeColor(draft.type)}"><i></i></span>${esc(labelOf('types', draft.type))}</button>
        <button class="dv-chipsel" data-npick="area">${ICON.box}${esc(draft.area ? labelOf('areas', draft.area) : 'Area')}</button>
        <button class="dv-chipsel" data-npick="assignee">${dev ? avatar(dev.name) : ICON.user}${esc(dev ? dev.name : 'Assignee')}</button>`;
}
async function createTicket() {
    const title = ($('#dvNewTitle') || {}).value || '';
    if (!title.trim()) { $('#dvNewTitle').focus(); toast('Give it a title first.', { bad: true }); return; }
    const btn = $('#dvNewCreate');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
        const r = await post({ action: 'create', title: title.trim(), description: $('#dvNewDesc').value, type: draft.type, area: draft.area || null,
            assignee_id: draft.assignee_id || null, branch: draft.branch || null, stores: [], ...(draft.prerelease ? { prerelease: true } : {}) });
        closeModal();
        const wasNote = draft.prerelease;
        Object.assign(draft, { area: '', assignee_id: '', branch: '', prerelease: false });
        if (r.ticket) S.landed.add(Number(r.ticket.id));
        await load(true);
        toast(wasNote ? `SN-${r.ticket && r.ticket.id} added to the patch notes`
            : `Created SN-${r.ticket && r.ticket.id}${r.ticket && r.ticket.branch ? ` on ${r.ticket.branch}` : ''}`);
    } catch (e) {
        btn.disabled = false; btn.textContent = 'Create ticket';
        toast(`Couldn't create it — ${e.message}`, { bad: true });
    }
}

// Start a branch: SPEEKSNET makes it on GitHub from pre-release (github-webhook
// start_branch), named for the work — one branch can carry several tickets.
function newBranch(withIds) {
    if (!canWrite()) { toast('Test accounts can only read.', { bad: true }); return; }
    const ids = (withIds || []).filter((id) => ticket(id) && isOpen(ticket(id)));
    const first = ids.length ? ticket(ids[0]) : null;
    const prefix = first && first.type === 'bug' ? 'fix' : first && first.type === 'task' ? 'chore' : 'feat';
    const m = openModal(`<div class="dv-modal-top">${ICON.branch}Start a branch<button class="dv-icon-btn" data-act="modal-close" title="Close (Esc)">${ICON.x}</button></div>
        <div class="dv-modal-body dv-branch-form">
            <p>Created on GitHub from <span class="dv-mono">pre-release</span>, as a new column. Name it for the work, not a ticket — one branch can carry several.</p>
            <div class="dv-inrow">
                <select id="dvBrPrefix" class="dv-input" aria-label="Kind">${PREFIXES.map((p) => `<option value="${p}"${p === prefix ? ' selected' : ''}>${p}/</option>`).join('')}</select>
                <input id="dvBrSlug" class="dv-input" placeholder="what-it-does" spellcheck="false" autocomplete="off" value="${esc(first ? slugify(first.title) : '')}" aria-label="Branch name">
            </div>
            <div class="dv-branch-preview" id="dvBrPreview"></div>
            ${ids.length ? `<div class="dv-br-tickets">Starts with ${ids.map((id) => `<span class="dv-tag">SN-${id}</span>`).join(' ')}</div>` : ''}
        </div>
        <div class="dv-modal-foot"><span><kbd>Enter</kbd> to create</span>
            <button class="dv-btn dv-btn-ghost" data-act="modal-close">Cancel</button>
            <button class="dv-btn dv-btn-primary" id="dvBrGo">${ICON.branch}Create branch</button></div>`, 'dv-confirm');
    const slug = $('#dvBrSlug', m), pre = $('#dvBrPrefix', m), out = $('#dvBrPreview', m);
    const name = () => `${pre.value}/${slugify(slug.value)}`;
    const draw = () => { out.textContent = slugify(slug.value) ? name() : `${pre.value}/…`; };
    draw();
    slug.addEventListener('input', draw);
    pre.addEventListener('change', draw);
    slug.focus(); slug.select();
    const go = async () => {
        if (!slugify(slug.value)) { slug.focus(); return; }
        const btn = $('#dvBrGo', m);
        btn.disabled = true; btn.textContent = 'Creating…';
        try {
            const r = await ghPost({ action: 'start_branch', prefix: pre.value, slug: slugify(slug.value), ticket_ids: ids });
            closeModal();
            S.fresh.add(r.branch);
            ids.forEach((id) => S.landed.add(Number(id)));
            await load(true);
            const lane = $(`.dv-lane[data-lane="${cssq(r.branch)}"]`);
            if (lane) lane.scrollIntoView({ behavior: 'smooth', inline: 'end', block: 'nearest' });
            toast(`Created ${r.branch}`, { action: { label: 'Copy git command', fn: () => copy(`git fetch origin && git switch ${r.branch}`, 'Command copied') } });
        } catch (e) {
            btn.disabled = false; btn.innerHTML = `${ICON.branch}Create branch`;
            toast(e.message, { bad: true });
        }
    };
    $('#dvBrGo', m).addEventListener('click', go);
    m.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); go(); }
        if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
    });
}

// ---- toasts ----------------------------------------------------------------
function toast(msg, opts) {
    const o = opts || {};
    const host = $('#dvToasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `dv-toast${o.bad ? ' bad' : ''}`;
    el.innerHTML = `<i></i><span>${esc(msg)}</span>${o.action ? `<a href="#" data-toast-act>${esc(o.action.label)}</a>` : ''}`;
    if (o.action) $('[data-toast-act]', el).addEventListener('click', (e) => { e.preventDefault(); o.action.fn(); el.remove(); });
    host.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, o.bad ? 5200 : 3200);
}
async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(`${what || 'Copied'} to the clipboard`); }
    catch (_) { toast("Couldn't reach the clipboard", { bad: true }); }
}

// ---- writes: optimistic, then confirmed ---------------------------------
function redraw() { renderBoard(); renderPanel(); }
async function optimistic(t, patch, payload, okMsg) {
    const before = {};
    for (const k of Object.keys(patch)) before[k] = t[k];
    Object.assign(t, patch, { updated_at: new Date().toISOString() });
    redraw();
    try {
        const r = await post(payload);
        const row = r.ticket || (r.tickets || []).find((x) => Number(x.id) === Number(t.id));
        if (row) Object.assign(t, row, { assignee_name: row.assignee_name ?? t.assignee_name });
        if (okMsg) toast(okMsg);
        load(true);   // events, history
    } catch (e) {
        Object.assign(t, before);
        redraw();
        toast(`Not saved — ${e.message}`, { bad: true });
    }
}
function saveTitle(t, text) {
    const v = String(text || '').replace(/\s+/g, ' ').trim();
    if (!v) { renderPanel(); return; }
    if (v === t.title) return;
    optimistic(t, { title: v }, { action: 'edit', id: t.id, title: v });
}
function setStatus(t, to, note, okMsg) {
    if (to === t.status) return;
    const patch = { status: to, closed_at: CLOSED.includes(to) ? new Date().toISOString() : null };
    if (['triage', 'backlog', 'wont_do'].includes(to)) Object.assign(patch, { branch: null, branch_done: false });
    optimistic(t, patch, { action: 'status', id: t.id, to, note: note || null }, okMsg);
}
// Onto a branch (or back to the Backlog with null) — the pipeline's one move.
function moveTicket(t, branch) {
    if (!t || !isOpen(t) || (t.branch || null) === (branch || null)) return;
    S.landed.add(Number(t.id));
    const status = branch ? (['triage', 'backlog'].includes(t.status) ? 'in_progress' : t.status) : 'backlog';
    optimistic(t, { branch: branch || null, branch_done: false, status }, { action: 'to_branch', ids: [t.id], branch: branch || null },
        `SN-${t.id} → ${branch || 'Backlog'}`);
}
function toggleDone(t) {
    if (!t || !t.branch || !isOpen(t)) return;
    optimistic(t, { branch_done: !t.branch_done }, { action: 'branch_done', id: t.id, done: !t.branch_done });
}
// The next update's size: the version follows at once (the server sends every
// size's version), and the confirmed pipeline replaces the guess.
async function setSize(size) {
    const next = pipe().next;
    if (!next || next.size === size || !canWrite()) return;
    const before = Object.assign({}, next);
    Object.assign(next, { size, version: (next.versions || {})[size] || next.version, needs_title: size !== 'minor' });
    renderBoard();
    if (next.needs_title && !String(S.titleDraft != null ? S.titleDraft : next.title).trim()) { const i = $('#dvNextTitle'); if (i) i.focus(); }
    try {
        const r = await post({ action: 'set_next', size });
        if (r.pipeline) S.data.pipeline = r.pipeline;
        renderBoard();
    } catch (e) {
        Object.assign(next, before);
        renderBoard();
        toast(`Not saved — ${e.message}`, { bad: true });
    }
}
let titleTimer = null;
function saveNextTitle(now) {
    clearTimeout(titleTimer);
    const go = async () => {
        const next = pipe().next;
        const v = S.titleDraft;
        if (!next || v == null || v.trim() === String(next.title || '').trim()) { S.titleDraft = null; return; }
        try {
            const r = await post({ action: 'set_next', title: v.trim() });
            if (r.pipeline) S.data.pipeline = r.pipeline;
            if (S.titleDraft === v) S.titleDraft = null;
            renderTop();
        } catch (e) { toast(`Title not saved — ${e.message}`, { bad: true }); }
    };
    if (now) go(); else titleTimer = setTimeout(go, 700);
}

// The move menu: a branch, back to the Backlog, or Won't do.
function moveMenu(t, anchor) {
    if (!canWrite() || !t) return;
    if (t.status === 'wont_do') {
        return picker(anchor, { items: [{ value: 'backlog', label: 'Back to the Backlog', html: ICON.inbox }], onPick: () => setStatus(t, 'backlog', null, `SN-${t.id} → Backlog`) });
    }
    if (!isOpen(t)) return;
    const items = lanes().filter((b) => b.name !== t.branch && !b.unknown)
        .map((b) => ({ value: 'b:' + b.name, label: b.name, html: ICON.branch, mono: true, section: 'Work on a branch', hint: plural(laneTickets(b.name).length, 'ticket') }));
    items.push({ value: 'new', label: 'A new branch…', html: ICON.plus, section: 'Work on a branch' });
    if (t.branch) items.push({ value: 'backlog', label: 'Back to the Backlog', html: ICON.inbox, section: 'Or' });
    if (t.status === 'triage') items.push({ value: 'accept', label: 'Keep it in the Backlog (seen)', html: ICON.inbox, section: 'Or' });
    items.push({ value: 'wont', label: "Won't do…", html: stIcon('wont_do'), section: 'Or' });
    picker(anchor, {
        items, placeholder: 'Move to…',
        onPick: (v) => {
            if (v === 'new') return newBranch([t.id]);
            if (v === 'backlog') return moveTicket(t, null);
            if (v === 'accept') return setStatus(t, 'backlog', null, `SN-${t.id} kept in the Backlog`);
            if (v === 'wont') return wontDo(t, anchor);
            if (v.startsWith('b:')) return moveTicket(t, v.slice(2));
        },
    });
}

function pickFor(t, kind, anchor) {
    if (!canWrite()) return;
    const items = {
        assignee: () => [{ value: '', label: 'Unassigned', html: avatar('') }].concat((S.data.devs || []).map((d) => ({ value: d.id, label: d.name, html: avatar(d.name), hint: d.store }))),
        type: () => (S.data.types || []).filter((x) => x.active !== false).map((x) => ({ value: x.key, label: x.label, html: `<span class="dv-ty" style="--c:${typeColor(x.key)}"><i></i></span>`, hint: x.dev_only ? 'dev' : '' })),
        area: () => [{ value: '', label: 'No area', html: ICON.box }].concat((S.data.areas || []).filter((x) => x.active !== false).map((x) => ({ value: x.key, label: x.label, html: ICON.box }))),
        stores: () => STORES.map((s) => ({ value: s, label: s, html: ICON.store })),
    };
    if (kind === 'due') {
        formPop(anchor, `<label for="dvDue">Due date</label><input type="date" class="dv-input" id="dvDue" value="${esc(t.due || '')}">
            <div style="display:flex;gap:6px;justify-content:flex-end"><button class="dv-btn dv-btn-ghost dv-btn-sm" data-due="clear">Clear</button><button class="dv-btn dv-btn-primary dv-btn-sm" data-due="save">Save</button></div>`, (el) => {
            const input = $('#dvDue', el);
            input.focus();
            const go = (v) => { closePop(); if ((v || null) !== (t.due || null)) optimistic(t, { due: v || null }, { action: 'edit', id: t.id, due: v || null }); };
            $('[data-due="save"]', el).addEventListener('click', () => go(input.value));
            $('[data-due="clear"]', el).addEventListener('click', () => go(''));
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(input.value); } });
        });
        return;
    }
    if (!items[kind]) return;
    const current = kind === 'assignee' ? String(t.assignee_id || '') : kind === 'stores' ? (t.stores || []) : (t[kind] || '');
    picker(anchor, {
        items: items[kind](), current, multi: kind === 'stores', placeholder: `Set ${kind}…`,
        onPick: (v) => {
            if (kind === 'assignee') {
                const d = (S.data.devs || []).find((x) => x.id === v);
                return optimistic(t, { assignee_id: v || null, assignee_name: d ? d.name : null }, { action: 'assign', id: t.id, assignee_id: v || null });
            }
            if (kind === 'stores') {
                clearTimeout(pickFor._st);
                t.stores = v; renderPanel();
                pickFor._st = setTimeout(() => optimistic(t, { stores: v }, { action: 'edit', id: t.id, stores: v }), 600);
                return;
            }
            const value = v || null;
            if (String(t[kind] ?? '') === String(value ?? '')) return;
            optimistic(t, { [kind]: value }, { action: 'edit', id: t.id, [kind]: value });
        },
    });
}
function wontDo(t, anchor) {
    formPop(anchor, `<label for="dvWhy">Why won't it be done? <span class="dv-muted">Whoever raised it reads this.</span></label>
        <textarea id="dvWhy" placeholder="e.g. Already handled by the eBay page"></textarea>
        <div style="display:flex;gap:6px;justify-content:flex-end"><button class="dv-btn dv-btn-ghost dv-btn-sm" data-why="cancel">Cancel</button><button class="dv-btn dv-btn-primary dv-btn-sm" data-why="go">Mark Won't Do</button></div>`, (el) => {
        const ta = $('#dvWhy', el);
        ta.focus();
        const go = () => { const note = ta.value.trim(); if (!note) { ta.focus(); return; } closePop(); setStatus(t, 'wont_do', note, `SN-${t.id} → Won't do`); };
        $('[data-why="go"]', el).addEventListener('click', go);
        $('[data-why="cancel"]', el).addEventListener('click', closePop);
        ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); go(); } });
    });
}
async function sendComment(t) {
    const ta = $('#dvComposer');
    const body = (ta && ta.value || '').trim();
    if (!body) { if (ta) ta.focus(); return; }
    ta.disabled = true;
    try {
        await post({ action: 'comment', id: t.id, body });
        ta.value = '';
        await load(true);
        const again = $('#dvComposer'); if (again) again.focus();
    } catch (e) {
        ta.disabled = false;
        toast(`Comment not sent — ${e.message}`, { bad: true });
    }
}
async function saveComment(t, cid) {
    const ta = $('#dvCommentEdit');
    const body = (ta && ta.value || '').trim();
    if (!body) return;
    try {
        await post({ action: 'edit_comment', id: t.id, comment_id: Number(cid), body });
        S.editingComment = null;
        await load(true);
    } catch (e) { toast(`Not saved — ${e.message}`, { bad: true }); }
}

// ---- GitHub (github-webhook) ---------------------------------------------
async function sync() {
    if (S.syncing) return;
    S.syncing = true; renderLanes();
    try {
        const r = await ghPost({ action: 'reconcile' });
        const bits = [];
        if (r.linked) bits.push(`${r.linked} linked`);
        if ((r.moved || []).length) bits.push(`${r.moved.length} moved`);
        toast(`Synced with GitHub — ${bits.length ? bits.join(', ') : 'nothing new'}`);
        S.syncing = false;
        await load(true);
    } catch (e) { toast(`Sync failed — ${e.message}`, { bad: true }); }
    finally { S.syncing = false; renderLanes(); fadeEdge(); }
}
async function deleteBranch(name) {
    const b = ((S.data && S.data.branches) || []).find((x) => x.name === name);
    const yes = await confirmDialog({ title: `Delete ${name}?`, body: `Everything on it is already on <span class="dv-mono">pre-release</span>, so no work is lost${b && b.pr_number ? ` (PR #${b.pr_number} stays on GitHub)` : ''}. The branch is removed from GitHub.`, ok: 'Delete branch', danger: true });
    if (!yes) return;
    try {
        await ghPost({ action: 'delete_branch', name });
        await load(true);
        toast(`Deleted ${name}`);
    } catch (e) { toast(e.message, { bad: true }); }
}
function branchMenu(name, anchor) {
    const b = lanes().find((x) => x.name === name) || ((S.data && S.data.branches) || []).find((x) => x.name === name) || { name };
    const w = canWrite();
    menu(anchor, `
        <div class="dv-pop-lbl dv-mono">${esc(name)}</div>
        ${w && !b.unknown ? `<button class="dv-opt" data-act="new-on" data-branch="${esc(name)}">${ICON.plus}<span>New ticket on this branch</span></button>` : ''}
        <a class="dv-opt" href="${REPO_URL}/tree/${esc(name)}" target="_blank" rel="noopener">${ICON.external}<span>Open on GitHub</span></a>
        ${b.pr_number ? `<a class="dv-opt" href="${esc(b.pr_url || `${REPO_URL}/pull/${b.pr_number}`)}" target="_blank" rel="noopener">${ICON.pr}<span>Open PR #${b.pr_number}</span></a>`
            : !b.unknown ? `<a class="dv-opt" href="${REPO_URL}/compare/pre-release...${esc(name)}?expand=1" target="_blank" rel="noopener">${ICON.pr}<span>Open a PR into pre-release</span></a>` : ''}
        <button class="dv-opt" data-copy="git fetch origin &amp;&amp; git switch ${esc(name)}">${ICON.copy}<span>Copy the checkout command</span></button>
        ${w && b.merged && !laneTickets(name).length ? `<hr><button class="dv-opt danger" data-bdelete="${esc(name)}">${ICON.trash}<span>Delete branch…</span></button>` : ''}`);
}
function tidyMenu(anchor) {
    const list = tidyBranches();
    menu(anchor, `<div class="dv-pop-lbl">Fully merged — safe to delete</div>`
        + list.map((b) => `<button class="dv-opt danger" data-bdelete="${esc(b.name)}">${ICON.trash}<span class="dv-mono">${esc(b.name)}</span></button>`).join(''), 'dv-menu-wide');
}
function liveMenu(anchor) {
    const rels = liveReleases().slice(0, 6);
    menu(anchor, `<div class="dv-pop-lbl">On speeksnet.com</div>` + rels.map((r, i) => {
        const shipped = shippedIn(r.id);
        const name = r._name || (r.title && r.title !== r.version ? r.title : '');
        return `<div class="dv-rel">
            <div class="dv-rel-h">${i === 0 ? '<span class="dv-ldot"></span>' : ''}<span class="dv-rel-v">${esc(r.version || '—')}</span><span class="dv-rel-n">${esc(name)}</span><span class="dv-rel-d">${esc(shortDate(r.published_at))}</span></div>
            ${shipped.length ? `<ul>${shipped.slice(0, 6).map((t) => `<li><button data-open="${t.id}"><span class="dv-card-id">SN-${t.id}</span><span>${esc(t.title)}</span></button></li>`).join('')}${shipped.length > 6 ? `<li class="dv-muted">and ${shipped.length - 6} more</li>` : ''}</ul>` : ''}
        </div>`;
    }).join('') || '<div class="dv-pop-empty">Nothing published yet.</div>', 'dv-menu-wide');
}

// ---- the Claude connector (dev-mcp, 0209) ---------------------------------
// Each developer's own key: made here, shown ONCE, stored only as a hash.
// Claude's writes through it show as "Claude, for <name>" in the history.
const MCP_URL = `${BASE}/dev-mcp`;
function meMenu(anchor) {
    menu(anchor, `<div class="dv-pop-lbl">${esc(me().name || '')}${me().test ? ' · test account' : ''}</div>
        <button class="dv-opt" data-act="connector">${ICON.code}<span>Claude connector…</span></button>
        <button class="dv-opt" data-act="keys">${ICON.keyboard}<span>Keyboard shortcuts</span></button>
        <a class="dv-opt" href="index.html">${ICON.back}<span>Back to SPEEKSNET</span></a>`);
}
function usedText(ts) {
    if (!ts) return 'never used';
    const w = when(ts);
    return w === 'now' ? 'used just now' : /^\d+[mhd]$/.test(w) ? `used ${w} ago` : `used ${w}`;
}
function keyRows(keys) {
    const live = (keys || []).filter((k) => !k.revoked_at);
    if (!live.length) return `<div class="dv-emptybox">No keys yet.</div>`;
    return live.map((k) => `<div class="dv-key-row">
        <span class="dv-mono">sndev_…${esc(k.hint)}</span>
        <span class="dv-key-label">${esc(k.label || 'No label')}</span>
        <span class="dv-muted" title="${esc(fullDate(k.created_at))}">made ${esc(shortDate(k.created_at))} · ${esc(usedText(k.last_used_at))}</span>
        <button class="dv-btn dv-btn-danger dv-btn-sm" data-revoke="${k.id}">Revoke</button>
    </div>`).join('');
}
async function connector() {
    closePop();
    const m = openModal(`<div class="dv-modal-top">${ICON.code}Claude connector<button class="dv-icon-btn" data-act="modal-close" title="Close (Esc)">${ICON.x}</button></div>
        <div class="dv-modal-body dv-conn">
            <p>Lets Claude see this pipeline and keep it true while it works: find or create the ticket, start a branch with tickets on it, move and tick tickets, comment. It can't merge, go live or delete. What it changes shows in the history as <b>Claude, for ${esc((me().name || '').split(/\s+/)[0])}</b>. The rules it follows are in <span class="dv-mono">docs/DEVELOPMENT-WORKFLOW.md</span>.</p>
            <div id="dvConnNew"></div>
            <div class="dv-conn-h">Your keys</div>
            <div id="dvConnKeys"><div class="dv-emptybox">Loading…</div></div>
            ${canWrite() ? `<div class="dv-inrow dv-conn-make"><input class="dv-input" id="dvKeyLabel" placeholder="Label, e.g. Nick's desktop" maxlength="60"><button class="dv-btn dv-btn-primary" id="dvKeyMake">${ICON.plus}Make a key</button></div>` : '<div class="dv-readonly">Test accounts can\'t have keys.</div>'}
        </div>`, 'dv-connector');
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeModal(); } });
    const draw = (keys) => { const h = $('#dvConnKeys', m); if (h) h.innerHTML = keyRows(keys); };
    if (!canWrite()) { draw([]); return; }
    m.addEventListener('click', async (e) => {
        const r = e.target.closest('[data-revoke]');
        if (!r) return;
        r.disabled = true;
        try { draw((await post({ action: 'mcp_key_revoke', key_id: Number(r.dataset.revoke) })).keys); toast('Key revoked — it stops working at once'); }
        catch (err) { r.disabled = false; toast(err.message, { bad: true }); }
    });
    $('#dvKeyMake', m).addEventListener('click', async () => {
        const btn = $('#dvKeyMake', m);
        btn.disabled = true;
        try {
            const r = await post({ action: 'mcp_key_create', label: ($('#dvKeyLabel', m).value || '').trim() });
            draw(r.keys);
            $('#dvKeyLabel', m).value = '';
            // The only time the key is ever shown.
            const ps = `[Environment]::SetEnvironmentVariable('SPEEKSNET_DEV_KEY', '${r.key}', 'User')`;
            $('#dvConnNew', m).innerHTML = `<div class="dv-newkey">
                <b>Your new key — copy it now. It won't be shown again.</b>
                <div class="dv-newkey-row"><code class="dv-mono">${esc(r.key)}</code><button class="dv-btn dv-btn-sm" data-copyk="${esc(r.key)}">${ICON.copy}Copy</button></div>
                <div class="dv-conn-step"><span>1</span>Claude Code: run this once in PowerShell, then restart Claude. The repo's <span class="dv-mono">.mcp.json</span> already points at the connector.</div>
                <div class="dv-newkey-row"><code class="dv-mono">${esc(ps)}</code><button class="dv-btn dv-btn-sm" data-copyk="${esc(ps)}">${ICON.copy}Copy</button></div>
                <div class="dv-conn-step"><span>2</span>Or claude.ai (Settings → Connectors → Add custom connector), with this URL. Anyone with the URL acts as you, so keep it to your own account.</div>
                <div class="dv-newkey-row"><code class="dv-mono">${esc(MCP_URL + '/' + r.key)}</code><button class="dv-btn dv-btn-sm" data-copyk="${esc(MCP_URL + '/' + r.key)}">${ICON.copy}Copy</button></div>
            </div>`;
            $$('[data-copyk]', m).forEach((b) => b.addEventListener('click', () => copy(b.dataset.copyk, 'Copied')));
        } catch (err) { toast(err.message, { bad: true }); }
        finally { btn.disabled = false; }
    });
    try { draw((await post({ action: 'mcp_keys' })).keys); }
    catch (err) { const h = $('#dvConnKeys', m); if (h) h.innerHTML = `<div class="dv-emptybox">Couldn't load your keys — ${esc(err.message)}</div>`; }
}

// ---- the patch notes as text, and rewording a line --------------------------
function notesText() {
    const next = pipe().next;
    const title = next && next.needs_title ? String((S.titleDraft != null ? S.titleDraft : next.title) || '').trim() : '';
    const lines = [`What's new in ${next ? next.version : 'the next update'}${title ? ` — ${title}` : ''}`, ''];
    for (const g of noteGroups(preTickets())) { lines.push(g.label); g.list.forEach((t) => lines.push(`- ${t.title}`)); lines.push(''); }
    return lines.join('\n').trim();
}
function reword(t, anchor) {
    if (!canWrite() || !t) return;
    formPop(anchor, `<label for="dvReword">Reword the note <span class="dv-muted">— it's SN-${t.id}'s title, read by every store manager</span></label>
        <input class="dv-input" id="dvReword" maxlength="200" value="${esc(t.title)}">
        <div style="display:flex;gap:6px;justify-content:flex-end"><button class="dv-btn dv-btn-ghost dv-btn-sm" data-rw="cancel">Cancel</button><button class="dv-btn dv-btn-primary dv-btn-sm" data-rw="save">Save</button></div>`, (el) => {
        const input = $('#dvReword', el);
        input.focus(); input.select();
        const go = () => { const v = input.value.replace(/\s+/g, ' ').trim(); closePop(); if (v && v !== t.title) optimistic(t, { title: v }, { action: 'edit', id: t.id, title: v }, 'Patch note reworded'); };
        $('[data-rw="save"]', el).addEventListener('click', go);
        $('[data-rw="cancel"]', el).addEventListener('click', closePop);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    });
}

// ---- the side columns: the Backlog collapses; both resize ----------------
// Nick, 2026-11-25: collapsible Backlog, side columns adjustable "within a
// certain range". Each person's choice is kept in this browser (localStorage),
// and none of it applies when the window is narrow enough to stack the columns.
const store = { get(k) { try { return localStorage.getItem('dv.' + k); } catch (_) { return null; } }, set(k, v) { try { localStorage.setItem('dv.' + k, v); } catch (_) {} } };
const SIDE = { backlog: { min: 220, max: 460, def: 288, key: 'blw' }, pre: { min: 300, max: 540, def: 360, key: 'prew' } };
const layout = { blw: Number(store.get('blw')) || null, prew: Number(store.get('prew')) || null, collapsed: store.get('blc') === '1' };
function applyLayout() {
    const pipeEl = $('#dvPipe');
    if (!pipeEl) return;
    pipeEl.classList.toggle('dv-blc', layout.collapsed);
    pipeEl.style.setProperty('--bl-w', layout.collapsed ? '48px' : layout.blw ? layout.blw + 'px' : '');
    if (!layout.collapsed && !layout.blw) pipeEl.style.removeProperty('--bl-w');
    if (layout.prew) pipeEl.style.setProperty('--pre-w', layout.prew + 'px'); else pipeEl.style.removeProperty('--pre-w');
    fadeEdge();
}
function toggleBacklog(force) {
    layout.collapsed = typeof force === 'boolean' ? force : !layout.collapsed;
    store.set('blc', layout.collapsed ? '1' : '0');
    renderBacklog();
    applyLayout();
}
// Drag a column's inner edge. The branches always keep at least 340px.
function startResize(which, e) {
    const pipeEl = $('#dvPipe');
    const col = which === 'backlog' ? $('#dvBacklog') : $('#dvPre');
    if (!pipeEl || !col) return;
    e.preventDefault();
    const s = SIDE[which], x0 = e.clientX, w0 = col.getBoundingClientRect().width;
    const other = (which === 'backlog' ? $('#dvPre') : $('#dvBacklog')).getBoundingClientRect().width;
    const max = Math.max(s.min, Math.min(s.max, pipeEl.clientWidth - other - 340));
    document.body.classList.add('dv-resizing');
    const move = (ev) => {
        const w = Math.round(Math.max(s.min, Math.min(max, w0 + (which === 'backlog' ? ev.clientX - x0 : x0 - ev.clientX))));
        layout[s.key] = w;
        pipeEl.style.setProperty(which === 'backlog' ? '--bl-w' : '--pre-w', w + 'px');
        fadeEdge();
    };
    const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.body.classList.remove('dv-resizing');
        if (layout[s.key]) store.set(s.key, String(layout[s.key]));
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
}
function resetWidth(which) {
    const s = SIDE[which];
    layout[s.key] = null;
    store.set(s.key, '');
    applyLayout();
}

// ---- hash: dev.html#SN-573 opens that ticket ------------------------------
// replaceState, not location.hash =: no history entries, no navigation (a
// hash assignment is one, and hung the headless checks — see the handoff).
function syncHash() {
    const h = S.openId != null ? `#SN-${S.openId}` : '';
    if (location.hash !== h) { try { history.replaceState(null, '', location.pathname + location.search + h); } catch (_) {} }
}
function openFromHash() {
    const m = /^#(?:SN-)?(\d+)$/i.exec(location.hash || '');
    if (m && ticket(m[1])) open(Number(m[1]));
}

// ---- events (one delegated handler) -------------------------------------
const ACTIONABLE = '[data-act],[data-id],[data-open],[data-chk],[data-more],[data-bmore],[data-size],[data-pick],[data-npick],[data-copy],[data-bdelete],[data-reword],[data-note-pr]';
function onClick(e) {
    if (!e.target || !e.target.closest) return;
    const el = e.target.closest(ACTIONABLE);
    const inLayer = !!e.target.closest('#dvLayer');
    if (!el) {
        if (pop && !e.target.closest('.dv-pop')) closePop();
        // A click on the board (not the panel, not a menu) puts the panel away.
        if (S.openId != null && !inLayer && !e.target.closest('.dv-panel') && e.target.closest('.dv-pipe')) closePanel();
        return;
    }
    if (pop && !el.closest('.dv-pop')) closePop();
    const t = S.openId != null ? ticket(S.openId) : null;
    const d = el.dataset;
    if (d.chk) { e.stopPropagation(); return toggleDone(ticket(d.chk)); }
    if (d.more) { e.stopPropagation(); return moveMenu(ticket(d.more), el); }
    if (d.bmore) { e.stopPropagation(); return branchMenu(d.bmore, el); }
    if (d.size) return setSize(d.size);
    if (d.reword) { e.stopPropagation(); return reword(ticket(d.reword), el); }
    if (d.notePr) { const p = ((S.data && S.data.prerelease_prs) || []).find((x) => String(x.pr_number) === d.notePr); return p && newTicket({ pr: p }); }
    if (d.open) { closePop(); return open(Number(d.open)); }
    if (d.id && el.classList.contains('dv-card')) return open(Number(d.id));
    if (d.copy) { closePop(); return copy(d.copy.replace(/&amp;/g, '&'), 'Command copied'); }
    if (d.bdelete) { closePop(); return deleteBranch(d.bdelete); }
    if (d.pick && t) return pickFor(t, d.pick, el);
    if (d.npick) return draftPick(d.npick, el);
    switch (d.act) {
        case 'new': return newTicket();
        case 'new-on': closePop(); return newTicket(d.branch);
        case 'new-create': return createTicket();
        case 'new-branch': return newBranch();
        case 'modal-close': return closeModal();
        case 'keys': return shortcuts();
        case 'sync': return sync();
        case 'tidy': return tidyMenu(el);
        case 'me-menu': if (pop) { closePop(); return; } return meMenu(el);
        case 'connector': return connector();
        case 'copy-notes': return copy(notesText(), 'Patch notes copied');
        case 'bl-collapse': return toggleBacklog(true);
        case 'bl-expand': return toggleBacklog(false);
        case 'live-menu': if (pop) { closePop(); return; } return liveMenu(el);
        case 'retry': S.gate = null; $('#dvApp').innerHTML = '<div class="dv-boot"><div class="dv-boot-mark"></div></div>'; return load();
        case 'close': return closePanel();
        case 'move': return t && moveMenu(t, el);
        case 'copy-link': return t && copy(`${location.origin}${location.pathname}#SN-${t.id}`, `Link to SN-${t.id} copied`);
        case 'desc-edit': S.editingDesc = true; return renderPanel();
        case 'desc-cancel': S.editingDesc = false; return renderPanel();
        case 'desc-save': return t && saveDesc(t);
        case 'comment': return t && sendComment(t);
        case 'comment-edit': S.editingComment = Number(d.cid); renderPanel(); { const ta = $('#dvCommentEdit'); if (ta) ta.focus(); } return;
        case 'comment-cancel': S.editingComment = null; return renderPanel();
        case 'comment-save': return t && saveComment(t, d.cid);
    }
}
function onInput(e) {
    if (e.target && e.target.id === 'dvNextTitle') {
        S.titleDraft = e.target.value;
        const h = $('#dvHTitle'); if (h) h.textContent = e.target.value.trim() || 'Untitled update';
        e.target.classList.toggle('need', !e.target.value.trim());
        saveNextTitle(false);
    }
}
function onFocusOut(e) {
    if (e.target && e.target.id === 'dvNextTitle' && S.titleDraft != null) saveNextTitle(true);
}
function saveDesc(t) {
    const v = ($('#dvDescEdit') || {}).value;
    S.editingDesc = false;
    if (v === undefined || v === (t.description || '')) { renderPanel(); return; }
    optimistic(t, { description: v }, { action: 'edit', id: t.id, description: v });
}
function draftPick(kind, anchor) {
    const items = {
        branch: [{ value: '', label: 'Backlog', html: ICON.inbox }].concat(lanes().filter((b) => !b.unknown).map((b) => ({ value: b.name, label: b.name, html: ICON.branch, mono: true }))),
        type: (S.data.types || []).filter((x) => x.active !== false).map((x) => ({ value: x.key, label: x.label, html: `<span class="dv-ty" style="--c:${typeColor(x.key)}"><i></i></span>` })),
        area: [{ value: '', label: 'No area' }].concat((S.data.areas || []).filter((x) => x.active !== false).map((x) => ({ value: x.key, label: x.label, html: ICON.box }))),
        assignee: [{ value: '', label: 'Unassigned', html: avatar('') }].concat((S.data.devs || []).map((d) => ({ value: d.id, label: d.name, html: avatar(d.name) }))),
    }[kind];
    const field = kind === 'assignee' ? 'assignee_id' : kind;
    picker(anchor, { items, current: draft[field], placeholder: kind === 'branch' ? 'Where it starts…' : 'Filter…', onPick: (v) => { draft[field] = v; drawDraftProps(); const ti = $('#dvNewTitle'); if (ti) ti.focus(); } });
}

// ---- drag and drop: onto a branch column, or back to the Backlog ----------
let dragId = null;
function onDragStart(e) {
    const c = e.target && e.target.closest && e.target.closest('.dv-card[draggable="true"]');
    if (!c) return;
    dragId = Number(c.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', `SN-${dragId}`); } catch (_) {}
    requestAnimationFrame(() => c.classList.add('drag'));
    closePop();
}
function onDragOver(e) {
    if (dragId == null) return;
    const z = e.target.closest && e.target.closest('.dv-drop');
    $$('.dv-drop.over').forEach((x) => { if (x !== z) x.classList.remove('over'); });
    if (!z) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    z.classList.add('over');
}
function onDrop(e) {
    const z = dragId != null && e.target.closest && e.target.closest('.dv-drop');
    if (!z) return;
    e.preventDefault();
    const t = ticket(dragId);
    dragId = null;
    $$('.drag, .over').forEach((x) => x.classList.remove('drag', 'over'));
    if (z.dataset.zone === 'branch') moveTicket(t, z.dataset.branch);
    else moveTicket(t, null);
}
function onDragEnd() { dragId = null; $$('.drag, .over').forEach((x) => x.classList.remove('drag', 'over')); }

function onKey(e) {
    if (modal || S.gate) return;
    const target = e.target && e.target.closest ? e.target : document.body;   // a key sent to document has no element
    const typing = target.closest('input, textarea, select, [contenteditable]');
    if (typing) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            const t = S.openId != null ? ticket(S.openId) : null;
            if (e.target.id === 'dvComposer' && t) { e.preventDefault(); sendComment(t); }
            if (e.target.id === 'dvDescEdit' && t) { e.preventDefault(); saveDesc(t); }
            if (e.target.id === 'dvCommentEdit' && t) { e.preventDefault(); saveComment(t, S.editingComment); }
        }
        if (e.key === 'Enter' && e.target.id === 'dvNextTitle') { e.preventDefault(); e.target.blur(); }
        if (e.key === 'Escape' && !pop) {
            if (e.target.id === 'dvDescEdit') { S.editingDesc = false; renderPanel(); }
            else e.target.blur();
        }
        return;
    }
    if (pop) return;
    if (e.ctrlKey || e.metaKey || e.altKey) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#dvSearch').focus(); }
        return;
    }
    const t = S.openId != null ? ticket(S.openId) : null;
    switch (e.key) {
        case '/': e.preventDefault(); $('#dvSearch').focus(); $('#dvSearch').select(); return;
        case 'c': case 'C': e.preventDefault(); return newTicket();
        case 'b': case 'B': e.preventDefault(); return newBranch(t && isOpen(t) && !t.branch ? [t.id] : []);
        case 'Escape': if (S.openId != null) return closePanel(); if (S.query) { S.query = ''; $('#dvSearch').value = ''; renderBoard(); } return;
        case '?': e.preventDefault(); return shortcuts();
        case 'Enter': {
            const c = target.closest('.dv-card');
            if (c) { e.preventDefault(); open(Number(c.dataset.id)); }
            return;
        }
        case '[': e.preventDefault(); return toggleBacklog();
        case 'a': case 'm': {
            if (!t) return;
            if (e.key === 'm') { const b = $('[data-act="move"]'); if (b) { e.preventDefault(); moveMenu(t, b); } return; }
            const anchor = $('.dv-prop[data-pick="assignee"]');
            if (anchor) { e.preventDefault(); pickFor(t, 'assignee', anchor); }
        }
    }
}

// ---- realtime ------------------------------------------------------------
function setLive(on) {
    S.live = !!on;
    const el = $('#dvLive');
    if (el) { el.classList.toggle('on', S.live); el.title = S.live ? 'Live — changes appear without reloading' : 'Not live — reload to see others\' changes'; }
}
let rtTimer = null;
function startRealtime() {
    const go = () => {
        try {
            const client = window.supabase.createClient(SB_URL, SB_KEY);
            client.channel('speeks-notify')
                .on('broadcast', { event: 'changed' }, (msg) => {
                    if (!msg || !msg.payload || msg.payload.tool !== 'dev-tickets' || Date.now() < muteUntil) return;
                    clearTimeout(rtTimer);
                    rtTimer = setTimeout(() => load(true), 350);
                })
                .subscribe((status) => {
                    const was = S.live;
                    setLive(status === 'SUBSCRIBED');
                    if (status === 'SUBSCRIBED' && was === false && S.data) load(true);   // caught up after a drop
                });
        } catch (_) { setLive(false); }
    };
    if (window.supabase && window.supabase.createClient) return go();
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
    s.onload = go;
    s.onerror = () => setLive(false);
    document.head.appendChild(s);
}

// ---- boot ------------------------------------------------------------------
function listen() {
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    document.addEventListener('input', onInput);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('dragstart', onDragStart);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    document.addEventListener('dragend', onDragEnd);
    window.addEventListener('resize', fadeEdge);
}
function boot() {
    let ok = false;
    try { ok = sessionStorage.getItem('speeksUnlocked') === 'true' && !!pin(); } catch (_) {}
    if (!ok) { location.replace('index.html'); return; }
    listen();
    load().then(() => { if (S.data) openFromHash(); });
    startRealtime();
    // A tab left open overnight: refresh on return rather than show stale work.
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.data) load(true); });
}

// For the checks — the app's internals, not an API.
window.Dev = {
    S, idx, setData, renderAll, renderShell, renderBoard, renderPanel, open, closePanel,
    lanes, backlogTickets, laneTickets, preTickets, tidyBranches, stageOf, matchesQuery, personFor,
    moveTicket, toggleDone, setSize, saveNextTitle, moveMenu, branchMenu, liveMenu, newBranch, connector, meMenu,
    untrackedMerges, notesText, reword, toggleBacklog, applyLayout, resetWidth, layout,
    stIcon, priIcon, slugify, eventText, onClick, onKey, onInput, onDrop, picker, menu, closePop,
    newTicket, closeModal, toast, optimistic, setStatus, pickFor, openFromHash, syncHash, load, listen,
    stub: (fn) => { stub = fn; },
};
// Checks set window.DEV_NO_BOOT before DOMContentLoaded; the page never does.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { if (!window.DEV_NO_BOOT) boot(); });
else if (!window.DEV_NO_BOOT) boot();
})();
