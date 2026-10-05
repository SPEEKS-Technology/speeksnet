// ===========================================================================
// NET PROFIT SCREENS ON A PHONE AND A TABLET (2026-10-03)
//
//   powershell -File scripts/browser-check.ps1 np-mobile-layout-check.js -WindowSize 390,844
//   powershell -File scripts/browser-check.ps1 np-mobile-layout-check.js -WindowSize 820,1180
//   powershell -File scripts/browser-check.ps1 np-mobile-layout-check.js -WindowSize 1280,900
//
// Run at all three sizes: the media queries are viewport queries, so one run
// only ever measures one band. Ethan asked that the NP switch be right on mobile
// and tablet too, and the first thing this found was the Month table's new fee
// cells: the tablet/phone rule `.lv-of { display: none }` hid the " · " between
// the dollars and the share, so a cell read "$5106.8%".
//
// Measures, with the real styles.css:
//   - nothing pushes the PAGE sideways (a wide table must scroll in its own box)
//   - no label or figure is clipped by its own box (overflow hidden + too wide)
//   - a fee cell never runs the dollars into the percentage
// over the Live dashboard (Today, Yesterday, Month), its phone cards, and the
// Daily Breakdown popout.
// ===========================================================================

if (typeof _b2bSend === 'function') { _b2bSend = function () { return Promise.resolve({}); }; }
sessionStorage.setItem('speeksUserRole', 'District Manager');
sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
sessionStorage.setItem('speeksUserStore', 'CORP');

// ---- Live payload (same shape as np-live-check.js) -------------------------
function _row(code, net, gp, np) {
    var r = {
        code: code, name: code + ' Store', netToday: net, cogsToday: net - gp, gpToday: gp, ordersToday: 10,
        returnsToday: 850, marginToday: gp / net * 100, aov: net / 10,
        mtdNet: net * 2, mtdCogs: (net - gp) * 2, mtdGp: gp * 2, mtdOrders: 20, mtdReturns: 850, mtdMargin: gp / net * 100,
        goal: 0, pctOfGoal: null, paceIndex: null, lastOrderAt: null, lastOrderAmount: null, recentOrders: [],
        source: 'shopifyql',
        prev: { netToday: net, cogsToday: net - gp, gpToday: gp, ordersToday: 10, returnsToday: 0,
                marginToday: gp / net * 100, aov: net / 10, mtdNet: net, mtdCogs: net - gp, mtdGp: gp,
                mtdOrders: 10, mtdReturns: 0, mtdMargin: gp / net * 100, pctOfGoal: null, paceIndex: null },
        cmp: null,
    };
    if (np) r.np = np;
    return r;
}
function _npBlock(goal, today, mtd, banked, sales, ebay, ship) {
    return { goal: goal, today: today, mtd: mtd, banked: banked, bankedDays: 1, estimated: today,
             costRate: 0.2, pctOfGoal: mtd / goal * 100, paceIndex: 159, track: mtd / 0.0645, lastMonth: 55361,
             bankedSales: sales, bankedEbay: ebay, bankedShip: ship, sellByDay: [sales, 0, 0],
             prev: { day: banked, dayEstimated: false, mtd: banked, pctOfGoal: banked / goal * 100,
                     paceIndex: 159, track: banked / 0.0323 } };
}
function _payload() {
    // Big numbers on purpose: the widest figures a store produces are what clip.
    var codes = [['OVL', 110699.7, 58832.73, 155000, 3925, 6742, 2817, 7464.77, 509.89, 276.46],
                 ['LEE', 3991.89, 2223.3, 43000, 1442, 2175, 733, 2658.72, 217.51, 356.3],
                 ['WSP', 2711.8, 1379.8, 52000, 844, 1654, 810, 2100.82, 177.64, 242.22],
                 ['MPL', 1928.92, 1016.15, 43000, 603, 2608, 2005, 5009.74, 213.4, 253.19],
                 ['BAL', 1949.45, 1071.96, 37000, 611, 1285, 674, 1838.28, 202.27, 154.89]];
    var stores = codes.map(function (c) { return _row(c[0], c[1], c[2], _npBlock(c[3], c[4], c[5], c[6], c[7], c[8], c[9])); });
    var dist = _row('District', 121281.76, 64523.94, _npBlock(330000, 7425, 14464, 7039, 19072.33, 1320.71, 1283.06));
    delete dist.code;
    return { asOfCentral: '2026-10-02 16:03', open: true, goalKind: 'np',
             month: { daysTotal: 31, daysElapsed: 2, elapsedPct: 6.45 },
             prev: { date: '2026-10-01', inMonth: true, daysElapsed: 1, elapsedPct: 3.23 },
             cmpThrough: '2026-10-01', district: dist, stores: stores, scope: { store: 'CORP' } };
}

(function () {
    var card = document.createElement('div');
    card.className = 'lv-card';
    card.id = 'np-ml-live';
    card.innerHTML = '<span class="lv-eyebrow"></span><span class="lv-asof"></span>'
        + '<div class="lv-dist-strip"></div><div class="lv-dist-detail"></div>';
    document.body.appendChild(card);
})();

function _renderLive(mode) {
    _lvData = _payload();
    _lvMode = mode;
    renderLiveDashboard();
    return document.getElementById('np-ml-live');
}

// ---- measuring --------------------------------------------------------------
function _visible(el) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}
function _pageOverflow() {
    var over = document.documentElement.scrollWidth - window.innerWidth;
    return over > 1 ? 'page scrolls sideways by ' + over + 'px at ' + window.innerWidth + 'px' : null;
}
// Clipped = the element hides overflow and its content is wider than it. A
// scrolling box (auto/scroll) is fine — that is how a wide table is meant to fit.
function _clipped(root) {
    var bad = [];
    root.querySelectorAll('*').forEach(function (el) {
        if (!_visible(el)) return;
        var cs = getComputedStyle(el);
        if (!/hidden|clip/.test(cs.overflowX) && cs.textOverflow !== 'ellipsis') return;
        if (el.scrollWidth > el.clientWidth + 1 && el.textContent.trim()) {
            bad.push('"' + el.textContent.trim().replace(/\s+/g, ' ').slice(0, 50) + '" (' + el.className + ') '
                + el.scrollWidth + '>' + el.clientWidth);
        }
    });
    return bad;
}
function _jammed(root) {
    var bad = [];
    root.querySelectorAll('td').forEach(function (td) {
        if (!_visible(td)) return;
        // innerText honours display:none, so a hidden separator shows up here as
        // the two figures touching: "$5106.8%".
        if (/\$[\d,]*\d\.\d+%/.test(td.innerText)) bad.push(td.innerText.replace(/\n/g, '⏎'));
    });
    return bad;
}
function _report(parts) {
    var out = parts.filter(Boolean);
    return out.length ? out.slice(0, 5).join(' ; ') : true;
}

['today', 'prev', 'mtd'].forEach(function (mode) {
    t('Live ' + mode + ' @' + window.innerWidth + 'px: no sideways page, nothing clipped, fees readable', function () {
        var root = _renderLive(mode);
        var clip = _clipped(root);
        var jam = _jammed(root);
        return _report([_pageOverflow(),
            clip.length ? 'clipped: ' + clip.join(' | ') : null,
            jam.length ? 'dollars run into the %: ' + jam.join(' | ') : null]);
    });
});

t('Live month @' + window.innerWidth + 'px: the fee % is on screen and red where it should be', function () {
    var root = _renderLive('mtd');
    var hot = Array.prototype.filter.call(root.querySelectorAll('.lv-fee-pct.lv-fee-hot'), _visible);
    if (!hot.length) {
        // A phone shows cards, not the table; the table being hidden there is fine.
        var tbl = root.querySelector('table.lv-tbl');
        if (tbl && !_visible(tbl)) return true;
        return 'no visible red fee %';
    }
    var c = getComputedStyle(hot[0]).color;
    return /192, 52, 29/.test(c) || 'red % is ' + c;
});

// ---- Daily Breakdown ---------------------------------------------------------
function _npDay(day, sales, gp, ebay, ship, cc, shipFinal) {
    var roy = Math.round(sales * 0.07 * 100) / 100;
    return { day: day, sales: sales, cost: sales - gp, gp: gp, resale: 10000, paid: 5000, buyMargin: 0.5,
             np: Math.round((gp - ebay - (ship || 0) - cc - roy) * 100) / 100,
             ebayFee: ebay, shipping: ship, ccFee: cc, royalty: roy, shipFinal: shipFinal };
}
function _blank(day) { return { day: day, sales: null, cost: null, gp: null, resale: null, paid: null, buyMargin: null }; }
function _pad(days, n) { var out = days.slice(); for (var d = days.length + 1; d <= n; d++) out.push(_blank(d)); return out; }
var BD_OCT = { month: '2026-10', isCurrent: true, today: 4, daysInMonth: 31,
    months: ['2026-10', '2026-09', '2026-08'], source: 'cache', goalKind: 'np', npDays: 1,
    prevYear: { ym: '', stores: {} },
    stores: {
        OVL: { goal: 155000, days: _pad([_npDay(1, 74000, 32000, 5200, 2800, 90, true), _npDay(2, 61000, 31000, 4300, 2500, 80, true),
                                         _npDay(3, 55000, 25000, 3900, null, 75, false)], 31) },
        BAL: { goal: 37000, days: _pad([_npDay(1, 3000, 1500, 300, 120, 15, true), _npDay(2, 3000, 1500, 300, 130, 15, true)], 31) },
    } };

function _openBd(store) {
    if (_bdEl()) _bdEl().remove();
    var el = document.createElement('div');
    el.id = 'bdDaily';
    el.className = 'bd-fs';
    el.innerHTML = '<div class="bd-bar"><span class="bd-title">Daily Breakdown</span><span class="bd-bar-r"><span class="bd-pickers"></span></span></div>'
        + '<div class="bd-card"><div class="bd-body"></div></div>';
    document.body.appendChild(el);
    _bdData = BD_OCT; _bdMonth = '2026-10'; _bdStore = store; _bdErr = '';
    _bdRender();
    return el;
}

['OVL', 'SPEEKS'].forEach(function (store) {
    t('Daily Breakdown ' + store + ' @' + window.innerWidth + 'px: nothing clipped, no sideways page', function () {
        var el = _openBd(store);
        var clip = _clipped(el);
        var res = _report([_pageOverflow(), clip.length ? 'clipped: ' + clip.join(' | ') : null]);
        el.remove();
        return res;
    });
});

t('Daily Breakdown @' + window.innerWidth + 'px: the cost tiles fit side by side or wrap, never overlap', function () {
    var el = _openBd('BAL');
    var tiles = Array.prototype.filter.call(el.querySelectorAll('.bd-strip-cost .bd-tile'), _visible);
    var bad = [];
    for (var i = 0; i < tiles.length; i++) for (var j = i + 1; j < tiles.length; j++) {
        var a = tiles[i].getBoundingClientRect(), b = tiles[j].getBoundingClientRect();
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(i + '/' + j);
    }
    el.remove();
    return bad.length ? 'overlapping tiles ' + bad.join(', ') : (tiles.length === 4 || 'tiles: ' + tiles.length);
});

// Phones and touch tablets get the cards, never the table, so the Month card has
// to carry the two fees itself (2026-10-03).
t('Card @' + window.innerWidth + 'px: Month shows eBay Fees and Shipping, BAL share red, nothing run together', function () {
    var root = _renderLive('mtd');
    if (typeof setLiveCard === 'function') setLiveCard('BAL');
    var cards = Array.prototype.filter.call(root.querySelectorAll('.lvc'), _visible);
    if (!cards.length) return window.innerWidth > 900 ? true : 'no visible card';
    var c = cards[0], txt = c.innerText;
    if (!/eBay Fees/i.test(txt) || !/Shipping/i.test(txt)) return 'card: ' + txt.replace(/\n/g, ' | ');
    if (/\$[\d,]*\d\.\d+%/.test(txt)) return 'run together: ' + txt.replace(/\n/g, ' | ');
    var hot = c.querySelector('.lv-fee-pct.lv-fee-hot');
    if (!hot || !/192, 52, 29/.test(getComputedStyle(hot).color)) return 'BAL share not red';
    var clip = _clipped(c);
    if (clip.length) return 'clipped: ' + clip.join(' | ');
    // Each figure stays on one line in its half of the card.
    var wrapped = Array.prototype.filter.call(c.querySelectorAll('.lvc-v'), function (v) {
        var lh = parseFloat(getComputedStyle(v).lineHeight) || 22;
        return v.getBoundingClientRect().height > lh * 1.6;
    }).map(function (v) { return v.innerText; });
    return wrapped.length ? 'wrapped: ' + wrapped.join(' | ') : true;
});
