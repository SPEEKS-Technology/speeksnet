// QUICKPORTAL NEW WIDGETS + MINI SHELVES checks (Ethan, 2026-10-29).
//
//   powershell -File scripts/browser-check.ps1 qp-shelf-check.js
//
// What these hold:
//   · a shelf is a ⅓ block whose key is its contents ("shelf:a,b,c"); three
//     slots, a double mini takes two, and a mini is on the page once
//   · every widget sits in one of the drawer's categories
//   · Goal Pace, Google Reviews and Team Production work their numbers the way
//     their cards say (made-up snapshot below — the real one is store-snapshot)
// Heights were measured in the browser for manager, DM and employee.

_b2bSend = function () { return Promise.resolve({}); };
_qpHeadlinesOn = function () { return true; };

t('a shelf is a third of a row, and its key is its contents', function () {
    if (Math.abs(_qpMaxW('shelf:mcash,mdue') - 1 / 3) > 1e-9) return 'shelf max ' + _qpMaxW('shelf:mcash,mdue');
    if (!_qpIsShelfKey('shelf:mcash') || _qpIsShelfKey('claims')) return 'shelf key test';
    var ids = _qpShelfIds('shelf:mcash,mdue,mnews');
    if (ids.join('|') !== 'mcash|mdue|mnews') return 'ids ' + ids;
    if (_qpShelfKey(ids) !== 'shelf:mcash,mdue,mnews') return 'round trip';
    if (_qpWidgetId('shelf:mcash')) return 'a shelf read as a widget';
    return true;
});

t('a shelf holds three rows; a double mini takes two', function () {
    var real = _qpMiniOk;
    try {
        _qpMiniOk = function () { return true; };
        if (_qpShelfUsed(['mcash', 'mdue', 'mnews']) !== 3) return 'three singles';
        if (_qpShelfUsed(['mmix', 'mdue']) !== 3) return 'double + single';
        if (_qpShelfUsed(['mmix']) !== 2) return 'one double';
        if (!QP_MINIS.mmix.double || !QP_MINIS.mcal.double) return 'Customer Mix and Coming Up should be doubles';
        return true;
    } finally { _qpMiniOk = real; }
});

t('every widget is in a drawer category, and every mini can draw', function () {
    var bad = Object.keys(QP_WIDGETS).filter(function (id) { return _QP_LIB_SECTIONS.indexOf(QP_WIDGETS[id].section || 'Other') === -1 || !QP_WIDGETS[id].section; });
    if (bad.length) return 'no category: ' + bad.join(', ');
    var mb = Object.keys(QP_MINIS).filter(function (id) { var m = QP_MINIS[id]; return !m.label || !m.sub || !m.icon || typeof m.draw !== 'function' || ['snap', 'page', 'cal', 'recycle'].indexOf(m.src) === -1; });
    if (mb.length) return 'incomplete minis: ' + mb.join(', ');
    if (QP_MINIS.shoutouts || QP_WIDGETS.shoutouts) return 'Customer Shoutouts was dropped (Ethan)';
    return true;
});

// A made-up snapshot: OVL, three October days and one September day.
var SNAP = {
    today: '2026-10-29', goals: { OVL: 55000 },
    np: [
        { store: 'OVL', date: '2026-10-26', sales: 5000, np: 2000 },
        { store: 'OVL', date: '2026-10-27', sales: 6000, np: 3000 },
        { store: 'OVL', date: '2026-10-28', sales: 4000, np: 1000 },
    ],
    facts: [
        { store: 'OVL', date: '2026-09-27', reviews_today: 2 },
        { store: 'OVL', date: '2026-10-26', reviews_today: 1, five_star_mtd: 3, devices_processed: 30, team_production: [{ name: 'Ann Lee', processed: 20, value: 900, top: true }, { name: 'Bo Ray', processed: 10, value: 300 }] },
        { store: 'OVL', date: '2026-10-27', reviews_today: 3, five_star_mtd: 6, devices_processed: 40, team_production: [{ name: 'Ann Lee', processed: 25, value: 1000, top: true }, { name: 'Bo Ray', processed: 15, value: 500 }] },
        { store: 'OVL', date: '2026-10-28', reviews_today: 2, five_star_mtd: 8, devices_processed: 35, processed_value: 1700, team_production: [{ name: 'Bo Ray', processed: 20, value: 800 }, { name: 'Ann Lee', processed: 15, value: 900, top: true }] },
    ],
};

t('Goal Pace: what is left, over the open days left', function () {
    var p = _qpPaceOf(SNAP, 'OVL');
    if (p.soFar !== 6000) return 'so far ' + p.soFar;
    if (p.avg !== 2000) return 'average ' + p.avg;
    // Oct 29 (Thu) to Oct 31 (Sat): three open days, no Sunday.
    if (p.left !== 3) return 'days left ' + p.left;
    if (Math.round(p.need) !== Math.round((55000 - 6000) / 3)) return 'needed ' + p.need;
    if (p.best.date !== '2026-10-27') return 'best day ' + p.best.date;
    if (p.hit) return 'goal not hit yet';
    return true;
});

t('Google Reviews: this month, tracking and last month to the same day', function () {
    var r = _qpReviewsOf(SNAP, 'OVL');
    if (r.mtd !== 6) return 'month to date ' + r.mtd;
    if (r.stars !== 8) return 'five-star ' + r.stars;
    if (r.prev !== 2) return 'last month so far ' + r.prev;
    // 6 reviews by the 28th of a 31-day month: 6 / 28 * 31 = 6.6 -> 7.
    if (r.track !== 7) return 'tracking ' + r.track;
    return true;
});

t('Team Production: the latest report, most processed first, top producer run', function () {
    var tm = _qpTeamOf(SNAP, 'OVL');
    if (tm.last.date !== '2026-10-28') return 'latest ' + tm.last.date;
    if (tm.team[0].name !== 'Bo Ray') return 'first ' + tm.team[0].name;
    if (tm.total !== 35) return 'total ' + tm.total;
    if (tm.topRun !== 3) return 'top producer run ' + tm.topRun;
    return true;
});
