// ===========================================================================
// DAILY BREAKDOWN ON NET PROFIT (2026-10-02)
//
//   powershell -File scripts/browser-check.ps1 np-breakdown-check.js
//
// From October 2026 stores are graded on Net Profit. buysell-daily now carries
// each day's NP and its costs (from daily_np, the mirror of the workbook's Net
// Profit tab) and a `goalKind`. The popout must:
//   - headline real NP (never the old flat 21%) on any month that has it
//   - measure the goal chip and goal bar in NP on an 'np' month
//   - show where the GP went (eBay, shipping, card, royalty) as % of sales,
//     and mark a store whose eBay share runs > 1 pt above the district
//   - star a day whose shipping has not landed yet
//   - leave a month before September exactly as it was: Net GP, labelled Est.
// ===========================================================================

if (typeof _b2bSend === 'function') { _b2bSend = function () { return Promise.resolve({}); }; }
sessionStorage.setItem('speeksUserRole', 'District Manager');
sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');

function _npDay(day, sales, gp, ebay, ship, cc, shipFinal) {
    var roy = Math.round(sales * 0.07 * 100) / 100;
    return { day: day, sales: sales, cost: sales - gp, gp: gp, resale: 1000, paid: 500, buyMargin: 0.5,
             np: Math.round((gp - ebay - (ship || 0) - cc - roy) * 100) / 100,
             ebayFee: ebay, shipping: ship, ccFee: cc, royalty: roy, shipFinal: shipFinal };
}
function _blank(day) { return { day: day, sales: null, cost: null, gp: null, resale: null, paid: null, buyMargin: null }; }
function _month(ym, isCurrent, today, kind, stores) {
    return { month: ym, isCurrent: isCurrent, today: today, daysInMonth: ym === '2026-09' ? 30 : 31,
             months: ['2026-10', '2026-09', '2026-08'], source: 'cache', goalKind: kind, npDays: 1,
             prevYear: { ym: '', stores: {} }, stores: stores };
}
function _pad(days, n) { var out = days.slice(); for (var d = days.length + 1; d <= n; d++) out.push(_blank(d)); return out; }

// October: OVL pays 5% to eBay, BAL pays 10% — BAL is the hot one. Day 3's
// shipping has not landed (null, not final). Day 4 has sales but no NP yet.
var OCT = _month('2026-10', true, 4, 'np', {
    OVL: { goal: 30000, days: _pad([_npDay(1, 4000, 2000, 200, 150, 20, true), _npDay(2, 6000, 3000, 300, 250, 30, true),
                                    _npDay(3, 5000, 2500, 250, null, 25, false),
                                    { day: 4, sales: 3000, cost: 1500, gp: 1500, resale: 1000, paid: 500, buyMargin: 0.5 }], 31) },
    BAL: { goal: 20000, days: _pad([_npDay(1, 3000, 1500, 300, 120, 15, true), _npDay(2, 3000, 1500, 300, 130, 15, true),
                                    _npDay(3, 3000, 1500, 300, null, 15, false)], 31) },
});
var SEP = _month('2026-09', false, null, 'gp', {
    OVL: { goal: 81000, days: _pad([_npDay(1, 5000, 2600, 250, 200, 20, true)], 30) },
    BAL: { goal: 60000, days: _pad([_npDay(1, 4000, 2000, 360, 200, 20, true)], 30) },
});
var AUG = _month('2026-08', false, null, 'gp', {
    OVL: { goal: 77000, days: _pad([{ day: 1, sales: 10000, cost: 5000, gp: 5000, resale: 1000, paid: 500, buyMargin: 0.5 }], 31) },
});
AUG.npDays = 0;

function _openWith(payload, store) {
    if (_bdEl()) _bdEl().remove();
    var el = document.createElement('div');
    el.id = 'bdDaily';
    el.innerHTML = '<div class="bd-pickers"></div><div class="bd-body"></div>';
    document.body.appendChild(el);
    Object.keys(_bdCache).forEach(function (k) { delete _bdCache[k]; });
    _bdCache['2026-09'] = SEP;
    _bdData = payload; _bdMonth = payload.month; _bdStore = store; _bdErr = '';
    _bdRender();
    return el.querySelector('.bd-body');
}
function _tile(body, label) {
    var tiles = body.querySelectorAll('.bd-tile');
    for (var i = 0; i < tiles.length; i++) {
        var k = tiles[i].querySelector('.sh-k');
        if (k && k.textContent.trim().indexOf(label) === 0) return tiles[i];
    }
    return null;
}

t('October OVL headlines real Net Profit, not GP less 21%', function () {
    var b = _openWith(OCT, 'OVL');
    var tile = _tile(b, 'Net Profit');
    if (!tile) return 'no Net Profit tile';
    // NP over days 1-3: gp 7500 − ebay 750 − ship 400 − cc 75 − royalty 1050 = 5225
    var v = tile.querySelector('.sh-v').textContent;
    var cur = tile.querySelector('.bd-track').textContent;
    if (cur.indexOf('5,225') < 0) return 'Current NP should be $5,225, tile says "' + v + '" / "' + cur + '"';
    if (_tile(b, 'Net GP')) return 'the 21% Net GP tile is still there';
    return true;
});

t('NP projects off its own last day (3), not the selling columns (4)', function () {
    var b = _openWith(OCT, 'OVL');
    var v = _tile(b, 'Net Profit').querySelector('.sh-v').textContent.replace(/[^0-9]/g, '');
    // 5225 / 3 * 31 = 53,991.67
    if (Math.abs(Number(v) - 53992) > 1) return 'projected NP should be ~$53,992, got ' + v;
    return true;
});

t('the goal chip measures NP against the NP goal', function () {
    var b = _openWith(OCT, 'OVL');
    var chip = b.querySelector('.bd-h-goal');
    if (!chip) return 'no goal chip';
    // 53,991.67 / 30,000 = 180.0%
    if (chip.textContent.indexOf('180') < 0) return 'chip should read ~180% of $30,000, reads "' + chip.textContent + '"';
    var bar = b.querySelector('.lv-goal-lbl');
    if (!bar || bar.textContent.indexOf('Net Profit') < 0) return 'goal bar is not labelled Net Profit';
    return true;
});

t('the cost strip shows all four costs as a share of sales', function () {
    var b = _openWith(OCT, 'OVL');
    var strip = b.querySelector('.bd-strip-cost');
    if (!strip) return 'no cost strip';
    var labels = Array.prototype.map.call(strip.querySelectorAll('.sh-k'), function (k) { return k.textContent; }).join('|');
    if (!/eBay Fees/.test(labels) || !/Shipping/.test(labels) || !/Card Fees/.test(labels) || !/Royalty/.test(labels)) return labels;
    // eBay 750 / 15000 = 5.0%
    if (_tile(b, 'eBay Fees').textContent.indexOf('5.0% of sales') < 0) return 'eBay share wrong: ' + _tile(b, 'eBay Fees').textContent;
    return true;
});

t('BAL, paying eBay well above the district, is marked hot; OVL is not', function () {
    var bal = _openWith(OCT, 'BAL');
    if (!_tile(bal, 'eBay Fees').classList.contains('bd-tile-hot')) return 'BAL eBay tile not hot: ' + _tile(bal, 'eBay Fees').textContent;
    if (_tile(bal, 'eBay Fees').textContent.indexOf('District') < 0) return 'no district comparison on BAL';
    var ovl = _openWith(OCT, 'OVL');
    if (_tile(ovl, 'eBay Fees').classList.contains('bd-tile-hot')) return 'OVL eBay tile should not be hot';
    return true;
});

t('the company view has no district line (it IS the district)', function () {
    var b = _openWith(OCT, BD_ALL);
    if (_tile(b, 'eBay Fees').textContent.indexOf('District') >= 0) return 'company view compares itself with itself';
    return true;
});

t('the table carries eBay fees, shipping and NP, and stars day 3', function () {
    var b = _openWith(OCT, 'OVL');
    var heads = Array.prototype.map.call(b.querySelectorAll('.bd-tbl thead tr:last-child th'), function (h) { return h.textContent; });
    if (heads.indexOf('Net profit') < 0 || heads.indexOf('eBay fees') < 0) return 'headers: ' + heads.join('|');
    if (b.querySelectorAll('.bd-tbl sup.bd-pend').length !== 1) return 'expected one starred NP, got ' + b.querySelectorAll('.bd-tbl sup.bd-pend').length;
    // Every body row must have as many cells as the header row has columns.
    var n = heads.length, bad = '';
    b.querySelectorAll('.bd-tbl tbody tr:not(.bd-wkrow)').forEach(function (tr) {
        if (tr.children.length !== n) bad = 'row has ' + tr.children.length + ' cells, header ' + n;
    });
    var wk = b.querySelector('.bd-wkrow');
    var span = 0; wk.querySelectorAll('td').forEach(function (td) { span += Number(td.getAttribute('colspan') || 1); });
    if (span !== n) bad = 'week row spans ' + span + ' of ' + n;
    var foot = b.querySelector('.bd-tbl tfoot tr');
    if (foot.children.length !== n) bad = 'footer has ' + foot.children.length + ' cells, header ' + n;
    return bad || true;
});

t('day 4 (sales, no NP yet) is dashed, never zero', function () {
    var b = _openWith(OCT, 'OVL');
    var rows = b.querySelectorAll('.bd-tbl tbody tr:not(.bd-wkrow)');
    var r4 = rows[3];
    var dashes = r4.querySelectorAll('td.bd-dash').length;
    if (dashes < 3) return 'day 4 should have its three NP cells dashed, has ' + dashes + ' dashes';
    return true;
});

t('a pending-shipping note explains the star', function () {
    var b = _openWith(OCT, 'OVL');
    if (b.textContent.indexOf('not in yet') < 0) return 'no note';
    return true;
});

t('August (no NP tab) is unchanged: Net GP, labelled as an estimate, no NP columns', function () {
    var b = _openWith(AUG, 'OVL');
    var tile = _tile(b, 'Net GP');
    if (!tile) return 'no Net GP tile on August';
    if (tile.textContent.indexOf('Est.') < 0) return 'Net GP not labelled as an estimate: ' + tile.textContent;
    if (b.querySelector('.bd-strip-cost')) return 'cost strip on a month with no NP';
    var heads = Array.prototype.map.call(b.querySelectorAll('.bd-tbl thead tr:last-child th'), function (h) { return h.textContent; });
    if (heads.indexOf('Net profit') >= 0) return 'NP column on August';
    return true;
});

t('September (GP goal, but NP data) shows real NP and keeps its GP goal chip', function () {
    var b = _openWith(SEP, 'OVL');
    if (!_tile(b, 'Net Profit')) return 'no NP tile on September';
    var chip = b.querySelector('.bd-h-goal');
    // GP 2600 of 81,000 → 3.2%
    if (!chip || chip.textContent.indexOf('81,000') < 0) return 'September chip should be against the $81,000 GP goal: ' + (chip && chip.textContent);
    return true;
});

// ---- no GP on an NP month (Ethan 2026-10-02) --------------------------------
t('October: no Gross Profit tile, no GP column, no gross margin column', function () {
    var b = _openWith(OCT, 'OVL');
    if (_tile(b, 'Gross Profit')) return 'Gross Profit tile still on an NP month';
    var heads = Array.prototype.map.call(b.querySelectorAll('.bd-tbl thead tr:last-child th'), function (h) { return h.textContent; });
    if (heads.indexOf('Gross profit') >= 0 || heads.indexOf('Margin') >= 0) return 'headers: ' + heads.join('|');
    if (heads.indexOf('Net margin') < 0) return 'no Net margin column: ' + heads.join('|');
    if (/Gross Profit|Sell Margin/.test(b.querySelector('.bd-strip-top').textContent)) return 'GP in the top strip';
    return true;
});

t('Only eBay fees and shipping go red; the tile goes red text, not a box', function () {
    var b = _openWith(OCT, 'BAL');
    if (!_tile(b, 'eBay Fees').classList.contains('bd-tile-hot')) return 'BAL eBay not hot';
    if (_tile(b, 'Card Fees').classList.contains('bd-tile-hot')) return 'card fees should never be judged';
    var bg = getComputedStyle(_tile(b, 'eBay Fees')).backgroundColor;
    var plain = getComputedStyle(_tile(b, 'Royalty')).backgroundColor;
    if (bg !== plain) return 'hot tile has its own background: ' + bg + ' vs ' + plain;
    return true;
});

t('No eBay Standing block any more', function () {
    OCT.ebay = { BAL: { fees: { ebay_sales: 1, fvf: 1, inad: 1 } } };
    var b = _openWith(OCT, 'BAL');
    return b.querySelector('.bd-eb') ? 'eBay Standing still rendered' : true;
});

// Ethan 2026-10-02: the red is the share of sales, not the dollars; no
// "Final Value & Other" after eBay Fees.
t('Cost strip: eBay Fees has no sub-label, and only the % turns red', function () {
    var b = _openWith(OCT, 'BAL');
    var tile = _tile(b, 'eBay Fees');
    if (tile.querySelector('.bd-k-sub')) return 'sub-label still there: ' + tile.querySelector('.sh-k').textContent;
    var pctC = getComputedStyle(tile.querySelector('.bd-track')).color;
    var usdC = getComputedStyle(tile.querySelector('.sh-v')).color;
    if (pctC === usdC) return 'the % and the dollars are the same colour (' + pctC + ')';
    if (!/192, 52, 29/.test(pctC)) return 'the % is not red: ' + pctC;
    return true;
});

// The month picker's list opened BEHIND the popout (.dd-list 12000 under .bd-fs
// 100002), so picking a month looked broken. The list has to paint over it.
t('Month picker list paints above the Daily Breakdown popout', function () {
    var fs = document.createElement('div'); fs.className = 'bd-fs'; document.body.appendChild(fs);
    var l = document.createElement('div'); l.className = 'dd-list dd-open'; document.body.appendChild(l);
    var zf = parseInt(getComputedStyle(fs).zIndex, 10), zl = parseInt(getComputedStyle(l).zIndex, 10);
    fs.remove(); l.remove();
    if (!isFinite(zf) || !isFinite(zl)) return 'styles not loaded: ' + zf + '/' + zl;
    return zl > zf || ('list z ' + zl + ' is under the popout z ' + zf);
});
