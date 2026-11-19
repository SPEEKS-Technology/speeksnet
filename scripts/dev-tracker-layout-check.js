// DEVELOPMENT TRACKER LAYOUT — does dev.html fit at phone, tablet and desktop widths.
//
//   powershell -File scripts/browser-check.ps1 dev-tracker-layout-check.js
//   powershell -File scripts/browser-check.ps1 dev-tracker-layout-check.js -WindowSize 1440,900
//
// Run twice, as Projects' is: media queries read the WINDOW, not the stage, so
// each run measures only the widths on its own side of the 900px line. The
// table sits in .prj-table-wrap, which scrolls sideways on purpose — allowed;
// the page itself growing is not.

_featureOv = { role: {}, user: {} };

function stage(width, html) {
    var host = document.getElementById('layout-host');
    if (!host) { host = document.createElement('div'); host.id = 'layout-host'; document.body.appendChild(host); }
    host.style.cssText = 'width:' + width + 'px;overflow:hidden;';
    host.innerHTML = html;
    void host.offsetHeight;
    return host;
}
function overflowing(host) {
    var bad = [], limit = host.getBoundingClientRect().right;
    host.querySelectorAll('*').forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= limit + 1) return;
        for (var p = el.parentElement; p && p !== host; p = p.parentElement) {
            var s = getComputedStyle(p);
            if (s.overflowX === 'auto' || s.overflowX === 'scroll') return;
        }
        bad.push((el.className || el.tagName) + ' right@' + Math.round(r.right) + ' > ' + Math.round(limit));
    });
    return bad;
}

var LONG = 'https://github.com/SPEEKS-Technology/speeksnet/blob/pre-release/supabase/functions/b2b-deals/index.ts#L1234-L1290';
function fixture() {
    var now = Date.now();
    var T = function (id, status, extra) {
        var b = { id: id, title: 'Ticket ' + id + ' — callback list does not refresh after a match', description: 'Steps, what happens, what should. ' + LONG,
            type: 'improvement', area: 'quickportal', priority: 'urgent', status: status, assignee_id: 'e', assignee_name: 'Alexandra Longname-Hyphenated',
            reporter_id: 'e', reporter_name: 'Ethan Kushnir', reporter_store: 'CORP', stores: ['OVL', 'LEE', 'WSP', 'MPL', 'BAL', 'CORP'],
            release_id: 1, due: '2026-12-01', source: 'github_import', github_number: id, closed_at: null,
            created_at: new Date(now - 86400000).toISOString(), updated_at: new Date(now).toISOString() };
        for (var k in extra) b[k] = extra[k];
        return b;
    };
    return {
        me: { id: 'n', name: 'Nick Hettinger', test: false }, can: { dev: true },
        devs: [{ id: 'e', name: 'Alexandra Longname-Hyphenated' }, { id: 'n', name: 'Nick Hettinger' }],
        types: [{ key: 'improvement', label: 'Improvement', active: true }],
        areas: [{ key: 'quickportal', label: 'QuickPortal', active: true }],
        releases: [{ id: 1, version: 'v3.13.0', title: 'Main December Update — the one with everything in it', status: 'in_progress' }],
        tickets: [T(573, 'backlog', { title: 'Supercalifragilisticexpialidocious-callback-refresh-after-match-v2' }), T(574, 'backlog', { status: 'wont_do' }), T(575, 'in_progress')],
        events: [{ id: 1, ticket_id: 573, kind: 'status', actor_name: 'Alexandra Longname-Hyphenated', to_value: 'wont_do', note: LONG, created_at: new Date().toISOString() }],
        comments: [{ id: 1, ticket_id: 573, body: LONG + ' ' + LONG, author_name: 'Nick Hettinger', author_id: 'n', source: 'speeksnet', created_at: new Date().toISOString() }],
        links: [{ id: 1, ticket_id: 573, kind: 'pr', ref: '581', url: LONG, title: LONG, state: 'open' }],
    };
}
// The card as dev.html builds it.
function renderPane(width) {
    var host = stage(width, '<div class="card ws-tool-panel ws-panel ws-panel-projects ws-panel-dev"><div class="ws-head"><div class="ws-head-main">'
        + '<span class="ws-head-ico dev-head-ico"><svg viewBox="0 0 24 24"></svg></span>'
        + '<div class="ws-head-titles"><span class="ws-head-eyebrow">Development</span><span class="ws-head-title">Tickets</span><span class="ws-head-sub" id="devHeadSub"></span></div></div>'
        + '<div class="ws-head-controls dev-head-controls"><input id="devSearch" class="dev-search" type="search"><select id="devAreaFilter" class="kpi-select dev-filter"><option>All areas</option></select>'
        + '<label class="dev-mine"><input type="checkbox"> Mine</label><button id="devNewBtn" class="kpi-update-trigger-btn">＋ New Ticket</button></div></div>'
        + '<div class="ws-scroll" id="devBody"></div></div>');
    _devData = fixture(); _devView = 'backlog'; _devSearch = ''; _devArea = ''; _devMine = false;
    devRender();
    void host.offsetHeight;
    return host;
}

[390, 820, 1440].filter(function (w) { return (w > 900) === (window.innerWidth > 900); }).forEach(function (w) {
    t('list @' + w + ': nothing spills past the frame', function () {
        var bad = overflowing(renderPane(w));
        return bad.length === 0 || bad.slice(0, 4).join(' ; ');
    });
    t('list @' + w + ': every status button, row and head control has a real size', function () {
        renderPane(w);
        var flat = Array.prototype.filter.call(document.querySelectorAll('#layout-host .prj-seg-btn, #layout-host .prj-row, #layout-host .dev-head-controls > *'), function (el) {
            var r = el.getBoundingClientRect();
            return r.width < 40 || r.height < 18;
        });
        return flat.length === 0 || flat.length + ' element(s) collapsed: ' + flat.map(function (e) { return e.className || e.tagName; }).slice(0, 3).join(', ');
    });
    t('detail @' + w + ': long words in description, comments, links and history wrap', function () {
        var host = stage(Math.min(w, 760), '<div id="devDetailEyebrow"></div><div id="devDetailHead"></div><div id="devDetailSub" class="prj-detail-sub"></div>'
            + '<div class="manage-content prj-detail-body dev-detail-body" id="devDetailBody" style="height:auto;max-height:none;overflow:visible;"></div>'
            + '<div class="manage-footer prj-detail-foot" id="devDetailFooter"></div>');
        _devData = fixture(); _devOpenId = 573; _devEditingComment = null;
        _devRenderDetail();
        void host.offsetHeight;
        var bad = overflowing(host);
        return bad.length === 0 || bad.slice(0, 3).join(' ; ');
    });
});

[390, 820].forEach(function (w) {
    t('detail footer @' + w + ': status, assignee, note and three buttons all fit', function () {
        _devData = fixture();
        var host = stage(w, '<div class="modal-menu manage-menu prj-detail-modal show" style="position:static;transform:none;width:100%;max-width:100%;">'
            + '<div class="manage-footer prj-detail-foot">' + _devFootHtml(_devById(575)) + '</div></div>');
        var bad = overflowing(host);
        if (bad.length) return bad.slice(0, 3).join(' ; ');
        var btns = host.querySelectorAll('.prj-foot-btns button');
        var squashed = Array.prototype.filter.call(btns, function (b) { return b.getBoundingClientRect().width < 40; });
        return (btns.length === 3 && squashed.length === 0) || btns.length + ' buttons, ' + squashed.length + ' squashed';
    });
    t('form @' + w + ': the field grid and stores fit, and the description keeps its rows', function () {
        _devData = fixture();
        var host = stage(w, '<div class="manage-content prj-form dev-form" style="height:auto;max-height:none;">'
            + '<label class="form-label-caps">Title</label><input id="devFTitle" class="form-input-lg">'
            + '<div class="dev-form-grid"><div><label class="form-label-caps">Type</label><select id="devFType" class="kpi-select"></select></div>'
            + '<div><label class="form-label-caps">Area</label><select id="devFArea" class="kpi-select"></select></div>'
            + '<div><label class="form-label-caps">Priority</label><select id="devFPriority" class="kpi-select"></select></div>'
            + '<div><label class="form-label-caps">Assigned to</label><select id="devFAssignee" class="kpi-select"></select></div>'
            + '<div><label class="form-label-caps">Release</label><select id="devFRelease" class="kpi-select"></select></div>'
            + '<div><label class="form-label-caps">Due</label><input id="devFDue" type="date" class="kpi-select"></div></div>'
            + '<label class="form-label-caps">Description</label><textarea id="devFDesc" class="form-input-lg" rows="7"></textarea>'
            + '<div class="dev-stores" id="devFStores"></div></div>'
            + '<span id="devFormTitle"></span><span id="devFormSub"></span><button id="devFormSubmit"></button><span id="devFormMsg"></span>');
        _devFillForm(_devById(573));
        void host.offsetHeight;
        var bad = overflowing(host);
        if (bad.length) return bad.slice(0, 3).join(' ; ');
        var ta = host.querySelector('textarea');
        return ta.getBoundingClientRect().height >= 100 || 'description squashed to ' + Math.round(ta.getBoundingClientRect().height) + 'px';
    });
});

// ---- Submit a Ticket (Phase 3 part 2) ----------------------------------------
// The real popup (injectIdeaModal), pulled into the stage and laid out in
// place, since its look hangs off #ideaModal. Phone width is where it's used
// most: a store employee with a photo.
function ideaStage(width, tickets) {
    var old = document.getElementById('ideaModal'); if (old) old.remove();
    _ideaData = tickets ? { me: { name: 'Browser Check', test: false }, types: [{ key: 'bug', label: 'Bug' }], areas: [{ key: 'b2b', label: 'B2B' }], tickets: tickets } : null;
    injectIdeaModal();
    var m = document.getElementById('ideaModal');
    var host = stage(width, '');
    host.appendChild(m);
    m.style.cssText = 'position:static;display:block;opacity:1;visibility:visible;transform:none;width:100%;max-width:100%;';
    var was = sessionStorage.getItem('speeksUserPin');
    sessionStorage.setItem('speeksUserPin', '9999');
    try {
        _ideaResetForm();
        if (tickets) { ideaSetTab('mine'); }
    } finally { if (was === null) sessionStorage.removeItem('speeksUserPin'); else sessionStorage.setItem('speeksUserPin', was); }
    void host.offsetHeight;
    return host;
}
[390, 820].forEach(function (w) {
    t('submit a ticket @' + w + ': the form fits', function () {
        var host = ideaStage(w);
        var bad = overflowing(host);
        var sel = document.getElementById('ideaArea').getBoundingClientRect();
        if (sel.width < 100) return 'Area select squeezed to ' + Math.round(sel.width) + 'px';
        return !bad.length || bad.slice(0, 4).join('; ');
    });
    t('submit a ticket @' + w + ': My Tickets fits a long title and a long reason', function () {
        var host = ideaStage(w, [
            { id: 1234, title: 'Supercalifragilisticexpialidocious-callback-refresh-after-match-v2 and then some more words', type: 'bug', area: 'b2b', status: 'on_prerelease', created_at: new Date().toISOString() },
            { id: 1235, title: 'Short', type: 'bug', area: null, status: 'wont_do', reason: LONG, created_at: new Date().toISOString() },
        ]);
        var bad = overflowing(host);
        if (bad.length) return bad.slice(0, 4).join('; ');
        var chip = host.querySelector('.idea-mine-main .prj-chip').getBoundingClientRect();
        return chip.width > 40 || 'status chip squeezed to ' + Math.round(chip.width) + 'px';
    });
});
(function () { var m = document.getElementById('ideaModal'); if (m) m.remove(); _ideaData = null; })();
