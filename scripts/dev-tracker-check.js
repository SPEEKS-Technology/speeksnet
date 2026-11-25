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
// THE SUITE — the pipeline (dev.html = dev.js + dev.css, 2026-11-24). Run with
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
    return Promise.resolve({ success: true, branch: body.action === 'start_branch' ? body.prefix + '/' + body.slug : undefined });
});
function last() { return DV_SENT[DV_SENT.length - 1] || {}; }

var BR = 'Main-December-Update-2---Ethan';
function dvFixture(opts) {
    var day = 86400000, now = Date.now();
    var T = function (id, status, extra) {
        var b = { id: id, title: 'Ticket ' + id, description: 'What is wrong.', type: 'bug', area: 'b2b', priority: 'normal', status: status,
            assignee_id: null, assignee_name: null, reporter_id: 'e', reporter_name: 'Ethan Kushnir', reporter_store: 'CORP', stores: [],
            release_id: null, due: null, source: 'dev', github_number: null, closed_at: null, attachments: [], branch: null, branch_done: false,
            created_at: new Date(now - 5 * day).toISOString(), updated_at: new Date(now - id * 1000).toISOString() };
        for (var k in extra) b[k] = extra[k];
        return b;
    };
    return {
        me: { id: 'n', name: 'Nick Hettinger', role: 'Manager', test: !!(opts && opts.test) },
        can: { dev: true, publish: false },
        pipeline: {
            live: { id: 57, version: 'v3.12.3', title: 'v3.12.3', published_at: new Date(now - 3 * day).toISOString() },
            next: { id: 14, size: 'major', title: (opts && 'title' in opts) ? opts.title : 'Main December Update', version: 'v3.13.0',
                versions: { minor: 'v3.12.4', major: 'v3.13.0', overhaul: 'v4.0.0' }, needs_title: true },
        },
        devs: [{ id: 'e', name: 'Ethan Kushnir', store: 'CORP', role: 'District Manager' }, { id: 'n', name: 'Nick Hettinger', store: 'OVL', role: 'Manager' }],
        types: [{ key: 'bug', label: 'Bug', active: true }, { key: 'suggestion', label: 'Suggestion', active: true }, { key: 'improvement', label: 'Improvement', active: true }, { key: 'task', label: 'Task', active: true }],
        areas: [{ key: 'b2b', label: 'B2B', active: true }, { key: 'claims', label: 'Claims', active: true }],
        releases: [
            { id: 14, version: null, title: 'Main December Update', status: 'in_progress', size: 'major' },
            { id: 57, version: 'v3.12.3', title: 'v3.12.3', status: 'published', published_at: new Date(now - 3 * day).toISOString() },
            // The old split: the name and the number as two rows, published seconds apart.
            { id: 13, version: null, title: 'Main November Update', status: 'published', published_at: new Date(now - 20 * day).toISOString() },
            { id: 16, version: 'v3.11.0', title: 'v3.11.0', status: 'published', published_at: new Date(now - 20 * day - 23000).toISOString() },
        ],
        tickets: [
            T(1000, 'triage', { source: 'idea', title: 'From the shop floor', attachments: [{ name: 'photo.jpg', url: 'https://example.invalid/signed' }, { name: 'old.pdf', url: null }] }),
            T(1001, 'backlog', { priority: 'low', title: 'Low one' }),
            T(1002, 'backlog', { priority: 'urgent', assignee_id: 'n', assignee_name: 'Nick Hettinger', title: 'Urgent one' }),
            T(1003, 'in_progress', { area: 'claims', type: 'suggestion', title: 'Sort the B2B list by brand', branch: 'feat/b2b-sort', branch_done: true }),
            T(1004, 'in_progress', { type: 'improvement', title: '<b>Expense</b> export', branch: 'feat/b2b-sort' }),
            T(1005, 'in_review', { title: 'On a merged branch still', branch: 'feat/projects-completion-signoff' }),
            T(568, 'on_prerelease', { type: 'bug', title: 'Fix box order tool cart', release_id: 14, branch: 'fix/box-order-cart' }),
            T(572, 'on_prerelease', { type: 'improvement', title: 'Submit an Idea moved to SPEEKSNET', release_id: 14, branch: null }),
            T(573, 'done', { source: 'github_import', github_number: 573, release_id: 13, title: 'Customer Callback Fixes', closed_at: new Date(now - day).toISOString() }),
            T(66, 'wont_do', { source: 'github_import', github_number: 66, closed_at: new Date(now - 2 * day).toISOString(), title: 'Test 1' }),
        ],
        events: [
            { id: 1, ticket_id: 66, kind: 'created', actor_name: 'Nick Hettinger', created_at: new Date(now - 9 * day).toISOString() },
            { id: 2, ticket_id: 66, kind: 'status', actor_name: 'GitHub', from_value: 'backlog', to_value: 'wont_do', note: 'Closed on GitHub as not planned', created_at: new Date(now - 2 * day).toISOString() },
            { id: 3, ticket_id: 1003, kind: 'linked', actor_name: 'GitHub', to_value: 'pr', note: 'PR #612', created_at: new Date(now - 3 * day).toISOString() },
            { id: 4, ticket_id: 1003, kind: 'branch', actor_name: 'Nick Hettinger', to_value: 'feat/b2b-sort', note: 'Put on feat/b2b-sort', created_at: new Date(now - 4 * day).toISOString() },
        ],
        comments: [
            { id: 10, ticket_id: 1003, body: 'Mine to fix.', author_name: 'Nick Hettinger', author_id: 'n', source: 'speeksnet', created_at: new Date(now - day).toISOString() },
            { id: 11, ticket_id: 1003, body: 'From GitHub.', author_name: 'Ethan Kushnir', author_id: 'e', source: 'github', created_at: new Date(now - 4.5 * day).toISOString() },
        ],
        links: [
            { id: 1, ticket_id: 1003, kind: 'commit', ref: 'abcdef1234567890', url: 'https://github.com/x/commit/abcdef1', title: 'Sort SN-1003' },
            { id: 2, ticket_id: 1003, kind: 'branch', ref: 'feat/b2b-sort', url: 'https://github.com/x/tree/feat/b2b-sort', state: 'active' },
            { id: 3, ticket_id: 1003, kind: 'pr', ref: '612', url: 'https://github.com/x/pull/612', title: 'B2B sort by brand', state: 'open', base: 'pre-release', author: 'Eckushnir',
              checks: [
                  { kind: 'migration', level: 'error', text: '0192 is already used in the database by 0192_dev_github_sync' },
                  { kind: 'buster', level: 'warn', text: 'speeks.js changed but no cache-buster was bumped' },
                  { kind: 'migration', level: 'warn', text: '<img src=x onerror=alert(1)>' },
              ] },
        ],
        branches: [
            { name: 'feat/b2b-sort', kind: 'untracked', ahead: 2, behind: 0, merged: false, pr_number: 612, pr_state: 'open', last_commit_author: 'Eckushnir', last_commit_at: new Date(now - day).toISOString() },
            { name: 'main', kind: 'base', ahead: 6, behind: 9, merged: false, last_commit_at: new Date(now - 7 * day).toISOString() },
            { name: BR, kind: 'untracked', ahead: 17, behind: 40, merged: false, pr_number: 576, pr_state: 'open', last_commit_author: 'Eckushnir', last_commit_at: new Date(now - 2 * day).toISOString() },
            { name: 'feat/projects-completion-signoff', kind: 'untracked', ahead: 0, behind: 1, merged: true, pr_number: 581, pr_state: 'merged', last_commit_at: new Date(now - 3 * day).toISOString() },
            { name: 'App-Icon-Green---Ethan', kind: 'untracked', ahead: 0, behind: 1, merged: true, pr_number: 587, pr_state: 'merged', last_commit_at: new Date(now - 4 * day).toISOString() },
            { name: 'pre-release', kind: 'base', ahead: 0, behind: 0, merged: false, last_commit_at: new Date(now - day).toISOString() },
        ],
    };
}
function dvStage(opts) {
    ['dvApp', 'dvLayer', 'dvToasts'].forEach(function (id) {
        if (!document.getElementById(id)) { var d = document.createElement('div'); d.id = id; document.body.appendChild(d); }
    });
    document.getElementById('dvApp').className = 'dv-app';
    document.getElementById('dvApp').innerHTML = '';
    Dev.closePop(); Dev.closeModal();
    Dev.setData(dvFixture(opts));
    Dev.S.query = ''; Dev.S.openId = null; Dev.S.editingDesc = false; Dev.S.editingComment = null; Dev.S.titleDraft = null;
    Dev.S.fresh.clear(); Dev.S.landed.clear();
    Dev.renderShell(); Dev.renderAll();
    return document.getElementById('dvApp');
}
function cardIds(sel) { return Array.prototype.map.call(document.querySelectorAll(sel + ' .dv-card'), function (c) { return c.getAttribute('data-id'); }).join(','); }
function lane(name) { return document.querySelector('.dv-lane[data-lane="' + name + '"]'); }
function laneNames() { return Array.prototype.map.call(document.querySelectorAll('.dv-lane'), function (l) { return l.getAttribute('data-lane'); }); }
// The page attaches Dev.onKey to document at boot, which the harness skips —
// so a key goes straight to the handler, with the target it would have had.
function key(k, target) {
    var e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'target', { value: target || document.body });
    Dev.onKey(e);
}
function optText(re) { return Array.prototype.filter.call(document.querySelectorAll('.dv-opt'), function (o) { return re.test(o.textContent); })[0]; }

t('suite: boots nothing in the harness (DEV_NO_BOOT) and exposes Dev', function () {
    return (typeof Dev === 'object' && typeof Dev.renderAll === 'function' && typeof Dev.moveTicket === 'function') || 'window.Dev missing';
});

// ---- the three places -------------------------------------------------------
t('backlog: open tickets on no branch; Submit a Ticket ones on top; urgent before low', function () {
    dvStage();
    var all = cardIds('#dvBacklog');
    if (all !== '1000,1002,1001') return 'backlog ' + all;
    var grp = document.querySelector('#dvBacklog .dv-grp-h').textContent;
    return /1 new/.test(grp) && /From Submit a Ticket/.test(grp) || 'first group: ' + grp;
});
t('branches: a column per unmerged branch AND per branch a ticket is on; never main / pre-release', function () {
    dvStage();
    var names = laneNames();
    if (names.indexOf('main') >= 0 || names.indexOf('pre-release') >= 0) return 'a base branch got a column';
    if (names.indexOf('feat/b2b-sort') < 0 || names.indexOf(BR) < 0) return 'unmerged branch missing: ' + names.join(', ');
    if (names.indexOf('feat/projects-completion-signoff') < 0) return 'a merged branch with a ticket still on it lost its column';
    return names.indexOf('App-Icon-Green---Ethan') < 0 || 'a merged, empty branch still has a column';
});
t('branches: merged and empty ones are offered for tidying, not shown', function () {
    dvStage();
    var tidy = Dev.tidyBranches().map(function (b) { return b.name; }).join(',');
    if (tidy !== 'App-Icon-Green---Ethan') return 'tidy list: ' + tidy;
    return /1 merged branch to tidy/.test(document.getElementById('dvLanesK').textContent) || 'no tidy button';
});
t('branches: each column shows its tickets, progress, PR and how far behind', function () {
    dvStage();
    var l = lane('feat/b2b-sort');
    if (cardIds('.dv-lane[data-lane="feat/b2b-sort"]') !== '1003,1004') return 'cards ' + cardIds('.dv-lane[data-lane="feat/b2b-sort"]');
    if (!/1\/2 done/.test(l.querySelector('.dv-lane-p').textContent)) return 'progress: ' + l.querySelector('.dv-lane-p').textContent;
    if (!/#612/.test(l.querySelector('.dv-lane-m').textContent)) return 'no PR pill';
    if (!l.querySelector('.dv-card[data-id="1003"]').classList.contains('done')) return 'a ticked ticket is not shown done';
    var far = lane(BR).querySelector('.dv-behind');
    return (far && far.classList.contains('far') && /40 behind/.test(far.textContent)) || 'far-behind branch not flagged';
});
t('branches: a GitHub login shows as the dev it belongs to', function () {
    dvStage();
    return Dev.personFor('Eckushnir') === 'Ethan Kushnir' && Dev.personFor('someone-else') === 'someone-else' || 'personFor wrong';
});
t('pre-release: the merged tickets, as patch notes grouped by type, each saying its branch', function () {
    dvStage();
    var heads = Array.prototype.map.call(document.querySelectorAll('.dv-notes h4'), function (h) { return h.firstChild.textContent; }).join(',');
    if (heads !== 'Improved,Fixed') return 'headings ' + heads;
    var n = document.querySelector('.dv-note[data-open="568"]');
    return (n && /from fix\/box-order-cart/.test(n.textContent)) || 'no "from <branch>" on SN-568';
});
t('pre-release: the next version from the live one, and what each size would make', function () {
    dvStage();
    if (document.querySelector('.dv-ver-now').textContent !== 'v3.13.0') return 'version ' + document.querySelector('.dv-ver-now').textContent;
    if (!/v3\.12\.3/.test(document.querySelector('.dv-ver-from').textContent)) return 'no "from v3.12.3"';
    var sizes = Array.prototype.map.call(document.querySelectorAll('.dv-sizes button'), function (b) { return b.textContent.replace(/\s+/g, ''); }).join(',');
    if (sizes !== 'Minorv3.12.4,Majorv3.13.0,Overhaulv4.0.0') return 'sizes ' + sizes;
    return document.querySelector('.dv-sizes button.on').getAttribute('data-size') === 'major' || 'major not selected';
});
t('pre-release: a major update with no title says so; Go live is drawn but not wired yet', function () {
    dvStage({ title: '' });
    var warn = document.querySelector('.dv-ready .warn');
    if (!warn || !/needs a title/.test(warn.textContent)) return 'no title warning';
    if (!document.getElementById('dvNextTitle').classList.contains('need')) return 'title box not marked';
    return document.querySelector('.dv-golive').disabled || 'Go live is clickable before step 5 exists';
});
t('pre-release: picking Minor moves the version at once, drops the title box, and saves', function () {
    dvStage();
    Dev.setSize('minor');
    if (document.querySelector('.dv-ver-now').textContent !== 'v3.12.4') return 'version ' + document.querySelector('.dv-ver-now').textContent;
    if (document.getElementById('dvNextTitle')) return 'a minor update still asks for a title';
    var b = last().body || {};
    return (b.action === 'set_next' && b.size === 'minor') || 'sent ' + JSON.stringify(b);
});
t('pre-release: the title saves as it is typed (debounced), not on every key', function () {
    dvStage();
    var i = document.getElementById('dvNextTitle');
    var sent = DV_SENT.length;
    i.value = 'December Update';
    Dev.onInput({ target: i });
    if (DV_SENT.length !== sent) return 'sent on the keystroke';
    if (document.getElementById('dvHTitle').textContent !== 'December Update') return 'heading did not follow';
    Dev.saveNextTitle(true);   // the send itself is synchronous; only its answer waits
    var b = last().body || {};
    return (b.action === 'set_next' && b.title === 'December Update') || 'sent ' + JSON.stringify(b);
});

// ---- moving work ------------------------------------------------------------
t('move: onto a branch shows at once (In progress) and sends to_branch', function () {
    dvStage();
    Dev.moveTicket(Dev.idx.byId.get(1001), BR);
    var t1 = Dev.idx.byId.get(1001);
    if (t1.branch !== BR || t1.status !== 'in_progress') return 'ticket ' + t1.branch + ' / ' + t1.status;
    if (cardIds('.dv-lane[data-lane="' + BR + '"]') !== '1001') return 'not in the column';
    if (/1001/.test(cardIds('#dvBacklog'))) return 'still in the backlog';
    var b = last().body || {};
    return (b.action === 'to_branch' && b.ids[0] === 1001 && b.branch === BR) || 'sent ' + JSON.stringify(b);
});
t('move: back to the Backlog sends branch: null and clears the tick', function () {
    dvStage();
    Dev.moveTicket(Dev.idx.byId.get(1003), null);
    var t1 = Dev.idx.byId.get(1003);
    if (t1.branch !== null || t1.status !== 'backlog' || t1.branch_done) return 'ticket ' + JSON.stringify([t1.branch, t1.status, t1.branch_done]);
    var b = last().body || {};
    return (b.action === 'to_branch' && b.branch === null && 'branch' in b) || 'sent ' + JSON.stringify(b);
});
t('move: a refused move goes back, and says why', function () {
    dvStage();
    var t1 = Dev.idx.byId.get(1002);
    DV_FAIL = true;
    var p = Dev.optimistic(t1, { branch: BR, status: 'in_progress' }, { action: 'to_branch', ids: [1002], branch: BR });
    DV_FAIL = false;
    if (t1.branch !== BR) return 'not optimistic';
    // (Later checks restage the board before this settles, so it asserts on the
    // ticket and the toast, not on where a card is drawn.)
    return p.then(function () {
        if (t1.branch !== null || t1.status !== 'backlog') return 'not put back: ' + t1.branch;
        var said = Array.prototype.some.call(document.querySelectorAll('.dv-toast.bad'), function (x) { return /Not saved — the server said no/.test(x.textContent); });
        return said || 'no failure toast';
    });
});
t('move: merged or shipped tickets never move', function () {
    dvStage();
    var sent = DV_SENT.length;
    Dev.moveTicket(Dev.idx.byId.get(568), BR);
    Dev.moveTicket(Dev.idx.byId.get(573), BR);
    return (DV_SENT.length === sent && Dev.idx.byId.get(568).status === 'on_prerelease') || 'a merged ticket moved';
});
t('move: dropping a card on a column moves it there', function () {
    dvStage();
    if (!window.__dvListening) { Dev.listen(); window.__dvListening = true; }
    var card = document.querySelector('#dvBacklog .dv-card[data-id="1001"]');
    var zone = lane(BR).querySelector('.dv-drop');
    var dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    var b = last().body || {};
    return (b.action === 'to_branch' && b.ids[0] === 1001 && b.branch === BR) || 'sent ' + JSON.stringify(b);
});
t('tick: the box ticks at once, the progress follows, and branch_done is sent', function () {
    dvStage();
    Dev.onClick({ target: lane('feat/b2b-sort').querySelector('[data-chk="1004"]'), stopPropagation: function () {} });
    if (!/2\/2 done/.test(lane('feat/b2b-sort').querySelector('.dv-lane-p').textContent)) return 'progress did not follow';
    var b = last().body || {};
    return (b.action === 'branch_done' && b.id === 1004 && b.done === true) || 'sent ' + JSON.stringify(b);
});
t('move menu: the other branches, a new branch, back to the Backlog, Won\'t do', function () {
    dvStage();
    Dev.moveMenu(Dev.idx.byId.get(1003), document.querySelector('.dv-card[data-id="1003"] .dv-more'));
    var txt = document.querySelector('.dv-pop').textContent;
    Dev.closePop();
    if (/feat\/b2b-sort/.test(txt)) return 'offers the branch it is already on';
    if (txt.indexOf(BR) < 0) return 'missing another branch';
    return (/A new branch/.test(txt) && /Back to the Backlog/.test(txt) && /Won't do/.test(txt)) || 'menu: ' + txt;
});
t('move menu: a Backlog ticket is not offered "Back to the Backlog"; Won\'t do asks why first', function () {
    dvStage();
    var anchor = document.querySelector('.dv-card[data-id="1001"] .dv-more');
    Dev.moveMenu(Dev.idx.byId.get(1001), anchor);
    if (/Back to the Backlog/.test(document.querySelector('.dv-pop').textContent)) { Dev.closePop(); return 'offered to a backlog ticket'; }
    var sent = DV_SENT.length;
    optText(/Won't do/).click();
    var ok = !!document.getElementById('dvWhy') && DV_SENT.length === sent;
    Dev.closePop();
    return ok || 'no reason box, or it was sent at once';
});

// ---- test accounts ----------------------------------------------------------
t('read-only: a test account can look but not move, tick, size or start anything', function () {
    dvStage({ test: true });
    if (document.querySelector('.dv-card[draggable="true"]')) return 'cards draggable';
    if (document.querySelector('.dv-more:not(.show)')) return 'move buttons shown';
    if (!document.querySelector('.dv-chk').disabled) return 'tick box live';
    if (!document.querySelector('.dv-sizes button').disabled) return 'size buttons live';
    if (document.querySelector('.dv-addlane')) return 'Start a branch offered';
    Dev.newTicket();
    return !document.getElementById('dvNewTitle') || 'new-ticket form opened';
});

// ---- search -----------------------------------------------------------------
t('search: narrows every column, and finds tickets that already moved on', function () {
    dvStage();
    var s = document.getElementById('dvSearch');
    s.value = 'callback'; s.dispatchEvent(new Event('input'));
    var gone = document.querySelector('#dvBacklog .dv-found[data-open="573"]');
    var shown = document.querySelectorAll('.dv-card').length;
    s.value = ''; s.dispatchEvent(new Event('input'));
    if (shown) return shown + ' cards still showing';
    return !!gone || 'the live ticket was not found';
});
t('search: "SN-573" + Enter opens that ticket, wherever it is', function () {
    dvStage();
    var s = document.getElementById('dvSearch');
    s.value = 'SN-573'; s.dispatchEvent(new Event('input'));
    s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    var ok = Dev.S.openId === 573;
    s.value = ''; s.dispatchEvent(new Event('input')); Dev.closePanel();
    return ok || 'opened ' + Dev.S.openId;
});
t('search: words match title, description and branch', function () {
    dvStage();
    var t1 = Dev.idx.byId.get(1003);
    return (Dev.matchesQuery(t1, 'sort brand') && Dev.matchesQuery(t1, 'b2b-sort') && !Dev.matchesQuery(t1, 'nothing like it')) || 'match wrong';
});

// ---- the panel -----------------------------------------------------------------
t('panel: the stepper and "Where" say where it is', function () {
    dvStage();
    var cur = function (id) { Dev.open(id); var c = document.querySelector('.dv-stepper .cur'); return c ? c.textContent : '-'; };
    var got = [cur(1001), cur(1003), cur(568), cur(573)].join(',');
    if (got !== 'Backlog,On a branch,Pre-release,Live') return 'stages ' + got;
    Dev.open(568);
    if (!/ships in v3\.13\.0/.test(document.querySelector('.dv-where').textContent)) return 'pre-release does not say which version';
    Dev.open(573);
    var w = document.querySelector('.dv-where').textContent;
    Dev.closePanel();
    return /Live in v3\.11\.0/.test(w) || 'live ticket says ' + w;
});
t("panel: Won't Do shows its reason, and no stepper", function () {
    dvStage(); Dev.open(66);
    var c = document.querySelector('.dv-callout.no');
    var ok = c && /Closed on GitHub as not planned/.test(c.textContent) && !document.querySelector('.dv-stepper');
    Dev.closePanel();
    return ok || 'callout / stepper wrong';
});
t('panel: Code lists the PR first with every check; markup in a check is shown, not run', function () {
    dvStage(); Dev.open(1003);
    var kinds = Array.prototype.map.call(document.querySelectorAll('.dv-code-item .dv-code-line > svg:first-child'), function () { return 1; }).length;
    var first = document.querySelector('.dv-code-item');
    var ok = kinds === 3 && /#612/.test(first.textContent) && document.querySelectorAll('.dv-check').length === 3 && !document.querySelector('.dv-checks img');
    Dev.closePanel();
    return ok || 'code section wrong';
});
t('panel: history reads in words, branch moves included', function () {
    dvStage(); Dev.open(1003);
    var txt = document.querySelector('.dv-activity').textContent;
    Dev.closePanel();
    return (/GitHub linked a pull request/.test(txt) && /put it on feat\/b2b-sort/.test(txt)) || 'history: ' + txt.slice(0, 200);
});
t('panel: activity interleaves comments and history by time; only my own comment has Edit', function () {
    dvStage(); Dev.open(1003);
    var order = Array.prototype.map.call(document.querySelectorAll('.dv-activity > li'), function (li) { return li.classList.contains('dv-comment') ? 'c' : 'e'; }).join('');
    var edits = document.querySelectorAll('[data-act="comment-edit"]');
    Dev.closePanel();
    // branch event (4d), GitHub's comment (4.5d — older), PR link (3d), my comment (1d)
    if (order !== 'ceec') return 'order ' + order;
    return (edits.length === 1 && edits[0].getAttribute('data-cid') === '10') || 'edit buttons: ' + edits.length;
});
t('panel: the title edits in place for a dev, not for a test account', function () {
    dvStage(); Dev.open(1001);
    var dev = document.getElementById('dvTitle').getAttribute('contenteditable');
    dvStage({ test: true }); Dev.open(1001);
    var test = document.getElementById('dvTitle').getAttribute('contenteditable');
    Dev.closePanel();
    return (dev === 'plaintext-only' && test === null) || 'dev ' + dev + ' / test ' + test;
});
t('panel: attachments link out; an expired one says so', function () {
    dvStage(); Dev.open(1000);
    var a = document.querySelectorAll('.dv-file');
    var ok = a.length === 2 && a[0].tagName === 'A' && a[1].tagName === 'SPAN' && /expired/.test(a[1].title);
    Dev.closePanel();
    return ok || 'attachments wrong';
});

// ---- the top bar -------------------------------------------------------------
t('live: the pill shows the live version; its menu folds the old name+number split into one', function () {
    dvStage();
    if (!/v3\.12\.3/.test(document.getElementById('dvLivePill').textContent)) return 'pill ' + document.getElementById('dvLivePill').textContent;
    Dev.liveMenu(document.getElementById('dvLivePill'));
    var rels = Array.prototype.map.call(document.querySelectorAll('.dv-rel'), function (r) { return r.querySelector('.dv-rel-v').textContent + '|' + r.querySelector('.dv-rel-n').textContent; });
    var shipped = !!document.querySelector('.dv-rel [data-open="573"]');
    Dev.closePop();
    if (rels.join(',') !== 'v3.12.3|,v3.11.0|Main November Update') return 'releases ' + rels.join(',');
    return shipped || 'the November ticket is not listed under v3.11.0';
});

// ---- creating -----------------------------------------------------------------
t('new ticket: C opens it; Create sends the title and fields, Backlog by default', function () {
    dvStage();
    key('c');
    var title = document.getElementById('dvNewTitle');
    if (!title) return 'no form';
    title.value = 'A new thing';
    Dev.onClick({ target: document.querySelector('[data-act="new-create"]') });
    var b = last().body || {};
    Dev.closeModal();
    return (b.action === 'create' && b.title === 'A new thing' && b.branch === null && !!b.type && !('status' in b)) || 'sent ' + JSON.stringify(b);
});
t('new ticket: started from a branch menu, it is created on that branch', function () {
    dvStage();
    Dev.newTicket(BR);
    document.getElementById('dvNewTitle').value = 'On the branch';
    Dev.onClick({ target: document.querySelector('[data-act="new-create"]') });
    var b = last().body || {};
    Dev.closeModal();
    return (b.action === 'create' && b.branch === BR) || 'sent ' + JSON.stringify(b);
});
t('new branch: B opens it, previews the name, and sends start_branch with the open ticket', function () {
    dvStage(); Dev.open(1001); Dev.closePanel();
    Dev.newBranch([1001]);
    var slug = document.getElementById('dvBrSlug');
    if (!slug) return 'no form';
    slug.value = 'Low One Fix!'; slug.dispatchEvent(new Event('input'));
    if (document.getElementById('dvBrPreview').textContent !== 'fix/low-one-fix') return 'preview ' + document.getElementById('dvBrPreview').textContent;
    document.getElementById('dvBrGo').click();
    var b = last().body || {};
    Dev.closeModal();
    return (b.action === 'start_branch' && b.prefix === 'fix' && b.slug === 'low-one-fix' && b.ticket_ids[0] === 1001) || 'sent ' + JSON.stringify(b);
});
t('branch menu: GitHub, the PR, the checkout command; Delete only once merged and empty', function () {
    dvStage();
    Dev.branchMenu(BR, lane(BR).querySelector('[data-bmore]'));
    var open = document.querySelector('.dv-pop').textContent;
    Dev.closePop();
    if (!/Open on GitHub/.test(open) || !/Open PR #576/.test(open) || !/checkout command/.test(open)) return 'menu: ' + open;
    if (/Delete/.test(open)) return 'Delete offered on an unmerged branch';
    Dev.branchMenu('feat/projects-completion-signoff', lane('feat/projects-completion-signoff').querySelector('[data-bmore]'));
    var merged = document.querySelector('.dv-pop').textContent;
    Dev.closePop();
    return !/Delete/.test(merged) || 'Delete offered while a ticket is still on it';
});

// ---- the rest ------------------------------------------------------------------
t('escaping: what people typed is shown, not run', function () {
    dvStage();
    var c = document.querySelector('.dv-card[data-id="1004"] .dv-card-title');
    return (c.textContent === '<b>Expense</b> export' && !c.querySelector('b')) || 'title rendered as HTML';
});
t('hash: dev.html#SN-573 (the Submit a Ticket email link) opens that ticket', function () {
    dvStage();
    var was = location.hash;
    var set = function (h) { history.replaceState(null, '', location.pathname + location.search + h); };
    try {
        set('#SN-573'); Dev.openFromHash();
        if (Dev.S.openId !== 573) return 'opened ' + Dev.S.openId;
        Dev.closePanel(); set('#SN-99999'); Dev.openFromHash();
        return Dev.S.openId === null || 'opened a ticket that does not exist';
    } finally { set(was || ''); }
});
t('keys: ? opens the shortcuts; Esc closes the panel', function () {
    dvStage();
    key('?');
    var keys = !!document.querySelector('.dv-keys');
    Dev.closeModal();
    Dev.open(1001); key('Escape');
    return (keys && Dev.S.openId === null) || 'shortcuts ' + keys + ', open ' + Dev.S.openId;
});
t('history words: branch moves and ticks read as sentences', function () {
    var on = Dev.eventText({ kind: 'branch', to_value: 'feat/x' }), off = Dev.eventText({ kind: 'branch', from_value: 'feat/x', to_value: null }), d = Dev.eventText({ kind: 'branch_done', to_value: 'done' });
    return (/put it on/.test(on) && /took it off/.test(off) && /marked it done/.test(d)) || [on, off, d].join(' | ');
});
