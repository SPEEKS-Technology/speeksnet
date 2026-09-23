// DISTRICT WATCH DOM checks — against index.html's REAL markup.
//
//   powershell -File scripts/browser-check.ps1 district-watch-dom-check.js -Html index.html
//
// The other two suites build their own markup, which proves only that the copy
// agrees with itself. This one runs against the page as index.html actually
// declares it, because that is where the things that break live: ids the
// renderer looks up by name, the role classes applyRoleBasedUI sweeps, and the
// data-feature keys that gate the tab. A control moved between containers keeps
// its gate only if the attributes moved with it.
//
// ⚠️ NEEDS -Html index.html. Without it the page has no #dcWidget and every
// assertion below would pass vacuously, so the first test fails loudly instead.

function el(id) { return document.getElementById(id); }

t('the harness was given index.html (otherwise everything below is vacuous)', function () {
    return !!el('dcWidget')
        || 'no #dcWidget in the DOM — re-run with: -Html index.html';
});

t('the tab button exists and is labelled Matrix', function () {
    var b = el('dc-tab-watch');
    if (!b) return '#dc-tab-watch is not in index.html';
    // The id stays `watch` on purpose — it matches DC_TABS, the edge function
    // and watch_flags. Only what a person reads was renamed.
    return b.textContent.trim() === 'Matrix'
        || 'the tab reads "' + b.textContent.trim() + '", not "Matrix"';
});

t('the Watch panel and the body the renderer writes into both exist', function () {
    var p = el('dc-panel-watch');
    if (!p) return '#dc-panel-watch is not in index.html';
    var b = el('dc-watch-body');
    if (!b) return '#dc-watch-body is missing — renderDistrictWatch would silently do nothing';
    return p.contains(b) || '#dc-watch-body is not inside #dc-panel-watch';
});

t('_tabSwitch can find the pair by its id convention', function () {
    // _tabSwitch builds ids as <prefix>-tab-<name> and <prefix>-panel-<name>.
    // A typo in either half is a tab that highlights but never opens, or opens
    // but never highlights.
    var miss = ['dc-tab-watch', 'dc-panel-watch'].filter(function (id) { return !el(id); });
    return miss.length === 0 || 'missing: ' + miss.join(', ');
});

t('the button sits immediately after Live Dashboard in the strip', function () {
    var live = el('dc-tab-live'), watch = el('dc-tab-watch');
    if (!live || !watch) return 'one of the two buttons is missing';
    if (live.parentElement !== watch.parentElement) return 'they are in different containers';
    var kids = Array.prototype.filter.call(live.parentElement.children, function (n) {
        return n.tagName === 'BUTTON';
    });
    return kids.indexOf(watch) === kids.indexOf(live) + 1
        || 'Watch is at position ' + kids.indexOf(watch) + ', Live at ' + kids.indexOf(live);
});

t('the panel sits inside the district card, not loose on the page', function () {
    var w = el('dcWidget'), p = el('dc-panel-watch');
    if (!w || !p) return 'widget or panel missing';
    if (!w.contains(p)) return 'the panel is outside #dcWidget — it would never show or hide';
    return !!p.closest('.cc-body') || 'the panel is not inside .cc-body';
});

t('both halves carry the DM/CEO role classes', function () {
    // This is what keeps the tab off a store manager today. "DM first, managers
    // later" is enforced here and by the feature key, not by anything in the
    // renderer.
    var bad = [];
    [['dc-tab-watch', el('dc-tab-watch')], ['dc-panel-watch', el('dc-panel-watch')]]
        .forEach(function (pair) {
            var n = pair[1];
            if (!n) { bad.push(pair[0] + ' missing'); return; }
            ['role-district-manager', 'role-ceo'].forEach(function (c) {
                if (!n.classList.contains(c)) bad.push(pair[0] + ' lacks ' + c);
            });
        });
    return bad.length === 0 || bad.join('; ');
});

t('no store-facing role class leaked onto either half', function () {
    var leaked = [];
    ['dc-tab-watch', 'dc-panel-watch'].forEach(function (id) {
        var n = el(id);
        if (!n) return;
        Array.prototype.forEach.call(n.classList, function (c) {
            if (/^role-/.test(c) && c !== 'role-district-manager' && c !== 'role-ceo') {
                leaked.push(id + ' has ' + c);
            }
        });
    });
    return leaked.length === 0 || leaked.join('; ');
});

t('both halves carry the same data-feature key', function () {
    var b = el('dc-tab-watch'), p = el('dc-panel-watch');
    if (!b || !p) return 'one half is missing';
    var bf = b.getAttribute('data-feature'), pf = p.getAttribute('data-feature');
    if (bf !== 'widget-district-watch') return 'button data-feature is ' + bf;
    // A button gated and a panel not is a tab that disappears while its content
    // still reserves height in the shared grid cell.
    if (pf !== 'widget-district-watch') return 'panel data-feature is ' + pf;
    return true;
});

t('the feature key the markup names actually exists in the catalog', function () {
    if (typeof FEATURE_CATALOG === 'undefined') return 'FEATURE_CATALOG is not defined';
    var keys = FEATURE_CATALOG.map(function (f) { return f.key; });
    return keys.indexOf('widget-district-watch') >= 0
        || 'index.html gates on a key the catalog does not have — _featureEffectiveVisible would be false forever';
});

// --- the store popup --------------------------------------------------------

t('the store popup exists in index.html', function () {
    var m = el('dcWatchModal');
    if (!m) return '#dcWatchModal is not in index.html — every Watch row would open nothing';
    // .modal-menu is what closeAllModals() sweeps and what .show is toggled on.
    return m.classList.contains('modal-menu')
        || 'the popup is not a .modal-menu, so closeAllModals() will not close it';
});

t('the popup has the three elements _dcwModalPaint writes into', function () {
    var miss = ['dcwModalTitle', 'dcwModalSub', 'dcwModalBody'].filter(function (id) { return !el(id); });
    return miss.length === 0 || 'missing: ' + miss.join(', ');
});

t('all three popup tab buttons exist with the ids the painter toggles', function () {
    var miss = ['conversion', 'margin', 'listing']
        .map(function (t) { return 'dcw-mtab-' + t; })
        .filter(function (id) { return !el(id); });
    return miss.length === 0 || 'missing: ' + miss.join(', ');
});

t('the popup starts closed', function () {
    var m = el('dcWatchModal');
    if (!m) return 'popup missing';
    // A modal shipped with .show sits over the dashboard on every page load.
    return !m.classList.contains('show') || '#dcWatchModal has .show in the markup';
});

t('the popup has a close button wired to closeAllModals', function () {
    var m = el('dcWatchModal');
    if (!m) return 'popup missing';
    var btn = m.querySelector('.modal-close-btn');
    if (!btn) return 'no .modal-close-btn — the popup would be a trap';
    return /closeAllModals/.test(btn.getAttribute('onclick') || '')
        || 'the close button does not call closeAllModals()';
});

t('the popup is NOT role-gated — the tab that opens it already is', function () {
    // Gating both would be belt and braces; gating the popup with a class that
    // drifts from the tab's would be a row that opens an invisible window.
    var m = el('dcWatchModal');
    if (!m) return 'popup missing';
    var roles = Array.prototype.filter.call(m.classList, function (c) { return /^role-/.test(c); });
    return roles.length === 0
        || 'the popup carries ' + roles.join(',') + ' — it must not drift from the tab that opens it';
});

t('the tab is hidden on a phone, like its three sibling data tabs', function () {
    // Deliberate, and recorded in index.html: a phone gets Live only. If this
    // ever fires because the attribute was dropped, check the panel too — the
    // two must agree or the card reserves height for a tab you cannot open.
    var b = el('dc-tab-watch'), p = el('dc-panel-watch');
    if (!b || !p) return 'one half is missing';
    var bm = b.getAttribute('data-mobile'), pm = p.getAttribute('data-mobile');
    return (bm === pm)
        || 'button data-mobile=' + bm + ' but panel data-mobile=' + pm + ' — they must agree';
});

t('the popup’s three tab buttons are the same width', function () {
    // Ethan, 2026-09-21: "make the 3 tab name buttons the same size". The
    // popup is display:none until opened, so show it just long enough to
    // measure, then put it back exactly as it was.
    var tabs = el('dcwModalTabs');
    if (!tabs) return 'no #dcwModalTabs';
    var modal = tabs.closest('.modal-menu') || tabs.parentElement;
    var was = modal.getAttribute('style');
    modal.style.cssText += ';display:block !important;visibility:hidden;position:fixed;left:0;top:0;width:1100px;';
    try {
        var w = Array.prototype.map.call(tabs.querySelectorAll('.tab-btn'), function (b) {
            return Math.round(b.getBoundingClientRect().width);
        });
        if (w.length !== 3) return 'expected 3 buttons, got ' + w.length;
        if (w[0] < 20) return 'buttons measured at zero width — the popup did not lay out';
        return (Math.max.apply(null, w) - Math.min.apply(null, w) <= 1) || 'widths differ: ' + w.join(', ');
    } finally {
        if (was == null) modal.removeAttribute('style'); else modal.setAttribute('style', was);
    }
});
