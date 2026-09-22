// DISTRICT WATCH checks — the wiring, and what the renderer says.
//
//   powershell -File scripts/browser-check.ps1 district-watch-check.js
//
// Asserts about the HTML _dcWatchHtml returns. It cannot see a row overflowing
// its grid or a sparkline drawn at zero size — district-watch-layout-check.js
// measures those.
//
// The engine's own arithmetic is NOT tested here. state, streak, shortfall and
// the sentence are all decided by the district-watch edge function and arrive
// finished (see migration 0097's header for why). What this file protects is
// the half that lives in speeks.js: that the tab is wired up, that the rows
// sort worst-first, and that the SHORTFALL reaches the screen — the whole point
// of the feature is that "$3,936 of GP behind" is visible next to "50.2%",
// because the percentage alone hides how much the store buys.

// A payload shaped exactly like the edge function's action:'board' reply, using
// the real numbers from 2026-09-19 so a change in wording is visible as a diff
// against something a person can recognise.
var PAYLOAD = {
    day: '2026-09-19',
    config: { conv_target: 85, margin_target: 53, p_threshold: 0.1, chronic_window: 14,
              gp_short_min: 750, gp_short_red: 1750, gp_day_min: 150,
              margin_recover_max: 60,
              listing_short_min: 25, listing_short_red: 200, listing_min_goal: 25,
              listing_catchup_mult: 1.3 },
    flags: [
        { store: 'OVL', metric: 'margin', state: 'critical', value: 50.2, target: 53,
          sample_n: 91557, sample_k: null, p_value: null, shortfall: 2562, streak: 13,
          acute: true, chronic: true, month_lost: true, drifting: false,
          reason: '50.2% against a 53.0% target — $2,562 of gross profit behind on $91,557 of buying. Flagged 13 days running.' },
        // Listing became a flagged metric in 0099. OVL misses its staffed goal
        // by 240 devices; the other two clear theirs.
        { store: 'OVL', metric: 'listing', state: 'critical', value: 51.2, target: 100,
          sample_n: 492, sample_k: 252, p_value: null, shortfall: 240, streak: 4,
          acute: false, chronic: true, month_lost: true, drifting: false,
          reason: '252 listed against 492 the store was staffed for this week — 240 devices short (51.2% of goal), with only 2 days left and room for about 30 of catch-up in them.' },
        { store: 'WSP', metric: 'listing', state: 'ok', value: 143.9, target: 100,
          sample_n: 212, sample_k: 305, p_value: null, shortfall: -93, streak: 1,
          acute: false, chronic: false, month_lost: false, drifting: false,
          reason: 'Cleared the staffed goal — 305 listed against 212 set (143.9%).' },
        { store: 'BAL', metric: 'listing', state: 'ok', value: 123.2, target: 100,
          sample_n: 289, sample_k: 356, p_value: null, shortfall: -67, streak: 1,
          acute: false, chronic: false, month_lost: false, drifting: false,
          reason: 'Cleared the staffed goal — 356 listed against 289 set (123.2%).' },
        { store: 'OVL', metric: 'conversion', state: 'ok', value: 83.3, target: 85,
          sample_n: 204, sample_k: 170, p_value: 0.2796, shortfall: 3, streak: 1,
          acute: false, chronic: false, month_lost: false, drifting: true,
          reason: '83.3% over 12 days, but no day is further below target than its volume explains.' },
        { store: 'BAL', metric: 'conversion', state: 'ok', value: 85.7, target: 85,
          sample_n: 105, sample_k: 90, p_value: 0.6227, shortfall: 0, streak: 1,
          acute: false, chronic: false, month_lost: false, drifting: false,
          reason: 'On target — 85.7% over 12 days.' },
        { store: 'BAL', metric: 'margin', state: 'ok', value: 55.1, target: 54.5,
          sample_n: 32206, sample_k: null, p_value: null, shortfall: -189, streak: 1,
          acute: false, chronic: false, month_lost: false, drifting: false,
          reason: 'On target — 55.1% on $32,206 of buying.' },
        { store: 'WSP', metric: 'conversion', state: 'warn', value: 80.0, target: 85,
          sample_n: 130, sample_k: 104, p_value: 0.0741, shortfall: 7, streak: 6,
          acute: false, chronic: true, month_lost: false, drifting: false,
          reason: '80.0% over 12 days — 7 customers short of target. Flagged 6 days running.' },
        { store: 'WSP', metric: 'margin', state: 'ok', value: 53.7, target: 53,
          sample_n: 36740, sample_k: null, p_value: null, shortfall: -268, streak: 1,
          acute: false, chronic: false, month_lost: false, drifting: false,
          reason: 'On target — 53.7% on $36,740 of buying.' }
    ],
    series: (function () {
        var out = [], conv = { OVL: [86.7, 93.3, 84.6, 83.3, 82.6, 77.8, 75, 85.7, 100, 60, 80, 95.7],
                               BAL: [100, 82.4, 88.9, 66.7, 92.3, 57.1, 83.3, 100, 100, 100, 83.3, 81.8],
                               WSP: [87.5, 81.3, 85.7, 64.3, 81.8, 90, 66.7, 70.6, 100, 72.7, 92.9, 90] };
        Object.keys(conv).forEach(function (s) {
            conv[s].forEach(function (p, i) {
                out.push({ store: s, date: '2026-09-' + String(i + 7).padStart(2, '0'),
                           cust_conv_den: 20, cust_conv_num: Math.round(20 * p / 100),
                           est_value: 5000, total_spent: 2400, devices_lost: 2, no_deal_customers: 1 });
            });
        });
        return out;
    })(),
    // Month to date. OVL opened the month badly and has come back: 78.0% MTD
    // against 83.3% over the last 14 days — the comeback case Ethan asked the
    // MTD/14-day pair to show. WSP is the other way round.
    mtd: [
        { store: 'OVL', cust_conv_num: 390, cust_conv_den: 500, est_value: 126302, total_spent: 62014 },
        { store: 'WSP', cust_conv_num: 255, cust_conv_den: 300, est_value: 51262, total_spent: 23760 },
        { store: 'BAL', cust_conv_num: 171, cust_conv_den: 200, est_value: 47055, total_spent: 20845 }
    ]
};

function render(payload) {
    _dcWatch = payload;
    return _dcWatchHtml();
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

t('each cell shows MTD as the headline and the last 14 days beside it', function () {
    var html = render(PAYLOAD);
    // OVL conversion: 390/500 = 78.0% MTD, 83.3% over the window.
    if (!/class="dcw-val dcw-mtd">78\.0%/.test(html)) return 'OVL conversion MTD 78.0% missing';
    if (!/class="dcw-recent[^"]*">83\.3%/.test(html)) return 'OVL conversion 14-day 83.3% missing';
    return (html.match(/>Last 14 days</g) || []).length >= 6
        || 'the 14-day figure is not labelled on every cell';
});

t('MTD margin is dollar-weighted from the month rows', function () {
    // OVL: (126302 - 62014) / 126302 = 50.9%
    var html = render(PAYLOAD);
    return /class="dcw-val dcw-mtd">50\.9%/.test(html)
        || 'OVL margin MTD should be 50.9%';
});

t('a comeback shows an up arrow; a slide shows a down arrow', function () {
    // Ethan: "if they started a month off poorly and have a comeback". OVL
    // conversion is 78.0% MTD and 83.3% recently — up. WSP conversion is
    // 85.0% MTD and 80.0% recently — down.
    var html = render(PAYLOAD);
    if (!/83\.3%<\/span><span class="dcw-slot"><span class="dcw-arrow dcw-up"/.test(html)) return 'no up arrow on OVL\u2019s comeback';
    return /80\.0%<\/span><span class="dcw-slot"><span class="dcw-arrow dcw-down"/.test(html)
        || 'no down arrow on WSP\u2019s slide';
});

t('the verdict colour is on the 14-day figure, not on MTD', function () {
    // Colour on this board means "what the engine judged", and it judges the
    // window. MTD is a fact, shown neutral.
    var html = render(PAYLOAD);
    if (/dcw-mtd[^"]*dc-(good|warn|bad)|dc-(good|warn|bad)[^"]*dcw-mtd/.test(html)) {
        return 'MTD carries a severity class';
    }
    return /class="dcw-recent dc-warn">80\.0%/.test(html)
        || 'WSP\u2019s warned 14-day figure does not carry dc-warn';
});

t('no MTD rows reads as a dash, not 0%', function () {
    var p = JSON.parse(JSON.stringify(PAYLOAD));
    p.mtd = [];
    var html = render(p);
    if (/dcw-mtd">0\.0%/.test(html)) return 'printed 0.0% for a month with no data';
    return /class="dcw-val dcw-mtd">&mdash;/.test(html) || 'expected a dash';
});

t('rows sort worst-first — OVL critical above WSP warn above BAL clear', function () {
    var html = render(PAYLOAD);
    var order = ['OVL', 'WSP', 'BAL'].map(function (s) { return html.indexOf('>' + s + '<'); });
    if (order.some(function (i) { return i < 0; })) return 'a store is missing: ' + order.join(',');
    if (!(order[0] < order[1] && order[1] < order[2])) {
        return 'wrong order — OVL@' + order[0] + ' WSP@' + order[1] + ' BAL@' + order[2];
    }
    return true;
});

t('margin leads with its percentage, in the unit of its target', function () {
    // Ethan, 2026-09-21: "for margin it should be % based like the threshold
    // not $ behind". The dollars still decide nothing on screen by themselves
    // and are still in the hover sentence — but the figure a DM compares with
    // "53%" has to be a percentage.
    var html = render(PAYLOAD);
    if (/class="dcw-lead">\$/.test(html)) return 'a line still leads with dollars';
    return /class="dcw-lead">50\.2%</.test(html)
        || 'the margin line does not lead with 50.2%';
});

t('the dollars behind are kept, in the hover', function () {
    var html = render(PAYLOAD);
    return /title="[^"]*\$2,562 of gross profit behind/.test(html)
        || 'the gross-profit shortfall is gone from the board entirely';
});

t('conversion leads with its percentage too', function () {
    var html = render(PAYLOAD);
    return /class="dcw-lead">80\.0%</.test(html)
        || 'the WSP conversion line does not lead with 80.0%';
});

t('the why phrases are plain words, not the names of tests', function () {
    // "Across the fortnight", "2 of the last 3", "not yet significant" were
    // accurate and meant nothing to the reader ("I don't understand the
    // fortnight stuff").
    var html = render(PAYLOAD);
    var jargon = /fortnight|of the last 3|significant/i;
    var whys = html.match(/class="dcw-why">[^<]*/g) || [];
    var bad = whys.filter(function (w) { return jargon.test(w); });
    return bad.length === 0 || 'jargon still on the board: ' + bad.join(' | ');
});

t('each state reads as one of the words Ethan asked for', function () {
    var html = render(PAYLOAD);
    var want = { 'Month is out of reach': 'OVL margin (critical)',
                 'Under target': 'WSP conversion (warn)',
                 'Slightly under target': 'OVL conversion (drifting)' };
    var miss = Object.keys(want).filter(function (k) {
        return html.indexOf('class="dcw-why">' + k) < 0;
    });
    return miss.length === 0
        || 'missing: ' + miss.map(function (k) { return k + ' (' + want[k] + ')'; }).join(', ');
});

t('every glance line is label, then number, then why — in that order', function () {
    // The order is the whole point: five stores, fifteen lines, and an eye
    // running down the column. A line that puts the reason before the number
    // reads fine on its own and ruins the list.
    var html = render(PAYLOAD);
    var lines = html.match(/<tr class="dcw-note[^"]*"[^>]*>.*?<\/tr>/g) || [];
    if (lines.length < 9) return 'expected a line per metric per store, got ' + lines.length;
    var bad = lines.filter(function (l) {
        var b = l.indexOf('<b>'), lead = l.indexOf('dcw-lead'), why = l.indexOf('dcw-why');
        return !(b >= 0 && lead > b && why > lead);
    });
    return bad.length === 0 || bad.length + ' lines are out of order, e.g. ' + bad[0].slice(0, 120);
});

t('the engine sentence moves to the hover instead of being printed', function () {
    // Nothing is thrown away — the detail is one hover from the summary. If
    // the title ever stops carrying it, the long-form reasoning is gone from
    // the app entirely, because the popup shows its own day-by-day tables
    // rather than this sentence.
    var html = render(PAYLOAD);
    if (/<td[^>]*>252 listed against 492/.test(html)) {
        return 'the full sentence is still being printed into the row';
    }
    return /title="252 listed against 492 the store was staffed for this week/.test(html)
        || 'the full sentence is not on the line as a tooltip';
});

t('a clear store that is sliding says so, without being flagged', function () {
    // Ethan, 2026-09-21: "or if they are good and have a negative trend
    // starting". OVL conversion is the case — 83.3%, not significant, so not a
    // warning, but under target with a bad day in the last three.
    var html = render(PAYLOAD);
    if (!/dcw-note dc-good dcw-drift/.test(html)) {
        return 'the drifting metric did not get the drift class';
    }
    if (!/class="dcw-why">Slightly under target/.test(html)) {
        return 'the drifting line does not say why it is drifting';
    }
    // And it must NOT have pulled the store onto the triage list.
    var m = html.match(/<b>(\d+)<\/b> of \d+ stores need attention/);
    return (m && m[1] === '2')
        || 'drifting changed the count of stores needing attention: ' + (m ? m[1] : 'none');
});

t('a clear metric leaves the phrase blank', function () {
    // Ethan, 2026-09-21: "if a store is good, you don't need to even say on
    // target. Just leave it blank". BAL conversion (85.7%) and BAL listing.
    var html = render(PAYLOAD);
    if (/class="dcw-why">(On target|Week cleared)/.test(html)) {
        return 'a clear line still prints on target / week cleared';
    }
    var line = lineFor(html, 'BAL', 'Conversion');
    return /class="dcw-why"><\/span><\/td>/.test(line) || 'BAL conversion line is not blank: ' + line;
});

// The day count is DAYS IN A ROW FINISHED UNDER TARGET, counted from the
// daily series (Ethan, 2026-09-21: "how many days in a row they fell under
// target"), not watch_flags.streak — the days the flag has stood.
function lineFor(html, store, label) {
    // The glance rows follow their store row; find the store's group.
    var groups = html.split('<tbody class="dc-grp">');
    var g = groups.filter(function (x) { return x.indexOf("_dcwOpen('" + store + "')") >= 0; })[0] || '';
    var rows = g.match(/<tr class="dcw-note[^"]*"[^>]*>.*?<\/tr>/g) || [];
    return rows.filter(function (r) { return r.indexOf('<b>' + label + '</b>') >= 0; })[0] || '';
}

t('the day count is days in a row under target, not days flagged', function () {
    // OVL margin: flagged 13 days (streak), but the fixture has it at 52.0%
    // on every one of the 12 days loaded — so 12, marked as possibly longer.
    var line = lineFor(render(PAYLOAD), 'OVL', 'Margin');
    if (!line) return 'no OVL margin line';
    // (The hover sentence still says "Flagged 13 days running" — on purpose.)
    if (/&middot; 13 days/.test(line)) return 'still printing the flag streak: ' + line;
    return /Missed 12\+ days in a row/.test(line) || 'expected "Missed 12+ days in a row": ' + line;
});

t('the run stops at the first day that made target', function () {
    // WSP conversion ends ..., 100, 72.7, 92.9, 90 — make the last three miss.
    var p = JSON.parse(JSON.stringify(PAYLOAD));
    p.series.forEach(function (r) {
        if (r.store === 'WSP' && r.date >= '2026-09-16') r.cust_conv_num = 14;   // 70%
    });
    var line = lineFor(render(p), 'WSP', 'Conversion');
    return /Missed 3 days in a row</.test(line) || 'expected 3 in a row: ' + line;
});

t('a closed day is stepped over, not counted and not a reset', function () {
    var p = JSON.parse(JSON.stringify(PAYLOAD));
    p.series.forEach(function (r) {
        if (r.store === 'WSP' && r.date >= '2026-09-16') r.cust_conv_num = 14;
        if (r.store === 'WSP' && r.date === '2026-09-17') { r.cust_conv_num = 0; r.cust_conv_den = 0; }
    });
    var line = lineFor(render(p), 'WSP', 'Conversion');
    return /Missed 2 days in a row</.test(line) || 'expected 2 in a row across the closed day: ' + line;
});

t('one miss reads "Missed yesterday"; a made day reads "Hit target yesterday"', function () {
    var html = render(PAYLOAD);
    // WSP conversion's last day is 90% — flagged, but made it.
    if (!/Hit target yesterday/.test(lineFor(html, 'WSP', 'Conversion'))) return 'WSP should read hit target';
    var p = JSON.parse(JSON.stringify(PAYLOAD));
    p.series.forEach(function (r) {
        if (r.store === 'WSP' && r.date === '2026-09-18') r.cust_conv_num = 14;
    });
    var line = lineFor(render(p), 'WSP', 'Conversion');
    if (/1 days/.test(line)) return 'printed "1 days"';
    return /Missed yesterday</.test(line) || 'expected "Missed yesterday": ' + line;
});

t('a clear line never carries a day count, even after a miss', function () {
    // BAL conversion is on target but its last two days were 83.3 and 81.8.
    var line = lineFor(render(PAYLOAD), 'BAL', 'Conversion');
    if (!line) return 'no BAL conversion line';
    return line.indexOf('dcw-age') < 0 || 'a clear line printed a day count: ' + line;
});

t('listing counts days under that day\u2019s goal, skipping days with none', function () {
    var p = JSON.parse(JSON.stringify(PAYLOAD));
    p.goals = [];
    p.series.forEach(function (r) {
        if (r.store !== 'OVL') return;
        r.devices_processed = r.date >= '2026-09-16' ? 20 : 60;
        if (r.date !== '2026-09-17') p.goals.push({ store: 'OVL', date: r.date, goal: 40 });
    });
    var line = lineFor(render(p), 'OVL', 'Listing');
    return /Missed 2 days in a row</.test(line) || 'expected 2 (16th, 18th; 17th had no goal): ' + line;
});

t('the listing column carries the DEVICES short of the staffed goal', function () {
    var html = render(PAYLOAD);
    if (html.indexOf('51%') < 0) return 'OVL listing percentage missing';
    // Same principle as margin: the unit the work is done in, not a percentage.
    // "this week" because 0100 moved the metric off a rolling window onto the
    // Monday-to-Saturday week; the sub-line has to say which.
    return /class="dcw-recent dcw-dev">240 short</.test(html)
        || 'the device shortfall is not on screen under the percentage';
});

t('a store that clears its staffed goal says so rather than showing a negative', function () {
    var html = render(PAYLOAD);
    if (/-93 short|-67 short/.test(html)) return 'printed a negative device shortfall';
    if (!/>93 over</.test(html)) return 'WSP (93 ahead) does not read as over';
    return />67 over</.test(html) || 'BAL (67 ahead) does not read as over';
});

t('listing raises a store that is fine on the other two metrics', function () {
    // The point of adding the metric: a store can be converting and buying well
    // and still not be listing what it was staffed for. If the row state does
    // not follow the worst of the THREE, that store stays invisible.
    var p = JSON.parse(JSON.stringify(PAYLOAD));
    p.flags = [
        { store: 'LEE', metric: 'conversion', state: 'ok', value: 90, target: 85,
          sample_n: 100, sample_k: 90, shortfall: 0, streak: 1, reason: 'On target.' },
        { store: 'LEE', metric: 'margin', state: 'ok', value: 56, target: 53,
          sample_n: 40000, shortfall: -1200, streak: 1, reason: 'On target.' },
        { store: 'LEE', metric: 'listing', state: 'critical', value: 44, target: 100,
          sample_n: 400, sample_k: 176, shortfall: 224, streak: 2, reason: '224 devices short.' }
    ];
    var html = render(p);
    if (!/need attention/.test(html)) return 'the store was not counted as needing attention';
    return /dc-cat dc-bad">Critical/.test(html)
        || 'the row status did not follow the listing metric';
});

t('no negative shortfall is ever printed anywhere on the board', function () {
    // A store ahead of target must never render as "-$189 behind" or
    // "-93 devices short". The engine words those as "ahead" / "cleared goal".
    var html = render(PAYLOAD);
    if (/-\$[\d,]/.test(html) || /\$-[\d,]/.test(html)) return 'printed a negative dollar figure';
    return !/-\d+ short/.test(html) || 'printed a negative device shortfall';
});

t('the conversion cell says how many customers short', function () {
    var html = render(PAYLOAD);
    return html.indexOf('7 customers short') >= 0
        || 'WSP’s customer shortfall is not on screen';
});

t('buy margin gets a trend chart of its own, not just conversion', function () {
    var html = render(PAYLOAD);
    // Two metrics with 12 days of history each -> two sparklines per store row
    // that has both. Three stores in the fixture have conversion AND margin.
    var sparks = (html.match(/dcw-spark/g) || []).length;
    return sparks >= 6 || 'expected at least 6 sparklines (3 stores x 2 metrics), got ' + sparks;
});

t('the two charts share a 50-point span so they can be compared by eye', function () {
    // Conversion plots 50-100, margin 30-80. Same span, same sensitivity: a
    // wobble of N points draws the same height on either. Widening one would
    // quietly make that store look steadier than it is.
    var html = render(PAYLOAD);
    // The target line's y is the tell. 85 on a 50-100 scale and 53 on a 30-80
    // scale both sit at the same fraction from the top: (100-85)/50 = 0.30,
    // (80-53)/50 = 0.54 — different heights, same arithmetic.
    var ys = (html.match(/y1="([\d.]+)"/g) || []).map(function (m) { return m.slice(4, -1); });
    if (ys.length < 6) return 'expected target lines on both charts, found ' + ys.length;
    var uniq = ys.filter(function (v, i, a) { return a.indexOf(v) === i; });
    return uniq.length === 2
        || 'expected exactly two distinct target-line heights (one per metric), got ' + uniq.join(', ');
});

t('a sparkline is drawn, with the target line on it', function () {
    var html = render(PAYLOAD);
    if (html.indexOf('dcw-spark') < 0) return 'no sparkline rendered';
    if (html.indexOf('<polyline') < 0) return 'sparkline has no trend line';
    // Without the dashed target the trend answers "which way" but not "against what".
    return /stroke-dasharray/.test(html) || 'sparkline is missing its target line';
});

t('a store with under two days of history gets no sparkline rather than a broken one', function () {
    var p = JSON.parse(JSON.stringify(PAYLOAD));
    p.series = [{ store: 'OVL', date: '2026-09-19', cust_conv_den: 10, cust_conv_num: 8,
                  est_value: 100, total_spent: 50, devices_lost: 0, no_deal_customers: 0 }];
    var html = render(p);
    // One point cannot make a line; the x() divisor would be zero.
    if (/NaN|Infinity/.test(html)) return 'emitted NaN/Infinity into the SVG';
    return true;
});

t('the "why this is NOT flagged" sentence still reaches the screen', function () {
    var html = render(PAYLOAD);
    // OVL conversion is under 85% and deliberately unflagged. If the tab hides
    // that sentence, the board looks like it is ignoring a number.
    return html.indexOf('no day is further below target than its volume explains') >= 0
        || 'the ok-state explanation was dropped';
});

t('the severity class lands on the note, so the label colours and the prose does not', function () {
    var html = render(PAYLOAD);
    return /class="dcw-note dc-bad"/.test(html)
        || 'expected the critical note to carry dc-bad on .dcw-note';
});

t('the caption counts the stores needing attention', function () {
    var html = render(PAYLOAD);
    return /<b>2<\/b> of 3 stores need attention/.test(html)
        || 'caption did not count 2 of 3: ' + (html.match(/dcw-cap-l[^<]*<[^>]*>[^<]*/) || [''])[0];
});

t('an all-clear district says so instead of showing a zero', function () {
    var p = JSON.parse(JSON.stringify(PAYLOAD));
    p.flags = p.flags.map(function (f) { f.state = 'ok'; return f; });
    var html = render(p);
    if (/need attention/.test(html)) return 'still worded as if something were flagged';
    return /All 3 stores clear/.test(html) || 'expected an all-clear caption';
});

t('the caption is the date and nothing else', function () {
    var html = render(PAYLOAD);
    var cap = (html.match(/dcw-cap-r[^>]*>([^<]*)/) || ['', ''])[1];
    if (!/^Through /.test(cap)) return 'caption does not start with "Through": ' + cap;
    // The targets used to trail this line; they moved onto the column headers.
    return !/target|%/.test(cap) || 'the caption still carries targets: ' + cap;
});

t('each column header states the target it judges against', function () {
    var html = render(PAYLOAD);
    var miss = [];
    if (!/Customer conversion &middot; target 85\.0%/.test(html)) miss.push('conversion');
    if (!/Buy margin &middot; target 53\.0%/.test(html))          miss.push('margin');
    if (!/Listing this week &middot; target 100%/.test(html))     miss.push('listing');
    return miss.length === 0 || 'headers missing their target: ' + miss.join(', ');
});

t('the Status header explains what warning and critical mean', function () {
    // The methodology paragraph under the table was cut on 2026-09-21. This
    // tooltip is now the ONLY place the rule is written down in the app.
    var html = render(PAYLOAD);
    var m = html.match(/<th title="([^"]*)">Status<\/th>/);
    if (!m) return 'the Status header has no tooltip';
    var tip = m[1];
    var miss = ['WARNING', 'CRITICAL'].filter(function (w) { return tip.indexOf(w) < 0; });
    if (miss.length) return 'the tooltip never says: ' + miss.join(', ');
    // Built from config, so re-tuning cannot leave it lying. Every live
    // threshold has to appear: the pooled and per-day margin floors, the
    // recovery ceiling, and the weekly listing floor.
    var want = ['$750', '$150', '60.0%', '25 devices'];
    var gone = want.filter(function (w) { return tip.indexOf(w) < 0; });
    return gone.length === 0
        || 'the tooltip does not carry: ' + gone.join(', ') + ' — ' + tip.slice(0, 240);
});

t('the Status tooltip says listing is judged by the WEEK, and why red is red', function () {
    // The three metrics no longer share a frame: conversion and margin are read
    // over the rolling window, listing over Monday-to-Saturday. A tooltip that
    // implied one frame for all three would be the single most misleading
    // sentence on the board.
    var html = render(PAYLOAD);
    var tip = (html.match(/<th title="([^"]*)">Status<\/th>/) || ['', ''])[1];
    if (!/working week|Monday to Saturday/i.test(tip)) return 'the weekly frame is not stated';
    if (!/caught up|catch/i.test(tip)) return 'the critical rule does not mention catching up';
    return /can no longer reach/.test(tip)
        || 'the month-lost rule is missing for conversion and margin';
});

t('margin critical is the month-lost test, not a dollar floor', function () {
    // 0100 retired gp_short_red. If the tooltip still quotes a red dollar
    // figure it is describing a rule the engine no longer runs.
    var html = render(PAYLOAD);
    var tip = (html.match(/<th title="([^"]*)">Status<\/th>/) || ['', ''])[1];
    var crit = tip.slice(tip.indexOf('CRITICAL'));
    return !/\$[\d,]+ behind/.test(crit)
        || 'the CRITICAL section still quotes a dollar floor: ' + crit.slice(0, 160);
});

t('the Status tooltip follows the config rather than hardcoding', function () {
    var p = JSON.parse(JSON.stringify(PAYLOAD));
    p.config.gp_short_min = 9999;
    p.config.conv_target = 90;
    p.config.listing_catchup_mult = 1.5;
    var tip = (render(p).match(/<th title="([^"]*)">Status<\/th>/) || ['', ''])[1];
    if (tip.indexOf('$9,999') < 0) return 'a re-tuned margin floor did not reach the tooltip';
    if (tip.indexOf('50%') < 0) return 'a re-tuned catch-up multiplier did not reach the tooltip';
    return tip.indexOf('90.0%') >= 0 || 'a re-tuned conversion target did not reach the tooltip';
});

t('the methodology paragraph under the table is gone', function () {
    var html = render(PAYLOAD);
    return !/dcw-foot/.test(html)
        || 'the footnote is still rendered under the board';
});

t('the judged day is labelled, and it is the judged day not today', function () {
    var html = render(PAYLOAD);
    return /Through Sat, Sep 19/.test(html)
        || 'expected the 2026-09-19 date in the caption, got: '
           + (html.match(/Through [^<&]*/) || ['(none)'])[0];
});

t('a reason from the server is escaped before it is written into the row', function () {
    var p = JSON.parse(JSON.stringify(PAYLOAD));
    p.flags = [{ store: 'OVL', metric: 'margin', state: 'warn', value: 50, target: 54.5,
                 sample_n: 1000, sample_k: null, p_value: null, shortfall: 300, streak: 1,
                 reason: '<img src=x onerror="alert(1)">' }];
    var html = render(p);
    if (/<img src=x/.test(html)) return 'the reason was written in raw';
    return /&lt;img/.test(html) || 'expected the reason to come through escaped';
});

t('every store row opens that store’s popup', function () {
    // Was _dcDrill (jump to Store Breakdown) until 2026-09-21. The Watch tab is
    // a triage list read top-down, and swapping the tab underneath the DM lost
    // their place in it. district-watch-popup-check.js covers the popup itself.
    var html = render(PAYLOAD);
    if (/_dcDrill\(/.test(html)) return 'a row still swaps to the Store Breakdown tab';
    return (html.indexOf("_dcwOpen('OVL')") >= 0 && html.indexOf("_dcwOpen('WSP')") >= 0)
        || 'rows are not wired to _dcwOpen';
});
