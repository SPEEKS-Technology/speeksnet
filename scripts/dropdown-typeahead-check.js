// Type-to-jump on the styled dropdowns.
//
// A native select already jumps when you type — but PREFIX-ONLY. On the 63-shelf
// Shopify category list, typing "video" matched on "V", stopped, and went
// nowhere useful, because what somebody knows about an item is rarely the first
// word of the shelf it lives on. This makes the jump a substring match and
// leaves everything else about the gesture alone: no box, nothing to aim at,
// open the list and type.
//
// What this asserts, on the real page, with no credential:
//
//   1. "video" lands on a Video Game shelf. That is the whole feature.
//   2. PREFIX STILL WINS where both exist, so short queries land where a native
//      select would have
//   3. the letters keep narrowing, and Backspace walks them back
//   4. a miss leaves the cursor where it was — it does not jump somewhere wrong
//   5. THE OPTION THE LETTERS FOUND IS PAINTED THE SAME BLACK AS THE CHOSEN one.
//      There is no badge showing the letters any more (asked for, 24 Aug), so the
//      black IS the feedback: a hit is obvious, and a miss is the cursor not
//      moving. Asserted against the chosen row's own computed colour rather than
//      a hard-coded hex, so a theme change cannot make this pass wrongly.
//   6. Enter takes the focused option, through the native select, firing exactly
//      one change — every inline onchange= on the site depends on that
//   7. short lists are left entirely alone: the browser's own prefix jump is
//      right for five stores and a second one fighting it is worse than neither
//   8. arrowing away drops the letters, so the next keystroke does not jump back
//   9. no console errors
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };
const IGNORE = /calendar\.google\.com|toDataURL|[Tt]ainted canvas|Failed to fetch|net::ERR|401/;

(async () => {
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) errs.push(m); });
    await page.setViewport({ width: 1500, height: 1000 });
    await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
        sessionStorage.setItem('speeksUserRole', 'district manager');
        sessionStorage.setItem('speeksUserStore', 'CORP');
    });
    await page.goto('file:///' + REPO + '/operations.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));

    // Two selects built for this check, with the real Shopify shelf names on the
    // long one, so the assertions do not depend on which panel happened to load.
    // The module enhances them exactly as it enhances the page's own selects —
    // that is what the MutationObserver at the end of speeks.js is for.
    await page.evaluate(() => {
        const CATS = ['Apple Genuine Accessories', 'Cameras & Photo', 'Car Electronics & Audio',
            'Charging & Power', 'Computer Accessories', 'Computer Parts', 'Desktops',
            'DJ & Recording Equipment', 'Drones', 'Handheld Game Consoles', 'Laptops',
            'Monitors & Displays', 'Networking', 'Optics', 'Other', 'Smart Home',
            'Speakers & Audio', 'Tablets', 'Televisions', 'Video Game Accessories',
            'Video Game Consoles', 'Video Games', 'Wearables'];
        const wrap = document.createElement('div');
        wrap.id = 'ddTestWrap';
        wrap.style.cssText = 'position:fixed;top:180px;left:80px;width:260px;z-index:5;';
        const sel = document.createElement('select');
        sel.id = 'ddTestLong'; sel.className = 'form-input';
        CATS.forEach(c => { const o = document.createElement('option');
            o.value = c.toLowerCase().replace(/\W+/g, '-'); o.textContent = c; sel.appendChild(o); });
        const sel2 = document.createElement('select');
        sel2.id = 'ddTestShort'; sel2.className = 'form-input';
        ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'].forEach(c => { const o = document.createElement('option');
            o.value = c; o.textContent = c; sel2.appendChild(o); });
        wrap.appendChild(sel); wrap.appendChild(sel2);
        document.body.appendChild(wrap);
        window.__ddFired = [];
        sel.addEventListener('change', () => window.__ddFired.push(sel.value));
    });
    await new Promise(r => setTimeout(r, 700));   // the observer is debounced

    const nFaces = await page.$$eval('#ddTestWrap .dd-btn', b => b.length);
    ok(nFaces === 2, 'both selects were given a face', String(nFaces));

    // Real key events through the browser, not synthesised ones: the whole
    // feature is a keydown handler, and dispatching our own would test the
    // handler against itself.
    const openLong = async () => {
        await page.evaluate(() => document.querySelectorAll('#ddTestWrap .dd-btn')[0].click());
        await new Promise(r => setTimeout(r, 200));
    };
    const focused = () => page.evaluate(() =>
        (document.activeElement && document.activeElement.classList.contains('dd-opt'))
            ? document.activeElement.textContent : '(not an option)');
    // The letters are no longer on screen, so the buffer itself is the observable.
    const buf = () => page.evaluate(() => {
        const h = document.querySelector('#ddTestWrap .dd-host.open');
        return h ? (h._ddType || '') : null;
    });
    // What the option you are ON looks like, against what the CHOSEN one looks
    // like. Equality is the requirement; a hex would only prove today's theme.
    const bgs = () => page.evaluate(() => {
        const list = document.querySelector('body > .dd-list.dd-open');
        if (!list) return null;
        const a = document.activeElement;
        const on = list.querySelector('.dd-opt.on');
        const plain = Array.from(list.querySelectorAll('.dd-opt'))
            .find(o => o !== a && !o.classList.contains('on'));
        const bg = el => el ? getComputedStyle(el).backgroundColor : null;
        return {
            focused: (a && a.classList.contains('dd-opt')) ? bg(a) : null,
            chosen: bg(on), plain: bg(plain),
            badge: !!document.querySelector('.dd-typed'),
        };
    });
    const close = () => page.evaluate(() => document.body.click());

    console.log('');
    console.log('== "video" lands on a Video Game shelf ==');
    await openLong();
    ok((await focused()) === 'Apple Genuine Accessories', 'the list opens on the current choice', await focused());
    for (const ch of 'video') await page.keyboard.press(ch.toUpperCase() === ch ? ch : ch);
    // THE ASSERTION THIS FILE EXISTS FOR. A native select gets to "Video Game
    // Accessories" only because V happens to be unique here; on the real list it
    // stops on the first V-word and stays there.
    ok(/^Video Game/.test(await focused()), 'five letters and it is there', await focused());
    ok((await buf()) === 'video', 'the buffer holds what was typed', await buf());
    const c1 = await bgs();
    ok(!!c1 && c1.focused === c1.chosen,
        'and it is painted the same black as the chosen row', c1 ? c1.focused + ' vs ' + c1.chosen : '(none)');
    ok(!!c1 && c1.focused !== c1.plain,
        'which a plain row is not', c1 ? c1.plain : '(none)');
    ok(!!c1 && !c1.badge, 'and no letters badge is drawn');

    console.log('');
    console.log('== Backspace walks it back ==');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    ok((await buf()) === 'vid', 'two off the end', await buf());
    ok(/^Video Game/.test(await focused()), 'and it is still on a video shelf', await focused());
    await close();

    console.log('');
    console.log('== Prefix beats substring ==');
    await openLong();
    // "Computer Accessories" and "Computer Parts" start with it; "Apple Genuine
    // Accessories" and "Video Game Accessories" merely contain "c". A native
    // select would land on Cameras & Photo for "c", and so should this.
    await page.keyboard.press('c');
    ok((await focused()) === 'Cameras & Photo', 'a single letter goes where native would', await focused());
    for (const ch of 'onso') await page.keyboard.press(ch);
    // Nothing STARTS with "conso", so this is the substring half doing the work.
    ok(/Consoles$/.test(await focused()), 'and then substring takes over', await focused());
    await close();

    console.log('');
    console.log('== A miss stays put and says so ==');
    await openLong();
    for (const ch of 'lap') await page.keyboard.press(ch);
    const before = await focused();
    ok(before === 'Laptops', 'on Laptops', before);
    await page.keyboard.press('z');
    ok((await focused()) === before, 'a letter nothing matches does not move the cursor', await focused());
    // The badge used to go red here. With it gone, what has to stay true is that
    // the letter was RECORDED (so Backspace walks it off) while the cursor did
    // not move -- otherwise a typo would silently strand you.
    ok((await buf()) === 'lapz', 'the stray letter is still recorded', await buf());
    await page.keyboard.press('Backspace');
    ok((await focused()) === 'Laptops', 'and Backspace recovers', await focused());
    await close();

    console.log('');
    console.log('== Enter commits, through the native select ==');
    await openLong();
    for (const ch of 'network') await page.keyboard.press(ch);
    await page.keyboard.press('Enter');
    const committed = await page.evaluate(() => ({
        value: document.getElementById('ddTestLong').value,
        label: document.querySelectorAll('#ddTestWrap .dd-cur')[0].textContent,
        fired: window.__ddFired.slice(),
        open: !!document.querySelector('body > .dd-list.dd-open'),
    }));
    ok(committed.value === 'networking', 'the native select moved', committed.value);
    ok(committed.fired.length === 1, 'and fired exactly one change', JSON.stringify(committed.fired));
    ok(committed.label === 'Networking', 'the face shows the new choice', committed.label);
    ok(!committed.open, 'and the list closed');

    console.log('');
    console.log('== Arrowing away drops the letters ==');
    await openLong();
    for (const ch of 'tab') await page.keyboard.press(ch);
    ok((await focused()) === 'Tablets', 'typed to Tablets', await focused());
    await page.keyboard.press('ArrowDown');
    ok((await buf()) === '', 'arrowing clears them', 'cleared');
    // Without the clear, this "l" would append to "tab" and jump back.
    await page.keyboard.press('l');
    ok((await focused()) === 'Laptops', 'so the next letter starts fresh', await focused());
    await close();

    console.log('');
    console.log('== A five-option list is left alone ==');
    await page.evaluate(() => document.querySelectorAll('#ddTestWrap .dd-btn')[1].click());
    await new Promise(r => setTimeout(r, 200));
    await page.keyboard.press('w');
    const shortState = await page.evaluate(() => ({
        buf: (document.querySelector('#ddTestWrap .dd-host.open') || {})._ddType || '',
        opts: document.querySelectorAll('body > .dd-list.dd-open .dd-opt').length,
    }));
    ok(shortState.buf === '', 'nothing is captured on five stores', JSON.stringify(shortState.buf));
    ok(shortState.opts === 5, 'and all five options', String(shortState.opts));
    await close();

    console.log('');
    ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | ') || 'clean');
    await browser.close();
    console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
    process.exit(fails ? 1 : 0);
})();
