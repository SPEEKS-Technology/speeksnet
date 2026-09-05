// The Recycle search bar: does it LOOK like every other search bar on the site,
// and does it behave like one? The look half matters as much as the behaviour
// half — the ask was explicitly "act and look like every other search bar we
// have" — so it is measured against the Box Order search box rendered on the
// same page rather than against numbers typed in here.
//
// It also covers the two traps this feature has:
//   1. the table is rebuilt by innerHTML on every keystroke, so an input living
//      inside it would lose focus and caret after a single character
//   2. the footer total must never read as the MONTH total while a search is
//      narrowing the rows above it
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

const now = new Date();
const thisMonth = d => new Date(now.getFullYear(), now.getMonth(), d).toISOString();
const lastMonth = d => new Date(now.getFullYear(), now.getMonth() - 1, d).toISOString();

const ROWS = [
    { id: '1', store: 'OVL', sku: 'KS01-7548N-E6', description: 'Canon EF-S 55-250mm lens, fungus',
      quantity: 1, cost: 40, created_by: 'Nick Hettinger', created_at: thisMonth(3) },
    { id: '2', store: 'OVL', sku: 'OVL-9001-C', description: 'Apple iPhone 11, cracked board',
      quantity: 1, cost: 60, created_by: 'Nick Hettinger', created_at: thisMonth(5) },
    { id: '3', store: 'LEE', sku: 'LEE-2211-B', description: 'Apple iPhone 12 64GB, swollen battery',
      quantity: 2, cost: 25, created_by: 'Sam Reed', created_at: thisMonth(9) },
    // The cross-month case: looking this up while the current month is selected
    // is the dead end the box was added to remove.
    { id: '4', store: 'LEE', sku: 'ZZTOP-0001', description: 'Nintendo Switch dock, no output',
      quantity: 1, cost: 15, created_by: 'Sam Reed', created_at: lastMonth(14) },
];

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
    await page.goto('file:///' + REPO + '/index.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2400));

    await page.evaluate(rows => {
        // .show is what actually reveals a .modal-menu — display:block alone
        // leaves visibility:hidden/opacity:0, and innerText of a hidden element
        // is the empty string, so every behaviour assertion below would read
        // blank and pass or fail for the wrong reason.
        const modal = document.getElementById('recycleInvModal');
        modal.style.display = 'block';
        modal.classList.add('show');
        document.getElementById('recycle-panel-new').style.display = 'none';
        document.getElementById('recycle-panel-view').style.display = 'block';
        _recycleMine = rows;
        _buildRecycleViewFilters(['OVL', 'LEE']);
        renderMyRecycleTable();
    }, ROWS);
    await new Promise(r => setTimeout(r, 300));

    console.log('== It looks like the other search bars ==');
    const look = await page.evaluate(() => {
        const r = document.getElementById('recycleSearch');
        const b = document.getElementById('boxOrderSearch');
        if (!r || !b) return null;
        const pick = el => {
            const c = getComputedStyle(el);
            return { cls: el.className, font: c.fontSize, pad: c.padding,
                     radius: c.borderRadius, border: c.border };
        };
        const wrapOf = el => el.closest('.kb-search-bar');
        return {
            recycle: pick(r), box: pick(b),
            rWrap: wrapOf(r) ? wrapOf(r).className : null,
            bWrap: wrapOf(b) ? wrapOf(b).className : null,
            rIcon: !!(wrapOf(r) && wrapOf(r).querySelector('.doc-search-icon svg')),
        };
    });
    ok(!!look, 'both search inputs exist on the page');
    if (look) {
        ok(look.recycle.cls === look.box.cls, 'same classes as Box Order', look.recycle.cls);
        ok(look.rWrap === look.bWrap, 'same wrapper classes', look.rWrap);
        ok(look.rIcon, 'has the magnifier icon');
        ok(look.recycle.font === look.box.font, 'same font size', look.recycle.font);
        ok(look.recycle.pad === look.box.pad, 'same padding', look.recycle.pad);
        ok(look.recycle.radius === look.box.radius, 'same corner radius', look.recycle.radius);
        ok(look.recycle.border === look.box.border, 'same border', look.recycle.border);
    }

    const rowsFor = async q => await page.evaluate(query => {
        const input = document.getElementById('recycleSearch');
        input.value = query;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const body = document.querySelector('#recycle-table-wrap tbody');
        const skus = body ? [...body.querySelectorAll('td[data-label="SKU"]')]
            .map(c => c.innerText.trim().split('\n')[0]).filter(Boolean) : [];
        const foot = document.querySelector('#recycle-table-wrap tfoot');
        const wrap = document.getElementById('recycle-table-wrap');
        return { skus,
                 foot: foot ? foot.innerText.replace(/\s+/g, ' ').trim() : '',
                 text: wrap.innerText.replace(/\s+/g, ' ').trim() };
    }, q);

    console.log('== It filters ==');
    let v = await rowsFor('');
    ok(v.skus.length === 3, 'no query shows the whole month', v.skus.join(', '));
    v = await rowsFor('iphone');
    ok(v.skus.length === 2, 'search by item', v.skus.join(', '));
    v = await rowsFor('7548');
    ok(v.skus.length === 1 && /7548/.test(v.skus[0]), 'search by partial SKU', v.skus.join(', '));
    v = await rowsFor('iphone lee');
    ok(v.skus.length === 1 && /LEE-2211-B/.test(v.skus[0]), 'two words, both must match', v.skus.join(', '));
    v = await rowsFor('nick');
    ok(v.skus.length === 2, 'search by who filed it', v.skus.join(', '));

    console.log('== The total never lies about what it is counting ==');
    v = await rowsFor('');
    ok(/Total recycled cost/i.test(v.foot), 'unfiltered footer says total recycled cost');
    v = await rowsFor('iphone');
    ok(!/Total recycled cost/i.test(v.foot), 'filtered footer drops the month-total wording', v.foot.slice(0, 70));
    // innerText comes back CSS-uppercased (text-transform on the footer label).
    ok(/2 of 3 lines/i.test(v.foot), 'filtered footer counts matches out of the month', v.foot.slice(0, 70));

    console.log('== A miss in this month is not a dead end ==');
    v = await rowsFor('nintendo');
    ok(!v.skus.length && /match/i.test(v.text), 'says nothing matched here', v.text.slice(0, 120));
    const jumped = await page.evaluate(() => {
        const b = document.querySelector('#recycle-table-wrap button[onclick^="_recycleJumpMonth"]');
        if (!b) return null;
        b.click();
        return [...document.querySelectorAll('#recycle-table-wrap td[data-label="SKU"]')]
            .map(c => c.innerText.trim().split('\n')[0]);
    });
    ok(jumped && jumped.length === 1 && /ZZTOP-0001/.test(jumped[0]),
       'the month name is a button that goes there', jumped ? jumped.join(', ') : 'no button rendered');

    console.log('== Typing does not steal focus ==');
    const focus = await page.evaluate(() => {
        const input = document.getElementById('recycleSearch');
        input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        input.value = 'iph'; input.dispatchEvent(new Event('input', { bubbles: true }));
        input.setSelectionRange(3, 3);
        input.value = 'ipho'; input.dispatchEvent(new Event('input', { bubbles: true }));
        input.setSelectionRange(4, 4);
        return { stillThere: !!document.getElementById('recycleSearch'),
                 active: document.activeElement === document.getElementById('recycleSearch'),
                 caret: document.getElementById('recycleSearch').selectionStart };
    });
    ok(focus.stillThere, 'the input survives the table rebuild');
    ok(focus.active, 'focus stays in the box after a keystroke');
    ok(focus.caret === 4, 'caret is not thrown to the start', 'caret=' + focus.caret);

    ok(errs.length === 0, 'no page errors', errs.slice(0, 2).join(' | '));
    await browser.close();
    console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
    process.exit(fails ? 1 : 0);
})();
