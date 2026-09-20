// ===========================================================================
// THE LOGIN SCREEN, VERTICALLY — brand, card, rail
//
//   powershell -File scripts/browser-check.ps1 auth-layout-check.js -WindowSize 744,1133
//   powershell -File scripts/browser-check.ps1 auth-layout-check.js -WindowSize 820,1180
//   powershell -File scripts/browser-check.ps1 auth-layout-check.js -WindowSize 1024,1366
//
// No -Html: injectGlobalAuth() builds the whole overlay from speeks.js, so the
// real markup is already here and no page needs inlining.
//
// WHY THIS FILE EXISTS. The login lays itself out by SPLITTING LEFTOVER HEIGHT —
// .auth-brand and .auth-tail are both `flex: 1 1 0` and the brand centres the
// wordmark inside its share. That means every measurement on this screen is a
// function of the viewport height, and nothing about it can be verified by
// reading the stylesheet. It has to be rendered at a height and measured, which
// is what scripts/browser-check.ps1 -WindowSize was added for.
//
// Ethan, 2026-09-20, on an iPad: "make the top part above the pin code move down
// closer to the top of the pin code area like it looks on desktop, so there isn't
// such a high amount of space between them."
//
// The desktop gap is a CONSTANT, not a ratio: 84px at 1440x900 and 84px at
// 1920x1080 — two windows that share neither dimension. The tablet gap is not:
// 149px at 744x1133, 161px at 820x1180, 204px at 1024x1366, because the taller
// the screen the bigger the share the brand centres the wordmark inside. Those
// five numbers are the whole argument for the fix and the reason it is a flat
// 84px rather than a vh clamp.
//
// THE HARNESS CANNOT BE A TABLET. The tier needs pointer:coarse and headless
// Chrome reports fine, so the tablet rule is never live here. It is read out of
// the CSSOM and replayed under html.tbprobe — which measures the SHIPPED
// declaration, so editing it moves these numbers. Nothing on this screen is
// decided on source order (one rule, one property, no competitor), so the
// specificity the probe class adds costs nothing here; contrast the nav-label
// rule in stats-awards-check.js, where it costs everything.
// ===========================================================================

if (typeof _b2bSend === 'function') { _b2bSend = function () { return Promise.resolve({}); }; }

var AU_TABLET_Q = '(min-width: 701px) and (min-height: 540px)'
                + ' and (max-width: 1366px) and (pointer: coarse)';

function _auNorm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function _auMediaRules() {
    var out = [];
    Array.prototype.forEach.call(document.styleSheets, function (ss) {
        var rules; try { rules = ss.cssRules; } catch (e) { return; }
        Array.prototype.forEach.call(rules || [], function (r) {
            if (r.type === CSSRule.MEDIA_RULE) out.push(r);
        });
    });
    return out;
}

function _auReplayTablet() {
    var css = '';
    _auMediaRules().forEach(function (r) {
        if (_auNorm(r.conditionText) !== _auNorm(AU_TABLET_Q)) return;
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                css += 'html.tbprobe ' + r.cssRules[i].selectorText +
                       ' { ' + r.cssRules[i].style.cssText + ' }\n';
            }
        } catch (e) {}
    });
    if (!css) return null;
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    document.documentElement.classList.add('tbprobe');
    return st;
}
function _auEndReplay(st) {
    if (st) st.remove();
    document.documentElement.classList.remove('tbprobe');
}

// Every number here is a function of the window, so a run at the wrong one
// reports a drift that does not exist. Told once, in one place.
function _auNeedsTabletBox() {
    var w = window.innerWidth, h = window.innerHeight;
    if (w >= 701 && w <= 1366 && h >= 540) return null;
    return 'this run is ' + w + 'x' + h + ', outside the tablet tier\'s box — ' +
           'the rule under test would not apply on a real device this shape. ' +
           'Use -WindowSize 744,1133.';
}

// The overlay is display:none until the auth JS shows it, and a hidden ancestor
// makes every rect 0x0 — the quiet way this file could go green while measuring
// nothing. Shown once, here, and left up for the whole suite.
function _auOpen() {
    injectGlobalAuth();
    var ov = document.getElementById('authOverlay');
    ov.style.display = 'flex';
    return ov;
}

function _auBox(sel) {
    var el = document.querySelector('#authOverlay ' + sel);
    if (!el) return null;
    var b = el.getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, height: b.height };
}

// The gap the request is about: the bottom of the last thing in the brand group
// to the top of the card. Measured off .auth-portal rather than .auth-brand,
// because the brand REGION is mostly empty space by design — its bottom edge is
// the card's top edge and the difference would always be zero.
function _auGap() {
    var portal = _auBox('.auth-portal'), card = _auBox('.auth-card');
    if (!portal || !card) return null;
    return card.top - portal.bottom;
}

t('the login overlay renders at all', function () {
    var ov = _auOpen();
    if (!ov) return 'injectGlobalAuth() produced no #authOverlay';
    var missing = ['.auth-brand', '.auth-portal', '.auth-card', '.pin-cells', '.auth-rail']
        .filter(function (s) { return !_auBox(s); });
    if (missing.length) return 'no ' + missing.join(', ') + ' — the markup moved';
    var card = _auBox('.auth-card');
    return card.height > 100 ||
        'the card measures ' + Math.round(card.height) + 'px tall, so something ' +
        'above it is display:none and every number in this file is meaningless';
});

t('a tall tablet leaves the wordmark stranded without the fix', function () {
    // The baseline, asserted rather than remembered. If the underlying split ever
    // changes — .auth-tail gaining a min-height, the brand losing its flex — this
    // is the test that says so, and the next test's number stops meaning what its
    // comment claims it means.
    var g = _auNeedsTabletBox(); if (g) return g;
    _auOpen();
    var gap = _auGap();
    return gap > 120 ||
        'the un-replayed gap is ' + Math.round(gap) + 'px, not the 149-204px this ' +
        'screen produces from an even brand/tail split — the split changed, so ' +
        'the tablet rule may no longer be the thing fixing it';
});

t('the tablet tier pulls the wordmark down to the desktop gap', function () {
    var g = _auNeedsTabletBox(); if (g) return g;
    _auOpen();
    var before = _auGap();
    var st = _auReplayTablet();
    try {
        if (!st) return 'no tablet-tier rules in the stylesheet at all';
        var after = _auGap();
        if (after >= before) {
            return 'the gap did not close: ' + Math.round(before) + 'px before the ' +
                   'tablet rules, ' + Math.round(after) + 'px after';
        }
        // 84px is the desktop's measured gap at both 1440x900 and 1920x1080. The
        // tolerance is for sub-pixel line-box rounding on .auth-portal, not for
        // slack in the number.
        return Math.abs(after - 84) <= 4 ||
            'the gap lands at ' + Math.round(after) + 'px, not the desktop\'s 84px ' +
            '(it was ' + Math.round(before) + 'px before the fix)';
    } finally { _auEndReplay(st); }
});

t('...and the card does not move while it happens', function () {
    // The point of anchoring the brand to the BOTTOM of its share rather than
    // shrinking the share: the region keeps its height, so the card stays exactly
    // where it was and only the wordmark travels. Shrink the brand instead and
    // this fails — the card climbs, the rail follows, and the screen is
    // top-heavy with a void under it.
    var g = _auNeedsTabletBox(); if (g) return g;
    _auOpen();
    var before = _auBox('.auth-card').top;
    var st = _auReplayTablet();
    try {
        var after = _auBox('.auth-card').top;
        return Math.abs(after - before) <= 1 ||
            'the card moved ' + Math.round(after - before) + 'px (' +
            Math.round(before) + ' -> ' + Math.round(after) + '); the fix is ' +
            'supposed to move the wordmark, not the card';
    } finally { _auEndReplay(st); }
});

t('the wordmark stays above the card and on the screen', function () {
    // flex-end with a padding that outgrew the region would push the group up
    // through the top of the viewport, where it cannot be scrolled back to on a
    // login (.auth-page scrolls, but nobody scrolls a PIN pad).
    var g = _auNeedsTabletBox(); if (g) return g;
    _auOpen();
    var st = _auReplayTablet();
    try {
        var brand = _auBox('.auth-brand'), portal = _auBox('.auth-portal');
        var card = _auBox('.auth-card');
        if (brand.top < 0) {
            return 'the brand region starts at ' + Math.round(brand.top) + 'px — ' +
                   'above the top of the screen';
        }
        return portal.bottom <= card.top + 1 ||
            'the wordmark overlaps the card: portal ends at ' +
            Math.round(portal.bottom) + ', card starts at ' + Math.round(card.top);
    } finally { _auEndReplay(st); }
});

t('the fix is two declarations, not a rebuild', function () {
    // Guards the blast radius. This screen is load-bearing — it is the only way
    // in — and its stylesheet header lists the hooks the auth JS depends on, so
    // a tablet tweak that quietly started moving .auth-card or .pin-cells around
    // would be a much bigger change than the one that was asked for.
    var OK = { '.auth-brand': 1, '.auth-portal': 1 };
    var touched = [];
    _auMediaRules().forEach(function (r) {
        if (_auNorm(r.conditionText) !== _auNorm(AU_TABLET_Q)) return;
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                var sel = _auNorm(r.cssRules[i].selectorText || '');
                if (/\.auth-|\.pin-/.test(sel) && !OK[sel]) touched.push(sel);
            }
        } catch (e) {}
    });
    return !touched.length ||
        'the tablet tier now also restyles ' + touched.join(', ') + ' — if that is ' +
        'deliberate, measure it here too rather than deleting this test';
});

t('the gap is a margin, because padding would move the card', function () {
    // The trap this screen sets, asserted directly so the next person reading
    // `.auth-portal { margin-bottom }` and reaching for the more obvious
    // `.auth-brand { padding-bottom }` is told why before they measure it.
    // .auth-brand is `flex: 1 1 0` and its padding lands in the flex BASE, which
    // it splits with .auth-tail — so padding here buys half a gap and half a
    // card-shove. The test above catches the shove; this one names the cause.
    var bad = [];
    _auMediaRules().forEach(function (r) {
        if (_auNorm(r.conditionText) !== _auNorm(AU_TABLET_Q)) return;
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                var rule = r.cssRules[i];
                if (_auNorm(rule.selectorText || '') !== '.auth-brand') continue;
                ['padding', 'padding-bottom', 'padding-top', 'height', 'min-height', 'flex']
                    .forEach(function (p) {
                        var v = rule.style.getPropertyValue(p);
                        if (v) bad.push(p + ': ' + v);
                    });
            }
        } catch (e) {}
    });
    return !bad.length ||
        '.auth-brand sets ' + bad.join('; ') + ' in the tablet tier — every one of ' +
        'those feeds the brand/tail split and therefore the card\'s position';
});
