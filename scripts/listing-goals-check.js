// Listing Goals capacity-model checks. Run with the Chrome runner (no Node):
//
//   powershell -File scripts/browser-check.ps1 listing-goals-check.js
//
// The runner loads speeks.js and provides t(name, fn): return true to pass, or
// a string saying what went wrong. It also parse-checks the whole file first.
//
// These guard the 2026-09-17 fix, which was three faults reported as one
// complaint ("clean up the listing goals stuff"):
//
//   1. The DAILY goal used a flat cfg.hours_per_day = 8 for everybody while the
//      WEEKLY goal used each person's real hours. A floater on 25h/week and a
//      part-timer on 10 both scored 18 on a lister day, exactly like someone on
//      40. Because `Staffed For` on the DM's efficiency table is the SUM of the
//      daily goals, the inflation landed in the denominator of the ratio every
//      store is judged on.
//
//   2. The store's own 4-week bars were scored against the weekly goal while the
//      DM's Result chip was scored against Staffed For. Both were labelled
//      "target", so the same week read green to one role and Below to the other.
//
//   3. A week with no goal set was silently carried forward. OVL ran three weeks
//      on the 151 typed on 10 August and cleared it every time.
//
// Everything here is synchronous state -- no network, no saves. The engine's
// numbers come from applyConfig, which is a pure absorb, so these can drive it
// directly rather than stubbing a fetch.

// ---------------------------------------------------------------------------
// A store payload shaped like the one store-targets actually returns, so these
// checks fail if the engine and the function's response drift apart.
// ---------------------------------------------------------------------------
function lgPayload(over) {
    var p = {
        store: 'OVL',
        goalFactor: 0.75,
        cfg: {
            hours_per_day: 8,
            rate_buyer_1: 0.5, rate_buyer_2: 1.0, rate_lister: 3.0, rate_new_hire: 1.0,
            saturday_factor: 0.5, goal_factor: 0.78, open_days: 6,
            hours_full_time: 40, hours_part_time: 20, hours_floater: 25, new_hire_weeks: 2,
            days_full_time: 5, days_part_time: 4, days_floater: 5, max_shift_hours: 12
        },
        newHires: [],
        // Nick full-time (40/5), Kaden part-time on ten hours over two days
        // (10/2), Zach the floater (25/5). These are the real OVL numbers the
        // report was about.
        shifts: { 'Nick Hettinger': 8, 'Kaden Lamothe': 5, 'Zach Marchesano': 5 }
    };
    for (var k in (over || {})) p[k] = over[k];
    return p;
}

// A Thursday and a Saturday, as the widget passes them (en-US locale strings).
var LG_THU = '9/17/2026';
var LG_SAT = '9/19/2026';

function lgReset() {
    ListingGoalsEngine._shifts = {};
    ListingGoalsEngine._factors = {};
    ListingGoalsEngine._newHires = {};
}

// ---------------------------------------------------------------------------
// 1. The daily goal is built from the PERSON'S day, not a district constant
// ---------------------------------------------------------------------------

t('applyConfig absorbs the per-person shifts', function () {
    lgReset();
    ListingGoalsEngine.applyConfig(lgPayload());
    var s = ListingGoalsEngine._shifts.OVL;
    if (!s) return 'shifts were not absorbed at all';
    return s['Kaden Lamothe'] === 5 || 'Kaden came back as ' + s['Kaden Lamothe'] + ', expected 5';
});

t('a full-timer on a lister seat is unchanged at 18', function () {
    lgReset();
    ListingGoalsEngine.applyConfig(lgPayload());
    // 8h x 3.0 lister x 1.0 weekday x 0.75 OVL factor = 18. This is the number
    // that was ALREADY right; the fix must not move it.
    var g = ListingGoalsEngine.goalFor('L1', LG_THU, { employee: 'Nick Hettinger', store: 'OVL' });
    return g === 18 || 'full-time lister scored ' + g + ', expected 18';
});

t('a ten-hour part-timer no longer scores a full-timer day', function () {
    lgReset();
    ListingGoalsEngine.applyConfig(lgPayload());
    // 5h x 3.0 x 0.75 = 11.25 -> 11. Before the fix this was 18, the same as a
    // full-timer, which is the reported complaint.
    var g = ListingGoalsEngine.goalFor('L2', LG_THU, { employee: 'Kaden Lamothe', store: 'OVL' });
    if (g === 18) return 'part-timer still scores 18 -- the flat hours_per_day is still in play';
    return g === 11 || 'part-time lister scored ' + g + ', expected 11';
});

t('the floater is costed at a five-hour day', function () {
    lgReset();
    ListingGoalsEngine.applyConfig(lgPayload());
    // 25h/week over 5 days is the floater's actual schedule, so 5h x 3.0 x 0.75.
    var g = ListingGoalsEngine.goalFor('L3', LG_THU, { employee: 'Zach Marchesano', store: 'OVL' });
    return g === 11 || 'floater lister scored ' + g + ', expected 11';
});

t('a buyer seat still prices off the same shift', function () {
    lgReset();
    ListingGoalsEngine.applyConfig(lgPayload());
    var full = ListingGoalsEngine.goalFor('B1', LG_THU, { employee: 'Nick Hettinger', store: 'OVL' });
    var part = ListingGoalsEngine.goalFor('B2', LG_THU, { employee: 'Kaden Lamothe', store: 'OVL' });
    // B1: 8 x 0.5 x 0.75 = 3.  B2 on a 5h day: 5 x 1.0 x 0.75 = 3.75 -> 4.
    if (full !== 3) return 'full-time B1 scored ' + full + ', expected 3';
    return part === 4 || 'part-time B2 scored ' + part + ', expected 4';
});

t('Saturday still halves, on the person own day', function () {
    lgReset();
    ListingGoalsEngine.applyConfig(lgPayload());
    var g = ListingGoalsEngine.goalFor('L2', LG_SAT, { employee: 'Kaden Lamothe', store: 'OVL' });
    // 5h x 3.0 x 0.5 Saturday x 0.75 = 5.625 -> 6
    return g === 6 || 'part-timer Saturday scored ' + g + ', expected 6';
});

t('someone the server has never heard of falls back to a full day, not zero', function () {
    lgReset();
    ListingGoalsEngine.applyConfig(lgPayload());
    // Failing toward a full day is deliberate: a goal of 0 for a real person
    // looks like the widget is broken and silently shrinks Staffed For.
    var g = ListingGoalsEngine.goalFor('L1', LG_THU, { employee: 'Nobody At All', store: 'OVL' });
    return g === 18 || 'unknown person scored ' + g + ', expected the 18 of a full day';
});

t('a name that differs by surname still matches its shift', function () {
    lgReset();
    ListingGoalsEngine.applyConfig(lgPayload());
    // listing_goals has no user_id (see the identity note in CLAUDE.md), so a
    // roster name and a saved name can differ. Same loose rule as the rollups.
    var g = ListingGoalsEngine.goalFor('L2', LG_THU, { employee: 'Kaden', store: 'OVL' });
    return g === 11 || 'loose name match scored ' + g + ', expected 11';
});

t('a Multi-Store Manager keeps a full day, so their goal does not move', function () {
    lgReset();
    // The server sends 8 for an MSM: they are stored as part_time because that is
    // how their WEEK is split across two stores (20h at each), not because they
    // work short days. The board bears that out -- Joseph Ortega is marked OFF at
    // one store and given a full seat at the other, in runs of days. Which store
    // varies week to week with what each needs (user, 2026-09-17), which is
    // exactly why a fixed day count is the wrong shape for him.
    //
    // If this ever comes back as 12, the part-time DAY default has leaked onto
    // the part-time WEEK flag again, and BAL and MPL have both silently lost a
    // third of their Staffed For.
    ListingGoalsEngine.applyConfig(lgPayload({ store: 'BAL', shifts: { 'Joseph Ortega': 8 } }));
    var g = ListingGoalsEngine.goalFor('L1', LG_THU, { employee: 'Joseph Ortega', store: 'BAL' });
    return g === 18 || 'the MSM scored ' + g + ' on a lister day, expected an unchanged 18';
});

t('Off carries no goal whatever the shift', function () {
    lgReset();
    ListingGoalsEngine.applyConfig(lgPayload());
    var g = ListingGoalsEngine.goalFor('OFF', LG_THU, { employee: 'Kaden Lamothe', store: 'OVL' });
    return g === 0 || 'Off scored ' + g + ', expected 0';
});

// ---------------------------------------------------------------------------
// Placeholders must not be SAVED. Before the store's own payload lands, the
// engine is running on district defaults -- the wrong factor and a flat day for
// anyone who isn't full-time. OVL has rows reading 19 (x 0.78) beside rows
// reading 18 (x 0.75) inside one week because those got written.
// ---------------------------------------------------------------------------

t('isReady is false until the store own payload lands', function () {
    lgReset();
    if (ListingGoalsEngine.isReady('OVL')) return 'reported ready with nothing absorbed';
    ListingGoalsEngine.applyConfig(lgPayload());
    if (!ListingGoalsEngine.isReady('OVL')) return 'still not ready after applyConfig';
    // Another store's payload must not make this one look ready -- applyConfig
    // merges cfg into one shared object, which is exactly how the factor used to
    // leak between stores.
    return ListingGoalsEngine.isReady('LEE') === false
        || 'LEE reported ready off OVL payload';
});

// ---------------------------------------------------------------------------
// 2. Both readings of a week, on the same bar
// ---------------------------------------------------------------------------

// The four OVL weeks from the report, in the shape the server now returns.
var LG_WEEKS = [
    { week: '2026-08-23', total: 178, target: 151, targetSource: 'carried', targetSetFor: '2026-08-10', adjusted: 190, efficiency: 94 },
    { week: '2026-08-30', total: 162, target: 151, targetSource: 'carried', targetSetFor: '2026-08-10', adjusted: 176, efficiency: 92 },
    { week: '2026-09-06', total: 190, target: 151, targetSource: 'carried', targetSetFor: '2026-08-10', adjusted: 218, efficiency: 87 },
    { week: '2026-09-13', total: 147, target: 274, targetSource: 'set', targetSetFor: '2026-09-07', adjusted: 302, efficiency: 49 }
];

t('a bar shows the efficiency the district sees, not just the total', function () {
    var html = levelUpHtml(LG_WEEKS, 274);
    if (html.indexOf('87%') < 0) return 'the Sep 6 week 87% is missing from the bars';
    return html.indexOf('49%') >= 0 || 'the Sep 13 week 49% is missing from the bars';
});

t('a bar names the goal it was coloured against', function () {
    var html = levelUpHtml(LG_WEEKS, 274);
    return html.indexOf('of 274') >= 0 || 'the goal a week was judged against is not shown';
});

t('a week nobody set a goal for is marked', function () {
    var html = levelUpHtml(LG_WEEKS, 274);
    if (html.indexOf('goal not set') < 0) return 'a carried goal is still indistinguishable from a set one';
    var stale = html.split('lu-week-stale').length - 1;
    // Three of the four weeks were carried; the Sep 13 one was really set.
    return stale === 3 || 'marked ' + stale + ' carried weeks, expected 3';
});

t('a week WITH its own goal is not marked as carried', function () {
    var html = levelUpHtml([LG_WEEKS[3]], 274);
    if (html.indexOf('goal not set') >= 0) return 'a genuinely set goal was marked as carried';
    return html.indexOf('of 274') >= 0 || 'the set goal is not shown';
});

t('green still means beat the goal, red still means missed it', function () {
    var html = levelUpHtml(LG_WEEKS, 274);
    // 178/162/190 all cleared the 151 they were carried against; 147 missed 274.
    var greens = html.split('lu-week green').length - 1;
    var reds = html.split('lu-week red').length - 1;
    if (greens !== 3) return 'painted ' + greens + ' green weeks, expected 3';
    return reds === 1 || 'painted ' + reds + ' red weeks, expected 1';
});

t('a week with no roles set shows a blank, not a 0%', function () {
    // efficiency null means nothing was staffed, so there is no denominator. A
    // printed 0% reads as a verdict on the store instead of as missing data --
    // the same trap _dmxEfficiencyPane already documents for an in-progress week.
    var html = levelUpHtml([{ week: '2026-08-23', total: 0, target: 151, targetSource: 'set', adjusted: 0, efficiency: null }], 151);
    return html.indexOf('lu-week-eff none') >= 0 || 'a week with no roles did not render the blank state';
});

t('history shorter than four weeks still pads to four', function () {
    var html = levelUpHtml(LG_WEEKS.slice(0, 2), 274);
    var empties = html.split('lu-week empty').length - 1;
    return empties === 2 || 'padded with ' + empties + ' empty bars, expected 2';
});

t('plain totals from the Weekly KPI still render', function () {
    // fetchStoreWeeklyHistory returns bare numbers, not objects. That path has no
    // efficiency and no goal source, and must degrade rather than throw.
    var html = levelUpHtml([178, 162, 190, 147], 200);
    if (html.indexOf('178') < 0) return 'a plain-number history did not render its totals';
    return html.indexOf('lu-week-eff none') >= 0
        || 'a plain-number history should show the blank efficiency state';
});

t('the DM four-week chart marks a carried goal too', function () {
    // The two roles have to see the same caveat, or this change has simply moved
    // the disagreement rather than closed it.
    var html = _dmxLevelUp(LG_WEEKS, 274);
    if (html.indexOf('dmx-lu-astk') < 0) return 'the DM chart does not mark a carried goal';
    return html.indexOf('no goal was set for this one') > 0
        || 'the DM chart marks it but does not say what the mark means';
});

// ---------------------------------------------------------------------------
// The User Permissions shift label -- the derived number made visible, so nobody
// has to discover it a week later in the efficiency table.
// ---------------------------------------------------------------------------

t('the shift label is hours over days', function () {
    if (_upShiftLabel(40, 5) !== '8h/day') return '40/5 came back as ' + _upShiftLabel(40, 5);
    if (_upShiftLabel(10, 2) !== '5h/day') return '10/2 came back as ' + _upShiftLabel(10, 2);
    return _upShiftLabel(25, 5) === '5h/day' || '25/5 came back as ' + _upShiftLabel(25, 5);
});

t('the shift label says when the cap has bitten', function () {
    lgReset();
    ListingGoalsEngine.applyConfig(lgPayload());
    // 40 over 2 days is 20h, past max_shift_hours. Showing a plain "12h/day"
    // would look like a rounding error rather than a clamp.
    var s = _upShiftLabel(40, 2);
    return s.indexOf('*') > 0 || 'a capped shift rendered as "' + s + '" with no mark';
});

t('the shift label degrades on a blank box', function () {
    var s = _upShiftLabel('', 5);
    return s === '—' || 'a blank hours box rendered as ' + s;
});
