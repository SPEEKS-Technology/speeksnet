// DEVELOPMENT TRACKER — behaviour checks (docs/plans/dev-tracker-HANDOFF.md).
//
//   powershell -File scripts/browser-check.ps1 dev-tracker-check.js
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

// ---- Phase 3: the page (dev.html) ------------------------------------------
// Renderers run against a fixture; nothing here reaches the network. _devPost
// is stubbed ONCE, here, for the reason CLAUDE.md gives for _b2bSend: a
// per-test stub restored in a finally is gone before an awaited send runs.
var DEV_POSTED = [];
_devPost = function (p) { DEV_POSTED.push(p); return Promise.resolve({ success: true }); };

function devFixture() {
    var day = 86400000, now = Date.now();
    var T = function (id, status, extra) {
        var b = { id: id, title: 'Ticket ' + id, description: 'What is wrong.', type: 'bug', area: 'b2b', priority: 'normal', status: status,
            assignee_id: null, assignee_name: null, reporter_id: 'e', reporter_name: 'Ethan Kushnir', reporter_store: 'CORP', stores: [],
            release_id: null, due: null, source: 'dev', github_number: null, closed_at: null,
            created_at: new Date(now - 5 * day).toISOString(), updated_at: new Date(now - id * 1000).toISOString() };
        for (var k in extra) b[k] = extra[k];
        return b;
    };
    return {
        me: { id: 'n', name: 'Nick Hettinger', role: 'Manager', test: false },
        can: { dev: true, publish: false },
        devs: [{ id: 'e', name: 'Ethan Kushnir', store: 'CORP', role: 'District Manager' }, { id: 'n', name: 'Nick Hettinger', store: 'OVL', role: 'Manager' }],
        types: [{ key: 'bug', label: 'Bug', active: true }, { key: 'suggestion', label: 'Suggestion', active: true }, { key: 'task', label: 'Task', active: true }],
        areas: [{ key: 'b2b', label: 'B2B', active: true }, { key: 'claims', label: 'Claims', active: true }],
        releases: [{ id: 1, version: null, title: 'Main December Update', status: 'in_progress' }, { id: 2, version: 'v3.12.0', title: 'v3.12.0', status: 'published' }],
        tickets: [
            T(1001, 'backlog', { priority: 'low' }),
            T(1002, 'backlog', { priority: 'urgent', assignee_id: 'n', assignee_name: 'Nick Hettinger' }),
            T(1003, 'in_progress', { area: 'claims', release_id: 1 }),
            T(573, 'done', { source: 'github_import', github_number: 573, closed_at: new Date(now - day).toISOString() }),
            T(66, 'wont_do', { source: 'github_import', github_number: 66, closed_at: new Date(now - 2 * day).toISOString(), title: 'Test 1' }),
        ],
        events: [
            { id: 1, ticket_id: 66, kind: 'created', actor_name: 'Nick Hettinger', created_at: new Date(now - 9 * day).toISOString() },
            { id: 2, ticket_id: 66, kind: 'status', actor_name: 'GitHub', from_value: 'backlog', to_value: 'wont_do', note: 'Closed on GitHub as not planned', created_at: new Date(now - 2 * day).toISOString() },
        ],
        comments: [
            { id: 10, ticket_id: 1003, body: 'Mine to fix.', author_name: 'Nick Hettinger', author_id: 'n', source: 'speeksnet', created_at: new Date(now - day).toISOString() },
            { id: 11, ticket_id: 1003, body: 'From GitHub.', author_name: 'Ethan Kushnir', author_id: 'e', source: 'github', created_at: new Date(now - 2 * day).toISOString() },
        ],
        links: [],
    };
}
function devStage() {
    var host = document.getElementById('dev-host');
    if (!host) { host = document.createElement('div'); host.id = 'dev-host'; document.body.appendChild(host); }
    host.innerHTML = '<span id="devHeadSub"></span><button id="devNewBtn"></button><div id="devBody"></div>'
        + '<div id="devDetailModal" class="modal-menu"><span id="devDetailEyebrow"></span><span id="devDetailHead"></span><span id="devDetailSub"></span>'
        + '<div id="devDetailBody"></div><div id="devDetailFooter"></div></div>';
    _devData = devFixture(); _devView = null; _devSearch = ''; _devArea = ''; _devMine = false; _devEditingComment = null;
    return host;
}
function devIds() {
    return Array.prototype.map.call(document.querySelectorAll('#devBody .prj-id'), function (e) { return e.textContent; }).join(',');
}

t('list: with nothing in triage it opens on In progress', function () {
    devStage(); devRender();
    return _devView === 'in_progress' || 'opened on ' + _devView;
});
t('list: a ticket waiting in triage takes the first look', function () {
    devStage(); _devData.tickets.push(Object.assign(devFixture().tickets[0], { id: 1009, status: 'triage' })); devRender();
    return _devView === 'triage' || 'opened on ' + _devView;
});
t('list: urgent first, low last, within a view', function () {
    devStage(); devSetView('backlog');
    return devIds() === 'SN-1002,SN-1001' || 'order ' + devIds();
});
t("list: Done holds Done and Won't do, most recently closed first", function () {
    devStage(); devSetView('closed');
    return devIds() === 'SN-573,SN-66' || 'order ' + devIds();
});
t('list: "SN-573", "#573" and "573" all find the imported ticket', function () {
    devStage(); devSetView('closed');
    var bad = ['SN-573', '#573', '573', 'sn573'].filter(function (q) { devSetSearch(q); return devIds() !== 'SN-573'; });
    return !bad.length || 'missed: ' + bad.join(', ');
});
t('list: the filter counts follow the search', function () {
    devStage(); devRender(); devSetSearch('Ticket 1002');
    var txt = Array.prototype.map.call(document.querySelectorAll('#devBody .prj-seg-btn'), function (b) { return b.textContent.trim(); }).join(' | ');
    return (/Backlog · 1/.test(txt) && /In progress · 0/.test(txt)) || txt;
});
t('list: Mine is tickets assigned to me', function () {
    devStage(); devSetMine(true); devSetView('backlog');
    return devIds() === 'SN-1002' || 'mine shows ' + devIds();
});
t('list: Area filter, and "No area"', function () {
    devStage(); _devData.tickets[0].area = null; devSetArea('claims'); devSetView('in_progress');
    if (devIds() !== 'SN-1003') return 'claims shows ' + devIds();
    devSetArea('__none'); devSetView('backlog');
    return devIds() === 'SN-1001' || 'no-area shows ' + devIds();
});
t('list: escapes what people typed', function () {
    devStage(); _devData.tickets[0].title = '<img src=x onerror=alert(1)>'; devSetView('backlog');
    return !document.querySelector('#devBody img') || 'a title became markup';
});

t('detail: an imported ticket says where it came from', function () {
    devStage(); devOpen(573);
    var txt = document.getElementById('devDetailEyebrow').textContent;
    return /SN-573 · was GitHub #573/.test(txt) || txt;
});
t("detail: Won't do shows its reason at the top", function () {
    devStage(); devOpen(66);
    var c = document.querySelector('#devDetailBody .prj-callout');
    return (c && /not planned/.test(c.textContent)) || 'no reason callout';
});
t('detail: only my own SPEEKSNET comment is editable', function () {
    devStage(); devOpen(1003);
    var edits = document.querySelectorAll('#devDetailBody .dev-comment-edit');
    return edits.length === 1 || edits.length + ' edit buttons';
});
t('detail: the assignee list is the devs, plus Nobody', function () {
    devStage(); devOpen(1003);
    var opts = Array.prototype.map.call(document.querySelectorAll('#devAssignSel option'), function (o) { return o.textContent; }).join(',');
    return opts === 'Nobody,Ethan Kushnir,Nick Hettinger' || opts;
});
t('detail: every status is offered', function () {
    devStage(); devOpen(1003);
    var n = document.querySelectorAll('#devStatusSel option').length;
    return n === 7 || 'only ' + n;
});
t('detail: a test account reads, but gets no controls', function () {
    devStage(); _devData.me.test = true; devOpen(1003);
    return (!document.getElementById('devStatusSel') && !document.getElementById('devNote')) || 'controls drawn for a test account';
});

t("save: Won't do without a reason is stopped before it is sent", function () {
    devStage(); devOpen(1003); DEV_POSTED.length = 0;
    document.getElementById('devStatusSel').value = 'wont_do';
    devApply();
    if (DEV_POSTED.length) return 'sent anyway';
    var said = document.getElementById('devMsg').textContent;
    return /why/i.test(said) || 'said: ' + said;
});
t('save: a status change is sent with its note', function () {
    devStage(); devOpen(1003); DEV_POSTED.length = 0;
    document.getElementById('devStatusSel').value = 'wont_do';
    document.getElementById('devNote').value = 'Covered by SN-1002';
    devApply();
    var p = DEV_POSTED[0] || {};
    return (p.action === 'status' && p.id === 1003 && p.to === 'wont_do' && p.note === 'Covered by SN-1002') || JSON.stringify(DEV_POSTED);
});
t('save: nothing changed sends nothing', function () {
    devStage(); devOpen(1003); DEV_POSTED.length = 0;
    devApply();
    return !DEV_POSTED.length || 'sent ' + JSON.stringify(DEV_POSTED);
});
t('comment: an empty one is not sent', function () {
    devStage(); devOpen(1003); DEV_POSTED.length = 0;
    devComment();
    return !DEV_POSTED.length || 'sent an empty comment';
});

// The header button. data-feature-any, because a plain [data-feature] with no
// role classes is shown to everyone unless an override says otherwise.
t('header button: shown to a dev-tracker holder, hidden from everyone else', function () {
    var host = document.getElementById('dev-host') || devStage();
    host.insertAdjacentHTML('beforeend', '<div class="action-btn dev-nav-btn" id="devBtnProbe" data-feature-any="dev-tracker" style="display:none;"></div>');
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

// ---- Phase 3 part 2: intake (Submit a Ticket) -------------------------------
// Its popup has its own suite, submit-ticket-check.js. These are the two things
// the tracker page gained for it.
// replaceState, never location.hash = …: a fragment assignment is a navigation,
// and headless --dump-dom sat waiting on it until the run was killed.
t('intake: the email link dev.html#SN-n opens that ticket, once', function () {
    var was = window.location.hash;
    var setHash = function (h) { history.replaceState(null, '', window.location.pathname + window.location.search + h); };
    try {
        setHash('#SN-573');
        devStage(); _devOpenId = null; _devHashDone = false;
        _devOpenFromHash();
        if (_devOpenId !== 573) return 'opened ' + _devOpenId;
        _devOpenId = null;
        _devOpenFromHash();
        if (_devOpenId !== null) return 'opened again on a later load';
        setHash('#SN-99999');
        _devHashDone = false; _devOpenFromHash();
        return _devOpenId === null || 'opened a ticket that does not exist';
    } finally { setHash(was || ''); _devHashDone = true; }
});
t('intake: a submitted ticket says so, and lists its attachment', function () {
    devStage();
    _devData.tickets.push(Object.assign(devFixture().tickets[0], { id: 1010, status: 'triage', source: 'idea',
        attachments: [{ name: 'photo.jpg', url: 'https://example.invalid/signed' }, { name: 'old.pdf', url: null }] }));
    devOpen(1010);
    if (!/from Submit a Ticket/.test(document.getElementById('devDetailEyebrow').textContent)) return 'eyebrow: ' + document.getElementById('devDetailEyebrow').textContent;
    var a = document.querySelector('#devDetailBody a[href="https://example.invalid/signed"]');
    if (!a || a.textContent !== 'photo.jpg') return 'no link to the attachment';
    return /old\.pdf[\s\S]*expired/.test(document.getElementById('devDetailBody').textContent) || 'an unsigned attachment is not explained';
});
