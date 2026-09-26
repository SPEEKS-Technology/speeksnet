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
    return compact.length === 41 ||
        'found ' + compact.length + ' compact blocks, expected 41 -- if you added or ' +
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
    // rule: the data-mobile="hide" CUT has to live inside the compact band, not
    // in a narrower block of its own, or a tablet keeps surfaces the phone drops.
    //
    // The RESTORE is a different rule and belongs somewhere else entirely -- the
    // tablet tier -- so the two are told apart by what they SAY, not by the
    // attribute they mention:
    //   - names data-mobile ALONE and declares display:none  -> the curation cut
    //   - names data-tablet as well                          -> an opt-in rule,
    //     whatever it declares. The district Command Center's panels are
    //     display-switched by their own tab (#dcWidget .cc-panel:not(.cc-active)),
    //     so THEIR opt-in has to restore display:none for the inactive case --
    //     a cut-shaped declaration that is not a cut, and belongs in the tier.
    // The opt-in rules are checked separately, by "the CSS half of the opt-in
    // covers the plain elements" and by scripts/command-center-check.js.
    var cuts = [];
    _tbMediaRules().forEach(function (r) {
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                var rule = r.cssRules[i];
                var sel = rule.selectorText || '';
                if (sel.indexOf('data-mobile') < 0) continue;
                if (sel.indexOf('data-tablet') >= 0) continue;
                if (rule.style.getPropertyValue('display') !== 'none') continue;
                cuts.push(r);
            }
        } catch (e) {}
    });
    if (!cuts.length) return 'no media block declares the [data-mobile="hide"] cut';
    var narrow = cuts.filter(function (r) { return _tbNorm(r.conditionText) !== _tbNorm(TB_BAND); });
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

var TB_TABLET = '(min-width: 701px) and (min-height: 540px)'
              + ' and (max-width: 1366px) and (pointer: coarse)';

t('the tablet exception band is written once, and the JS agrees', function () {
    if (typeof _tabletMediaQuery !== 'function') return '_tabletMediaQuery() is gone';
    if (_tbNorm(_tabletMediaQuery()) !== _tbNorm(TB_TABLET)) {
        return 'JS says "' + _tabletMediaQuery() + '"';
    }
    var blocks = _tbMediaRules().filter(function (r) {
        return _tbNorm(r.conditionText).indexOf('min-width: 701px') >= 0;
    });
    if (!blocks.length) return 'no tablet-only block in the stylesheet';
    var wrong = blocks.filter(function (r) { return _tbNorm(r.conditionText) !== _tbNorm(TB_TABLET); });
    return !wrong.length || 'a tablet block reads "' + wrong[0].conditionText + '"';
});

t('the tier is tested on BOTH dimensions, not width alone', function () {
    // The short edge is the only thing that separates a tablet from a phone on
    // its side: an iPhone 15 Pro Max is 932x430 in landscape, WIDER than an iPad
    // Mini is tall. A width-only tier either misses every portrait iPad (which
    // is what 901px did) or swallows big phones in landscape. It cannot do
    // neither, so the height test is not optional.
    if (_tbNorm(TB_TABLET).indexOf('min-height') < 0) {
        return 'TB_TABLET has no min-height -- this suite is asserting the wrong shape';
    }
    var blocks = _tbMediaRules().filter(function (r) {
        return _tbNorm(r.conditionText).indexOf('min-width: 701px') >= 0;
    });
    if (!blocks.length) return 'no tablet-only block in the stylesheet';
    var noHeight = blocks.filter(function (r) {
        return _tbNorm(r.conditionText).indexOf('min-height') < 0;
    });
    return !noHeight.length ||
        'a tablet block tests width only: "' + noHeight[0].conditionText + '" -- ' +
        'an iPhone in landscape would get the tablet layout';
});

t('the tier claims every iPad and no phone', function () {
    // The harness viewport cannot be resized, so evaluate the tier's own numbers
    // against each device rather than pretending to stand on one. The numbers are
    // read OUT of TB_TABLET, so this cannot drift from the rule it is checking.
    var q = _tbNorm(TB_TABLET);
    var minW = parseInt((q.match(/min-width:\s*(\d+)px/) || [])[1], 10);
    var minH = parseInt((q.match(/min-height:\s*(\d+)px/) || [])[1], 10);
    var maxW = parseInt((q.match(/max-width:\s*(\d+)px/) || [])[1], 10);
    if (!minW || !minH || !maxW) return 'could not read the tier bounds out of "' + q + '"';
    var hit = function (w, h) { return w >= minW && h >= minH && w <= maxW; };
    var wrong = [];
    // Every iPad, both ways up. Portrait is the case that was broken for three
    // rounds: only the 12.9" clears 901px standing up.
    [['iPad mini 6', 744, 1133], ['iPad Mini preset', 768, 1024],
     ['iPad 10.9', 820, 1180], ['iPad Pro 11', 834, 1194],
     ['iPad Pro 12.9', 1024, 1366]].forEach(function (d) {
        if (!hit(d[1], d[2])) wrong.push(d[0] + ' portrait (' + d[1] + 'x' + d[2] + ') is not a tablet');
        if (!hit(d[2], d[1])) wrong.push(d[0] + ' landscape (' + d[2] + 'x' + d[1] + ') is not a tablet');
    });
    // ...and the devices that must NOT be claimed.
    [['iPhone 15 Pro Max landscape', 932, 430], ['iPhone 15 Pro Max portrait', 430, 932],
     ['a 1368px Surface', 1368, 912]].forEach(function (d) {
        if (hit(d[1], d[2])) wrong.push(d[0] + ' (' + d[1] + 'x' + d[2] + ') IS being claimed');
    });
    return !wrong.length || wrong.join('; ');
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

t('the drawer width adapts across the whole tier', function () {
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
    var w = rule.style.getPropertyValue('width').trim();
    // A FLAT PERCENTAGE CANNOT WORK HERE. The tier spans 744px to 1366px, nearly
    // double: a third of a Mini is 256px, which wraps the long checklist rows to
    // three lines, and half a Pro 12.9 is 683px, which is not a drawer. The clamp
    // fixes the useful thing -- how wide the panel needs to be -- and lets the
    // fraction fall out of the screen (Ethan, 2026-09-19: "for the mini and sizes
    // similar we can make it be half of the page instead of 1/3").
    var m = w.match(/^clamp\(\s*(\d+)px\s*,\s*(\d+)%\s*,\s*(\d+)px\s*\)$/);
    if (!m) return 'width is "' + w + '", not a clamp(floor, %, ceiling)';
    var lo = +m[1], pct = +m[2], hi = +m[3];
    if (lo >= hi) return 'the clamp floor ' + lo + ' is not below its ceiling ' + hi;
    // 330px is where "Check For Everything Else Category Items" starts wrapping
    // to three lines; the floor has to clear it with room to spare.
    if (lo < 340) return 'a ' + lo + 'px floor wraps the long checklist rows';
    if (hi > 520) return 'a ' + hi + 'px ceiling stops reading as a drawer';
    // The two ends that were actually asked for.
    var at = function (vw) { return Math.min(Math.max(lo, vw * pct / 100), hi); };
    var mini = Math.round(at(768) / 768 * 100);
    var pro = Math.round(at(1366) / 1366 * 100);
    if (mini < 44 || mini > 56) return 'a 768px Mini gets ' + mini + '%, which is not about half';
    if (pro > 38) return 'a 1366px Pro gets ' + pro + '%, which is not about a third';
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
    // Both edges have to come off a MEASUREMENT, not a number somebody counted
    // once. --panel-top was always measured; --tabbar-h is the bottom half of
    // that promise, and it is what makes this right on an iPad whose bar is not
    // 61px -- bigger Dynamic Type, a wrapped label, a home-indicator inset the
    // emulator did not report.
    if (!/var\(--tabbar-h/.test(h)) {
        return 'height is "' + h + '" -- the bottom clearance is a literal, so it is ' +
               'right on exactly one device';
    }
    // FLUSH. Nothing but the two bars comes off the viewport. A literal px term
    // in here is the 10px gap creeping back, which read as the panel failing to
    // reach the bars rather than as breathing room.
    if (/\d+px\s*\)?\s*$/.test(h.replace(/\([^()]*\)/g, '')) || /-\s*\d+px/.test(h)) {
        return 'height is "' + h + '" -- something other than the two bars is ' +
               'being subtracted, so the panel will not touch them';
    }
    // THE DOUBLE-COUNT. The bar pads its own foot with env(safe-area-inset-bottom)
    // and a border box includes padding, so a measured --tabbar-h already holds
    // the inset. Subtracting env() again here takes that strip off the panel
    // twice on every notched device. It may only ever be ADDED, inside the
    // fallback, which is the one branch with no measurement behind it.
    if (/-\s*env\(/.test(h)) {
        return 'height is "' + h + '" -- env(safe-area-inset-bottom) is subtracted ' +
               'on top of a measurement that already contains it';
    }
    if (!/61px/.test(h)) {
        return 'the no-JS fallback is gone from "' + h + '" -- a browser that has ' +
               'not run _syncLayout yet would clear nothing at all';
    }
    // The bar owns the home-indicator strip now, so padding it again inside the
    // panel would only be dead space.
    var pb = rule.style.getPropertyValue('padding-bottom');
    return !pb || 'padding-bottom "' + pb + '" is left over from when the panel ran to the floor';
});

t('_syncLayout measures the bar rather than trusting a number', function () {
    if (typeof _syncLayout !== 'function') return '_syncLayout() is gone';
    var bar = document.querySelector('.top-nav .nav-bar');
    if (!bar) return 'no .nav-bar in the markup (run this with -Html index.html)';
    var root = document.documentElement;
    var hadAuth = document.body.classList.contains('is-authenticated');
    document.body.classList.add('is-authenticated');
    try {
        _syncLayout();
        var live = root.style.getPropertyValue('--tabbar-h');
        if (!/^\d+px$/.test(live)) return '--tabbar-h is "' + live + '", not a measurement';
        // The point of measuring: it has to FOLLOW the bar. Watching .top-nav
        // alone cannot see this happen -- the bar is position:fixed, so it is out
        // of the header's flow and the header's box never moves when it grows.
        var was = parseFloat(live);
        bar.style.paddingTop = '26px';
        _syncLayout();
        var grown = parseFloat(root.style.getPropertyValue('--tabbar-h'));
        bar.style.paddingTop = '';
        _syncLayout();
        var back = parseFloat(root.style.getPropertyValue('--tabbar-h'));
        if (!(grown > was)) {
            return 'the bar grew from ' + was + ' but --tabbar-h stayed ' + grown;
        }
        return back === was ||
            '--tabbar-h did not come back down (' + back + ' vs ' + was + ')';
    } finally {
        bar.style.paddingTop = '';
        if (!hadAuth) document.body.classList.remove('is-authenticated');
        _syncLayout();
    }
});

t('a bar that is not the bottom bar publishes nothing', function () {
    // The same .nav-bar element is the inline row of links inside the header on
    // desktop, where its height means nothing to a panel. Publishing it there
    // would put a number on the variable that is true in one layout and
    // misleading in the other, so position:fixed is the test.
    var bar = document.querySelector('.top-nav .nav-bar');
    if (!bar) return 'no .nav-bar in the markup';
    var root = document.documentElement;
    var hadAuth = document.body.classList.contains('is-authenticated');
    document.body.classList.add('is-authenticated');
    bar.style.position = 'static';
    try {
        _syncLayout();
        return root.style.getPropertyValue('--tabbar-h') === '' ||
            'a static bar still published --tabbar-h="' +
            root.style.getPropertyValue('--tabbar-h') + '"';
    } finally {
        bar.style.position = '';
        if (!hadAuth) document.body.classList.remove('is-authenticated');
        _syncLayout();
    }
});

t('the panel really does meet both bars', function () {
    // The assertions above are about the rule; this one measures the result.
    // Flush at both ends: the panel starts where the header stops and stops where
    // the tab bar starts, with no strip of page showing through at either end.
    var panel = document.querySelector('.checklist-side-panel') ||
                document.querySelector('.tools-side-panel');
    if (!panel) return 'no side panel in the markup';
    var hadAuth = document.body.classList.contains('is-authenticated');
    document.body.classList.add('is-authenticated');
    try {
        _syncLayout();
        var cs = getComputedStyle(panel);
        var root = getComputedStyle(document.documentElement);
        var navH = parseFloat(root.getPropertyValue('--panel-top'));
        var barH = parseFloat(root.getPropertyValue('--tabbar-h'));
        var top = parseFloat(cs.top);
        var height = parseFloat(cs.height);
        if (!(navH > 0) || !(barH > 0)) return 'the bars did not measure';
        var gapTop = Math.round(top - navH);
        var gapBottom = Math.round(window.innerHeight - (top + height) - barH);
        if (gapTop !== 0) return 'there is a ' + gapTop + 'px strip of page under the nav';
        if (gapBottom !== 0) return 'there is a ' + gapBottom + 'px strip of page above the tab bar';
        return true;
    } finally {
        if (!hadAuth) document.body.classList.remove('is-authenticated');
        _syncLayout();
    }
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

// ---------------------------------------------------------------------------
// NO SIDEWAYS SCROLLING IN A TOOL (Ethan, 2026-09-19)
// ---------------------------------------------------------------------------

t('a record list stacks into cards instead of scrolling sideways', function () {
    // .tbl-stack was written for this and gated at 640px -- phone only -- so an
    // iPad got the TABLE form of a ten-column list inside a ~908px modal. It
    // cannot fit however you slice it, and #recycleInvModal's own
    // `overflow-x: hidden` then CLIPPED the row actions rather than scrolling to
    // them: unreachable, with nothing on screen to say they existed.
    var host = document.createElement('div');
    host.id = 'recycleInvModal';
    host.style.cssText = 'position:absolute;left:0;top:0;width:700px;';
    host.innerHTML =
        '<div style="overflow-x:auto;"><table class="tbl-stack recycle-tbl" ' +
        'style="width:100%;border-collapse:collapse;">' +
        '<thead><tr><th>Review</th><th>Date</th><th>SKU</th><th>Description</th>' +
        '<th>Qty</th><th>Unit Cost</th><th>Total Cost</th><th>By</th><th></th></tr></thead>' +
        '<tbody><tr>' +
        '<td data-label="Review">For Store</td><td data-label="Date">Aug 31</td>' +
        '<td data-label="SKU">KS01-7600E-E5</td>' +
        '<td data-label="Description">KEYBOARD. Terrible sales data. Going to keep it ' +
        'just for the store since we need a new functioning one anyways</td>' +
        '<td data-label="Qty">1</td><td data-label="Unit Cost">$10.00</td>' +
        '<td data-label="Total Cost">$10.00</td><td data-label="By">Nick Hettinger</td>' +
        '<td data-label=""><button>a</button><button>b</button></td>' +
        '</tr></tbody></table></div>';
    document.body.appendChild(host);
    try {
        var tbl = host.querySelector('table');
        var scroller = host.querySelector('div');
        if (getComputedStyle(tbl).display !== 'block') {
            return 'the table is still a table -- .tbl-stack is gated too narrow again';
        }
        if (getComputedStyle(host.querySelector('thead')).display !== 'none') {
            return 'the header row is still showing, so the cards have no labels';
        }
        var overflow = tbl.scrollWidth - scroller.clientWidth;
        return overflow <= 1 ||
            'the list still overflows its container by ' + overflow + 'px';
    } finally { host.remove(); }
});

t('a stacked cell carries its column name', function () {
    // Stacking without data-label is worse than scrolling: numbers with nothing
    // to say which column they came from.
    var host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:0;top:0;width:700px;';
    host.innerHTML = '<table class="tbl-stack"><tbody><tr>' +
        '<td data-label="Unit Cost">$10.00</td></tr></tbody></table>';
    document.body.appendChild(host);
    try {
        var c = getComputedStyle(host.querySelector('td'), '::before').content;
        return /Unit Cost/.test(c) || 'the label did not render (content=' + c + ')';
    } finally { host.remove(); }
});

t('tables that keep their columns kept their phone-only floors', function () {
    // The min-width reductions are sized against a 390px screen (.lv-tbl also
    // drops to 11px type). A tablet has the width to leave those alone, so
    // widening .tbl-stack must NOT have dragged them along.
    //
    // Only rules that actually DECLARE min-width count. Matching on the class
    // name alone flagged every rule that merely mentions one of these tables --
    // including a prefers-reduced-motion block -- which is a check that cries
    // wolf and gets switched off.
    var wrong = [];
    _tbMediaRules().forEach(function (r) {
        var cond = _tbNorm(r.conditionText);
        if (cond.indexOf('640px') >= 0) return;             // the phone tier: correct
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                var rule = r.cssRules[i];
                var sel = _tbNorm(rule.selectorText || '');
                if (!/\.(lv|dc|bd)-tbl/.test(sel)) continue;
                if (!rule.style.getPropertyValue('min-width')) continue;
                wrong.push('{' + sel + '} @' + r.conditionText);
            }
        } catch (e) {}
    });
    return !wrong.length ||
        'a keep-the-columns floor escaped the phone tier: ' + wrong.join(', ');
});

// ---------------------------------------------------------------------------
// BUTTON SIZES (Ethan, 2026-09-19: "size them down ... standardization")
// ---------------------------------------------------------------------------

t('the row buttons in Expense Report match the row they sit in', function () {
    var host = document.createElement('div');
    host.id = 'expensesModal';
    host.className = 'modal-menu manage-menu';
    host.style.cssText = 'position:absolute;left:0;top:0;width:880px;display:block;';
    host.innerHTML =
        '<button type="button" class="exp-btn-sm">Save</button>' +
        '<button type="button" class="btn-primary exp-btn-mail">Email Report</button>' +
        '<button type="button" class="btn-primary exp-add-btn">Add Trip</button>' +
        '<button type="button" class="btn-primary">footer action</button>';
    document.body.appendChild(host);
    try {
        var h = Array.prototype.map.call(host.children, function (b) {
            return Math.round(b.getBoundingClientRect().height);
        });
        if (h[1] !== h[0]) return 'Email Report is ' + h[1] + 'px beside a ' + h[0] + 'px Save';
        if (h[2] !== h[0]) return 'Add Trip is ' + h[2] + 'px beside a ' + h[0] + 'px Save';
        // ...and the 38px tier must survive: a footer action that runs the full
        // width of a sheet is a different thing and keeps its size.
        return h[3] > h[0] ||
            'the footer action came down to ' + h[3] + 'px too -- the two tiers have collapsed';
    } finally { host.remove(); }
});

t('btn-ghost is sized with the family it belongs to', function () {
    var host = document.createElement('div');
    host.className = 'modal-menu manage-menu';
    host.style.cssText = 'position:absolute;left:0;top:0;width:880px;display:block;';
    host.innerHTML = '<button class="btn-primary">p</button>' +
                     '<button class="btn-secondary">s</button>' +
                     '<button class="btn-ghost">g</button>';
    document.body.appendChild(host);
    try {
        var mh = Array.prototype.map.call(host.children, function (b) {
            return parseFloat(getComputedStyle(b).minHeight) || 0;
        });
        return (mh[2] === mh[0] && mh[2] === mh[1]) ||
            '.btn-ghost is ' + mh[2] + 'px beside .btn-primary ' + mh[0] +
            ' and .btn-secondary ' + mh[1];
    } finally { host.remove(); }
});

// ---------------------------------------------------------------------------
// THE STACKED CARD ON A TABLET (Ethan, 2026-09-19: "very empty")
// ---------------------------------------------------------------------------

// The tablet tier needs pointer:coarse, which this harness cannot provide, so a
// rule inside it is never live here. Reading its declarations out of the CSSOM
// and re-applying them under a probe class is the closest honest thing: it
// measures the SHIPPED declarations, so editing them changes what this sees.
function _tbReplayTabletRules(selectors) {
    var css = '';
    _tbMediaRules().forEach(function (r) {
        if (_tbNorm(r.conditionText) !== _tbNorm(TB_TABLET)) return;
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                var k = r.cssRules[i];
                var sel = k.selectorText || '';
                if (selectors.indexOf(sel) < 0) continue;
                css += '.tbprobe ' + sel + ' { ' + k.style.cssText + ' }\n';
            }
        } catch (e) {}
    });
    if (!css) return null;
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    return st;
}

function _tbRecycleCard(width) {
    var host = document.createElement('div');
    host.id = 'recycleInvModal';
    host.className = 'tbprobe';
    host.style.cssText = 'position:absolute;left:0;top:0;width:' + width + 'px;';
    host.innerHTML =
        '<table class="tbl-stack recycle-tbl" style="width:100%;border-collapse:collapse;">' +
        '<thead><tr><th>Review</th><th>Date</th><th>Store</th><th>SKU</th>' +
        '<th>Description</th><th>Qty</th><th>Unit Cost</th><th>Total Cost</th>' +
        '<th>By</th><th></th></tr></thead><tbody><tr>' +
        '<td data-label="Review"><span class="recycle-review-cell">' +
        '<select><option>Against Store</option></select></span></td>' +
        '<td data-label="Date">Sep 11</td><td data-label="Store">BAL</td>' +
        '<td data-label="SKU">MO04-1018F-E7</td>' +
        '<td data-label="Description">This was from before we were aware of the ' +
        '~$20 profit threshold for all devices.</td>' +
        '<td data-label="Qty">1</td><td data-label="Unit Cost">$5.00</td>' +
        '<td data-label="Total Cost">$5.00</td><td data-label="By">Garrett Burnell</td>' +
        '<td data-label=""><button>a</button><button>b</button></td>' +
        '</tr></tbody></table>';
    document.body.appendChild(host);
    if (typeof _ddScan === 'function') _ddScan(host);
    return host;
}

var _TB_CARD_SELECTORS = ['.tbl-stack tr', '.tbl-stack td', '.tbl-stack td::before',
                          '.tbl-stack td[data-label=""]',
                          '.recycle-tbl td[data-label="Description"]'];

t('a stacked card becomes a grid of fields on a tablet', function () {
    // The phone card is label-left / value-right. At 390px that is two things
    // nearly touching; at 780px it is 600px of nothing, nine times down the card.
    var st = _tbReplayTabletRules(_TB_CARD_SELECTORS);
    if (!st) return 'no tablet-tier rules for the stacked card were found at all';
    try {
        var host = _tbRecycleCard(780);
        try {
            var tr = host.querySelector('tbody tr');
            var cs = getComputedStyle(tr);
            if (cs.display !== 'grid') return 'the card is display:' + cs.display + ', not a grid';
            var cols = cs.gridTemplateColumns.split(/\s+/).filter(Boolean).length;
            if (cols < 3) {
                return 'only ' + cols + ' column(s) at 780px -- the fields are still ' +
                       'stacked one per line';
            }
            // The chasm, measured: a short field must not own the whole card.
            var cardW = tr.getBoundingClientRect().width;
            var qty = host.querySelector('td[data-label="Qty"]').getBoundingClientRect();
            return qty.width < cardW / 2 ||
                'the QTY field is ' + Math.round(qty.width) + 'px of a ' +
                Math.round(cardW) + 'px card';
        } finally { host.remove(); }
    } finally { st.remove(); }
});

t('the grid tracks more columns as the card gets wider', function () {
    // auto-fit is what makes this hold at 744px and at 1366px without a second
    // breakpoint. A fixed column count would be a new thing to get wrong.
    var st = _tbReplayTabletRules(_TB_CARD_SELECTORS);
    if (!st) return 'no tablet-tier card rules found';
    try {
        var count = function (w) {
            var host = _tbRecycleCard(w);
            try {
                return getComputedStyle(host.querySelector('tbody tr'))
                    .gridTemplateColumns.split(/\s+/).filter(Boolean).length;
            } finally { host.remove(); }
        };
        var narrow = count(620), wide = count(900);
        return wide > narrow ||
            'a 900px card has ' + wide + ' columns and a 620px card has ' + narrow +
            ' -- the track count is not following the width';
    } finally { st.remove(); }
});

t('prose and the action buttons take the whole card', function () {
    var st = _tbReplayTabletRules(_TB_CARD_SELECTORS);
    if (!st) return 'no tablet-tier card rules found';
    try {
        var host = _tbRecycleCard(780);
        try {
            var tr = host.querySelector('tbody tr').getBoundingClientRect();
            var d = host.querySelector('td[data-label="Description"]').getBoundingClientRect();
            var a = host.querySelector('td[data-label=""]').getBoundingClientRect();
            // A sentence in a 150px column beside QTY is worse than the chasm was.
            if (d.width < tr.width * 0.8) {
                return 'Description is ' + Math.round(d.width) + 'px of a ' +
                       Math.round(tr.width) + 'px card -- it is sitting in a field column';
            }
            return a.width >= tr.width * 0.8 ||
                'the action buttons are ' + Math.round(a.width) + 'px -- [data-label=""] ' +
                'is not spanning, so an unlabelled cell became a field';
        } finally { host.remove(); }
    } finally { st.remove(); }
});

t('the Review dropdown stays inside its grid track', function () {
    // A grid track is a definite width, which is exactly the case the inline
    // min-width from _ddScan paints over -- the same bug as the B2B sheet's Type
    // control and the Expense Report's Category. .tbl-stack td had to join the
    // clamp list or the face would cover the field beside it.
    var host = _tbRecycleCard(780);
    var st = null;
    try {
        var dh = host.querySelector('.dd-host');
        if (!dh) return 'the select was never enhanced';
        if (String(dh.style.minWidth).indexOf('min(') !== 0) {
            return 'the host took a flat min-width ("' + dh.style.minWidth +
                   '") -- nothing in CSS can outrank that, so it will paint over ' +
                   'the field beside it';
        }
        host.remove();
        st = _tbReplayTabletRules(_TB_CARD_SELECTORS);
        if (!st) return 'no tablet-tier card rules found';
        host = _tbRecycleCard(780);
        var cell = host.querySelector('td[data-label="Review"]').getBoundingClientRect();
        var face = host.querySelector('.dd-btn').getBoundingClientRect();
        return face.right <= cell.right + 0.5 ||
            'the face overhangs its track by ' + Math.round(face.right - cell.right) + 'px';
    } finally { host.remove(); if (st) st.remove(); }
});

t('the phone card keeps the layout it was approved with', function () {
    // The grid is a TABLET exception. At 390px label-left / value-right is right,
    // and it is the 20 Aug design -- widening the grid to the whole band would
    // quietly redesign the phone.
    var phone = null;
    _tbMediaRules().forEach(function (r) {
        if (_tbNorm(r.conditionText) !== _tbNorm(TB_BAND)) return;
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                if ((r.cssRules[i].selectorText || '') === '.tbl-stack td') phone = r.cssRules[i];
            }
        } catch (e) {}
    });
    if (!phone) return 'the compact-band .tbl-stack td rule is gone';
    var d = phone.style.getPropertyValue('display');
    var j = phone.style.getPropertyValue('justify-content');
    return (d === 'flex' && j === 'space-between') ||
        'the phone card is now display:' + d + ' / ' + j + ' -- the tablet grid leaked down';
});

// ---------------------------------------------------------------------------
// SURFACES A TABLET EARNS BACK (Ethan, 2026-09-19)
// data-tablet="show" beside data-mobile="hide": cut from the phone, kept here.
// ---------------------------------------------------------------------------

// What was asked for, by the attribute that identifies each one. Written out so
// that removing one is a decision somebody makes, not something that rots away.
var TB_EARNED_BACK = [
    ['#notifySettingsBtn',    'Settings button'],
    ['[data-tip="Strategic Calendar"]', 'Calendar button'],
    ['[data-feature="widget-dm-goals"]',    'Monthly Team Goals (DM)'],
    ['[data-feature="widget-goals-panel"]', 'Goals & Initiatives (manager)'],
    ['[data-feature="widget-dm-audit"]',    'Cleaning Checklist (DM/CEO)'],
    ['[data-feature="widget-audit-panel"]', 'Cleaning Checklist (manager)']
];

t('the four surfaces asked for are opted in', function () {
    var missing = [];
    TB_EARNED_BACK.forEach(function (p) {
        var els = document.querySelectorAll(p[0]);
        if (!els.length) { missing.push(p[1] + ' — no element matches ' + p[0]); return; }
        var any = false;
        els.forEach(function (e) { if (e.getAttribute('data-tablet') === 'show') any = true; });
        if (!any) missing.push(p[1] + ' is not opted in');
    });
    return !missing.length || missing.join('; ');
});

t('the opt-in does not leak onto the phone', function () {
    // The whole point of data-tablet="show" rather than deleting data-mobile.
    // If this ever passes on a phone, 208 surfaces are one attribute away from
    // coming back on a 390px screen.
    var mob = window._isMobileLayout, tab = window._isTabletLayout;
    var el = document.createElement('div');
    el.className = 'dynamic-module-flex role-mocd';
    el.setAttribute('data-mobile', 'hide');
    el.setAttribute('data-tablet', 'show');
    document.body.appendChild(el);
    try {
        window._isMobileLayout = function () { return true; };
        window._isTabletLayout = function () { return false; };      // a phone
        applyRoleBasedUI();
        if (el.style.display !== 'none') {
            return 'an opted-in surface is visible on the PHONE (display: "' +
                   el.style.display + '")';
        }
        window._isTabletLayout = function () { return true; };       // a tablet
        applyRoleBasedUI();
        if (el.style.display !== 'flex') {
            return 'an opted-in surface is still cut on a TABLET (display: "' +
                   el.style.display + '")';
        }
        window._isMobileLayout = function () { return false; };      // desktop
        applyRoleBasedUI();
        return el.style.display === 'flex' ||
            'an opted-in surface broke on the desktop (display: "' + el.style.display + '")';
    } finally {
        window._isMobileLayout = mob; window._isTabletLayout = tab;
        el.remove();
    }
});

t('a surface WITHOUT the opt-in is still cut on a tablet', function () {
    // The other half: the port cut 208 surfaces on purpose, and a tablet keeps
    // every one of them until somebody says otherwise.
    var mob = window._isMobileLayout, tab = window._isTabletLayout;
    var el = document.createElement('div');
    el.className = 'dynamic-module-flex role-mocd';
    el.setAttribute('data-mobile', 'hide');
    document.body.appendChild(el);
    try {
        window._isMobileLayout = function () { return true; };
        window._isTabletLayout = function () { return true; };
        applyRoleBasedUI();
        return el.style.display === 'none' ||
            'the cut stopped applying to plain data-mobile="hide" surfaces on a tablet';
    } finally {
        window._isMobileLayout = mob; window._isTabletLayout = tab;
        el.remove();
    }
});

t('the CSS half of the opt-in covers the plain elements', function () {
    // The sweep only reaches .dynamic-module-* elements. The two nav buttons are
    // plain .action-btn, so without this rule they would stay cut on a tablet
    // however the JS votes.
    //
    // The BLANKET rule specifically -- the bare attribute pair and nothing else.
    // Per-surface restores sit beside it now (.cc-sum block, .cc-strip grid,
    // .cc-panel block, and the district gate's display:none), and taking the last
    // match would test one of those instead of the default every other opted-in
    // element relies on.
    var rule = null;
    _tbMediaRules().forEach(function (r) {
        if (_tbNorm(r.conditionText) !== _tbNorm(TB_TABLET)) return;
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                var sel = _tbNorm(r.cssRules[i].selectorText || '');
                if (sel === '[data-mobile="hide"][data-tablet="show"]') rule = r.cssRules[i];
            }
        } catch (e) {}
    });
    if (!rule) return 'no blanket [data-mobile="hide"][data-tablet="show"] rule in the tablet tier';
    var d = rule.style.getPropertyValue('display');
    // revert would resolve to the UA default (block for a div), not to what the
    // author's own rules said -- .action-btn and .sam-mini are both flex.
    if (d === 'revert') {
        return 'the rule uses display:revert, which resolves to the UA default ' +
               'and would lay a flex box out as a block';
    }
    if (d !== 'flex') return 'the rule restores display:' + d + ', not flex';
    return rule.style.getPropertyPriority('display') === 'important' ||
        'the restore is not !important, so the cut (which is) still wins';
});

t('no opted-in trigger opens something that is still cut', function () {
    // A button that opens a hidden panel is worse than no button at all.
    var PAIRS = [['widget-audit-panel', 'auditSidePanel'],
                 ['widget-goals-panel', 'goalsSidePanel']];
    var bad = [];
    PAIRS.forEach(function (p) {
        var trig = document.querySelector('[data-feature="' + p[0] + '"][data-tablet="show"]');
        var targ = document.getElementById(p[1]);
        if (!trig) { bad.push(p[0] + ': trigger not opted in'); return; }
        if (!targ) { bad.push(p[1] + ': missing from the page'); return; }
        if (targ.getAttribute('data-mobile') === 'hide' &&
            targ.getAttribute('data-tablet') !== 'show') {
            bad.push(p[1] + ' is still cut while the row that opens it is back');
        }
    });
    // ...and the handlers those rows call have to exist at all.
    ['toggleAuditPanel', 'toggleGoalsPanel', 'openDmCleaning', 'openDmMonthlyGoals',
     'openSettings', 'toggleCalendar'].forEach(function (fn) {
        if (typeof window[fn] !== 'function') bad.push(fn + '() is not defined');
    });
    return !bad.length || bad.join('; ');
});

t('the restored panels are the ones the drawer rule already covers', function () {
    // #auditSidePanel is a .checklist-side-panel and #goalsSidePanel a
    // .goals-side-panel, which is why they need no new width rule: the tablet
    // drawer clamp picks them up as they are.
    var bad = [];
    [['auditSidePanel', 'checklist-side-panel'],
     ['goalsSidePanel', 'goals-side-panel']].forEach(function (p) {
        var el = document.getElementById(p[0]);
        if (!el) { bad.push(p[0] + ' missing'); return; }
        if (!el.classList.contains(p[1])) {
            bad.push(p[0] + ' no longer carries .' + p[1] + ', so it will open full-bleed');
        }
    });
    return !bad.length || bad.join('; ');
});
