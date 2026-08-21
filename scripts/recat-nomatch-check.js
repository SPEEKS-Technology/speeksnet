// The No Suggestion tab — the third of the three Categories queues, and the one
// that exists because the first two never showed it.
//
// The panel's queue was `collection_proposals`, so it only ever listed rows a
// RULE had a guess for. 48 listings across the five stores were live in Other
// on the storefront, matched no keyword, and appeared on no screen at all —
// which is how a manager can be looking at the Other collection in Shopify
// while SPEEKS says everything is filed.
//
// This drives the render directly with a canned payload rather than a PIN, so
// it runs without a credential and asserts the part a live queue cannot: a row
// with NO shelf on it. What matters here is the restraint —
//
//   1. three tabs, and the third one is badged with its own count
//   2. a row with nothing matched still READS: title, SKU, both links
//   3. and says WHY it is here, in words, rather than leaving the cell blank
//   4. it cannot be submitted. The tick is dead and Submit is dead, because
//      there is no category to file it on and "somewhere" is not an answer
//   5. picking a category arms exactly that row, and nothing else
//   6. Select All means the rows that CAN go — a Select All that ticks 13 and
//      then fails on 11 is worse than no Select All
//   7. the header counts the whole store, not the open tab
//
// The server-side refusal is checked in collection-recat-check.js.
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const SHOT = process.env.SHOT_DIR || REPO + '/scripts';

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

// Three real rows from OVL, plus the counts and one skip. Shelves trimmed to
// five — the picker's list length is not what this harness is about.
const PAYLOAD = {
    scope: { name: 'Ethan Kushnir', role: 'district manager', stores: ['OVL'], corp: true },
    store: 'OVL', mode: 'unmatched',
    queue: [
        { productId: 'gid://shopify/Product/8112466788454', sku: 'KS01-7140A-E3',
          title: 'Bose Alto Audio Sunglasses', handle: 'bose-alto-audio-sunglasses',
          rule: 'no match', to: '', toTitle: '', from: ['Other'], shop: 'paymore-overland-park.myshopify.com' },
        { productId: 'gid://shopify/Product/8067825565798', sku: 'KS01-7226A-R7R3',
          title: 'Xreal One Pro Smart Glasses X1112', handle: 'xreal-one-pro',
          rule: 'no match', to: '', toTitle: '', from: ['Other'], shop: 'paymore-overland-park.myshopify.com' },
        { productId: 'gid://shopify/Product/8067774414951', sku: 'KS01-7347A-R9R3',
          title: 'Roland V-60HD HD Video Switcher', handle: 'roland-v-60hd',
          rule: 'no match', to: '', toTitle: '', from: ['Other'], shop: 'paymore-overland-park.myshopify.com' },
    ],
    skipped: [{ product_id: 'gid://shopify/Product/8028874604646', sku: 'KS01-6581A-E10',
                title: 'Bushnell TOUR V6 Golf Rangefinder 202301P', in: ['Other'],
                skipped_by: 'Ethan Kushnir', reason: '' }],
    shelves: [
        { handle: 'optics', title: 'Optics' }, { handle: 'wearables', title: 'Wearables' },
        { handle: 'dj-recording-equipment', title: 'DJ & Recording Equipment' },
        { handle: 'computer-accessories', title: 'Computer Accessories' },
        { handle: 'monitors-displays', title: 'Monitors & Displays' },
    ],
    counts: { other: 64, misfiled: 3, unmatched: 13 },
};

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
    await new Promise(r => setTimeout(r, 2200));

    // The panel's own state, set where it lives. `_rcData` and friends are
    // top-level `let`s, so a bare assignment in page scope reaches the real
    // binding — `window._rcData = ...` would quietly create a different variable.
    const drew = await page.evaluate(p => {
        _ecView = 'cats'; _ecStore = 'OVL'; _rcMode = 'unmatched';
        _rcData = p; _rcSel = new Set(); _rcOver.clear();
        _ecScope = p.scope;
        ecRender();
        return !!document.querySelector('.rc-table tbody tr');
    }, PAYLOAD);
    ok(drew, 'the No Suggestion queue draws');
    if (!drew) {
        console.log('    body:', (await page.$eval('#ecBody', e => e.innerHTML)).slice(0, 400).replace(/\s+/g, ' '));
    }

    console.log('');
    console.log('== Three tabs, and the third has its own number ==');
    const tabs = await page.$$eval('.rc-mode', bs => bs.map(b => ({
        label: b.textContent.replace(/\s+/g, ' ').trim(),
        on: b.classList.contains('rc-mode-on'),
        w: b.getBoundingClientRect().width,
    })));
    ok(tabs.length === 3, 'there are three queues', tabs.map(t => t.label).join(' | '));
    ok(/No Suggestion 13/.test(tabs[2] ? tabs[2].label : ''), 'the third is badged with its own count',
        tabs[2] ? tabs[2].label : '(missing)');
    ok(tabs[2] && tabs[2].on === true, 'and it is the open one');
    ok(new Set(tabs.map(t => Math.round(t.w))).size === 1,
        'the three pills are one size', tabs.map(t => Math.round(t.w)).join('/'));

    console.log('');
    console.log('== A row with nothing matched still reads ==');
    const row = await page.$eval('.rc-table tbody tr', tr => {
        const shelf = tr.querySelector('.rc-shelf');
        return {
            title: (tr.querySelector('.rc-title') || {}).textContent || '',
            sku: (tr.querySelector('.rc-sub') || {}).textContent || '',
            links: [...tr.querySelectorAll('.rc-links a')].map(a => a.textContent.trim()),
            why: ((tr.querySelector('.rc-nomatch') || {}).textContent || '').trim(),
            rule: ((tr.querySelector('.rc-rule') || {}).textContent || '').trim(),
            from: ((tr.querySelector('.rc-from') || {}).textContent || '').trim(),
            ask: ((tr.querySelector('.rc-to') || {}).textContent || '').trim(),
            dashed: shelf ? getComputedStyle(shelf).borderTopStyle : '',
            tickDead: (tr.querySelector('.rc-pick input') || {}).disabled,
            submitDead: (tr.querySelector('.rc-acts .ec-btn-on') || {}).disabled,
            removeLive: (tr.querySelector('.rc-acts .ec-btn-off') || {}).disabled === false,
        };
    });
    ok(!!row.title.trim() && !!row.sku.trim(), 'it names the item and its SKU',
        row.title.trim() + ' - ' + row.sku.trim());
    ok(row.links.join('/') === 'Store/Shopify',
        'both links are there — the title alone is not enough to judge it', row.links.join('/'));
    // A blank cell reads as a rendering fault. This is the REASON the row is here.
    ok(row.why === 'Nothing Matched' && !row.rule, 'and says why it is in this tab, in words', row.why);
    ok(row.from === 'Other', 'it comes off Other, same as the first tab', row.from);
    ok(row.ask === 'Choose A Category', 'and the destination is an ASK, not a shelf', row.ask);
    ok(row.dashed === 'dashed', 'drawn as an open question', row.dashed);

    console.log('');
    console.log('== It cannot be filed until somebody answers ==');
    // The whole safety of this tab. There is no proposed shelf, so there is
    // nothing to agree with — and "file it somewhere" is not an answer.
    ok(row.tickDead === true, 'the tick is dead');
    ok(row.submitDead === true, 'and Submit is dead');
    ok(row.removeLive === true, 'but Remove still works — deciding it belongs in Other is an answer too');

    const armed = await page.evaluate(() => {
        _rcOver.set('gid://shopify/Product/8112466788454', 'wearables');
        ecRender();
        return [...document.querySelectorAll('.rc-table tbody tr')].map(tr => ({
            to: ((tr.querySelector('.rc-to') || {}).textContent || '').trim(),
            tick: !(tr.querySelector('.rc-pick input') || {}).disabled,
            submit: !(tr.querySelector('.rc-acts .ec-btn-on') || {}).disabled,
            picked: !!tr.querySelector('.rc-shelf-picked'),
        }));
    });
    ok(armed[0].to === 'Wearables' && armed[0].tick && armed[0].submit && armed[0].picked,
        'picking a category arms that row', JSON.stringify(armed[0]));
    ok(!armed[1].tick && !armed[2].tick, 'and only that row',
        armed[1].to + ' / ' + armed[2].to);

    console.log('');
    console.log('== Select All means the ones that can actually go ==');
    const sel = await page.evaluate(() => {
        rcSelectAll(true);
        const btn = document.getElementById('rcFileBtn');
        return { n: _rcSel.size, ticked: document.querySelectorAll('.rc-pick input:checked').length,
                 btn: btn ? btn.textContent.trim() : '' };
    });
    ok(sel.n === 1 && sel.ticked === 1, 'one of three, because two have no category yet', sel.n + ' selected');
    ok(/1 Selected/.test(sel.btn), 'and the button counts what it would send', sel.btn);
    // "3 To Submit" over three rows that cannot be submitted is the same lie the
    // header used to tell, one line lower down.
    const count = await page.$eval('.rc-count', e => e.textContent.trim());
    ok(/Waiting On A Category/.test(count), 'and the list says what it is waiting on', count);

    console.log('');
    console.log('== The header is about the store, not the tab ==');
    const sub = await page.$eval('#ecSubtitle', e => e.textContent.trim()).catch(() => '');
    // 64 + 3 + 13. A header that counted the open tab said "13 To Submit" over a
    // store with 80 outstanding, and "Everything Is Filed" over one with 64.
    ok(/80 Items To Submit/.test(sub), 'all three queues, added up', sub);

    await page.screenshot({ path: SHOT + '/recat-nomatch.png', fullPage: false });
    ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | ') || 'clean');

    await browser.close();
    console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
    process.exit(fails ? 1 : 0);
})();
