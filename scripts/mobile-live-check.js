// The four 19-Aug critiques, checked on the REAL index.html rather than a
// harness page — the harness has no Command Center chrome, no summary strip and
// no Performance card, so it cannot prove any of them.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const OUT = process.env.LV_SHOT_DIR || __dirname;
const F = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/lv-month-fixture.json'), 'utf8'));
const ORDER = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];

F.hub.wkBuy = {}; F.hub.wkSell = {}; F.hub.wkBuyMarginPct = {};
ORDER.forEach((code, si) => {
    const buy = [], sell = [], mar = [];
    for (let day = 1; day <= 31; day++) {
        const sunday = [2, 9, 16, 23, 30].indexOf(day) >= 0;
        buy.push(day <= 16 && !sunday ? 2000 + si * 200 : 0);
        sell.push(day <= 16 ? 3000 + si * 150 : 0);
        mar.push(0.55);
    }
    F.hub.wkBuy[code] = buy; F.hub.wkSell[code] = sell; F.hub.wkBuyMarginPct[code] = mar;
});
const store = (code, i) => ({
    code, netToday: 2000 + i * 500, cogsToday: 900 + i * 200, gpToday: 1100 + i * 300,
    ordersToday: 10 + i, returnsToday: 0, marginToday: 50 + i, aov: 150,
    mtdNet: F.prevs[code].mtdNet, mtdCogs: F.prevs[code].mtdCogs, mtdGp: F.prevs[code].mtdGp,
    mtdOrders: F.prevs[code].mtdOrders, mtdReturns: F.prevs[code].mtdReturns,
    mtdMargin: F.prevs[code].mtdMargin, goal: F.goals[code],
    pctOfGoal: F.prevs[code].pctOfGoal, paceIndex: F.prevs[code].paceIndex,
    prev: F.prevs[code], cmp: F.cmp[code], lastOrderAt: null,
});
const payload = {
    asOfCentral: F.asOfCentral, open: F.open, month: F.month, prev: F.prev,
    cmpThrough: F.cmpThrough, scope: { role: 'district manager', store: '', district: true },
    district: {
        netToday: 14995.39, cogsToday: 6919.61, gpToday: 8075.78, ordersToday: 79,
        returnsToday: 0, marginToday: 53.86, aov: 189.82, mtdNet: 330887.70,
        mtdGp: 183047.35, mtdReturns: 0, mtdMargin: 55.32,
        goal: F.distGoal, pctOfGoal: 55.13, prev: F.distPrev,
    },
    stores: ORDER.map(store),
};

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
    await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Layout Harness');
        sessionStorage.setItem('speeksUserRole', 'district manager');
        sessionStorage.setItem('speeksUserStore', 'LEE');
    });
    await page.goto('file:///' + REPO + '/index.html', { waitUntil: 'networkidle2' }).catch(() => {});
    await page.evaluate(() => {
        const ov = document.getElementById('authOverlay'); if (ov) ov.style.display = 'none';
        document.documentElement.classList.remove('no-scroll');
        document.body.classList.remove('no-scroll', 'preload');
        document.body.classList.add('is-authenticated');
        if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
    });
    await new Promise(r => setTimeout(r, 800));

    const vis = sel => page.evaluate(s => Array.from(document.querySelectorAll(s))
        .filter(e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0).length, sel);

    console.log('\n--- 19 Aug critiques, on the real index.html @390 ---');
    ok(await vis('.ew-perf') === 0, '1. whole Performance card hidden');
    ok(await vis('.ew-standings') === 0, '   Leaderboard inside it gone with it');
    ok(await vis('.hotbars-stack') === 0, '1b. Quick Links bar hidden');
    ok(await vis('.hotbar-container') === 0, '   including the empty rounded box');
    ok(await vis('.cc-summary') === 0, '2. Summary strips hidden (store + district)');

    // Live tab open by default, with real figures in it.
    await page.evaluate((p, hub) => {
        hubDataCache = hub; _lvData = p; _lvMode = 'mtd'; renderLiveDashboard();
    }, payload, F.hub);
    await new Promise(r => setTimeout(r, 400));

    const liveOpen = await page.evaluate(() =>
        !!document.querySelector('#dc-panel-live.cc-active, #dc-panel-live.active')
        || getComputedStyle(document.getElementById('dc-panel-live')).display !== 'none');
    ok(liveOpen, '   Live Dashboard is the open tab');

    ok(await vis('.bd-open') === 0, '3. Daily Breakdown button hidden');
    ok(await vis('.lv-full') === 0, '   Full screen button hidden');
    ok(await vis('.lv-sound') > 0, '   mute switch kept');

    ok(await vis('.lv-cards-legend') === 0, '3b. legend paragraph gone from the cards');

    const picks = await page.evaluate(() => Array.from(document.querySelectorAll('.lv-dist-detail .lv-pickopt')).map(e => e.textContent.trim()));
    const cards = await page.evaluate(() => Array.from(document.querySelectorAll('.lv-dist-detail .lvc .lvc-h b')).map(e => e.textContent.trim()));
    ok(picks.length === 6, '4. six options in the store dropdown', picks.join(','));
    ok(await vis('.lv-picklist') === 0, '   the list is closed until tapped');
    ok(cards.length === 1 && cards[0] === 'District', '   one card, District on arrival', cards.join(','));
    await (await page.$('#dcWidget')).screenshot({ path: path.join(OUT, 'real-district.png') });

    // Tap a store pill and confirm the card follows it.
    await page.evaluate(() => {
        const opt = Array.from(document.querySelectorAll('.lv-dist-detail .lv-pickopt'))
            .find(e => e.textContent.trim() === 'MPL');
        opt.click();
    });
    await new Promise(r => setTimeout(r, 400));
    const after = await page.evaluate(() => ({
        cards: Array.from(document.querySelectorAll('.lv-dist-detail .lvc .lvc-h b')).map(e => e.textContent.trim()),
        lit: (document.querySelector('.lv-dist-detail .lv-pickcur') || {}).textContent.trim(),
    }));
    ok(after.cards.length === 1 && after.cards[0] === 'MPL', '   tapping MPL swaps the card', after.cards.join(','));
    ok(after.lit === 'MPL', '   and the dropdown holds the selection', after.lit);
    await (await page.$('#dcWidget')).screenshot({ path: path.join(OUT, 'real-mpl.png') });

    // The pick must survive a day change rather than snapping back to District.
    await page.evaluate(() => { setLiveMode('today'); });
    await new Promise(r => setTimeout(r, 400));
    const onToday = await page.evaluate(() => (document.querySelector('.lv-dist-detail .lv-pickcur') || {}).textContent.trim());
    ok(onToday === 'MPL', '   the pick survives switching to Today', onToday);

    const docW = await page.evaluate(() => document.documentElement.scrollWidth);
    ok(docW <= 390, '   no sideways scroll', docW);
    ok(!errs.length, '   no page errors', errs.join(' | '));

    await browser.close();
    console.log(fails ? '\n' + fails + ' FAILED' : '\nall four critiques verified on the real page');
    process.exit(fails ? 1 : 0);
})();
