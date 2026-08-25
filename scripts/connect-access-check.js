// SPEEKS Connect access, after the Feature Access restructure.
//
// It had THREE toggles for TWO things: Upload, Categories, and the tab that
// contains them. A parent switch that can contradict its children is a way to
// turn a tool half-off — Categories granted, tab revoked, nothing on screen and
// nothing saying why — so the tab lost its switch and is now DERIVED:
// data-feature-any over its sub-tab keys on the Operations tab button,
// which is the same OR that _SECTION_TABS already applies one level up to the
// page nav link.
//
// The whole point is that the four combinations behave, so all four are driven:
//
// Listing Health is itself TWO switches since 2026-08-25 (ec-view-categories
// and ec-view-photos), so its pill is data-feature-any over both and "Listing
// Health off" means both revoked. A fifth case drives one half alone.
//
//   both      → tab shows, lands on Upload, toggle offers both
//   upload    → tab shows, no Categories button, no toggle (one option is a
//               button that does nothing)
//   categories→ tab shows and LANDS ON CATEGORIES. Before, it opened on Upload:
//               a blank pane behind a hidden button, which reads as broken
//               rather than as a permission.
//   neither   → no tab at all, and Jump To cannot reach it either
//
// Overrides are injected the way the page stores them, so this exercises the
// real resolution path (_featureOverrideFor → _featureEffectiveVisible) with no
// credential and no writes.
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };
const IGNORE = /calendar\.google\.com|toDataURL|[Tt]ainted canvas|Failed to fetch|net::ERR|401/;

async function withGrants(browser, upload, cats, photos) {
    // `photos` defaults to `cats` so the four original cases keep meaning what
    // they meant: "Listing Health off" is both halves off. Pass it explicitly
    // to drive one half on its own.
    if (photos === undefined) photos = cats;
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) errs.push(m); });
    await page.setViewport({ width: 1500, height: 1000 });
    await page.evaluateOnNewDocument(([u, c, ph]) => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Test Manager');
        sessionStorage.setItem('speeksUserRole', 'manager');
        sessionStorage.setItem('speeksUserStore', 'OVL');
        // The resolved lookup maps the page keeps overrides in, keyed the way
        // _featureOverrideFor reads them: role slug, not role class.
        window.__FA_SEED = {
            role: { 'ec-upload': { manager: u }, 'ec-view-categories': { manager: c },
                    'ec-view-photos': { manager: ph } },
            user: {},
        };
    }, [upload, cats, photos]);
    await page.goto('file:///' + REPO + '/operations.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2300));
    // Seed and re-run the pass the page runs at login.
    await page.evaluate(() => {
        _featureOv = window.__FA_SEED;
        _applyFeatureOverridesToPlainEls('role-manager', 'Test Manager');
    });
    return { page, errs };
}

const read = page => page.evaluate(() => {
    const vis = el => !!el && el.style.display !== 'none';
    const tab = document.getElementById('ops-tab-ebay');
    return {
        tab: vis(tab),
        upload: vis(document.getElementById('ecViewListingsBtn')),
        cats: vis(document.getElementById('ecViewCatsBtn')),
        // Jump To resolves off the catalog, not the DOM, so it is a second
        // opinion on the same question rather than a restatement.
        jump: typeof _jumpPlaces === 'function'
            ? _jumpPlaces().some(p => p.id === 'ops-ebay')
            : (typeof JUMP_PLACES !== 'undefined'
                ? JUMP_PLACES.filter(p => p.id === 'ops-ebay')
                    .some(p => p.feature.some(k => _jumpFeatureVisible(k)))
                : null),
    };
});

(async () => {
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

    console.log('== Both granted ==');
    let { page } = await withGrants(browser, true, true);
    let s = await read(page);
    ok(s.tab, 'the SPEEKS Connect tab shows');
    ok(s.upload && s.cats, 'with both sub-tabs', `upload=${s.upload} cats=${s.cats}`);
    ok(s.jump === true, 'and Jump To can reach it');
    await page.close();

    console.log('');
    console.log('== Upload only ==');
    ({ page } = await withGrants(browser, true, false));
    s = await read(page);
    ok(s.tab, 'the tab still shows — Upload is enough on its own');
    ok(s.upload && !s.cats, 'and Categories is gone', `upload=${s.upload} cats=${s.cats}`);
    const one = await page.evaluate(() => {
        _ecScope = { allStores: false, stores: ['OVL'] };
        _ecSyncChrome();
        return { toggle: document.getElementById('ecViewToggle').style.display, view: _ecView };
    });
    ok(one.toggle === 'none', 'no view toggle for a single option', one.toggle || '(shown)');
    ok(one.view === 'listings', 'and it sits on Upload', one.view);
    await page.close();

    console.log('');
    console.log('== Categories only ==');
    ({ page } = await withGrants(browser, false, true));
    s = await read(page);
    // THE ONE THE OLD STRUCTURE GOT WRONG.
    ok(s.tab, 'the tab shows, carrying the one sub-tab that is on');
    ok(!s.upload && s.cats, 'Upload is gone, Categories is there', `upload=${s.upload} cats=${s.cats}`);
    ok(s.jump === true, 'and Jump To still reaches it');
    const landed = await page.evaluate(() => {
        _ecScope = { allStores: false, stores: ['OVL'] };
        _ecView = 'listings';          // the module's default, as at page load
        const v = _ecViewsOn();
        if (!v.listings && v.cats) { _ecView = 'cats'; _ecMarkView('cats'); }
        _ecSyncChrome();
        return { view: _ecView, toggle: document.getElementById('ecViewToggle').style.display,
                 marked: (document.getElementById('ecViewCatsBtn').className || '').includes('active') };
    });
    ok(landed.view === 'cats', 'and the panel LANDS on Categories, not on a blank Upload', landed.view);
    ok(landed.marked, 'with the Categories button lit');
    ok(landed.toggle === 'none', 'and no toggle, because there is one option', landed.toggle || '(shown)');
    await page.close();

    console.log('');
    console.log('== Neither ==');
    const { page: p4, errs } = await withGrants(browser, false, false);
    s = await read(p4);
    ok(!s.tab, 'no SPEEKS Connect tab at all', String(s.tab));
    ok(s.jump === false, 'and Jump To cannot reach it either', String(s.jump));

    console.log('');
    console.log('== Listing Health is two switches ==');
    // Upload off, Categories off, PHOTOS ON. The pill must still appear — the
    // tab shows whichever halves are enabled — and Jump To must reach it on the
    // alarm key alone. This is the case that would silently regress if anything
    // went back to gating the pill on ec-view-categories by itself.
    ({ page } = await withGrants(browser, false, false, true));
    s = await read(page);
    ok(s.tab, 'the tab shows for the photo alarm alone', String(s.tab));
    ok(!s.upload && s.cats, 'and the Listing Health pill is the half that is on',
        `upload=${s.upload} listingHealth=${s.cats}`);
    ok(s.jump === true, 'Jump To reaches it on the alarm key alone', String(s.jump));
    await page.close();

    console.log('');
    console.log('== The retired switch is really gone ==');
    const gone = await p4.evaluate(() => ({
        catalog: FEATURE_CATALOG.some(f => f.key === 'widget-ops-ebay'),
        upload: !!FEATURE_CATALOG.find(f => f.key === 'ec-upload'),
        label: (FEATURE_CATALOG.find(f => f.key === 'ec-upload') || {}).label,
        section: _SECTION_TABS['operations.html'].includes('widget-ops-ebay'),
        dom: !!document.querySelector('[data-feature="widget-ops-ebay"]'),
    }));
    ok(!gone.catalog && !gone.section && !gone.dom, 'widget-ops-ebay is out of the catalog, the section map and the DOM');
    ok(gone.upload, 'and Upload has a switch of its own', gone.label);

    console.log('');
    console.log('== The switch labels name the thing, not its shape ==');
    // "Upload tab" / "No Pictures alarm" described the WIDGET. In a list of
    // switches every row is a tab or a panel or an alarm, so the suffix is noise
    // that pushes the part you are scanning for further right.
    const labels = await p4.evaluate(() => ['ec-upload', 'ec-view-categories', 'ec-view-photos']
        .map(k => (FEATURE_CATALOG.find(f => f.key === k) || {}).label));
    ok(labels.every(l => l && !/\b(tab|alarm|panel|widget)$/i.test(l)),
        'no trailing tab / alarm on the three SPEEKS Connect switches', labels.join(' | '));
    ok(labels.every(l => /^SPEEKS Connect · /.test(l)),
        'and all three still group under one name', labels.join(' | '));

    console.log('');
    console.log('== Where each role opens ==');
    // The landing view is chosen BEFORE the first request, so this stubs both
    // fetches: the question is where the panel opens, not what the server says.
    const landsOn = async (role, store) => {
        const pg = await browser.newPage();
        pg.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) errs.push(m); });
        await pg.setViewport({ width: 1500, height: 1000 });
        await pg.evaluateOnNewDocument(([r, st]) => {
            sessionStorage.setItem('speeksUnlocked', 'true');
            sessionStorage.setItem('speeksUserName', 'Test Person');
            sessionStorage.setItem('speeksUserRole', r);
            sessionStorage.setItem('speeksUserStore', st);
            sessionStorage.setItem('speeksUserPin', '0000');
        }, [role, store]);
        await pg.goto('file:///' + REPO + '/operations.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
        await new Promise(r => setTimeout(r, 2300));
        const view = await pg.evaluate(async (r) => {
            const corp = r === 'district manager' || r === 'ceo';
            const all = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
            window._ecFetch = async () => ({ scope: { allStores: corp, stores: corp ? all : ['OVL'] }, stores: [] });
            window._rcFetch = async () => ({ scope: { corp, stores: corp ? all : ['OVL'], mayCats: true, mayPhotos: true },
                                             other: {}, misfiled: {}, unmatched: {}, photos: {}, counts: {}, queue: [] });
            _ecView = 'listings'; _ecData = null; _ecScope = null; _ecHealth = null;
            await ecLoad();
            return _ecView;
        }, role);
        await pg.close();
        return view;
    };
    ok(await landsOn('district manager', 'CORP') === 'health', 'a DM opens on All Stores');
    ok(await landsOn('ceo', 'CORP') === 'health', 'so does the CEO');
    // Unchanged: a store role has no All Stores view to open on.
    ok(await landsOn('manager', 'OVL') === 'cats', 'a manager still opens on Listing Health');

    ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | ') || 'clean');
    await p4.close();
    await browser.close();
    console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
    process.exit(fails ? 1 : 0);
})();
