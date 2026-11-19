// THE DEVELOPMENT SUITE — dev.html's real markup.
//
//   powershell -File scripts/browser-check.ps1 dev-tracker-page-check.js -Html dev.html -Js dev.js -Css dev.css
//
// dev.html is a bare shell that dev.js fills: #dvApp (the app), #dvLayer
// (pickers, modals), #dvToasts. It must NOT carry the SPEEKSNET page shell any
// more — that was the point of moving it out (no speeks.js, no styles.css, no
// header). The door, the green </> button, is on every OTHER page: checked by
// dev-header-check.js against b2b.html.
//
// (-Html inlines the <body> only, so the <head> — the title, dev.js/dev.css
// and their ?v= — is checked with a grep in the handoff's verify list.)
// Changes no sessionStorage. DEV_NO_BOOT keeps dev.js from booting (it would
// see the harness's PIN-less session and leave for index.html).
window.DEV_NO_BOOT = true;

t('shell: #dvApp, #dvLayer and #dvToasts', function () {
    var need = ['dvApp', 'dvLayer', 'dvToasts'].filter(function (id) { return !document.getElementById(id); });
    if (need.length) return 'missing: ' + need.join(', ');
    return document.getElementById('dvApp').classList.contains('dv-app') || 'dvApp is not .dv-app';
});
t('shell: none of the SPEEKSNET page shell came along', function () {
    var found = ['.top-nav', '.main-content', '#settingsModal', '#goalsSidePanel', '#featureAccessModal', '#devTrackerBtn']
        .filter(function (sel) { return document.querySelector(sel); });
    return !found.length || 'still here: ' + found.join(', ');
});
t('shell: a loading state until dev.js fills it', function () {
    var app = document.getElementById('dvApp');
    return (app.getAttribute('aria-busy') === 'true' && !!app.querySelector('.dv-boot')) || 'no loading state';
});
t('shell: the toast area is announced to screen readers', function () {
    return document.getElementById('dvToasts').getAttribute('aria-live') === 'polite' || 'toasts not aria-live';
});
