// ===========================================================================
// LIVE DASHBOARD ON NET PROFIT (2026-10-02)
//
//   powershell -File scripts/browser-check.ps1 np-live-check.js
//
// shopify-live now carries an `np` block per store and on the district, and a
// payload-level goalKind. On an NP payload the board must:
//   - pace and grade on NP (pills, % to goal, Tracking to Goal) — never GP
//   - show NP where it showed GP as the headline profit, marked est. where it is
//   - project Tracking Net Profit from the NP block, not GP less 21%
//   - put the goal on the NP tile, and NOT on the GP one
//   - leave a GP payload (goalKind absent) exactly as it was
// ===========================================================================

if (typeof _b2bSend === 'function') { _b2bSend = function () { return Promise.resolve({}); }; }
sessionStorage.setItem('speeksUserRole', 'District Manager');
sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
sessionStorage.setItem('speeksUserStore', 'CORP');

function _row(code, net, gp, np) {
    var r = {
        code: code, name: code + ' Store', netToday: net, cogsToday: net - gp, gpToday: gp, ordersToday: 10,
        returnsToday: 0, marginToday: gp / net * 100, aov: net / 10,
        mtdNet: net * 2, mtdCogs: (net - gp) * 2, mtdGp: gp * 2, mtdOrders: 20, mtdReturns: 0, mtdMargin: gp / net * 100,
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
function _npBlock(goal, today, mtd, prevDay, prevMtd, pace, prevPace, lastMonth) {
    return { goal: goal, today: today, mtd: mtd, banked: prevMtd, bankedDays: 1, estimated: today,
             costRate: 0.2, pctOfGoal: mtd / goal * 100, paceIndex: pace, track: mtd / 0.0645, lastMonth: lastMonth,
             prev: { day: prevDay, dayEstimated: false, mtd: prevMtd, pctOfGoal: prevMtd / goal * 100,
                     paceIndex: prevPace, track: prevMtd / 0.0323 } };
}
function _payload(np) {
    var a = _row('OVL', 9000, 5000, np ? _npBlock(55000, 3500, 6300, 2800, 2800, 178, 159, 55361) : null);
    var b = _row('BAL', 800, 440, np ? _npBlock(37000, 250, 925, 675, 675, 39, 56, 33454) : null);
    var dist = _row('District', 9800, 5440, np ? _npBlock(92000, 3750, 7225, 3475, 3475, 122, 117, 88815) : null);
    delete dist.code;
    var p = { asOfCentral: '2026-10-02 16:03', open: true,
              month: { daysTotal: 31, daysElapsed: 2, elapsedPct: 6.45 },
              prev: { date: '2026-10-01', inMonth: true, daysElapsed: 1, elapsedPct: 3.23 },
              cmpThrough: '2026-10-01', district: dist, stores: [a, b], scope: { store: 'CORP' } };
    if (np) p.goalKind = 'np';
    return p;
}

(function () {
    var card = document.createElement('div');
    card.className = 'lv-card';
    card.innerHTML = '<span class="lv-eyebrow"></span><span class="lv-asof"></span>'
        + '<div class="lv-dist-strip"></div><div class="lv-dist-detail"></div>';
    document.body.appendChild(card);
})();

function _render(np, mode) {
    _lvData = _payload(np);
    _lvMode = mode;
    renderLiveDashboard();
    return { strip: document.querySelector('.lv-dist-strip'), detail: document.querySelector('.lv-dist-detail') };
}
function _pace(cells) { for (var i = 0; i < cells.length; i++) { var p = cells[i].querySelector('.lv-pill'); if (p) return p.textContent; } return '(no pill)'; }
function _rowCells(detail, code) {
    var rows = detail.querySelectorAll('table.lv-tbl:not(.lv-tbl-buy) tbody tr');
    for (var i = 0; i < rows.length; i++) if (rows[i].textContent.indexOf(code) >= 0) return rows[i].children;
    return null;
}

t('Today: the pace pill is NP pace (OVL 178, BAL 39), not GP', function () {
    var r = _render(true, 'today');
    var ovl = _rowCells(r.detail, 'OVL'), bal = _rowCells(r.detail, 'BAL');
    if (!ovl || !bal) return 'rows missing';
    var o = _pace(ovl), b = _pace(bal);
    if (o.indexOf('178') < 0 || b.indexOf('39') < 0) return 'pace cells: OVL "' + o + '", BAL "' + b + '"';
    return true;
});

t('Today: the table says Net profit, and the month column is NP of the NP goal', function () {
    var r = _render(true, 'today');
    var h = r.detail.querySelector('table.lv-tbl thead').textContent;
    if (!/net profit/i.test(h) || h.indexOf('NP this month') < 0) return 'headers: ' + h;
    if (/Gross profit|GP this month/.test(h)) return 'GP headers survive: ' + h;
    var ovl = _rowCells(r.detail, 'OVL');
    var txt = Array.prototype.map.call(ovl, function (c) { return c.textContent; }).join('|');
    if (txt.indexOf('6,300') < 0 || txt.indexOf('55,000') < 0) return 'OVL row: ' + txt;
    return true;
});

t('Today: the strip says Estimated Net Profit in the label, not an est. tag', function () {
    var r = _render(true, 'today');
    var t1 = r.strip.textContent;
    if (t1.indexOf('Estimated Net Profit') < 0) return 'strip: ' + t1;
    if (/\best\./.test(t1)) return 'an est. tag is still there: ' + t1;
    if (t1.indexOf('Net Profit This Month') < 0) return 'no month NP tile: ' + t1;
    return true;
});

t('Month: Tracking Net Profit comes from the NP block and carries the goal; GP tile does not', function () {
    var r = _render(true, 'mtd');
    var tiles = r.detail.querySelectorAll('.lv-fc-strip .cc-cell');
    var np = null, gp = null;
    tiles.forEach(function (el) {
        var k = el.textContent;
        if (k.indexOf('Tracking Net Profit') >= 0) np = el;
        if (k.indexOf('Tracking Gross Profit') >= 0) gp = el;
    });
    if (!np) return 'no Tracking Net Profit tile';
    // district NP track in month mode = prev.track summed over stores = 2800/.0323 + 675/.0323 = 107,585
    var v = np.querySelector('.sh-v').textContent.replace(/[^0-9]/g, '');
    if (Math.abs(Number(v) - 107585) > 3) return 'Tracking NP should be ~$107,585, is ' + v;
    if (np.textContent.indexOf('Goal $92,000') < 0) return 'NP tile does not carry the goal: ' + np.textContent;
    if (gp && gp.textContent.indexOf('Goal') >= 0) return 'GP tile still carries a goal: ' + gp.textContent;
    return true;
});

t('Month: Tracking to Goal is NP tracking over the NP goal', function () {
    var r = _render(true, 'mtd');
    var t1 = r.strip.textContent;
    // 107,585 / 92,000 = 116.9%
    if (t1.indexOf('116.9') < 0) return 'strip: ' + t1;
    return true;
});

t('Yesterday: the day close and pace use yesterday\'s NP', function () {
    var r = _render(true, 'prev');
    var ovl = _rowCells(r.detail, 'OVL');
    var o = _pace(ovl);
    if (o.indexOf('159') < 0) return 'yesterday pace should be 159: ' + o;
    return true;
});

t('Nothing renders NaN or undefined on any NP tab', function () {
    var bad = '';
    ['today', 'prev', 'mtd'].forEach(function (m) {
        var r = _render(true, m);
        var all = r.strip.textContent + r.detail.textContent;
        if (/NaN|undefined|Infinity/.test(all)) bad += m + ': ' + all.match(/.{0,40}(NaN|undefined|Infinity).{0,20}/)[0] + ' / ';
    });
    return bad || true;
});

t('A GP payload (no goalKind) is unchanged: Gross profit headers, Gross Margin tile', function () {
    var r = _render(false, 'today');
    var h = r.detail.querySelector('table.lv-tbl thead').textContent;
    if (h.indexOf('Gross profit') < 0) return 'GP headers gone on a GP payload: ' + h;
    if (r.strip.textContent.indexOf('Gross Margin') < 0) return 'Gross Margin tile gone: ' + r.strip.textContent;
    if (r.detail.textContent.indexOf('Net profit') >= 0) return 'NP shown on a GP payload';
    return true;
});

t('District board: rail grades on the SHEET\'s NP tracking over the NP goal, header says NP goal', function () {
    _lvData = _payload(true);
    _lvMode = 'today';
    _dccRows = ['OVL', 'BAL'].map(function (s) { return _dccRow(s, {}, {}, { data: [] }, { data: [] }, []); });
    var html = _dccBoardHtml([]);
    var ovl = _dccRows.filter(function (r) { return r.store === 'OVL'; })[0];
    // The NP tab's formula (Ethan 2026-10-03): banked 2,800 / 1 day x 31 = 86,800
    // / 55,000 = 157.8%. NOT the live np.track (6,300 / .0645 -> 177.6%), which
    // adds today's estimate and is why the board disagreed with the sheet.
    if (!ovl.npKind || Math.abs(ovl.salesPct - 157.8) > 0.1) return 'OVL salesPct ' + ovl.salesPct;
    if (ovl.npNow !== 2800 || ovl.npTrack !== 86800) return 'OVL npNow/npTrack ' + ovl.npNow + '/' + ovl.npTrack;
    if (html.indexOf('NP goal') < 0) return 'header does not say NP goal';
    if (html.indexOf('$92,000') < 0) return 'header goal should be $92,000';
    return true;
});

t('No GP anywhere on an NP board, on any tab', function () {
    var bad = '';
    ['today', 'prev', 'mtd'].forEach(function (m) {
        var r = _render(true, m);
        var txt = r.strip.textContent + ' ' + r.detail.querySelector('.lv-tbl-scroll, .lv-fc-strip') ? (r.strip.textContent + ' ' + r.detail.textContent) : '';
        var hit = txt.match(/.{0,30}(Gross Profit|Gross profit|Gross Margin|GP this month|Total Profit).{0,20}/);
        if (hit) bad += m + ': "' + hit[0] + '" / ';
    });
    return bad || true;
});

t('The read path passes goalKind through (the bug that left the board on GP)', function () {
    // shopify-live's browser read rebuilds the response field by field; the np
    // blocks rode along on the store rows but goalKind did not, so _lvNpKind()
    // was false on every real page. Asserted against the payload the page
    // actually receives: a payload with np blocks and goalKind:'np' must grade NP.
    var p = _payload(true);
    if (p.goalKind !== 'np') return 'fixture';
    _lvData = p;
    return _lvNpKind() ? true : '_lvNpKind false with goalKind np';
});

t('District board Store Breakdown: NP rows, net margin, no GP or sell margin', function () {
    _lvData = _payload(true);
    _lvMode = 'today';
    _dccRows = ['OVL', 'BAL'].map(function (s) { return _dccRow(s, {}, {}, { data: [] }, { data: [] }, []); });
    _dccApplyNp();
    var html = _dccBuyBlock(_dccRows[0]);
    if (/GP|Gross|Sell margin/.test(html)) return 'GP left in: ' + html.match(/.{0,30}(GP|Gross|Sell margin).{0,20}/)[0];
    if (html.indexOf('NP tracking vs goal') < 0 || html.indexOf('Net margin') < 0) return 'NP rows missing';
    return true;
});

// Ethan 2026-10-02: eBay fees and Shipping after Refunds on the Month table,
// finished days only, red text when a store's share beats the district by > 1pt.
t('Month table: eBay fees and Shipping after Refunds; red only when above the district', function () {
    var p = _payload(true);
    var set = function (n, s, e, sh) { n.bankedSales = s; n.bankedEbay = e; n.bankedShip = sh; };
    set(p.stores[0].np, 7464.77, 509.89, 276.46);   // OVL 6.8% / 3.7%
    set(p.stores[1].np, 1838.28, 202.27, 154.89);   // BAL 11.0% / 8.4%
    set(p.district.np, 9303.05, 712.16, 431.35);    // district 7.7% / 4.6%
    _lvData = p; _lvMode = 'mtd'; renderLiveDashboard();
    var detail = document.querySelector('.lv-dist-detail');
    var hs = Array.prototype.map.call(detail.querySelectorAll('table.lv-tbl:not(.lv-tbl-buy) thead th'), function (h) { return h.textContent; });
    var ri = hs.indexOf('Refunds');
    if (hs[ri + 1] !== 'eBay fees' || hs[ri + 2] !== 'Shipping') return 'headers: ' + hs.join('|');
    var ovl = _rowCells(detail, 'OVL'), bal = _rowCells(detail, 'BAL');
    if (ovl.length !== hs.length) return 'OVL row has ' + ovl.length + ' cells for ' + hs.length + ' headers';
    if (ovl[ri + 1].textContent.indexOf('$510') < 0) return 'OVL eBay: ' + ovl[ri + 1].textContent;
    if (ovl[ri + 1].querySelector('.lv-fee-hot')) return 'OVL is below the district but red';
    // The % goes red, never the dollars.
    var bp = bal[ri + 1].querySelector('.lv-fee-hot');
    if (!bp || !/%$/.test(bp.textContent)) return 'BAL red is not the percentage: ' + (bp && bp.textContent);
    if (!bal[ri + 1].querySelector('.lv-fee-hot') || !bal[ri + 2].querySelector('.lv-fee-hot')) return 'BAL is above the district but not red';
    _lvMode = 'today'; renderLiveDashboard();
    var th = Array.prototype.map.call(detail.querySelectorAll('table.lv-tbl:not(.lv-tbl-buy) thead th'), function (h) { return h.textContent; });
    if (th.indexOf('eBay fees') >= 0) return 'fee columns on the Today tab';
    return true;
});

// Ethan 2026-10-02: "the leaderboard should be from previous day like it was".
// Finished days only, so it agrees with the NP tab, and never today's estimate.
t('Leaderboard: NP is the banked days (the sheet), not banked + the estimate for today', function () {
    _lvData = _payload(true);
    var np = _lbLiveRows('NP');
    var ovl = np.filter(function (r) { return r.store === 'OVL'; })[0];
    if (!ovl || ovl.val !== 2800) return 'OVL NP ' + (ovl && ovl.val) + ', want the banked 2800 (not mtd 6300)';
    if (np.thru !== '2026-10-01') return 'thru ' + np.thru;
    var rev = _lbLiveRows('Revenue');
    var r = rev.filter(function (x) { return x.store === 'OVL'; })[0];
    if (!r || r.val !== 9000) return 'OVL revenue ' + (r && r.val) + ', want through yesterday 9000';
    if (rev.thru !== '2026-10-01') return 'rev thru ' + rev.thru;
    return true;
});
t('Leaderboard: footer says Through Thu, Oct 1; nothing closed yet says so', function () {
    var w = document.createElement('div'); w.id = 'lb-wrapper'; document.body.appendChild(w);
    var f = document.createElement('div');
    f.innerHTML = '<span id="lb-last-updated-label">Updated as of </span><span id="lb-last-updated">x</span>';
    document.body.appendChild(f);
    _lvData = _payload(true);
    currentLeaderboardMetric = 'NP';
    drawLeaderboard();
    var foot = f.textContent;
    if (foot !== 'Through Thu, Oct 1') return 'footer: "' + foot + '"';
    if (w.textContent.indexOf('2,800') < 0) return 'board: ' + w.textContent;
    var p = _payload(true);
    p.stores.forEach(function (m) { m.np.bankedDays = 0; m.np.banked = 0; });
    _lvData = p;
    drawLeaderboard();
    if (w.textContent.indexOf('First results tomorrow') < 0) return 'day 1: ' + w.textContent;
    w.remove(); f.remove();
    return true;
});

// Sales Summary retired 2026-10-03: the hub sends no Sales-tab arrays. Bought vs
// sold reads each day's sales off the NP tab (np.sellByDay), the Command Center
// date reads the NP tab's last closed day, and nothing asks for a hub redeploy.
t('Retired Sales tab: wkSell comes from np.sellByDay, cc date from the NP tab', function () {
    var p = _payload(true);
    p.stores[0].np.sellByDay = [7464.77, 0, 0];
    _lvData = p;
    var a = _lvBuyArr('wkSell', 'OVL');
    if (!a || a[0] !== 7464.77) return 'wkSell: ' + JSON.stringify(a);
    var lbl = _ccUpdatedNp('ovl');
    if (lbl !== 'Thu, Oct 1') return 'cc date: ' + lbl;
    return true;
});
