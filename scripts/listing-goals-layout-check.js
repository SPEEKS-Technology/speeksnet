// Listing Goals LAYOUT checks -- does the new markup fit, at real widths.
//
//   powershell -File scripts/browser-check.ps1 listing-goals-layout-check.js
//
// Separate from listing-goals-check.js on purpose, and for the reason
// b2b-layout-check.js documents: that file asserts about HTML strings, which
// cannot see a row squashed out of usable size or a bar spilling off a phone.
// This one measures the real thing with the real stylesheet loaded.
//
// Two pieces of markup grew in the 2026-09-17 change and both can wrap or clip:
//
//   1. The User Permissions row gained two number boxes and a derived-shift
//      label. It is a nowrap flex row that already carried a name, a PIN, two
//      selects, a notify dot and a delete button -- three more children is the
//      kind of addition that squashes the name field to nothing without anyone
//      noticing until a manager cannot read who they are editing.
//
//   2. Each Last-4-Weeks bar went from one line to three (total, the goal it was
//      judged against, and the efficiency the district sees). There are four of
//      them side by side inside a modal that has to work on a phone.

// A stage in the DOM at a known width, so measurements mean something.
// Same shape as b2b-layout-check.js's, deliberately -- two harnesses that
// measure differently produce two sets of numbers nobody can compare.
function lgStage(width, html, hostClass) {
    var host = document.getElementById('lg-layout-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'lg-layout-host';
        document.body.appendChild(host);
    }
    host.style.cssText = 'width:' + width + 'px;overflow:hidden;';
    host.innerHTML = '<div class="' + (hostClass || '') + '" style="width:100%">' + html + '</div>';
    void host.offsetHeight;
    return host;
}

// Anything wider than the frame that is not inside a deliberately scrollable
// wrapper. A container that scrolls sideways when it was not built to is content
// the operator cannot reach.
function lgOverflowing(host) {
    var bad = [];
    var limit = host.clientWidth;
    host.querySelectorAll('*').forEach(function (el) {
        var style = getComputedStyle(el);
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') return;
        if (el.getBoundingClientRect().width > limit + 1) {
            var parent = el.parentElement, scrollable = false;
            while (parent && parent !== host) {
                var ps = getComputedStyle(parent);
                if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') { scrollable = true; break; }
                parent = parent.parentElement;
            }
            if (!scrollable) bad.push((el.className || el.tagName) + ' @' + Math.round(el.getBoundingClientRect().width) + 'px');
        }
    });
    return bad;
}

// ---------------------------------------------------------------------------
// The User Permissions row
// ---------------------------------------------------------------------------

function lgUserRow(width, user) {
    var host = lgStage(width, '<div id="lg-rows"></div>');
    // Seed the config the row's labels and placeholders read, so the boxes are
    // sized against the real numbers rather than the pre-payload fallbacks.
    ListingGoalsEngine.applyConfig({
        store: 'OVL', goalFactor: 0.75,
        cfg: {
            hours_full_time: 40, hours_part_time: 20, hours_floater: 25,
            days_full_time: 5, days_part_time: 4, days_floater: 5,
            open_days: 6, max_shift_hours: 12
        },
        shifts: {}
    });
    addManageUserRow(user, document.getElementById('lg-rows'));
    void host.offsetHeight;
    return host;
}

var LG_PT = {
    name: 'Kaden Lamothe', pin: '1234', store: 'OVL', role: 'Employee',
    employment_type: 'part_time', can_float: false, weekly_hours: 10, days_per_week: 2
};

t('the permissions row does not push the page sideways at 1440', function () {
    var host = lgUserRow(1440, LG_PT);
    var bad = lgOverflowing(host);
    return bad.length === 0 || 'overflowing at 1440: ' + bad.join(', ');
});

t('the permissions row does not push the page sideways in a narrow modal', function () {
    // The User Permissions modal is not full-bleed; 820 is the realistic floor
    // for it on a laptop with the sidebar open.
    var host = lgUserRow(820, LG_PT);
    var bad = lgOverflowing(host);
    return bad.length === 0 || 'overflowing at 820: ' + bad.join(', ');
});

t('the name field survives the two new boxes', function () {
    // The row is a nowrap flex. The new children are flex: 0 0 -- they do not
    // shrink -- so everything they take comes out of the fields that do, and the
    // name is the one a manager actually reads to know whose row this is.
    var host = lgUserRow(820, LG_PT);
    var name = host.querySelector('.u-name');
    if (!name) return 'the name field is not in the row at all';
    var w = name.getBoundingClientRect().width;
    return w >= 110 || 'the name field squashed to ' + Math.round(w) + 'px at 820 wide';
});

t('the hours and days boxes render at a usable size', function () {
    var host = lgUserRow(820, LG_PT);
    var h = host.querySelector('.u-hours'), d = host.querySelector('.u-days');
    if (!h || !d) return 'the hours/days boxes are missing';
    var hw = h.getBoundingClientRect().width, dw = d.getBoundingClientRect().width;
    // A number input below ~44px cannot show two digits and its spinner.
    if (hw < 44) return 'the hours box rendered at ' + Math.round(hw) + 'px';
    return dw >= 40 || 'the days box rendered at ' + Math.round(dw) + 'px';
});

t('the derived shift is visible, not collapsed to nothing', function () {
    var host = lgUserRow(820, LG_PT);
    var s = host.querySelector('.u-shift');
    if (!s) return 'the shift label is missing';
    var r = s.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return 'the shift label rendered at zero size';
    // It is the number the daily goal is built from; a blank one defeats the
    // point of showing it at all.
    return /\d/.test(s.textContent) || 'the shift label rendered as "' + s.textContent + '"';
});

t('the shift label tracks what is typed', function () {
    var host = lgUserRow(820, LG_PT);
    var h = host.querySelector('.u-hours'), s = host.querySelector('.u-shift');
    h.value = '40';
    host.querySelector('.u-days').value = '5';
    _upShiftSync(h);
    return s.textContent.indexOf('8') === 0 || 'typing 40/5 gave "' + s.textContent + '"';
});

t('a blank row falls back to the type placeholders, not to nothing', function () {
    // The normal state is both boxes empty. The label must still say what the
    // person is being counted as, or an untouched row looks like missing data.
    var host = lgUserRow(820, {
        name: 'New Person', pin: '9999', store: 'OVL', role: 'Employee',
        employment_type: 'full_time', can_float: false
    });
    var s = host.querySelector('.u-shift');
    return s && s.textContent.indexOf('8h') === 0
        || 'a blank full-time row showed "' + (s ? s.textContent : 'nothing') + '"';
});

// ---------------------------------------------------------------------------
// The Last-4-Weeks bars, now three lines deep
// ---------------------------------------------------------------------------

var LGL_WEEKS = [
    { week: '2026-08-23', total: 178, target: 151, targetSource: 'carried', targetSetFor: '2026-08-10', adjusted: 190, efficiency: 94 },
    { week: '2026-08-30', total: 162, target: 151, targetSource: 'carried', targetSetFor: '2026-08-10', adjusted: 176, efficiency: 92 },
    { week: '2026-09-06', total: 190, target: 151, targetSource: 'carried', targetSetFor: '2026-08-10', adjusted: 218, efficiency: 87 },
    { week: '2026-09-13', total: 147, target: 274, targetSource: 'set', targetSetFor: '2026-09-07', adjusted: 302, efficiency: 49 }
];

function lgBars(width, inModal) {
    // The modal rules are id-scoped, so the id has to be on a real ancestor for
    // them to apply -- measuring the compact widget's styling and calling it the
    // modal is exactly the mistake mobile-check.js documents for page redirects.
    //
    // ⚠️ But #listingGoalsModal also carries its OWN box: `width: 1200px;
    // max-width: 95vw`. vw is the BROWSER viewport, which a stage cannot change,
    // so the element arrives ~712px wide however narrow the stage is and every
    // width below that "fails" against the modal's frame rather than against the
    // bars. Pin the box to the stage width instead: what is under test is
    // whether the bars fit the space they are given, and on a 390px phone the
    // real modal is 95vw of 390, not 712.
    var inner = '<div class="goals-levelup">' + levelUpHtml(LGL_WEEKS, 274) + '</div>';
    var html = inModal
        ? '<div id="listingGoalsModal" style="width:100%;max-width:none;min-width:0">' + inner + '</div>'
        : inner;
    return lgStage(width, html);
}

[390, 820, 1440].forEach(function (w) {
    t('the modal bars fit at ' + w + 'px', function () {
        var host = lgBars(w, true);
        var bad = lgOverflowing(host);
        return bad.length === 0 || 'overflowing at ' + w + ': ' + bad.join(', ');
    });
});

t('the compact widget bars fit on a phone', function () {
    var host = lgBars(390, false);
    var bad = lgOverflowing(host);
    return bad.length === 0 || 'overflowing at 390: ' + bad.join(', ');
});

t('all three lines of a bar are actually visible on a phone', function () {
    // The bar had a fixed 28px height for a single number. Three lines in a
    // 28px box clip silently -- no scrollbar, nothing to say the goal and the
    // efficiency are there at all.
    var host = lgBars(390, true);
    var bar = host.querySelector('.lu-week');
    if (!bar) return 'no bars rendered';
    var barBox = bar.getBoundingClientRect();
    var kids = ['.lu-week-num', '.lu-week-carried, .lu-week-goal', '.lu-week-eff'];
    for (var i = 0; i < kids.length; i++) {
        var el = bar.querySelector(kids[i]);
        if (!el) return 'missing ' + kids[i];
        var r = el.getBoundingClientRect();
        if (r.height < 1) return kids[i] + ' rendered at zero height';
        if (r.bottom > barBox.bottom + 1) {
            return kids[i] + ' is clipped -- it ends ' + Math.round(r.bottom - barBox.bottom) + 'px below the bar';
        }
    }
    return true;
});

t('a bar is tall enough to hold three lines', function () {
    var host = lgBars(390, true);
    var bar = host.querySelector('.lu-week');
    var h = bar.getBoundingClientRect().height;
    return h >= 40 || 'a three-line bar rendered only ' + Math.round(h) + 'px tall';
});

t('the four bars stay on one row, not stacked', function () {
    // .lu-weeks is a 4-column grid in the modal. If a bar's new content forces
    // the grid to blow out, the bars wrap and stop reading as four weeks in a
    // line -- which is the entire shape of the thing.
    var host = lgBars(390, true);
    var bars = host.querySelectorAll('.lu-week');
    if (bars.length !== 4) return 'rendered ' + bars.length + ' bars, expected 4';
    var top = Math.round(bars[0].getBoundingClientRect().top);
    for (var i = 1; i < 4; i++) {
        if (Math.abs(Math.round(bars[i].getBoundingClientRect().top) - top) > 2) {
            return 'bar ' + (i + 1) + ' wrapped onto a second row at 390px';
        }
    }
    return true;
});

t('the carried marker does not hide the total', function () {
    // The hatch is a background-image over a tinted fill. If it were painted as
    // a background SHORTHAND it would wipe the tint and take the colour -- the
    // verdict -- with it.
    var host = lgBars(390, true);
    var stale = host.querySelector('.lu-week.lu-week-stale');
    if (!stale) return 'no carried week was marked';
    var bg = getComputedStyle(stale).backgroundColor;
    if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
        return 'the hatch wiped the bar fill -- green/red no longer reads as the verdict';
    }
    var num = stale.querySelector('.lu-week-num');
    return num.getBoundingClientRect().height >= 1 || 'the total is not visible on a carried week';
});
