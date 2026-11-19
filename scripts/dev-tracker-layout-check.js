// THE DEVELOPMENT SUITE — does it fit? (dev.html = dev.js + dev.css)
//
//   powershell -File scripts/browser-check.ps1 dev-tracker-layout-check.js -Js dev.js -Css dev.css
//   powershell -File scripts/browser-check.ps1 dev-tracker-layout-check.js -Js dev.js -Css dev.css -WindowSize 1440,900
//
// Run twice. dev.css's breakpoints read the WINDOW: headless Chrome's default
// (~800px) lands under the 960px line, so the first run measures the narrow
// layout (icon sidebar, the panel over the list) and the second the full one.
// The app is the whole viewport (100vh grid), so it is measured in place, not
// in a stage: nothing may poke out past the window's right edge, and nothing
// may spill out of the box it sits in, except where something scrolls.

window.DEV_NO_BOOT = true;
// Measure where things SETTLE: the panel slides in from 14px right over 180ms,
// and the harness measures at time zero. And measure against the visible width
// (clientWidth) — the harness page has a scrollbar the real one (overflow:
// hidden) never shows.
(function () { var st = document.createElement('style'); st.textContent = '*{animation:none!important;transition:none!important}'; document.head.appendChild(st); })();
var VW = function () { return document.documentElement.clientWidth; };
Dev.stub(function (url, body) { return body === undefined ? new Promise(function () {}) : Promise.resolve({ success: true }); });

var LONG = 'https://github.com/SPEEKS-Technology/speeksnet/blob/pre-release/supabase/functions/b2b-deals/index.ts#L1234-L1290';
function fixture() {
    var now = Date.now();
    var T = function (id, status, extra) {
        var b = { id: id, title: 'Ticket ' + id + ' — callback list does not refresh after a match is made on the QuickPortal widget', description: 'Steps, what happens, what should. ' + LONG,
            type: 'improvement', area: 'quickportal', priority: 'urgent', status: status, assignee_id: 'e', assignee_name: 'Alexandra Longname-Hyphenated',
            reporter_id: 'e', reporter_name: 'Ethan Kushnir', reporter_store: 'CORP', stores: ['OVL', 'LEE', 'WSP', 'MPL', 'BAL', 'CORP'],
            release_id: 1, due: '2026-12-01', source: 'github_import', github_number: id, closed_at: null, attachments: [{ name: 'a-very-long-screenshot-file-name-from-a-phone-IMG_20261119_123456789.jpg', url: LONG }],
            created_at: new Date(now - 86400000).toISOString(), updated_at: new Date(now).toISOString() };
        for (var k in extra) b[k] = extra[k];
        return b;
    };
    return {
        me: { id: 'n', name: 'Nick Hettinger', test: false }, can: { dev: true },
        devs: [{ id: 'e', name: 'Alexandra Longname-Hyphenated' }, { id: 'n', name: 'Nick Hettinger' }],
        types: [{ key: 'improvement', label: 'Improvement', active: true }],
        areas: [{ key: 'quickportal', label: 'QuickPortal and the Command Center', active: true }],
        releases: [{ id: 1, version: 'v3.13.0', title: 'Main December Update — the one with everything in it', status: 'in_progress' }],
        tickets: [T(573, 'backlog', { title: 'Supercalifragilisticexpialidocious-callback-refresh-after-match-v2-with-no-spaces-at-all' }), T(574, 'in_review'), T(575, 'in_progress')],
        events: [{ id: 1, ticket_id: 573, kind: 'status', actor_name: 'Alexandra Longname-Hyphenated', to_value: 'wont_do', note: LONG, created_at: new Date().toISOString() }],
        comments: [{ id: 1, ticket_id: 573, body: LONG + ' ' + LONG, author_name: 'Nick Hettinger', author_id: 'n', source: 'speeksnet', created_at: new Date().toISOString() }],
        links: [
            { id: 1, ticket_id: 573, kind: 'pr', ref: '581', url: LONG, title: LONG, state: 'open', base: 'Main-December-Update-2---Ethan', author: 'Eckushnir',
              checks: [{ kind: 'migration', level: 'error', text: '0192 is also used on feat/some-very-long-branch-name-with-no-breaks-at-all (0192_another_migration_with_a_long_name) — renumber one of them' }] },
            { id: 2, ticket_id: 573, kind: 'branch', ref: 'fix/sn-573-supercalifragilisticexpialidocious-callback-refresh-after-match', url: LONG, state: 'active' },
            { id: 3, ticket_id: 573, kind: 'commit', ref: 'abcdef1234567890', url: LONG, title: LONG },
        ],
        branches: [
            { name: 'pre-release', kind: 'base', ahead: 0, behind: 0, last_commit_message: 'Merge pull request #581 from SPEEKS-Technology/feat/projects-completion-signoff', last_commit_author: 'back707', last_commit_at: new Date().toISOString() },
            { name: 'Main-December-Update-2---Ethan-and-a-much-longer-name-than-anyone-would-type', kind: 'untracked', ahead: 117, behind: 210, pr_number: 576, pr_state: 'open', last_commit_message: LONG, last_commit_author: 'Eckushnir', last_commit_at: new Date().toISOString() },
            { name: 'feat/projects-completion-signoff', kind: 'untracked', ahead: 0, behind: 1, merged: true, pr_number: 581, pr_state: 'merged', last_commit_at: new Date().toISOString() },
            { name: 'fix/sn-573-supercalifragilisticexpialidocious-callback-refresh', kind: 'ticket', ticket_id: 573, ahead: 3, behind: 0, last_commit_at: new Date().toISOString() },
        ],
    };
}
function stage(view) {
    ['dvApp', 'dvLayer', 'dvToasts'].forEach(function (id) {
        if (!document.getElementById(id)) { var d = document.createElement('div'); d.id = id; document.body.appendChild(d); }
    });
    var app = document.getElementById('dvApp');
    app.className = 'dv-app'; app.innerHTML = '';
    Dev.closePop(); Dev.closeModal();
    Dev.setData(fixture());
    Dev.S.view = view; Dev.S.query = ''; Dev.S.openId = null; Dev.S.selId = null;
    Dev.S.filters = { area: '', type: '', assignee: '' };
    Dev.renderShell(); Dev.renderAll();
    void app.offsetHeight;
    return app;
}
// Anything past the window's right edge, or spilling out of its parent box,
// unless an ancestor scrolls or clips it on purpose (ellipsis).
function spills(root) {
    var bad = [], W = VW();
    root.querySelectorAll('*').forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        if (r.right > W + 1) bad.push((el.className || el.tagName) + ' right@' + Math.round(r.right) + ' > window ' + W);
        var p = el.parentElement;
        if (!p || p === root) return;
        for (var a = p; a && a !== root; a = a.parentElement) {
            var s = getComputedStyle(a);
            if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return;
        }
        var pr = p.getBoundingClientRect();
        if (r.right > pr.right + 1.5) bad.push((typeof el.className === 'string' ? el.className : el.tagName) + ' spills ' + Math.round(r.right - pr.right) + 'px out of ' + (typeof p.className === 'string' ? p.className : p.tagName));
    });
    return bad;
}
var W = VW();

t('layout @' + W + ': the shell fills the window, no sideways scroll', function () {
    stage('open');
    var app = document.getElementById('dvApp').getBoundingClientRect();
    if (Math.abs(app.width - VW()) > 2) return 'app is ' + Math.round(app.width) + ' wide in a ' + VW() + ' window';
    return document.documentElement.scrollWidth <= VW() + 1 || 'page scrolls sideways: ' + document.documentElement.scrollWidth;
});
t('layout @' + W + ': ticket rows hold a long unbroken title', function () {
    stage('open');
    var bad = spills(document.getElementById('dvList'));
    if (bad.length) return bad.slice(0, 3).join('; ');
    var row = document.querySelector('.dv-row');
    return row.getBoundingClientRect().height <= 41 || 'a row grew to ' + Math.round(row.getBoundingClientRect().height) + 'px';
});
t('layout @' + W + ': the panel (long title, links, checks, comment) stays inside', function () {
    stage('open'); Dev.open(573);
    var p = document.querySelector('.dv-panel');
    if (!p) return 'no panel';
    var r = p.getBoundingClientRect();
    if (r.right > VW() + 1) return 'panel ends at ' + Math.round(r.right);
    if (r.width < 300) return 'panel squeezed to ' + Math.round(r.width);
    var bad = spills(p);
    return !bad.length || bad.slice(0, 3).join('; ');
});
t('layout @' + W + ': the list keeps room beside the panel (or the panel covers it, narrow)', function () {
    stage('open'); Dev.open(573);
    var list = document.getElementById('dvList').getBoundingClientRect();
    var panel = document.querySelector('.dv-panel').getBoundingClientRect();
    if (VW() <= 960) return Math.abs(panel.left - list.left) < 2 || 'narrow: panel should cover the list';
    return list.width >= 480 || 'list squeezed to ' + Math.round(list.width);
});
t('layout @' + W + ': branches hold long names, messages and counts', function () {
    stage('branches');
    var bad = spills(document.getElementById('dvList'));
    return !bad.length || bad.slice(0, 3).join('; ');
});
t('layout @' + W + ': a picker opens inside the window', function () {
    stage('open'); Dev.open(573);
    var anchor = document.querySelector('.dv-prop[data-pick="assignee"]');
    Dev.pickFor(Dev.idx.byId.get(573), 'assignee', anchor);
    var pop = document.querySelector('.dv-pop');
    if (!pop) return 'no picker';
    var r = pop.getBoundingClientRect();
    Dev.closePop();
    return (r.left >= 0 && r.right <= VW() + 1 && r.top >= 0 && r.bottom <= window.innerHeight + 1) || 'picker at ' + JSON.stringify({ l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) });
});
t('layout @' + W + ': the new-ticket form fits', function () {
    stage('open'); Dev.newTicket();
    var m = document.querySelector('.dv-modal');
    if (!m) return 'no form';
    var r = m.getBoundingClientRect();
    var bad = spills(m);
    Dev.closeModal();
    if (r.right > VW() + 1 || r.left < 0) return 'form off screen';
    return !bad.length || bad.slice(0, 3).join('; ');
});
t('layout @' + W + ': the sidebar fits its column' + (W <= 960 ? ' (icons only)' : ''), function () {
    stage('open');
    var side = document.getElementById('dvSide').getBoundingClientRect();
    if (W <= 960) return side.width <= 70 || 'sidebar ' + Math.round(side.width) + ' wide when narrow';
    var bad = spills(document.getElementById('dvSide'));
    return !bad.length || bad.slice(0, 3).join('; ');
});
// Leave the page as the harness found it.
(function () { ['dvApp', 'dvLayer', 'dvToasts'].forEach(function (id) { var e = document.getElementById(id); if (e) e.remove(); }); })();
