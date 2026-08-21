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
//      somebody clicks Submit, and this harness never does.
//   6. the two destinations on every row — the storefront and the Shopify admin
//      — with the admin link built from the numeric product id, not the handle
//   7. the two middle columns sit under their own headings
//   8. THE PICKER LEAVES WITH ITS ROW. Scroll the queue with a shelf list open
//      and it used to stay parked mid-page, over rows it would not file
//   9. a MANAGER is offered the tab (Feature Access owns that button now), sees
//      only their own store, and lands right with #categories
//  10. the feed card fires for a manager and NOT for corp, and its snooze is
//      keyed to the counts so new stock breaks through
//  11. no console errors
//
// SPEEKS_TEST_PIN must be a corp PIN. SPEEKS_TEST_PIN_MGR is optional and adds
// checks 9 and 10. NODE_PATH must point at a node_modules with puppeteer-core.
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const PIN = process.env.SPEEKS_TEST_PIN || '';
const MGR_PIN = process.env.SPEEKS_TEST_PIN_MGR || '';

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
    ok(first?.acts.join(' / ') === "Submit / Remove", 'both answers are offered', first?.acts.join(' / '));

    const ruled = await page.$$eval('.rc-table tbody tr', rs =>
        rs.filter(r => r.querySelector('.rc-rule')?.textContent?.trim()).length);
    ok(ruled === before, 'every row shows its rule', `${ruled}/${before}`);

    // The queue is a subset and has to say so. A reviewer who knows the store
    // holds 500 unfiled units reads a queue of 52 as the panel being broken,
    // not as the 448 nobody can buy online being left out of it.
    const note = await page.$eval(".rc-note", e => e.textContent.trim()).catch(() => "");
    ok(/online store/i.test(note), "the panel says what it is showing", note || "NO NOTE");


    console.log('');
    console.log('== The two queues, and what is not on screen ==');
    const pills = await page.$$eval('.rc-modes .rc-mode', bs => bs.map(b => ({
        text: b.textContent.replace(/\s+/g, ' ').trim(),
        w: Math.round(b.getBoundingClientRect().width),
    })));
    ok(pills.length === 2, 'two queue pills', pills.map(p => p.text).join(' | '));
    ok(/“?Other”? Collection/.test(pills[0]?.text || ''), 'the first is named for the collection', pills[0]?.text);
    ok(/^Wrong Category/.test(pills[1]?.text || ''), 'the second says what is wrong', pills[1]?.text);
    // Same kind of control, so the same box. Measured, not trusted to a min-width
    // that a longer label or a 3-digit count could quietly outgrow.
    ok(pills[0]?.w === pills[1]?.w, 'and both are the same size', `${pills[0]?.w}px / ${pills[1]?.w}px`);
    // The per-store chips are gone: everybody who saw them also has the dropdown.
    ok(await page.$('.rc-strip') === null, 'no per-store chips above the queue');



    console.log('');
    console.log('== Both tabs carry this store\'s number ==');
    const tabN = await page.$$eval('.rc-modes .rc-mode .rc-chip-n', ns => ns.map(n => Number(n.textContent.trim())));
    const state = await page.evaluate(() => window._dbgRecat());
    ok(tabN.length === 2, 'both tabs show a count', JSON.stringify(tabN));
    // The one that matters: the badge on the tab you are NOT on used to carry the
    // whole scope, so a DM on OVL read 17 above a list of one.
    ok(tabN[0] === state.queue, 'the open tab agrees with the list under it', `${tabN[0]} / ${state.queue}`);
    ok(tabN[1] === state.counts.misfiled && tabN[1] < 10,
        'and the other tab is this store, not all five', `${tabN[1]}`);

    console.log('');
    console.log('== A skipped row says what it was ==');
    const skip = await page.evaluate(() => {
        const d = document.querySelector('.rc-skips');
        if (!d) return null;
        d.open = true;
        const r = d.querySelector('.rc-skiprow');
        if (!r) return null;
        const btn = r.querySelector('.ec-btn').getBoundingClientRect();
        const rm = [...document.querySelectorAll('.rc-table tbody tr .rc-acts .ec-btn')].pop().getBoundingClientRect();
        return {
            title: r.querySelector('.rc-title')?.textContent?.trim() || '',
            sub: r.querySelector('.rc-sub')?.textContent?.trim() || '',
            dRight: Math.abs(btn.right - rm.right),
        };
    });
    if (skip) {
        // The question a skip has to answer is "was I right", and the answer is
        // where the item sits NOW — an id alone cannot tell you.
        ok(!!skip.title, 'it names the item', skip.title.slice(0, 44));
        ok(/·/.test(skip.sub) && /Now In/i.test(skip.sub), 'and the SKU, the id and where it is now', skip.sub.slice(0, 80));
        ok(skip.dRight <= 1, 'Put It Back squares up with Remove', `${skip.dRight.toFixed(1)}px apart`);
    } else {
        console.log('  SKIPPED (nothing skipped at this store)');
    }
    console.log('');
    console.log('== The links sit beside the title, in their own column ==');
    const geom = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.rc-table tbody tr')].slice(0, 8);
        const xs = new Set();
        let sameLine = 0;
        rows.forEach(tr => {
            const t = tr.querySelector('.rc-title').getBoundingClientRect();
            const p = tr.querySelector('.rc-links').getBoundingClientRect();
            xs.add(Math.round(p.left));
            // Beside, not under: the pills start after the title ends and overlap
            // its line vertically.
            if (p.left > t.right - 2 && p.top < t.bottom && p.bottom > t.top) sameLine += 1;
        });
        return { rows: rows.length, sameLine, columns: xs.size };
    });
    ok(geom.sameLine === geom.rows, 'every row has them beside its title', geom.sameLine + '/' + geom.rows);
    // A column, not a flex row: the whole point is that they do not move with the
    // length of the title, so every row lines up.
    ok(geom.columns === 1, 'and all at the same x, however long the title', geom.columns + ' distinct x');
    console.log('');
    console.log('== The two destinations ==');
    // One listing lives in two places and a reviewer needs both: the storefront
    // to see what a shopper sees, the admin to fix a title by hand. Asserting the
    // shape of the URLs, not just that two pills exist — an admin link built from
    // the product HANDLE instead of the numeric id 404s, and looks fine until
    // somebody clicks it.
    const links = await page.$eval('.rc-table tbody tr .rc-links', el =>
        [...el.querySelectorAll('a')].map(a => ({ label: a.textContent.trim(), href: a.href }))
    ).catch(() => []);
    ok(links.length === 2, 'every row offers both links', links.map(l => l.label).join(' / '));
    ok(/\/products\//.test(links[0]?.href || ''), 'the first goes to the storefront', (links[0]?.href || '').slice(0, 72));
    ok(/\/admin\/products\/\d+$/.test(links[1]?.href || ''), 'the second goes to the Shopify admin, by numeric id',
        (links[1]?.href || '').slice(-46));

    console.log('');
    console.log('== The columns line up ==');
    // The headings were centred and the cells were not, so every column read as
    // though it had slipped a notch left.
    const align = await page.evaluate(() => {
        const tr = document.querySelector('.rc-table tbody tr');
        const th = document.querySelectorAll('.rc-table thead th');
        const td = tr.querySelectorAll('td');
        const get = el => getComputedStyle(el).textAlign;
        return { h2: get(th[2]), c2: get(td[2]), h3: get(th[3]), c3: get(td[3]) };
    });
    ok(align.h2 === align.c2, 'Matched On sits under its heading', `${align.h2} / ${align.c2}`);
    ok(align.h3 === align.c3, 'Move To sits under its heading', `${align.h3} / ${align.c3}`);

    console.log('');
    console.log('== The picker leaves with its row ==');
    // The reported glitch: _ecCatPlace ends in a clamp that keeps the popover on
    // screen whatever the arithmetic said, so scrolling the queue left a list of
    // shelves parked mid-page over rows it would not file.
    await page.click('.rc-table tbody tr .rc-shelf');
    await new Promise(r => setTimeout(r, 350));
    ok(await page.$('#ecCatPop') !== null, 'the picker opens');
    await page.evaluate(() => window.scrollBy(0, 1200));
    await new Promise(r => setTimeout(r, 350));
    ok(await page.$('#ecCatPop') === null, 'and closes once its row has scrolled away');
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 250));

    console.log('\n== Selecting ==');
    await page.$eval('.rc-table tbody tr .rc-pick input', el => el.click());
    await new Promise(r => setTimeout(r, 250));
    let btn = await page.$eval('#rcFileBtn', b => ({ text: b.textContent.trim(), disabled: b.disabled }));
    ok(!btn.disabled && /Submit 1 Selected/.test(btn.text), 'one row arms the bulk button', btn.text);

    await page.$eval('#rcAll', el => el.click());
    await new Promise(r => setTimeout(r, 400));
    btn = await page.$eval('#rcFileBtn', b => ({ text: b.textContent.trim(), disabled: b.disabled }));
    ok(btn.text === `Submit ${before} Selected`, 'Select All takes the whole queue', btn.text);

    await page.$eval('#rcAll', el => el.click());
    await new Promise(r => setTimeout(r, 400));
    btn = await page.$eval('#rcFileBtn', b => ({ text: b.textContent.trim(), disabled: b.disabled }));
    ok(btn.disabled, 'and clearing it disarms the button', btn.text);

    console.log('\n== Choosing a different shelf ==');
    const proposed = await page.$eval('.rc-table tbody tr .rc-shelf .rc-to', e => e.textContent.trim());
    await page.click('.rc-table tbody tr .rc-shelf');
    await new Promise(r => setTimeout(r, 400));
    const opts = await page.$$eval('#ecCatPop .ec-catopt', bs => bs.length).catch(() => 0);
    ok(opts > 20, 'the picker lists every shelf', `${opts} options`);
    const marked = await page.$eval('#ecCatPop .ec-catopt-on .rc-optnow', e => e.textContent.trim()).catch(() => '');
    ok(marked === 'Current', 'and marks the one it is on now', marked || 'NOT MARKED');

    await page.type('#ecCatQ', 'Networking');
    await new Promise(r => setTimeout(r, 350));
    const filtered = await page.$$eval('#ecCatPop .ec-catopt', bs => bs.map(b => b.textContent.trim()));
    ok(filtered.length === 1 && /Networking/.test(filtered[0]), 'and searches by name', filtered.join(', '));

    await page.click('#ecCatPop .ec-catopt');
    await new Promise(r => setTimeout(r, 600));
    const after1 = await page.$eval('.rc-table tbody tr .rc-shelf', e => ({
        to: e.querySelector('.rc-to').textContent.trim(),
        picked: e.classList.contains('rc-shelf-picked'),
    }));
    ok(after1.to === 'Networking' && after1.to !== proposed,
        'the row takes the chosen shelf', `${proposed} → ${after1.to}`);
    ok(after1.picked, 'and shows that a person chose it, not the rule');
    ok(!(await page.$('#ecCatPop')), 'the picker closes on choosing');

    // Put it back, so the harness leaves no opinion behind for the next reader.
    await page.click('.rc-table tbody tr .rc-shelf');
    await new Promise(r => setTimeout(r, 400));
    await page.type('#ecCatQ', proposed);
    await new Promise(r => setTimeout(r, 350));
    await page.click('#ecCatPop .ec-catopt');
    await new Promise(r => setTimeout(r, 500));
    const back = await page.$eval('.rc-table tbody tr .rc-shelf', e => ({
        to: e.querySelector('.rc-to').textContent.trim(),
        picked: e.classList.contains('rc-shelf-picked'),
    }));
    ok(back.to === proposed && !back.picked, 'choosing the rule\'s own answer clears the override', back.to);

    console.log('\n== Nothing was written ==');
    const after = await page.$$eval('.rc-table tbody tr', rs => rs.length);
    ok(after === before, 'the queue is the length it started', `${before} → ${after}`);
    const sub = await page.$eval('#ecSubtitle', e => e.textContent.trim());
    ok(/To Submit/.test(sub), 'the header counts what is left', sub);

    ok(errs.length === 0, 'no console errors', errs.length ? errs.slice(0, 3).join(' | ') : 'clean');

    console.log('');
    console.log('== The All Stores tab carries the same two numbers ==');
    await page.click('#ecViewHealthBtn');
    await page.waitForFunction(() => document.querySelectorAll('.ec-hcard').length > 0, { timeout: 20000 }).catch(() => {});
    // The counts come from shopify-recat, not from the health view, so they land
    // a beat later than the eBay rows.
    await page.waitForFunction(
        () => [...document.querySelectorAll('.ec-hk')].some(k => /Wrong Category/.test(k.textContent)),
        { timeout: 20000 }).catch(() => {});
    const cards = await page.$$eval('.ec-hcard', cs => cs.map(c => ({
        store: c.querySelector('.ec-hstore')?.textContent?.trim(),
        keys: [...c.querySelectorAll('.ec-hk')].map(k => k.textContent.trim()),
        vals: [...c.querySelectorAll('.ec-hrow')].map(r => r.querySelector('.ec-hv')?.textContent?.trim()),
    })));
    ok(cards.length === 5, 'a card per store', cards.map(c => c.store).join(' '));
    ok(cards.every(c => c.keys.some(k => /Other/.test(k)) && c.keys.some(k => /Wrong Category/.test(k))),
        'each one now names both category queues', JSON.stringify(cards[0]?.keys));
    ok(cards.every(c => c.vals.length === 5), 'five rows on every card', String(cards[0]?.vals.length));
    // Text, not controls: the pills invited a click they did not need to own.
    // Asserted, because "make it text" is easy to undo by accident the next time
    // somebody copies the To Fix row above it.
    const catCells = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('.ec-hcard').forEach(c => {
            [...c.querySelectorAll('.ec-hrow')].forEach(r => {
                const k = r.querySelector('.ec-hk')?.textContent?.trim() || '';
                if (!/Other|Wrong Category/.test(k)) return;
                const v = r.querySelector('.ec-hv');
                out.push({ k, text: v?.textContent?.trim(), btn: !!r.querySelector('button'),
                           colour: v ? getComputedStyle(v).color : null });
            });
        });
        return out;
    });
    ok(catCells.length === 10, 'both numbers on all five cards', String(catCells.length));
    ok(catCells.every(c => !c.btn), 'they are text, not buttons');
    ok(catCells.filter(c => Number(c.text) > 0).every(c => c.colour === 'rgb(183, 121, 31)'),
        'and amber when there is something to do', catCells[0]?.colour);


    // ── The manager route, and the nag ────────────────────────────────────────
    // Two new things at once, and they have to agree: a manager is now offered the
    // Categories tab (Feature Access owns that button, not the eBay corp scope),
    // and a manager — never corp — gets the feed card telling them there is
    // something to sort. If the card lit for the DM it would say 289 across five
    // stores every morning, which is how a reminder stops being read.
    if (MGR_PIN) {
        console.log('');
        console.log('== As an OVL manager ==');
        const mp = await browser.newPage();
        const mErrs = [];
        mp.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) mErrs.push(m); });
        await mp.setViewport({ width: 1500, height: 1000 });
        await mp.evaluateOnNewDocument(pin => {
            sessionStorage.setItem('speeksUnlocked', 'true');
            sessionStorage.setItem('speeksUserPin', pin);
            sessionStorage.setItem('speeksUserName', 'Nick Hettinger');
            sessionStorage.setItem('speeksUserRole', 'manager');
            sessionStorage.setItem('speeksUserStore', 'OVL');
        }, MGR_PIN);
        await mp.goto('file:///' + REPO + '/operations.html', { waitUntil: 'networkidle2' }).catch(() => {});
        await new Promise(r => setTimeout(r, 2500));
        const mgrTab = await mp.waitForFunction(
            () => { const b = document.getElementById('ecViewCatsBtn'); return b && b.style.display !== 'none'; },
            { timeout: 15000 }).then(() => true).catch(() => false);
        ok(mgrTab, 'a manager is offered the Categories tab');
        // A single tab is a button that does nothing; two is a real choice.
        const toggleShown = await mp.$eval('#ecViewToggle', e => e.style.display !== 'none').catch(() => false);
        ok(toggleShown, 'and the view toggle appears to carry it');
        if (mgrTab) {
            await mp.click('#ecViewCatsBtn');
            await mp.waitForFunction(
                () => window._dbgRecat && window._dbgRecat().view === 'cats' && window._dbgRecat().loaded,
                { timeout: 25000 }).catch(() => {});
            const mState = await mp.evaluate(() => window._dbgRecat());
            ok(mState.store === 'OVL', 'and the queue is their own store', mState.store);
            ok(mState.queue > 0, 'with rows in it', String(mState.queue));
            ok(mState.counts && mState.counts.other === mState.queue,
                'and the tab count matches the list under it', JSON.stringify(mState.counts));
        }

        // The card's destination, which is a VIEW of a tab rather than a tab —
        // so it opens through initOperations rather than ecSetView, and the lit
        // pill has to be set separately or the panel shows Categories under a
        // highlighted Upload.
        const dp = await browser.newPage();
        await dp.setViewport({ width: 1500, height: 1000 });
        await dp.evaluateOnNewDocument(pin => {
            sessionStorage.setItem('speeksUnlocked', 'true');
            sessionStorage.setItem('speeksUserPin', pin);
            sessionStorage.setItem('speeksUserName', 'Nick Hettinger');
            sessionStorage.setItem('speeksUserRole', 'manager');
            sessionStorage.setItem('speeksUserStore', 'OVL');
        }, MGR_PIN);
        await dp.goto('file:///' + REPO + '/operations.html#categories', { waitUntil: 'networkidle2' }).catch(() => {});
        const landed = await dp.waitForFunction(
            () => window._dbgRecat && window._dbgRecat().view === 'cats' && window._dbgRecat().loaded,
            { timeout: 25000 }).then(() => true).catch(() => false);
        ok(landed, '#categories lands on the Categories queue');
        ok(await dp.$eval('#ecViewCatsBtn', b => b.classList.contains('active')).catch(() => false),
            'and lights its own pill, not Upload');
        await dp.close();
        ok(mErrs.length === 0, 'no console errors', mErrs.slice(0, 2).join(' / ') || 'clean');
        await mp.close();

        console.log('');
        console.log('== The feed card ==');
        for (const who of [{ name: 'Nick Hettinger', role: 'manager', store: 'OVL', pin: MGR_PIN, want: true },
                           { name: 'Ethan Kushnir', role: 'district manager', store: 'CORP', pin: PIN, want: false }]) {
            const page2 = await browser.newPage();
            const e2 = [];
            page2.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) e2.push(m); });
            await page2.setViewport({ width: 1500, height: 1000 });
            await page2.evaluateOnNewDocument(w => {
                sessionStorage.setItem('speeksUnlocked', 'true');
                sessionStorage.setItem('speeksUserName', w.name);
                sessionStorage.setItem('speeksUserRole', w.role);
                sessionStorage.setItem('speeksUserStore', w.store);
                sessionStorage.setItem('speeksUserPin', w.pin);
            }, who);
            await page2.goto('file:///' + REPO + '/index.html', { waitUntil: 'networkidle2' }).catch(() => {});
            await page2.evaluate(() => {
                const o = document.getElementById('authOverlay'); if (o) o.style.display = 'none';
                document.body.classList.add('is-authenticated');
                document.body.classList.remove('preload', 'no-scroll');
                if (typeof applyRoleBasedUI === 'function') { try { applyRoleBasedUI(); } catch (e) {} }
            });
            const res = await page2.evaluate(async () => {
                await checkCategoryQueueReminders();
                const b = document.getElementById('recatAlertBubble');
                const t = document.getElementById('recatAlertBubbleText');
                const vis = b ? getComputedStyle(b).visibility : null;
                const card = (typeof _samGatherReminders === 'function'
                    ? _samGatherReminders() : []).find(r => r.key === 'recatQueue');
                return {
                    shown: !!b && getComputedStyle(b).display !== 'none',
                    vis,
                    summary: t && t.dataset ? t.dataset.summary : null,
                    sig: t && t.dataset ? t.dataset.sig : null,
                    card: card ? { title: card.title, due: card.due, snippet: card.snippet, action: card.action } : null,
                };
            });
            const tag = who.role === 'manager' ? 'MGR' : 'DM';
            ok(res.shown === who.want, `[${tag}] the bubble ${who.want ? 'lights' : 'stays dark'}`, 'shown=' + res.shown);
            if (who.want) {
                ok(!!res.card, `[${tag}] the feed picks the card up`, res.card ? res.card.title + ' / ' + res.card.due : 'missing');
                ok(res.card?.due === 'Action', `[${tag}] the badge says what it is — something to do`, res.card && res.card.due);
                // The bubble is a STATE CARRIER, never a toast: a new id is not
                // covered by the retired-toast CSS until it is listed there, and
                // mine shipped visible. The feed is the surface.
                ok(res.vis === 'hidden', `[${tag}] and no floating toast`, res.vis);
                ok(!!res.card && /categor/i.test(res.card.snippet || ''),
                    `[${tag}] with a readable line`, res.card && res.card.snippet);
                ok(/operations\.html#categories/.test(res.card?.action || ''),
                    `[${tag}] and it opens the panel it is about`, res.card && res.card.action);
                // The counts are the identity, so a snooze lifts when they move.
                ok(/^recat:\d+:\d+$/.test(res.sig || ''), `[${tag}] the snooze is keyed to the counts`, res.sig);
            }
            ok(e2.length === 0, `[${tag}] no console errors`, e2.slice(0, 2).join(' / ') || 'clean');
            await page2.close();
        }
    } else {
        console.log('');
        console.log('== As an OVL manager ==');
        console.log('  SKIPPED (set SPEEKS_TEST_PIN_MGR to a store manager PIN)');
    }

    await browser.close();
    console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
    process.exit(fails ? 1 : 0);
})();
