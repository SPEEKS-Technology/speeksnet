// ===========================================================================
// LISTING GOALS / GOALS & INITIATIVES / ACTION ROWS — layout invariants
//
//   powershell -File scripts/browser-check.ps1 goals-layout-check.js \
//              -Html index.html -WindowSize 1500,1100
//
// -Html because every one of these asserts about the real markup — which
// element sits inside which is the whole subject. -WindowSize because three of
// the four are vh-sized or stretch-sized: at Chrome's headless default of
// ~758x482 the Listing Goals modal is too short for its own dead band to
// appear, so the bug these were written for is invisible without a viewport it
// can be wrong at.
//
// Ethan, 2026-09-19, four reports in one message:
//   - "when the max of 4 lines are in the action area, they get scrunched up"
//   - "make today and past weeks button the same size" (desktop + tablet)
//   - "for manager version of goals and initiatives, can you make this look
//      better"
//   - "for MSM listing goals, there is a huge amount of white space at the
//      bottom of the widget ... on both today and past weeks"
// ===========================================================================

// The login gate hides .main-content, and applyRoleBasedUI cuts the side panel
// and the action menu by role. None of that is what is under test, so open it.
(function () {
    var mc = document.querySelector('.main-content');
    if (mc) mc.style.setProperty('display', 'block', 'important');
    var sam = document.getElementById('speeksActionMenu');
    if (sam) sam.style.setProperty('display', 'block', 'important');
    var gp = document.getElementById('goalsSidePanel');
    if (gp) { gp.style.setProperty('display', 'flex', 'important'); gp.classList.add('open'); }
})();

function _glRow(store, i) {
    return '<div class="goals-mgr-row"><div class="goals-mgr-emp">' +
        '<span class="goals-roster-name">Person ' + store + i + '</span>' +
        '<div class="goals-edit-roles"><button class="role-dot">B1</button>' +
        '<button class="role-dot">B2</button><button class="role-dot">L1</button>' +
        '<button class="role-dot">L2</button><button class="role-dot role-off">Off</button>' +
        '</div></div><div class="goal-auto-display">9</div>' +
        '<div class="goals-mgr-week">27</div></div>';
}

// The two-store stack renderManagerGoalsMS writes. Built here rather than called
// because the real one needs the roster and goals endpoints, and the shape is
// what these assertions are about.
function _glMsSection(store, n) {
    var rows = '';
    for (var i = 0; i < n; i++) rows += _glRow(store, i);
    return '<div class="ms-store-section" data-goals-scope="' + store + '">' +
        '<div class="ms-store-head"><span class="ms-store-name">' + store + '</span>' +
        '<span class="ms-store-prog">Goal: 146 Listings</span></div>' + rows +
        '<div class="goals-total-row"><span class="goals-total-lbl">Total</span>' +
        '<span class="goals-total-val target">20</span>' +
        '<span class="goals-total-val actual">142</span></div>' +
        '<div class="goals-levelup"><div class="lu-head"><span class="lu-title">Last 4 weeks</span></div>' +
        '<div class="lu-weeks"><div class="lu-week green"><span class="lu-week-num">102</span></div>' +
        '<div class="lu-week green"><span class="lu-week-num">244</span></div>' +
        '<div class="lu-week green"><span class="lu-week-num">147</span></div>' +
        '<div class="lu-week green"><span class="lu-week-num">149</span></div></div></div></div>';
}

function _glOpenModal(stores, rowsEach) {
    var m = document.getElementById('listingGoalsModal');
    var body = document.getElementById('goals-manager-body');
    var html = '';
    stores.forEach(function (s) { html += _glMsSection(s, rowsEach); });
    body.innerHTML = html;
    // MSM mode hides the single-store footer — _setMSGoalsChrome does this.
    var tr = document.querySelector('#goals-manager-body ~ .goals-total-row');
    if (tr) tr.style.display = stores.length > 1 ? 'none' : '';
    var lu = document.getElementById('goals-levelup');
    if (lu) lu.style.display = stores.length > 1 ? 'none' : '';
    m.classList.add('show');
    m.style.opacity = '1';
    m.style.visibility = 'visible';
    return m;
}

// The band of white between the bottom of the scroller and the bottom of the
// card it sits in. Nothing is drawn there, so every pixel of it is the bug.
function _glDeadBand(m) {
    var card = m.querySelector('.lg-modal-card');
    var kb = m.querySelector('.employee-kpi-body');
    return Math.round(card.getBoundingClientRect().bottom - kb.getBoundingClientRect().bottom);
}

// ---------------------------------------------------------------------------
// 1. Listing Goals: no dead white under the roster
// ---------------------------------------------------------------------------

t('the roster scroller reaches the bottom of its card (Today)', function () {
    var m = _glOpenModal(['BAL', 'MPL'], 4);
    var dead = _glDeadBand(m);
    // It was ~40px here and grew with the screen: the scroller stopped at a flat
    // 62vh inside a modal that is 84vh.
    return dead <= 2 ||
        dead + 'px of white below the roster (the 62vh cap on .employee-kpi-body ' +
        'is back, or the card stopped being the thing that sizes it)';
});

t('...and with the banner gone in Past weeks, where it was worst', function () {
    var m = document.getElementById('listingGoalsModal');
    lgpwSetView(true);
    document.getElementById('goals-pane-past').innerHTML =
        '<div class="lgpw-store"><div class="lgpw-store-name">BAL</div>' +
        '<div class="lgpw-sum"><span class="lgpw-sum-k">Listed</span>' +
        '<div class="lgpw-track"><i style="width:80%"></i></div>' +
        '<span class="lgpw-pct good">80%</span></div></div>';
    var hdr = m.querySelector('.district-kpi-header');
    if (getComputedStyle(hdr).display !== 'none') {
        return 'Past weeks is showing the Today banner — the :has() rule that ' +
               'hides it has gone, so this measures the wrong thing';
    }
    // Past weeks drops the green banner, so the same cap left ~110px here: every
    // pixel the banner used to occupy became white as well.
    var dead = _glDeadBand(m);
    lgpwSetView(false);
    return dead <= 2 || dead + 'px of white below the Past weeks grid';
});

t('a long roster still scrolls rather than pushing the modal open', function () {
    var m = _glOpenModal(['BAL', 'MPL'], 9);
    var kb = m.querySelector('.employee-kpi-body');
    if (kb.scrollHeight <= kb.clientHeight + 2) {
        return 'the roster is not scrolling at all — min-height: 0 is missing, so ' +
               'the flex item cannot shrink below its content';
    }
    // 84vh of the viewport, allowing for the shell's own transform.
    var cap = window.innerHeight * 0.85;
    return m.getBoundingClientRect().height <= cap ||
        'the modal is ' + Math.round(m.getBoundingClientRect().height) +
        'px tall against a ' + Math.round(cap) + 'px ceiling';
});

t('a short roster gets a short modal, not an 84vh slab', function () {
    // The other half of the same complaint: three people on a tall display drew
    // the same full-height modal and padded the difference with white.
    var m = _glOpenModal(['OVL'], 2);
    var h = m.getBoundingClientRect().height;
    var full = window.innerHeight * 0.84;
    return h < full - 40 ||
        'a two-person roster still draws ' + Math.round(h) + 'px (84vh is ' +
        Math.round(full) + 'px) — #listingGoalsModal lost its height: auto';
});

t('height:auto does not reach the phone sheet', function () {
    // #listingGoalsModal { height: auto } is an ID rule and outranks the shell's
    // 84vh. On a phone the modal is a bottom sheet pinned at 92dvh, and it stays
    // one only because that rule is !important — an id would otherwise beat it
    // and the sheet would shrink to its content halfway up the screen.
    var found = null;
    Array.prototype.forEach.call(document.styleSheets, function (ss) {
        var rules; try { rules = ss.cssRules; } catch (e) { return; }
        Array.prototype.forEach.call(rules || [], function (r) {
            if (r.type !== CSSRule.MEDIA_RULE) return;
            if (r.conditionText.replace(/\s+/g, ' ') !== '(max-width: 640px)') return;
            Array.prototype.forEach.call(r.cssRules, function (k) {
                if ((k.selectorText || '') === '.modal-menu' &&
                    k.style.getPropertyValue('height')) found = k;
            });
        });
    });
    if (!found) return 'the phone bottom-sheet rule for .modal-menu is gone';
    return found.style.getPropertyPriority('height') === 'important' ||
        'the sheet height is not !important, so #listingGoalsModal { height: auto } ' +
        'now wins on the phone too';
});

// ---------------------------------------------------------------------------
// 2. Today / Past weeks are one size
// ---------------------------------------------------------------------------

t('Today and Past weeks are the same width', function () {
    var a = document.getElementById('lgpw-v-today');
    var b = document.getElementById('lgpw-v-past');
    if (!a || !b) return 'one of the view buttons is missing';
    var wa = a.getBoundingClientRect().width, wb = b.getBoundingClientRect().width;
    return Math.abs(wa - wb) < 1 ||
        'Today is ' + Math.round(wa) + 'px and Past weeks ' + Math.round(wb) + 'px';
});

t('...sized to the wider label, not to a hand-set number', function () {
    // A min-width would pass the test above and break the moment either button
    // is relabelled. The equal-track grid re-measures itself.
    var seg = document.querySelector('.lgpw-seg');
    var cs = getComputedStyle(seg);
    if (cs.display.indexOf('grid') < 0) {
        return 'the segmented control is display:' + cs.display +
               ' — equal widths are coming from somewhere else';
    }
    var was = document.getElementById('lgpw-v-past').textContent;
    document.getElementById('lgpw-v-past').textContent = 'Past several weeks';
    var wa = document.getElementById('lgpw-v-today').getBoundingClientRect().width;
    var wb = document.getElementById('lgpw-v-past').getBoundingClientRect().width;
    document.getElementById('lgpw-v-past').textContent = was;
    return Math.abs(wa - wb) < 1 ||
        'after a relabel Today is ' + Math.round(wa) + ' and Past ' + Math.round(wb);
});

// ---------------------------------------------------------------------------
// 3. Goals & Initiatives: a goal is readable where it is written
// ---------------------------------------------------------------------------

t('a goal in the panel is not cut off mid-sentence', function () {
    var list = document.getElementById('giGoalsList');
    if (!list) return 'no #giGoalsList in the page';
    list.innerHTML =
        '<div class="mgb-goal-item"><span class="mgb-goal-title">House Keeping! (MANAGERS)</span>' +
        '<span class="mgb-goal-desc">Finishing off the remaining loose ends of inventory ' +
        '(District office items, "Low Priority" items, doing a full sweep of the back ' +
        'room and getting every last device either listed or recycled.)</span></div>';
    var desc = list.querySelector('.mgb-goal-desc');
    var title = list.querySelector('.mgb-goal-title');
    if (desc.scrollHeight > desc.clientHeight + 1) {
        return 'the description is still clamped (' + desc.clientHeight + 'px shown of ' +
               desc.scrollHeight + 'px) — the panel scrolls, so there is no height to protect';
    }
    return title.scrollWidth <= title.clientWidth + 1 ||
        'the title is still nowrap + ellipsis, so a long goal name is cut mid-word';
});

t('the dashboard banner keeps its clamp', function () {
    // The panel is the exception, not a redesign of every .mgb-goal-item: the
    // Monthly Goals banner is a fixed-height widget and still needs two lines.
    var host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;top:0;width:300px;';
    host.innerHTML = '<div class="mgb-goal-item"><span class="mgb-goal-desc">' +
        'One two three four five six seven eight nine ten eleven twelve thirteen ' +
        'fourteen fifteen sixteen seventeen eighteen nineteen twenty.</span></div>';
    document.body.appendChild(host);
    try {
        var d = host.querySelector('.mgb-goal-desc');
        return d.scrollHeight > d.clientHeight + 1 ||
            'the 2-line clamp has been dropped globally, not just inside the panel';
    } finally { host.remove(); }
});

t('the hover tooltip only fires on a card that is actually cutting text', function () {
    // It exists to recover a clamp. Over an uncut card it repeats what is
    // already on screen and covers the card it came from.
    var list = document.getElementById('giGoalsList');
    var item = list.querySelector('.mgb-goal-item');
    // The tooltip has no id — speeks.js creates it and appends it to <body>.
    var tip = document.querySelector('body > .speeks-tooltip');
    if (!tip) return 'no .speeks-tooltip on the body';
    tip.classList.remove('show');
    item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 }));
    return !tip.classList.contains('show') ||
        'the tooltip opened over a card whose text is fully visible';
});

t('goals carry the accent that tells them apart from initiatives', function () {
    var goal = document.querySelector('#giGoalsList .mgb-goal-item');
    var w = parseFloat(getComputedStyle(goal).borderLeftWidth);
    if (!(w >= 3)) return 'the goal card has a ' + w + 'px left edge — the sage accent is gone';
    var ini = document.getElementById('giInitiativesList');
    ini.innerHTML = '<div class="cpb-project-item"><div class="cpb-item-title-row">' +
        '<span class="mgb-goal-title">Kiosk pilot</span>' +
        '<span class="si-status-badge si-status-badge--upcoming">Upcoming</span></div></div>';
    var iw = parseFloat(getComputedStyle(ini.querySelector('.cpb-project-item')).borderLeftWidth);
    return iw < 3 ||
        'initiatives took the sage accent too — it would sit beside an amber ' +
        '"Upcoming" badge and say two different things about the same card';
});

// ---------------------------------------------------------------------------
// 4. Four action rows keep their own proportions
// ---------------------------------------------------------------------------

function _glRailRows() {
    var rail = document.querySelector('.speeks-action-menu .sam-rail');
    var shown = [];
    Array.prototype.slice.call(rail.querySelectorAll('.sam-mini')).forEach(function (el, i) {
        if (i < 4) { el.style.setProperty('display', 'flex', 'important'); shown.push(el); }
        else el.style.setProperty('display', 'none', 'important');
    });
    return { rail: rail, shown: shown };
}
function _glHeights(shown) {
    return shown.map(function (e) { return Math.round(e.getBoundingClientRect().height); });
}

t('a full set of four rows shares the slack without being levelled', function () {
    var g = _glRailRows();
    if (g.shown.length < 4) return 'fewer than four .sam-mini rows in the page';
    g.rail.classList.remove('sam-rail-fill');
    var natural = _glHeights(g.shown);
    var spread = Math.max.apply(null, natural) - Math.min.apply(null, natural);
    if (spread < 5) return 'the four rows are already the same height, so this proves nothing';
    g.rail.style.height = '460px';           // a rail with room to fill
    g.rail.classList.add('sam-rail-fill');
    var filled = _glHeights(g.shown);
    g.rail.style.height = '';
    var fSpread = Math.max.apply(null, filled) - Math.min.apply(null, filled);
    // A zero flex-basis gave every row the identical height whatever it held, so
    // a row carrying a progress bar got the same box as one carrying a line of
    // text. Each row should grow by the same amount, keeping its own shape.
    return Math.abs(fSpread - spread) <= 2 ||
        'the rows were levelled to within ' + fSpread + 'px (natural spread is ' +
        spread + 'px) — flex-basis is back to 0';
});

t('no row is ever taken below the height of what it holds', function () {
    var g = _glRailRows();
    g.rail.classList.remove('sam-rail-fill');
    var natural = _glHeights(g.shown);
    g.rail.classList.add('sam-rail-fill');
    g.rail.style.height = '140px';           // far less than the rows need
    var squeezed = _glHeights(g.shown);
    g.rail.style.height = '';
    var bad = squeezed.filter(function (v, i) { return v < natural[i] - 1; });
    return !bad.length ||
        bad.length + ' of 4 rows were crushed below their content ([' +
        squeezed.join(',') + '] against [' + natural.join(',') + '])';
});

t('the card cannot be shrunk to nothing behind its own overflow:hidden', function () {
    var g = _glRailRows();
    var card = g.rail.querySelector('.sam-card');
    if (getComputedStyle(card).overflow !== 'hidden') return true;  // guard not needed
    g.rail.classList.add('sam-rail-fill');
    var min = getComputedStyle(card).minHeight;
    return (min === 'min-content' || parseFloat(min) > 0) ||
        'the card has min-height:' + min + ' and overflow:hidden, so a short rail ' +
        'would clip the bottom row away rather than overflow';
});
