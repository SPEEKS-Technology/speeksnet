// DM → Listing Goals → Results: column order, and every header over its own number.
//
// The Efficiency table was reordered (user, 2026-08-24):
//
//   was  Store · Hours · Ceiling · Goal · Listed · Staffed For · Efficiency · Result
//   now  Store · Hours · Staffed For · Ceiling · Goal · Listed · Efficiency · Result
//
// Hours and Staffed For now sit together because they are the same fact in two
// units — contracted hours, and the listings those hours earned once seats were
// assigned. Read apart, the pair invites exactly the confusion that prompted
// this ("is staffed for total listings?").
//
// The failure mode of a reorder like this is silent and ugly: a <td> moved
// without its <th>, so every figure is one column off and the table still looks
// perfectly plausible. So this does not check the header list — it checks each
// header AGAINST THE VALUE UNDER IT, using figures distinct enough that a
// one-column slip cannot coincide.
//
//   1. the headers are in the order asked for
//   2. every store figure sits under its own header
//   3. the district roll-up is aligned the same way, and totals its own column
//   4. the two group rules land in the new gaps, not the old ones — they are
//      nth-child POSITIONS and do not follow a column when it moves
//   5. Ceiling keeps its muted styling after the move (it is the one derived
//      figure in the row)
//   6. an in-progress week still suppresses Listed and Efficiency
//
// No credential and no network: _dmxCap is seeded directly.
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };
const IGNORE = /calendar\.google\.com|toDataURL|[Tt]ainted canvas|Failed to fetch|net::ERR|401|403/;

const WEEK = '2026-08-17';   // a COMPLETED week, so nothing is suppressed as pending
const WANT = ['Store', 'Hours', 'Staffed For', 'Ceiling', 'Goal', 'Listed', 'Efficiency', 'Result'];

// The screenshot's own figures. Deliberately all-distinct per row so a
// one-column slip cannot land on a matching number by luck.
const ROWS = [
    { store: 'OVL', hours: 205, capacity: 307, planned: 230, actual: 178, adjusted: 227 },
    { store: 'LEE', hours: 180, capacity: 263, planned: 197, actual: 157, adjusted: 226 },
    { store: 'WSP', hours: 160, capacity: 242, planned: 181, actual: 111, adjusted: 167 },
].map(r => ({
    ...r, people: [1, 2, 3, 4], assignedDays: 24, offDays: 0,
    efficiency: Math.round((r.actual / r.adjusted) * 100) / 100,
}));

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

    const table = await page.evaluate((week, rows) => {
        _dmxGoalsLoaded = true;
        _storeTargets.OVL = { store: 'OVL', target: 230, manual: true, weeks: [] };
        _dmxCap[week] = rows;
        _dmxCapWeek = week;
        _dmxSel.lg = 'EFF';
        renderDmListingModal();
        const t = document.querySelector('#dmListingBody .dmx-tbl-c');
        if (!t) return null;
        const cellText = tr => [...tr.children].map(td => td.textContent.trim());
        const bodyRows = [...t.querySelectorAll('tbody tr')];
        return {
            heads: [...t.querySelectorAll('thead th')].map(th => th.textContent.trim()),
            stores: bodyRows.filter(r => !r.classList.contains('dmx-tot')).map(cellText),
            total: (() => { const r = bodyRows.find(x => x.classList.contains('dmx-tot')); return r ? cellText(r) : null; })(),
            // The vertical rules, resolved from the DOM rather than read off the
            // stylesheet — nth-child is positional, so this is the only way to
            // know where they actually landed.
            ruled: [...t.querySelectorAll('thead th')]
                .map((th, i) => getComputedStyle(th).borderLeftWidth !== '0px' ? i + 1 : 0)
                .filter(Boolean),
            mutedCols: [...bodyRows[0].children]
                .map((td, i) => td.classList.contains('dmx-mute') ? i + 1 : 0).filter(Boolean),
        };
    }, WEEK, ROWS);

    if (!table) { ok(false, 'the Results table rendered at all'); await browser.close(); process.exit(1); }

    console.log('== Column order ==');
    ok(JSON.stringify(table.heads) === JSON.stringify(WANT),
        'headers are Store · Hours · Staffed For · Ceiling · Goal · Listed · Efficiency · Result',
        table.heads.join(' · '));

    console.log('');
    console.log('== Every figure under its own header ==');
    // What each header must hold, per store row. This is the assertion that a
    // moved <td> without its <th> fails.
    const expect = r => ({
        'Store': r.store,
        'Hours': String(r.hours),
        'Staffed For': String(r.adjusted),
        'Ceiling': String(r.capacity),
        'Goal': String(r.planned),
        'Listed': String(r.actual),
        'Efficiency': Math.round(r.efficiency * 100) + '%',
    });
    // ⚠️ Look the column up in the RENDERED headers, not in WANT. Indexing off
    // WANT only ever re-checks that the <td>s are where this file expects them,
    // which is blind to the exact bug being guarded against: leave the <td>s
    // alone, move a <th>, and every figure is under the wrong label while an
    // assertion keyed to WANT still passes. Verified — it did.
    const colOf = h => table.heads.indexOf(h);
    ROWS.forEach((r, i) => {
        const cells = table.stores[i] || [];
        const want = expect(r);
        const bad = Object.keys(want).filter(h => {
            const col = colOf(h);
            if (col < 0) return true;   // header missing entirely
            // Store's cell carries the roles tag too, so match on containment there.
            return h === 'Store' ? !(cells[col] || '').includes(want[h]) : cells[col] !== want[h];
        });
        ok(bad.length === 0, r.store + ' reads correctly under the headers as rendered',
            bad.length ? 'MISALIGNED: ' + bad.map(h => h + ' shows "' + cells[colOf(h)] + '" not "' + want[h] + '"').join('; ')
                       : Object.keys(want).map(h => h + ' ' + cells[colOf(h)]).join(' · '));
    });

    console.log('');
    console.log('== District roll-up ==');
    const sum = k => ROWS.reduce((a, r) => a + r[k], 0);
    const tot = table.total || [];
    const tExp = {
        'Hours': String(sum('hours')), 'Staffed For': String(sum('adjusted')),
        'Ceiling': String(sum('capacity')), 'Goal': String(sum('planned')),
        'Listed': String(sum('actual')),
        'Efficiency': Math.round((sum('actual') / sum('adjusted')) * 100) + '%',
    };
    const tBad = Object.keys(tExp).filter(h => tot[colOf(h)] !== tExp[h]);
    ok(tBad.length === 0, 'the roll-up totals its own column, in the same order',
        tBad.length ? 'MISALIGNED: ' + tBad.map(h => h + ' shows "' + tot[colOf(h)] + '" not "' + tExp[h] + '"').join('; ')
                   : Object.keys(tExp).map(h => h + ' ' + tot[colOf(h)]).join(' · '));

    console.log('');
    console.log('== Grouping rules follow the new layout ==');
    // Before Ceiling (4) and before Efficiency (7). At 3 and 6 they would split
    // Hours from Staffed For, which is the pair that has to be read together.
    ok(JSON.stringify(table.ruled) === JSON.stringify([4, 7]),
        'the two vertical rules sit before Ceiling and before Efficiency',
        'ruled at column(s) ' + (table.ruled.join(', ') || 'none'));
    ok(!table.ruled.includes(3), 'and nothing separates Hours from Staffed For');

    console.log('');
    console.log('== Styling survived the move ==');
    // mutedCols is 1-based (it reports column positions, to read the same way as
    // the nth-child rules above); WANT is a 0-based array.
    ok(table.mutedCols.length === 1 && table.mutedCols[0] === WANT.indexOf('Ceiling') + 1,
        'Ceiling is still the muted column',
        'muted at ' + (table.mutedCols.join(', ') || 'none') + ' — Ceiling is column ' + (WANT.indexOf('Ceiling') + 1));

    console.log('');
    console.log('== An in-progress week still suppresses what it cannot know ==');
    const live = await page.evaluate(rows => {
        // Monday of the CURRENT week, the same key the pane compares against.
        const d = new Date();
        d.setDate(d.getDate() + (d.getDay() === 0 ? -6 : 1 - d.getDay()));
        const wk = d.toLocaleDateString('en-CA');
        _dmxCap[wk] = rows.map(r => ({ ...r, actual: 0, efficiency: 0 }));
        _dmxCapWeek = wk;
        renderDmListingModal();
        const t = document.querySelector('#dmListingBody .dmx-tbl-c');
        const cells = [...t.querySelectorAll('tbody tr')[0].children].map(td => td.textContent.trim());
        return { listed: cells[5], eff: cells[6], result: cells[7], hours: cells[1], staffed: cells[2] };
    }, ROWS);
    ok(live.listed === '–' && live.eff === '–' && /not filed/i.test(live.result),
        'Listed and Efficiency read "–" until the KPI is filed', JSON.stringify(live));
    ok(live.hours === '205' && live.staffed === '227',
        'but Hours and Staffed For still show — they do not need the KPI',
        live.hours + ' / ' + live.staffed);

    console.log('');
    ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | ') || 'clean');
    await browser.close();
    console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
    process.exit(fails ? 1 : 0);
})();
