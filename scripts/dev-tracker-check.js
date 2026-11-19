// DEVELOPMENT TRACKER — behaviour checks (docs/plans/dev-tracker-HANDOFF.md).
//
//   powershell -File scripts/browser-check.ps1 dev-tracker-check.js -Js dev.js -Css dev.css
//
// Phase 1 is the data model (migration 0188) and the dev-tickets edge function;
// the only browser-side piece so far is Feature Access. These pin down D2 —
// dev access is a per-person grant, not a role — because a role default here
// would quietly hand the tracker (and later, Publish) to every DM, CEO or
// manager the day a new one is hired. The dev-tickets function holds the same
// defaults (DEFAULTS there): if one of these fails after a deliberate change,
// change the function too.
//
// Phase 3 adds the page and the header button; its checks go in this file
// (behaviour), dev-tracker-layout-check.js and a -Html one, as Projects does.

_featureOv = { role: {}, user: {} };

var EVERY_ROLE = ['ceo', 'district-manager', 'mocd', 'owner-manager', 'manager', 'assistant-manager', 'employee', 'store'];
function sees(key, role, name) { return _featureEffectiveVisible(key, 'role-' + role, name || 'Someone'); }
function entry(key) { return FEATURE_CATALOG.filter(function (f) { return f.key === key; })[0]; }

t('catalog: dev-tracker is listed, next to the settings cog it will sit beside', function () {
    var e = entry('dev-tracker');
    if (!e) return 'no dev-tracker entry in FEATURE_CATALOG';
    return (e.tab === 'hotbar' && e.group === 'Top Bar') || 'filed under ' + e.tab + ' / ' + e.group;
});
t('catalog: dev-release-publish is listed', function () {
    return !!entry('dev-release-publish') || 'no dev-release-publish entry in FEATURE_CATALOG';
});
t('access: no role gets the tracker by default — not even the DM', function () {
    var who = EVERY_ROLE.filter(function (r) { return sees('dev-tracker', r); });
    return !who.length || 'on by default for: ' + who.join(', ');
});
t('access: no role can publish a release by default', function () {
    var who = EVERY_ROLE.filter(function (r) { return sees('dev-release-publish', r); });
    return !who.length || 'on by default for: ' + who.join(', ');
});
t('access: a per-person grant switches the tracker on for that person only', function () {
    // feature-access writes the subject lower-cased; 0188 seeds Nick and Ethan this way.
    _featureOv = { role: {}, user: { 'dev-tracker': { 'nick hettinger': true, 'ethan kushnir': true } } };
    try {
        if (!sees('dev-tracker', 'manager', 'Nick Hettinger')) return 'Nick (a manager) not granted';
        if (!sees('dev-tracker', 'district-manager', 'Ethan Kushnir')) return 'Ethan (the DM) not granted';
        if (sees('dev-tracker', 'district-manager', 'Ethan Frye')) return 'another Ethan was granted by first name';
        if (sees('dev-tracker', 'manager', 'Someone Else')) return 'leaked to another manager';
        return true;
    } finally { _featureOv = { role: {}, user: {} }; }
});
t('access: the tracker grant does not carry publish with it', function () {
    _featureOv = { role: {}, user: { 'dev-tracker': { 'nick hettinger': true } } };
    try {
        return !sees('dev-release-publish', 'manager', 'Nick Hettinger') || 'holding dev-tracker also granted publish';
    } finally { _featureOv = { role: {}, user: {} }; }
});
t('access: a per-person "off" beats a role grant', function () {
    _featureOv = { role: { 'dev-tracker': { 'district-manager': true } }, user: { 'dev-tracker': { 'ethan kushnir': false } } };
    try {
        if (!sees('dev-tracker', 'district-manager', 'Someone')) return 'role grant ignored';
        return !sees('dev-tracker', 'district-manager', 'Ethan Kushnir') || 'user override did not win over the role';
    } finally { _featureOv = { role: {}, user: {} }; }
});

t('header button: shown to a dev-tracker holder, hidden from everyone else', function () {
    document.body.insertAdjacentHTML('beforeend', '<div class="action-btn dev-nav-btn" id="devBtnProbe" data-feature-any="dev-tracker" style="display:none;"></div>');
    var btn = document.getElementById('devBtnProbe');
    _featureOv = { role: {}, user: { 'dev-tracker': { 'nick hettinger': true } } };
    try {
        _applyFeatureOverridesToPlainEls('role-manager', 'Nick Hettinger');
        if (btn.style.display === 'none') return 'hidden from Nick';
        _applyFeatureOverridesToPlainEls('role-district-manager', 'Someone Else');
        if (btn.style.display !== 'none') return 'shown to a DM without the grant';
        _featureOv = { role: {}, user: {} };
        _applyFeatureOverridesToPlainEls('role-ceo', 'Paul');
        return btn.style.display === 'none' || 'shown to the CEO by default';
    } finally { _featureOv = { role: {}, user: {} }; btn.remove(); }
});

// ============================================================================
// THE SUITE (dev.html = dev.js + dev.css, 2026-11-19). Run with
//   -Js dev.js -Css dev.css
// dev.js would boot on DOMContentLoaded — sign-in check, network, realtime — so
// DEV_NO_BOOT stops it; these drive window.Dev against a fixture instead.
//
// The network is swapped ONCE, here (CLAUDE.md's _b2bSend rule): writes are
// optimistic and their confirmation lands in a promise long after a per-test
// stub would have been put back. POSTs are recorded and answered; a GET never
// answers, so no stray reload can swap the fixture out from under a later test.
// ============================================================================
window.DEV_NO_BOOT = true;
var DV_SENT = [];
var DV_FAIL = false;
Dev.stub(function (url, body) {
    if (body === undefined) return new Promise(function () {});
    DV_SENT.push({ url: url, body: body });
    if (DV_FAIL) return Promise.reject(new Error('the server said no'));
    return Promise.resolve({ success: true });
});
function last() { return DV_SENT[DV_SENT.length - 1] || {}; }

function dvFixture(opts) {
    var day = 86400000, now = Date.now();
    var T = function (id, status, extra) {
        var b = { id: id, title: 'Ticket ' + id, description: 'What is wrong.', type: 'bug', area: 'b2b', priority: 'normal', status: status,
            assignee_id: null, assignee_name: null, reporter_id: 'e', reporter_name: 'Ethan Kushnir', reporter_store: 'CORP', stores: [],
            release_id: null, due: null, source: 'dev', github_number: null, closed_at: null, attachments: [],
            created_at: new Date(now - 5 * day).toISOString(), updated_at: new Date(now - id * 1000).toISOString() };
        for (var k in extra) b[k] = extra[k];
        return b;
    };
    return {
        me: { id: 'n', name: 'Nick Hettinger', role: 'Manager', test: !!(opts && opts.test) },
        can: { dev: true, publish: false },
        devs: [{ id: 'e', name: 'Ethan Kushnir', store: 'CORP', role: 'District Manager' }, { id: 'n', name: 'Nick Hettinger', store: 'OVL', role: 'Manager' }],
        types: [{ key: 'bug', label: 'Bug', active: true }, { key: 'suggestion', label: 'Suggestion', active: true }, { key: 'task', label: 'Task', active: true }],
        areas: [{ key: 'b2b', label: 'B2B', active: true }, { key: 'claims', label: 'Claims', active: true }],
        releases: [{ id: 1, version: null, title: 'Main December Update', status: 'in_progress' }],
        tickets: [
            T(1000, 'triage', { source: 'idea', attachments: [{ name: 'photo.jpg', url: 'https://example.invalid/signed' }, { name: 'old.pdf', url: null }] }),
            T(1001, 'backlog', { priority: 'low' }),
            T(1002, 'backlog', { priority: 'urgent', assignee_id: 'n', assignee_name: 'Nick Hettinger' }),
            T(1003, 'in_progress', { area: 'claims', type: 'suggestion', title: 'Sort the B2B list by brand' }),
            T(573, 'done', { source: 'github_import', github_number: 573, closed_at: new Date(now - day).toISOString() }),
            T(66, 'wont_do', { source: 'github_import', github_number: 66, closed_at: new Date(now - 2 * day).toISOString(), title: 'Test 1' }),
        ],
        events: [
            { id: 1, ticket_id: 66, kind: 'created', actor_name: 'Nick Hettinger', created_at: new Date(now - 9 * day).toISOString() },
            { id: 2, ticket_id: 66, kind: 'status', actor_name: 'GitHub', from_value: 'backlog', to_value: 'wont_do', note: 'Closed on GitHub as not planned', created_at: new Date(now - 2 * day).toISOString() },
            { id: 3, ticket_id: 1003, kind: 'linked', actor_name: 'GitHub', to_value: 'pr', note: 'PR #612', created_at: new Date(now - 3 * day).toISOString() },
        ],
        comments: [
            { id: 10, ticket_id: 1003, body: 'Mine to fix.', author_name: 'Nick Hettinger', author_id: 'n', source: 'speeksnet', created_at: new Date(now - day).toISOString() },
            { id: 11, ticket_id: 1003, body: 'From GitHub.', author_name: 'Ethan Kushnir', author_id: 'e', source: 'github', created_at: new Date(now - 4 * day).toISOString() },
        ],
        links: [
            { id: 1, ticket_id: 1003, kind: 'commit', ref: 'abcdef1234567890', url: 'https://github.com/x/commit/abcdef1', title: 'Sort SN-1003' },
            { id: 2, ticket_id: 1003, kind: 'branch', ref: 'feat/sn-1003-sort', url: 'https://github.com/x/tree/feat/sn-1003-sort', state: 'active' },
            { id: 3, ticket_id: 1003, kind: 'pr', ref: '612', url: 'https://github.com/x/pull/612', title: 'B2B sort by brand', state: 'open', base: 'pre-release', author: 'Eckushnir',
              checks: [
                  { kind: 'migration', level: 'error', text: '0192 is already used in the database by 0192_dev_github_sync' },
                  { kind: 'buster', level: 'warn', text: 'speeks.js changed but no cache-buster was bumped' },
                  { kind: 'function', level: 'todo', text: 'Deploy the b2b-deals function' },
                  { kind: 'migration', level: 'ok', text: '0193_x — applied' },
                  { kind: 'migration', level: 'warn', text: '<img src=x onerror=alert(1)>' },
              ] },
        ],
        branches: [
            { name: 'feat/sn-1003-sort', kind: 'ticket', ticket_id: 1003, ahead: 2, behind: 0, merged: false, pr_number: 612, pr_state: 'open', last_commit_message: 'Sort', last_commit_author: 'back707', last_commit_at: new Date(now - day).toISOString() },
            { name: 'main', kind: 'base', ahead: 6, behind: 9, merged: false, last_commit_at: new Date(now - 7 * day).toISOString() },
            { name: 'Main-December-Update-2---Ethan', kind: 'untracked', ahead: 17, behind: 10, merged: false, pr_number: 576, pr_state: 'open', last_commit_at: new Date(now - 2 * day).toISOString() },
            { name: 'feat/projects-completion-signoff', kind: 'untracked', ahead: 0, behind: 1, merged: true, pr_number: 581, pr_state: 'merged', last_commit_at: new Date(now - 3 * day).toISOString() },
            { name: 'pre-release', kind: 'base', ahead: 0, behind: 0, merged: false, last_commit_at: new Date(now - day).toISOString() },
            { name: 'release/v3.13.0', kind: 'release', marked_kind: 'release', marked_by: 'Ethan Kushnir', ahead: 4, behind: 0, merged: false, last_commit_at: new Date(now - day).toISOString() },
        ],
    };
}
function dvStage(view, opts) {
    ['dvApp', 'dvLayer', 'dvToasts'].forEach(function (id) {
        if (!document.getElementById(id)) { var d = document.createElement('div'); d.id = id; document.body.appendChild(d); }
    });
    document.getElementById('dvApp').className = 'dv-app';
    document.getElementById('dvApp').innerHTML = '';
    Dev.closePop(); Dev.closeModal();
    Dev.setData(dvFixture(opts));
    Dev.S.view = view || 'open'; Dev.S.query = ''; Dev.S.openId = null; Dev.S.selId = null;
    Dev.S.filters = { area: '', type: '', assignee: '' }; Dev.S.startOpen = false; Dev.S.editingDesc = false; Dev.S.editingComment = null;
    Dev.renderShell(); Dev.renderAll();
    return document.getElementById('dvApp');
}
function ids() { return Array.prototype.map.call(document.querySelectorAll('.dv-row'), function (r) { return r.getAttribute('data-id'); }).join(','); }
// The page attaches Dev.onKey to document at boot, which the harness skips —
// so a key goes straight to the handler, with the target it would have had.
function key(k, target) {
    var e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'target', { value: target || document.body });
    Dev.onKey(e);
}

t('suite: boots nothing in the harness (DEV_NO_BOOT) and exposes Dev', function () {
    return (typeof Dev === 'object' && typeof Dev.renderAll === 'function') || 'no window.Dev';
});
t('views: the sidebar counts every view, Triage hot when something waits', function () {
    dvStage('open');
    var c = Dev.counts();
    if (c.triage !== 1 || c.backlog !== 2 || c.in_progress !== 1 || c.closed !== 2 || c.open !== 4 || c.mine !== 1) return JSON.stringify(c);
    var hot = document.querySelector('.dv-nav[data-view="triage"] .dv-nav-count.hot');
    return (hot && hot.textContent === '1') || 'triage count not flagged';
});
t('views: Branches counts the branches that need a ticket', function () {
    dvStage('open');
    return Dev.counts().branches === 2 || 'branches: ' + Dev.counts().branches;
});
t('list: urgent first, low last, within a view', function () {
    dvStage('backlog');
    return ids() === '1002,1001' || 'order ' + ids();
});
t('list: All Open is grouped by status, in workflow order', function () {
    dvStage('open');
    var g = Array.prototype.map.call(document.querySelectorAll('.dv-group'), function (x) { return x.textContent.replace(/\d+$/, '').trim(); }).join('|');
    return g === 'Triage|Backlog|In Progress' || g;
});
t("list: Done holds Done and Won't Do, most recently closed first", function () {
    dvStage('closed');
    return ids() === '573,66' || 'order ' + ids();
});
t('list: My Work is what is assigned to me', function () {
    dvStage('mine');
    return ids() === '1002' || ids();
});
t('search: "SN-573", "#573" and "573" all find the imported ticket, across every view', function () {
    dvStage('triage');
    var bad = ['SN-573', '#573', '573', 'sn573'].filter(function (q) { Dev.S.query = q; Dev.renderList(); return ids() !== '573'; });
    return !bad.length || 'missed: ' + bad.join(', ');
});
t('search: words match title, description and people', function () {
    dvStage('open');
    Dev.S.query = 'brand sort'; Dev.renderList();
    if (ids() !== '1003') return 'words: ' + ids();
    Dev.S.query = 'ethan'; Dev.renderList();
    return ids().split(',').length === 6 || 'reporter: ' + ids();
});
t('filters: area, "No area", and assignee narrow the list', function () {
    dvStage('open');
    Dev.S.filters.area = 'claims'; Dev.renderList();
    if (ids() !== '1003') return 'claims: ' + ids();
    Dev.S.filters.area = ''; Dev.S.filters.assignee = 'n'; Dev.renderList();
    if (ids() !== '1002') return 'mine: ' + ids();
    Dev.S.filters.assignee = '__none'; Dev.renderList();
    return ids() === '1000,1001,1003' || 'unassigned: ' + ids();
});
t('list: what people typed is escaped', function () {
    dvStage('backlog');
    Dev.idx.byId.get(1001).title = '<img src=x onerror=alert(1)>'; Dev.renderList();
    return !document.querySelector('.dv-row img') || 'a title became markup';
});
t('keys: J/K move the selection, Enter opens, J then follows in the panel, Esc closes', function () {
    dvStage('backlog');
    key('j'); if (Dev.S.selId !== 1002) return 'first j: ' + Dev.S.selId;
    key('j'); if (Dev.S.selId !== 1001) return 'second j: ' + Dev.S.selId;
    key('k'); key('Enter');
    if (Dev.S.openId !== 1002 || !document.querySelector('.dv-panel')) return 'Enter did not open 1002';
    key('j'); if (Dev.S.openId !== 1001) return 'panel did not follow: ' + Dev.S.openId;
    key('Escape');
    return (Dev.S.openId === null && !document.querySelector('.dv-panel')) || 'Esc left the panel open';
});
t('keys: G then a letter switches view; typing in a box is left alone', function () {
    dvStage('open');
    key('g'); key('c');
    if (Dev.S.view !== 'branches') return 'g c went to ' + Dev.S.view;
    key('g'); key('t');
    if (Dev.S.view !== 'triage') return 'g t went to ' + Dev.S.view;
    key('j', document.getElementById('dvSearch'));
    return Dev.S.selId === null || 'a j typed in search moved the selection';
});
t('keys: ? opens the shortcuts sheet', function () {
    dvStage('open'); key('?');
    var ok = !!document.querySelector('.dv-keys');
    Dev.closeModal();
    return ok || 'no shortcuts sheet';
});

t('panel: an imported ticket says where it came from; Submit a Ticket says so too', function () {
    dvStage('closed'); Dev.open(573);
    if (!/was #573/.test(document.querySelector('.dv-panel-id').textContent)) return 'no import note';
    Dev.open(1000);
    return /from Submit a Ticket/.test(document.querySelector('.dv-panel-id').textContent) || 'no intake note';
});
t("panel: Won't Do shows its reason at the top", function () {
    dvStage('closed'); Dev.open(66);
    var c = document.querySelector('.dv-callout');
    return (c && /not planned/.test(c.textContent)) || 'no reason callout';
});
t('panel: attachments link out; an expired one says so', function () {
    dvStage('triage'); Dev.open(1000);
    var a = document.querySelector('.dv-file[href="https://example.invalid/signed"]');
    if (!a || !/photo\.jpg/.test(a.textContent)) return 'no link';
    var dead = Array.prototype.filter.call(document.querySelectorAll('span.dv-file'), function (s) { return /old\.pdf/.test(s.textContent); })[0];
    return (dead && /expired/.test(dead.title)) || 'unsigned attachment not explained';
});
t('panel: the title edits in place for a dev, not for a test account', function () {
    dvStage('backlog'); Dev.open(1001);
    if (document.getElementById('dvTitle').getAttribute('contenteditable') !== 'plaintext-only') return 'not editable for a dev';
    if (document.querySelector('.dv-prop[data-pick="status"]').disabled) return 'status locked for a dev';
    dvStage('backlog', { test: true }); Dev.open(1001);
    if (document.getElementById('dvTitle').hasAttribute('contenteditable')) return 'editable for a test account';
    if (!document.querySelector('.dv-prop[data-pick="status"]').disabled) return 'status open to a test account';
    return !!document.querySelector('.dv-readonly') || 'no read-only badge';
});
t('panel: Code lists the PR first, with every check by level, then the branch, then the commit', function () {
    dvStage('open'); Dev.open(1003);
    var kinds = Array.prototype.map.call(document.querySelectorAll('.dv-code-item .dv-code-line'), function (l) {
        return /#612/.test(l.textContent) ? 'pr' : /feat\/sn-1003/.test(l.textContent) ? 'branch' : /abcdef1/.test(l.textContent) ? 'commit' : '?';
    }).join(',');
    if (kinds !== 'pr,branch,commit') return kinds;
    var lv = Array.prototype.map.call(document.querySelectorAll('.dv-check'), function (c) { return c.className.replace('dv-check ', ''); }).join(',');
    if (lv !== 'error,warn,todo,ok,warn') return 'levels ' + lv;
    return !document.querySelector('.dv-checks img') || 'a check became markup';
});
t('panel: activity interleaves comments and history by time; only my own comment has Edit', function () {
    dvStage('open'); Dev.open(1003);
    var order = Array.prototype.map.call(document.querySelectorAll('.dv-activity > li'), function (li) { return li.classList.contains('dv-comment') ? 'c' : 'e'; }).join('');
    // GitHub's comment (4 days ago), the PR link (3), my comment (1).
    if (order !== 'cec') return 'order ' + order;
    var edits = document.querySelectorAll('[data-act="comment-edit"]');
    return (edits.length === 1 && edits[0].getAttribute('data-cid') === '10') || 'edit buttons: ' + edits.length;
});
t('panel: history reads in words ("GitHub linked a pull request")', function () {
    dvStage('open'); Dev.open(1003);
    return /GitHub linked a pull request/.test(document.querySelector('.dv-activity').textContent) || 'history text';
});

t('save: a status change shows at once and sends the change', function () {
    dvStage('backlog');
    var t1 = Dev.idx.byId.get(1001);
    Dev.setStatus(t1, 'in_progress');
    if (t1.status !== 'in_progress') return 'not optimistic';
    var b = last().body || {};
    return (b.action === 'status' && b.id === 1001 && b.to === 'in_progress') || 'sent ' + JSON.stringify(b);
});
t('save: a refused change goes back, and says why', function () {
    dvStage('backlog');
    var t1 = Dev.idx.byId.get(1001);
    DV_FAIL = true;
    var p = Dev.optimistic(t1, { priority: 'urgent' }, { action: 'edit', id: 1001, priority: 'urgent' });
    DV_FAIL = false;
    if (t1.priority !== 'urgent') return 'not optimistic';
    return p.then(function () {
        if (t1.priority !== 'low') return 'not put back: ' + t1.priority;
        var said = Array.prototype.some.call(document.querySelectorAll('.dv-toast.bad'), function (x) { return /Not saved — the server said no/.test(x.textContent); });
        return said || 'no failure toast';
    });
});
t("save: Won't Do asks why before anything is sent", function () {
    dvStage('backlog'); Dev.open(1001);
    var sent = DV_SENT.length;
    Dev.pickFor(Dev.idx.byId.get(1001), 'status', document.querySelector('.dv-prop[data-pick="status"]'));
    var wont = Array.prototype.filter.call(document.querySelectorAll('.dv-opt'), function (o) { return /Won't Do/.test(o.textContent); })[0];
    if (!wont) return 'no Won\'t Do option';
    wont.click();
    var ok = !!document.getElementById('dvWhy') && DV_SENT.length === sent;
    Dev.closePop();
    return ok || 'no reason box, or it was sent at once';
});

t('start work: prefixes follow the type (Bug fix, Suggestion/Improvement feat, Task chore)', function () {
    var p = [Dev.prefixFor('bug'), Dev.prefixFor('suggestion'), Dev.prefixFor('improvement'), Dev.prefixFor('task')].join(',');
    if (p !== 'fix,feat,feat,chore') return p;
    return Dev.slugify('  Sort the B2B list — by Brand!! ') === 'sort-the-b2b-list-by-brand' || Dev.slugify('  Sort the B2B list — by Brand!! ');
});
t('start work: offered on an open ticket with no branch; the form previews the name', function () {
    dvStage('backlog'); Dev.open(1001);
    var btn = document.querySelector('[data-act="start"]');
    if (!btn) return 'no Start work';
    Dev.onClick({ target: btn });
    var prev = document.getElementById('dvBranchPreview');
    return (prev && prev.textContent === 'fix/sn-1001-ticket-1001') || 'preview: ' + (prev && prev.textContent);
});
t('start work: not offered when a branch exists, the ticket is closed, or for a test account', function () {
    dvStage('open'); Dev.open(1003);
    if (document.querySelector('[data-act="start"]')) return 'offered with a branch';
    dvStage('closed'); Dev.open(573);
    if (document.querySelector('[data-act="start"]')) return 'offered on a closed ticket';
    dvStage('backlog', { test: true }); Dev.open(1001);
    return !document.querySelector('[data-act="start"]') || 'offered to a test account';
});

t('branches: base first, then the ones needing a ticket, then ticket, then release', function () {
    dvStage('branches');
    var names = Array.prototype.map.call(document.querySelectorAll('.dv-brow[data-branch]'), function (r) { return r.getAttribute('data-branch'); }).join(',');
    return names === 'pre-release,main,Main-December-Update-2---Ethan,feat/projects-completion-signoff,feat/sn-1003-sort,release/v3.13.0' || names;
});
t('branches: a branch with no ticket is flagged and can be linked or marked', function () {
    dvStage('branches');
    var row = document.querySelector('.dv-brow[data-branch="Main-December-Update-2---Ethan"]');
    if (!/No ticket/.test(row.textContent)) return 'not flagged';
    return (!!row.querySelector('[data-blink]') && !!row.querySelector('[data-bmark]')) || 'no Link / Mark';
});
t('branches: only a fully merged branch offers Delete; never main or pre-release', function () {
    dvStage('branches');
    var del = Array.prototype.map.call(document.querySelectorAll('[data-bdelete]'), function (b) { return b.getAttribute('data-bdelete'); }).join(',');
    return del === 'feat/projects-completion-signoff' || 'delete offered on: ' + del;
});
t('branches: a ticket branch opens its ticket; a test account gets no buttons', function () {
    dvStage('branches');
    var tag = document.querySelector('.dv-brow[data-branch="feat/sn-1003-sort"] [data-open]');
    if (!tag || tag.getAttribute('data-open') !== '1003') return 'no ticket link';
    dvStage('branches', { test: true });
    return !document.querySelector('.dv-bactions button') || 'buttons for a test account';
});

t('hash: dev.html#SN-573 (the Submit a Ticket email link) opens that ticket', function () {
    var was = location.hash;
    var set = function (h) { history.replaceState(null, '', location.pathname + location.search + h); };
    try {
        dvStage('triage');
        set('#SN-573'); Dev.openFromHash();
        if (Dev.S.openId !== 573) return 'opened ' + Dev.S.openId;
        Dev.closePanel(); set('#SN-99999'); Dev.openFromHash();
        return Dev.S.openId === null || 'opened a ticket that does not exist';
    } finally { set(was || ''); }
});
t('new ticket: C opens it; Create sends the title and the chosen fields', function () {
    dvStage('backlog');
    key('c');
    var title = document.getElementById('dvNewTitle');
    if (!title) return 'no form';
    title.value = 'A new thing';
    Dev.onClick({ target: document.querySelector('[data-act="new-create"]') });
    var b = last().body || {};
    Dev.closeModal();
    return (b.action === 'create' && b.title === 'A new thing' && b.status === 'backlog' && !!b.type) || 'sent ' + JSON.stringify(b);
});
t('new ticket: a test account is told, not given the form', function () {
    dvStage('backlog', { test: true });
    Dev.newTicket();
    return !document.getElementById('dvNewTitle') || 'form opened for a test account';
});
