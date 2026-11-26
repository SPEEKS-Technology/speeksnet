// STORE ACCOUNT checks — the shared store login (role 'store', the TV and the
// picture-station iPad) on the ordinary pages.
//
//   powershell -File scripts/browser-check.ps1 store-account-check.js -Html operations.html -WindowSize 1440,900
//
// Needs -Html (the real nav markup) and a desktop -WindowSize (the nav's
// spacing rule only applies at desktop widths).
//
// Two bugs found on BAL's account, 2026-11-18:
//  1. The Picture Guide's "Category missing? Have an Idea" link did nothing: the
//     idea popup was only injected for non-board roles.
//  2. On desktop the two tabs a store account has (QuickPortal, Operations) sat
//     at opposite ends of the bar, because the nav spreads its tabs across 820px.

function asStore(fn) {
    var prev = sessionStorage.getItem('speeksUserRole');
    sessionStorage.setItem('speeksUserRole', 'store');
    try { return fn(); }
    finally {
        if (prev === null) sessionStorage.removeItem('speeksUserRole');
        else sessionStorage.setItem('speeksUserRole', prev);
    }
}

t('Have an Idea opens the popup on a store account', function () {
    return asStore(function () {
        injectIdeaModal();
        sessionStorage.setItem('speeksUserName', 'BAL Store');
        toggleIdeaModal();
        var m = document.getElementById('ideaModal');
        if (!m) return 'no #ideaModal';
        if (!m.classList.contains('show')) return 'popup did not get .show';
        if (getComputedStyle(m).display === 'none') return 'popup is display:none';
        var r = m.getBoundingClientRect();
        if (r.width < 50 || r.height < 50) return 'popup rendered at ' + Math.round(r.width) + 'x' + Math.round(r.height);
        if (document.getElementById('ideaName').value !== 'BAL Store') return 'name not prefilled';
        closeAllModals();
        return true;
    });
});

t('store account nav: the two tabs sit together', function () {
    document.body.classList.add('is-store-board');
    try {
        var links = Array.prototype.filter.call(
            document.querySelectorAll('.top-nav .nav-bar a.nav-link'),
            function (a) { return getComputedStyle(a).display !== 'none'; });
        var hrefs = links.map(function (a) { return a.getAttribute('href'); });
        if (hrefs.join(',') !== 'index.html,operations.html') return 'visible tabs: ' + hrefs.join(',');
        var a = links[0].getBoundingClientRect(), b = links[1].getBoundingClientRect();
        var gap = b.left - a.right;
        if (gap > 24) return 'gap between tabs is ' + Math.round(gap) + 'px';
        return true;
    } finally { document.body.classList.remove('is-store-board'); }
});

t('manager nav keeps its even spread', function () {
    var bar = document.querySelector('.top-nav .nav-bar');
    var jc = getComputedStyle(bar).justifyContent;
    return jc === 'space-between' ? true : 'manager nav justify-content is ' + jc;
});
