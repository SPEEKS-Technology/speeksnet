// DISTRICT WATCH POPUP checks — the store drill-down, one store day by day.
//
//   powershell -File scripts/browser-check.ps1 district-watch-popup-check.js
//
// Its own file rather than more of district-watch-check.js: that suite is about
// the board, this one is about the popup behind it, and they fail for different
// reasons.
//
// THE ASSERTION THAT MATTERS MOST is the dollar-weighting one. An average of
// seven daily margin percentages and a dollar-weighted margin are different
// numbers, the wrong one is flattering, and nothing on screen would tell you
// which you were looking at. 0004_buying_margin.sql made the same point about
// buyers and it has been re-learned twice since.

// Seven trading days with deliberately uneven buying, so the two answers cannot
// coincide: six small days at a good margin, then one large buy at a poor one.
var POPUP = {
    day: '2026-09-19',
    config: { conv_target: 85, margin_target: 54.5 },
    flags: [],
    goals: [
        { store: 'OVL', date: '2026-09-11', goal: 40 },
        { store: 'OVL', date: '2026-09-12', goal: 40 },
        { store: 'OVL', date: '2026-09-19', goal: 0 }
    ],
    series: [
        // An 8th, older day that must NOT appear — the popup shows seven.
        { store: 'OVL', date: '2026-09-10', cust_conv_den: 99, cust_conv_num: 99,
          est_value: 1000, total_spent: 100, devices_lost: 0, no_deal_customers: 0,
          devices_processed: 99, processed_value: 999 },
        { store: 'OVL', date: '2026-09-11', cust_conv_den: 10, cust_conv_num: 9,
          est_value: 1000, total_spent: 300, devices_lost: 1, no_deal_customers: 1,
          devices_processed: 20, processed_value: 4000 },
        { store: 'OVL', date: '2026-09-12', cust_conv_den: 10, cust_conv_num: 9,
          est_value: 1000, total_spent: 300, devices_lost: 1, no_deal_customers: 1,
          devices_processed: 20, processed_value: 4000 },
        { store: 'OVL', date: '2026-09-14', cust_conv_den: 10, cust_conv_num: 9,
          est_value: 1000, total_spent: 300, devices_lost: 1, no_deal_customers: 1,
          devices_processed: 20, processed_value: 4000 },
        { store: 'OVL', date: '2026-09-15', cust_conv_den: 10, cust_conv_num: 9,
          est_value: 1000, total_spent: 300, devices_lost: 1, no_deal_customers: 1,
          devices_processed: 20, processed_value: 4000 },
        { store: 'OVL', date: '2026-09-16', cust_conv_den: 10, cust_conv_num: 9,
          est_value: 1000, total_spent: 300, devices_lost: 1, no_deal_customers: 1,
          devices_processed: 20, processed_value: 4000 },
        { store: 'OVL', date: '2026-09-17', cust_conv_den: 10, cust_conv_num: 9,
          est_value: 1000, total_spent: 300, devices_lost: 1, no_deal_customers: 1,
          devices_processed: 20, processed_value: 4000 },
        { store: 'OVL', date: '2026-09-19', cust_conv_den: 10, cust_conv_num: 5,
          est_value: 54000, total_spent: 40000, devices_lost: 5, no_deal_customers: 5,
          devices_processed: 10, processed_value: 2000 }
    ],
    mtd: []
};

function popup(tab) {
    _dcWatch = POPUP;
    _dcwStore = 'OVL';
    _dcwTab = tab;
    return _dcwModalHtml(_dcwStoreDays('OVL'));
}

// --- wiring -----------------------------------------------------------------

t('the Watch rows open the popup instead of swapping tabs underneath the DM', function () {
    _dcWatch = POPUP;
    // Rebuild a board row set so the row markup can be inspected.
    var p = JSON.parse(JSON.stringify(POPUP));
    p.flags = [{ store: 'OVL', metric: 'margin', state: 'warn', value: 33.3, target: 54.5,
                 sample_n: 60000, shortfall: 12700, streak: 1, reason: 'x' }];
    _dcWatch = p;
    var html = _dcWatchHtml();
    if (/_dcDrill\(/.test(html)) return 'a Watch row still calls _dcDrill';
    return /_dcwOpen\('OVL'\)/.test(html) || 'rows are not wired to _dcwOpen';
});

t('_dcDrill survives for the eBay and Scorecard tabs that still use it', function () {
    // Watch changed its own behaviour; it must not have taken the shared
    // drill-down away from the two tabs that still want it.
    return typeof _dcDrill === 'function'
        || '_dcDrill was removed — the eBay and Scorecard rows are now dead';
});

t('the popup helpers are all defined', function () {
    var missing = ['_dcwOpen', 'dcwModalTab', '_dcwModalPaint', '_dcwStoreDays', '_dcwModalHtml']
        .filter(function (n) { return typeof window[n] !== 'function' && typeof eval(n) !== 'function'; });
    return missing.length === 0 || 'missing: ' + missing.join(', ');
});

// --- the window it shows -----------------------------------------------------

t('it shows seven days, and the newest seven', function () {
    _dcWatch = POPUP;
    var rows = _dcwStoreDays('OVL');
    if (rows.length !== 7) return 'expected 7 rows, got ' + rows.length;
    if (rows[0].date !== '2026-09-11') return 'oldest row is ' + rows[0].date + ', expected 2026-09-11';
    return rows[6].date === '2026-09-19' || 'newest row is ' + rows[6].date;
});

t('a store with no recorded days says so rather than drawing an empty table', function () {
    _dcWatch = POPUP; _dcwStore = 'ZZZ'; _dcwTab = 'conversion';
    var html = _dcwModalHtml(_dcwStoreDays('ZZZ'));
    if (/<table/.test(html)) return 'drew a table for a store with no data';
    return /No Day End Reports recorded/.test(html) || 'got: ' + html.slice(0, 140);
});

t('opening it before the board has answered does not throw', function () {
    _dcWatch = null; _dcwStore = 'OVL'; _dcwTab = 'conversion';
    var html = _dcwModalHtml(_dcwStoreDays('OVL'));
    return /has not loaded yet/.test(html) || 'got: ' + html.slice(0, 140);
});

// --- conversion tab ----------------------------------------------------------

t('conversion: one row per day, pooled total in the footer', function () {
    var html = popup('conversion');
    var days = (html.match(/dcw-td-day/g) || []).length;
    if (days !== 7) return 'expected 7 day rows, got ' + days;
    return /<b>59 Of 70<\/b>/.test(html)
        || 'footer did not pool to 59 of 70: ' + (html.match(/dcw-mtot[\s\S]{0,140}/) || [''])[0];
});

t('conversion: customers short is counted against the target, not guessed', function () {
    var html = popup('conversion');
    // 85% of 70 = 59.5, rounds to 60 expected; 59 converted, so 1 short.
    return /Customers short[\s\S]{0,140}>1</.test(html)
        || 'expected 1 customer short: ' + (html.match(/Customers short[\s\S]{0,160}/) || [''])[0];
});

// --- margin tab --------------------------------------------------------------

t('MARGIN IS DOLLAR-WEIGHTED, never an average of the daily percentages', function () {
    var html = popup('margin');
    // Six days of $1,000 bought for $300 (70% each), then $54,000 for $40,000
    // (25.9%). Value $60,000, cost $41,800, gross profit $18,200.
    //   average of the seven daily percentages = 63.7%   (wrong, and flattering
    //                                                     by more than 33 points)
    //   dollar-weighted, $18,200 / $60,000     = 30.3%   (right)
    if (/63\.7%/.test(html)) return 'the headline is an average of percentages';
    return /30\.3%/.test(html)
        || 'expected a dollar-weighted 30.3%, got: ' + (html.match(/Buy margin[\s\S]{0,170}/) || [''])[0];
});

t('margin: gross profit behind target is stated in dollars', function () {
    var html = popup('margin');
    // 54.5% of $60,000 = $32,700 of target GP; actual $18,200 → $14,500 behind.
    return /\$14,500/.test(html)
        || 'expected $14,500 behind: ' + (html.match(/Gross profit[\s\S]{0,170}/) || [''])[0];
});

t('margin: a store ahead of target reads as ahead, never as a negative', function () {
    var p = JSON.parse(JSON.stringify(POPUP));
    p.series = p.series.map(function (r) { r.est_value = 1000; r.total_spent = 100; return r; });
    _dcWatch = p; _dcwStore = 'OVL'; _dcwTab = 'margin';
    var html = _dcwModalHtml(_dcwStoreDays('OVL'));
    if (/-\$/.test(html)) return 'printed a negative dollar figure';
    return /Gross profit ahead/.test(html) || 'expected the tile to read "ahead"';
});

t('margin: says out loud that the 7-day figure is weighted', function () {
    return /dollar-weighted/i.test(popup('margin'))
        || 'the weighting is not explained anywhere on the tab';
});

// --- listing tab -------------------------------------------------------------

t('listing: ONLY days that had a goal set count, on both sides of the ratio', function () {
    var html = popup('listing');
    // The fixture sets goals on 09-11 (40) and 09-12 (40) only; 09-19 carries a
    // goal of 0 and the rest have no goal row at all. So the judged figure is
    // 40 listed against 80 staffed for — NOT all 130 devices the store handled.
    // Counting the goal-less days would flatter the store by 90 devices.
    if (!/<b>40<\/b> Listed against <b>80<\/b> staffed for/.test(html)) {
        return 'the judged totals are not 40 against 80: '
            + (html.match(/dcw-mtot[\s\S]{0,160}/) || [''])[0];
    }
    return /40<\/b> devices short|>40</.test(html) || 'the 40-device shortfall is missing';
});

t('listing: the untouched device count is still visible, just not judged', function () {
    var html = popup('listing');
    // 20x6 + 10 = 130 devices processed in total, $4,000x6 + $2,000 = $26,000.
    // Dropping it entirely would lose the honest "here is what they did do".
    if (!/130 devices in total/i.test(html)) return 'the total device count is gone';
    return /\$26,000/.test(html) || 'value total is not $26,000';
});

t('listing: says how many of the seven days actually had a goal', function () {
    // Without this the reader cannot tell a bad fortnight from a half-filled
    // rota, and the two look identical in the percentage.
    return /2 of 7 days had a goal set/i.test(popup('listing'))
        || 'the tab does not say how many days were judged';
});

t('listing: a zero goal never becomes a divide-by-zero', function () {
    // 2026-09-19 carries goal 0 on purpose — a real shape, on a day most of the
    // roster is off.
    var html = popup('listing');
    return !/Infinity|NaN/.test(html) || 'emitted Infinity/NaN from a zero goal';
});

t('listing: a day with no goal row shows a dash, not a zero', function () {
    var html = popup('listing');
    // Several days in the fixture have no goals entry at all. A 0 there would
    // read as "the goal was nothing", which is a different claim from "nobody
    // set one".
    return /&mdash;/.test(html) || 'a missing goal did not render as a dash';
});

t('listing: warns that it reads harsher than the Store Efficiency board', function () {
    // Listing became a FLAGGED metric in 0099, but the measurement did not
    // change: Day End processed runs 15-30% below the manager-filed weekly KPI
    // the efficiency board scores (0095). The two screens disagree, both
    // defensibly, and this sentence is the only thing that explains why. It is
    // now more important than it was when the tab merely displayed the number.
    var html = popup('listing');
    if (!/15–30%|15-30%/.test(html)) return 'the 15-30% gap is no longer stated';
    return /Store Efficiency/.test(html)
        || 'the note does not name the board it disagrees with';
});

// --- shared ------------------------------------------------------------------

t('every tab draws its bars with a target tick', function () {
    var bad = [];
    ['conversion', 'margin', 'listing'].forEach(function (tab) {
        var html = popup(tab);
        if (html.indexOf('dcw-bar-fill') < 0) bad.push(tab + ' has no bars');
        if (html.indexOf('dcw-bar-tick') < 0) bad.push(tab + ' has no target tick');
    });
    return bad.length === 0 || bad.join('; ');
});

t('the three tabs render genuinely different things', function () {
    var a = popup('conversion'), b = popup('margin'), c = popup('listing');
    if (a === b || b === c || a === c) return 'two tabs produced identical HTML';
    return true;
});

t('an unknown tab name falls back to conversion rather than blanking', function () {
    var html = popup('nonsense');
    return /Conversion &middot; 7 days|Conversion · 7 days/.test(html)
        || 'an unrecognised tab produced: ' + html.slice(0, 140);
});

// --- Ethan's 2026-09-21 pass on the popup ------------------------------------

t('the newest day is the top row, the oldest the bottom', function () {
    var html = popup('conversion');
    var a = html.indexOf('Sat, Sep 19'), b = html.indexOf('Fri, Sep 11');
    if (a < 0 || b < 0) return 'days missing from the table';
    return a < b || 'rows still run oldest first';
});

t('each tab puts its target beside the Against header', function () {
    if (popup('conversion').indexOf('Against target &middot; 85.0%') < 0) return 'conversion header has no target';
    if (popup('margin').indexOf('Against target &middot; 54.5%') < 0) return 'margin header has no target';
    return popup('listing').indexOf('Against goal &middot; 100%') >= 0 || 'listing header has no target';
});

t('tile and total lines start with a capital, past any leading figure', function () {
    var html = popup('conversion');
    if (/class="dcw-tile-s">against/.test(html)) return '"against a ... target" not capitalised';
    if (!/class="dcw-tile-s">\d+ Of \d+ customers/.test(html)) return 'number-first sub-line not capitalised';
    return /class="dcw-mtot"[^>]*><b>\d+ Of \d+<\/b> customers converted/.test(html)
        || 'total line not capitalised: ' + (html.match(/class="dcw-mtot"[^>]*>.{0,80}/) || [''])[0];
});

t('the explanatory footnote is gone from every tab', function () {
    var bad = ['conversion', 'margin', 'listing'].filter(function (t) {
        return popup(t).indexOf('dcw-foot') >= 0;
    });
    return bad.length === 0 || 'still has a footnote: ' + bad.join(', ');
});
