// Live Dashboard MONTH-TAB harness.
//
//   node scripts/lv-month-check.js [--mode=mtd] [--shot=out.png]
//
// Renders the REAL _lv* functions out of speeks.js against a fixture built from
// the real app_cache payload (scripts/lv-month-fixture.json), screenshots the
// result, and asserts the arithmetic. Two things it exists to catch:
//
//   1. That the Month tab really stopped at the last COMPLETE day. Every figure on
//      it has to reconcile to the edge function's month-at-yesterday's-close, and
//      the ones that give the game away are the goal bar and the pace pill: they
//      read mtdGp and paceIndex directly rather than through the day fields, so a
//      rebase that only moved the day fields would look right and be wrong.
//   2. That the district year-over-year is same-store on BOTH sides. Summing five
//      stores now against the three that traded last August is the exact mistake
//      that shows +51% growth for two shop openings, and it is invisible in a
//      screenshot.
//
// Loads speeks.js in a real page rather than extracting the functions: an
// extracted copy drifts from the file it came out of, which is the one failure
// mode a harness must not have.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const args = process.argv.slice(2);
const mode = (args.find(a => a.startsWith('--mode=')) || '--mode=mtd').split('=')[1];
const width = parseInt((args.find(a => a.startsWith('--width=')) || '--width=1400').split('=')[1], 10);
const shot = path.resolve((args.find(a => a.startsWith('--shot=')) || '').split('=')[1]
    || 'lv-month-' + mode + (width === 1400 ? '' : '-' + width) + '.png');

const F = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/lv-month-fixture.json'), 'utf8'));
const NAMES = { OVL: 'Overland Park', LEE: 'Lees Summit', WSP: 'Westport', MPL: 'Maplewood', BAL: 'Ballwin' };
const ORDER = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];

// A whole finished month, the shape cmpSpans now emits.
const month = (f) => {
    const last = new Date(Date.UTC(+f.ym.slice(0, 4), +f.ym.slice(5, 7), 0)).getUTCDate();
    return Object.assign({
        from: f.ym + '-01',
        to: f.ym + '-' + String(last).padStart(2, '0'),
        days: last, ym: f.ym,
    }, f, { cogs: +(f.net - f.gp).toFixed(2), returns: 0 });
};

// The payload the browser path serves. Today's own figures are deliberately
// DIFFERENT from the month's, so a renderer still reading the live month instead
// of the closed-out one shows up as a wrong number rather than as a coincidence.
const payload = {
    asOfCentral: F.asOfCentral, open: F.open, month: F.month, prev: F.prev,
    cmpThrough: F.cmpThrough, scope: F.scope,
    district: {
        netToday: 14995.39, cogsToday: 6919.61, gpToday: 8075.78, ordersToday: 79,
        returnsToday: 4595.81, marginToday: 53.86, aov: 189.82,
        mtdNet: 330887.70, mtdGp: 183047.35, mtdReturns: 42882.67, mtdMargin: 55.32,
        goal: F.distGoal, pctOfGoal: 55.13, storesReporting: 5, storesTotal: 5,
        prev: F.distPrev,
    },
    stores: ORDER.map(function (code, i) {
        return {
            code: code, name: NAMES[code], goal: F.goals[code],
            netToday: 2000 + i * 500, cogsToday: 900 + i * 200, gpToday: 1100 + i * 300,
            ordersToday: 10 + i, returnsToday: i * 100, marginToday: 50 + i, aov: 150 + i,
            mtdNet: F.prevs[code].mtdNet + 2000 + i * 500,
            mtdCogs: F.prevs[code].mtdCogs + 900 + i * 200,
            mtdGp: F.prevs[code].mtdGp + 1100 + i * 300,
            mtdOrders: F.prevs[code].mtdOrders + 10 + i,
            mtdReturns: F.prevs[code].mtdReturns + i * 100,
            mtdMargin: 54, pctOfGoal: 60, paceIndex: 111,
            lastOrderAt: '2026-08-17T21:40:00Z', lastOrderAmount: 129.99, recentOrders: [],
            prev: F.prevs[code],
            cmp: {
                through: F.cmpThrough, days: 16,
                lastMonth: month(F.cmp[code].lm),
                lastYear: month(F.cmp[code].ly),
            },
        };
    }),
};

// Buying rides the sheet's 31-slot daily arrays, not the Shopify feed. Day 17 is
// POISONED: a day's purchases are keyed the following morning, so the 17th cannot
// legitimately be in a month that runs to the 16th, and a buying total that
// includes 999,999 proves the buying span did not follow the selling span back.
// Slot 0 is day 1. Sundays are real zeros — the stores shut and only the webstore
// trades — so a couple are left at 0 deliberately.
const DAY_BUY = 4000, POISON = 999999;
F.hub.wkBuy = {}; F.hub.wkSell = {}; F.hub.wkBuyMarginPct = {};
ORDER.forEach(function (code, si) {
    const buy = [], sell = [], mar = [];
    for (let day = 1; day <= 31; day++) {
        const sunday = (day % 7 === 2);            // arbitrary but fixed
        buy.push(day === 17 ? POISON : (day <= 16 && !sunday ? DAY_BUY + si * 200 : 0));
        sell.push(day <= 16 ? 3000 + si * 150 : 0);
        mar.push(0.55);
    }
    F.hub.wkBuy[code] = buy; F.hub.wkSell[code] = sell; F.hub.wkBuyMarginPct[code] = mar;
});
// What the buying total MUST be if the span stops at the 16th: 14 open days
// (16 less the two Sundays in slots 1-16) at each store's daily figure.
const WANT_BUY = ORDER.reduce(function (a, code, si) {
    return a + F.hub.wkBuy[code].slice(0, 16).reduce(function (x, y) { return x + y; }, 0);
}, 0);

const HARNESS = '_lv-harness.html';
// styles.css sets body{display:flex} for the sidebar shell. Left alone, every
// harness card sits in a row and every table is crushed to nothing.
fs.writeFileSync(path.join(REPO, HARNESS), [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link rel="stylesheet" href="styles.css">',
    '<style>',
    '  body { display: block !important; background: #f6f8fa; padding: 24px; }',
    '  .hcard { background:#fff; border:1px solid #e6ebf1; border-radius:14px;',
    '           padding:18px; margin:0 auto 24px; max-width:1280px; }',
    '  @media (max-width:900px){ body{padding:0} .hcard{padding:8px 0; border-radius:0} }',
    '  .hcard > h3 { font:800 12px/1 system-ui; letter-spacing:.1em; text-transform:uppercase;',
    '                color:#94a3b8; margin:0 0 14px; }',
    '</style></head><body>',
    // Mirrors index.html exactly: .lv-dist-strip does NOT carry .lv-strip. Giving
    // it both makes the store branch's querySelectorAll('.lv-strip') overwrite the
    // district tiles with the own-store ones — which looks like a code bug and is
    // a harness bug. .cc-strip is opacity:0 until .cc-active.
    '<div class="hcard"><h3>District &mdash; tiles</h3><div class="lv-dist-strip"></div></div>',
    '<div class="hcard"><h3>District &mdash; detail</h3><div class="lv-dist-detail"></div></div>',
    '<div class="hcard"><h3>Store (manager) &mdash; tiles</h3><div class="cc-strip s4 lv-strip cc-active"></div></div>',
    '<div class="hcard"><h3>Store (manager) &mdash; detail</h3><div class="lv-detail"></div></div>',
    '<script src="speeks.js"></script>',
    '</body></html>',
].join('\n'));

// --first simulates the 1ST OF THE MONTH, when the previous day belongs to LAST
// month and there is no complete day in this one. The Month tab must be withdrawn
// rather than shown full of zeros, and anyone standing on it moved to Today.
if (args.indexOf('--first') >= 0) {
    payload.prev.inMonth = false;
    payload.prev.date = '2026-07-31';
    payload.prev.daysElapsed = null;
    payload.month = { daysTotal: 31, daysElapsed: 1, elapsedPct: 3.23 };
    payload.cmpThrough = null;
    payload.stores.forEach(function (m) { m.cmp = null; });
}

(async function () {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });
    const page = await browser.newPage();
    // isMobile matters: without touch emulation Chrome ignores the viewport meta
    // tag and reports overflow that does not exist on a real phone.
    await page.setViewport({ width: width, height: 1200, deviceScaleFactor: 2,
        isMobile: width <= 900, hasTouch: width <= 900 });
    const errs = [];
    page.on('pageerror', function (e) { errs.push(String(e).slice(0, 200)); });
    await page.evaluateOnNewDocument(function () {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Layout Harness');
        sessionStorage.setItem('speeksUserRole', 'district manager');
        sessionStorage.setItem('speeksUserStore', 'OVL');
        sessionStorage.setItem('speeksUserPin', '0000');
    });
    await page.goto('file:///' + REPO + '/' + HARNESS,
        { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(function () {});

    const out = await page.evaluate(function (payload, hub, mode) {
        // hubDataCache is declared `let` at the top of speeks.js, so it is a
        // script-scope lexical binding and NOT a property of window. Assigning
        // window.hubDataCache leaves _lvHub() returning null, which silently drops
        // the whole Tracking band and the buying table — the bare assignment is
        // what reaches the binding the page actually reads.
        hubDataCache = hub;
        _lvData = payload;
        _lvMode = mode;
        renderLiveDashboard();
        const txt = function (s) { return (document.querySelector(s) || {}).innerText || ''; };
        // Recomputed through the PAGE's own helpers off the same payload it just
        // rendered, so the harness cannot agree with itself by keeping a second
        // copy of the arithmetic.
        const views = payload.stores.map(_lvView);
        const ly = _lvCmpSum(views, 'lastYear');
        const lm = _lvCmpSum(views, 'lastMonth');
        return {
            dist: txt('.lv-dist-detail'), strip: txt('.lv-dist-strip'), store: txt('.lv-detail'),
            headStamp: _lvHeadStamp(payload), stamp: _lvStamp(payload),
            days: _lvDays(payload), elapsedPct: _lvElapsedPct(payload),
            buySpan: _lvBuySpan(payload), mtdReady: _lvMtdReady(payload),
            // Read back AFTER the render, because _lvGuardMode rewrites it.
            mode: _lvMode,
            // Day 17 is poisoned in the fixture, so a buying total that includes it
            // proves the buying span did not follow the selling span back to the
            // 16th. Read through the page's own summing helper.
            buyTotal: _lvBuySum(payload.stores.map(function (m) { return _lvBuyFor(m.code, payload); })).bought,
            fc: !!_lvFcSum(views),
            views: views.map(function (v) {
                return { code: v.code, net: v.netToday, gp: v.gpToday, mtdGp: v.mtdGp, pace: v.paceIndex };
            }),
            ly: ly && { codes: ly.codes, missing: ly.missing, partial: ly.partial,
                        thenNet: ly.thenNet, thenResale: ly.thenResale,
                        fcRev: ly.fc && ly.fc.trackRev, buyProj: ly.buyFc && ly.buyFc.buyProj },
            lm: lm && { codes: lm.codes, missing: lm.missing, partial: lm.partial,
                        thenNet: lm.thenNet, thenResale: lm.thenResale,
                        fcRev: lm.fc && lm.fc.trackRev, buyProj: lm.buyFc && lm.buyFc.buyProj },
            // The rendered rows, so placement is asserted and not just the maths.
            fcRows: [].slice.call(document.querySelectorAll('.lv-dist-detail .lv-fc-strip .cc-cell'))
                .map(function (el) {
                    const k = el.querySelector('.sh-k');
                    return {
                        tile: k ? k.innerText.trim() : '',
                        rows: [].slice.call(el.querySelectorAll('.bd-cmp')).map(function (r) {
                            // textContent, not innerText: these spans are laid out in a
                            // grid and innerText was returning only the first cell.
                            return r.textContent.replace(/s+/g, ' ').trim();
                        }),
                    };
                }),
            // Scoped to the new band, because two overflows outside it predate this
            // work and are not this change's to fix: the tile sub-lines (.sh-sub),
            // which do it on the Today tab as well, and one buying-table TH on the
            // Month tab, where the Reviews column makes six columns share the 720px
            // phone floor. Verified against HEAD: the diff adds no <th> outside the
            // comparison band. Printed as a note so a NEW one still shows up.
            // Computed columns on the Tracking strip, so a rule that lost an
            // ordering fight shows as a number rather than as a mystery overflow.
            fcCols: [].slice.call(document.querySelectorAll('.lv-fc-strip')).map(function (el) {
                return getComputedStyle(el).gridTemplateColumns + ' @' + el.clientWidth
                    + ' row=' + (el.querySelector('.bd-tile-row')
                        ? getComputedStyle(el.querySelector('.bd-tile-row')).display : '-');
            }),
            wideBand: [].slice.call(document.querySelectorAll('.lv-cmp-band *')).filter(function (el) {
                return el.scrollWidth > el.clientWidth + 2
                    && !el.classList.contains('lv-tbl-scroll');
            }).map(function (el) {
                return (el.className || el.tagName) + ' ' + el.scrollWidth + '>' + el.clientWidth;
            }),
            wide: [].slice.call(document.querySelectorAll('.hcard *')).filter(function (el) {
                return el.scrollWidth > el.clientWidth + 2
                    && !el.classList.contains('lv-tbl-scroll');
            }).map(function (el) {
                return (el.className || el.tagName) + ' ' + el.scrollWidth + '>' + el.clientWidth;
            }).slice(0, 6),
            // A horizontally scrolling PAGE is the mobile failure that matters. A
            // wide table is fine as long as it scrolls inside its own box, which is
            // why .lv-tbl-scroll is exempt above and the body is checked here.
            bodyWide: document.body.scrollWidth,
            viewport: window.innerWidth,
        };
    }, payload, F.hub, mode);

    await page.screenshot({ path: shot, fullPage: true });
    await browser.close();
    fs.unlinkSync(path.join(REPO, HARNESS));

    if (errs.length) console.log('PAGE ERRORS: ' + errs.join(' | '));
    console.log('--- labels');
    console.log('  headStamp  ' + out.headStamp);
    console.log('  tileStamp  ' + out.stamp);
    console.log('  days       ' + out.days + '   elapsedPct ' + out.elapsedPct);
    console.log('  buySpan    ' + JSON.stringify(out.buySpan) + '   mtdReady ' + out.mtdReady);
    console.log('--- views (must be the month at the close of the 16th)');
    out.views.forEach(function (v) {
        console.log('   ' + v.code + '  net ' + v.net + '  gp ' + v.gp + '  mtdGp ' + v.mtdGp + '  pace ' + v.pace);
    });
    console.log('--- tiles');
    out.fcRows.forEach(function (t) { console.log('   ' + t.tile + '  ||  ' + t.rows.join('  ||  ')); });
    console.log('--- same-store sums');
    console.log('  lastMonth ' + JSON.stringify(out.lm));
    console.log('  lastYear  ' + JSON.stringify(out.ly));
    console.log('  fc columns: ' + out.fcCols.join('  |  '));
    if (out.wide.length) console.log('OVERFLOW: ' + out.wide.join(' | '));

    let bad = 0;
    const ok = function (name, cond, detail) {
        console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
        if (!cond) bad++;
    };
    console.log('--- assertions');
    // With --first the page falls back to Today, so the Month assertions below do
    // not apply — they are replaced by the withdrawal checks further down.
    if (mode === 'mtd' && args.indexOf('--first') < 0) {
        ok('month runs to the last complete day (16, not 17)', out.days === 16, 'days=' + out.days);
        ok('head stamp names the closed span', /1–16$/.test(out.headStamp), out.headStamp);
        ok('buying span matches the selling span',
            !!out.buySpan && out.buySpan.from === 1 && out.buySpan.to === 16, JSON.stringify(out.buySpan));
        out.views.forEach(function (v) {
            const want = F.prevs[v.code];
            ok(v.code + ' net is the month at close of the 16th',
                Math.abs(v.net - want.mtdNet) < 0.005, v.net + ' vs ' + want.mtdNet);
            ok(v.code + ' goal-bar GP rebased too',
                Math.abs(v.mtdGp - want.mtdGp) < 0.005, v.mtdGp + ' vs ' + want.mtdGp);
            ok(v.code + ' pace is the closed-day pace', v.pace === want.paceIndex,
                v.pace + ' vs ' + want.paceIndex);
        });
        const sum = ORDER.reduce(function (a, c) { return a + F.prevs[c].mtdNet; }, 0);
        ok('the five closed months sum to the district figure',
            Math.abs(sum - F.distPrev.mtdNet) < 0.02, sum.toFixed(2) + ' vs ' + F.distPrev.mtdNet);
        ok('YoY counts only the stores that traded last August',
            !!out.ly && out.ly.codes.join(',') === 'OVL,LEE,WSP', out.ly && out.ly.codes.join(','));
        ok('YoY names the two that did not',
            !!out.ly && out.ly.missing.join(',') === 'MPL,BAL', out.ly && out.ly.missing.join(','));
        // Both sides same-store: the PROJECTION is summed over the same three
        // stores as the 2025 figure it is measured against.
        const lyThen = F.cmp.OVL.ly.net + F.cmp.LEE.ly.net + F.cmp.WSP.ly.net;
        const lyProj = F.hub.ovlTrackRev + F.hub.leeTrackRev + F.hub.wspTrackRev;
        ok('YoY last-year revenue is the three-store sum',
            !!out.ly && Math.abs(out.ly.thenNet - lyThen) < 0.02,
            (out.ly && out.ly.thenNet) + ' vs ' + lyThen.toFixed(2));
        ok('YoY projection side excludes MPL and BAL too',
            !!out.ly && Math.abs(out.ly.fcRev - lyProj) < 0.02,
            (out.ly && out.ly.fcRev) + ' vs ' + lyProj.toFixed(2));
        const allProj = ORDER.reduce(function (a, c) { return a + F.hub[c.toLowerCase() + 'TrackRev']; }, 0);
        ok('YoY projection is NOT the all-store projection',
            !!out.ly && Math.abs(out.ly.fcRev - allProj) > 1);
        ok('MoM counts all five', !!out.lm && out.lm.codes.length === 5,
            out.lm && String(out.lm.codes.length));
        // Buying: last month from daily_buysell, last year from the 2025 history.
        const lmRes = ORDER.reduce(function (a, c) { return a + F.cmp[c].lm.resale; }, 0);
        const lyRes = F.cmp.OVL.ly.resale + F.cmp.LEE.ly.resale + F.cmp.WSP.ly.resale;
        ok('buying MoM sums every store resale value',
            !!out.lm && Math.abs(out.lm.thenResale - lmRes) < 0.02,
            (out.lm && out.lm.thenResale) + ' vs ' + lmRes.toFixed(2));
        ok('buying YoY is same-store too',
            !!out.ly && Math.abs(out.ly.thenResale - lyRes) < 0.02,
            (out.ly && out.ly.thenResale) + ' vs ' + lyRes.toFixed(2));
        // ---- placement: the rows are ON the Tracking tiles, not in a section ----
        ok('no separate comparison section', !/Against last month/i.test(out.dist + out.store));
        // innerText applies text-transform, and .sh-k is uppercased — so the tile
        // captions come back as "TRACKING BUYING". Keyed upper on both sides.
        const byTile = {};
        out.fcRows.forEach(function (t) { byTile[t.tile.toUpperCase()] = t.rows; });
        ['Tracking Buying', 'Tracking Revenue', 'Tracking Net Profit', 'Tracking Gross Profit']
            .forEach(function (name) {
                const rows = byTile[name.toUpperCase()] || [];
                ok(name + ' carries both comparison rows', rows.length === 2, rows.join(' / '));
            });
        ok('last month is named, not dated', /July/.test((byTile['TRACKING REVENUE'] || []).join(' ')),
            (byTile['TRACKING REVENUE'] || []).join(' / '));
        ok('last year carries its year', /Aug 2025/.test((byTile['TRACKING REVENUE'] || []).join(' ')),
            (byTile['TRACKING REVENUE'] || []).join(' / '));
        ok('a partial year-over-year says how many stores',
            /3 Of 5/.test((byTile['TRACKING REVENUE'] || []).join(' ')),
            (byTile['TRACKING REVENUE'] || []).join(' / '));
        ok('reviews get no comparison row',
            !byTile['TRACKING GOOGLE REVIEWS'] || byTile['TRACKING GOOGLE REVIEWS'].length === 0);
        ok('no pulsing "in progress" pill on a closed month',
            !/in progress/.test(out.strip + out.dist));
        ok('buying stops at the 16th (day 17 excluded)',
            Math.abs(out.buyTotal - WANT_BUY) < 0.5, out.buyTotal + ' vs ' + WANT_BUY);
        ok('the Tracking band still renders beside the new one', out.fc === true);
        ok('Tracking to Goal reached the headline tile', /Tracking to Goal/i.test(out.strip), '');
    }
    // The other two tabs share every helper this change touched — _lvDays,
    // _lvElapsedPct, _lvHasMonth, _lvBuySpan, _lvFreshness and the roll-up's day
    // count — so they are checked here rather than left to be noticed later.
    if (mode === 'today') {
        ok('Today still counts today', out.days === 17, 'days=' + out.days);
        // innerText applies text-transform, so the pill reads OPEN, not open.
        ok('Today keeps the live dot', /open|closed/i.test(out.strip + out.store));
        ok('Today has no comparison band', !/Against last month/i.test(out.dist + out.store));
        ok('Today buys one day only',
            !!out.buySpan && out.buySpan.from === 17 && out.buySpan.to === 17, JSON.stringify(out.buySpan));
    }
    if (mode === 'prev') {
        ok('Yesterday counts complete days', out.days === 16, 'days=' + out.days);
        ok('Yesterday has no comparison band', !/Against last month/i.test(out.dist + out.store));
        ok('Yesterday buys the 16th alone',
            !!out.buySpan && out.buySpan.from === 16 && out.buySpan.to === 16, JSON.stringify(out.buySpan));
        ok('Yesterday reads final', /final/i.test(out.store));
    }
    if (args.indexOf('--first') >= 0) {
        ok('the Month tab is withdrawn on the 1st', out.mtdReady === false);
        ok('a viewer left on it is moved to Today', out.mode === 'today', 'mode=' + out.mode);
        ok('no Month button is offered', !/Month/.test(out.store), '');
        ok('no comparison band', !/Against last month/i.test(out.dist + out.store));
    }
    ok('no page errors', errs.length === 0);
    if (out.wide.length) console.log('  (pre-existing, outside the band: ' + out.wide.join(' | ') + ')');
    ok('nothing in the comparison band overflows', out.wideBand.length === 0, out.wideBand.join(' | '));
    ok('the page itself does not scroll sideways',
        out.bodyWide <= out.viewport + 2, out.bodyWide + ' vs ' + out.viewport);
    console.log('\n' + (bad ? bad + ' FAILED' : 'all assertions passed') + '   ->  ' + shot);
    process.exit(bad ? 1 : 0);
})();
