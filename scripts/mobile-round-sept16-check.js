// MOBILE ROUND, 2026-09-16. Needs the real markup:
//
//   powershell -File scripts/browser-check.ps1 mobile-round-sept16-check.js -Html index.html
//
// Four asks from phone screenshots:
//   1. Documents' Download button wore a solid green and an emoji arrow (a blue
//      tile on iOS) — it should match the soft sage chips around it
//   2. Listing Health is not a phone tool
//   3. the Expense Report's date field ran off the card on iOS — CSS only, and
//      iOS-only, so it is not measurable in desktop Chrome and is not asserted here
//   4. scrolling a Tools / Checklist panel on a phone dragged the page behind it
//
// The panel lock is driven by a MutationObserver, so every lock assertion waits a
// tick before reading body.no-scroll. _isMobileLayout is stubbed: the harness is a
// desktop-width window.

function _msTick() { return new Promise(function (r) { setTimeout(r, 0); }); }
function _msPhone(on) { window._isMobileLayout = function () { return on; }; }
function _msLocked() { return document.body.classList.contains('no-scroll'); }
// The runner starts every check at once and only waits for the promises at the
// end, so async checks that share the page would interleave. Queue them.
// Starts after DOMContentLoaded: the harness loads speeks.js without `defer`, so
// the panel watcher attaches on that event, and the first queued check used to
// run before it had (in the app speeks.js is deferred and attaches at once).
var _msQueue = new Promise(function (r) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { r(); });
    else r();
});
function _msSerial(fn) { var run = _msQueue.then(fn); _msQueue = run.catch(function () {}); return run; }

t('Download: an icon, not an emoji', function () {
    var html = _annDocCard({ docName: 'x.pdf', docUrl: '#', title: 't', author: 'a', date: '2026-09-01' });
    if (html.indexOf('⬇') >= 0) return 'the ⬇ emoji is still in the button';
    return /class="ann-doc-dl-btn"><svg/.test(html) || 'no svg icon in the button';
});

t('Download: the soft sage chip, not a solid green block', function () {
    var host = document.createElement('div');
    host.innerHTML = _annDocCard({ docName: 'x.pdf', docUrl: '#', title: 't', author: 'a', date: '2026-09-01' });
    document.body.appendChild(host);
    try {
        var cs = getComputedStyle(host.querySelector('.ann-doc-dl-btn'));
        if (cs.backgroundColor !== 'rgb(232, 247, 238)') return 'background ' + cs.backgroundColor;
        if (cs.color === 'rgb(255, 255, 255)') return 'text is still white';
        return cs.borderTopWidth !== '0px' || 'no outline';
    } finally { host.remove(); }
});

t('Listing Health is cut from the phone in the Tools panel', function () {
    var a = document.querySelector('#toolsSidePanel .tools-item[data-feature="tool-listing-health"]');
    if (!a) return 'Listing Health link not found';
    return a.getAttribute('data-mobile') === 'hide' || 'no data-mobile="hide"';
});

t('...so a feed card that opens it stops being a button on the phone', function () {
    _msPhone(true);
    try { return _samDestDead('openListingHealthTool()') === true || '_samDestDead did not see it as dead'; }
    finally { _msPhone(false); }
});

t('phone: opening a side panel locks the page, closing it lets go', function () { return _msSerial(async function () {
    closeAllModals(); _msPhone(true);
    var p = document.getElementById('checklistSidePanel');
    try {
        p.classList.add('open'); await _msTick();
        if (!_msLocked()) return 'page not locked with the checklist open';
        p.classList.remove('open'); await _msTick();
        return !_msLocked() || 'page still locked after the checklist closed';
    } finally { p.classList.remove('open'); _msPhone(false); await _msTick(); }
}); });

t('desktop: a side panel does NOT lock the page', function () { return _msSerial(async function () {
    closeAllModals(); _msPhone(false);
    var p = document.getElementById('toolsSidePanel');
    try {
        p.classList.add('open'); await _msTick();
        return !_msLocked() || 'desktop page locked by a drawer';
    } finally { p.classList.remove('open'); await _msTick(); }
}); });

t('phone: a tool opened FROM the Tools panel keeps the page locked', function () { return _msSerial(async function () {
    closeAllModals(); _msPhone(true);
    var p = document.getElementById('toolsSidePanel');
    try {
        p.classList.add('open'); await _msTick();
        // What a Tools link does: close the panel, open the modal.
        _closeToolsPanel();
        toggleModal('listingGoalsModal');
        await _msTick();
        if (!_msLocked()) return 'the panel released the lock the modal needs';
        closeAllModals(); await _msTick();
        return !_msLocked() || 'still locked after the modal closed';
    } finally { closeAllModals(); _msPhone(false); await _msTick(); }
}); });

t('phone: switching panels does not drop the lock in between', function () { return _msSerial(async function () {
    closeAllModals(); _msPhone(true);
    var a = document.getElementById('checklistSidePanel'), b = document.getElementById('toolsSidePanel');
    try {
        a.classList.add('open'); await _msTick();
        _closeSidePanels('toolsSidePanel'); b.classList.add('open'); await _msTick();
        if (!_msLocked()) return 'lock dropped when Tools replaced Checklist';
        b.classList.remove('open'); await _msTick();
        return !_msLocked() || 'still locked after both closed';
    } finally { a.classList.remove('open'); b.classList.remove('open'); _msPhone(false); await _msTick(); }
}); });

t('a panel closing does not release a lock a modal is holding', function () { return _msSerial(async function () {
    closeAllModals(); _msPhone(true);
    var p = document.getElementById('checklistSidePanel');
    try {
        toggleModal('listingGoalsModal');
        p.classList.add('open'); await _msTick();
        p.classList.remove('open'); await _msTick();
        return _msLocked() || 'the panel unlocked the page under an open modal';
    } finally { closeAllModals(); _msPhone(false); await _msTick(); }
}); });
