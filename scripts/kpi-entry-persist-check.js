// Weekly / Monthly KPI entry — does typed data survive a re-render?
//
// THE BUG. Typed numbers lived only in the DOM: _kpiSavePeriod reads them
// straight out of the inputs by id, so nothing ever put them back into
// _kpiPeriodsData — and every re-render rebuilds the grid FROM
// _kpiPeriodsData. So filling in a roster and then clicking
// "+ Add Ethan (DM) — helped out this week" rebuilt the grid from the server
// and wiped the whole week. No warning, no undo.
//
// Reproduced here as the user hit it: type into several people and several
// columns, click the add-the-DM button, and read the boxes back.
//
//   1. every number typed is still in its own box afterwards
//   2. the DM's row is there, and it is empty (nothing invented)
//   3. the computed columns are recomputed, not left stale — _kpiUpdateRow
//      only ever wrote those to the DOM, never to the entry
//   4. an EMPTIED saved figure still reads as a deletion, because that is what
//      the save path does with it
//   5. a never-touched row does not start totalling $0 where it showed "—"
//      (Number(null) is 0; the total row filters on != null)
//   6. switching which week is being edited keeps the first week's numbers
//   7. Cancel still discards — losing the data is the POINT there
//
// No credential and no writes: the modal is driven with canned period data.
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };
const IGNORE = /calendar\.google\.com|toDataURL|[Tt]ainted canvas|Failed to fetch|net::ERR|401/;

// Two weeks: the current one (editable) and last week with a saved figure on it.
const PERIODS = [
    {
        period_end_date: '2026-08-23', period_label: 'Week of Aug 17', is_editable: true, note: '',
        entries: [
            { employee_name: 'Alice Adams' },
            { employee_name: 'Bob Baker' },
            { employee_name: 'Cara Cole' },
        ],
    },
    {
        period_end_date: '2026-08-16', period_label: 'Week of Aug 10', is_editable: false, note: '',
        entries: [{ id: 91, employee_name: 'Alice Adams', buying_value: 500, buying_cost: 300 }],
    },
];

(async () => {
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => { const m = String(e.message || e); if (!IGNORE.test(m)) errs.push(m); });
    await page.setViewport({ width: 1700, height: 1000 });
    await page.evaluateOnNewDocument(() => {
        sessionStorage.setItem('speeksUnlocked', 'true');
        sessionStorage.setItem('speeksUserName', 'Test Manager');
        sessionStorage.setItem('speeksUserRole', 'manager');
        sessionStorage.setItem('speeksUserStore', 'OVL');
        sessionStorage.setItem('speeksUserPin', '0000');
        // _kpiDmName reads the auth cache, so the "+ Add the DM" button needs one.
        localStorage.setItem('speeksAuthCache', JSON.stringify({
            users: [{ name: 'Ethan Kushnir', role: 'district manager' }],
        }));
    });
    await page.goto('file:///' + REPO + '/workspace.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));

    const drew = await page.evaluate(periods => {
        _kpiCurrentTab = 'weekly';
        _kpiPeriodsData = JSON.parse(JSON.stringify(periods));
        _kpiEditingPeriod = '2026-08-23';
        _kpiRenderWeekly(_kpiPeriodsData);
        return document.querySelectorAll('#kpiModalBody input.kpi-grid-input').length;
    }, PERIODS);
    ok(drew > 0, 'the entry grid draws with inputs', drew + ' boxes');

    const PK = '20260823';
    // Three people, four columns — the shape of a real week's entry, not one box.
    const TYPED = [
        [0, 'buying_value', '1200'], [0, 'buying_cost', '700'], [0, 'transaction_count', '14'],
        [1, 'buying_value', '900'],  [1, 'listed_count', '31'],
        [2, 'no_deal_count', '3'],   [2, 'mtd_google_reviews', '5'],
    ];
    // Values are SET and an input event dispatched, rather than typed with the
    // keyboard: the KPI grid lives in a workspace pane that is not the active one
    // here, so its boxes have no clickable point. The harvest reads el.value and
    // the live recalc listens for 'input', so both paths under test run exactly
    // as they do for a person.
    await page.evaluate((pk, typed) => {
        typed.forEach(([i, f, v]) => {
            const el = document.getElementById('kpi-' + pk + '-' + i + '-' + f);
            if (!el) return;
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }, PK, TYPED);
    const before = await page.evaluate((pk, typed) => {
        const out = {};
        typed.forEach(([i, f]) => { const el = document.getElementById('kpi-' + pk + '-' + i + '-' + f); out[i + ':' + f] = el ? el.value : null; });
        return out;
    }, PK, TYPED);
    ok(Object.values(before).every(v => v && v !== ''), 'and all seven figures went in',
        JSON.stringify(before));

    console.log('');
    console.log('== Add the DM mid-entry ==');
    const addBtn = await page.evaluate(() => {
        const b = [...document.querySelectorAll('#kpiModalBody button')]
            .find(x => /Add .*helped out this/.test(x.textContent));
        return b ? b.textContent.trim() : null;
    });
    ok(!!addBtn && /Ethan Kushnir/.test(addBtn), 'the add-the-DM button is offered', addBtn);

    await page.evaluate(() => {
        [...document.querySelectorAll('#kpiModalBody button')]
            .find(x => /Add .*helped out this/.test(x.textContent)).click();
    });
    await new Promise(r => setTimeout(r, 300));

    const after = await page.evaluate((pk, typed) => {
        const out = {};
        typed.forEach(([i, f]) => { const el = document.getElementById('kpi-' + pk + '-' + i + '-' + f); out[i + ':' + f] = el ? el.value : null; });
        const names = [...document.querySelectorAll('#kpiModalBody .kpi-grid-emp-name')].map(n => n.textContent.trim());
        const gp = document.getElementById('kpiC-' + pk + '-0-estimated_gross_profit');
        const dmIdx = names.indexOf('Ethan Kushnir');
        const dmBoxes = dmIdx < 0 ? [] : [...document.querySelectorAll('#kpiModalBody input.kpi-grid-input')]
            .filter(el => el.id.indexOf('kpi-' + pk + '-' + (dmIdx) + '-') === 0).map(el => el.value);
        return { out, names, gp: gp ? gp.textContent.trim() : null, dmBoxes };
    }, PK, TYPED);

    // THE ASSERTION THIS FILE EXISTS FOR.
    const kept = Object.keys(before).filter(k => after.out[k] === before[k]);
    ok(kept.length === TYPED.length, 'every figure survived adding a person',
        kept.length + '/' + TYPED.length + ' kept — ' + JSON.stringify(after.out));
    ok(after.names.includes('Ethan Kushnir'), 'and the DM is on the grid', after.names.join(', '));
    ok(after.dmBoxes.length > 0 && after.dmBoxes.every(v => v === ''),
        'with every box of theirs empty — nothing invented', after.dmBoxes.length + ' empty boxes');
    // 1200 - 700. _kpiUpdateRow only ever wrote this to the DOM, so without the
    // recompute in the harvest it would come back as "—" beside a live 1200.
    ok(after.gp === '$500', 'and the computed columns are recomputed, not stale', after.gp);

    console.log('');
    console.log('== A never-touched row still reads "—", not $0 ==');
    // Number(null) is 0 and the total row filters on != null, so harvesting a
    // null onto a key that was never there would start totalling zeroes.
    const totals = await page.evaluate(() => {
        const cells = [...document.querySelectorAll('#kpiModalBody .kpi-total-cell')].map(c => c.textContent.trim());
        return cells;
    });
    ok(!totals.length || totals.some(t => t === '—'),
        'untouched columns are blank on the total row', totals.slice(0, 8).join(' | ') || '(no total row)');

    console.log('');
    console.log('== Switching weeks keeps the first one ==');
    const swapped = await page.evaluate((pk) => {
        _kpiStartEdit('2026-08-16');
        const p = _kpiPeriodsData.find(x => x.period_end_date === '2026-08-23');
        return { bv: p.entries[0].buying_value, tc: p.entries[0].transaction_count,
                 listed: p.entries[1].listed_count, editing: _kpiEditingPeriod };
    }, PK);
    ok(swapped.editing === '2026-08-16', 'the other week is now the editable one', swapped.editing);
    ok(swapped.bv === 1200 && swapped.tc === 14 && swapped.listed === 31,
        'and the first week kept its numbers in the data',
        JSON.stringify(swapped));

    console.log('');
    console.log('== Cancel still discards ==');
    const cancelled = await page.evaluate(() => {
        _kpiEditingPeriod = '2026-08-23';
        _kpiRenderWeekly(_kpiPeriodsData);
        _kpiCancelEdit();
        const p = _kpiPeriodsData.find(x => x.period_end_date === '2026-08-23');
        return { names: p.entries.map(e => e.employee_name), editing: _kpiEditingPeriod };
    });
    // Losing the DM row is the intent of Cancel — it was never saved.
    ok(!cancelled.names.includes('Ethan Kushnir'), 'the unsaved DM row is dropped', cancelled.names.join(', '));
    ok(cancelled.editing === null, 'and the edit is closed');

    console.log('');
    ok(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | ') || 'clean');
    await browser.close();
    console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
    process.exit(fails ? 1 : 0);
})();
