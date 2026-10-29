// QUICKPORTAL DISTRICT checks — the District Command Center as headline cards
// (part A of the DM design, 2026-10-29) and the feed's due dates (same day).
//
//   powershell -File scripts/browser-check.ps1 qp-district-check.js
//
// What these hold, in Ethan's words:
//   · "if it's not going to look good at 33% it can be designed for just 50%" —
//     a card holding Live keeps half a row; the other four may take a third.
//   · the district card is no longer a full row of its own.
//   · every card fits 350px, so a card sharing a tab bar says less (h.compact),
//     and a third of a row says less again (h.narrow).
//   · "the due dates for all applicable notifications for all roles" — the
//     badge and group a deadline card gets from its date (_samDueInfo).
// Heights themselves were measured in the browser (1280 and 1440, every tab,
// every Live mode, split and combined); this file holds the rules behind them.

_b2bSend = function () { return Promise.resolve({}); };
_qpHeadlinesOn = function () { return true; };
var _saved = null;
_qpSaved = function () { return _saved; };

t('the district card is held to half a row, not a full one', function () {
    if (_qpMaxW('district') !== 0.5) return 'district max ' + _qpMaxW('district');
    if (_qpMaxW('district:watch') !== 0.5) return 'a split-out tab max ' + _qpMaxW('district:watch');
    return true;
});

t('a card holding Live keeps half a row; the other tabs may take a third', function () {
    _saved = null;
    if (_qpMinW('district') !== 0.5) return 'original with Live: ' + _qpMinW('district');
    if (_qpMinW('district:live') !== 0.5) return 'Live on its own: ' + _qpMinW('district:live');
    if (_qpMinW('district:live,ebay') !== 0.5) return 'Live combined: ' + _qpMinW('district:live,ebay');
    if (_qpMinW('district:watch') !== 0) return 'Matrix on its own: ' + _qpMinW('district:watch');
    if (_qpMinW('district:stores,ebay') !== 0) return 'Stores + eBay: ' + _qpMinW('district:stores,ebay');
    return true;
});

t('once Live is split out (saved layout), the original may take a third', function () {
    _saved = [{ items: ['district:live', 'feed'] }, { items: ['district', 'actions', 'chart'] }];
    var m = _qpMinW('district');
    _saved = null;
    return m === 0 ? true : 'original after Live left: ' + m;
});

t('Live draws five store boxes, and drops its caption beside a tab bar', function () {
    var stores = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'].map(function (s, i) {
        return { code: s, net: 100 * i, pct: 80 + i, prev: null, month: null };
    });
    var h = { asOf: '9:30 am', net: 1000, orders: 3, pct: 88, goal: 54400, proj: { rev: 266500, net: 48000 }, stores: stores, prev: null, month: null };
    var one = _QP_DHL_BUILD.live(Object.assign({}, h));
    var n = (one.match(/class="qp-hl-box"/g) || []).length;
    if (n !== 5) return n + ' store boxes';
    if (one.indexOf('Today By Store') === -1) return 'no caption on its own';
    if (one.indexOf('Projected Month-End') === -1) return 'no projection on its own';
    var combined = _QP_DHL_BUILD.live(Object.assign({}, h, { compact: true }));
    if (combined.indexOf('Today By Store') !== -1) return 'caption kept beside a tab bar';
    if (combined.indexOf('Projected Month-End') !== -1) return 'projection kept beside a tab bar';
    if (one.indexOf('Yesterday') !== -1) return 'Yesterday offered with no closed-out day';
    return true;
});

t('Matrix ranks the stores worst first and says why', function () {
    _dcWatch = { day: '2026-10-28', flags: [
        { store: 'BAL', metric: 'conversion', state: 'ok' },
        { store: 'LEE', metric: 'margin', state: 'critical', value: 49.9, miss_run: 12 },
        { store: 'LEE', metric: 'conversion', state: 'ok' },
        { store: 'OVL', metric: 'listing', state: 'warn', value: 59, miss_run: 1 },
        { store: 'WSP', metric: 'conversion', state: 'watch', value: 86, miss_run: 3 },
    ] };
    var h = _qpDWatch();
    _dcWatch = null;
    var order = h.rows.map(function (r) { return r.store; }).join(',');
    if (order !== 'LEE,OVL,WSP,BAL') return 'order ' + order;
    if (h.rows[0].text !== 'Buy margin 49.9% · missed 12 days in a row') return 'LEE: ' + h.rows[0].text;
    if (h.rows[1].text !== 'Listing 59% of goal · missed 1 day') return 'OVL: ' + h.rows[1].text;
    if (h.rows[3].text !== 'All three on target') return 'BAL: ' + h.rows[3].text;
    if (h.crit !== 1 || h.warn !== 1 || h.watch !== 1 || h.ok !== 1) return 'counts ' + [h.crit, h.warn, h.watch, h.ok];
    return true;
});

t('a card beside a tab bar puts "Open Full" up by its label; a narrow one shortens it', function () {
    var h = { rows: [{ store: 'MPL', state: 'bad', off: 3, text: 'Tracking 86.41%', cats: ['Computers'] }], danger: 1, risk: 0, clear: 0 };
    var alone = _QP_DHL_BUILD.ebay(Object.assign({}, h));
    if (alone.indexOf('qp-hl-top') !== -1) return 'on its own the link sits in the label line';
    if (alone.indexOf('Open Full eBay') === -1) return 'no link on its own';
    if (alone.indexOf('sh-badge') !== -1) return 'category chips are back (they wrapped to 382px)';
    if (alone.indexOf('1 category failing') === -1) return 'no category count';
    var combined = _QP_DHL_BUILD.ebay(Object.assign({}, h, { compact: true }));
    if (combined.indexOf('qp-hl-top') === -1) return 'combined: link not beside the label';
    var narrow = _QP_DHL_BUILD.ebay(Object.assign({}, h, { compact: true, narrow: true }));
    if (narrow.indexOf('Open Full →') === -1 || narrow.indexOf('Open Full eBay') !== -1) return 'narrow combined link not shortened';
    return true;
});

// EVERY WORD (Ethan, 2026-10-29, on "PayMore audit 98.5%"): widget lines are
// Title Case, small joining words aside; quotes, product titles, eBay-style
// words and anything glued to a number stay as written.
t('widget lines are Title Case, except what has to stay as written', function () {
    var box = document.createElement('div');
    box.innerHTML = '<div class="qp-hl-big">87.3%<small>PayMore audit 98.5% · of 6 in the green</small></div>'
        + '<div class="qp-hl-sub">▲ 4 vs last week · $55.4k so far · due by 8:30am · trade-in push</div>'
        + '<div class="qp-cw-lt">Reply — “did we test the battery?” · eBay listing</div>'
        + '<div class="qp-hl-note">“keep the photos sharp”</div>'
        + '<div class="qp-hl-ot">Apple iPad Air 64GB wi-fi</div>'
        + '<div class="qp-hl-bs">of goal</div>';
    _qpCapLines(box);
    var got = Array.prototype.map.call(box.children, function (e) { return e.textContent; });
    var want = ['87.3%PayMore Audit 98.5% · of 6 in the Green',
        '▲ 4 vs Last Week · $55.4k So Far · Due by 8:30am · Trade-In Push',
        'Reply — “did we test the battery?” · eBay Listing',
        '“keep the photos sharp”',
        'Apple iPad Air 64GB wi-fi',
        'Of Goal'];
    for (var i = 0; i < want.length; i++) if (got[i] !== want[i]) return 'got "' + got[i] + '"';
    return true;
});

t('a deadline card gets its badge and group from its date', function () {
    var today = _kpiCentralToday();
    var day = function (n) { return _b2bAddDays(today, n); };
    var cases = [
        [day(-1), false, 'over', 'Overdue'],
        [today, false, 'today', 'Due Today'],
        [today, true, 'over', 'Overdue'],       // KPIs go overdue at 8:30 on the day
        [day(1), false, 'week', 'Due Tomorrow'],
        [day(6), false, 'week', null],
        [day(7), false, 'later', null],
        ['', false, 'none', ''],
    ];
    for (var i = 0; i < cases.length; i++) {
        var c = cases[i], r = _samDueInfo(c[0], c[1]);
        if (r.group !== c[2]) return (c[0] || 'no date') + ': group ' + r.group;
        if (c[3] !== null && r.badge !== c[3]) return (c[0] || 'no date') + ': badge ' + r.badge;
    }
    if (!/^Due [A-Z][a-z]{2}$/.test(_samDueInfo(day(3)).badge)) return 'three days out: ' + _samDueInfo(day(3)).badge;
    var none = _samDueFields({ kind: 'due', due: 'Due' }, '');
    if (none.dueGroup !== 'none' || none.due !== 'Due') return 'undated card: ' + JSON.stringify(none);
    if (Object.keys(_samDueFields({ kind: '', due: 'Review' }, day(1))).length) return 'a To Do card was given a date';
    return true;
});
