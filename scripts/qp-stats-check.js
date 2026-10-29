// STATS & AWARDS widget checks — the three tabs, from made-up page reads.
//
//   powershell -File scripts/browser-check.ps1 qp-stats-check.js
//
// Ethan, 2026-10-25: option A — Champions, Awards and Records as tabs. The
// model reads the page's own data (_champData's boards, awardsCache,
// recordsCache), so these feed it that shape and read the lines it draws.

_b2bSend = function () { return Promise.resolve({}); };
// A Customize page: only those are held to half a row (_qpMaxW, 2026-10-26),
// and this page has no Customize bar to look at.
_qpHeadlinesOn = function () { return true; };
_claimStores = function () { return ['OVL']; };

var D = {
    champ: {
        week: 'Week of Oct 19, 2026',
        lister: [{ name: 'Eli Kushnir', store: 'WSP', listed: 96 }, { name: 'Colin Hart', store: 'OVL', listed: 40 }],
        review: [{ name: 'Rorie Moore', store: 'OVL', reviews: 12 }],
        buyer: [{ name: 'Willie Tolon', store: 'WSP', score: 15700 }],
    },
    awards: [
        { month: 'August 2026', winner1: 'BAL' },
        { month: 'September 2026', winner1: 'OVL', winner2: null, winner3: 'LEE', videoUrl: null },
    ],
    records: [
        { section: 'OVL', label: 'Daily Sell Record', value: '$15,995.81' },
        { section: 'WSP', label: 'Daily Sell Record', value: '$12,654.49' },
        { section: 'OVL', label: 'Monthly Net Profit Record', value: '$55,361' },
        { section: 'BAL', label: 'Monthly Net Profit Record', value: '$60,000' },
        { section: 'OVL', label: 'Monthly Gross Profit Record', value: '$89,486' },
        { section: 'OVL', label: 'Single Day Google Reviews', value: '12', person: 'Rorie Moore' },
        { section: 'Company', label: 'Daily Sell Record', value: '$35,913.59' },
    ],
};
function lines(m) {
    var el = document.createElement('div');
    el.innerHTML = m.lines.join('');
    return Array.from(el.querySelectorAll('.qp-cw-ln')).map(function (l) { return l.textContent.trim(); });
}
var M = function (tab) { return _QP_WSPEC.stats.model(D, tab); };

t('Champions: each board\'s leader, and where this store stands', function () {
    var m = M('champions');
    var got = lines(m).join(' | ');
    if (got !== 'ListerEli K. · WSP96 Items | ReviewsRorie M. · OVL12 Reviews | BuyerWillie T. · WSP157 Score') return got;
    if (m.cap !== 'Week of Oct 19') return 'cap: ' + m.cap;
    return /OVL: Rorie M\. is 1st in Reviews/.test(m.sub) ? true : 'sub: ' + m.sub;
});

t('Awards: the latest month, every award, this store\'s wins', function () {
    var m = M('awards');
    var got = lines(m).join(' | ');
    if (got !== 'OVLBeyond The Benchmark | —Scroll Stopper | LEEBrand Beacon') return got;
    if (m.cap !== 'September 2026') return 'cap: ' + m.cap;
    return /OVL won 1 of 3/.test(m.sub) ? true : 'sub: ' + m.sub;
});

t('Records: this store\'s figures and place, no GP, no person records, whole dollars', function () {
    var m = M('records');
    var got = lines(m).join(' | ');
    if (got !== '1stDaily Sell$15,996 | 2ndMonthly Net Profit$55,361') return got;
    return m.cap === 'OVL Holds 1 of 2 · Place Among 5 Stores' ? true : 'cap: ' + m.cap;
});

t('the widget is in the drawer for everyone, ⅓ or ½, three pieces', function () {
    if (!QP_WIDGETS.stats.avail()) return 'not available';
    // Under "Company" since the drawer went to categories (2026-10-29).
    if (_QP_LIB_SECTIONS.indexOf(QP_WIDGETS.stats.section) === -1) return 'no drawer section';
    if (QP_FAMILIES.stats.pieces.map(function (p) { return p.key; }).join() !== 'champions,awards,records') return 'pieces';
    return _qpMaxW('stats') === 0.5 ? true : 'max ' + _qpMaxW('stats');
});

t('a card link opens that view on the Stats page', function () {
    var saved = null;
    var realSet = sessionStorage.setItem.bind(sessionStorage);
    try { sessionStorage.removeItem('speeksStatsView'); } catch (_) {}
    var m = M('records');
    if (m.link[1] !== "_qpStatsOpen('records')") return 'link: ' + m.link[1];
    var pane = document.createElement('div');
    pane.id = 'pane-records';
    document.body.appendChild(pane);
    ['champions', 'awards', 'records'].forEach(function (v) {
        var p = document.createElement('div'); p.id = 'stats-view-' + v; p.className = 'stats-view'; pane.appendChild(p);
    });
    realSet('speeksStatsView', 'awards');
    _statsOpenSaved();
    saved = sessionStorage.getItem('speeksStatsView');
    var on = document.getElementById('stats-view-awards').classList.contains('active');
    pane.remove();
    if (saved !== null) return 'not forgotten: ' + saved;
    return on ? true : 'awards view not opened';
});
