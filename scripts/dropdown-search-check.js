// Searchable dropdowns — the DROPDOWNS module's new filter row.
//
// Native type-ahead is prefix-only, so on the 63-shelf Shopify category list
// typing "video" reached nothing: what somebody knows about an item is rarely
// the first word of the shelf it lives on. The filter is substring, every word
// has to hit somewhere, and word order does not matter.
//
// What this asserts, on the real pages, with no credential:
//
//   1. long lists get a filter row, SHORT ONES DO NOT — a search box over five
//      stores is a control asking to be used where scanning is faster
//   2. "video" reaches Video Games. That is the whole feature.
//   3. word order does not matter, and neither does case
//   4. Enter on the box commits the first match
//   5. THE NATIVE SELECT IS STILL AUTHORITATIVE — .value moves and a real
//      `change` fires, which is what every inline onchange= on the site needs
//   6. a word that matches nothing SAYS so rather than showing an empty box
//   7. the box is wide enough to type in
//   8. no console errors
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

    // A select built for this check, with the real Shopify shelf names on it, so
    // the assertions do not depend on which panel happens to have loaded. The
    // module enhances it exactly as it enhances the page's own selects — that is
    // what the MutationObserver at the end of speeks.js is for.
    console.log('== A long list gets a filter row ==');
    const built = await page.evaluate(() => {
        const CATS = ['Apple Genuine Accessories', 'Cameras & Photo', 'Car Electronics & Audio',
            'Charging & Power', 'Computer Accessories', 'Computer Parts', 'Desktops',
            'DJ & Recording Equipment', 'Drones', 'Handheld Game Consoles', 'Laptops',
            'Monitors & Displays', 'Networking', 'Optics', 'Other', 'Smart Home',
            'Speakers & Audio', 'Tablets', 'Televisions', 'Video Game Accessories',
            'Video Game Consoles', 'Video Games', 'Wearables'];
        const host = document.createElement('div');
        host.id = 'ddTestWrap';
        host.style.cssText = 'position:fixed;top:200px;left:80px;width:260px;z-index:5;';
        const sel = document.createElement('select');
        sel.id = 'ddTestLong';
        sel.className = 'form-input';
        CATS.forEach(c => { const o = document.createElement('option'); o.value = c.toLowerCase().replace(/\W+/g, '-'); o.textContent = c; sel.appendChild(o); });
        // A short one beside it: the threshold is the point.
        const sel2 = document.createElement('select');
        sel2.id = 'ddTestShort';
        sel2.className = 'form-input';
        ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'].forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel2.appendChild(o); });
        host.appendChild(sel); host.appendChild(sel2);
        document.body.appendChild(host);
        window.__ddFired = [];
        sel.addEventListener('change', () => window.__ddFired.push(sel.value));
        return { long: CATS.length, short: 5 };
    });
    // The observer is debounced, so the faces are not there the same tick.
    await new Promise(r => setTimeout(r, 700));
    ok(built.long === 23, 'the test list has 23 shelves on it', String(built.long));

    const faces = await page.evaluate(() => ({
        long: !!document.querySelector('#ddTestWrap .dd-host [aria-labelledby="ddTestLong-ddlab"]')
              || !!document.querySelectorAll('#ddTestWrap .dd-btn').length,
        count: document.querySelectorAll('#ddTestWrap .dd-btn').length,
    }));
    ok(faces.count === 2, 'both selects were given a face', String(faces.count));

    const openLong = async () => page.evaluate(() => {
        document.querySelectorAll('#ddTestWrap .dd-btn')[0].click();
    });
    await openLong();
    await new Promise(r => setTimeout(r, 250));

    const opened = await page.evaluate(() => {
        const list = document.querySelector('body > .dd-list.dd-open');
        const box = list && list.querySelector('.dd-search-in');
        return {
            hasBox: !!box,
            focused: !!box && document.activeElement === box,
            placeholder: box ? box.placeholder : '',
            opts: list ? list.querySelectorAll('.dd-opt').length : 0,
            boxW: box ? Math.round(box.getBoundingClientRect().width) : 0,
        };
    });
    ok(opened.hasBox, 'a 23-option list opens with a filter row');
    ok(opened.focused, 'and the caret is already in it — typing works immediately');
    ok(opened.opts === 23, 'with every option still listed', String(opened.opts));
    // 105px was the narrowest control on the site before this; a box that size is
    // not a box you can read what you typed in.
    ok(opened.boxW >= 150, 'the box is wide enough to type in', opened.boxW + 'px');

    console.log('');
    console.log('== "video" reaches Video Games ==');
    const typed = await page.evaluate(() => {
        const box = document.querySelector('body > .dd-list.dd-open .dd-search-in');
        box.value = 'video';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        const list = document.querySelector('body > .dd-list.dd-open');
        return [...list.querySelectorAll('.dd-opt')].map(o => o.textContent);
    });
    // THE ASSERTION THIS FILE EXISTS FOR. Native prefix matching finds none of
    // these from "video" unless the option starts with it.
    ok(typed.length === 3, 'three shelves match', typed.join(' | '));
    ok(typed.includes('Video Games') && typed.includes('Video Game Accessories')
        && typed.includes('Video Game Consoles'), 'and they are the video game ones');

    const loose = await page.evaluate(() => {
        const box = document.querySelector('body > .dd-list.dd-open .dd-search-in');
        const run = v => { box.value = v; box.dispatchEvent(new Event('input', { bubbles: true }));
            return [...document.querySelectorAll('body > .dd-list.dd-open .dd-opt')].map(o => o.textContent); };
        return { reversed: run('game video'), shouty: run('AUDIO'), mid: run('phot') };
    });
    ok(loose.reversed.includes('Video Games'), 'word order does not matter', loose.reversed.join(' | '));
    ok(loose.shouty.length === 2, 'case does not matter', loose.shouty.join(' | '));
    // Mid-word, which is the other half of what prefix matching cannot do.
    ok(loose.mid.join('') === 'Cameras & Photo', 'and it matches inside a word', loose.mid.join(' | '));

    console.log('');
    console.log('== A word that matches nothing says so ==');
    const none = await page.evaluate(() => {
        const box = document.querySelector('body > .dd-list.dd-open .dd-search-in');
        box.value = 'zzzz'; box.dispatchEvent(new Event('input', { bubbles: true }));
        const list = document.querySelector('body > .dd-list.dd-open');
        return { opts: list.querySelectorAll('.dd-opt').length,
                 msg: (list.querySelector('.dd-none') || {}).textContent || '',
                 boxStill: !!list.querySelector('.dd-search-in') };
    });
    ok(none.opts === 0 && /Nothing matches/.test(none.msg), 'it says so', none.msg);
    ok(none.boxStill, 'and the box stays, so the word can be corrected');

    console.log('');
    console.log('== Enter commits, through the native select ==');
    const committed = await page.evaluate(() => {
        const box = document.querySelector('body > .dd-list.dd-open .dd-search-in');
        box.value = 'consoles'; box.dispatchEvent(new Event('input', { bubbles: true }));
        const b2 = document.querySelector('body > .dd-list.dd-open .dd-search-in');
        b2.focus();
        b2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const sel = document.getElementById('ddTestLong');
        return { value: sel.value, label: document.querySelectorAll('#ddTestWrap .dd-cur')[0].textContent,
                 fired: window.__ddFired.slice(), open: !!document.querySelector('body > .dd-list.dd-open') };
    });
    // The module's whole safety property: the face is a face, the select is the
    // control. Every inline onchange= on the site depends on this.
    ok(committed.value === 'handheld-game-consoles' || /consoles/.test(committed.value),
        'the native select moved', committed.value);
    ok(committed.fired.length === 1, 'and fired exactly one change', JSON.stringify(committed.fired));
    ok(/Consoles/.test(committed.label), 'the face shows the new choice', committed.label);
    ok(!committed.open, 'and the list closed');

    console.log('');
    console.log('== A narrow control still gets a usable box ==');
    // The site's narrowest control was 105px. "As wide as the button" is right
    // for five stores and wrong for a search box, so the floor applies to
    // searchable lists ONLY — a short list still matches its button exactly.
    const narrow = await page.evaluate(() => {
        const wrap = document.getElementById('ddTestWrap');
        wrap.style.width = '105px';
        const btns = document.querySelectorAll('#ddTestWrap .dd-btn');
        btns[0].click();
        const longList = document.querySelector('body > .dd-list.dd-open');
        const longW = Math.round(longList.getBoundingClientRect().width);
        const boxW = Math.round(longList.querySelector('.dd-search-in').getBoundingClientRect().width);
        document.body.click();
        btns[1].click();
        const shortList = document.querySelector('body > .dd-list.dd-open');
        const shortW = Math.round(shortList.getBoundingClientRect().width);
        const btnW = Math.round(btns[1].getBoundingClientRect().width);
        document.body.click();
        return { longW, boxW, shortW, btnW };
    });
    ok(narrow.longW >= 240, 'the searchable list widens to fit its box', narrow.longW + 'px');
    ok(narrow.boxW >= 150, 'so the box is still readable', narrow.boxW + 'px');
    ok(Math.abs(narrow.shortW - narrow.btnW) <= 1,
        'and a short list still matches its button exactly',
        narrow.shortW + 'px vs ' + narrow.btnW + 'px');

    console.log('');
    console.log('== A short list is left alone ==');
    const short = await page.evaluate(() => {
        document.querySelectorAll('#ddTestWrap .dd-btn')[1].click();
        const list = document.querySelector('body > .dd-list.dd-open');
        return { box: !!list.querySelector('.dd-search-in'), opts: list.querySelectorAll('.dd-opt').length };
    });
    ok(!short.box, 'five stores get no filter row');
    ok(short.opts === 5, 'and all five options', String(short.opts));

    ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | ') || 'clean');
    await browser.close();
    console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
    process.exit(fails ? 1 : 0);
})();
