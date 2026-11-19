/* ============================================================================
   THE DEVELOPMENT SUITE — dev.html's app (docs/plans/dev-tracker-HANDOFF.md).

   Nick, 2026-11-19: "the whole reason we are doing this is to have everything
   nice and simple. I want the UI to be PERFECT. Polished, snappy, fluid …
   better than all the competitors." Two people use it (Nick, Ethan). So it is
   its own app, not a SPEEKSNET page:
     - no speeks.js / styles.css on this page (3.5 MB it never needed)
     - one GET (dev-tickets) brings everything; every view, filter and search
       after that is local and instant
     - writes are OPTIMISTIC: the screen changes first, the server confirms,
       a failure puts it back and says why
     - a side panel, not popups; keyboard all the way (press ?)
     - realtime: the same 'speeks-notify' broadcast the rest of the site uses
       (tool 'dev-tickets'), so the other person's change appears on its own

   The rules all live on the server, unchanged: dev-tickets (tickets, comments,
   statuses — every name from the PIN) and github-webhook (sync, and Phase 5's
   Start work / delete / link / mark branch). Access is the dev-tracker Feature
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
const STATUS = {
    triage:        { label: 'Triage',         color: 'var(--s-triage)' },
    backlog:       { label: 'Backlog',        color: 'var(--s-backlog)' },
    in_progress:   { label: 'In Progress',    color: 'var(--s-progress)' },
    in_review:     { label: 'In Review',      color: 'var(--s-review)' },
    on_prerelease: { label: 'On Pre-release', color: 'var(--s-pre)' },
    done:          { label: 'Done',           color: 'var(--s-done)' },
    wont_do:       { label: "Won't Do",       color: 'var(--s-wont)' },
};
const STATUS_ORDER = ['triage', 'backlog', 'in_progress', 'in_review', 'on_prerelease', 'done', 'wont_do'];
const CLOSED = ['done', 'wont_do'];
const PRIORITY = {
    urgent: { label: 'Urgent', rank: 0 },
    high:   { label: 'High',   rank: 1 },
    normal: { label: 'Normal', rank: 2 },
    low:    { label: 'Low',    rank: 3 },
};
const PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'];
const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL', 'CORP'];
const PREFIXES = ['fix', 'feat', 'chore'];
// Nick's call (Phase 5): Bug → fix; Suggestion, Improvement → feat; else chore.
const prefixFor = (type) => type === 'bug' ? 'fix' : (type === 'suggestion' || type === 'improvement') ? 'feat' : 'chore';
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

const VIEWS = [
    { key: 'triage',        label: 'Triage',         group: 'inbox',    icon: 'triage' },
    { key: 'mine',          label: 'My Work',        group: 'inbox',    icon: 'user' },
    { key: 'open',          label: 'All Open',       group: 'workflow', icon: 'layers' },
    { key: 'backlog',       label: 'Backlog',        group: 'workflow', icon: 'backlog' },
    { key: 'in_progress',   label: 'In Progress',    group: 'workflow', icon: 'in_progress' },
    { key: 'in_review',     label: 'In Review',      group: 'workflow', icon: 'in_review' },
    { key: 'on_prerelease', label: 'On Pre-release', group: 'workflow', icon: 'on_prerelease' },
    { key: 'closed',        label: 'Done',           group: 'workflow', icon: 'done' },
    { key: 'branches',      label: 'Branches',       group: 'code',     icon: 'branch' },
];
// g + key → view
const GO_KEYS = { t: 'triage', m: 'mine', a: 'open', b: 'backlog', i: 'in_progress', r: 'in_review', p: 'on_prerelease', d: 'closed', c: 'branches' };

// ---- state -----------------------------------------------------------------
const S = {
    data: null,          // the dev-tickets GET
    view: null,          // a VIEWS key
    query: '',
    filters: { area: '', type: '', assignee: '' },
    openId: null,        // the ticket in the side panel
    selId: null,         // the keyboard-selected row
    editingDesc: false,
    editingComment: null,
    startOpen: false,    // the Start work form
    startPrefix: null,
    startSlug: '',
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
const pin = () => { try { return sessionStorage.getItem('speeksUserPin') || ''; } catch (_) { return ''; } };
const me = () => (S.data && S.data.me) || { id: null, name: '', test: true };
const canWrite = () => !!(S.data && S.data.me && S.data.me.id && !S.data.me.test);
const ticket = (id) => idx.byId.get(Number(id)) || null;
const labelOf = (list, key) => { const x = ((S.data && S.data[list]) || []).find((r) => r.key === key); return x ? x.label : (key || ''); };
const release = (id) => ((S.data && S.data.releases) || []).find((r) => Number(r.id) === Number(id)) || null;
const releaseLabel = (r) => !r ? '' : !r.version ? (r.title || '') : (r.title && r.title !== r.version ? `${r.version} · ${r.title}` : r.version);
const store = { get(k) { try { return localStorage.getItem('dv.' + k); } catch (_) { return null; } }, set(k, v) { try { localStorage.setItem('dv.' + k, v); } catch (_) {} } };

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
const AVATAR = ['#3fbf7f', '#a78bfa', '#2dd4bf', '#f0a83a', '#60a5fa', '#f472b6', '#facc15'];
function initials(name) { const p = String(name || '').trim().split(/\s+/); return ((p[0] || '')[0] || '?').toUpperCase() + ((p[1] || '')[0] || '').toUpperCase(); }
function avatar(name, cls) {
    if (!name) return `<span class="dv-avatar none ${cls || ''}" title="Unassigned">–</span>`;
    let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `<span class="dv-avatar ${cls || ''}" style="background:${AVATAR[h % AVATAR.length]}" title="${esc(name)}">${esc(initials(name))}</span>`;
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
    commit: sv('<circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/>'),
    file: sv('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
    sync: sv('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
    user: sv('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    layers: sv('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
    check: sv('<polyline points="20 6 9 17 4 12"/>'),
    keyboard: sv('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
    filter: sv('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'),
    trash: sv('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
    tag: sv('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
    calendar: sv('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
    box: sv('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>'),
    store: sv('<path d="M3 9l1-5h16l1 5"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/>'),
    external: sv('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
    inbox: sv('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
};

// Status: a ring that fills as the work moves along — the shape says where it
// is before the colour does.
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
function viewIcon(v) {
    if (STATUS[v.icon]) return stIcon(v.icon);
    return { user: ICON.user, layers: ICON.layers, branch: ICON.branch, triage: stIcon('triage') }[v.icon] || ICON.inbox;
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
}

async function load(quiet) {
    if (S.loading) return;
    S.loading = true;
    try {
        const json = await api(TICKETS_URL);
        setData(json);
        S.gate = null;
        if (!S.view) S.view = defaultView();
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
function defaultView() {
    const h = (location.hash || '').replace('#', '');
    if (VIEWS.some((v) => v.key === h)) return h;
    const saved = store.get('view');
    if (saved && VIEWS.some((v) => v.key === saved)) return saved;
    return (S.data.tickets || []).some((t) => t.status === 'triage') ? 'triage' : 'open';
}

// ---- which tickets a view shows --------------------------------------------
function passesFilters(t) {
    const f = S.filters;
    if (f.area && (f.area === '__none' ? t.area : t.area !== f.area)) return false;
    if (f.type && t.type !== f.type) return false;
    if (f.assignee && (f.assignee === '__none' ? t.assignee_id : String(t.assignee_id || '') !== f.assignee)) return false;
    return true;
}
function inView(t, view) {
    switch (view) {
        case 'triage': return t.status === 'triage';
        case 'mine': return !CLOSED.includes(t.status) && !!me().id && String(t.assignee_id || '') === String(me().id);
        case 'open': return !CLOSED.includes(t.status);
        case 'closed': return CLOSED.includes(t.status);
        default: return t.status === view;
    }
}
// "SN-573", "#573", "573" find the number; anything else searches the words.
function matchesQuery(t, q) {
    const n = q.replace(/^(sn-?|#)/i, '');
    if (/^\d+$/.test(n)) return String(t.id).startsWith(n) || String(t.github_number || '') === n;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = `${t.title} ${t.description || ''} ${t.reporter_name || ''} ${t.assignee_name || ''} ${labelOf('areas', t.area)} ${labelOf('types', t.type)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
}
function sortTickets(list, view) {
    if (view === 'closed') return list.sort((a, b) => String(b.closed_at || b.updated_at).localeCompare(String(a.closed_at || a.updated_at)));
    return list.sort((a, b) => ((PRIORITY[a.priority] || PRIORITY.normal).rank - (PRIORITY[b.priority] || PRIORITY.normal).rank)
        || String(b.updated_at).localeCompare(String(a.updated_at)));
}
function visibleTickets() {
    const all = (S.data && S.data.tickets) || [];
    const q = S.query.trim();
    if (q) return sortTickets(all.filter((t) => matchesQuery(t, q) && passesFilters(t)), 'search');
    return sortTickets(all.filter((t) => inView(t, S.view) && passesFilters(t)), S.view);
}
const grouped = () => !!S.query.trim() || S.view === 'mine' || S.view === 'open' || S.view === 'closed';
function counts() {
    const all = ((S.data && S.data.tickets) || []).filter(passesFilters);
    const c = {};
    for (const v of VIEWS) c[v.key] = v.key === 'branches'
        ? ((S.data && S.data.branches) || []).filter((b) => b.kind === 'untracked').length
        : all.filter((t) => inView(t, v.key)).length;
    return c;
}
// The rows in screen order, for j/k.
function rowOrder() {
    const list = visibleTickets();
    if (!grouped()) return list;
    return STATUS_ORDER.flatMap((s) => list.filter((t) => t.status === s));
}

// ---- render: shell ---------------------------------------------------------
function renderShell() {
    const app = $('#dvApp');
    app.removeAttribute('aria-busy');
    document.body.classList.remove('dv-booting');
    app.innerHTML = `
        <header class="dv-top">
            <div class="dv-brand"><span class="dv-brand-mark">${ICON.code}</span><span class="dv-brand-name">Development<small>SPEEKSNET</small></span></div>
            <label class="dv-search">${ICON.search}<input id="dvSearch" type="search" placeholder="Search tickets, or SN-1004" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>
            <div class="dv-top-right">
                <span class="dv-live" id="dvLive" title="Changes appear without reloading"><i></i><span>Live</span></span>
                <button class="dv-btn dv-btn-primary" data-act="new" id="dvNewBtn">${ICON.plus}New Ticket<kbd>C</kbd></button>
                <a class="dv-back" href="index.html" title="Back to SPEEKSNET">${ICON.back}<span>SPEEKSNET</span></a>
                <span id="dvMe">${avatar(me().name, 'lg dv-me')}</span>
            </div>
        </header>
        <nav class="dv-side" id="dvSide" aria-label="Views"></nav>
        <main class="dv-main" id="dvMain"><section class="dv-list-wrap" id="dvList"></section><div id="dvPanelHost" style="display:contents"></div></main>`;
    const search = $('#dvSearch');
    search.value = S.query;
    search.addEventListener('input', () => { S.query = search.value; S.selId = null; renderList(); renderSide(); });
    search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { search.value = ''; S.query = ''; renderList(); renderSide(); search.blur(); e.stopPropagation(); }
        if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); search.blur(); moveSel(e.key === 'Enter' ? 0 : 1, e.key === 'Enter'); }
    });
    setLive(S.live);
}
function renderAll() {
    if (!$('#dvSide')) renderShell();
    renderSide();
    renderList();
    renderPanel();
    syncHash();
}
function renderGate(msg) {
    const app = $('#dvApp');
    document.body.classList.remove('dv-booting');
    app.removeAttribute('aria-busy');
    app.innerHTML = S.gate === 'off'
        ? `<div class="dv-gate"><h1>The development suite isn't switched on for you</h1><p>It's for the people building SPEEKSNET. Ask Nick or Ethan if you need it.</p><p><a class="dv-btn" href="index.html">${ICON.back} Back to SPEEKSNET</a></p></div>`
        : `<div class="dv-gate"><h1>Couldn't load the tracker</h1><p>${esc(msg || 'Network error')}</p><p><button class="dv-btn" data-act="retry">${ICON.sync} Try again</button></p></div>`;
}

function renderSide() {
    const side = $('#dvSide');
    if (!side) return;
    const c = counts();
    const nav = (group) => VIEWS.filter((v) => v.group === group).map((v) => {
        const n = c[v.key];
        const hot = (v.key === 'triage' || v.key === 'branches') && n > 0;
        return `<button class="dv-nav${S.view === v.key && !S.query.trim() ? ' on' : ''}" data-view="${v.key}" title="${esc(v.label)}">
            ${viewIcon(v)}<span class="dv-nav-name">${esc(v.label)}</span>
            ${v.key === 'closed' || v.key === 'open' ? `<span class="dv-nav-count">${n}</span>` : n ? `<span class="dv-nav-count${hot ? ' hot' : ''}">${n}</span>` : ''}
        </button>`;
    }).join('');
    side.innerHTML = `
        <div class="dv-nav-group"><div class="dv-nav-label">Inbox</div>${nav('inbox')}</div>
        <div class="dv-nav-group"><div class="dv-nav-label">Workflow</div>${nav('workflow')}</div>
        <div class="dv-nav-group"><div class="dv-nav-label">Code</div>${nav('code')}</div>
        <div class="dv-side-foot">
            <button class="dv-btn dv-btn-ghost dv-btn-sm" data-act="sync" ${S.syncing ? 'disabled' : ''}>${ICON.sync}<span>${S.syncing ? 'Syncing…' : 'Sync with GitHub'}</span></button>
            <button class="dv-btn dv-btn-ghost dv-btn-sm" data-act="keys">${ICON.keyboard}<span>Shortcuts</span><kbd>?</kbd></button>
        </div>`;
}

// ---- render: the ticket list ----------------------------------------------
function filterChip(kind) {
    const f = S.filters[kind];
    const label = kind === 'area' ? (f ? (f === '__none' ? 'No area' : labelOf('areas', f)) : 'Area')
        : kind === 'type' ? (f ? labelOf('types', f) : 'Type')
        : (f ? (f === '__none' ? 'Unassigned' : ((S.data.devs || []).find((d) => d.id === f) || {}).name || 'Someone') : 'Assignee');
    return `<button class="dv-chipsel${f ? ' set' : ''}" data-filter="${kind}">${kind === 'assignee' ? ICON.user : kind === 'area' ? ICON.box : ICON.tag}${esc(label)}${f ? `<span data-clear="${kind}" title="Clear">${ICON.x}</span>` : ''}</button>`;
}
function rowHtml(t) {
    const area = t.area ? `<span class="dv-tag">${esc(labelOf('areas', t.area))}</span>` : '';
    const links = idx.links.get(Number(t.id)) || [];
    const pr = links.filter((l) => l.kind === 'pr').sort((a, b) => Number(b.ref) - Number(a.ref))[0];
    const br = links.find((l) => l.kind === 'branch' && l.state !== 'deleted');
    const comments = (idx.comments.get(Number(t.id)) || []).length;
    const files = (t.attachments || []).length;
    const bad = pr && (pr.checks || []).some((c) => c.level === 'error');
    return `<div class="dv-row${S.selId === Number(t.id) ? ' sel' : ''}${S.openId === Number(t.id) ? ' open' : ''}" data-id="${t.id}" role="row" tabindex="-1">
        ${priIcon(t.priority)}
        <span class="dv-row-id">SN-${t.id}</span>
        ${stIcon(t.status)}
        <span class="dv-row-title">${esc(t.title)}${t.status === 'wont_do' ? '<em>won\'t do</em>' : ''}</span>
        <span class="dv-row-tags">${area}<span class="dv-tag">${esc(labelOf('types', t.type))}</span></span>
        <span class="dv-row-meta">
            ${pr ? `<span title="PR #${esc(pr.ref)} · ${esc(pr.state || '')}" ${bad ? 'style="color:var(--danger)"' : ''}>${ICON.pr}</span>` : br ? `<span title="${esc(br.ref)}">${ICON.branch}</span>` : ''}
            ${files ? `<span title="${files} attachment${files === 1 ? '' : 's'}">${ICON.file}</span>` : ''}
            ${comments ? `<span title="${comments} comment${comments === 1 ? '' : 's'}">${comments}</span>` : ''}
        </span>
        ${avatar(t.assignee_name)}
        <span class="dv-row-when" title="Updated ${esc(fullDate(t.updated_at))}">${esc(when(t.updated_at))}</span>
    </div>`;
}
function renderList() {
    const host = $('#dvList');
    if (!host || !S.data) return;
    if (S.view === 'branches' && !S.query.trim()) { renderBranches(host); return; }
    const list = visibleTickets();
    const q = S.query.trim();
    const v = VIEWS.find((x) => x.key === S.view) || VIEWS[0];
    const head = `<div class="dv-head">
        <h1>${q ? ICON.search : viewIcon(v)}${q ? `Results for “${esc(q)}”` : esc(v.label)} <span class="dv-head-count">${list.length}</span></h1>
        <div class="dv-head-tools">${filterChip('area')}${filterChip('type')}${filterChip('assignee')}</div>
    </div>`;
    let body;
    if (!list.length) {
        const msg = q ? ['Nothing matches', 'Try fewer words, or a ticket number.']
            : S.view === 'triage' ? ['Triage is clear', 'New tickets from Submit a Ticket land here.']
            : S.view === 'mine' ? ['Nothing assigned to you', 'Tickets assigned to you show up here.']
            : ['No tickets here', 'Press C to create one.'];
        body = `<div class="dv-empty">${q ? ICON.search : ICON.inbox}<b>${msg[0]}</b><span>${msg[1]}</span></div>`;
    } else if (grouped()) {
        body = STATUS_ORDER.map((s) => {
            const rows = list.filter((t) => t.status === s);
            return rows.length ? `<div class="dv-group">${stIcon(s)}${esc(STATUS[s].label)}<span>${rows.length}</span></div>${rows.map(rowHtml).join('')}` : '';
        }).join('');
    } else {
        body = list.map(rowHtml).join('');
    }
    const scroll = $('.dv-scroll', host);
    const top = scroll ? scroll.scrollTop : 0;
    host.innerHTML = head + `<div class="dv-scroll" id="dvScroll" role="grid">${body}</div>`;
    $('#dvScroll').scrollTop = top;
}

// Selection moves without re-rendering — classes only, so j/k is instant.
function moveSel(delta, openIt) {
    if (S.view === 'branches' && !S.query.trim()) return;
    const order = rowOrder();
    if (!order.length) return;
    let i = order.findIndex((t) => Number(t.id) === S.selId);
    i = i < 0 ? (delta > 0 ? 0 : delta < 0 ? order.length - 1 : 0) : Math.max(0, Math.min(order.length - 1, i + delta));
    S.selId = Number(order[i].id);
    $$('.dv-row.sel').forEach((r) => r.classList.remove('sel'));
    const row = $(`.dv-row[data-id="${S.selId}"]`);
    if (row) { row.classList.add('sel'); row.scrollIntoView({ block: 'nearest' }); }
    if (openIt || S.openId != null) open(S.selId);
}

// ---- render: the side panel -----------------------------------------------
function open(id) {
    const t = ticket(id);
    if (!t) return;
    if (S.openId !== Number(id)) { S.editingDesc = false; S.editingComment = null; S.startOpen = false; }
    S.openId = Number(id);
    S.selId = Number(id);
    $$('.dv-row.open').forEach((r) => r.classList.remove('open'));
    const row = $(`.dv-row[data-id="${id}"]`);
    if (row) { row.classList.add('open'); $$('.dv-row.sel').forEach((r) => r.classList.remove('sel')); row.classList.add('sel'); }
    renderPanel();
    syncHash();
}
function closePanel() {
    if (S.openId == null) return;
    S.openId = null; S.editingDesc = false; S.startOpen = false;
    $$('.dv-row.open').forEach((r) => r.classList.remove('open'));
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
        case 'release': { const r = release(e.to_value); return r ? `put it in <b>${esc(releaseLabel(r))}</b>` : 'took it out of its release'; }
        case 'linked':   return `linked ${({ pr: 'a pull request', branch: 'a branch', commit: 'a commit' })[e.to_value] || 'code'}`;
        case 'unlinked': return `unlinked ${esc(e.from_value || 'code')}`;
        default:         return esc(e.kind);
    }
}
function prop(key, label, value, editable) {
    return `<dt>${label}</dt><dd><button class="dv-prop" data-pick="${key}" ${editable ? '' : 'disabled'}>${value}</button></dd>`;
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
    const activeBranch = links.some((l) => l.kind === 'branch' && l.state !== 'deleted');
    const canStart = canWrite() && !CLOSED.includes(t.status) && !activeBranch;
    let start = '';
    if (canStart && S.startOpen) {
        const prefix = S.startPrefix || prefixFor(t.type);
        const slug = S.startSlug || slugify(t.title);
        start = `<div class="dv-start">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <div class="dv-seg" role="radiogroup" aria-label="Kind of branch">${PREFIXES.map((p) => `<button class="${p === prefix ? 'on' : ''}" data-prefix="${p}">${p}</button>`).join('')}</div>
                <input class="dv-input" id="dvSlug" value="${esc(slug)}" spellcheck="false" style="flex:1;min-width:160px" aria-label="Branch name">
            </div>
            <div class="dv-branch-preview" id="dvBranchPreview">${esc(`${prefix}/sn-${t.id}-${slug}`)}</div>
            <div style="display:flex;gap:6px;justify-content:flex-end">
                <button class="dv-btn dv-btn-ghost dv-btn-sm" data-act="start-cancel">Cancel</button>
                <button class="dv-btn dv-btn-primary dv-btn-sm" data-act="start-go">${ICON.branch}Create branch from pre-release</button>
            </div>
        </div>`;
    }
    return `<div class="dv-sec">
        <div class="dv-sec-head"><h3>Code</h3>${canStart && !S.startOpen ? `<button class="dv-btn dv-btn-sm" data-act="start">${ICON.branch}Start work</button>` : ''}</div>
        ${start}
        ${items ? `<div class="dv-code">${items}</div>` : (!S.startOpen ? `<div class="dv-muted" style="font-size:12px">Nothing linked yet. Name a branch <span class="dv-mono">fix/sn-${t.id}-…</span> or put SN-${t.id} in a PR title and it appears here.</div>` : '')}
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
                ${e.note && e.kind !== 'edited' ? `<span class="dv-ev-note">${esc(e.note)}</span>` : ''}</span></li>`;
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
    const why = t.status === 'wont_do' ? ((idx.events.get(Number(t.id)) || []).filter((e) => e.kind === 'status' && e.to_value === 'wont_do').pop() || {}).note : '';
    const rel = release(t.release_id);
    const files = (t.attachments || []).length ? `<div class="dv-sec"><div class="dv-sec-head"><h3>Attachments</h3></div><div class="dv-files">${t.attachments.map((a) => a.url
        ? `<a class="dv-file" href="${esc(a.url)}" target="_blank" rel="noopener">${ICON.file}<span>${esc(a.name || 'attachment')}</span></a>`
        : `<span class="dv-file" title="The link expired — reload">${ICON.file}<span>${esc(a.name || 'attachment')}</span></span>`).join('')}</div></div>` : '';
    const desc = S.editingDesc
        ? `<textarea class="dv-desc-edit" id="dvDescEdit" placeholder="What's wrong, what's wanted, how to tell it's done.">${esc(t.description || '')}</textarea>
           <div class="dv-desc-actions"><span class="dv-muted" style="margin-right:auto;font-size:11.5px"><kbd>Ctrl</kbd> <kbd>Enter</kbd> to save</span><button class="dv-btn dv-btn-ghost dv-btn-sm" data-act="desc-cancel">Cancel</button><button class="dv-btn dv-btn-primary dv-btn-sm" data-act="desc-save">Save</button></div>`
        : `<div class="dv-desc${t.description ? '' : ' placeholder'}${w ? ' dv-editable' : ''}" ${w ? 'data-act="desc-edit" title="Click to edit"' : ''}>${t.description ? esc(t.description) : (w ? 'Add a description…' : 'No description.')}</div>`;
    host.innerHTML = `<aside class="dv-panel" aria-label="SN-${t.id}">
        <div class="dv-panel-top">
            <span class="dv-panel-id">${stIcon(t.status)}<b>SN-${t.id}</b>${t.github_number ? `<span>· was #${t.github_number}</span>` : ''}${t.source === 'idea' ? '<span>· from Submit a Ticket</span>' : ''}</span>
            <button class="dv-icon-btn dv-push" data-act="copy-link" title="Copy a link to this ticket">${ICON.link}</button>
            ${t.github_number ? `<a class="dv-icon-btn" href="${REPO_URL}/issues/${t.github_number}" target="_blank" rel="noopener" title="The old GitHub issue">${ICON.external}</a>` : ''}
            <button class="dv-icon-btn" data-act="close" title="Close (Esc)">${ICON.x}</button>
        </div>
        <div class="dv-panel-body">
            ${me().test ? `<div style="margin-bottom:12px"><span class="dv-readonly">Read-only — test account</span></div>` : ''}
            ${why ? `<div class="dv-callout no"><b>Won't do:</b> ${esc(why)}</div>` : ''}
            <h2 class="dv-title${w ? ' dv-editable' : ''}" id="dvTitle" ${w ? 'contenteditable="plaintext-only" spellcheck="true"' : ''}>${esc(t.title)}</h2>
            ${desc}
            <dl class="dv-props">
                ${prop('status', 'Status', `${stIcon(t.status)}<span>${esc(STATUS[t.status].label)}</span>`, w)}
                ${prop('priority', 'Priority', `${priIcon(t.priority)}<span>${esc((PRIORITY[t.priority] || PRIORITY.normal).label)}</span>`, w)}
                ${prop('assignee', 'Assignee', `${avatar(t.assignee_name)}<span class="${t.assignee_name ? '' : 'placeholder'}">${esc(t.assignee_name || 'Unassigned')}</span>`, w)}
                ${prop('type', 'Type', `${ICON.tag}<span>${esc(labelOf('types', t.type))}</span>`, w)}
                ${prop('area', 'Area', `${ICON.box}<span class="${t.area ? '' : 'placeholder'}">${esc(t.area ? labelOf('areas', t.area) : 'No area')}</span>`, w)}
                ${prop('release', 'Release', `${ICON.layers}<span class="${rel ? '' : 'placeholder'}">${esc(rel ? releaseLabel(rel) : 'No release')}</span>`, w)}
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
    const slug = $('#dvSlug');
    if (slug) slug.addEventListener('input', () => {
        S.startSlug = slugify(slug.value) || '';
        $('#dvBranchPreview').textContent = `${S.startPrefix || prefixFor(t.type)}/sn-${t.id}-${S.startSlug || slugify(t.title)}`;
    });
}

// ---- render: branches (Phase 5) -------------------------------------------
function branchSort(a, b) {
    const rank = { base: 0, untracked: 1, ticket: 2, release: 3 };
    if (a.kind === 'base' && b.kind === 'base') return a.name === 'pre-release' ? -1 : 1;
    return (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || String(b.last_commit_at || '').localeCompare(String(a.last_commit_at || ''));
}
function branchRowHtml(b) {
    const isBase = b.kind === 'base';
    const t = b.ticket_id ? ticket(b.ticket_id) : null;
    const kind = isBase ? `<span class="dv-tag">Base</span>`
        : b.kind === 'release' ? `<span class="dv-tag dv-tag-ok">Release${b.marked_by ? ` · ${esc(b.marked_by.split(' ')[0])}` : ''}</span>`
        : t ? `<button class="dv-tag" data-open="${t.id}" title="${esc(t.title)}">${stIcon(t.status)}SN-${t.id} · ${esc(t.title)}</button>`
        : `<span class="dv-tag dv-tag-warn">No ticket</span>`;
    const max = Math.max(1, b.ahead || 0, b.behind || 0);
    const ab = b.name === 'pre-release' ? `<div class="dv-ab"><span>the base</span></div>`
        : `<div class="dv-ab"><span>${b.ahead || 0} ahead · ${b.behind || 0} behind</span><div class="dv-ab-bars"><i class="behind" style="width:${Math.round(((b.behind || 0) / max) * 46)}%"></i><i class="ahead" style="width:${Math.round(((b.ahead || 0) / max) * 46)}%"></i></div></div>`;
    const pr = b.pr_number ? `<a class="dv-pill ${esc(b.pr_state || 'open')}" href="${esc(b.pr_url || '#')}" target="_blank" rel="noopener" style="text-decoration:none">#${b.pr_number} ${esc((b.pr_state || '').replace(/^./, (c) => c.toUpperCase()))}</a>` : '<span class="dv-muted">—</span>';
    const w = canWrite();
    const actions = [];
    if (w && !isBase && b.kind === 'untracked') actions.push(`<button class="dv-btn dv-btn-sm" data-blink="${esc(b.name)}">${ICON.link}Link ticket</button>`, `<button class="dv-btn dv-btn-ghost dv-btn-sm" data-bmark="${esc(b.name)}">Mark release</button>`);
    if (w && b.marked_kind === 'release') actions.push(`<button class="dv-btn dv-btn-ghost dv-btn-sm" data-bunmark="${esc(b.name)}">Unmark</button>`);
    if (w && !isBase && b.merged) actions.push(`<button class="dv-btn dv-btn-danger dv-btn-sm" data-bdelete="${esc(b.name)}" title="Everything on it is already on pre-release">${ICON.trash}Delete</button>`);
    return `<div class="dv-brow" data-branch="${esc(b.name)}">
        <div class="dv-bname">${ICON.branch}<a href="${REPO_URL}/tree/${esc(b.name)}" target="_blank" rel="noopener" title="${esc(b.name)}">${esc(b.name)}</a>${b.merged ? '<span class="dv-pill merged" title="Everything on it is on pre-release">Merged</span>' : ''}</div>
        <div class="dv-bkind">${kind}</div>
        <div class="dv-bpr">${pr}</div>
        ${ab}
        <div class="dv-bcommit"><div title="${esc(b.last_commit_message || '')}">${esc(b.last_commit_message || '')}</div><small>${esc(b.last_commit_author || '')}${b.last_commit_at ? ` · ${esc(when(b.last_commit_at))}` : ''}</small></div>
        <div class="dv-bactions">${actions.join('')}</div>
    </div>`;
}
function renderBranches(host) {
    const list = ((S.data && S.data.branches) || []).slice().sort(branchSort);
    const others = list.filter((b) => b.kind !== 'base');
    const untracked = others.filter((b) => b.kind === 'untracked').length;
    const merged = others.filter((b) => b.merged).length;
    const linked = others.filter((b) => b.kind === 'ticket').length;
    host.innerHTML = `<div class="dv-head"><h1>${ICON.branch}Branches <span class="dv-head-count">${list.length}</span></h1>
        <div class="dv-head-tools"><span class="dv-muted" style="font-size:11.5px">Against <span class="dv-mono">pre-release</span>${list[0] && list[0].synced_at ? ` · synced ${esc(when(list[0].synced_at))} ago` : ''}</span>
        <button class="dv-btn dv-btn-sm" data-act="sync" ${S.syncing ? 'disabled' : ''}>${ICON.sync}${S.syncing ? 'Syncing…' : 'Sync'}</button></div></div>
        <div class="dv-scroll" id="dvScroll">
            <div class="dv-stats">
                <div class="dv-stat"><b>${others.length}</b><span>Working branches</span></div>
                <div class="dv-stat ok"><b>${linked}</b><span>On a ticket</span></div>
                <div class="dv-stat${untracked ? ' warn' : ''}"><b>${untracked}</b><span>Need a ticket</span></div>
                <div class="dv-stat"><b>${merged}</b><span>Merged — safe to delete</span></div>
            </div>
            ${list.length ? `<div class="dv-brow head"><span>Branch</span><span>Ticket</span><span class="dv-bpr">PR</span><span>vs pre-release</span><span>Last commit</span><span></span></div>${list.map(branchRowHtml).join('')}`
              : `<div class="dv-empty">${ICON.branch}<b>No branches cached yet</b><span>Press Sync to read them from GitHub.</span></div>`}
        </div>`;
}

// ---- popovers ----------------------------------------------------------------
let pop = null;   // { el, onKey }
function closePop() { if (pop) { pop.el.remove(); pop = null; } }
function place(el, anchor) {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = Math.min(r.left, innerWidth - w - 8), top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
    el.style.left = Math.max(8, left) + 'px';
    el.style.top = top + 'px';
}
// A searchable list. items: [{value, label, html, hint}]; current: value or [values] (multi).
function picker(anchor, { items, current, onPick, multi, placeholder }) {
    closePop();
    const el = document.createElement('div');
    el.className = 'dv-pop';
    el.setAttribute('role', 'listbox');
    el.innerHTML = `<input class="dv-pop-search" placeholder="${esc(placeholder || 'Filter…')}" spellcheck="false"><div class="dv-pop-list"></div>`;
    $('#dvLayer').appendChild(el);
    const input = $('.dv-pop-search', el), listEl = $('.dv-pop-list', el);
    let act = 0, shown = items;
    const isOn = (v) => multi ? (current || []).includes(v) : current === v;
    const draw = () => {
        const q = input.value.trim().toLowerCase();
        shown = items.filter((i) => !q || String(i.label).toLowerCase().includes(q) || String(i.hint || '').toLowerCase().includes(q));
        act = Math.min(act, Math.max(0, shown.length - 1));
        listEl.innerHTML = shown.length ? shown.map((i, n) => `<button class="dv-opt${n === act ? ' act' : ''}" data-n="${n}">${i.html || ''}<span>${esc(i.label)}</span>${isOn(i.value) ? `<svg class="dv-opt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="20 6 9 17 4 12"/></svg>` : i.hint ? `<small>${esc(i.hint)}</small>` : ''}</button>`).join('')
            : `<div class="dv-pop-empty">No matches</div>`;
    };
    const choose = (n) => {
        const i = shown[n];
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
    listEl.addEventListener('mousemove', (e) => { const b = e.target.closest('.dv-opt'); if (b && Number(b.dataset.n) !== act) { act = Number(b.dataset.n); $$('.dv-opt', listEl).forEach((o, k) => o.classList.toggle('act', k === act)); } });
    listEl.addEventListener('click', (e) => { const b = e.target.closest('.dv-opt'); if (b) choose(Number(b.dataset.n)); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); act = Math.min(shown.length - 1, act + 1); draw(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); act = Math.max(0, act - 1); draw(); }
        else if (e.key === 'Enter') { e.preventDefault(); choose(act); }
        else if (e.key === 'Escape' || (e.key === 'Tab')) { e.preventDefault(); e.stopPropagation(); closePop(); }
    });
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

// ---- modals: new ticket, confirm, shortcuts -------------------------------
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
        ['Search', ['/']], ['New ticket', ['C']], ['Move down / up', ['J', 'K']], ['Open ticket', ['Enter']],
        ['Close panel', ['Esc']], ['Set status', ['S']], ['Set assignee', ['A']], ['Set priority', ['P']],
        ['Triage', ['G', 'T']], ['My Work', ['G', 'M']], ['All Open', ['G', 'A']], ['Backlog', ['G', 'B']],
        ['In Progress', ['G', 'I']], ['In Review', ['G', 'R']], ['On Pre-release', ['G', 'P']], ['Done', ['G', 'D']],
        ['Branches', ['G', 'C']], ['Send comment', ['Ctrl', 'Enter']],
    ];
    openModal(`<div class="dv-modal-top">Keyboard shortcuts<button class="dv-icon-btn" data-act="modal-close">${ICON.x}</button></div>
        <div class="dv-modal-body">${rows.map(([l, k]) => `<div class="dv-key"><span>${l}</span><span>${k.map((x) => `<kbd>${x}</kbd>`).join('')}</span></div>`).join('')}</div>`, 'dv-keys');
}

const draft = { status: 'backlog', priority: 'normal', type: 'task', area: '', assignee_id: '', release_id: '' };
function newTicket() {
    if (!canWrite()) { toast('Test accounts can only read.', { bad: true }); return; }
    if (S.view && STATUS[S.view] && !CLOSED.includes(S.view)) draft.status = S.view;
    const types = (S.data.types || []).filter((t) => t.active !== false);
    if (!types.some((t) => t.key === draft.type)) draft.type = (types[0] || {}).key || 'task';
    const m = openModal(`<div class="dv-modal-top">${ICON.plus}New ticket<button class="dv-icon-btn" data-act="modal-close" title="Close (Esc)">${ICON.x}</button></div>
        <div class="dv-modal-body">
            <input class="dv-new-title" id="dvNewTitle" placeholder="Ticket title" maxlength="200" autocomplete="off">
            <textarea class="dv-new-desc" id="dvNewDesc" placeholder="Add a description…"></textarea>
        </div>
        <div class="dv-new-props" id="dvNewProps"></div>
        <div class="dv-modal-foot"><span><kbd>Ctrl</kbd> <kbd>Enter</kbd> to create</span>
            <button class="dv-btn dv-btn-ghost" data-act="modal-close">Cancel</button>
            <button class="dv-btn dv-btn-primary" data-act="new-create" id="dvNewCreate">Create ticket</button></div>`);
    drawDraftProps();
    const title = $('#dvNewTitle', m), desc = $('#dvNewDesc', m);
    title.focus();
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
    const rel = release(draft.release_id);
    host.innerHTML = `
        <button class="dv-chipsel" data-npick="status">${stIcon(draft.status)}${esc(STATUS[draft.status].label)}</button>
        <button class="dv-chipsel" data-npick="priority">${priIcon(draft.priority)}${esc(PRIORITY[draft.priority].label)}</button>
        <button class="dv-chipsel" data-npick="type">${ICON.tag}${esc(labelOf('types', draft.type))}</button>
        <button class="dv-chipsel" data-npick="area">${ICON.box}${esc(draft.area ? labelOf('areas', draft.area) : 'Area')}</button>
        <button class="dv-chipsel" data-npick="assignee">${dev ? avatar(dev.name) : ICON.user}${esc(dev ? dev.name : 'Assignee')}</button>
        <button class="dv-chipsel" data-npick="release">${ICON.layers}${esc(rel ? releaseLabel(rel) : 'Release')}</button>`;
}
async function createTicket() {
    const title = ($('#dvNewTitle') || {}).value || '';
    if (!title.trim()) { $('#dvNewTitle').focus(); toast('Give it a title first.', { bad: true }); return; }
    const btn = $('#dvNewCreate');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
        const r = await post({ action: 'create', title: title.trim(), description: $('#dvNewDesc').value, type: draft.type, area: draft.area || null,
            priority: draft.priority, status: draft.status, assignee_id: draft.assignee_id || null, release_id: draft.release_id || null, stores: [] });
        closeModal();
        Object.assign(draft, { area: '', assignee_id: '', release_id: '' });
        await load(true);
        if (r.ticket) {
            if (!inView(r.ticket, S.view) && !S.query) setView(r.ticket.status === 'triage' ? 'triage' : 'open');
            open(r.ticket.id);
        }
        toast(`Created SN-${r.ticket && r.ticket.id}`);
    } catch (e) {
        btn.disabled = false; btn.textContent = 'Create ticket';
        toast(`Couldn't create it — ${e.message}`, { bad: true });
    }
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
async function optimistic(t, patch, payload, okMsg) {
    const before = {};
    for (const k of Object.keys(patch)) before[k] = t[k];
    Object.assign(t, patch, { updated_at: new Date().toISOString() });
    renderList(); renderPanel(); renderSide();
    try {
        const r = await post(payload);
        if (r.ticket) Object.assign(t, r.ticket, { assignee_name: r.ticket.assignee_name ?? t.assignee_name });
        if (okMsg) toast(okMsg);
        load(true);   // events, history
    } catch (e) {
        Object.assign(t, before);
        renderList(); renderPanel(); renderSide();
        toast(`Not saved — ${e.message}`, { bad: true });
    }
}
function saveTitle(t, text) {
    const v = String(text || '').replace(/\s+/g, ' ').trim();
    if (!v) { renderPanel(); return; }
    if (v === t.title) return;
    optimistic(t, { title: v }, { action: 'edit', id: t.id, title: v });
}
function setStatus(t, to, note) {
    if (to === t.status) return;
    optimistic(t, { status: to, closed_at: CLOSED.includes(to) ? new Date().toISOString() : null }, { action: 'status', id: t.id, to, note: note || null },
        `SN-${t.id} → ${STATUS[to].label}`);
}

function pickFor(t, kind, anchor) {
    if (!canWrite()) return;
    const items = {
        status: () => STATUS_ORDER.map((k) => ({ value: k, label: STATUS[k].label, html: stIcon(k) })),
        priority: () => PRIORITY_ORDER.map((k) => ({ value: k, label: PRIORITY[k].label, html: priIcon(k) })),
        assignee: () => [{ value: '', label: 'Unassigned', html: avatar('') }].concat((S.data.devs || []).map((d) => ({ value: d.id, label: d.name, html: avatar(d.name), hint: d.store }))),
        type: () => (S.data.types || []).filter((x) => x.active !== false).map((x) => ({ value: x.key, label: x.label, html: ICON.tag, hint: x.dev_only ? 'dev' : '' })),
        area: () => [{ value: '', label: 'No area', html: ICON.box }].concat((S.data.areas || []).filter((x) => x.active !== false).map((x) => ({ value: x.key, label: x.label, html: ICON.box }))),
        release: () => [{ value: '', label: 'No release', html: ICON.layers }].concat((S.data.releases || []).filter((r) => r.status !== 'published' || Number(r.id) === Number(t.release_id)).map((r) => ({ value: String(r.id), label: releaseLabel(r), html: ICON.layers, hint: r.status === 'published' ? 'shipped' : '' }))),
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
    const current = kind === 'assignee' ? String(t.assignee_id || '') : kind === 'release' ? String(t.release_id || '') : kind === 'stores' ? (t.stores || []) : (t[kind] || '');
    picker(anchor, {
        items: items[kind](), current, multi: kind === 'stores', placeholder: `Set ${kind}…`,
        onPick: (v) => {
            if (kind === 'status') {
                if (v === 'wont_do') return wontDo(t, anchor);
                return setStatus(t, v);
            }
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
            const field = kind === 'release' ? 'release_id' : kind;
            const value = kind === 'release' ? (v ? Number(v) : null) : (v || null);
            if (String(t[field] ?? '') === String(value ?? '')) return;
            optimistic(t, { [field]: value }, { action: 'edit', id: t.id, [field]: value });
        },
    });
}
function wontDo(t, anchor) {
    formPop(anchor, `<label for="dvWhy">Why won't it be done? <span class="dv-muted">Whoever raised it reads this.</span></label>
        <textarea id="dvWhy" placeholder="e.g. Already handled by the eBay page"></textarea>
        <div style="display:flex;gap:6px;justify-content:flex-end"><button class="dv-btn dv-btn-ghost dv-btn-sm" data-why="cancel">Cancel</button><button class="dv-btn dv-btn-primary dv-btn-sm" data-why="go">Mark Won't Do</button></div>`, (el) => {
        const ta = $('#dvWhy', el);
        ta.focus();
        const go = () => { const note = ta.value.trim(); if (!note) { ta.focus(); return; } closePop(); setStatus(t, 'wont_do', note); };
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

// ---- GitHub actions (github-webhook) ------------------------------------
async function sync() {
    if (S.syncing) return;
    S.syncing = true; renderSide(); if (S.view === 'branches') renderList();
    try {
        const r = await ghPost({ action: 'reconcile' });
        const bits = [];
        if (r.linked) bits.push(`${r.linked} linked`);
        if ((r.moved || []).length) bits.push(`${r.moved.length} moved`);
        toast(`Synced with GitHub — ${bits.length ? bits.join(', ') : 'nothing new'}`);
        await load(true);
    } catch (e) { toast(`Sync failed — ${e.message}`, { bad: true }); }
    finally { S.syncing = false; renderSide(); if (S.view === 'branches') renderList(); }
}
async function startWork(t) {
    const prefix = S.startPrefix || prefixFor(t.type);
    const slug = S.startSlug || slugify(t.title);
    const btn = $('[data-act="start-go"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
    try {
        const r = await ghPost({ action: 'start_work', ticket_id: t.id, prefix, slug });
        S.startOpen = false; S.startSlug = ''; S.startPrefix = null;
        await load(true);
        toast(`Created ${r.branch}`, { action: { label: 'Copy git command', fn: () => copy(`git fetch origin && git switch ${r.branch}`, 'Command copied') } });
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Create branch from pre-release'; }
        toast(e.message, { bad: true });
    }
}
async function branchAct(action, name, extra) {
    try {
        await ghPost(Object.assign({ action, name }, extra || {}));
        await load(true);
        toast(action === 'delete_branch' ? `Deleted ${name}` : action === 'link_branch' ? `Linked ${name}` : `Updated ${name}`);
    } catch (e) { toast(e.message, { bad: true }); }
}

// ---- views + hash ----------------------------------------------------------
function setView(v) {
    if (!VIEWS.some((x) => x.key === v)) return;
    S.view = v; S.selId = null;
    if (S.query) { S.query = ''; const s = $('#dvSearch'); if (s) s.value = ''; }
    store.set('view', v);
    renderSide(); renderList();
    const scroll = $('#dvScroll'); if (scroll) scroll.scrollTop = 0;
    syncHash();
}
// replaceState, not location.hash =: no history entries, no navigation (a
// hash assignment is one, and hung the headless checks — see the handoff).
function syncHash() {
    const h = S.openId != null ? `#SN-${S.openId}` : S.view ? `#${S.view}` : '';
    if (location.hash !== h) { try { history.replaceState(null, '', location.pathname + location.search + h); } catch (_) {} }
}
function openFromHash() {
    const m = /^#(?:SN-)?(\d+)$/i.exec(location.hash || '');
    if (m && ticket(m[1])) open(Number(m[1]));
}

// ---- events (one delegated handler) -------------------------------------
function onClick(e) {
    if (!e.target || !e.target.closest) return;
    const el = e.target.closest('[data-act],[data-view],[data-id],[data-pick],[data-filter],[data-clear],[data-npick],[data-prefix],[data-open],[data-copy],[data-blink],[data-bmark],[data-bunmark],[data-bdelete]');
    if (!el) { if (pop && !e.target.closest('.dv-pop')) closePop(); return; }
    if (pop && !el.closest('.dv-pop')) closePop();
    const t = S.openId != null ? ticket(S.openId) : null;
    const d = el.dataset;
    if (d.clear) { e.stopPropagation(); S.filters[d.clear] = ''; renderList(); renderSide(); return; }
    if (d.view) return setView(d.view);
    if (d.open) return open(Number(d.open));
    if (d.id && el.classList.contains('dv-row')) return open(Number(d.id));
    if (d.copy) return copy(d.copy, 'Command copied');
    if (d.pick && t) return pickFor(t, d.pick, el);
    if (d.prefix) { S.startPrefix = d.prefix; renderPanel(); return; }
    if (d.filter) return filterPick(d.filter, el);
    if (d.npick) return draftPick(d.npick, el);
    if (d.blink) return linkBranchPick(d.blink, el);
    if (d.bmark) return branchAct('mark_branch', d.bmark, { release: true });
    if (d.bunmark) return branchAct('mark_branch', d.bunmark, { release: false });
    if (d.bdelete) {
        const b = ((S.data && S.data.branches) || []).find((x) => x.name === d.bdelete);
        return confirmDialog({ title: `Delete ${d.bdelete}?`, body: `Everything on it is already on <span class="dv-mono">pre-release</span>, so no work is lost${b && b.pr_number ? ` (PR #${b.pr_number} stays on GitHub)` : ''}. The branch is removed from GitHub.`, ok: 'Delete branch', danger: true })
            .then((yes) => { if (yes) branchAct('delete_branch', d.bdelete); });
    }
    switch (d.act) {
        case 'new': return newTicket();
        case 'new-create': return createTicket();
        case 'modal-close': return closeModal();
        case 'keys': return shortcuts();
        case 'sync': return sync();
        case 'retry': S.gate = null; $('#dvApp').innerHTML = '<div class="dv-boot"><div class="dv-boot-mark"></div></div>'; return load();
        case 'close': return closePanel();
        case 'copy-link': return t && copy(`${location.origin}${location.pathname}#SN-${t.id}`, `Link to SN-${t.id} copied`);
        case 'desc-edit': S.editingDesc = true; return renderPanel();
        case 'desc-cancel': S.editingDesc = false; return renderPanel();
        case 'desc-save': return t && saveDesc(t);
        case 'start': S.startOpen = true; S.startPrefix = null; S.startSlug = ''; renderPanel(); { const s = $('#dvSlug'); if (s) { s.focus(); s.select(); } } return;
        case 'start-cancel': S.startOpen = false; return renderPanel();
        case 'start-go': return t && startWork(t);
        case 'comment': return t && sendComment(t);
        case 'comment-edit': S.editingComment = Number(d.cid); renderPanel(); { const ta = $('#dvCommentEdit'); if (ta) ta.focus(); } return;
        case 'comment-cancel': S.editingComment = null; return renderPanel();
        case 'comment-save': return t && saveComment(t, d.cid);
    }
}
function saveDesc(t) {
    const v = ($('#dvDescEdit') || {}).value;
    S.editingDesc = false;
    if (v === undefined || v === (t.description || '')) { renderPanel(); return; }
    optimistic(t, { description: v }, { action: 'edit', id: t.id, description: v });
}
function filterPick(kind, anchor) {
    const items = kind === 'area'
        ? [{ value: '', label: 'Any area' }].concat((S.data.areas || []).map((a) => ({ value: a.key, label: a.label, html: ICON.box })), [{ value: '__none', label: 'No area' }])
        : kind === 'type'
        ? [{ value: '', label: 'Any type' }].concat((S.data.types || []).map((x) => ({ value: x.key, label: x.label, html: ICON.tag })))
        : [{ value: '', label: 'Anyone' }].concat((S.data.devs || []).map((x) => ({ value: x.id, label: x.name, html: avatar(x.name) })), [{ value: '__none', label: 'Unassigned', html: avatar('') }]);
    picker(anchor, { items, current: S.filters[kind], onPick: (v) => { S.filters[kind] = v; S.selId = null; renderList(); renderSide(); } });
}
function draftPick(kind, anchor) {
    const items = {
        status: ['triage', 'backlog', 'in_progress'].map((k) => ({ value: k, label: STATUS[k].label, html: stIcon(k) })),
        priority: PRIORITY_ORDER.map((k) => ({ value: k, label: PRIORITY[k].label, html: priIcon(k) })),
        type: (S.data.types || []).filter((x) => x.active !== false).map((x) => ({ value: x.key, label: x.label, html: ICON.tag })),
        area: [{ value: '', label: 'No area' }].concat((S.data.areas || []).filter((x) => x.active !== false).map((x) => ({ value: x.key, label: x.label, html: ICON.box }))),
        assignee: [{ value: '', label: 'Unassigned', html: avatar('') }].concat((S.data.devs || []).map((d) => ({ value: d.id, label: d.name, html: avatar(d.name) }))),
        release: [{ value: '', label: 'No release' }].concat((S.data.releases || []).filter((r) => r.status !== 'published').map((r) => ({ value: String(r.id), label: releaseLabel(r), html: ICON.layers }))),
    }[kind];
    const field = kind === 'assignee' ? 'assignee_id' : kind === 'release' ? 'release_id' : kind;
    picker(anchor, { items, current: draft[field], onPick: (v) => { draft[field] = v; drawDraftProps(); const ti = $('#dvNewTitle'); if (ti) ti.focus(); } });
}
function linkBranchPick(name, anchor) {
    const m = /sn-?(\d+)/i.exec(name);
    const items = ((S.data && S.data.tickets) || []).filter((t) => !CLOSED.includes(t.status))
        .sort((a, b) => Number(b.id) - Number(a.id))
        .map((t) => ({ value: String(t.id), label: `SN-${t.id} ${t.title}`, html: stIcon(t.status) }));
    picker(anchor, { items, current: m ? m[1] : '', placeholder: 'Find a ticket…', onPick: (v) => branchAct('link_branch', name, { ticket_id: Number(v) }) });
}

let goPending = 0;
function onKey(e) {
    if (modal || S.gate) return;
    const target = e.target && e.target.closest ? e.target : document.body;   // a key sent to document has no element
    const typing = target.closest('input, textarea, [contenteditable]');
    if (typing) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            const t = S.openId != null ? ticket(S.openId) : null;
            if (e.target.id === 'dvComposer' && t) { e.preventDefault(); sendComment(t); }
            if (e.target.id === 'dvDescEdit' && t) { e.preventDefault(); saveDesc(t); }
            if (e.target.id === 'dvCommentEdit' && t) { e.preventDefault(); saveComment(t, S.editingComment); }
            if (e.target.id === 'dvSlug' && t) { e.preventDefault(); startWork(t); }
        }
        if (e.key === 'Enter' && e.target.id === 'dvSlug') { e.preventDefault(); const t = ticket(S.openId); if (t) startWork(t); }
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
    const k = e.key;
    if (Date.now() < goPending) {
        goPending = 0;
        const v = GO_KEYS[k.toLowerCase()];
        if (v) { e.preventDefault(); setView(v); }
        return;
    }
    const t = S.openId != null ? ticket(S.openId) : (S.selId != null ? ticket(S.selId) : null);
    switch (k) {
        case '/': e.preventDefault(); $('#dvSearch').focus(); $('#dvSearch').select(); return;
        case 'c': case 'C': e.preventDefault(); return newTicket();
        case 'g': case 'G': goPending = Date.now() + 900; return;
        case 'j': case 'ArrowDown': e.preventDefault(); return moveSel(1);
        case 'k': case 'ArrowUp': e.preventDefault(); return moveSel(-1);
        case 'Enter': case 'o': if (S.selId != null) { e.preventDefault(); open(S.selId); } return;
        case 'Escape': if (S.openId != null) return closePanel(); if (S.query) { S.query = ''; $('#dvSearch').value = ''; renderList(); renderSide(); } return;
        case '?': e.preventDefault(); return shortcuts();
        case 's': case 'a': case 'p': {
            if (!t) return;
            if (S.openId !== Number(t.id)) open(t.id);
            const kind = { s: 'status', a: 'assignee', p: 'priority' }[k];
            const anchor = $(`.dv-prop[data-pick="${kind}"]`);
            if (anchor) { e.preventDefault(); pickFor(ticket(S.openId), kind, anchor); }
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
function boot() {
    let ok = false;
    try { ok = sessionStorage.getItem('speeksUnlocked') === 'true' && !!pin(); } catch (_) {}
    if (!ok) { location.replace('index.html'); return; }
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    load().then(() => { if (S.data) openFromHash(); });
    startRealtime();
    // A tab left open overnight: refresh on return rather than show stale work.
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.data) load(true); });
}

// For the checks — the app's internals, not an API.
window.Dev = {
    S, idx, setData, renderAll, renderShell, renderList, renderPanel, renderSide, open, closePanel, setView, moveSel,
    visibleTickets, counts, inView, matchesQuery, rowOrder, stIcon, priIcon, prefixFor, slugify, eventText, onClick, onKey,
    picker, closePop, newTicket, closeModal, toast, optimistic, setStatus, pickFor, openFromHash, syncHash, branchSort,
    load, stub: (fn) => { stub = fn; },
};
// Checks set window.DEV_NO_BOOT before DOMContentLoaded; the page never does.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { if (!window.DEV_NO_BOOT) boot(); });
else if (!window.DEV_NO_BOOT) boot();
})();
