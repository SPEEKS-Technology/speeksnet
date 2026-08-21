// SPEEKS Connect → Categories, driven as a real DM against the live functions.
//
// The panel writes to five live storefronts, so what this asserts is mostly
// about restraint:
//
//   1. the Categories tab exists for a corp role and loads a queue
//   2. every row shows the RULE that decided it — without that, a lucky match
//      and a good one look identical
//   3. every row offers both answers, and the destination is a shelf TITLE
//      ("Charging & Power"), not a handle
//   4. selecting rows arms the bulk button with a live count, and Select All
//      takes the whole queue
//   5. NOTHING IS WRITTEN BY LOADING OR SELECTING. The queue length at the end
//      equals the queue length at the start — the panel is a suggestion until
//      somebody clicks File It, and this harness never does.
//   6. no console errors
//
// SPEEKS_TEST_PIN must be a corp PIN. NODE_PATH must point at a node_modules
// with puppeteer-core.
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const PIN = process.env.SPEEKS_TEST_PIN || '';

let fails = 0;
// Two noises that are the harness's own fault, not the panel's:
// the Google Calendar embed has no session in headless, and a canvas drawn
// from file:// images is tainted so its toDataURL throws — neither happens on
// the real https page.
const IGNORE = /calendar\.google\.com|toDataURL|[Tt]ainted canvas/;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

(async () => {
    if (!PIN) { console.error('SPEEKS_TEST_PIN is required'); process.exit(2); }

    const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) errs.push(m); });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const where = ((m.location() || {}).url || '') + ' ' + m.text();
        if (!IGNORE.test(where)) errs.push(m.text());
    });
    await page.setViewport({ width: 1500, height: 1000 });
    await page.evaluateOnNewDocument(pin => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserPin', pin);
        sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
        sessionStorage.setItem('speeksUserRole', 'district manager');
        sessionStorage.setItem('speeksUserStore', 'CORP');
    }, PIN);

    await page.goto('file:///' + REPO + '/operations.html', { waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));

    console.log('== The Categories tab ==');
    // The button is revealed by _ecSyncChrome once the eBay scope comes back,
    // so it has to be WAITED for, not merely found. Clicking it early is a
    // no-op that leaves the panel on Upload and reads exactly like an empty
    // queue — which is how this harness lied the first time it ran.
    const tabShown = await page.waitForFunction(
        () => { const b = document.getElementById('ecViewCatsBtn'); return b && b.style.display !== 'none'; },
        { timeout: 15000 }).then(() => true).catch(() => false);
    ok(tabShown, 'a DM is offered the Categories tab');

    await page.click('#ecViewCatsBtn');
    // Wait on the PANEL'S OWN state, not on the DOM. Waiting for ".rc-table or
    // .ec-empty" passes instantly against the Upload view still on screen —
    // which is how this harness reported an empty queue while the queue was
    // still loading, twice.
    await page.waitForFunction(
        () => window._dbgRecat && window._dbgRecat().view === 'cats' && window._dbgRecat().loaded,
        { timeout: 25000 }).catch(() => {});

    const before = await page.$$eval('.rc-table tbody tr', rs => rs.length);
    ok(before > 0, 'the queue loads', `${before} rows`);
    if (!before) {
        // An empty queue and a panel that never switched views look identical
        // from the outside. _dbgRecat is the only thing that tells them apart.
        const state = await page.evaluate(() => window._dbgRecat ? window._dbgRecat() : 'no hook');
        console.log('    panel state:', JSON.stringify(state));
        console.log('    body:', (await page.$eval('#ecBody', e => e.innerHTML)).slice(0, 260).replace(/\s+/g, ' '));
    }

    const first = await page.$eval('.rc-table tbody tr', tr => ({
        title: tr.querySelector('.rc-title')?.textContent?.trim() || '',
        rule: tr.querySelector('.rc-rule')?.textContent?.trim() || '',
        to: tr.querySelector('.rc-to')?.textContent?.trim() || '',
        from: tr.querySelector('.rc-from')?.textContent?.trim() || '',
        acts: [...tr.querySelectorAll('.rc-acts button')].map(b => b.textContent.trim()),
    })).catch(() => null);
    ok(!!first?.title, 'a row names the item', first?.title);
    ok(!!first?.rule, 'and shows the rule that decided it', first?.rule);
    ok(first?.from === 'Other' && !!first?.to, 'and reads Other → a shelf', `${first?.from} → ${first?.to}`);
    ok(/[a-z]/.test(first?.to || '') && !(first?.to || '').includes('-'),
        'the shelf is a title, not a handle', first?.to);
    ok(first?.acts.join(' / ') === "File It / Not This One", 'both answers are offered', first?.acts.join(' / '));

    const ruled = await page.$$eval('.rc-table tbody tr', rs =>
        rs.filter(r => r.querySelector('.rc-rule')?.textContent?.trim()).length);
    ok(ruled === before, 'every row shows its rule', `${ruled}/${before}`);

    console.log('\n== Selecting ==');
    await page.$eval('.rc-table tbody tr .rc-pick input', el => el.click());
    await new Promise(r => setTimeout(r, 250));
    let btn = await page.$eval('#rcFileBtn', b => ({ text: b.textContent.trim(), disabled: b.disabled }));
    ok(!btn.disabled && /File 1 Selected/.test(btn.text), 'one row arms the bulk button', btn.text);

    await page.$eval('#rcAll', el => el.click());
    await new Promise(r => setTimeout(r, 400));
    btn = await page.$eval('#rcFileBtn', b => ({ text: b.textContent.trim(), disabled: b.disabled }));
    ok(btn.text === `File ${before} Selected`, 'Select All takes the whole queue', btn.text);

    await page.$eval('#rcAll', el => el.click());
    await new Promise(r => setTimeout(r, 400));
    btn = await page.$eval('#rcFileBtn', b => ({ text: b.textContent.trim(), disabled: b.disabled }));
    ok(btn.disabled, 'and clearing it disarms the button', btn.text);

    console.log('\n== Nothing was written ==');
    const after = await page.$$eval('.rc-table tbody tr', rs => rs.length);
    ok(after === before, 'the queue is the length it started', `${before} → ${after}`);
    const sub = await page.$eval('#ecSubtitle', e => e.textContent.trim());
    ok(/To File/.test(sub), 'the header counts what is left', sub);

    ok(errs.length === 0, 'no console errors', errs.length ? errs.slice(0, 3).join(' | ') : 'clean');

    await browser.close();
    console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
    process.exit(fails ? 1 : 0);
})();
