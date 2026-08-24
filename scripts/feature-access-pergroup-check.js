// Feature Access, Per-User tab: the group card you are working in stays open.
//
// Changing one setting re-renders the whole tab — it has to, because the "N set"
// badge on the card and the exception counts in the user picker both move with
// the change. Every card renders collapsed by default, so the card shut itself
// the moment you touched a toggle, and every further change meant re-opening it.
//
// What this asserts, on the real page, with no credential and no network:
//
//   1. a card opens when its header is clicked
//   2. IT IS STILL OPEN AFTER A SETTING IS CHANGED — the whole point
//   3. the setting that was clicked actually took (so this is not "nothing
//      happened", which would also leave the card open)
//   4. the card's "N set" badge moved, i.e. the re-render really did run
//   5. only that card is open — the fix is not "expand everything"
//   6. collapsing is still possible after a change, and survives the next one
//   7. a card left closed stays closed
//   8. no console errors
//
// The save is stubbed. This is a UI-state assertion; a real POST would need a
// credential and would make the check depend on the network being up.
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };
const IGNORE = /calendar\.google\.com|toDataURL|[Tt]ainted canvas|Failed to fetch|net::ERR|401|Load failed/;

(async () => {
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) errs.push(m); });
    // faSetUser alerts on a failed save. Nothing should reach it with fetch
    // stubbed, but an unhandled dialog hangs the run rather than failing it.
    page.on('dialog', async d => { errs.push('dialog: ' + d.message()); await d.dismiss(); });

    await page.setViewport({ width: 1500, height: 1100 });
    await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
        sessionStorage.setItem('speeksUserRole', 'ceo');
        sessionStorage.setItem('speeksUserStore', 'CORP');
    });
    await page.goto('file:///' + REPO + '/operations.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));

    // Seed the directory the tab reads, and stub the save. Top-level `let` in a
    // classic script lives in the global lexical environment, so an evaluate can
    // assign it by bare name — `window._faUsers` would NOT reach the same binding.
    const ready = await page.evaluate(() => {
        window.fetch = () => Promise.resolve({
            ok: true, json: () => Promise.resolve({ success: true }),
        });
        _faUsers = [{ name: 'Calvin Meadows', role: 'assistant manager', store: 'MPL' }];
        _faUser = 'calvin meadows';
        openFeatureAccess();
        switchFaTab('user');
        const cards = document.querySelectorAll('#fa-body .fa-ugroup');
        return {
            cards: cards.length,
            allCollapsed: Array.from(cards).every(c => c.classList.contains('collapsed')),
        };
    });
    ok(ready.cards > 3, 'the Per-User tab drew its group cards', String(ready.cards));
    ok(ready.allCollapsed, 'and they all start collapsed');

    // Work in the second card, not the first: a bug that keeps only the first
    // card open would pass against the first one.
    const state = () => page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('#fa-body .fa-ugroup'));
        const c = cards[1];
        const head = c && c.querySelector('.fa-ugroup-name');
        const badge = c && c.querySelector('.fa-ugroup-set');
        const active = c && c.querySelector('.fa-urow .fa-seg-active');
        return {
            name: head ? head.textContent : null,
            open: !!c && !c.classList.contains('collapsed'),
            badge: badge ? badge.textContent.trim() : null,
            firstRowActive: active ? active.textContent.trim() : null,
            openCount: cards.filter(x => !x.classList.contains('collapsed')).length,
            rowsVisible: !!c && c.querySelector('.fa-ugroup-body').offsetHeight > 0,
        };
    });

    console.log('');
    console.log('== The card opens ==');
    await page.evaluate(() => document.querySelectorAll('#fa-body .fa-ugroup .fa-ugroup-head')[1].click());
    let s = await state();
    ok(s.open, 'clicking the header opens it', s.name);
    ok(s.rowsVisible, 'and its rows are on screen');
    ok(s.openCount === 1, 'and it is the only one open', String(s.openCount));
    const badgeBefore = s.badge;
    const activeBefore = s.firstRowActive;

    console.log('');
    console.log('== Changing a setting leaves it open ==');
    // "Off" on the first row of that card — a value it cannot already be, since
    // the seeded user has no overrides at all, so the change is always real.
    await page.evaluate(() => {
        const card = document.querySelectorAll('#fa-body .fa-ugroup')[1];
        const segs = card.querySelectorAll('.fa-urow .fa-seg');
        Array.from(segs).find(b => b.textContent.trim() === 'Off').click();
    });
    await new Promise(r => setTimeout(r, 300));
    s = await state();
    ok(s.open, 'THE CARD IS STILL OPEN', s.name);
    ok(s.rowsVisible, 'and its rows are still on screen');
    ok(s.firstRowActive === 'Off' && activeBefore !== 'Off',
        'the setting took', activeBefore + ' -> ' + s.firstRowActive);
    ok(s.badge !== badgeBefore && /set$/.test(s.badge || ''),
        'and the badge moved, so the re-render really ran',
        (badgeBefore || '(none)') + ' -> ' + (s.badge || '(none)'));
    ok(s.openCount === 1, 'still the only one open — not "expand everything"', String(s.openCount));

    console.log('');
    console.log('== Collapsing still works, and sticks ==');
    await page.evaluate(() => document.querySelectorAll('#fa-body .fa-ugroup .fa-ugroup-head')[1].click());
    s = await state();
    ok(!s.open, 'it closes again');
    await page.evaluate(() => {
        // Re-render without touching the card: the closed state must survive it.
        renderFaBody();
    });
    s = await state();
    ok(!s.open, 'and a card left closed stays closed through a re-render');

    console.log('');
    ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | ') || 'clean');
    await browser.close();
    console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
    process.exit(fails ? 1 : 0);
})();
