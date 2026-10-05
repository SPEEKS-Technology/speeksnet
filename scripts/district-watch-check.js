// DISTRICT MATRIX checks — the wiring, and what the renderer says.
//
//   powershell -File scripts/browser-check.ps1 district-watch-check.js
//
// Asserts about the HTML _dcWatchHtml returns. It cannot see a row overflowing
// its grid or a sparkline drawn at zero size — district-watch-layout-check.js
// measures those.
//
// The engine's own arithmetic is NOT tested here. state, mtd_under, miss_run,
// recent_value and the sentence are all decided by the district-watch edge
// function and arrive finished (see 0097 and 0110 for why). What this file
// protects is the half that lives in speeks.js: that the tab is wired up, that
// the rows sort worst-first, that the four 0110 states read as Ethan's words,
// and that the figure on the left is YESTERDAY'S.
//
// Rewritten for 0110 (2026-09-23), when the rule became "MTD, plus days in a
// row missed" and the window went from 14 days to 7. The fixture is shaped on
// the real board of 2026-09-22 — MPL is the store that was green at 80.9% MTD
// with nine misses running, and is Critical here.

// Open days 2026-09-10..22; the 13th and 20th are Sundays and absent, exactly
// as day_end_facts has them.
var DATES = ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-14', '2026-09-15', '2026-09-16',
             '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-21', '2026-09-22'];
var CONV = { MPL: [90, 85, 80, 80, 75, 90, 75, 80, 75, 70, 75],
             WSP: [90, 90, 85, 80, 90, 85, 80, 90, 90, 85, 70],
             BAL: [90, 85, 90, 95, 90, 85, 90, 95, 90, 85, 90],
             LEE: [85, 90, 85, 90, 85, 90, 85, 90, 85, 90, 95] };
var SPENT = { MPL: 2200, WSP: 2400, BAL: 2200, LEE: 2400 };   // on $5,000: 56% / 52%

function flag(store, metric, state, value, recent, run, extra) {
    var f = { store: store, metric: metric, state: state, value: value,
              target: metric === 'conversion' ? 85 : metric === 'margin' ? 53 : 100,
              recent_value: recent, miss_run: run, mtd_under: state === 'warn' || state === 'critical',
              shortfall: 0, streak: 1, acute: false, chronic: false, month_lost: false, drifting: false,
              reason: store + ' ' + metric + ' sentence.' };
    for (var k in (extra || {})) f[k] = extra[k];
    return f;
}

var PAYLOAD = {
    day: '2026-09-22',
    config: { conv_target: 85, margin_target: 53, chronic_window: 7, watch_run: 2, critical_run: 4 },
    flags: [
        flag('MPL', 'conversion', 'critical', 80.9, 77.0, 9, { shortfall: 10,
             reason: '80.9% for the month — 208 of 257 customers, 10 customers short of 85.0%. 77.0% over the last 7 days. Missed target 9 open days in a row.' }),
        flag('MPL', 'margin',     'ok',       56.8, 57.4, 0, { shortfall: -2915 }),
        flag('MPL', 'listing',    'warn',     83.2, 87.7, 0, { shortfall: 7, sample_n: 40, sample_k: 33 }),
        flag('WSP', 'conversion', 'warn',     79.1, 80.0, 1),
        flag('WSP', 'margin',     'watch',    53.2, 52.0, 2),
        flag('WSP', 'listing',    'ok',      133.1, 80.8, 0, { shortfall: -93 }),
        flag('BAL', 'conversion', 'ok',       88.0, 93.1, 0),
        flag('BAL', 'margin',     'ok',       55.6, 54.1, 0, { shortfall: -680 }),
        flag('BAL', 'listing',    'ok',      118.7, 126.4, 0, { shortfall: -67 }),
        flag('LEE', 'conversion', 'ok',       86.9, 90.0, 0),
        flag('LEE', 'margin',     'warn',     51.5, 53.4, 0, { shortfall: 481,
             reason: '51.5% for the month on $44,493 of buying — $481 of gross profit behind 53.0%.' }),
        flag('LEE', 'listing',    'ok',      167.2, 256.3, 0)
    ],
    series: (function () {
        var out = [];
        Object.keys(CONV).forEach(function (s) {
            CONV[s].forEach(function (p, i) {
                var date = DATES[i];
                out.push({ store: s, date: date, cust_conv_den: 20, cust_conv_num: Math.round(20 * p / 100),
                           est_value: 5000,
                           // LEE made margin on the last day: 54%.
                           total_spent: s === 'LEE' && date === '2026-09-22' ? 2300 : SPENT[s],
                           devices_lost: 2, no_deal_customers: 1,
                           // MPL listed 15 of 20 on the 21st; the 22nd had no goal set.
                           devices_processed: s === 'MPL' ? (date === '2026-09-21' ? 15 : 0) : 25 });
            });
        });
        return out;
    })(),
    goals: (function () {
        var out = [];
        Object.keys(CONV).forEach(function (s) {
            DATES.forEach(function (date) {
                if (s === 'MPL' && date === '2026-09-22') return;
                out.push({ store: s, date: date, goal: 20 });
            });
        });
        return out;
    })(),
    mtd: []
};

function render(payload) {
    _dcWatch = payload;
    return _dcWatchHtml();
}

function copy() { return JSON.parse(JSON.stringify(PAYLOAD)); }

// The glance rows follow their store row; find the store's group.
function lineFor(html, store, label) {
    var groups = html.split('<tbody class="dc-grp">');
    var g = groups.filter(function (x) { return x.indexOf("_dcwOpen('" + store + "')") >= 0; })[0] || '';
    var rows = g.match(/<tr class="dcw-note[^"]*"[^>]*>.*?<\/tr>/g) || [];
    return rows.filter(function (r) { return r.indexOf('<b>' + label + '</b>') >= 0; })[0] || '';
}
function statusOf(html, store) {
    var groups = html.split('<tbody class="dc-grp">');
    var g = groups.filter(function (x) { return x.indexOf("_dcwOpen('" + store + "')") >= 0; })[0] || '';
    var m = g.match(/class="dc-cat ([^"]+)">([^<]+)</);
    return m ? m[1] + ' ' + m[2] : '(none)';
}

// --- wiring -----------------------------------------------------------------

t('DC_TABS carries watch, second, right after live', function () {
    if (typeof DC_TABS === 'undefined') return 'DC_TABS is not defined';
    if (DC_TABS.indexOf('watch') < 0) return 'watch missing from DC_TABS: ' + DC_TABS.join(',');
    // Second is not cosmetic: it is the tab the card gets opened with.
    if (DC_TABS[1] !== 'watch') return 'watch should be second, got order ' + DC_TABS.join(',');
    return true;
});

t('the edge function URL points at district-watch', function () {
    if (typeof DISTRICT_WATCH_URL !== 'string') return 'DISTRICT_WATCH_URL is not defined';
    return /\/functions\/v1\/district-watch$/.test(DISTRICT_WATCH_URL)
        || 'unexpected URL: ' + DISTRICT_WATCH_URL;
});

t('feature key exists, is labelled Matrix, and defaults to DM + CEO', function () {
    if (typeof FEATURE_CATALOG === 'undefined') return 'FEATURE_CATALOG is not defined';
    var row = FEATURE_CATALOG.filter(function (f) { return f.key === 'widget-district-watch'; })[0];
    if (!row) return 'widget-district-watch is not in FEATURE_CATALOG';
    // The key stays `watch` to match the edge function and its tables; the
    // LABEL is what an admin reads in Feature Access, so that is what renamed.
    if (row.label !== 'District Matrix') return 'labelled "' + row.label + '" in Feature Access';
    if (row.tab !== 'widgets') return 'filed under tab "' + row.tab + '", not widgets';
    var def = (row.def || []).slice().sort().join(',');
    // CEO by default alongside the DM; anyone else is a deliberate grant.
    return def === 'ceo,district-manager' || 'expected ceo,district-manager — got ' + def;
});

t('the tab is grantable — a feature override can beat the role classes', function () {
    // The button and panel are plain [data-feature] elements with role classes,
    // which _applyFeatureOverridesToPlainEls resolves as
    // "override if there is one, else the role classes". That ordering is what
    // makes granting Matrix to a manager work at all. If the sweep ever stops
    // running, the role classes become absolute and the Feature Access switch
    // silently does nothing.
    if (typeof _applyFeatureOverridesToPlainEls !== 'function') {
        return 'the plain [data-feature] sweep is gone — grants would not apply';
    }
    return typeof _featureOverrideFor === 'function'
        || '_featureOverrideFor is gone — nothing resolves a grant';
});

t('the palette entry points at the right page and key', function () {
    if (typeof _FEATURE_PLACES === 'undefined') return true;   // optional index
    var row = (_FEATURE_PLACES || []).filter(function (f) { return f.id === 'w-dwatch'; })[0];
    if (!row) return 'no w-dwatch entry in the feature places list';
    if (row.feature !== 'widget-district-watch') return 'points at ' + row.feature;
    return row.page === 'index.html' || 'points at page ' + row.page;
});

// --- the renderer ------------------------------------------------------------

t('before the fetch answers it says syncing, not an empty table', function () {
    var html = render(null);
    return /Syncing the district/.test(html) || 'got: ' + html.slice(0, 120);
});

t('a payload with no flags says so rather than drawing an empty table', function () {
    var html = render({ day: '2026-09-19', config: {}, flags: [], series: [], mtd: [] });
    if (/<table/.test(html)) return 'drew a table with no rows';
    return /No District Matrix rows yet/.test(html) || 'got: ' + html.slice(0, 160);
});

// --- the four states (0110) ---------------------------------------------------

t('each store takes the worst of its three metrics, in the 0110 words', function () {
    var html = render(PAYLOAD);
    var want = { MPL: 'dc-bad Critical', WSP: 'dc-warn Warning', LEE: 'dc-warn Warning', BAL: 'dc-good On target' };
    var bad = Object.keys(want).filter(function (s) { return statusOf(html, s) !== want[s]; });
    return bad.length === 0 || bad.map(function (s) { return s + ' is ' + statusOf(html, s); }).join(', ');
});

t('Watch is its own state, blue, and ranks between Warning and On target', function () {
    var p = copy();
    p.flags.forEach(function (f) { if (f.store === 'WSP' && f.metric === 'conversion') { f.state = 'ok'; f.mtd_under = false; } });
    var html = render(p);
    if (statusOf(html, 'WSP') !== 'dc-watch Watch') return 'WSP reads ' + statusOf(html, 'WSP');
    var at = function (s) { return html.indexOf("_dcwOpen('" + s + "')"); };
    if (!(at('LEE') < at('WSP') && at('WSP') < at('BAL'))) return 'Watch did not sort between Warning and On target';
    return true;
});

t('rows sort worst-first — Critical, then Warning, then On target', function () {
    var html = render(PAYLOAD);
    var at = function (s) { return html.indexOf("_dcwOpen('" + s + "')"); };
    if ([at('MPL'), at('WSP'), at('LEE'), at('BAL')].some(function (i) { return i < 0; })) return 'a store is missing';
    return (at('MPL') < at('LEE') && at('LEE') < at('BAL') && at('WSP') < at('BAL'))
        || 'wrong order — MPL@' + at('MPL') + ' LEE@' + at('LEE') + ' WSP@' + at('WSP') + ' BAL@' + at('BAL');
});

t('a state the page does not know never outranks a real one', function () {
    var p = copy();
    p.flags.push(flag('BAL', 'listing', 'mystery', 1, 1, 0));
    p.flags = p.flags.filter(function (f) { return !(f.store === 'BAL' && f.metric === 'listing' && f.state === 'ok'); });
    return statusOf(render(p), 'BAL') === 'dc-good On target' || 'an unknown state changed BAL to ' + statusOf(render(p), 'BAL');
});

t('each flagged line says where the month stands, in two words', function () {
    var html = render(PAYLOAD);
    var want = [
        ['MPL', 'Conversion', 'Month under'],
        ['WSP', 'Conversion', 'Month under'],
        ['WSP', 'Margin',     'Month fine'],
        ['LEE', 'Margin',     'Month under'],
        ['MPL', 'Listing',    'Week behind']
    ];
    var miss = want.filter(function (w) {
        return lineFor(html, w[0], w[1]).indexOf('class="dcw-why">' + w[2] + '<') < 0;
    });
    return miss.length === 0 || 'missing: ' + miss.map(function (w) { return w[0] + ' ' + w[1] + ' "' + w[2] + '"'; }).join('; ');
});

t('the why phrases are plain words, not the names of tests', function () {
    var html = render(PAYLOAD);
    var jargon = /fortnight|of the last 3|significant|chance/i;
    var whys = html.match(/class="dcw-why">[^<]*/g) || [];
    var bad = whys.filter(function (w) { return jargon.test(w); });
    return bad.length === 0 || 'jargon still on the board: ' + bad.join(' | ');
});

t('a clear metric leaves the phrase blank and carries no day count', function () {
    // Ethan, 2026-09-21: "if a store is good, you don't need to even say on
    // target. Just leave it blank".
    var line = lineFor(render(PAYLOAD), 'BAL', 'Conversion');
    if (!/class="dcw-why"><\/span><\/td>/.test(line)) return 'BAL conversion line is not blank: ' + line;
    return line.indexOf('dcw-age') < 0 || 'a clear line printed a day count';
});

// --- the day count ------------------------------------------------------------

t('the day count is the engine’s miss_run, the count the state was judged on', function () {
    // The fixture series only holds five misses in a row for MPL; the engine
    // saw nine because it reads 45 days. The board must say what the engine
    // judged, or the words and the colour disagree.
    var line = lineFor(render(PAYLOAD), 'MPL', 'Conversion');
    return /Missed 9 days in a row</.test(line) || 'expected "Missed 9 days in a row": ' + line;
});

t('one miss reads "Missed yesterday"; none reads "Hit target yesterday"', function () {
    var html = render(PAYLOAD);
    var w = lineFor(html, 'WSP', 'Conversion');
    if (/1 days/.test(w)) return 'printed "1 days"';
    if (!/Missed yesterday</.test(w)) return 'WSP conversion: ' + w;
    return /Hit target yesterday</.test(lineFor(html, 'LEE', 'Margin')) || 'LEE margin should read hit target';
});

t('a row from before 0110 (no miss_run) falls back to counting the series', function () {
    var p = copy();
    p.flags.forEach(function (f) { if (f.store === 'MPL' && f.metric === 'conversion') delete f.miss_run; });
    // MPL's series ends 90, 75, 80, 75, 70, 75 — five misses after the 90.
    var line = lineFor(render(p), 'MPL', 'Conversion');
    return /Missed 5 days in a row</.test(line) || 'expected 5 from the series: ' + line;
});

// --- yesterday, on the left ------------------------------------------------------

t('the figure beside each label is yesterday’s, not the month’s', function () {
    // Ethan, 2026-09-23: "on the left side, I think I want to see yesterdays
    // numbers". WSP converted 14 of 20 on the 22nd.
    var line = lineFor(render(PAYLOAD), 'WSP', 'Conversion');
    if (/class="dcw-lead[^"]*"[^>]*>79\.1%/.test(line)) return 'the lead is still the month figure';
    return /class="dcw-lead[^"]*"[^>]*>70\.0%</.test(line) || 'expected 70.0%: ' + line;
});

t('yesterday is coloured by that day alone — a fine month with a bad day reads red', function () {
    var html = render(PAYLOAD);
    // WSP margin: Watch for the month, 52% yesterday — a miss.
    if (!/dcw-lead dcw-y-miss/.test(lineFor(html, 'WSP', 'Margin'))) return 'WSP margin yesterday is not marked a miss';
    // LEE margin: Warning for the month, 54% yesterday — a hit.
    if (!/dcw-lead dcw-y-hit/.test(lineFor(html, 'LEE', 'Margin'))) return 'LEE margin yesterday is not marked a hit';
    return /dcw-lead dcw-y-hit/.test(lineFor(html, 'BAL', 'Conversion')) || 'BAL conversion (90%) is not a hit';
});

t('yesterday’s exact counts are in the hover on the figure', function () {
    var line = lineFor(render(PAYLOAD), 'WSP', 'Conversion');
    return /title="Tue, Sep 22: 14 of 20 customers converted"/.test(line) || 'no count hover: ' + line;
});

t('listing’s lead is the week so far, not yesterday', function () {
    // Ethan, 2026-09-23: "the left column should be daily tracked against the
    // week". It is the engine's figure — listing's value is week to date — so
    // the lead and the status cannot disagree. MPL is 83.2% of goal this week.
    var line = lineFor(render(PAYLOAD), 'MPL', 'Listing');
    if (!/class="dcw-lead dcw-y-miss"[^>]*>83% of goal</.test(line)) return 'expected 83% of goal: ' + line;
    return /title="This week so far: 33 listed against 40 staffed for"/.test(line) || 'no week hover: ' + line;
});

t('a listing week at goal reads green on the left', function () {
    var line = lineFor(render(PAYLOAD), 'BAL', 'Listing');
    return /class="dcw-lead dcw-y-hit"[^>]*>119% of goal</.test(line) || 'BAL listing: ' + line;
});

t('listing on Watch says "Week fine", not "Month fine"', function () {
    var p = copy();
    p.flags.forEach(function (f) { if (f.store === 'BAL' && f.metric === 'listing') { f.state = 'watch'; f.miss_run = 2; } });
    var line = lineFor(render(p), 'BAL', 'Listing');
    return /class="dcw-why">Week fine</.test(line) || 'BAL listing: ' + line;
});

t('on a Monday the header says Saturday, because Sunday is shut', function () {
    var p = copy();
    p.day = '2026-09-20';
    p.series = p.series.filter(function (r) { return r.date <= '2026-09-19'; });
    var html = render(p);
    if (!/Store &middot; Saturday</.test(html)) return 'header does not say Saturday';
    return /class="dcw-lead[^"]*"[^>]*>90\.0%</.test(lineFor(html, 'WSP', 'Conversion'))
        || 'WSP lead is not Saturday’s 90.0%';
});

t('the Store header says the figures are yesterday’s on an ordinary day', function () {
    return /Store &middot; yesterday</.test(render(PAYLOAD)) || 'Store header does not say yesterday';
});

// --- the metric columns -------------------------------------------------------

t('each cell shows MTD as the headline and the last 7 days beside it', function () {
    var html = render(PAYLOAD);
    if (!/class="dcw-val dcw-mtd dc-bad">80\.9%/.test(html)) return 'MPL conversion MTD 80.9% missing or uncoloured';
    if (!/class="dcw-recent dcw-r7">77\.0%/.test(html)) return 'MPL conversion 7-day 77.0% missing';
    if (/Last 14 days/.test(html)) return 'a cell still says 14 days';
    return (html.match(/>Last 7 days</g) || []).length >= 12
        || 'the 7-day figure is not labelled on every cell';
});

t('the verdict colour is on MTD, and the 7-day figure is neutral', function () {
    // Colour means "what the engine judged", and since 0110 it judges the month.
    var html = render(PAYLOAD);
    if (/dcw-r7[^"]*dc-(good|watch|warn|bad)|dc-(good|watch|warn|bad)[^"]*dcw-r7/.test(html)) {
        return 'the 7-day figure carries a severity class';
    }
    if (!/class="dcw-val dcw-mtd dc-watch">53\.2%/.test(html)) return 'WSP margin MTD is not blue for Watch';
    return /class="dcw-val dcw-mtd dc-good">88\.0%/.test(html) || 'BAL conversion MTD is not green';
});

t('a comeback shows an up arrow; a slide shows a down arrow', function () {
    var html = render(PAYLOAD);
    // LEE margin 51.5% MTD, 53.4% recently — up. MPL conversion 80.9 -> 77.0 — down.
    if (!/53\.4%<\/span><span class="dcw-slot"><span class="dcw-arrow dcw-up"/.test(html)) return 'no up arrow on LEE’s comeback';
    return /77\.0%<\/span><span class="dcw-slot"><span class="dcw-arrow dcw-down"/.test(html)
        || 'no down arrow on MPL’s slide';
});

t('the listing column leads with THIS WEEK, in whole percentages of goal', function () {
    var html = render(PAYLOAD);
    if (!/class="dcw-val dcw-mtd dc-warn">83%<\/span><span class="dcw-slot"><\/span><span class="dcw-tag">This week</.test(html)) {
        return 'MPL listing is not headed "This week" at 83%';
    }
    if ((html.match(/>This week</g) || []).length !== 4) return 'expected one This week tag per store';
    return /class="dcw-recent dcw-r7">88%/.test(html) || 'MPL listing 7-day 88% missing';
});

t('no month figure reads as a dash, not 0%', function () {
    var p = copy();
    p.flags.forEach(function (f) { if (f.store === 'BAL') { f.value = null; f.recent_value = null; } });
    var html = render(p);
    if (/dcw-mtd[^"]*">0\.0%/.test(html)) return 'printed 0.0% for a month with no data';
    return /class="dcw-val dcw-mtd dc-good">&mdash;/.test(html) || 'expected a dash';
});

t('conversion and margin each get a 7-day sparkline; listing gets none', function () {
    var html = render(PAYLOAD);
    var sparks = (html.match(/class="dcw-spark"/g) || []).length;
    if (sparks !== 8) return 'expected 8 sparklines (4 stores x 2 metrics), got ' + sparks;
    // 7 calendar days back from the 22nd holds 6 open days (the 20th is Sunday).
    var pts = (html.match(/points="([^"]*)"/) || ['', ''])[1].trim().split(' ').length;
    return pts === 6 || 'expected 6 points in the 7-day window, got ' + pts;
});

t('the two charts share a 50-point span so they can be compared by eye', function () {
    var html = render(PAYLOAD);
    var ys = (html.match(/y1="([\d.]+)"/g) || []).map(function (m) { return m.slice(4, -1); });
    if (ys.length < 8) return 'expected target lines on both charts, found ' + ys.length;
    var uniq = ys.filter(function (v, i, a) { return a.indexOf(v) === i; });
    return uniq.length === 2
        || 'expected exactly two distinct target-line heights (one per metric), got ' + uniq.join(', ');
});

t('a store with under two days of history gets no sparkline rather than a broken one', function () {
    var p = copy();
    p.series = p.series.filter(function (r) { return r.date === '2026-09-22'; });
    var html = render(p);
    if (/NaN|Infinity/.test(html)) return 'emitted NaN/Infinity into the SVG';
    return html.indexOf('dcw-spark') < 0 || 'drew a one-point sparkline';
});

// --- caption, headers, hover -------------------------------------------------

t('the caption counts the stores needing attention', function () {
    return /<b>3<\/b> of 4 stores need attention</.test(render(PAYLOAD))
        || 'caption did not count 3 of 4';
});

t('Watch is counted apart, never as needing attention', function () {
    var p = copy();
    p.flags.forEach(function (f) {
        if (f.state === 'warn' || f.state === 'critical') { f.state = 'ok'; f.mtd_under = false; }
    });
    var html = render(p);
    if (/need attention/.test(html)) return 'a Watch store was counted as needing attention';
    return /All 4 stores on target for the month &middot; <b>1<\/b> to watch/.test(html)
        || 'caption: ' + (html.match(/dcw-cap-l">(.*?)<\/span><span/) || ['', ''])[1];
});

t('an all-clear district says so instead of showing a zero', function () {
    var p = copy();
    p.flags.forEach(function (f) { f.state = 'ok'; });
    var html = render(p);
    if (/need attention|to watch/.test(html)) return 'still worded as if something were flagged';
    return /All 4 stores clear/.test(html) || 'expected an all-clear caption';
});

t('the judged day is labelled, and it is the judged day not today', function () {
    return /Through Tue, Sep 22/.test(render(PAYLOAD)) || 'expected the 2026-09-22 date in the caption';
});

t('each column header states the target it judges against', function () {
    var html = render(PAYLOAD);
    var miss = [];
    if (!/Customer conversion &middot; target 85\.0%/.test(html))  miss.push('conversion');
    if (!/Buy margin &middot; target 53\.0%/.test(html))           miss.push('margin');
    if (!/Listing &middot; target 100% of goal/.test(html))        miss.push('listing');
    return miss.length === 0 || 'headers missing their target: ' + miss.join(', ');
});

t('the Status header spells out all four states, from config', function () {
    var p = copy();
    p.config.watch_run = 3; p.config.critical_run = 5; p.config.conv_target = 90;
    var tip = (render(p).match(/<th title="([^"]*)">Status<\/th>/) || ['', ''])[1];
    if (!tip) return 'the Status header has no tooltip';
    var miss = ['ON TARGET', 'WATCH', 'WARNING', 'CRITICAL'].filter(function (w) { return tip.indexOf(w) < 0; });
    if (miss.length) return 'the tooltip never says: ' + miss.join(', ');
    if (tip.indexOf('3+') < 0 || tip.indexOf('5+') < 0) return 're-tuned runs did not reach the tooltip';
    if (tip.indexOf('90.0%') < 0) return 'a re-tuned conversion target did not reach the tooltip';
    return !/chance|significan|catch/i.test(tip) || 'the tooltip still describes the retired tests';
});

t('the engine sentence rides on the line as its hover', function () {
    var line = lineFor(render(PAYLOAD), 'MPL', 'Conversion');
    return /title="80\.9% for the month — 208 of 257 customers/.test(line) || 'the sentence is not the hover';
});

t('a reason from the server is escaped before it is written into the row', function () {
    var p = copy();
    p.flags = [flag('OVL', 'margin', 'warn', 50, 50, 1, { reason: '<img src=x onerror="alert(1)">' })];
    var html = render(p);
    if (/<img src=x/.test(html)) return 'the reason was written in raw';
    return /&lt;img/.test(html) || 'expected the reason to come through escaped';
});

t('no negative figure is ever printed anywhere on the board', function () {
    var html = render(PAYLOAD).replace(/<[^>]*>/g, ' ');
    if (/-\$[\d,]|\$-[\d,]/.test(html)) return 'printed a negative dollar figure';
    return !/(^|\s)-\d/.test(html) || 'printed a negative number';
});

t('every glance line is label, then number, then why — in that order', function () {
    var lines = render(PAYLOAD).match(/<tr class="dcw-note[^"]*"[^>]*>.*?<\/tr>/g) || [];
    if (lines.length !== 12) return 'expected a line per metric per store, got ' + lines.length;
    var bad = lines.filter(function (l) {
        var b = l.indexOf('<b>'), lead = l.indexOf('dcw-lead'), why = l.indexOf('dcw-why');
        return !(b >= 0 && lead > b && why > lead);
    });
    return bad.length === 0 || bad.length + ' lines are out of order';
});

t('the methodology paragraph under the table is gone', function () {
    return !/dcw-foot/.test(render(PAYLOAD)) || 'the footnote is still rendered under the board';
});

t('every store row opens that store’s popup', function () {
    var html = render(PAYLOAD);
    if (/_dcDrill\(/.test(html)) return 'a row still swaps to the Store Breakdown tab';
    return (html.indexOf("_dcwOpen('MPL')") >= 0 && html.indexOf("_dcwOpen('WSP')") >= 0)
        || 'rows are not wired to _dcwOpen';
});
