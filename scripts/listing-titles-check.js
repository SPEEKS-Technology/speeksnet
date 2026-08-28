// LISTING TITLES — the third tool on the Listing Health page.
//
// PIN-FREE and payload-driven, like listing-health-check.js and for the same
// reason: the states that matter most are the rare ones. Across the estate there
// are eight severity-3 rows and several hundred severity-1 ones, so a live
// harness would only ever photograph the least interesting tier — and would
// photograph a different one next week.
//
// What it is really checking:
//
//   1. THREE sections on one page now, in severity order (Photos, Titles,
//      Categories) — Titles did not become a fourth pill
//   2. the three tiers are tabs with severity-coloured counts, and the page
//      LANDS on the worst tier that has anything in it. Opening on an empty
//      "Wrong" tab hides the work and reads as a broken panel
//   3. A ROW WITH NO SUGGESTION CANNOT BE APPROVED. This is the assertion the
//      whole feature's safety rests on: rows arrive with suggested_title null
//      when there is no safe automatic fix, and a live Approve on one of those
//      would write an empty or unchanged title to a real storefront
//   4. TITLES WRAP, THEY DO NOT TRUNCATE. The reviewer is judging exact words at
//      up to 80 characters; an ellipsis through the changed part hides the only
//      thing worth looking at. This is the table-layout blowout trap, which is
//      why the row is not a table
//   5. a drift row shows BOTH titles, so "one of these is wrong" is a thing you
//      can actually see
//   6. the comps drawer is genuinely collapsed — asserted on RENDERING
//      (offsetParent === null), never on markup, because a closed <details>
//      does not hide an author-styled flex child
//   7. a failed read is NOT an all clear
//   8. the panel does not blow out sideways
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const SHOT = process.env.SHOT_DIR || REPO + '/scripts';

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

const SHOP = 'paymore-overland-park.myshopify.com';
const P = n => 'gid://shopify/Product/' + n;

// Real rows, copied from the first live sweep — including the two that produced
// bugs, so a regression shows up here rather than on a storefront.
const QUEUE = {
    store: 'OVL',
    counts: { OVL: 5 },
    queue: [
        // A drift row: eBay is showing a different RAM module than Shopify has.
        // No suggestion on purpose — we do not know which side is right.
        { productId: P(1), sku: 'KS01-6849E-R4R3', severity: 3, basis: 'rules',
          confidence: 'high', price: 59.99, quantity: 1, shop: SHOP, comps: [],
          current: 'SK Hynix HMA82GS6DJR8N 8GB (1x8GB) RAM DDR4 2400MHz',
          ebayTitle: 'SK Hynix HMA82GS6CJR8N-VK 16GB (2x8GB) RAM DDR4 2666MHz',
          suggested: null,
          findings: [{ code: 'title-drift', severity: 3, fixable: false,
            says: 'eBay currently shows a different module than Shopify. One of the two is wrong in front of a buyer.' }] },
        // A mirrorless body sold as a DSLR — fixable, and the fix is a
        // replacement rather than an append.
        { productId: P(2), sku: 'MO04-1606A-E10', severity: 3, basis: 'rules',
          confidence: 'high', price: 1049.99, quantity: 1, shop: SHOP, comps: [],
          current: 'Nikon Z 6 24.5MP Digital SLR DSLR Camera',
          suggested: 'Nikon Z 6 24.5MP Mirrorless Camera',
          findings: [{ code: 'hardware-conflict', severity: 3, fixable: true,
            says: 'The title calls this a DSLR, but this model is a mirrorless camera.' }] },
        // Severity 2 with no fix: nothing in the spec table names the product.
        { productId: P(3), sku: 'KS01-5031A-E10', severity: 2, basis: 'rules',
          confidence: 'high', price: 289.99, quantity: 1, shop: SHOP, comps: [],
          current: 'Intel Core i9-13900KS 3.20GHz 24 Core SRMBX 32 Thread LGA 1700',
          suggested: null,
          findings: [{ code: 'missing-noun', severity: 2, fixable: false,
            says: 'The title never says what the item IS.' }] },
        // THE LONGEST THING THIS PANEL CAN BE ASKED TO SHOW: an 80-character
        // title against an 80-character suggestion. If anything truncates, it
        // truncates here.
        { productId: P(4), sku: 'MO03-1052A-R3R4', severity: 2, basis: 'category',
          confidence: 'medium', price: 564.99, quantity: 1, shop: SHOP,
          current: 'Codi 34" MO34H-UC 4K LED Mini-LED Ultra Wide 3440x1440 100Hz VA Panel',
          suggested: 'Codi 34" MO34H-UC 4K LED Mini-LED Ultra Wide 3440x1440 100Hz VA Monitor',
          findings: [{ code: 'missing-noun', severity: 2, fixable: true,
            says: 'The title never says what the item IS. Shopify calls it a Monitor.' }],
          comps: [{ title: 'Dell 34 Inch Curved Ultrawide Gaming Monitor WQHD 165Hz', price: '299.99', itemId: '1' },
                  { title: 'LG 34WP65C-B 34" UltraWide QHD Curved Monitor 160Hz HDR10', price: '349.00', itemId: '2' }] },
        // Severity 1, fixable, and the one that dominates the real queue.
        { productId: P(5), sku: 'KS01-7283G4-E5', severity: 1, basis: 'rules',
          confidence: 'high', price: 12.99, quantity: 1, shop: SHOP, comps: [],
          current: "Asura's Wrath (Microsoft Xbox 360, 2012)",
          suggested: "Asura's Wrath (Microsoft Xbox 360, 2012) CIB Complete In Box",
          findings: [{ code: 'game-complete', severity: 1, fixable: true,
            says: 'Shopify says this game has its case, manual and inserts — that is Complete In Box.',
            warn: 'Confirm this one is actually CIB before approving — check the case, manual and all inserts are really with the game.' }] },
    ],
};

// The Categories payload, so the third section has something to draw and the
// section ORDER can be asserted.
// Today's real state: the live sweeps are paused, so the queue view stops
// applying its "and on eBay" rule rather than emptying itself. Both states are
// asserted below — the honest one is the one that has to be loud.
const SCOPE_STALE  = { active: false, lastSeen: '2026-08-25T17:33:25Z', hours: 76, maxAgeHours: 36 };
const SCOPE_ACTIVE = { active: true,  lastSeen: '2026-08-28T19:00:00Z', hours: 1,  maxAgeHours: 36 };

const CATS = {
    scope: { corp: true, stores: ['OVL'], mayCats: true, mayPhotos: true, mayTitles: true },
    store: 'OVL', mode: 'other',
    queue: [{ productId: P(9), sku: 'KS01-1A-E1', title: 'Bose Alto Audio Sunglasses',
              handle: 'bose-alto', rule: 'sunglasses', to: 'wearables',
              toTitle: 'Wearables', from: ['Other'], shop: SHOP }],
    skipped: [], shelves: [{ handle: 'wearables', title: 'Wearables' }],
    counts: { other: 1, misfiled: 0, unmatched: 0 },
};

const seed = async (page, titles, err, tier) => await page.evaluate((t, e, c, tr) => {
    // Top-level `let`s: a bare assignment reaches the real binding, where
    // `window._ltData = ...` would quietly create a different variable.
    _ecView = 'cats'; _ecStore = 'OVL';
    _rcMode = 'other'; _rcData = c; _rcSel = new Set(); _rcOver.clear();
    _ecScope = { allStores: true, stores: ['OVL'] };
    _lhPhotos = { store: 'OVL', queue: [] }; _lhPhotoErr = null;
    _ltData = t; _ltErr = e; _ltTier = tr; _ltEdits = new Map(); _ltBusy = new Set();
    ecRender();
}, titles, err, CATS, tier === undefined ? 3 : tier);

(async () => {
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errs = [];
    const IGNORE = /calendar\.google\.com|toDataURL|[Tt]ainted canvas|Failed to fetch|net::ERR/;
    page.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) errs.push(m); });
    await page.setViewport({ width: 1500, height: 1200 });
    await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
        sessionStorage.setItem('speeksUserRole', 'district manager');
        sessionStorage.setItem('speeksUserStore', 'CORP');
    });
    await page.goto('file:///' + REPO + '/operations.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2400));

    // ------------------------------------------------------------ sections
    console.log('== Three sections on one page, worst first ==');
    await seed(page, QUEUE, null);
    const secs = await page.$$eval('.lh-sec', ss => ss.map(s =>
        ((s.querySelector('.lh-title') || {}).textContent || '').trim()));
    ok(secs.length === 3, 'three sections', secs.join(' | '));
    ok(secs[1] === 'Listing Titles', 'Titles sits between the alarm and the queue', secs.join(' > '));
    // Titles is a SECTION of Listing Health, not a pill of its own. (Upload's
    // pill is hidden under this seeding whatever we do — it keys off the feed
    // payload — so the count itself is not the assertion; the absence of a
    // fourth destination is.)
    const pills = await page.$$eval('#ecViewToggle .mb-view-btn',
        bs => bs.filter(b => getComputedStyle(b).display !== 'none')
                .map(b => b.textContent.replace(/\s+/g, ' ').trim()));
    ok(pills.some(l => /Listing Health/.test(l)),
        'Listing Health is still the destination', pills.join(' | '));
    ok(!pills.some(l => /^Titles/i.test(l)),
        'and Titles did NOT become a fourth pill', pills.join(' | '));

    // ---------------------------------------------------------------- tabs
    console.log('');
    console.log('== The three tiers, with severity-coloured counts ==');
    const tabs = await page.$$eval('.lt-modes .rc-mode', bs => bs.map(b => ({
        label: b.textContent.replace(/\s+/g, ' ').trim(),
        on: b.classList.contains('rc-mode-on'),
        chipCls: (b.querySelector('.rc-chip-n') || {}).className || '',
    })));
    ok(tabs.length === 3, 'three tier tabs', tabs.map(t => t.label).join(' | '));
    ok(/Wrong 2/.test(tabs[0].label), 'Wrong counts 2', tabs[0].label);
    ok(/Hard To Find 2/.test(tabs[1].label), 'Hard To Find counts 2', tabs[1].label);
    ok(/Opportunity 1/.test(tabs[2].label), 'Opportunity counts 1', tabs[2].label);
    ok(/lt-t-bad/.test(tabs[0].chipCls), 'the Wrong count is red', tabs[0].chipCls);
    ok(tabs[0].on, 'and it opens on Wrong');

    // A store whose worst problem is severity 2 must NOT open on an empty
    // Wrong tab — that hides the work behind a tab that says nothing.
    const noWrong = { ...QUEUE, queue: QUEUE.queue.filter(r => r.severity < 3) };
    await seed(page, noWrong, null, 3);
    const landed = await page.$$eval('.lt-modes .rc-mode',
        bs => (bs.find(b => b.classList.contains('rc-mode-on')) || {}).textContent || '');
    ok(/Hard To Find/.test(landed), 'with no Wrong rows it lands on Hard To Find', landed.replace(/\s+/g, ' ').trim());

    // ---------------------------------------------------------------- rows
    console.log('');
    console.log('== A Wrong row shows both titles and refuses a blind Approve ==');
    await seed(page, QUEUE, null, 3);
    const rows = await page.$$eval('.lt-row', rs => rs.map(r => {
        const txt = s => ((r.querySelector(s) || {}).textContent || '').replace(/\s+/g, ' ').trim();
        const inp = r.querySelector('.lt-input');
        const okBtn = r.querySelector('.lt-ok');
        return {
            now: txt('.lt-now:not(.lt-drift) .lt-cur'),
            ebay: txt('.lt-drift .lt-cur'),
            sug: txt('.lt-sug'),
            nosug: txt('.lt-nosug'),
            why: txt('.lt-why'),
            marks: [...r.querySelectorAll('.lt-add')].map(m => m.textContent.trim()),
            boxVal: inp ? inp.value : null,
            approveDisabled: okBtn ? okBtn.disabled : null,
            approveLabel: okBtn ? okBtn.textContent.trim() : '',
            denyThere: !!r.querySelector('.lt-no'),
        };
    }));
    const drift = rows[0];
    ok(/HMA82GS6DJR8N/.test(drift.now), 'the Shopify title is shown', drift.now);
    ok(/HMA82GS6CJR8N-VK/.test(drift.ebay), 'AND what eBay is showing', drift.ebay);
    ok(/one of the two is wrong/i.test(drift.why), 'and the reason says so', drift.why.slice(0, 70));
    // THE ASSERTION THIS FEATURE'S SAFETY RESTS ON.
    ok(drift.approveDisabled === true,
        'Approve is REFUSED on a row with no suggestion', 'disabled=' + drift.approveDisabled);
    ok(/type one below/i.test(drift.nosug) || drift.nosug.length > 0,
        'and it says a title has to be typed', drift.nosug);
    ok(drift.boxVal === drift.now,
        'the box starts from the current title, not empty', JSON.stringify(drift.boxVal));
    ok(drift.denyThere, 'Deny is available on it');

    const conflict = rows[1];
    ok(conflict.approveDisabled === false, 'a fixable row CAN be approved');
    ok(conflict.approveLabel === 'Approve', 'and the button says Approve', conflict.approveLabel);
    ok(conflict.marks.join(' ') === 'Mirrorless',
        'only the CHANGED word is marked', JSON.stringify(conflict.marks));

    // ------------------------------------------------------------- wrapping
    console.log('');
    console.log('== An 80-character title WRAPS; it never truncates ==');
    await seed(page, QUEUE, null, 2);
    const wrap = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.lt-row')];
        const r = rows.find(x => /MO34H-UC/.test(x.textContent));
        const cur = r.querySelector('.lt-now .lt-cur');
        const sug = r.querySelector('.lt-sug');
        const panel = document.getElementById('ecBody') || document.body;
        return {
            // scrollWidth > clientWidth is the tell for a clipped line, and
            // getComputedStyle would happily report an ellipsis we never set.
            curClipped: cur.scrollWidth > cur.clientWidth + 1,
            sugClipped: sug.scrollWidth > sug.clientWidth + 1,
            curFull: cur.textContent.trim(),
            sugFull: sug.textContent.replace(/\s+/g, ' ').trim(),
            lines: Math.round(cur.getBoundingClientRect().height),
            panelOverflow: panel.scrollWidth > panel.clientWidth + 1,
            bodyOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
    });
    ok(!wrap.curClipped, 'the current title is not clipped');
    ok(!wrap.sugClipped, 'the suggestion is not clipped');
    ok(wrap.curFull.endsWith('VA Panel'), 'the whole current title is present', wrap.curFull.slice(-24));
    ok(/Monitor$/.test(wrap.sugFull), 'and the whole suggestion is', wrap.sugFull.slice(-24));
    ok(!wrap.panelOverflow, 'the panel does not scroll sideways');
    ok(!wrap.bodyOverflow, 'and neither does the page');

    // ---------------------------------------------------------------- comps
    console.log('');
    console.log('== The comps drawer is really collapsed ==');
    const comps = await page.evaluate(() => {
        const r = [...document.querySelectorAll('.lt-row')].find(x => /MO34H-UC/.test(x.textContent));
        const d = r.querySelector('.lt-comps');
        const li = d ? d.querySelector('li') : null;
        return {
            summary: d ? d.querySelector('summary').textContent.trim() : '',
            // ⚠️ RENDERING, not markup — a closed <details> loses to any author
            // display rule, which is how the eBay rows on the All Stores cards
            // shipped visible with the drawer shut.
            //
            // ⚠️ AND checkVisibility(), NOT offsetParent. Chrome 151 collapses a
            // details through ::details-content { content-visibility: hidden }
            // rather than display:none on the children, so a genuinely invisible
            // <li> still reports a layout box and a non-null offsetParent. The
            // offsetParent test that the photo harness uses would now pass a
            // drawer that renders. Both are checked, since our own explicit
            // display:none rule should satisfy the older test too.
            visible: li && li.checkVisibility ? li.checkVisibility() : null,
            noBox: li ? li.offsetParent === null : null,
        };
    });
    ok(/2 Live eBay Listings/.test(comps.summary), 'it counts the comps', comps.summary);
    // ⚠️ It must never say "sold". eBay's sold-data API is a Limited Release we
    // do not hold, so the sample is live listings and calling it anything else
    // would be the most misleading word on the page.
    ok(!/sold/i.test(comps.summary), 'and it does NOT claim they are sold listings', comps.summary);
    ok(comps.visible === false, 'the list is genuinely not visible', 'checkVisibility=' + comps.visible);
    ok(comps.noBox === true, 'and it has no layout box either', 'offsetParent null=' + comps.noBox);

    const basis = await page.$$eval('.lt-basis', bs => bs.map(b => b.textContent.trim()));
    ok(basis.includes('Active Listings'), 'the market basis chip says Active Listings', basis.join(' | '));
    ok(!basis.some(b => /sold/i.test(b)), 'and no chip says Sold', basis.join(' | '));

    // ------------------------------------------------------------- the edit
    console.log('');
    console.log('== Typing a title changes what the button promises ==');
    await seed(page, QUEUE, null, 3);
    await page.evaluate(() => {
        const r = [...document.querySelectorAll('.lt-row')].find(x => /HMA82GS6DJR8N/.test(x.textContent));
        const i = r.querySelector('.lt-input');
        i.value = 'SK Hynix HMA82GS6DJR8N 8GB 1x8GB DDR4 2400MHz SODIMM RAM';
        i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const afterType = await page.evaluate(() => {
        const r = [...document.querySelectorAll('.lt-row')].find(x => /HMA82GS6DJR8N/.test(x.textContent));
        return {
            label: r.querySelector('.lt-ok').textContent.trim(),
            disabled: r.querySelector('.lt-ok').disabled,
            count: r.querySelector('.lt-count').textContent.trim(),
            held: _ltEdits.size,
        };
    });
    ok(afterType.disabled === false, 'Approve unlocks once a title is typed');
    ok(afterType.label === 'Save My Title', 'and it says Save My Title', afterType.label);
    ok(/^56\/80$/.test(afterType.count), 'the character count keeps up', afterType.count);
    ok(afterType.held === 1, 'the edit is held outside the DOM', String(afterType.held));

    // --------------------------------------------------------------- scope
    // The queue is customer-facing stock only, and the eBay third of that scope
    // is conditional. A reviewer who cannot see which state it is in reads a
    // short list as a clean catalogue.
    console.log('');
    console.log('== The panel says what is and is not in the list ==');
    await seed(page, { ...QUEUE, ebayScope: SCOPE_STALE }, null, 3);
    const stale = await page.evaluate(() => {
        const t = [...document.querySelectorAll('.lh-sec')].find(s => /Listing Titles/.test(s.textContent));
        const n = t.querySelector('.lt-scope');
        if (!n) return { found: false };
        const tabs = t.querySelector('.lt-modes');
        return { found: true, text: n.textContent.replace(/\s+/g, ' ').trim(),
                 warn: n.classList.contains('lt-scope-part'),
                 shown: n.checkVisibility(),
                 // Above the tabs: it describes the whole list, not one tier.
                 aboveTabs: !!tabs && n.compareDocumentPosition(tabs) === 4 };
    });
    ok(stale.found, 'a scope line is drawn');
    ok(stale.shown, 'and it is visible');
    ok(stale.aboveTabs, 'it sits above the tier tabs, not inside one tier');
    ok(/in stock/i.test(stale.text) && /online store/i.test(stale.text),
       'it names the two rules that ARE applied', stale.text.slice(0, 70));
    ok(/not being applied/i.test(stale.text) && /paused/i.test(stale.text),
       'and admits the eBay rule is not running');
    ok(/nothing is being hidden/i.test(stale.text),
       'and says which way that errs');
    ok(stale.warn, 'a half-applied scope is flagged, not stated flatly');

    await seed(page, { ...QUEUE, ebayScope: SCOPE_ACTIVE }, null, 3);
    const live = await page.evaluate(() => {
        const t = [...document.querySelectorAll('.lh-sec')].find(s => /Listing Titles/.test(s.textContent));
        const n = t.querySelector('.lt-scope');
        return { text: n ? n.textContent.replace(/\s+/g, ' ').trim() : '',
                 warn: n ? n.classList.contains('lt-scope-part') : null };
    });
    ok(/on ebay/i.test(live.text), 'with a fresh snapshot it claims the eBay rule', live.text);
    ok(!/not being applied|paused/i.test(live.text), 'and drops the caveat');
    ok(live.warn === false, 'and is quiet, not amber');

    // ⚠️ AN ALL CLEAR OVER A NARROWED LIST IS A SMALLER CLAIM THAN IT LOOKS.
    // This is the one place the scope line is load-bearing rather than helpful.
    await seed(page, { store: 'OVL', counts: {}, queue: [], ebayScope: SCOPE_ACTIVE }, null);
    const clearScope = await page.evaluate(() => {
        const t = [...document.querySelectorAll('.lh-sec')].find(s => /Listing Titles/.test(s.textContent));
        return { clear: !!t.querySelector('.lh-clear'),
                 scope: !!t.querySelector('.lt-scope') };
    });
    ok(clearScope.clear && clearScope.scope,
       'an all clear still says what it was an all clear OF');

    // ---------------------------------------------------------- all stores
    // The DM's landing view. A district manager does not open a store to find
    // out whether a store needs opening — the card has to carry the number.
    console.log('');
    console.log('== The All Stores card carries the title numbers ==');
    await page.evaluate(() => {
        _ecView = 'health';
        _ecScope = { allStores: true, stores: ['OVL', 'LEE'] };
        _ecHealth = { stores: ['OVL', 'LEE'].map(s => ({
            store: s, connected: true,
            counts: { live: 0, failed: 0 },
            freshness: { liveMinutes: 12 },
        })) };
        _rcCounts = {
            photos:   { OVL: 0, LEE: 0 },
            other:    { OVL: 3, LEE: 0 },
            unmatched:{ OVL: 1, LEE: 0 },
            misfiled: { OVL: 0, LEE: 0 },
            titles:      { OVL: 14, LEE: 3 },
            titlesWrong: { OVL: 2,  LEE: 0 },
        };
        ecRender();
    });
    const cards = await page.$$eval('.ec-hcard', cs => cs.map(c => ({
        store: c.querySelector('.ec-hstore')?.textContent?.trim(),
        rows: [...c.querySelectorAll('.ec-hrow')].map(r => ({
            k: r.querySelector('.ec-hk')?.textContent?.trim(),
            v: r.querySelector('.ec-hv')?.textContent?.trim(),
            colour: getComputedStyle(r.querySelector('.ec-hv')).color,
        })),
    })));
    const ovl = cards.find(c => c.store === 'OVL') || { rows: [] };
    const at = k => ovl.rows.find(r => new RegExp(k).test(r.k || ''));
    ok(cards.length === 2, 'a card per store', cards.map(c => c.store).join(' '));
    ok(!!at('Titles To Review'), 'the card names the title queue');
    ok(at('Titles To Review')?.v === '14', 'and carries the store\'s own number',
       at('Titles To Review')?.v);
    ok(at('Wrong Titles')?.v === '2', 'the severity-3 count is split out, not buried',
       at('Wrong Titles')?.v);
    // Red, like No Photos: both are a shopper being shown something wrong right
    // now, while everything else on the card is work queued up.
    ok(at('Wrong Titles')?.colour === at('No Photos')?.colour
       || at('Wrong Titles')?.colour !== at('Titles To Review')?.colour,
       'Wrong Titles is graded harder than the queue below it',
       at('Wrong Titles')?.colour);
    // ⚠️ THE CARD MUST READ IN THE SAME ORDER AS THE PAGE IT LEADS TO.
    const order = ovl.rows.map(r => r.k).filter(k =>
        /No Photos|Titles|In .Other|No Suggestion|Wrong Category/.test(k || ''));
    ok(/No Photos/.test(order[0]) && /Titles/.test(order[1] || '')
       && /Titles/.test(order[2] || '') && /Other/.test(order[3] || ''),
       'photos, then titles, then categories — the panel\'s own order',
       order.join(' > '));
    // A store with nothing wrong still shows the row: absent means "we could not
    // read it", and zero means "we looked".
    const lee = cards.find(c => c.store === 'LEE') || { rows: [] };
    ok(lee.rows.some(r => /Wrong Titles/.test(r.k || '') && r.v === '0'),
       'a clean store shows a zero, not a blank');

    // And a reader without the Titles half sees NO title rows at all, rather
    // than two dashes claiming we could not read something they were never given.
    await page.evaluate(() => {
        _rcCounts = { photos: { OVL: 0, LEE: 0 }, other: { OVL: 3, LEE: 0 },
                      unmatched: { OVL: 1, LEE: 0 }, misfiled: { OVL: 0, LEE: 0 } };
        ecRender();
    });
    const ungranted = await page.$$eval('.ec-hcard .ec-hk',
        ks => ks.map(k => k.textContent.trim()).filter(t => /Title/.test(t)));
    ok(ungranted.length === 0, 'no title rows when the reader does not hold Titles',
       ungranted.join(' | ') || 'none');

    // ------------------------------------------------------------- caution
    // CIB is the one suggestion that asserts something about the ITEM rather
    // than about the words, so the reviewer has to check it against the game in
    // their hand. That only works if the warning cannot be read as more of the
    // same grey reason text — hence its own block, its own colour, and this.
    console.log('');
    console.log('== A claim about the physical item carries a visible caution ==');
    await seed(page, QUEUE, null, 1);
    const caution = await page.evaluate(() => {
        const row = [...document.querySelectorAll('.lt-row')]
            .find(r => /Complete In Box/.test(r.textContent));
        if (!row) return null;
        const c = row.querySelector('.lt-caution');
        if (!c) return { found: false };
        const cs = getComputedStyle(c);
        const reason = c.closest('li');
        const rs = getComputedStyle(reason);
        return {
            found: true,
            text: c.textContent.replace(/\s+/g, ' ').trim(),
            shown: c.checkVisibility(),
            block: cs.display === 'block',
            // Different colour from the reason it sits under, or it is just more
            // grey text and nobody stops to read it.
            colour: cs.color, reasonColour: rs.color,
            // And it must not be the only thing on the row — the reason still
            // explains WHY, the caution only says what to check.
            hasReason: /highest-intent|case, manual and inserts/i.test(reason.textContent),
        };
    });
    ok(!!caution && caution.found, 'the CIB row draws a caution');
    ok(caution && caution.shown, 'and it is actually visible', String(caution && caution.shown));
    ok(caution && /confirm/i.test(caution.text), 'it asks for confirmation',
       caution && caution.text.slice(0, 60));
    ok(caution && caution.block, 'it is its own block, not a trailing clause');
    ok(caution && caution.colour !== caution.reasonColour,
       'and it is not the same colour as the reason', caution && caution.colour);
    ok(caution && caution.hasReason, 'the reason is still there beside it');
    const noCaution = await page.$$eval('.lt-row', rs =>
        rs.filter(r => !/Complete In Box/.test(r.textContent))
          .every(r => !r.querySelector('.lt-caution')));
    ok(noCaution, 'no other row carries one');

    // ------------------------------------------------------- clear / failed
    console.log('');
    console.log('== All clear is one line; a failed read is NOT an all clear ==');
    await seed(page, { store: 'OVL', counts: {}, queue: [] }, null);
    const clear = await page.evaluate(() => {
        const secs = [...document.querySelectorAll('.lh-sec')];
        const t = secs.find(s => /Listing Titles/.test(s.textContent));
        const c = t.querySelector('.lh-clear');
        return { text: c ? c.textContent.replace(/\s+/g, ' ').trim() : '',
                 h: c ? Math.round(c.getBoundingClientRect().height) : 0,
                 tabs: t.querySelectorAll('.lt-modes .rc-mode').length };
    });
    ok(/All Clear/.test(clear.text) && /OVL/.test(clear.text), 'it names the store', clear.text);
    ok(clear.h > 0 && clear.h <= 60, 'and it is ONE line high', clear.h + 'px');
    ok(clear.tabs === 0, 'no tier tabs when there is nothing to sort', String(clear.tabs));

    await seed(page, null, 'unauthorized');
    const failed = await page.evaluate(() => {
        const t = [...document.querySelectorAll('.lh-sec')].find(s => /Listing Titles/.test(s.textContent));
        return { text: t.textContent.replace(/\s+/g, ' ').trim(),
                 clear: !!t.querySelector('.lh-clear') };
    });
    ok(!failed.clear, 'a failed read draws NO all-clear line');
    ok(/not an all clear/i.test(failed.text), 'and says nobody has looked yet', failed.text.slice(0, 90));

    // ----------------------------------------------------------- screenshot
    await seed(page, QUEUE, null, 3);
    await new Promise(r => setTimeout(r, 260));
    const el = await page.$('#ecBody');
    if (el) await el.screenshot({ path: SHOT + '/listing-titles.png' });
    await seed(page, QUEUE, null, 2);
    await new Promise(r => setTimeout(r, 260));
    const el2 = await page.$('#ecBody');
    if (el2) await el2.screenshot({ path: SHOT + '/listing-titles-findable.png' });
    // The Opportunity tier, where the CIB caution lives — the one thing on this
    // panel a reviewer has to check against the item rather than against the screen.
    await seed(page, QUEUE, null, 1);
    await new Promise(r => setTimeout(r, 260));
    const el3 = await page.$('#ecBody');
    if (el3) await el3.screenshot({ path: SHOT + '/listing-titles-caution.png' });

    console.log('');
    ok(errs.length === 0, 'no page errors', errs.slice(0, 3).join(' / ') || 'none');
    console.log('');
    console.log(fails ? `*** ${fails} FAILED ***` : 'all passed');
    console.log('shots: ' + SHOT + '/listing-titles.png (+ -findable, -caution)');
    await browser.close();
    process.exit(fails ? 1 : 0);
})();
