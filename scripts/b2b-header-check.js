// B2B HEADER — checks that need the REAL markup.
//
//   powershell -File scripts/browser-check.ps1 b2b-header-check.js -Html operations.html
//
// Separate from b2b-check.js on purpose. These assert about the DOM as
// operations.html actually declares it -- ids, role classes, data-feature,
// which element sits inside which -- and that needs the page inlined, which is
// what -Html does. Keeping them here means the main suite stays runnable with
// no page at all and cannot start failing for want of a flag.
//
// The alternative was building the markup inside the check, which proves only
// that the copy agrees with itself -- and the whole point of these is that the
// role gate and Feature Access are driven by attributes on the real elements.

// Local copy of b2b-check.js's helper. Duplicated rather than shared because
// the runner loads exactly one check file, and five lines in two places beats a
// module system this project deliberately does not have.
//
// Why it exists at all: three checks in the main suite have failed against
// working code because the word they searched for was in the comment explaining
// it. speeks.js is heavily commented on purpose, so a bare substring search
// over a function's text searches prose as much as code.
function _srcOf(fn) {
    return String(fn)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// The header was NOT the right place -- Nick, 2026-09-10: "you put this in the
// COMPLETEly wrong spot... this was meant for the per item listing actions".
// The menu moved to the listing rows; these now guard the header staying as it
// was, since it has just been churned and put back.
t('trial: the header keeps its own buttons, ungrouped', function () {
    var ids = ['b2bDelReqBtn', 'crmGearBtn', 'b2bCaptureDlBtn', 'b2bFeedbackBtn', 'b2bNewBtn'];
    var missing = ids.filter(function (id) { return !document.getElementById(id); });
    if (missing.length) return 'missing from the header: ' + missing.join(', ');
    return !document.getElementById('b2bActionsMenu')
        || 'the header actions menu came back — it belongs on the rows';
});
t('trial: the header buttons kept their gates through the churn', function () {
    // These were moved into a menu and moved back out. The role classes and the
    // feature key are what actually gate them, and a copy-paste that drops one
    // is invisible until the wrong person sees the wrong button.
    var gear = document.getElementById('crmGearBtn');
    var cap = document.getElementById('b2bCaptureDlBtn');
    var del = document.getElementById('b2bDelReqBtn');
    if (!gear.classList.contains('role-ceo')) return 'the gear lost its CEO gate';
    if (cap.getAttribute('data-feature') !== 'b2b-capture-download') return 'Capture lost its feature key';
    if (!cap.classList.contains('role-none')) return 'Capture lost role-none, so everyone can see it';
    if (!del.classList.contains('dynamic-module-flex')) return 'Delete Requests left the role sweep';
    // Feedback is deliberately ungated: no role- classes at all means everyone.
    var fb = document.getElementById('b2bFeedbackBtn');
    return Array.from(fb.classList).filter(function (c) { return c.indexOf('role-') === 0; }).length === 0
        || 'Feedback picked up a role gate — it is meant to be for everyone';
});
