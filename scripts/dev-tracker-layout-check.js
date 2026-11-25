// THE DEVELOPMENT SUITE — does the pipeline fit? (dev.html = dev.js + dev.css)
//
//   powershell -File scripts/browser-check.ps1 dev-tracker-layout-check.js -Js dev.js -Css dev.css
//   powershell -File scripts/browser-check.ps1 dev-tracker-layout-check.js -Js dev.js -Css dev.css -WindowSize 1440,900
//
// Run twice. dev.css's breakpoints read the WINDOW: headless Chrome's default
// (~800px) lands under the 960px line, so the first run measures the stacked
// layout (Backlog, then the branches, then pre-release, scrolling down) and the
// second the full three-part pipeline. The app is the whole viewport, so it is
// measured in place, not in a stage: nothing may poke out past the window's
// right edge, and nothing may spill out of the box it sits in, except where
// something scrolls (the branches scroll sideways on purpose).

window.DEV_NO_BOOT = true;
// Measure where things SETTLE: the panel slides in over 180ms, and the harness
// measures at time zero. And measure against the visible width (clientWidth) —
// the harness page has a scrollbar the real one (overflow: hidden) never shows.
(function () { var st = document.createElement('style'); st.textContent = '*{animation:none!important;transition:none!important}'; document.head.appendChild(st); })();
var VW = function () { return document.documentElement.clientWidth; };
Dev.stub(function (url, body) { return body === undefined ? new Promise(function () {}) : Promise.resolve({ success: true, key: body.action === 'mcp_key_create' ? 'sndev_' + new Array(44).join('x') : undefined, keys: /^mcp_key/.test(body.action) ? [{ id: 1, label: 'A label long enough to need cutting short on a phone screen, really', hint: 'xxxx', created_at: new Date().toISOString(), last_used_at: new Date().toISOString() }] : undefined }); });

var LONG = 'https://github.com/SPEEKS-Technology/speeksnet/blob/pre-release/supabase/functions/b2b-deals/index.ts#L1234-L1290';
var LONGBR = 'Main-December-Update-2---Ethan-and-a-much-longer-name-than-anyone-would-type';
function fixture() {
    var now = Date.now();
    var T = function (id, status, extra) {
        var b = { id: id, title: 'Ticket ' + id + ' — callback list does not refresh after a match is made on the QuickPortal widget', description: 'Steps, what happens, what should. ' + LONG,
            type: 'improvement', area: 'quickportal', priority: 'urgent', status: status, assignee_id: 'e', assignee_name: 'Alexandra Longname-Hyphenated',
            reporter_id: 'e', reporter_name: 'Ethan Kushnir', reporter_store: 'CORP', stores: ['OVL', 'LEE', 'WSP', 'MPL', 'BAL', 'CORP'],
            release_id: 14, due: '2026-12-01', source: 'github_import', github_number: id, closed_at: null, branch: null, branch_done: false,
            attachments: [{ name: 'a-very-long-screenshot-file-name-from-a-phone-IMG_20261119_123456789.jpg', url: LONG }],
            created_at: new Date(now - 86400000).toISOString(), updated_at: new Date(now).toISOString() };
        for (var k in extra) b[k] = extra[k];
        return b;
    };
    var many = [];
    for (var i = 0; i < 14; i++) many.push(T(600 + i, 'backlog', { priority: 'normal', type: i % 2 ? 'bug' : 'suggestion' }));
    return {
        me: { id: 'n', name: 'Nick Hettinger', test: false }, can: { dev: true },
        pipeline: {
            live: { id: 57, version: 'v3.12.3', title: 'v3.12.3', published_at: new Date(now).toISOString() },
            next: { id: 14, size: 'overhaul', title: 'The December Update — with every last thing we could fit into it, and then some more', version: 'v4.0.0',
                versions: { minor: 'v3.12.4', major: 'v3.13.0', overhaul: 'v4.0.0' }, needs_title: true },
        },
        devs: [{ id: 'e', name: 'Alexandra Longname-Hyphenated' }, { id: 'n', name: 'Nick Hettinger' }],
        types: [{ key: 'improvement', label: 'Improvement', active: true }, { key: 'bug', label: 'Bug', active: true }, { key: 'suggestion', label: 'Suggestion', active: true }],
        areas: [{ key: 'quickportal', label: 'QuickPortal and the Command Center', active: true }],
        releases: [{ id: 14, version: null, title: 'Main December Update', status: 'in_progress' },
            { id: 57, version: 'v3.12.3', title: 'v3.12.3 — the one with a name long enough to need cutting short in a menu', status: 'published', published_at: new Date(now).toISOString() }],
        tickets: [
            T(573, 'triage', { title: 'Supercalifragilisticexpialidocious-callback-refresh-after-match-v2-with-no-spaces-at-all' }),
            T(574, 'in_review', { branch: LONGBR }),
            T(575, 'in_progress', { branch: LONGBR, branch_done: true }),
            T(576, 'in_progress', { branch: 'fix/sn-573-supercalifragilisticexpialidocious-callback-refresh' }),
            T(577, 'on_prerelease', { branch: LONGBR, title: 'Pre-release-ticket-with-an-unbroken-name-that-goes-on-and-on-forever' }),
            T(578, 'on_prerelease', { type: 'bug' }),
        ].concat(many),
        events: [{ id: 1, ticket_id: 573, kind: 'status', actor_name: 'Alexandra Longname-Hyphenated', to_value: 'wont_do', note: LONG, created_at: new Date().toISOString() }],
        comments: [{ id: 1, ticket_id: 573, body: LONG + ' ' + LONG, author_name: 'Nick Hettinger', author_id: 'n', source: 'speeksnet', created_at: new Date().toISOString() }],
        links: [
            { id: 1, ticket_id: 573, kind: 'pr', ref: '581', url: LONG, title: LONG, state: 'open', base: 'Main-December-Update-2---Ethan', author: 'Eckushnir',
              checks: [{ kind: 'migration', level: 'error', text: '0192 is also used on feat/some-very-long-branch-name-with-no-breaks-at-all (0192_another_migration_with_a_long_name) — renumber one of them' }] },
            { id: 2, ticket_id: 573, kind: 'branch', ref: 'fix/sn-573-supercalifragilisticexpialidocious-callback-refresh-after-match', url: LONG, state: 'active' },
            { id: 3, ticket_id: 573, kind: 'commit', ref: 'abcdef1234567890', url: LONG, title: LONG },
        ],
        branches: [
            { name: 'pre-release', kind: 'base', ahead: 0, behind: 0, last_commit_at: new Date().toISOString() },
            { name: LONGBR, kind: 'untracked', ahead: 117, behind: 210, pr_number: 576, pr_state: 'draft', last_commit_author: 'Eckushnir', last_commit_at: new Date().toISOString() },
            { name: 'feat/projects-completion-signoff', kind: 'untracked', ahead: 0, behind: 1, merged: true, pr_number: 581, pr_state: 'merged', last_commit_at: new Date().toISOString() },
            { name: 'fix/sn-573-supercalifragilisticexpialidocious-callback-refresh', kind: 'ticket', ahead: 3, behind: 0, last_commit_at: new Date().toISOString() },
            { name: 'feat/a', kind: 'untracked', ahead: 1, behind: 0, last_commit_at: new Date().toISOString() },
            { name: 'feat/b', kind: 'untracked', ahead: 1, behind: 0, last_commit_at: new Date().toISOString() },
        ],
    };
}
function stage() {
    ['dvApp', 'dvLayer', 'dvToasts'].forEach(function (id) {
        if (!document.getElementById(id)) { var d = document.createElement('div'); d.id = id; document.body.appendChild(d); }
    });
    var app = document.getElementById('dvApp');
    app.className = 'dv-app'; app.innerHTML = '';
    Dev.closePop(); Dev.closeModal();
    Dev.setData(fixture());
    Dev.S.query = ''; Dev.S.openId = null;
    Dev.renderShell(); Dev.renderAll();
    void app.offsetHeight;
    return app;
}
// Anything past the window's right edge, or spilling out of its parent box,
// unless an ancestor scrolls or clips it on purpose (ellipsis, the lanes).
function spills(root) {
    var bad = [], W = VW();
    root.querySelectorAll('*').forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        var clipped = false;
        for (var a = el.parentElement; a && a !== document.body; a = a.parentElement) {
            if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(a).overflowX)) { clipped = true; break; }
        }
        if (!clipped && r.right > W + 1) bad.push((typeof el.className === 'string' ? el.className : el.tagName) + ' right@' + Math.round(r.right) + ' > window ' + W);
        var p = el.parentElement;
        if (!p || p === root) return;
        for (var b = p; b && b !== root; b = b.parentElement) {
            if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(b).overflowX)) return;
        }
        var pr = p.getBoundingClientRect();
        if (r.right > pr.right + 1.5) bad.push((typeof el.className === 'string' ? el.className : el.tagName) + ' spills ' + Math.round(r.right - pr.right) + 'px out of ' + (typeof p.className === 'string' ? p.className : p.tagName));
    });
    return bad;
}
var W = VW();
var NARROW = W <= 960;

t('layout @' + W + ': the app fills the window, no sideways page scroll', function () {
    stage();
    var app = document.getElementById('dvApp').getBoundingClientRect();
    if (Math.abs(app.width - VW()) > 2) return 'app is ' + Math.round(app.width) + ' wide in a ' + VW() + ' window';
    var pipe = document.getElementById('dvPipe');
    if (pipe.scrollWidth > pipe.clientWidth + 1) return 'the pipeline scrolls sideways: ' + pipe.scrollWidth + ' > ' + pipe.clientWidth;
    return document.documentElement.scrollWidth <= VW() + 1 || 'page scrolls sideways: ' + document.documentElement.scrollWidth;
});
t('layout @' + W + ': the top bar fits on one line', function () {
    stage();
    var top = document.querySelector('.dv-top');
    if (top.scrollWidth > top.clientWidth + 1) return 'top bar overflows by ' + (top.scrollWidth - top.clientWidth);
    var bad = spills(top);
    return !bad.length || bad.slice(0, 3).join('; ');
});
t('layout @' + W + (NARROW ? ': the three parts stack, Backlog first' : ': Backlog | branches | pre-release side by side'), function () {
    stage();
    var b = document.getElementById('dvBacklog').getBoundingClientRect();
    var l = document.querySelector('.dv-lanes-wrap').getBoundingClientRect();
    var p = document.getElementById('dvPre').getBoundingClientRect();
    if (NARROW) return (b.bottom <= l.top + 1 && l.bottom <= p.top + 1) || 'not stacked: ' + [b.top, l.top, p.top].map(Math.round).join(',');
    if (!(b.right <= l.left + 1 && l.right <= p.left + 1)) return 'not side by side';
    return l.width >= 420 || 'the branches got only ' + Math.round(l.width) + 'px';
});
t('layout @' + W + ': backlog cards hold a long unbroken title, at two lines at most', function () {
    stage();
    var bad = spills(document.getElementById('dvBacklog'));
    if (bad.length) return bad.slice(0, 3).join('; ');
    var c = document.querySelector('#dvBacklog .dv-card[data-id="573"] .dv-card-title');
    var lh = parseFloat(getComputedStyle(c).lineHeight);
    return c.getBoundingClientRect().height <= lh * 2 + 2 || 'title is ' + Math.round(c.getBoundingClientRect().height) + 'px tall';
});
t('layout @' + W + ': a branch column holds a long name, its pills and its cards', function () {
    stage();
    var lane = document.querySelector('.dv-lane[data-lane="' + LONGBR + '"]');
    if (!lane) return 'no column';
    var bad = spills(lane);
    if (bad.length) return bad.slice(0, 3).join('; ');
    var nm = lane.querySelector('.dv-lane-nm');
    return nm.scrollWidth > nm.clientWidth || 'the long name is not cut short';
});
t('layout @' + W + ': many branches scroll sideways inside their area, not the page', function () {
    stage();
    var lanes = document.getElementById('dvLanes');
    if (lanes.scrollWidth <= lanes.clientWidth) return 'not enough columns to scroll — fixture too small for this width';
    var r = lanes.getBoundingClientRect();
    return r.right <= VW() + 1 || 'the branches area itself ends at ' + Math.round(r.right);
});
t('layout @' + W + ': pre-release holds a long title, the sizes and the notes', function () {
    stage();
    var bad = spills(document.getElementById('dvPre'));
    if (bad.length) return bad.slice(0, 3).join('; ');
    var sizes = document.querySelectorAll('.dv-sizes button');
    var short = Array.prototype.filter.call(sizes, function (s) { return s.getBoundingClientRect().width < 64; });
    return !short.length || 'a size button is ' + Math.round(short[0].getBoundingClientRect().width) + 'px wide';
});
t('layout @' + W + ': the ticket panel (long title, links, checks, comment) stays inside', function () {
    stage(); Dev.open(573);
    var p = document.querySelector('.dv-panel');
    if (!p) return 'no panel';
    var r = p.getBoundingClientRect();
    if (r.right > VW() + 1 || r.left < -1) return 'panel at ' + Math.round(r.left) + '–' + Math.round(r.right);
    if (r.width < Math.min(300, VW() - 2)) return 'panel squeezed to ' + Math.round(r.width);
    var bad = spills(p);
    Dev.closePanel();
    return !bad.length || bad.slice(0, 3).join('; ');
});
t('layout @' + W + ': the move menu and the live menu open inside the window', function () {
    stage();
    var inside = function () {
        var pop = document.querySelector('.dv-pop');
        if (!pop) return 'no menu';
        var r = pop.getBoundingClientRect();
        Dev.closePop();
        return (r.left >= 0 && r.right <= VW() + 1 && r.top >= 0 && r.bottom <= window.innerHeight + 1) || 'menu at ' + JSON.stringify({ l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) });
    };
    Dev.moveMenu(Dev.idx.byId.get(573), document.querySelector('.dv-card[data-id="573"] .dv-more'));
    var a = inside();
    if (a !== true) return 'move: ' + a;
    Dev.liveMenu(document.getElementById('dvLivePill'));
    var b = inside();
    return b === true || 'live: ' + b;
});
t('layout @' + W + ': the new-ticket and new-branch forms fit', function () {
    stage();
    var fits = function (what) {
        var m = document.querySelector('.dv-modal');
        if (!m) return 'no ' + what + ' form';
        var r = m.getBoundingClientRect();
        var bad = spills(m);
        Dev.closeModal();
        if (r.right > VW() + 1 || r.left < 0) return what + ' form off screen';
        return !bad.length || what + ': ' + bad.slice(0, 3).join('; ');
    };
    Dev.newTicket();
    var a = fits('ticket');
    if (a !== true) return a;
    Dev.newBranch([573]);
    return fits('branch');
});
t('layout @' + W + ': the Claude connector screen, with a new key and its setup lines, fits', function () {
    stage();
    Dev.connector();
    var m = document.querySelector('.dv-connector');
    if (!m) return 'no connector screen';
    m.querySelector('#dvKeyMake').click();
    return new Promise(function (res) { setTimeout(res, 0); }).then(function () {
        if (!m.querySelector('.dv-newkey')) return 'no new-key block';
        var r = m.getBoundingClientRect();
        var bad = spills(m);
        Dev.closeModal();
        if (r.right > VW() + 1 || r.left < 0) return 'screen off the window';
        return !bad.length || bad.slice(0, 3).join('; ');
    });
});
