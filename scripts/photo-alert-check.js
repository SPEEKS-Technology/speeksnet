// The "listings with no pictures" alarm, as it reaches a manager or an ASM.
//
// PIN-FREE ON PURPOSE. The alarm's whole job is to be zero, so a harness driven
// against live data would assert nothing on almost every run — and the one bug
// worth catching here only appears in a state the live data may never be in
// (categories clean, photos dirty). So this stubs _rcFetch and drives the real
// checkCategoryQueueReminders over payloads we choose.
//
// What it asserts:
//   1. no photos → no bubble and no card, on a page that otherwise would show one
//   2. photos → the card, its Title Case title, its badge, and its destination
//   3. ⚠️ CATEGORIES CLEAN + PHOTOS DIRTY STILL SHOWS THE CARD. The category nag
//      returns early when its own three queues are empty; the photo update has
//      to happen BEFORE that return and the feed has to be repainted on the way
//      out, or the alarm is invisible exactly when it is the only thing wrong.
//   4. NO FLOATING TOAST. A new bubble id is not covered by the retired-toast
//      rule in styles.css until it is listed there — the Categories bubble
//      shipped visible for that reason. Asserted on computed visibility.
//   5. the snooze is keyed to the count, so photographing 1 of 3 re-surfaces
//   6. corp sees nothing (the DM walks this weekly by hand)
//   7. a two-store reader sums both stores
//   8. no console errors
//
// NODE_PATH must point at a node_modules with puppeteer-core.
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const IGNORE = /toDataURL|[Tt]ainted|calendar\.google/;

let fails = 0;
const ok = (cond, label, detail) => {
    if (!cond) fails++;
    console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail !== undefined ? '   — ' + detail : ''}`);
};

// One payload shape, so a test says only what it is varying.
const payload = (o = {}) => ({
    scope: { corp: !!o.corp, stores: o.stores || ['OVL'] },
    other: o.other || {}, misfiled: o.misfiled || {}, unmatched: o.unmatched || {},
    photos: o.photos || {},
});

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
    });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) errs.push(m); });
    await page.setViewport({ width: 1500, height: 1000 });
    await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Nick Hettinger');
        sessionStorage.setItem('speeksUserRole', 'manager');
        sessionStorage.setItem('speeksUserStore', 'OVL');
        sessionStorage.setItem('speeksUserPin', '0000');   // presence is all the nag checks
    });
    await page.goto('file:///' + REPO + '/index.html', { waitUntil: 'networkidle2' }).catch(() => {});
    await page.evaluate(() => {
        const o = document.getElementById('authOverlay'); if (o) o.style.display = 'none';
        document.body.classList.add('is-authenticated');
        document.body.classList.remove('preload', 'no-scroll');
        // The bubble builder hangs its element off the claims bubble, and the
        // feed only runs where there is a deck. Both exist on the real page;
        // create them if this shell has not built them yet, so a missing anchor
        // fails as a missing anchor rather than as a missing alarm.
        if (!document.getElementById('claimAlertBubble')) {
            const a = document.createElement('div');
            a.id = 'claimAlertBubble';
            document.body.appendChild(a);
        }
        if (!document.getElementById('samFeed')) {
            const f = document.createElement('div');
            f.id = 'samFeed';
            document.body.appendChild(f);
        }
        window._jumpFeatureVisible = () => true;
    });

    // Drive the real function over a chosen payload and read back what a user
    // would actually get: the card the feed builds, and whether anything floats.
    const run = async (p) => page.evaluate(async (pl) => {
        window._rcFetch = async () => pl;
        await checkCategoryQueueReminders();
        const b = document.getElementById('photoAlertBubble');
        const t = document.getElementById('photoAlertBubbleText');
        const cards = typeof _samGatherReminders === 'function' ? _samGatherReminders() : [];
        const card = cards.find(r => r.key === 'photoAlert');
        const cat = cards.find(r => r.key === 'recatQueue');
        return {
            shown: !!b && getComputedStyle(b).display !== 'none',
            vis: b ? getComputedStyle(b).visibility : null,
            summary: t && t.dataset ? t.dataset.summary : null,
            sig: t && t.dataset ? t.dataset.sig : null,
            // dueCls, NOT cls — the config's `cls` is renamed on the way into the
            // reminder object, and asserting the config's name silently reads
            // undefined and passes anything.
            card: card ? { title: card.title, due: card.due, cls: card.dueCls,
                           action: card.action, snippet: card.snippet, urgency: card.urgency } : null,
            catCard: cat ? { title: cat.title, urgency: cat.urgency, cls: cat.dueCls } : null,
        };
    }, p);

    console.log('\n== Nothing to report ==');
    let r = await run(payload({ photos: { OVL: 0 }, other: { OVL: 4 } }));
    ok(!r.shown, 'no photos, no bubble', 'shown=' + r.shown);
    ok(!r.card, 'and no card', r.card ? r.card.title : 'none');

    console.log('\n== One listing with no picture ==');
    r = await run(payload({ photos: { OVL: 1 }, other: { OVL: 4 } }));
    ok(r.shown, 'the bubble lights', 'shown=' + r.shown);
    ok(r.vis === 'hidden', 'but never as a floating toast', 'visibility=' + r.vis);
    ok(!!r.card, 'the feed picks the card up', r.card && r.card.title);
    ok(r.card?.title === 'Listings With No Pictures', 'Title Case, and it names the problem', r.card && r.card.title);
    ok(r.card?.due === 'Action', 'the badge says Action, not Overdue — nothing is late', r.card && r.card.due);
    ok(r.card?.cls === 'sam-due-red', 'red: this number should always be zero', r.card && r.card.cls);
    ok(/operations\.html#categories/.test(r.card?.action || ''), 'it opens Listing Health', r.card && r.card.action);
    ok(/not sell/i.test(r.summary || ''), 'the line says what it costs, not what the table holds', r.summary);
    ok(/Shopify/i.test(r.summary || ''), 'and where the fix happens', r.summary);
    ok(r.sig === 'photos:1', 'the snooze is keyed to the count', r.sig);
    ok((r.card?.urgency ?? 0) > (r.catCard?.urgency ?? 0),
        'and it outranks the category queue beside it', `photos=${r.card?.urgency} cats=${r.catCard?.urgency}`);
    // Both storefront cards are red now, so ORDER is the only thing left saying
    // which is worse — if urgency ever ties, the pair becomes indistinguishable.
    ok(r.catCard?.cls === 'sam-due-red', 'the category card is red to match', r.catCard && r.catCard.cls);

    console.log('\n== The regression: categories clean, photos dirty ==');
    r = await run(payload({ photos: { OVL: 2 }, other: {}, misfiled: {}, unmatched: {} }));
    ok(r.shown, 'an empty category queue does not swallow the photo alarm', 'shown=' + r.shown);
    ok(!!r.card, 'the card survives the category early-return', r.card ? r.card.title : 'MISSING');
    ok(r.sig === 'photos:2', 'with the right count', r.sig);

    console.log('\n== Clearing it ==');
    r = await run(payload({ photos: { OVL: 0 } }));
    ok(!r.shown && !r.card, 'photograph them and the card leaves on its own', 'shown=' + r.shown);

    console.log('\n== Who sees it ==');
    r = await run(payload({ corp: true, stores: ['OVL', 'LEE'], photos: { OVL: 3 } }));
    ok(!r.shown && !r.card, 'corp does not — the DM walks this by hand', 'shown=' + r.shown);
    r = await run(payload({ stores: ['BAL', 'MPL'], photos: { BAL: 1, MPL: 2 } }));
    ok(r.sig === 'photos:3', 'a two-store reader gets both stores in one number', r.sig);
    ok(/BAL & MPL/.test(r.summary || ''), 'and both are named', r.summary);

    // ---- the tab shows only the halves you hold ----------------------------
    // Two switches over one page (ec-view-categories / ec-view-photos). The
    // SERVER's answer wins where we have it, which is what _lhScope carries.
    console.log('\n== One tab, two switches ==');
    const halves = async (mayCats, mayPhotos) => page.evaluate((c, p) => {
        _lhScope = { mayCats: c, mayPhotos: p, stores: ['OVL'], corp: false };
        _lhPhotos = { store: 'OVL', queue: [] };
        _rcData = { scope: _lhScope, store: 'OVL', counts: { other: 0, misfiled: 0, unmatched: 0 }, queue: [] };
        const html = _lhHtml();
        const d = document.createElement('div'); d.innerHTML = html;
        const heads = [...d.querySelectorAll('*')]
            .map(e => (e.childElementCount === 0 ? (e.textContent || '').trim() : ''))
            .filter(t => t === 'Photos' || t === 'Categories');
        return { photos: heads.includes('Photos'), cats: heads.includes('Categories'),
                 empty: /not switched on for you/i.test(html) };
    }, mayCats, mayPhotos);

    let h = await halves(true, true);
    ok(h.photos && h.cats, 'both granted → both sections', JSON.stringify(h));
    h = await halves(false, true);
    ok(h.photos && !h.cats, 'photos only → the alarm alone, no filing queue', JSON.stringify(h));
    h = await halves(true, false);
    ok(!h.photos && h.cats, 'categories only → the page as it was before the alarm', JSON.stringify(h));
    h = await halves(false, false);
    ok(!h.photos && !h.cats && h.empty,
        'neither → it says so rather than drawing an empty page', JSON.stringify(h));

    console.log('');
    ok(errs.length === 0, 'no console errors', errs.slice(0, 2).join(' / ') || 'clean');

    await browser.close();
    console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
    process.exit(fails ? 1 : 0);
})();
