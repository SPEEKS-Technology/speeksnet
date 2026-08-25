// SPEEKS Connect: the store picker must disappear on the All Stores tab.
//
// "All Stores" shows every store at once, so a one-store picker beside it means
// nothing. _ecSyncChrome already intended this and never worked, because it set
// display on the <select> only — and every select on the site is wrapped by the
// custom dropdown (_ddInit): the native one is moved into a .dd-host and covered
// by a .dd-btn face, so hiding it hides the half nobody can see.
//
// ⚠️ THIS IS WHY THE CHECK MEASURES .dd-btn AND .dd-host, NOT THE SELECT.
// getComputedStyle(select).display is 'none' either way — the enhancer hides the
// native one regardless — so an assertion on the select passes whether the
// control is on screen or not. That false green is how the same bug survived for
// weeks on the Call Backs filter.
//
//   NODE_PATH=$(npm root -g) node scripts/connect-store-picker-check.js
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

let fails = 0;
const ok = (c, label, got) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + label + (got === undefined ? '' : '   ' + got));
    if (!c) fails++;
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--disable-gpu', '--allow-file-access-from-files'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Layout Harness');
        sessionStorage.setItem('speeksUserRole', 'district manager');
        sessionStorage.setItem('speeksUserStore', 'CORP');
    });
    await page.goto('file:///' + REPO + '/operations.html', { waitUntil: 'networkidle2' }).catch(() => {});
    await page.evaluate(() => {
        const ov = document.getElementById('authOverlay'); if (ov) ov.style.display = 'none';
        document.documentElement.classList.remove('no-scroll');
        document.body.classList.remove('no-scroll', 'preload');
        document.body.classList.add('is-authenticated');
        if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
    });
    await new Promise(r => setTimeout(r, 900));

    const probe = await page.evaluate(() => {
        const panel = document.getElementById('ebayChannelPanel')
            || document.getElementById('ecStoreFilter')?.closest('.modal-menu, .dynamic-module, section, div');
        if (panel) { panel.style.display = 'block'; panel.style.visibility = 'visible'; }

        // A district manager with all five stores: the only case where the picker
        // exists at all (it is hidden outright for a single-store user).
        try {
            _ecScope = { allStores: true, stores: ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'] };
            _ecStore = 'OVL';
        } catch (e) { return { err: 'could not set _ecScope: ' + e.message }; }

        const read = () => {
            const sel = document.getElementById('ecStoreFilter');
            if (!sel) return { missing: true };
            const host = sel.closest('.dd-host');
            const btn = host ? host.querySelector('.dd-btn') : null;
            const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
            return {
                wrapped: !!host,
                selDisplay: getComputedStyle(sel).display,
                hostDisplay: host ? getComputedStyle(host).display : null,
                hostBox: rect(host),
                btnBox: rect(btn),
                // What a person can actually see and hit.
                faceVisible: !!btn && btn.getClientRects().length > 0
                    && getComputedStyle(btn).visibility !== 'hidden',
            };
        };

        const out = {};
        _ecView = 'listings'; _ecSyncChrome(); out.listings = read();
        _ecView = 'health';   _ecSyncChrome(); out.health = read();
        _ecView = 'cats';     _ecSyncChrome(); out.cats = read();
        _ecView = 'listings'; _ecSyncChrome(); out.backToListings = read();
        return out;
    });

    if (probe.err) { console.log('  SETUP FAIL  ' + probe.err); process.exitCode = 1; await browser.close(); return; }

    console.log('\n--- SPEEKS Connect store picker, DM with 5 stores ---');
    console.log('  (enhancer wrapped the select: ' + probe.listings.wrapped + ')');
    ok(probe.listings.wrapped, 'the select is inside a .dd-host, so .dd-btn is the thing to measure');
    ok(probe.listings.faceVisible === true, 'Upload tab: picker IS shown', JSON.stringify(probe.listings.btnBox));
    ok(probe.health.faceVisible === false, 'All Stores tab: picker is GONE', JSON.stringify(probe.health));
    ok(probe.cats.faceVisible === true, 'Categories tab: picker IS shown', JSON.stringify(probe.cats.btnBox));
    ok(probe.backToListings.faceVisible === true, 'back to Upload: picker returns', JSON.stringify(probe.backToListings.btnBox));

    // The trap, spelled out so nobody "simplifies" this check into a one-liner on
    // the select later. Here the select's own display DOES move (none vs block),
    // because _ecSyncChrome sets it inline as well — so it happens to look like a
    // usable signal. It is not one: the visible half is the .dd-btn face, and the
    // Call Backs filter proved it by hiding the select alone and leaving the face
    // on screen for weeks. A green check on the select says nothing about whether
    // anyone can see the control.
    console.log('\n  note: select display — All Stores = ' + probe.health.selDisplay
        + ', Upload = ' + probe.listings.selDisplay
        + '   (moves here, but the .dd-btn face above is the assertion that counts)');
    console.log('        .dd-host display — All Stores = ' + probe.health.hostDisplay
        + ', Upload = ' + probe.listings.hostDisplay);

    console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
    process.exitCode = fails ? 1 : 0;
    await browser.close();
})();
