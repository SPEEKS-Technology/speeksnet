// DEVELOPMENT TRACKER — checks that need the REAL dev.html markup.
//
//   powershell -File scripts/browser-check.ps1 dev-tracker-page-check.js -Html dev.html
//
// Same split as projects-page-check.js. Changes no sessionStorage, on purpose
// (CLAUDE.md, "Verifying a change"). The header button is in all seven pages'
// headers; this checks dev.html's copy — `grep -c 'id="devTrackerBtn"' *.html`
// is the one-line check that the other six still carry it.

// The runner signs in as "Browser Check" (MOCD), who doesn't hold dev-tracker —
// so the page's own gate (initDevPage, which runs after this file) sent the
// harness to index.html and the report was lost. Grant it here, in memory only:
// _featureOv is what the gate reads, and the network refresh that could replace
// it is blocked in the harness. Nothing is written to sessionStorage.
_featureOv = { role: {}, user: { 'dev-tracker': { 'browser check': true } } };

function inMain(el) { var main = document.querySelector('.main-content'); return !!(el && main && main.contains(el)); }

t('header: the Development button sits directly right of Settings', function () {
    var s = document.getElementById('notifySettingsBtn');
    if (!s) return 'no #notifySettingsBtn';
    var next = s.nextElementSibling;
    return (next && next.id === 'devTrackerBtn') || 'next to Settings is ' + (next ? (next.id || next.className) : 'nothing');
});
t('header: gated by data-feature-any="dev-tracker", never a plain data-feature', function () {
    var b = document.getElementById('devTrackerBtn');
    if (b.getAttribute('data-feature-any') !== 'dev-tracker') return 'data-feature-any is ' + b.getAttribute('data-feature-any');
    if (b.hasAttribute('data-feature')) return 'carries a plain data-feature, which shows to everyone by default';
    return /display:\s*none/.test(b.getAttribute('style') || '') || 'not hidden until the sweep says so';
});
t('header: green chip, phone-hidden, opens dev.html', function () {
    var b = document.getElementById('devTrackerBtn');
    if (!b.classList.contains('action-btn') || !b.classList.contains('dev-nav-btn')) return 'classes: ' + b.className;
    if (b.getAttribute('data-mobile') !== 'hide') return 'not hidden on phones';
    return /dev\.html/.test(b.getAttribute('onclick') || '') || 'onclick: ' + b.getAttribute('onclick');
});
t('header: the tint is green', function () {
    var b = document.getElementById('devTrackerBtn');
    var was = b.getAttribute('style');
    b.setAttribute('style', 'display:flex;');
    try {
        var m = (getComputedStyle(b).backgroundColor.match(/[\d.]+/g) || []).map(Number);
        return (m[1] > m[0] && m[1] > m[2]) || 'background is ' + getComputedStyle(b).backgroundColor;
    } finally { b.setAttribute('style', was); }
});
t('page: hero, card head and list body', function () {
    var wrap = document.querySelector('.main-content > .dev-wrap');
    if (!wrap) return 'no .dev-wrap in .main-content';
    if (!wrap.querySelector('.page-header.dp-header h2')) return 'no hero';
    var card = wrap.querySelector('#dev-pane-tickets .card.ws-tool-panel.ws-panel');
    if (!card) return 'no card';
    if (!card.querySelector('.ws-head .ws-head-title')) return 'no .ws-head';
    return !!card.querySelector('#devBody') || 'no #devBody';
});
t('page: search, area, Mine and New Ticket are in the card head', function () {
    var ids = ['devSearch', 'devAreaFilter', 'devMineOnly', 'devNewBtn'].filter(function (id) {
        var el = document.getElementById(id);
        return !el || !el.closest('.ws-head-controls');
    });
    return !ids.length || 'missing from the head: ' + ids.join(', ');
});
t('popups: inside .main-content, outside the pane', function () {
    var bad = ['devDetailModal', 'devFormModal'].filter(function (id) {
        var el = document.getElementById(id);
        return !el || !inMain(el) || el.closest('.ws-pane') || !el.classList.contains('modal-menu');
    });
    return !bad.length || 'misplaced: ' + bad.join(', ');
});
t('form: the fields the function takes', function () {
    var ids = Array.prototype.map.call(document.querySelectorAll('#devFormModal .dev-form input:not([type=checkbox]), #devFormModal .dev-form textarea, #devFormModal .dev-form select'),
        function (f) { return f.id; }).join(',');
    return ids === 'devFTitle,devFType,devFArea,devFPriority,devFAssignee,devFRelease,devFDue,devFDesc' || 'fields: ' + ids;
});
t('page: the shared shell came along (settings, side panels, feature access)', function () {
    var need = ['settingsModal', 'goalsSidePanel', 'featureAccessModal'].filter(function (id) { return !document.getElementById(id); });
    return !need.length || 'missing: ' + need.join(', ');
});
// (The <title> isn't checkable here: -Html inlines the <body> only.)
t('page: no nav tab claims to be active — the tracker has no nav tab', function () {
    return !document.querySelector('.nav-bar .nav-link.active') || 'a nav link is marked active';
});
t('page: Sync with GitHub sits in the card head, before New Ticket', function () {
    var s = document.getElementById('devSyncBtn');
    if (!s || !s.closest('.ws-head-controls')) return 'no #devSyncBtn in the head';
    return s.nextElementSibling && s.nextElementSibling.id === 'devNewBtn' || 'not directly before New Ticket';
});
