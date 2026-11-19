// THE DEVELOPMENT SUITE'S DOOR — the green </> button in every page's header.
//
//   powershell -File scripts/browser-check.ps1 dev-header-check.js -Html b2b.html
//
// dev.html itself has no SPEEKSNET header any more (it's its own app), so the
// button is checked on a page that has one. b2b.html stands for all six;
// `grep -c 'id="devTrackerBtn"' *.html` is the one-line check that the other
// five carry it too (and that dev.html doesn't).
//
// Changes no sessionStorage (CLAUDE.md, "Verifying a change").

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
t('header: the tint is green (styles.css kept the button when the old page left)', function () {
    var b = document.getElementById('devTrackerBtn');
    var was = b.getAttribute('style');
    b.setAttribute('style', 'display:flex;');
    try {
        var m = (getComputedStyle(b).backgroundColor.match(/[\d.]+/g) || []).map(Number);
        return (m[1] > m[0] && m[1] > m[2]) || 'background is ' + getComputedStyle(b).backgroundColor;
    } finally { b.setAttribute('style', was); }
});
