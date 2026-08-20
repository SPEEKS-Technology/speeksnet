// Phone Live Dashboard — the STORE-SCOPED cases.
//
//   node scripts/lv-phone-check.js        (needs puppeteer-core; LV_SHOT_DIR= to move the shots)
//
// lv-month-check.js runs as a district manager, so it only ever proves the
// district rendering. The user's requirement is the other half: on a phone a
// store sees ITS OWN figures and not the district, while DM/CEO keep the
// district. Two paths reach a store card and they are not the same code:
//
//   A. role=manager on a payload that DOES carry the district (what the server
//      sends today). _lvCards filters the five stores down to _lvOwnCode.
//   B. role=manager on a single-store payload with no district — the
//      `stores.length === 1` branch, which draws no table at all and therefore
//      had no cards until they were added to it.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const OUT = process.env.LV_SHOT_DIR || __dirname;
const F = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/lv-month-fixture.json'), 'utf8'));
const ORDER = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
const NAMES = { OVL: 'Overland Park', LEE: 'Lees Summit', WSP: 'Westport', MPL: 'Maplewood', BAL: 'Ballwin' };

// Same buying fixture shape lv-month-check builds, minus the poison day.
F.hub.wkBuy = {}; F.hub.wkSell = {}; F.hub.wkBuyMarginPct = {};
ORDER.forEach((code, si) => {
    const buy = [], sell = [], mar = [];
    for (let day = 1; day <= 31; day++) {
        // NOT the 16th: fixture prev is 2026-08-16, and a zero-buy day there would
        // make every Yesterday assertion exercise the closed-day path instead.
        const sunday = [3, 10, 17, 24, 31].indexOf(day) >= 0;
        buy.push(day <= 16 && !sunday ? 2000 + si * 200 : 0);
        sell.push(day <= 16 ? 3000 + si * 150 : 0);
        mar.push(0.55);
    }
    F.hub.wkBuy[code] = buy; F.hub.wkSell[code] = sell; F.hub.wkBuyMarginPct[code] = mar;
});

const store = (code, i) => ({
    code, name: NAMES[code],
    netToday: 2000 + i * 500, cogsToday: 900 + i * 200, gpToday: 1100 + i * 300,
    ordersToday: 10 + i, returnsToday: 0, marginToday: 50 + i, aov: 150,
    mtdNet: F.prevs[code].mtdNet, mtdCogs: F.prevs[code].mtdCogs, mtdGp: F.prevs[code].mtdGp,
    mtdOrders: F.prevs[code].mtdOrders, mtdReturns: F.prevs[code].mtdReturns,
    mtdMargin: F.prevs[code].mtdMargin, goal: F.goals[code],
    pctOfGoal: F.prevs[code].pctOfGoal, paceIndex: F.prevs[code].paceIndex,
    prev: F.prevs[code], cmp: F.cmp[code], lastOrderAt: null,
});

const base = {
    asOfCentral: F.asOfCentral, open: F.open, month: F.month, prev: F.prev,
    cmpThrough: F.cmpThrough,
};

const CASES = [
    {
        name: 'A · manager, district payload (what the server sends today)',
        role: 'manager', store: 'LEE',
        payload: Object.assign({}, base, {
            scope: { role: 'manager', store: 'LEE', district: true },
            district: {
                netToday: 14995.39, cogsToday: 6919.61, gpToday: 8075.78, ordersToday: 79,
                returnsToday: 0, marginToday: 53.86, aov: 189.82,
                mtdNet: 330887.70, mtdGp: 183047.35, mtdReturns: 0, mtdMargin: 55.32,
                goal: F.distGoal, pctOfGoal: 55.13, prev: F.distPrev,
            },
            stores: ORDER.map(store),
        }),
        wantCards: 1, wantCode: 'LEE', wantPicks: 0,
    },
    {
        name: 'B · manager, single-store payload (no district)',
        role: 'manager', store: 'LEE',
        payload: Object.assign({}, base, {
            scope: { role: 'manager', store: 'LEE', district: false },
            district: null,
            stores: [store('LEE', 1)],
        }),
        wantCards: 1, wantCode: 'LEE', wantPicks: 0,
    },
    {
        name: 'C · district manager keeps the district (5 stores + roll-up)',
        role: 'district manager', store: '',
        payload: Object.assign({}, base, {
            scope: { role: 'district manager', store: '', district: true },
            district: {
                netToday: 14995.39, cogsToday: 6919.61, gpToday: 8075.78, ordersToday: 79,
                returnsToday: 0, marginToday: 53.86, aov: 189.82,
                mtdNet: 330887.70, mtdGp: 183047.35, mtdReturns: 0, mtdMargin: 55.32,
                goal: F.distGoal, pctOfGoal: 55.13, prev: F.distPrev,
            },
            stores: ORDER.map(store),
        }),
        wantCards: 1, wantCode: 'District', wantPicks: 6,
    },
];

const HARNESS = '_lv-store-harness.html';
fs.writeFileSync(path.join(REPO, HARNESS), [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link rel="stylesheet" href="styles.css">',
    '<style>body{display:block !important;background:#f6f8fa;margin:0}</style>',
    '</head><body>',
    // Ids copied from index.html, because the mobile rules hide #cc-strip-live by
    // id — a classless stand-in would stay visible here and pass a test the real
    // page fails.
    '<div class="cc-strip s4 lv-strip cc-active" id="cc-strip-live"></div>',
    '<div class="lv-detail"></div>',
    '<div class="lv-dist-strip"></div>',
    '<div class="lv-dist-detail"></div>',
    '<script src="speeks.js"></script>',
    '</body></html>',
].join('\n'));

let fails = 0;
const ok = (cond, label, got) => {
    console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + label + (got === undefined ? '' : '   ' + got));
    if (!cond) fails++;
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });

    for (const c of CASES) {
        for (const mode of ['today', 'prev', 'mtd']) {
            const page = await browser.newPage();
            await page.setViewport({ width: 390, height: 1400, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
            const errs = [];
            page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
            await page.evaluateOnNewDocument((role, st) => {
                sessionStorage.setItem('speeksUnlocked', 'true');
                sessionStorage.setItem('speeksUserName', 'Layout Harness');
                sessionStorage.setItem('speeksUserRole', role);
                sessionStorage.setItem('speeksUserStore', st);
                sessionStorage.setItem('speeksUserPin', '0000');
            }, c.role, c.store);
            await page.goto('file:///' + REPO + '/' + HARNESS, { waitUntil: 'domcontentloaded' }).catch(() => {});

            const r = await page.evaluate((payload, hub, mode) => {
                hubDataCache = hub;
                _lvData = payload;
                _lvMode = mode;
                renderLiveDashboard();
                const host = document.querySelector('.lv-detail');
                const cards = Array.from(host.querySelectorAll('.lvc'));
                const vis = sel => Array.from(host.querySelectorAll(sel))
                    .filter(el => getComputedStyle(el).display !== 'none').length;
                const stripVis = getComputedStyle(document.getElementById('cc-strip-live')).display !== 'none';
                return {
                    mode: _lvMode,
                    codes: cards.map(el => (el.querySelector('.lvc-h b') || {}).textContent || ''),
                    keys: cards.length ? Array.from(cards[0].querySelectorAll('.lvc-k')).map(e => e.textContent) : [],
                    legend: (host.querySelector('.lv-cards-legend') || {}).textContent || '',   // must stay empty: the paragraph was cut 19 Aug
                    picks: Array.from(host.querySelectorAll('.lv-pickopt')).map(e => e.textContent.trim()),
                    picked: (host.querySelector('.lv-pickcur') || {}).textContent || '',
                    extras: ['.bd-open', '.lv-full'].map(sel => Array.from(document.querySelectorAll(sel)).filter(e => getComputedStyle(e).display !== 'none').length).reduce((a,b)=>a+b,0),
                    // Everything the phone build is meant to have hidden.
                    leftovers: {
                        tiles: stripVis,
                        table: vis('.lv-tbl-scroll'), split: vis('.lv-split'),
                        chips: vis('.lv-chips'), goalbar: vis('.lv-goal'),
                        activity: vis('.lv-activity-row'), last: vis('.lv-last'),
                        fc: vis('.lv-fc-strip'), buy: vis('.lv-buy-strip'),
                    },
                    docW: document.documentElement.scrollWidth,
                };
            }, c.payload, F.hub, mode);

            console.log('\n' + c.name + '  [' + mode + ' -> ' + r.mode + ']');
            ok(r.codes.length === c.wantCards, 'card count', r.codes.length + ' (' + r.codes.join(',') + ')');
            ok(r.codes[0] === c.wantCode, 'first card is ' + c.wantCode, r.codes[0]);
            const wantKeys = r.mode === 'today'
                ? ['Net Sales', 'Gross Profit', 'Margin']
                : ['Net Sales', 'Gross Profit', 'Margin', 'Bought Value'];
            ok(JSON.stringify(r.keys) === JSON.stringify(wantKeys), 'figures on the card', r.keys.join(' / '));
            ok(r.legend === '', 'no legend paragraph over the cards', JSON.stringify(r.legend));
            const L = r.leftovers;
            ok(!L.tiles, 'headline tiles hidden');
            ok(!L.table && !L.split && !L.chips && !L.goalbar && !L.activity && !L.last && !L.fc && !L.buy,
                'nothing but the cards left', JSON.stringify(L));
            ok(r.picks.length === c.wantPicks, 'dropdown option count', r.picks.join(',') || '(none)');
            if (c.wantPicks) ok(r.picked.trim() === c.wantCode, 'roll-up is selected on arrival', r.picked.trim());
            ok(r.extras === 0, 'Daily Breakdown and full screen are gone', r.extras);
            ok(r.docW <= 390, 'no sideways scroll', r.docW);
            ok(!errs.length, 'no page errors', errs.join(' | '));

            if (mode === 'mtd') {
                await page.screenshot({ path: path.join(OUT, 'lv-store-' + c.name[0] + '.png'), fullPage: true });
            }
            await page.close();
        }
    }

    // A CLOSED Yesterday (Sunday, or a holiday) must DROP Bought Value, not print
    // $0 against it — the same rule _lvBuyBlock applies to the desktop table, and
    // the reason it exists is that every Monday the district otherwise looked like
    // it had had a catastrophic day when the stores were simply shut.
    {
        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 1400, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await page.evaluateOnNewDocument(() => {
            sessionStorage.setItem('speeksUnlocked', 'true');
            sessionStorage.setItem('speeksUserRole', 'district manager');
            sessionStorage.setItem('speeksUserStore', '');
        });
        await page.goto('file:///' + REPO + '/' + HARNESS, { waitUntil: 'domcontentloaded' }).catch(() => {});
        const shut = JSON.parse(JSON.stringify(F.hub));
        ORDER.forEach(c => { shut.wkBuy[c][15] = 0; });   // slot 15 = day 16 = prev
        const keys = await page.evaluate((payload, hub) => {
            hubDataCache = hub; _lvData = payload; _lvMode = 'prev';
            renderLiveDashboard();
            return Array.from(document.querySelectorAll('.lv-detail .lvc .lvc-k')).map(e => e.textContent);
        }, CASES[2].payload, shut);
        console.log('');
        console.log('closed Yesterday - no store bought anything');
        ok(keys.indexOf('Bought Value') < 0, 'Bought Value is dropped, not printed as $0', keys.join(' / '));
        await page.close();
    }

    await browser.close();
    try { fs.unlinkSync(path.join(REPO, HARNESS)); } catch (e) {}
    console.log(fails ? '\n' + fails + ' FAILED' : '\nall store-scope assertions passed');
    process.exit(fails ? 1 : 0);
})();
