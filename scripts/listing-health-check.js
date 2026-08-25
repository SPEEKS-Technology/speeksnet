// LISTING HEALTH — the Categories queue and the no-photo alarm on one page,
// with Upload folded into a drawer at the bottom.
//
// The photo alarm is the reason this page exists, and its correct reading is
// ZERO. That makes it a hard thing to test against live data: OVL has exactly
// one no-photo listing today and the other four stores have none, so the state
// that matters most — a store with a real problem — never appears on screen.
// So this drives the render directly with canned payloads, no PIN, and asserts
// the three states in turn: clear, alarmed, and NOT KNOWN.
//
// What it is really checking:
//
//   1. one page, two sections — Categories did not become a second tab
//   2. ALL CLEAR IS ONE LINE. The alarm sits above a working queue; a
//      full-height empty state would push the actual work off the screen every
//      day just to say nothing happened
//   3. a failed check is NOT an all clear — the one assertion this whole
//      feature's value rests on, since a zero nobody can trust is worth less
//      than no zero at all
//   4. an alarmed row carries the SKU and a WORKING Shopify link — the admin
//      URL needs the numeric id, and a handle-based one 404s while looking right
//   5. the eBay upload rows are folded INSIDE each All Stores card, and a real
//      failure count still surfaces on the shut drawer
//   6. the table does not blow the panel out sideways (a nowrap cell full of
//      free text is how that has happened before)
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const SHOT = process.env.SHOT_DIR || REPO + '/scripts';

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

const SHOP = 'paymore-overland-park.myshopify.com';

// The one real row on the estate today, plus two invented ones so the table is
// exercised with a long title and a sold-out unit.
const PHOTOS = {
    store: 'OVL',
    queue: [
        { productId: 'gid://shopify/Product/8144813523046', sku: 'KS01-7382A1-E5',
          title: 'PNY 2.5" CS900 250GB SATA III 6Gbps SSD SSD7CS900-250-RB',
          handle: 'pny-2-5-cs900-250gb-sata-iii-6gbps-ssd-ssd7cs900-250-rb-1786385659424-u86fqbi79',
          price: 24.99, quantity: 1, listedAt: '2026-08-10T18:14:19+00:00', shop: SHOP },
        { productId: 'gid://shopify/Product/8067825565798', sku: 'KS01-7226A-R7R3',
          title: 'Gigabyte GeForce RTX 3080 AORUS Master 12GB GDDR6X Graphics Card GV-N3080AORUS M-12GD',
          handle: 'gigabyte-rtx-3080-aorus', price: 429.99, quantity: 2,
          listedAt: '2026-07-02T15:00:00+00:00', shop: SHOP },
        { productId: 'gid://shopify/Product/8067774414951', sku: 'KS01-7347A-R9R3',
          title: 'Roland V-60HD HD Video Switcher', handle: 'roland-v-60hd',
          price: 1199.0, quantity: 0, listedAt: '2026-08-24T15:00:00+00:00', shop: SHOP },
    ],
};

// A small, valid Categories payload so the section below has something to draw.
const CATS = {
    scope: { name: 'Ethan Kushnir', role: 'district manager', stores: ['OVL', 'LEE'], corp: true },
    store: 'OVL', mode: 'other',
    queue: [{ productId: 'gid://shopify/Product/8112466788454', sku: 'KS01-7140A-E3',
              title: 'Bose Alto Audio Sunglasses', handle: 'bose-alto-audio-sunglasses',
              rule: 'sunglasses', to: 'wearables', toTitle: 'Wearables',
              from: ['Other'], shop: SHOP }],
    skipped: [], shelves: [{ handle: 'wearables', title: 'Wearables' }],
    counts: { other: 1, misfiled: 0, unmatched: 0 },
};

const seed = async (page, photos, err) => await page.evaluate((p, e, c) => {
    // Top-level `let`s: a bare assignment reaches the real binding, where
    // `window._lhPhotos = ...` would quietly create a different variable.
    _ecView = 'cats'; _ecStore = 'OVL';
    _rcMode = 'other'; _rcData = c; _rcSel = new Set(); _rcOver.clear();
    _ecScope = { allStores: true, stores: ['OVL', 'LEE'] };
    _lhPhotos = p; _lhPhotoErr = e;
    ecRender();
}, photos, err, CATS);

(async () => {
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errs = [];
    const IGNORE = /calendar\.google\.com|toDataURL|[Tt]ainted canvas|Failed to fetch|net::ERR/;
    page.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) errs.push(m); });
    await page.setViewport({ width: 1500, height: 1100 });
    await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
        sessionStorage.setItem('speeksUserRole', 'district manager');
        sessionStorage.setItem('speeksUserStore', 'CORP');
    });
    await page.goto('file:///' + REPO + '/operations.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2400));

    console.log('== The tab strip: Categories became Listing Health ==');
    // After a render, because the fold is applied by _ecSyncChrome. On file://
    // the panel's own fetches fail, and reading the strip before anything has
    // drawn would be measuring the raw HTML rather than the built page.
    await seed(page, { store: 'OVL', queue: [] }, null);
    const pills = await page.$$eval('#ecViewToggle .mb-view-btn', bs => bs.map(b => ({
        id: b.id,
        label: b.textContent.replace(/\s+/g, ' ').trim(),
        shown: getComputedStyle(b).display !== 'none',
    })));
    const shown = pills.filter(p => p.shown).map(p => p.label);
    ok(shown.includes('Listing Health'), 'the pill says Listing Health', shown.join(' | '));
    ok(!shown.some(l => /^Categories$/.test(l)), 'and there is no separate Categories pill');
    // Upload keeps its own pill — it is break-glass and must stay one click away.
    const up = pills.find(p => p.id === 'ecViewListingsBtn');
    ok(up && up.shown, 'and Upload still has its own pill', shown.join(' | '));
    ok(shown.length === 3, 'three pills: All Stores, Listing Health, Upload', String(shown.length));

    // ---------------------------------------------------------------- clear
    console.log('');
    console.log('== ALL CLEAR is one calm line, not an empty page ==');
    await seed(page, { store: 'OVL', queue: [] }, null);
    const clear = await page.evaluate(() => {
        const c = document.querySelector('.lh-clear');
        const secs = [...document.querySelectorAll('.lh-sec')];
        return {
            text: c ? c.textContent.replace(/\s+/g, ' ').trim() : '',
            h: c ? Math.round(c.getBoundingClientRect().height) : 0,
            badge: (document.querySelector('.lh-count-ok') || {}).textContent || '',
            sections: secs.map(s => (s.querySelector('.lh-title') || {}).textContent || ''),
        };
    });
    ok(/All Clear/.test(clear.text) && /OVL/.test(clear.text),
        'it says all clear and names the store', clear.text);
    // The number that matters: a compact strip, not a 34px-padded empty state.
    ok(clear.h > 0 && clear.h <= 60, 'and it is ONE line high', clear.h + 'px');
    ok(clear.badge === '0', 'the section badge reads 0', clear.badge);
    ok(clear.sections.length === 2, 'two sections on one page', clear.sections.join(' + '));

    console.log('');
    console.log('== Upload is NOT on the daily page ==');
    // It moved to All Stores. This page is the one opened every morning; the
    // drawer belongs with the other whole-estate things, not under the work.
    const onDaily = await page.$$eval('.lh-upload', d => d.length);
    ok(onDaily === 0, 'no Upload drawer on Listing Health', onDaily + ' found');

    // ---------------------------------------------------------------- alarm
    console.log('');
    console.log('== A store with a real problem ==');
    await seed(page, PHOTOS, null);
    const alarm = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.lh-table tbody tr')];
        const r = rows[0];
        const cell = s => ((r.querySelector(s) || {}).textContent || '').trim();
        return {
            n: rows.length,
            badge: (document.querySelector('.lh-count-bad') || {}).textContent || '',
            said: (document.querySelector('.lh-alarm') || {}).textContent.replace(/\s+/g, ' ').trim() || '',
            sku: cell('.lh-sku'),
            since: cell('.lh-since'),
            links: [...r.querySelectorAll('.ec-pills a')].map(a => ({ t: a.textContent.trim(), h: a.getAttribute('href') })),
            soldout: [...document.querySelectorAll('.lh-soldout')].length,
            heads: [...document.querySelectorAll('.lh-table thead th')].map(t => t.textContent.trim()),
        };
    });
    ok(alarm.n === 3, 'every listing is on the page', alarm.n + ' rows');
    ok(alarm.badge === '3', 'the badge counts them', alarm.badge);
    ok(!!alarm.sku, 'the SKU has its own column and is filled', alarm.sku);
    // ALWAYS A DURATION. _ecAgo prints a date past 14 days, which makes the
    // reader subtract — and this number IS the severity, so it has to be the
    // finding, not the raw material for one.
    ok(/^(Today|\d+ Days?|\d+ Months?)$/.test(alarm.since),
        'how long it has been live is a duration, not a date', alarm.since);
    const stale = await page.$$eval('.lh-stale', e => e.length);
    ok(stale === 2, 'the two that have been broken for weeks are flagged', stale + ' flagged');
    ok(alarm.soldout === 1, 'a sold-out unit is labelled rather than shown as 0', alarm.soldout + ' marked');

    // THE LINK TRAP: the admin URL takes the NUMERIC id off the gid. A
    // handle-based admin link 404s and looks perfectly right until clicked.
    const shopLink = alarm.links.find(l => l.t === 'Shopify');
    ok(!!shopLink, 'there is a Shopify link on the row');
    ok(shopLink && shopLink.h === `https://${SHOP}/admin/products/8144813523046`,
        'and it points at the numeric admin id, not the handle', shopLink && shopLink.h);
    const storeLink = alarm.links.find(l => l.t === 'Store');
    ok(storeLink && /\/products\//.test(storeLink.h), 'the storefront link goes to the product page');

    // Plain English, and it names who fixes it. "image_count = 0" is not a
    // sentence anybody can act on.
    ok(/empty square/.test(alarm.said), 'it says what a shopper actually sees', alarm.said.slice(0, 90) + '…');
    ok(/store fixes/i.test(alarm.said), 'and who fixes it');
    ok(alarm.heads.join('|') === 'Item|SKU|Price|Stock|Live For|Open',
        'the columns are the ones a manager needs', alarm.heads.join('|'));

    // Title Case is the house rule for headers and buttons.
    const badCase = alarm.heads.filter(h => h.split(/\s+/).some(w => /^[a-z]/.test(w)));
    ok(badCase.length === 0, 'headers are Title Case', badCase.join(',') || 'all good');

    console.log('');
    console.log('== The table stays inside the panel ==');
    // Free text in a nowrap cell is how a modal table has silently blown out
    // sideways before. That long GPU title is the one that would do it.
    const fit = await page.evaluate(() => {
        const body = document.getElementById('ecBody');
        const t = document.querySelector('.lh-table');
        return { over: Math.round(t.getBoundingClientRect().width - body.clientWidth),
                 hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    ok(fit.over <= 1, 'the table is no wider than the panel', fit.over + 'px over');
    ok(!fit.hscroll, 'and the page does not scroll sideways');

    // ------------------------------------------------------------- unknown
    console.log('');
    console.log('== A CHECK THAT FAILED IS NOT AN ALL CLEAR ==');
    // The assertion this feature's value rests on. The whole point of the panel
    // is that its zero can be trusted; a failed request that draws the green
    // line is a lie about the storefront.
    await seed(page, null, 'Request failed (500)');
    const unk = await page.evaluate(() => ({
        clear: !!document.querySelector('.lh-clear'),
        unknown: (document.querySelector('.lh-unknown') || {}).textContent?.replace(/\s+/g, ' ').trim() || '',
        okBadge: !!document.querySelector('.lh-count-ok'),
        sub: (document.getElementById('ecSubtitle') || {}).textContent || '',
    }));
    ok(!unk.clear, 'no green all-clear line');
    ok(!unk.okBadge, 'and no reassuring 0 badge');
    ok(/Could Not Check/i.test(unk.unknown), 'it says the check did not run', unk.unknown.slice(0, 80));
    ok(/not an all clear/i.test(unk.unknown), 'in as many words');
    ok(/Photo Check Failed/.test(unk.sub), 'and the panel subtitle says so too', unk.sub);

    console.log('');
    console.log('== The subtitle counts both sections ==');
    await seed(page, PHOTOS, null);
    const sub = await page.$eval('#ecSubtitle', e => e.textContent);
    ok(/3 Missing A Photo/.test(sub), 'photos lead — the number that should be zero', sub);
    ok(/1 Item To Submit/.test(sub), 'and the filing queue follows', sub);

    console.log('');
    console.log('== The All Stores card carries the photo number too ==');
    // Where the district looks to find WHICH store has the problem. Red rather
    // than amber, because everything else on that card is work sitting in a
    // queue and this one is live on the storefront right now.
    const health = await page.evaluate(() => {
        _ecView = 'health';
        _ecHealth = { stores: [
            { store: 'OVL', connected: true, counts: { live: 12, failed: 0 }, freshness: { liveMinutes: 5 } },
            { store: 'LEE', connected: true, counts: { live: 8, failed: 0 }, freshness: { liveMinutes: 5 } },
        ] };
        _rcCounts = { other: { OVL: 3, LEE: 0 }, misfiled: { OVL: 0, LEE: 0 },
                      unmatched: { OVL: 1, LEE: 0 }, photos: { OVL: 2, LEE: 0 } };
        ecRender();
        const card = document.querySelector('.ec-hcard');
        const rows = [...card.querySelectorAll('.ec-hrow')].map(r => ({
            k: r.querySelector('.ec-hk').textContent.trim(),
            v: r.querySelector('.ec-hv').textContent.trim(),
            cls: r.querySelector('.ec-hv').className,
            colour: getComputedStyle(r.querySelector('.ec-hv')).color,
        }));
        const lee = [...document.querySelectorAll('.ec-hcard')][1];
        const leePic = [...lee.querySelectorAll('.ec-hrow')].find(r => /No Photos/.test(r.textContent));
        return { rows, leeVal: leePic && leePic.querySelector('.ec-hv').textContent.trim(),
                 leeCls: leePic && leePic.querySelector('.ec-hv').className };
    });
    const pic = health.rows.find(r => /No Photos/.test(r.k));
    ok(!!pic, 'the card has a No Photos row', health.rows.map(r => r.k).join(' / '));
    ok(pic && pic.v === '2', 'with this store\'s count on it', pic && pic.v);
    ok(pic && /ec-bad/.test(pic.cls), 'flagged red, not amber like the queues', pic && pic.cls.trim());
    ok(pic && /rgb\(209, 68, 59\)/.test(pic.colour), 'and the red actually resolves', pic && pic.colour);
    // A clean store must read as clean, not as another warning.
    ok(health.leeVal === '0' && /ec-ok/.test(health.leeCls || ''),
        'a store with none reads green', health.leeVal + ' ' + (health.leeCls || '').trim());

    console.log('');
    console.log('== The eBay rows are folded INSIDE each store card ==');
    // SPEEKS Connect uploading is parked at all five stores, so three rows of
    // zeroes were doubling every card's height above the part still worth reading.
    const card = await page.evaluate(() => {
        const c = document.querySelector('.ec-hcard');
        const d = c.querySelector('.ec-hebay');
        const faceRows = [...c.querySelectorAll('.ec-hbody > .ec-hrow')]
            .map(r => r.querySelector('.ec-hk').textContent.trim());
        const hidden = d ? [...d.querySelectorAll('.ec-hrow')]
            .map(r => r.querySelector('.ec-hk').textContent.trim()) : [];
        return { hasDrawer: !!d, open: d ? d.open : null,
                 summary: d ? d.querySelector('summary').textContent.trim() : '',
                 faceRows, hidden,
                 drawerVisible: d ? d.querySelector('.ec-hrow').offsetParent !== null : null };
    });
    ok(card.hasDrawer, 'each card has an eBay drawer');
    ok(card.open === false, 'shut by default');
    ok(card.drawerVisible === false, 'and its rows really are hidden, not just unstyled');
    ok(card.hidden.join('|') === 'Live On eBay|Did Not Upload|Checked Against eBay',
        'the three eBay rows are the ones inside', card.hidden.join('|'));
    ok(card.faceRows.join('|') === 'No Photos|In “Other”|No Suggestion|Wrong Category',
        'and listing health is what the card reads as', card.faceRows.join('|'));
    // Nothing collapsed may hide an ACTIONABLE number. With failures present the
    // summary has to say so on the closed card.
    const surfaced = await page.evaluate(() => {
        _ecHealth.stores[0].counts.failed = 3;
        ecRender();
        return document.querySelector('.ec-hebay > summary').textContent.trim();
    });
    ok(/3 To Fix/.test(surfaced), 'a real failure count surfaces on the shut drawer', surfaced);
    await page.evaluate(() => { _ecHealth.stores[0].counts.failed = 0; ecRender(); });

    console.log('');
    console.log('== Upload keeps its own pill ==');
    const pillBack = await page.evaluate(() => {
        const b = document.getElementById('ecViewListingsBtn');
        return { folded: b.classList.contains('lh-folded'),
                 shown: getComputedStyle(b).display !== 'none',
                 noBottomDrawer: document.querySelectorAll('.lh-upload').length };
    });
    ok(!pillBack.folded && pillBack.shown, 'the Upload tab is visible again');
    ok(pillBack.noBottomDrawer === 0, 'and the bottom-of-page drawer is gone');

    await page.screenshot({ path: SHOT + '/listing-health-allstores.png' });

    await seed(page, PHOTOS, null);
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: SHOT + '/listing-health.png' });
    // The all-clear is the state this page is in almost every day, so it is the
    // one worth looking at rather than only asserting on.
    await seed(page, { store: 'OVL', queue: [] }, null);
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: SHOT + '/listing-health-clear.png' });
    console.log('\n  shots: listing-health.png (alarmed) + listing-health-clear.png (the normal day)');

    ok(errs.length === 0, 'no page errors', errs.slice(0, 3).join(' | ') || 'clean');
    await browser.close();
    console.log('\n' + (fails ? `${fails} FAILED` : 'all passed'));
    process.exit(fails ? 1 : 0);
})();
