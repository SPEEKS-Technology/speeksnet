// LISTING GOALS HEADER — do the goal and the date pill sit centred, top to
// bottom, in the green strip?
//
//   powershell -File scripts/browser-check.ps1 listing-goals-header-layout-check.js -Html index.html -WindowSize 1440,900
//
// Needs -Html (the real #listingGoalsModal markup from index.html) and a
// desktop -WindowSize: the phone layout under 900px wraps the header on
// purpose, and the harness's default window is narrower than that.
//
// The ask (Ethan, 2026-09-24) was the goal "centred vertically with the green
// bubble in the header". It was first read as horizontal centring and shipped
// that way — the goal moved to the middle, which was not wanted. The layout is
// goal on the LEFT, date pill on the RIGHT, both centred top-to-bottom in the
// strip. Only a measurement of the rendered header can tell those apart.

function lghHeader() {
    var modal = document.getElementById('listingGoalsModal');
    if (!modal) return null;
    modal.style.cssText = 'display:block !important; position:static !important; width:1200px; visibility:visible; opacity:1;';
    var content = modal.querySelector('.manage-content');
    if (content) content.style.maxHeight = 'none';
    var goal = document.getElementById('goals-store-target');
    var date = document.getElementById('goals-date-display');
    if (goal) goal.textContent = 'Goal: 254 Listings';
    if (date) date.textContent = 'Thursday, Sep 24';
    void modal.offsetHeight;
    return modal.querySelector('.district-kpi-header');
}
function mid(r) { return r.top + r.height / 2; }
// The goal's INK, not its box: a line box carries half-leading above and below
// the glyphs, so a box can be centred while the letters visibly are not. A Range
// over the text gives the glyph rectangle.
function inkRect(el) {
    var rg = document.createRange();
    rg.selectNodeContents(el);
    return rg.getBoundingClientRect();
}

t('the window is desktop-wide (run with -WindowSize 1440,900)', function () {
    return window.innerWidth > 900 || 'window is ' + window.innerWidth + 'px — the phone layout applies; pass -WindowSize';
});

t('the goal stays on the LEFT of the strip', function () {
    var h = lghHeader();
    if (!h) return 'no #listingGoalsModal .district-kpi-header — run with -Html index.html';
    var hb = h.getBoundingClientRect();
    var g = document.getElementById('goals-store-target').getBoundingClientRect();
    return (g.left - hb.left) < 60 || 'goal starts ' + Math.round(g.left - hb.left) + 'px in — it has moved off the left';
});

t('the goal text is centred top-to-bottom in the strip (within 2px)', function () {
    var h = lghHeader();
    if (!h) return 'no header';
    var hb = h.getBoundingClientRect(), ge = document.getElementById('goals-store-target');
    var ink = inkRect(ge), box = ge.getBoundingClientRect();
    var off = mid(ink) - mid(hb);
    var hs = getComputedStyle(h), gs = getComputedStyle(ge);
    return Math.abs(off) <= 2 || 'goal text is ' + Math.round(off) + 'px ' + (off > 0 ? 'below' : 'above') + ' the strip centre'
        + ' [strip ' + Math.round(hb.top) + '–' + Math.round(hb.bottom) + ' pad ' + hs.paddingTop + '/' + hs.paddingBottom
        + ' align ' + hs.alignItems + ' | goal box ' + Math.round(box.top) + '–' + Math.round(box.bottom)
        + ' ink ' + Math.round(ink.top) + '–' + Math.round(ink.bottom) + ' lh ' + gs.lineHeight + ' va ' + gs.verticalAlign
        + ' margin ' + gs.marginTop + '/' + gs.marginBottom + ' pad ' + gs.paddingTop + '/' + gs.paddingBottom + ']';
});

t('the date pill is centred top-to-bottom in the strip (within 2px)', function () {
    var h = lghHeader();
    if (!h) return 'no header';
    var hb = h.getBoundingClientRect();
    var pe = h.querySelector('.goals-title-wrapper'), p = pe.getBoundingClientRect(), ps = getComputedStyle(pe);
    var off = mid(p) - mid(hb);
    return Math.abs(off) <= 2 || 'pill is ' + Math.round(off) + 'px ' + (off > 0 ? 'below' : 'above') + ' the strip centre'
        + ' [pill ' + Math.round(p.top) + '–' + Math.round(p.bottom) + ' margin ' + ps.marginTop + '/' + ps.marginBottom + ']';
});

t('a long roster does not squash the strip', function () {
    // THE ACTUAL BUG (Ethan's screenshot, 2026-09-24): the card is a flex column
    // inside a modal capped at 84vh, and the strip carried min-height: 0, so a
    // tall roster (the new per-day chips, and a Multi-Store Manager's two stores
    // stacked) SHRANK the strip. Its green box got shorter while the goal and
    // pill kept their size and hung out of the bottom — which read as the
    // content sitting low. Measured at the modal's real height, not an
    // unconstrained one, because the unconstrained version cannot fail.
    var modal = document.getElementById('listingGoalsModal');
    if (!modal) return 'no modal — run with -Html index.html';
    modal.style.cssText = 'display:flex !important; visibility:visible; opacity:1;';
    var body = document.getElementById('goals-manager-body');
    var rows = '';
    for (var i = 0; i < 14; i++) {
        rows += '<div class="goals-mgr-row"><div class="goals-mgr-emp"><span class="goals-roster-name">Person ' + i
            + '</span><div class="goals-res-line">' + new Array(7).join('<span class="gr-chip gr-hit"><span class="gr-d">Mon</span><b>9</b>/9</span>')
            + '</div></div><div class="goal-auto-display">19</div><div class="goals-mgr-week">57</div></div>';
    }
    body.innerHTML = rows;
    var goal = document.getElementById('goals-store-target');
    goal.textContent = 'Goal: BAL 153 · MPL 115';
    document.getElementById('goals-date-display').textContent = 'Thursday, Sep 24';
    void modal.offsetHeight;
    var h = modal.querySelector('.district-kpi-header'), hb = h.getBoundingClientRect();
    var p = h.querySelector('.goals-title-wrapper').getBoundingClientRect();
    var g = goal.getBoundingClientRect();
    try {
        if (p.bottom > hb.bottom + 0.5 || g.bottom > hb.bottom + 0.5) {
            return 'strip squashed to ' + Math.round(hb.height) + 'px — content hangs '
                + Math.round(Math.max(p.bottom, g.bottom) - hb.bottom) + 'px out of the bottom (flex-shrink: '
                + getComputedStyle(h).flexShrink + ')';
        }
        var off = mid(p) - mid(hb);
        return Math.abs(off) <= 2 || 'pill ' + Math.round(off) + 'px off centre with a long roster';
    } finally { modal.style.cssText = ''; body.innerHTML = ''; }
});

t('the date pill stays on the right', function () {
    var h = lghHeader();
    if (!h) return 'no header';
    var hb = h.getBoundingClientRect();
    var p = h.querySelector('.goals-title-wrapper').getBoundingClientRect();
    return (hb.right - p.right) < 40 || 'pill is ' + Math.round(hb.right - p.right) + 'px in from the right edge';
});
