// PROJECTS (Workspace tab) — checks that need the REAL workspace.html markup.
//
//   powershell -File scripts/browser-check.ps1 projects-page-check.js -Html workspace.html
//
// Same split as b2b-header-check.js: these assert about the DOM as the page
// declares it, which needs -Html, so they live apart from projects-check.js and
// the main suite never needs the flag.
//
// It changes no sessionStorage, on purpose: the page's own init runs after this
// file, and a role left behind would send the harness elsewhere and lose the
// report (CLAUDE.md, "Verifying a change").

_featureOv = { role: {}, user: {} };

function inMain(id) {
    var el = document.getElementById(id);
    var main = document.querySelector('.main-content');
    return !!(el && main && main.contains(el));
}

t('tab: Projects is a Workspace tab beside the others', function () {
    var tab = document.getElementById('ws-tab-projects');
    if (!tab) return 'no #ws-tab-projects';
    if (!tab.closest('.ws-subtabs')) return 'the tab is not in the .ws-subtabs strip';
    return tab.classList.contains('ws-tab') || 'not a .ws-tab';
});
// applyRoleBasedUI shows a role-classed tab from its classes and Feature Access
// from data-feature — both have to be on the element itself.
t('tab: gated by nav-projects and the same roles as its default', function () {
    var tab = document.getElementById('ws-tab-projects');
    if (tab.getAttribute('data-feature') !== 'nav-projects') return 'data-feature is ' + tab.getAttribute('data-feature');
    var want = ['role-manager', 'role-owner-manager', 'role-district-manager', 'role-ceo', 'role-mocd'];
    var missing = want.filter(function (c) { return !tab.classList.contains(c); });
    var extra = ['role-employee', 'role-assistant-manager', 'role-store'].filter(function (c) { return tab.classList.contains(c); });
    return (!missing.length && !extra.length) || 'missing ' + missing + ' / extra ' + extra;
});
t('tab: carries the waiting-on-you pip, B2B style', function () {
    var pip = document.querySelector('#ws-tab-projects #prjWaitPip');
    return (pip && pip.classList.contains('b2b-pip')) || 'no .b2b-pip inside the tab';
});
t('pane: a Workspace card with the shared head', function () {
    var pane = document.getElementById('ws-pane-projects');
    if (!pane || !pane.classList.contains('ws-pane')) return 'no #ws-pane-projects.ws-pane';
    var card = pane.querySelector('.card.ws-tool-panel.ws-panel');
    if (!card) return 'no .card.ws-tool-panel.ws-panel';
    return !!card.querySelector('.ws-head .ws-head-title') || 'no .ws-head title';
});
t('pane: request button uses the site\'s own button style', function () {
    var b = document.getElementById('prjNewBtn');
    return (b && b.classList.contains('kpi-update-trigger-btn') && !!b.closest('.ws-head-controls')) || 'request button missing or restyled';
});
t('pane: the list body is there', function () {
    return !!document.querySelector('#ws-pane-projects #prjBody') || 'no #prjBody in the pane';
});
// The SPA router swaps .main-content and carries modals from INSIDE it; a
// modal inside a .ws-pane would be hidden whenever that tab is not active.
t('popups: inside .main-content but outside every pane', function () {
    var bad = ['prjDetailModal', 'prjFormModal'].filter(function (id) {
        var el = document.getElementById(id);
        return !el || !inMain(id) || el.closest('.ws-pane') || !el.classList.contains('modal-menu');
    });
    return bad.length === 0 || 'misplaced: ' + bad.join(', ');
});
// Nick, 2026-11-17: "as simple as Project Title, Project Description, and Who's
// involved". A fourth field is a decision to make with him, not a drive-by.
t('form: asks for exactly three things — title, description, who\'s involved', function () {
    var fields = document.querySelectorAll('#prjFormModal .prj-form input, #prjFormModal .prj-form textarea, #prjFormModal .prj-form select');
    var ids = Array.prototype.map.call(fields, function (f) { return f.id; }).join(',');
    return ids === 'prjFTitle,prjFDesc,prjFPeopleInput' || 'form fields: ' + ids;
});
t('form: who\'s involved is a roster picker, not a free-text box', function () {
    var input = document.getElementById('prjFPeopleInput');
    if (!input) return 'no picker input';
    if (input.getAttribute('role') !== 'combobox') return 'picker input is not a combobox';
    return (!!document.getElementById('prjFChips') && !!document.getElementById('prjFPeopleMenu')) || 'chips or menu missing';
});
t('nav: there is no Projects page link any more', function () {
    return !document.querySelector('.nav-bar a[href="projects.html"]') || 'a nav link to projects.html is still in the markup';
});
