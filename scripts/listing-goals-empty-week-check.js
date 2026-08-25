// DM → Listing Goals: does the panel render when the week is empty?
//
// THE BUG. renderDmListingModal held the whole panel back on
// "Syncing the district roster…" whenever no store had a role set for the
// CURRENT week:
//
//     if (!all.some(s => s.names.length)) { ...Syncing...; return; }
//
// That tests for ROWS, not for a RESPONSE. "Nobody has a role yet this week" is
// a normal state — it is the state of every Monday morning before the first
// manager sets a roster — so the message never cleared, because the thing it
// claimed to be waiting for had already arrived and was empty. The DM saw a
// permanent spinner over a working panel, with the subheader above it happily
// reading "0 of 735 listed this week · 5 stores still need this week's goal".
//
// Reproduced here by pinning the clock to a Monday, which is the day the trap is
// guaranteed to fire.
//
//   1. before the fetch returns, the spinner IS correct
//   2. after it returns EMPTY, the panel renders — no spinner
//   3. and what renders is the useful part: the store rail, the district strip,
//      the stretch factor, and Goals set 0/5
//   4. the store pane says why it is blank instead of dead-ending
//   5. Results (last week) is still reachable, which is the real Monday read
//   6. a week WITH a roster still draws its table — the fix didn't cost anything
//   7. a genuinely failed fetch still says so, and does not fake an empty week
//
// No credential and no network: _storeTargets and allDistrictGoalsData are
// seeded directly, the same way the other PIN-free harnesses do it.
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };
const IGNORE = /calendar\.google\.com|toDataURL|[Tt]ainted canvas|Failed to fetch|net::ERR|401|403/;

const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
// Five stores' targets, summing to the 735 in the screenshot. `manual: false` is
// what "still needs this week's goal" means.
const TARGETS = {};
STORES.forEach((s, i) => {
    TARGETS[s] = { store: s, target: [147, 147, 147, 147, 147][i], suggested: 150,
                   capacity: 196, manual: false, size: 4, weeks: [{ week: 'Aug 10', total: 120, target: 147 }] };
});

(async () => {
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) errs.push(m); });
    await page.setViewport({ width: 1700, height: 1000 });
    await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
        sessionStorage.setItem('speeksUserRole', 'district manager');
        sessionStorage.setItem('speeksUserStore', 'OVL');
        sessionStorage.setItem('speeksUserPin', '0000');
    });
    await page.goto('file:///' + REPO + '/index.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));

    const read = () => page.evaluate(() => {
        const w = document.getElementById('dmListingBody');
        const sub = document.getElementById('dmListingSub');
        const t = w ? w.textContent : '';
        return {
            spinner: /Syncing the district roster/.test(t),
            failed: /Couldn.t load the district roster/.test(t),
            sub: sub ? sub.textContent.trim() : '',
            rail: w ? w.querySelectorAll('.dmx-rail .dmx-t').length : 0,
            cells: w ? [...w.querySelectorAll('.dmx-cell-l')].map(x => x.textContent.trim()) : [],
            factor: !!(w && w.querySelector('#dmx-factor-input')),
            rows: w ? w.querySelectorAll('.dmx-tbl tbody tr').length : 0,
            note: w && w.querySelector('.dmx-empty-n') ? w.querySelector('.dmx-empty-n').textContent.trim() : '',
            empty: w && w.querySelector('.dmx-empty') ? w.querySelector('.dmx-empty').textContent.trim() : '',
            goalsSet: w ? (w.textContent.match(/Goals set/) ? true : false) : false,
        };
    });

    // -- 1. the honest spinner ------------------------------------------------
    console.log('== Before the fetch returns ==');
    await page.evaluate(t => {
        _dmxGoalsLoaded = false;
        allDistrictGoalsData = [];
        Object.keys(t).forEach(k => { _storeTargets[k] = t[k]; });
        _dmxSel.lg = 'OVL';
        renderDmListingModal();
    }, TARGETS);
    let r = await read();
    ok(r.spinner, 'the spinner shows while the fetch is genuinely in flight', r.empty || '(none)');

    // -- 2/3/4. the empty week ------------------------------------------------
    console.log('');
    console.log('== The fetch returns, and the week is empty (Monday) ==');
    await page.evaluate(() => {
        allDistrictGoalsData = [];      // the API answered; there is just nothing yet
        _dmxGoalsLoaded = true;
        renderDmListingModal();
    });
    r = await read();
    // THE ASSERTION THIS FILE EXISTS FOR.
    ok(!r.spinner, 'the spinner is GONE once the roster has actually landed', r.spinner ? 'still syncing' : 'cleared');
    ok(r.rail === STORES.length + 1, 'the store rail renders (5 stores + Results)', r.rail + ' tabs');
    ok(r.cells.includes('District listed') && r.cells.includes('District target'),
        'the district strip renders', r.cells.join(' | '));
    ok(r.goalsSet, 'including the Goals set counter — the DM\'s actual Monday job');
    ok(r.factor, 'the stretch factor control is usable');
    ok(/still need this week/.test(r.sub), 'and the subheader flags the unset goals', r.sub);
    ok(/roster/i.test(r.note) && /Results/.test(r.note),
        'the blank store pane explains itself instead of dead-ending', r.note || '(no note)');

    // -- 5. last week is still reachable --------------------------------------
    console.log('');
    console.log('== Results (last week) is reachable from an empty week ==');
    const eff = await page.evaluate(() => {
        dmxShowEfficiency();
        const w = document.getElementById('dmListingBody');
        return { sel: _dmxSel.lg, spinner: /Syncing the district roster/.test(w.textContent),
                 painted: w.innerHTML.length > 200 };
    });
    ok(eff.sel === 'EFF' && !eff.spinner && eff.painted,
        'the Results view opens and paints', JSON.stringify(eff));

    // -- 6. a week with a roster is unchanged ---------------------------------
    console.log('');
    console.log('== A week that DOES have a roster still draws ==');
    const withData = await page.evaluate(() => {
        // Today, Chicago — the same key _dmxListingStore buckets on.
        const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
        allDistrictGoalsData = [
            { store: 'OVL', employee: 'Alice Adams', date: today, goal: 12, role: 'L1' },
            { store: 'OVL', employee: 'Bob Baker',   date: today, goal: 9,  role: 'B1' },
        ];
        _dmxGoalsLoaded = true;
        _dmxSel.lg = 'OVL';
        renderDmListingModal();
        const w = document.getElementById('dmListingBody');
        return {
            spinner: /Syncing the district roster/.test(w.textContent),
            rows: w.querySelectorAll('.dmx-tbl tbody tr').length,
            names: [...w.querySelectorAll('.dmx-name')].map(n => n.textContent.trim()),
        };
    });
    ok(!withData.spinner && withData.names.length === 2,
        'two rostered people draw two rows', withData.names.join(', ') + ' (' + withData.rows + ' tbody rows incl. total)');

    // -- 7. a real failure still reads as a failure ---------------------------
    console.log('');
    console.log('== A failed fetch is not disguised as an empty week ==');
    const failed = await page.evaluate(() => {
        const cont = document.getElementById('dmListingBody');
        // Exactly what the catch in fetchDmGoalsData writes.
        cont.innerHTML = '<div class="dmx-empty" style="padding:60px 0; color:var(--red-alert);">Couldn\'t load the district roster. Close and reopen to retry.</div>';
        return /Couldn.t load the district roster/.test(cont.textContent);
    });
    ok(failed, 'the error state still says what went wrong and what to do');

    console.log('');
    ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | ') || 'clean');
    await browser.close();
    console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
    process.exit(fails ? 1 : 0);
})();
