// ===========================================================================
// COMMAND CENTERS ON A TABLET — eBay, Scorecard, Store Breakdown
//
//   powershell -File scripts/browser-check.ps1 command-center-check.js \
//              -Html index.html -WindowSize 744,1133
//
// 744x1133 is an iPad mini in portrait: the narrowest tablet the tier admits,
// and therefore the only width worth asserting about. -Html because all of this
// is about which attribute sits on which real element.
//
// Ethan, 2026-09-19: "you can now add ebay, scorecard, and store breakdown back
// in." Those are three TABS on two boards, and bringing a tab back means four
// separate things — the button, the summary cell, the strip and the panel — plus
// the bar that holds the button, which the compact layer cuts wholesale.
//
// THE HARNESS CANNOT BE A TABLET. The tier needs pointer:coarse and headless
// Chrome reports fine, so tablet-tier rules are never live here. They are read
// out of the CSSOM and replayed under html.tbprobe, which measures the SHIPPED
// declarations — edit them and this moves.
// ===========================================================================

function _ccMediaRules() {
    var out = [];
    Array.prototype.forEach.call(document.styleSheets, function (ss) {
        var rules; try { rules = ss.cssRules; } catch (e) { return; }
        Array.prototype.forEach.call(rules || [], function (r) {
            if (r.type === CSSRule.MEDIA_RULE) out.push(r);
        });
    });
    return out;
}
function _ccNorm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

var CC_TABLET_Q = '(min-width: 701px) and (min-height: 540px)'
                + ' and (max-width: 1366px) and (pointer: coarse)';
var CC_BAND_Q   = '(max-width: 900px), (max-width: 1366px) and (pointer: coarse)';

function _ccReplayTablet() {
    var css = '';
    _ccMediaRules().forEach(function (r) {
        if (_ccNorm(r.conditionText) !== _ccNorm(CC_TABLET_Q)) return;
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
function _ccEndReplay(st) {
    if (st) st.remove();
    document.documentElement.classList.remove('tbprobe');
}

// MOST OF THIS FILE ONLY MEANS ANYTHING INSIDE THE COMPACT BAND. The cuts it
// asserts about — .cc-summary, .cc-tabbar, .bd-open, the whole .lv-pick* restyle
// and the 30px close-control standard — are compact-band rules, and the tablet
// tier layers on top of them. Run at a desktop width they simply are not there,
// and seven tests fail with seven different stories about why. One guard, told
// once, so the width contract in the header is enforced rather than hoped for.
function _ccNeedsCompact() {
    if (typeof _isMobileLayout === 'function' && _isMobileLayout()) return null;
    return 'this run is at ' + window.innerWidth + 'px, outside the compact band — ' +
           'the rule under test is not live here. Use -WindowSize 744,1133.';
}

// The login gate hides .main-content and the boards are role-gated. Neither is
// what is under test.
(function () {
    var mc = document.querySelector('.main-content');
    if (mc) mc.style.setProperty('display', 'block', 'important');
    ['ccWidget', 'dcWidget'].forEach(function (id) {
        var e = document.getElementById(id);
        if (e) e.style.setProperty('display', 'block', 'important');
    });
})();

// What was asked for, spelled out, with the display each surface has to come
// back as. Written here so removing one is a decision somebody makes.
var CC_EARNED_BACK = [
    ['cc-tab-ebay',        'flex',  'manager eBay tab'],
    ['cc-tab-scorecard',   'flex',  'manager Scorecard tab'],
    ['cc-sum-ebay',        'block', 'manager eBay summary cell'],
    ['cc-sum-score',       'block', 'manager Scorecard summary cell'],
    ['cc-sum-audit',       'block', 'manager PayMore Audit summary cell'],
    ['cc-strip-ebay',      'grid',  'manager eBay tile strip'],
    ['cc-strip-scorecard', 'grid',  'manager Scorecard tile strip'],
    ['cc-panel-ebay',      'block', 'manager eBay panel'],
    ['cc-panel-scorecard', 'block', 'manager Scorecard panel'],
    ['dc-tab-stores',      'flex',  'district Store Breakdown tab'],
    ['dc-tab-ebay',        'flex',  'district eBay tab'],
    ['dc-tab-scorecard',   'flex',  'district Scorecard tab'],
    ['dc-sum-ebay',        'block', 'district eBay summary cell'],
    ['dc-sum-score',       'block', 'district Scorecard summary cell'],
    ['dc-sum-audit',       'block', 'district PayMore Audit summary cell'],
    // The district panels are display-switched, not opacity-switched — so the
    // right answer for an INACTIVE one is still none.
    ['dc-panel-ebay',      'none',  'district eBay panel'],
    ['dc-panel-scorecard', 'none',  'district Scorecard panel'],
    ['dc-panel-stores',    'none',  'Store Breakdown panel']
];

t('every surface asked for carries the opt-in', function () {
    var bad = [];
    CC_EARNED_BACK.forEach(function (p) {
        var e = document.getElementById(p[0]);
        if (!e) { bad.push(p[2] + ' (#' + p[0] + ') is not in the page'); return; }
        if (e.getAttribute('data-mobile') !== 'hide') {
            bad.push(p[2] + ' no longer carries the cut, so the opt-in means nothing');
        } else if (e.getAttribute('data-tablet') !== 'show') {
            bad.push(p[2] + ' is not opted in');
        }
    });
    return !bad.length || bad.join('; ');
});

t('each one comes back as the display it actually uses', function () {
    // The blanket restore is display:flex, which is right for a tab button and
    // wrong for the other three shapes: a .cc-sum would put its key beside its
    // value, and a .cc-strip would throw away the column counts .s3/.s4 declare.
    var st = _ccReplayTablet();
    if (!st) return 'no tablet-tier rules found at all';
    try {
        var bad = [];
        CC_EARNED_BACK.forEach(function (p) {
            var e = document.getElementById(p[0]);
            if (!e) return;
            var d = getComputedStyle(e).display;
            if (d !== p[1]) bad.push(p[2] + ' is display:' + d + ', wanted ' + p[1]);
        });
        return !bad.length || bad.join('; ');
    } finally { _ccEndReplay(st); }
});

t('the tablet display matches what the desktop computes', function () {
    // The restore names a value by hand, so it can drift away from the rule it is
    // copying. Compare against the element with the cut taken off entirely, which
    // is the desktop cascade.
    var bad = [];
    CC_EARNED_BACK.forEach(function (p) {
        if (p[1] === 'none') return;            // the district gate, asserted below
        var e = document.getElementById(p[0]);
        if (!e) return;
        var was = e.getAttribute('data-mobile');
        e.removeAttribute('data-mobile');
        var desktop = getComputedStyle(e).display;
        if (was) e.setAttribute('data-mobile', was);
        if (desktop !== p[1]) {
            bad.push(p[2] + ': the tablet restores ' + p[1] + ' but the desktop ' +
                     'computes ' + desktop);
        }
    });
    return !bad.length || bad.join('; ');
});

t('the district board keeps display as its tab switch', function () {
    // #dcWidget .cc-panel:not(.cc-active) { display: none } — its tabs are wildly
    // different heights, so unlike the store board it does not stack them in one
    // grid cell. A flat restore would pin all four open on top of each other.
    var st = _ccReplayTablet();
    if (!st) return 'no tablet-tier rules found';
    try {
        var bad = [];
        ['dc-panel-ebay', 'dc-panel-scorecard', 'dc-panel-stores'].forEach(function (id) {
            var e = document.getElementById(id);
            if (getComputedStyle(e).display !== 'none') {
                bad.push(id + ' is open while inactive');
            }
            e.classList.add('cc-active');
            var open = getComputedStyle(e).display;
            e.classList.remove('cc-active');
            if (open === 'none') bad.push(id + ' stays hidden when its tab is open');
        });
        return !bad.length || bad.join('; ');
    } finally { _ccEndReplay(st); }
});

t('a tablet gets the tab bar back', function () {
    // A tab is unreachable without its bar, and the bar is cut for the whole
    // compact band. The summary is NOT restored with it — see "a tablet has no
    // summary and no way back to one" further down, which is the later call.
    var st = _ccReplayTablet();
    if (!st) return 'no tablet-tier rules found';
    try {
        var bar = document.querySelector('#ccWidget .cc-tabbar');
        if (!bar) return 'the board chrome is missing from the page';
        return getComputedStyle(bar).display !== 'none' ||
            'the tab bar is still cut — the tabs cannot be reached';
    } finally { _ccEndReplay(st); }
});

t('a phone keeps every one of them cut', function () {
    var _g = _ccNeedsCompact(); if (_g) return _g;
    // The harness viewport is inside the compact band and is not a tablet, which
    // is the phone case exactly — no replay needed.
    if (_isTabletLayout()) return 'this run reads as a tablet, so it proves nothing about a phone';
    var bad = [];
    CC_EARNED_BACK.forEach(function (p) {
        var e = document.getElementById(p[0]);
        if (e && getComputedStyle(e).display !== 'none') {
            bad.push(p[2] + ' came back on the PHONE (display:' + getComputedStyle(e).display + ')');
        }
    });
    var bar = document.querySelector('#ccWidget .cc-tabbar');
    var sum = document.getElementById('cc-summary');
    if (bar && getComputedStyle(bar).display !== 'none') bad.push('the tab bar is back on the phone');
    if (sum && getComputedStyle(sum).display !== 'none') bad.push('the summary is back on the phone');
    return !bad.length || bad.join('; ');
});

t('no restored tab opens a panel that is still cut', function () {
    var bad = [];
    [['cc-tab-ebay', 'cc-panel-ebay'], ['cc-tab-scorecard', 'cc-panel-scorecard'],
     ['dc-tab-ebay', 'dc-panel-ebay'], ['dc-tab-scorecard', 'dc-panel-scorecard'],
     ['dc-tab-stores', 'dc-panel-stores']].forEach(function (p) {
        var tab = document.getElementById(p[0]), panel = document.getElementById(p[1]);
        if (!tab || !panel) { bad.push(p[0] + '/' + p[1] + ': missing'); return; }
        if (tab.getAttribute('data-tablet') === 'show' &&
            panel.getAttribute('data-tablet') !== 'show') {
            bad.push(p[0] + ' is back but ' + p[1] + ' is not');
        }
    });
    // ...and the handlers the buttons call exist.
    ['switchCommandTab', 'switchDistrictTab'].forEach(function (fn) {
        if (typeof window[fn] !== 'function') bad.push(fn + '() is not defined');
    });
    // Every restored tab must be one the switcher actually knows about, or
    // clicking it toggles nothing.
    ['ebay', 'scorecard'].forEach(function (k) {
        if (CC_TABS.indexOf(k) < 0) bad.push('CC_TABS has no "' + k + '"');
    });
    ['stores', 'ebay', 'scorecard'].forEach(function (k) {
        if (DC_TABS.indexOf(k) < 0) bad.push('DC_TABS has no "' + k + '"');
    });
    return !bad.length || bad.join('; ');
});

t('the Live tab does not leave an empty tile strip behind it', function () {
    // #cc-strip-live is cut on every compact screen, and all the strips share one
    // grid cell — so with the strips row restored, opening Live reserved the
    // height of the tallest strip and painted none of it.
    var found = false;
    _ccMediaRules().forEach(function (r) {
        if (_ccNorm(r.conditionText) !== _ccNorm(CC_BAND_Q)) return;
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                var sel = _ccNorm(r.cssRules[i].selectorText || '');
                if (sel.indexOf('cc-strips') >= 0 && sel.indexOf('cc-strip-live') >= 0 &&
                    r.cssRules[i].style.getPropertyValue('display') === 'none') found = true;
            }
        } catch (e) {}
    });
    return found ||
        'nothing hides .cc-strips while #cc-strip-live is the active tab, so Live ' +
        'shows an empty band under the tab bar';
});

t('a phone opens a tab, so the board is not a bare header', function () {
    var _g = _ccNeedsCompact(); if (_g) return _g;
    // The compact layer hides the summary AND the tab bar, on the reading that
    // "the panel is opened on arrival". _reconcileCommandWidgets stopped opening
    // one, which left the card as 68px of its own title with no way in.
    var w = document.getElementById('ccWidget');
    var before = Math.round(w.getBoundingClientRect().height);
    w.classList.remove('cc-expanded');
    // No flags to reset any more: _openDefaultTab reads the card's own state,
    // because a module flag cannot survive the SPA router replacing .main-content
    // underneath it. Clearing cc-expanded above is the whole setup now -- and it
    // can leave a tab still flagged active, which is the torn state
    // _openDefaultTab repairs rather than mistakes for "already open".
    _reconcileCommandWidgets();
    var live = document.getElementById('cc-panel-live');
    if (!w.classList.contains('cc-expanded')) {
        return 'the board is still collapsed on a phone (was ' + before + 'px tall), ' +
               'and both the summary it collapses to and the tab bar are cut';
    }
    return live.classList.contains('cc-active') ||
        'the board expanded but no tab opened, so every panel is transparent';
});

t('...and a DESKTOP still opens on its summary', function () {
    // The compact rule is "open a tab because the summary is cut". A desktop has
    // the summary, and opening a tab over it would bury the one line that answers
    // "how are we doing" before anyone has asked anything.
    var mob = window._isMobileLayout;
    var w = document.getElementById('ccWidget');
    w.classList.remove('cc-expanded');
    // No flags to reset any more: _openDefaultTab reads the card's own state,
    // because a module flag cannot survive the SPA router replacing .main-content
    // underneath it. Clearing cc-expanded above is the whole setup now -- and it
    // can leave a tab still flagged active, which is the torn state
    // _openDefaultTab repairs rather than mistakes for "already open".
    try {
        window._isMobileLayout = function () { return false; };
        _reconcileCommandWidgets();
        return !w.classList.contains('cc-expanded') ||
            'the desktop board opened a tab over its own summary';
    } finally { window._isMobileLayout = mob; }
});

// ---------------------------------------------------------------------------
// Nothing scrolls sideways. Ethan's standing rule, 2026-09-19: "for any tool, I
// don't want to have to scroll horizontally."
// ---------------------------------------------------------------------------

function _ccActivate(id) {
    ['dc-panel-live', 'dc-panel-ebay', 'dc-panel-scorecard', 'dc-panel-stores']
        .forEach(function (p) {
            var e = document.getElementById(p);
            if (e) e.classList.toggle('cc-active', p === id);
        });
    document.getElementById('dcWidget').classList.add('cc-expanded');
    return document.getElementById(id);
}

t('the district eBay board fits an iPad mini', function () {
    var st = _ccReplayTablet();
    try {
        var p = _ccActivate('dc-panel-ebay');
        p.innerHTML = '<div class="lv-tbl-scroll"><table class="lv-tbl dc-tbl">' +
            '<thead><tr><th>Store</th><th>Tracking</th><th>Defect rate</th>' +
            '<th>Cases closed</th><th>Late shipment</th></tr></thead>' +
            '<tbody class="dc-grp"><tr class="dc-clickable">' +
            '<td class="lv-store"><b>BAL</b></td><td>97.42%</td><td>0.21%</td>' +
            '<td>0.10%</td><td>1.80%</td></tr><tr class="dc-catrow">' +
            '<td colspan="5" class="dc-cats"><div class="dc-catwrap">' +
            '<span class="dc-catlab">Categories at risk</span>' +
            '<span class="dc-cat dc-bad"><b>Cell Phones &amp; Smartphones</b>very high</span>' +
            '</div></td></tr></tbody></table></div>';
        var w = p.querySelector('.lv-tbl-scroll');
        return w.scrollWidth <= w.clientWidth + 1 ||
            'it scrolls sideways by ' + (w.scrollWidth - w.clientWidth) + 'px at ' +
            window.innerWidth + 'px';
    } finally { _ccEndReplay(st); }
});

t('...and so does the district Scorecard, with real category names', function () {
    // Both tables are table-layout:fixed with a colgroup, so content never widens
    // a column — an over-long header spills out of the table instead and the
    // wrapper grows a scrollbar for it. "Merchandising" in an 8.5% column is the
    // case that found it.
    var st = _ccReplayTablet();
    try {
        var p = _ccActivate('dc-panel-scorecard');
        var cols = '', tds = '', colg = '';
        for (var i = 0; i < 4; i++) {
            cols += '<th>Merchandising</th>'; tds += '<td>92</td>';
            colg += '<col style="width:8.5%">';
        }
        p.innerHTML = '<div class="lv-tbl-scroll">' +
            '<table class="lv-tbl dc-tbl dc-tbl-score"><colgroup>' +
            '<col style="width:16%"><col style="width:15%"><col style="width:16%">' +
            '<col style="width:19%">' + colg + '</colgroup><thead><tr><th>Store</th>' +
            '<th>SPEEKS audit</th><th>PayMore audit</th><th>Total</th>' + cols +
            '</tr></thead><tbody class="dc-grp"><tr>' +
            '<td class="lv-store"><b>BAL</b></td><td>88</td><td>91</td><td>89</td>' +
            tds + '</tr></tbody></table></div>';
        var w = p.querySelector('.lv-tbl-scroll');
        return w.scrollWidth <= w.clientWidth + 1 ||
            'it scrolls sideways by ' + (w.scrollWidth - w.clientWidth) + 'px at ' +
            window.innerWidth + 'px';
    } finally { _ccEndReplay(st); }
});

t('the header rule that makes that fit is in the compact band', function () {
    // .dc-tbl-score th { white-space: normal } has existed since the board was
    // written and never applied: .lv-tbl th sets nowrap at the same specificity,
    // later in the file. The compact copy is what actually lands.
    var rule = null;
    _ccMediaRules().forEach(function (r) {
        if (_ccNorm(r.conditionText) !== _ccNorm(CC_BAND_Q)) return;
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                var sel = _ccNorm(r.cssRules[i].selectorText || '');
                if (sel.indexOf('.dc-tbl-score th') >= 0) rule = r.cssRules[i];
            }
        } catch (e) {}
    });
    if (!rule) return 'no .dc-tbl-score th rule in the compact band';
    if (rule.style.getPropertyValue('white-space') !== 'normal') {
        return 'it does not set white-space: normal, so .lv-tbl th wins and the ' +
               'headers stay on one line';
    }
    return rule.style.getPropertyValue('overflow-wrap') === 'break-word' ||
        'wrapping alone is not enough — a single word wider than a 55px column ' +
        'still spills; overflow-wrap: break-word is what stops it';
});

t('the Store Breakdown board fits without a sideways scroll', function () {
    var st = _ccReplayTablet();
    try {
        var p = _ccActivate('dc-panel-stores');
        var tiles = '';
        for (var s = 0; s < 5; s++) {
            tiles += '<button class="dcc-t"><span>Overland Park</span></button>';
        }
        p.innerHTML = '<div class="dcc"><div class="dcc-body"><div class="dcc-grid">' +
            '<div><div class="dcc-group">Stores</div>' + tiles + '</div>' +
            '<div><div class="dcc-head"><div class="dcc-titles">' +
            '<span class="dcc-eyebrow">Store</span>' +
            '<span class="dcc-title">Ballwin</span></div></div></div>' +
            '</div></div></div>';
        return p.scrollWidth <= p.clientWidth + 1 ||
            'it scrolls sideways by ' + (p.scrollWidth - p.clientWidth) + 'px';
    } finally { _ccEndReplay(st); }
});

// ---------------------------------------------------------------------------
// Ethan, 2026-09-19, once the boards were reachable: "make the command center
// header buttons all the same size like they are for desktop", and "make the
// eBay breakdown look a little better for tablet".
// ---------------------------------------------------------------------------

t('the tabs are all one size, as they are on the desktop', function () {
    var st = _ccReplayTablet();
    try {
        var seg = document.querySelector('#dcWidget .cc-seg');
        if (!seg) return 'no district tab strip in the page';
        var w = [];
        seg.querySelectorAll('.toggle-btn').forEach(function (b) {
            if (getComputedStyle(b).display === 'none') return;
            w.push(Math.round(b.getBoundingClientRect().width));
        });
        if (w.length < 4) return 'only ' + w.length + ' visible tabs — the restore is incomplete';
        var spread = Math.max.apply(null, w) - Math.min.apply(null, w);
        // `flex: 1 1 auto` sizes each tab to its label first: "eBay" came out
        // 67px shorter than "Store Breakdown".
        return spread <= 1 ||
            'the tabs differ by ' + spread + 'px ([' + w.join(',') + ']) — the basis ' +
            'is back to auto, so each one is sized by its own label';
    } finally { _ccEndReplay(st); }
});

t('...and the rule that does it is late enough to win', function () {
    // THE TEST ABOVE CANNOT SEE THIS. Replaying a tier's rules under a probe
    // class adds a class to every selector, which breaks specificity ties in
    // favour of whatever is being tested — so a tablet rule that loses to a
    // later compact rule on the real cascade still measures as if it won. It
    // happened: `.cc-seg .toggle-btn` is (0,2,0) in both the tablet tier and the
    // compact segmented-controls block, so this is decided on source order and
    // nothing else. Read the order out of the CSSOM instead of measuring it.
    var tabletAt = -1, compactAt = -1;
    _ccMediaRules().forEach(function (r, i) {
        var cond = _ccNorm(r.conditionText);
        try {
            for (var j = 0; j < r.cssRules.length; j++) {
                var sel = _ccNorm(r.cssRules[j].selectorText || '');
                if (sel.indexOf('.cc-seg .toggle-btn') < 0) continue;
                if (!r.cssRules[j].style.getPropertyValue('flex-basis')) continue;
                if (cond === _ccNorm(CC_TABLET_Q)) tabletAt = i;
                else if (cond === _ccNorm(CC_BAND_Q)) compactAt = i;
            }
        } catch (e) {}
    });
    if (tabletAt < 0) return 'no tablet-tier .cc-seg .toggle-btn flex rule at all';
    if (compactAt < 0) return true;          // nothing to lose to
    return tabletAt > compactAt ||
        'the tablet rule (block ' + tabletAt + ') comes BEFORE the compact one ' +
        '(block ' + compactAt + ') and they are the same specificity, so the ' +
        'compact `flex: 1 1 auto` wins and the tabs are sized by their labels';
});

t('...and they still all fit on one row at the narrowest tablet', function () {
    // A zero basis lets a tab shrink below its label, which would trade a ragged
    // strip for a clipped one. 744px is the floor the tier admits.
    var st = _ccReplayTablet();
    try {
        var seg = document.querySelector('#dcWidget .cc-seg');
        var tops = {}, clipped = [];
        seg.querySelectorAll('.toggle-btn').forEach(function (b) {
            if (getComputedStyle(b).display === 'none') return;
            tops[Math.round(b.getBoundingClientRect().top)] = 1;
            if (b.scrollWidth > b.clientWidth + 1) clipped.push(b.textContent.trim());
        });
        if (clipped.length) return 'clipped label(s): ' + clipped.join(', ');
        return Object.keys(tops).length === 1 ||
            'the strip wrapped onto ' + Object.keys(tops).length + ' rows at ' +
            window.innerWidth + 'px';
    } finally { _ccEndReplay(st); }
});

t('every category chip on the eBay board starts at the same edge', function () {
    // "Categories at risk" and its chips are one wrapping flex row, so a chip on
    // the second line began at the cell edge while the first line began after the
    // label — three chips, three different left edges. The label takes a line of
    // its own now, which is also how every other grouped block on the site reads.
    var st = _ccReplayTablet();
    try {
        var p = _ccActivate('dc-panel-ebay');
        p.innerHTML = '<div class="lv-tbl-scroll"><table class="lv-tbl dc-tbl">' +
            '<thead><tr><th>Store</th><th>Tracking</th><th>Defect rate</th>' +
            '<th>Cases closed</th><th>Late shipment</th></tr></thead>' +
            '<tbody class="dc-grp"><tr class="dc-clickable">' +
            '<td class="lv-store"><b>MPL</b></td><td>91.17%</td><td>1.18%</td>' +
            '<td>1.06%</td><td>1.45%</td></tr><tr class="dc-catrow">' +
            '<td colspan="5" class="dc-cats"><div class="dc-catwrap">' +
            '<span class="dc-catlab">Categories at risk</span>' +
            '<span class="dc-cat dc-bad"><b>Active &middot; very high</b>' +
            'Computers/Tablets &amp; Networking, Consumer Electronics</span>' +
            '<span class="dc-cat dc-warn"><b>Projected &middot; very high</b>' +
            'Consumer Electronics</span>' +
            '<span class="dc-cat dc-warn"><b>Projected &middot; high</b>' +
            'Computers/Tablets &amp; Networking</span>' +
            '</div></td></tr></tbody></table></div>';
        var chips = p.querySelectorAll('.dc-cat');
        if (chips.length < 3) return 'the fixture lost its chips';
        // Group the chips by the line they landed on; every line must START at
        // the same x. A second chip further along the same line is fine.
        var lineStart = {};
        chips.forEach(function (c) {
            var r = c.getBoundingClientRect();
            var top = Math.round(r.top);
            var left = Math.round(r.left);
            if (lineStart[top] === undefined || left < lineStart[top]) lineStart[top] = left;
        });
        var edges = {};
        Object.keys(lineStart).forEach(function (k) { edges[lineStart[k]] = 1; });
        var list = Object.keys(edges);
        if (list.length > 1) {
            return 'the chip lines start at ' + list.length + ' different x positions (' +
                   list.join(', ') + ') — the label is back on the first line';
        }
        // ...and the label is above them, not beside them.
        var lab = p.querySelector('.dc-catlab').getBoundingClientRect();
        var first = chips[0].getBoundingClientRect();
        return lab.bottom <= first.top + 1 ||
            'the label still sits on the same line as the first chip';
    } finally { _ccEndReplay(st); }
});

t('the Scorecard keeps its own chip row, which is a different thing', function () {
    // .dc-catwrap is worn by two unrelated blocks: eBay's wrapping severity chips
    // and the Scorecard's nowrap grid of equal section chips. Only the first was
    // asked about, and the second would break if the label took its whole line.
    var st = _ccReplayTablet();
    try {
        var p = _ccActivate('dc-panel-scorecard');
        p.innerHTML = '<div class="lv-tbl-scroll">' +
            '<table class="lv-tbl dc-tbl dc-tbl-score"><tbody class="dc-grp">' +
            '<tr class="dc-catrow"><td class="dc-cats"><div class="dc-catwrap">' +
            '<span class="dc-catlab">SPEEKS Audit points by section</span>' +
            '<span class="dc-cat dc-fix"><span>Merchandising</span><b>18/20</b></span>' +
            '</div></td></tr></tbody></table></div>';
        var wrap = p.querySelector('.dc-catwrap');
        var lab = p.querySelector('.dc-catlab');
        if (getComputedStyle(wrap).flexWrap !== 'nowrap') {
            return 'the Scorecard chip row is wrapping now — the eBay rule reached it';
        }
        return lab.getBoundingClientRect().width < wrap.getBoundingClientRect().width ||
            'the Scorecard label took the whole line, pushing its chip grid below it';
    } finally { _ccEndReplay(st); }
});

// ---------------------------------------------------------------------------
// Ethan, 2026-09-19: "I would get rid of the summary option for tablet. Just
// have it default to live dashboard and it be three buttons if that makes
// sense." Three is the MANAGER board — Live, eBay, Scorecard. A DM and the CEO
// have four, because Store Breakdown is theirs.
// ---------------------------------------------------------------------------

t('a tablet has no summary and no way back to one', function () {
    var _g = _ccNeedsCompact(); if (_g) return _g;
    var st = _ccReplayTablet();
    try {
        var sum = document.getElementById('cc-summary');
        var coll = document.getElementById('cc-collapse');
        coll.style.display = '';          // as _tabSwitch leaves it with a tab open
        var bad = [];
        if (getComputedStyle(sum).display !== 'none') {
            bad.push('the summary strip is showing again');
        }
        if (getComputedStyle(coll).display !== 'none') {
            bad.push('the "Summary" collapse is showing, and it leads to a view ' +
                     'that is not drawn');
        }
        var bar = document.querySelector('#ccWidget .cc-tabbar');
        if (getComputedStyle(bar).display === 'none') bad.push('the tab bar went with it');
        return !bad.length || bad.join('; ');
    } finally { _ccEndReplay(st); }
});

t('a tablet opens on the Live Dashboard', function () {
    var mob = window._isMobileLayout, tab = window._isTabletLayout;
    var w = document.getElementById('ccWidget');
    w.style.setProperty('display', 'block', 'important');
    w.classList.remove('cc-expanded');
    // No flags to reset any more: _openDefaultTab reads the card's own state,
    // because a module flag cannot survive the SPA router replacing .main-content
    // underneath it. Clearing cc-expanded above is the whole setup now -- and it
    // can leave a tab still flagged active, which is the torn state
    // _openDefaultTab repairs rather than mistakes for "already open".
    try {
        window._isMobileLayout = function () { return true; };
        window._isTabletLayout = function () { return true; };
        _reconcileCommandWidgets();
        if (!w.classList.contains('cc-expanded')) {
            return 'the board stayed collapsed, so with the summary cut it shows nothing';
        }
        var live = document.getElementById('cc-panel-live');
        return live.classList.contains('cc-active') ||
            'it expanded but Live did not open';
    } finally { window._isMobileLayout = mob; window._isTabletLayout = tab; }
});

t('tapping the open tab cannot empty the card', function () {
    // The desktop treats a click on the open tab as "collapse to the summary".
    // With the summary cut and the collapse control gone, that same tap would
    // leave a card with no panel, no strip and no control to recover it.
    var mob = window._isMobileLayout;
    var w = document.getElementById('ccWidget');
    try {
        window._isMobileLayout = function () { return true; };
        switchCommandTab('live');                       // open it
        var btn = document.getElementById('cc-tab-live');
        if (!btn.classList.contains('active')) return 'Live would not open at all';
        switchCommandTab('live');                       // ...and tap it again
        if (!w.classList.contains('cc-expanded')) {
            return 'the board collapsed to a summary that is not drawn — a blank card';
        }
        return document.getElementById('cc-panel-live').classList.contains('cc-active') ||
            'the panel closed behind the still-active tab';
    } finally { window._isMobileLayout = mob; }
});

t('...but a desktop keeps the toggle it was designed with', function () {
    var mob = window._isMobileLayout;
    var w = document.getElementById('ccWidget');
    try {
        window._isMobileLayout = function () { return false; };
        // Start from a known state — the tests above leave Live open, and a first
        // click would then be the collapse rather than the open.
        collapseCommand();
        switchCommandTab('live');
        if (!w.classList.contains('cc-expanded')) return 'Live would not open on a desktop';
        switchCommandTab('live');
        return !w.classList.contains('cc-expanded') ||
            'a second click no longer collapses the board back to its summary';
    } finally { window._isMobileLayout = mob; }
});

// ---------------------------------------------------------------------------
// "You can also add the daily breakdown button to the live dashboard."
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// "Can you make the % bubbles the same size."
// ---------------------------------------------------------------------------

t('every audit score pill is the same width', function () {
    var d = document.getElementById('dcWidget');
    d.style.setProperty('display', 'block', 'important');
    d.classList.add('cc-expanded');
    var p = document.getElementById('dc-panel-scorecard');
    p.classList.add('cc-active');
    p.style.setProperty('display', 'block', 'important');
    p.style.setProperty('opacity', '1', 'important');
    // BOTH ELEMENT TYPES, alternating, inside the .dc-au-stack the renderer
    // actually emits. The two pills wear one class and are not one element: the
    // SPEEKS score is a <button> because it opens the breakdown, PayMore's is an
    // inert <span>. A fixture of six buttons measured perfectly equal while the
    // shipped board was 44px against 29.2 (Ethan: "one is fatter and one is
    // skinnier"), and a min-width on a column flex item is the other thing a
    // bare fixture would miss.
    var vals = ['97.6%', '100%', '9.5%', '100.0%', '69.7%', '0%'];
    p.innerHTML = '<div class="lv-tbl-scroll"><table class="lv-tbl dc-tbl dc-tbl-score">' +
        '<tbody class="dc-grp"><tr>' + vals.map(function (v, i) {
            var pill = (i % 2)
                ? '<span class="dc-audit dc-paudit dc-good">' + v + '</span>'
                : '<button type="button" class="dc-audit dc-good">' + v + '</button>';
            return '<td><span class="dc-au-stack">' + pill +
                   '<span class="dc-pa-date">Jul 30</span></span></td>';
        }).join('') + '</tr></tbody></table></div>';
    var w = [], h = [], clipped = [];
    p.querySelectorAll('.dc-audit').forEach(function (b) {
        var r = b.getBoundingClientRect();
        w.push(Math.round(r.width));
        h.push(Math.round(r.height * 10) / 10);
        if (b.scrollWidth > b.clientWidth + 1) clipped.push(b.textContent);
    });
    if (clipped.length) return 'the floor is too low — clipped: ' + clipped.join(', ');
    // A bare `.dc-audit { min-width }` loses to `.main-content * { min-width: 0 }`,
    // which is thousands of lines later and (0,1,0) all the same. It has to be
    // scoped past it.
    var ws = Math.max.apply(null, w) - Math.min.apply(null, w);
    if (ws !== 0) {
        return 'the pills differ in WIDTH by ' + ws + 'px ([' + w.join(',') + ']) — ' +
               'the floor is being flattened by .main-content * { min-width: 0 }';
    }
    // ...and `button { min-height: 44px }`, the tap-target floor, catches the
    // <button> half and not the <span> half.
    var hs = Math.max.apply(null, h) - Math.min.apply(null, h);
    return hs < 0.5 ||
        'the pills differ in HEIGHT by ' + hs + 'px ([' + h.join(',') + ']) — the ' +
        'button is being inflated by the 44px tap-target floor';
});

t('the manager tile strips keep three columns and stay inside the card', function () {
    var st = _ccReplayTablet();
    try {
        var strip = document.getElementById('cc-strip-scorecard');
        // _reconcileCommandWidgets ran in the tests above and may have hidden the
        // board outright (no visible tab for the harness's blank session), which
        // would leave this measuring a zero-width grid that never resolved.
        var w = document.getElementById('ccWidget');
        w.style.setProperty('display', 'block', 'important');
        w.classList.add('cc-expanded');
        // The phone test above left Live open, and the rule two tests up hides the
        // whole strips row while Live is the active tab. Close it first.
        document.getElementById('cc-strip-live').classList.remove('cc-active');
        strip.classList.add('cc-active');
        if (!strip.getBoundingClientRect().width) {
            return 'the strip has no width to measure — the board is still hidden';
        }
        var cs = getComputedStyle(strip);
        var cols = cs.gridTemplateColumns.split(/\s+/).filter(Boolean).length;
        if (cols !== 3) {
            return 'the .s3 strip has ' + cols + ' column(s) ("' +
                   cs.gridTemplateColumns + '", display:' + cs.display + ', ' +
                   Math.round(strip.getBoundingClientRect().width) + 'px wide) — ' +
                   'the restore threw away its grid template';
        }
        return strip.scrollWidth <= strip.clientWidth + 1 ||
            'the strip scrolls sideways by ' + (strip.scrollWidth - strip.clientWidth) + 'px';
    } finally { _ccEndReplay(st); }
});

// ---------------------------------------------------------------------------
// Ethan, 2026-09-19, on the tablet board once it was usable:
//   · "you can actually remove live breakdown from tablet version"
//   · "fix the way the x in the top right looks to match other x buttons"
//   · "fix the MSM live dashboard dropdown to match ... all other dropdowns"
// ---------------------------------------------------------------------------

t('the Daily Breakdown stays off the tablet', function () {
    var _g = _ccNeedsCompact(); if (_g) return _g;
    // Added on 2026-09-19 and taken back off the same day: "too crammed and too
    // much info". The reason for the original cut was the popout SHAPE — eight
    // columns of money over 31 days — and a tablet is not enough wider to change
    // it. This is the guard against restoring it a second time by reflex.
    var st = _ccReplayTablet();
    try {
        var host = document.createElement('div');
        host.className = 'lv-head';
        host.innerHTML = '<span class="lv-sound-host">' +
            '<button type="button" class="bd-open">Daily Breakdown</button></span>';
        document.body.appendChild(host);
        try {
            return getComputedStyle(host.querySelector('.bd-open')).display === 'none' ||
                'the Daily Breakdown button is back on the tablet';
        } finally { host.remove(); }
    } finally { _ccEndReplay(st); }
});

t('...and nothing is left behind propping it up', function () {
    // It needed a lower .bd-tbl floor and wrapping headers to fit. With the
    // button gone those are rules for a surface that cannot be reached, and a
    // dead rule is how the next person concludes the button must still exist.
    var leftovers = [];
    _ccMediaRules().forEach(function (r) {
        if (_ccNorm(r.conditionText) !== _ccNorm(CC_TABLET_Q)) return;
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                var sel = _ccNorm(r.cssRules[i].selectorText || '');
                if (sel.indexOf('.bd-tbl') >= 0 || sel.indexOf('.bd-open') >= 0) {
                    leftovers.push(sel);
                }
            }
        } catch (e) {}
    });
    return !leftovers.length ||
        'the tablet tier still carries: ' + leftovers.join(', ');
});

t('the audit photo lightbox draws the house X', function () {
    var _g = _ccNeedsCompact(); if (_g) return _g;
    // It was a 38px circle of inline style around a TEXT glyph — the exact shape
    // scripts/close-btn-audit exists to catch, because no CSS can make a text
    // glyph match a 15px stroked SVG. Geometry now comes from the same compact
    // rule as every other close control; only the ink differs, because it floats
    // over an arbitrary photograph.
    openAuditPhotoLightbox('data:image/gif;base64,R0lGODlhAQABAAAAACw=');
    var lb = document.getElementById('auditPhotoLightbox');
    try {
        var b = lb.querySelector('.au-lb-close');
        if (!b) {
            return 'no .au-lb-close — the button is unclassed, so no rule and no ' +
                   'audit script can reach it';
        }
        if (!b.querySelector('svg')) {
            return 'it is drawing a text glyph ("' + b.textContent.trim() + '") again';
        }
        var r = b.getBoundingClientRect();
        var cs = getComputedStyle(b);
        // The standard, read off the modal X beside it rather than hard-coded.
        var std = document.querySelector('#auditBreakdownModal .modal-close-btn');
        if (!std) return 'no .modal-close-btn to compare against';
        var scs = getComputedStyle(std);
        if (cs.borderRadius !== scs.borderRadius) {
            return 'radius ' + cs.borderRadius + ' against the standard ' + scs.borderRadius;
        }
        if (Math.abs(r.width - r.height) > 1) {
            return 'it is an oval: ' + Math.round(r.width) + 'x' + Math.round(r.height);
        }
        return (parseFloat(cs.width) === parseFloat(scs.width)) ||
            'it is ' + cs.width + ' against the standard ' + scs.width;
    } finally { lb.style.display = 'none'; }
});

t('the Live Dashboard store picker is the house dropdown', function () {
    var _g = _ccNeedsCompact(); if (_g) return _g;
    // Hand-built (a button and a <ul>), so _ddEnhance — which only ever touches a
    // real <select> — never reached it, and it drifted: a 30px lozenge at a 999px
    // radius with a solid-charcoal chosen row. Compared against a real .dd-btn
    // rendered beside it rather than against hard-coded values, so the two move
    // together or this fails.
    var host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:0;top:0;width:420px;';
    host.innerHTML =
        '<div class="lv-picks"><div class="lv-pickwrap">' +
        '<button type="button" class="lv-pickbtn"><span class="lv-pickcur">MPL</span>' +
        '<svg class="lv-pickchev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>' +
        '</button><ul class="lv-picklist">' +
        '<li><button class="lv-pickopt">Both</button></li>' +
        '<li><button class="lv-pickopt on">MPL</button></li></ul></div></div>' +
        '<div class="dd-host"><button class="dd-btn"><span class="dd-cur">Ref</span>' +
        '<svg class="dd-chev"></svg></button></div>' +
        '<div class="dd-list dd-open"><button class="dd-opt on">Chosen</button></div>';
    document.body.appendChild(host);
    try {
        var g = function (sel, props) {
            var cs = getComputedStyle(host.querySelector(sel));
            return props.map(function (p) { return cs[p]; }).join('|');
        };
        var FACE = ['height', 'minHeight', 'borderRadius', 'fontSize', 'fontWeight',
                    'paddingLeft', 'borderTopColor'];
        var face = g('.lv-pickbtn', FACE), dd = g('.dd-btn', FACE);
        if (face !== dd) {
            return 'the face differs — picker [' + face + '] against .dd-btn [' + dd + ']';
        }
        var ROW = ['backgroundColor', 'color', 'fontWeight', 'borderRadius', 'paddingTop'];
        var row = g('.lv-pickopt.on', ROW), ddrow = g('.dd-opt.on', ROW);
        return row === ddrow ||
            'the chosen row differs — picker [' + row + '] against .dd-opt.on [' +
            ddrow + ']';
    } finally { host.remove(); }
});

t('...and its open list matches the house menu', function () {
    var _g = _ccNeedsCompact(); if (_g) return _g;
    var host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:0;top:0;width:420px;';
    host.innerHTML =
        '<div class="lv-picks"><div class="lv-pickwrap open">' +
        '<button type="button" class="lv-pickbtn">MPL</button>' +
        '<ul class="lv-picklist"><li><button class="lv-pickopt">Both</button></li></ul>' +
        '</div></div><div class="dd-list dd-open"><button class="dd-opt">x</button></div>';
    document.body.appendChild(host);
    try {
        var g = function (sel, props) {
            var cs = getComputedStyle(host.querySelector(sel));
            return props.map(function (p) { return cs[p]; }).join('|');
        };
        var MENU = ['borderRadius', 'paddingTop', 'borderTopColor', 'borderTopWidth'];
        var mine = g('.lv-picklist', MENU), theirs = g('.dd-list', MENU);
        if (mine !== theirs) {
            return 'the menu differs — picker [' + mine + '] against .dd-list [' +
                   theirs + ']';
        }
        // ...and an open face is focused, the same emerald as a .dd-host.open one.
        var open = getComputedStyle(host.querySelector('.lv-pickbtn')).borderTopColor;
        return open === 'rgb(31, 157, 87)' ||
            'an open picker draws a ' + open + ' border, not the emerald focus the ' +
            'rest of the site uses';
    } finally { host.remove(); }
});
