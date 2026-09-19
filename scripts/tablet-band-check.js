// TABLET PORT, 2026-09-17.
//
//   powershell -File scripts/browser-check.ps1 tablet-band-check.js -Html index.html
//
// The compact build used to be one number, <= 900px, written in two languages:
// 38 media queries in styles.css and three matchMedia calls in speeks.js. The
// tablet port widened it to
//
//     (max-width: 900px), (max-width: 1366px) and (pointer: coarse)
//
// which is still two languages but no longer something you can eyeball. This
// file asserts the two spellings are the SAME spelling, because the failure mode
// is silent and ugly: the CSS gives a landscape iPad the compact layout while
// _isMobileLayout() still says desktop, so applyRoleBasedUI writes
// display:flex !important onto every surface the stylesheet just cut, and the
// tablet gets a phone skeleton with the whole desktop tool set stuffed back into
// it. Nothing throws. It just looks wrong on a device nobody has at their desk.
//
// WHAT THIS CANNOT CHECK, and there is no point pretending otherwise: headless
// Chrome here is a fixed ~800x600 window with a FINE pointer and no CDP device
// emulation (the runner drives chrome.exe with --dump-dom, not a debugger
// socket). So no assertion below is standing at 1180px on a touch screen. It
// cannot see that the iPad now gets the compact build. It can only see that the
// rule which will decide that is written once and agreed on. Proving the device
// half needs a real iPad, or a puppeteer run with
// Emulation.setDeviceMetricsOverride -- do that with your eyes, once, and then
// let this file hold the invariant still.

// The band, spelled out here a THIRD time on purpose. If you are moving the
// breakpoint you should have to change it somewhere that fails loudly, and a
// test that reads its expectation out of the thing under test asserts nothing.
var TB_BAND = '(max-width: 900px), (max-width: 1366px) and (pointer: coarse)';

// conditionText round-trips through the CSSOM serialiser, which is free to
// normalise whitespace and has changed its mind about it across Chrome
// versions. Compare on shape, not on bytes.
function _tbNorm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

// Walk nested rules too. Nothing nests today; a future @supports or @layer
// wrapper would hide every block from a flat scan and quietly pass this file.
function _tbMediaRules() {
    var out = [];
    function walk(rules) {
        if (!rules) return;
        for (var i = 0; i < rules.length; i++) {
            var r = rules[i];
            if (r.media && r.conditionText !== undefined) out.push(r);
            if (r.cssRules) walk(r.cssRules);
        }
    }
    for (var s = 0; s < document.styleSheets.length; s++) {
        var rules = null;
        try { rules = document.styleSheets[s].cssRules; } catch (e) { rules = null; }
        walk(rules);
    }
    return out;
}

// Selectors of the rules directly inside a media block, as one string.
function _tbSelectors(rule) {
    var txt = '';
    try {
        for (var i = 0; i < rule.cssRules.length; i++) txt += (rule.cssRules[i].selectorText || '') + ' ';
    } catch (e) { return ''; }
    return txt;
}

// EVERY assertion below is vacuously true if the stylesheet did not load or its
// rules are unreadable -- "no bare 900px blocks left" passes beautifully over
// zero blocks. This runs first and fails loudly so the suite can never go green
// on an empty sheet. It is also the canary for --allow-file-access-from-files
// being dropped from the runner's chrome line.
t('the real styles.css is loaded and its rules are readable', function () {
    if (!document.styleSheets.length) return 'no stylesheet on the page at all';
    var all = _tbMediaRules();
    if (!all.length) {
        return 'zero media rules readable -- cssRules is probably blocked ' +
               '(is --allow-file-access-from-files still on the chrome line?). ' +
               'Every other check in this file would pass on nothing.';
    }
    return all.length > 100 || 'only ' + all.length + ' media rules -- not the real styles.css';
});

t('no bare max-width: 900px block is left in the stylesheet', function () {
    var bare = _tbMediaRules().filter(function (r) {
        var c = _tbNorm(r.conditionText);
        return c.indexOf('900px') >= 0 && c.indexOf('pointer: coarse') < 0;
    });
    if (!bare.length) return true;
    return bare.length + ' block(s) still on 900px alone, first: "' + bare[0].conditionText +
           '" -- a landscape tablet skips those and gets half a layout';
});

t('every compact block carries the full band, verbatim', function () {
    var compact = _tbMediaRules().filter(function (r) {
        return _tbNorm(r.conditionText).indexOf('900px') >= 0;
    });
    if (!compact.length) return 'no compact blocks found at all';
    var wrong = compact.filter(function (r) { return _tbNorm(r.conditionText) !== _tbNorm(TB_BAND); });
    if (wrong.length) {
        return wrong.length + ' of ' + compact.length + ' differ, first: "' +
               wrong[0].conditionText + '"';
    }
    return compact.length === 38 ||
        'found ' + compact.length + ' compact blocks, expected 38 -- if you added or ' +
        'removed one on purpose, update the count here and in the MOBILE LAYER banner';
});

t('the laptop guarantee: the wide arm is gated on a coarse pointer', function () {
    // The whole reason the band is not simply `max-width: 1366px`. If a bare
    // 1366 block ever appears, every 1366x768 store laptop silently joins the
    // compact build -- hotbar links and tools cut out from under people at work.
    var bare = _tbMediaRules().filter(function (r) {
        var c = _tbNorm(r.conditionText);
        return c.indexOf('1366px') >= 0 && c.indexOf('pointer: coarse') < 0;
    });
    if (bare.length) {
        return bare.length + ' block(s) reach 1366px with no pointer test, first: "' +
               bare[0].conditionText + '"';
    }
    // Headless is a fine-pointer client, which is exactly the position a
    // 1366x768 laptop is in. The wide arm must not match here.
    return window.matchMedia('(max-width: 1366px) and (pointer: coarse)').matches === false ||
        'the wide arm matches on a fine-pointer client -- it would catch laptops';
});

t('the JS reads the same band as the CSS', function () {
    if (typeof _compactMediaQuery !== 'function') return '_compactMediaQuery() is gone';
    var js = _tbNorm(_compactMediaQuery());
    if (js !== _tbNorm(TB_BAND)) return 'JS says "' + _compactMediaQuery() + '"';
    var css = _tbMediaRules().filter(function (r) {
        return _tbNorm(r.conditionText).indexOf('900px') >= 0;
    })[0];
    if (!css) return 'no compact block in the CSS to compare against';
    return _tbNorm(css.conditionText) === js ||
        'CSS says "' + css.conditionText + '", JS says "' + _compactMediaQuery() + '"';
});

t('_isMobileLayout() answers with that band and nothing else', function () {
    if (typeof _isMobileLayout !== 'function') return '_isMobileLayout() is gone';
    var expect = window.matchMedia(_compactMediaQuery()).matches;
    return _isMobileLayout() === expect ||
        '_isMobileLayout() says ' + _isMobileLayout() + ', the band says ' + expect;
});

t('no second copy of the breakpoint is hiding in a reader', function () {
    // The three original matchMedia sites now all call _compactMediaQuery(), and
    // _usageDevice used to re-derive the answer as `w <= 900` -- which would have
    // under-reported every tablet on the estate in the usage telemetry. A fourth
    // copy would show up in no other check here, so read the bodies.
    var readers = [];
    if (typeof _isMobileLayout === 'function') readers.push(['_isMobileLayout', _isMobileLayout]);
    if (typeof _usageDevice === 'function') readers.push(['_usageDevice', _usageDevice]);
    if (typeof _syncPanelScrollLock === 'function') readers.push(['_syncPanelScrollLock', _syncPanelScrollLock]);
    for (var i = 0; i < readers.length; i++) {
        var src = String(readers[i][1]);
        if (/max-width:\s*900/.test(src) || /<=\s*900\b/.test(src)) {
            return readers[i][0] + '() re-derives the breakpoint instead of asking ' +
                   '_compactMediaQuery() -- that is the copy that goes stale';
        }
    }
    return readers.length > 0 || 'none of the readers are defined -- did speeks.js load?';
});

t('the phone curation is what a tablet inherits', function () {
    // "Port over all the stuff we kept active on mobile" comes down to this one
    // rule: the data-mobile="hide" cut has to live INSIDE the band, not in a
    // narrower block of its own, or a tablet keeps 208 surfaces the phone drops.
    var hosts = _tbMediaRules().filter(function (r) {
        return _tbSelectors(r).indexOf('data-mobile') >= 0;
    });
    if (!hosts.length) return 'no media block declares the [data-mobile="hide"] cut';
    var narrow = hosts.filter(function (r) { return _tbNorm(r.conditionText) !== _tbNorm(TB_BAND); });
    return !narrow.length ||
        'the curation cut sits in "' + narrow[0].conditionText + '", not the compact band';
});

t('the curation cut keeps the !important it was given', function () {
    // applyRoleBasedUI writes display:<type> !important onto every visible
    // module, so the stylesheet cut needs !important to stand up to it. Losing
    // that is how 11 role-gated elements stayed on screen the first time round.
    var found = false;
    _tbMediaRules().forEach(function (r) {
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                var rule = r.cssRules[i];
                if ((rule.selectorText || '').indexOf('data-mobile') < 0) continue;
                if (rule.style.getPropertyPriority('display') === 'important') found = true;
            }
        } catch (e) {}
    });
    return found || 'the [data-mobile="hide"] cut lost its !important -- ' +
                    'the inline display from applyRoleBasedUI will beat it';
});

t('the JS half of the cut still follows the band', function () {
    // CSS alone cannot do this job: applyRoleBasedUI writes an inline !important
    // display, which outranks the stylesheet, so the sweep has to consult the
    // band itself. Stub it both ways and watch one module follow.
    var el = document.createElement('div');
    el.className = 'dynamic-module-flex role-mocd';
    el.setAttribute('data-mobile', 'hide');
    document.body.appendChild(el);
    var real = window._isMobileLayout;
    try {
        window._isMobileLayout = function () { return true; };
        applyRoleBasedUI();
        if (el.style.display !== 'none') {
            return 'a data-mobile="hide" module survived the sweep inside the band ' +
                   '(display: "' + el.style.display + '")';
        }
        window._isMobileLayout = function () { return false; };
        applyRoleBasedUI();
        return el.style.display === 'flex' ||
            'outside the band the same module should come back, got "' + el.style.display + '"';
    } finally {
        window._isMobileLayout = real;
        el.remove();
    }
});

// ---------------------------------------------------------------------------
// TABLET EXCEPTIONS. The band above says a tablet runs the phone's rules; this
// half is where a tablet is allowed to differ, and the first of them is the side
// panels, which are full-screen sheets on a phone and third-width drawers here.
// ---------------------------------------------------------------------------

var TB_TABLET = '(min-width: 901px) and (max-width: 1366px) and (pointer: coarse)';

t('the tablet exception band is written once, and the JS agrees', function () {
    if (typeof _tabletMediaQuery !== 'function') return '_tabletMediaQuery() is gone';
    if (_tbNorm(_tabletMediaQuery()) !== _tbNorm(TB_TABLET)) {
        return 'JS says "' + _tabletMediaQuery() + '"';
    }
    var blocks = _tbMediaRules().filter(function (r) {
        return _tbNorm(r.conditionText).indexOf('min-width: 901px') >= 0;
    });
    if (!blocks.length) return 'no tablet-only block in the stylesheet';
    var wrong = blocks.filter(function (r) { return _tbNorm(r.conditionText) !== _tbNorm(TB_TABLET); });
    return !wrong.length || 'a tablet block reads "' + wrong[0].conditionText + '"';
});

t('the two bands cannot both claim a 900px screen', function () {
    // 901, not 900. The compact ceiling is inclusive, so a tablet block starting
    // at 900 would have both sets of panel rules live at exactly that width and
    // the winner decided by source order rather than by intent.
    var lo = _tbMediaRules().filter(function (r) {
        return _tbNorm(r.conditionText).indexOf('min-width: 900px') >= 0;
    });
    return !lo.length ||
        'a tablet block opens at min-width: 900px, which overlaps the compact ceiling: "' +
        lo[0].conditionText + '"';
});

t('the tablet panel rule comes after the sheet rule it overrides', function () {
    // Same specificity, no !important: source order is the ONLY thing deciding
    // which width wins. Moving this block up the file would silently give every
    // tablet the full-bleed sheet back, and nothing else here would notice.
    var sheet = -1, drawer = -1;
    var all = _tbMediaRules();
    for (var i = 0; i < all.length; i++) {
        var sel = _tbSelectors(all[i]);
        if (sel.indexOf('.checklist-side-panel') < 0) continue;
        var cond = _tbNorm(all[i].conditionText);
        if (cond === _tbNorm(TB_BAND) && /width:\s*100%/.test(all[i].cssText || '')) sheet = i;
        if (cond === _tbNorm(TB_TABLET)) drawer = i;
    }
    if (sheet < 0) return 'no full-bleed sheet rule found in the compact band';
    if (drawer < 0) return 'no tablet drawer rule found';
    return drawer > sheet ||
        'the tablet drawer rule is declared BEFORE the sheet rule, so the sheet wins';
});

t('the drawer is about a third, and bounded at both ends', function () {
    var rule = null;
    _tbMediaRules().forEach(function (r) {
        if (_tbNorm(r.conditionText) !== _tbNorm(TB_TABLET)) return;
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                if ((r.cssRules[i].selectorText || '').indexOf('.checklist-side-panel') >= 0) {
                    rule = r.cssRules[i];
                }
            }
        } catch (e) {}
    });
    if (!rule) return 'no tablet rule for the checklist panel';
    var w = rule.style.getPropertyValue('width');
    var lo = rule.style.getPropertyValue('min-width');
    var hi = rule.style.getPropertyValue('max-width');
    if (!/^3[0-9]%$/.test(w.trim())) return 'width is "' + w + '", not a thirtysomething percent';
    // Without a floor the checklist's longest rows wrap to three lines at the
    // narrow end of the band; without a ceiling it stops reading as a drawer.
    if (!lo) return 'no min-width floor -- the rows will wrap at 901px';
    if (!hi) return 'no max-width ceiling -- at 1366px this is not a drawer any more';
    return true;
});

t('the scroll lock follows the sheet, not the band', function () {
    // With the panel at a third, two thirds of the page is on screen. Freezing it
    // there is just a page that has stopped working, so the lock has to ask
    // whether the panel is FULL-BLEED, not whether the layout is compact.
    if (typeof _panelIsFullBleed !== 'function') return '_panelIsFullBleed() is gone';
    if (typeof _syncPanelScrollLock !== 'function') return '_syncPanelScrollLock() is gone';
    if (/_isMobileLayout\(\)\s*&&\s*_PANEL_LOCK_IDS/.test(String(_syncPanelScrollLock))) {
        return '_syncPanelScrollLock still gates on _isMobileLayout() -- a tablet drawer ' +
               'will freeze the page behind it';
    }
    return /_panelIsFullBleed\(\)/.test(String(_syncPanelScrollLock)) ||
        '_syncPanelScrollLock does not ask _panelIsFullBleed()';
});

t('the panel stops above the bottom tab bar', function () {
    // It used to run to the foot of the viewport at z-index 320, over the tab bar,
    // so Quick Portal and Processes were untappable while any panel was open --
    // on the only navigation the compact build has.
    var rule = null;
    _tbMediaRules().forEach(function (r) {
        if (_tbNorm(r.conditionText) !== _tbNorm(TB_BAND)) return;
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                var sel = r.cssRules[i].selectorText || '';
                if (sel.indexOf('.checklist-side-panel') >= 0 &&
                    /width:\s*100%/.test(r.cssRules[i].cssText || '')) rule = r.cssRules[i];
            }
        } catch (e) {}
    });
    if (!rule) return 'no full-bleed panel rule found';
    var h = rule.style.getPropertyValue('height');
    // 61px is the bar, measured: 6px padding + a 48px tap target + 6px + a 1px
    // top border. NOT .main-content's 78px, which is a scrolling page's breathing
    // room -- borrowing it left a 17px gap under the panel against a 10px one
    // above, which is what "looks good on top just not the bottom" was.
    if (!/61px/.test(h)) {
        return 'height is "' + h + '" -- it does not subtract the bar\'s measured 61px';
    }
    if (!/20px/.test(h)) {
        return 'height is "' + h + '" -- the 10px gap is not applied at BOTH ends ' +
               '(top offset + bottom clearance = 20px of the viewport)';
    }
    // The bar owns the home-indicator strip now, so padding it again inside the
    // panel would only be dead space.
    var pb = rule.style.getPropertyValue('padding-bottom');
    return !pb || 'padding-bottom "' + pb + '" is left over from when the panel ran to the floor';
});

t('the feed shows more rows on a tablet than on a phone', function () {
    if (typeof _samCapFeed !== 'function') return '_samCapFeed() is gone';
    var src = String(_samCapFeed);
    if (!/_isTabletLayout\(\)/.test(src)) {
        return '_samCapFeed does not ask _isTabletLayout() -- a tablet still gets the phone cap';
    }
    // The count drives both the early return and the row it measures to; an
    // off-by-one between them caps the feed one row short of what it decided.
    if (/rows\.length\s*<=\s*2\b/.test(src)) return 'the early return is still hard-coded to 2 rows';
    return /rows\[\s*showRows\s*-\s*1\s*\]/.test(src) ||
        'the measured row is not derived from the same count as the early return';
});

t('Past weeks is cut from the phone for the store-floor managers', function () {
    if (typeof _lgpwPastAllowed !== 'function') return '_lgpwPastAllowed() is gone';
    var realRole = sessionStorage.getItem('speeksUserRole');
    var mob = window._isMobileLayout, tab = window._isTabletLayout;
    function at(role, phone) {
        try { sessionStorage.setItem('speeksUserRole', role); } catch (e) {}
        window._isMobileLayout = function () { return true; };
        window._isTabletLayout = function () { return !phone; };
        return _lgpwPastAllowed();
    }
    try {
        // Cut on a phone...
        if (at('Manager', true) !== false) return 'a Manager keeps Past weeks on a phone';
        if (at('Assistant Manager', true) !== false) return 'an ASM keeps Past weeks on a phone';
        if (at('Multi-Store Manager', true) !== false) return 'an MSM keeps Past weeks on a phone';
        // ...kept for leadership, and kept for everyone on a tablet, where the
        // seven columns fit. That split is the whole point of the tablet tier.
        if (at('District Manager', true) !== true) return 'a DM lost Past weeks on a phone';
        if (at('CEO', true) !== true) return 'the CEO lost Past weeks on a phone';
        if (at('Manager', false) !== true) return 'a Manager lost Past weeks on a TABLET';
        window._isMobileLayout = function () { return false; };
        return _lgpwPastAllowed() === true || 'Past weeks is cut on the desktop';
    } finally {
        window._isMobileLayout = mob;
        window._isTabletLayout = tab;
        try {
            if (realRole === null) sessionStorage.removeItem('speeksUserRole');
            else sessionStorage.setItem('speeksUserRole', realRole);
        } catch (e) {}
    }
});

t('a cut Past weeks tab does not strand somebody on it', function () {
    if (typeof _lgpwSyncTabs !== 'function') return '_lgpwSyncTabs() is gone';
    var btn = document.getElementById('lgpw-v-past');
    if (!btn) return 'no #lgpw-v-past in the page markup (run this with -Html index.html)';
    var realRole = sessionStorage.getItem('speeksUserRole');
    var mob = window._isMobileLayout, tab = window._isTabletLayout, wasPast = _lgpw.past;
    try {
        try { sessionStorage.setItem('speeksUserRole', 'Manager'); } catch (e) {}
        window._isMobileLayout = function () { return true; };
        window._isTabletLayout = function () { return false; };
        _lgpw.past = true;                       // they were looking at it
        _lgpwSyncTabs();
        if (btn.style.display !== 'none') return 'the tab is still visible to a Manager on a phone';
        if (_lgpw.past !== false) return 'the view stayed on Past weeks with its tab hidden';
        // ...and it comes back, with no inline display left behind to fight the
        // stylesheet over.
        window._isTabletLayout = function () { return true; };
        _lgpwSyncTabs();
        return btn.style.display === '' ||
            'going back to a tablet left display "' + btn.style.display + '" on the tab';
    } finally {
        window._isMobileLayout = mob;
        window._isTabletLayout = tab;
        _lgpw.past = wasPast;
        btn.style.removeProperty('display');
        try {
            if (realRole === null) sessionStorage.removeItem('speeksUserRole');
            else sessionStorage.setItem('speeksUserRole', realRole);
        } catch (e) {}
    }
});

t('_panelIsFullBleed() is compact-minus-tablet, both ways round', function () {
    var mob = window._isMobileLayout, tab = window._isTabletLayout;
    try {
        window._isMobileLayout = function () { return true; };
        window._isTabletLayout = function () { return true; };
        if (_panelIsFullBleed() !== false) return 'a tablet is being treated as full-bleed';
        window._isTabletLayout = function () { return false; };
        if (_panelIsFullBleed() !== true) return 'a phone is not being treated as full-bleed';
        window._isMobileLayout = function () { return false; };
        return _panelIsFullBleed() === false || 'a desktop is being treated as full-bleed';
    } finally {
        window._isMobileLayout = mob;
        window._isTabletLayout = tab;
    }
});
