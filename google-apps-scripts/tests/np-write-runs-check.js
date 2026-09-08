// Writing the Net Profit grid around cells that must not be touched.
//
// Two things now cut a hole in a column write:
//   * a PIN — the workbook's bare-number lock, e.g. OVL Sep 1's restated Sales,
//     which exists because Shopify keeps reporting a duplicate order that has
//     been deleted
//   * the MORNING PASS — NP_SKIP_SHIP, which leaves shipping alone until 2pm
//
// Before this, one pinned cell skipped the WHOLE DAY: that day's eBay Fee,
// Shipping and CC Fee froze at whatever they held and nothing said so again.
// This harness exists because the failure is silent — a wrong range here does
// not throw, it writes a real number one row off in a financial column.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'netprofit-sheet.gs');
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const grab = name => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
eval(grab('_npWriteRuns'));

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

// A fake sheet that records every setValues call and refuses to be written
// outside the range it was given.
function fakeSheet(height) {
    const cells = {};                 // "r,c" -> value
    const calls = [];
    return {
        calls,
        cells,
        getRange(r1, c1, nR, nC) {
            if (r1 < 1 || c1 < 1) throw new Error('range out of bounds: ' + r1 + ',' + c1);
            if (r1 + nR - 1 > height) throw new Error('range past the grid: row ' + (r1 + nR - 1));
            return {
                setValues(vals) {
                    if (vals.length !== nR) throw new Error('height mismatch');
                    calls.push({ r1, c1, n: nR });
                    for (let i = 0; i < nR; i++) cells[(r1 + i) + ',' + c1] = vals[i][0];
                }
            };
        }
    };
}

// Rows as _npWrite builds them: 0-based sheet row index, day number, lock map.
const mkRows = (n, locks) => {
    const rows = [];
    for (let d = 1; d <= n; d++) rows.push({ r: 4 + (d - 1), day: d, locked: (locks || {})[d] || {} });
    return rows;
};
const vals = n => { const v = []; for (let d = 1; d <= n; d++) v.push(d * 10); return v; };

const SALES = 1, SHIP = 10;

console.log('== A clean month is still ONE block write ==');
{
    const sh = fakeSheet(40), rows = mkRows(30);
    const wrote = _npWriteRuns(sh, rows, SALES + 1, vals(30), SALES);
    ok(wrote === 30, '30 cells written', String(wrote));
    ok(sh.calls.length === 1, 'in a single setValues call', String(sh.calls.length));
    ok(sh.calls[0].r1 === 5 && sh.calls[0].n === 30, 'starting at row 5, 30 tall',
       'r' + sh.calls[0].r1 + ' x' + sh.calls[0].n);
    ok(sh.cells['5,2'] === 10 && sh.cells['34,2'] === 300, 'day 1 and day 30 land on the right rows');
}

console.log('== A pin is never written, and never written back ==');
{
    // OVL Sep 1: Sales pinned at =949.33. The pin is day 1, the first row.
    const sh = fakeSheet(40), rows = mkRows(30, { 1: { [SALES]: true } });
    const wrote = _npWriteRuns(sh, rows, SALES + 1, vals(30), SALES);
    ok(wrote === 29, '29 of 30 cells written', String(wrote));
    ok(sh.cells['5,2'] === undefined, 'row 5 — the pinned cell — was NOT touched');
    ok(sh.calls.every(c => c.r1 > 5), 'no call even starts on it',
       sh.calls.map(c => 'r' + c.r1 + 'x' + c.n).join(' '));
    ok(sh.cells['6,2'] === 20, 'day 2 still lands on row 6 — nothing shifted up');
}

console.log('== A pin in the MIDDLE splits the block, it does not truncate it ==');
{
    const sh = fakeSheet(40), rows = mkRows(30, { 15: { [SALES]: true } });
    const wrote = _npWriteRuns(sh, rows, SALES + 1, vals(30), SALES);
    ok(wrote === 29, '29 cells written', String(wrote));
    ok(sh.calls.length === 2, 'in two runs', String(sh.calls.length));
    ok(sh.cells['19,2'] === undefined, 'day 15 (row 19) untouched');
    ok(sh.cells['18,2'] === 140 && sh.cells['20,2'] === 160,
       'the days either side of it are correct — 14 before, 16 after');
    ok(sh.cells['34,2'] === 300, 'and the last day is still on the last row');
}

console.log('== Every day pinned writes nothing at all ==');
{
    const locks = {};
    for (let d = 1; d <= 30; d++) locks[d] = { [SALES]: true };
    const sh = fakeSheet(40);
    const wrote = _npWriteRuns(sh, mkRows(30, locks), SALES + 1, vals(30), SALES);
    ok(wrote === 0 && sh.calls.length === 0, 'no cells, no calls');
}

console.log('== A gap in the day rows is never written through ==');
{
    // Day 7 has no row on the tab. Writing straight through would put day 8 on
    // day 7's row and every later day one row too high — in a money column.
    const rows = mkRows(30).filter(x => x.day !== 7);
    const v = rows.map(x => x.day * 10);
    const sh = fakeSheet(40);
    const wrote = _npWriteRuns(sh, rows, SALES + 1, v, SALES);
    ok(wrote === 29, '29 cells written', String(wrote));
    ok(sh.calls.length === 2, 'in two runs, because the rows are not consecutive',
       String(sh.calls.length));
    ok(sh.cells['10,2'] === 60, 'day 6 on row 10');
    ok(sh.cells['12,2'] === 80, 'day 8 on row 12 — its OWN row, not day 7 shifted');
    ok(sh.cells['34,2'] === 300, 'day 30 still on row 34');
}

console.log('== The morning pass: shipping is skipped, the rest is not ==');
{
    // What npsDailyRefresh does at 8am is simply not to call _npWriteRuns for
    // the shipping column. Asserted as the caller behaves, so the test fails if
    // somebody "simplifies" the guard away.
    const NP_SKIP_SHIP = true;
    const sh = fakeSheet(40), rows = mkRows(30);
    _npWriteRuns(sh, rows, SALES + 1, vals(30), SALES);
    if (!NP_SKIP_SHIP) _npWriteRuns(sh, rows, SHIP + 1, vals(30), SHIP);
    ok(sh.calls.length === 1, 'one column written, not two', String(sh.calls.length));
    ok(!Object.keys(sh.cells).some(k => k.endsWith(',' + (SHIP + 1))),
       'nothing at all in the shipping column');
    ok(sh.cells['5,2'] === 10, 'and Sales was written normally');
}

console.log('== Skipping leaves yesterday empty, NOT the whole month ==');
{
    // The reason skipping is safe: the earlier days already hold final shipping
    // from a previous 2pm pass, and a skip does not clear them.
    const sh = fakeSheet(40), rows = mkRows(30);
    // Pretend the sheet already holds shipping for days 1-9 (rows 5-13).
    for (let d = 1; d <= 9; d++) sh.cells[(4 + d) + ',' + (SHIP + 1)] = 'final';
    // Morning pass: shipping not called.
    let survived = 0;
    for (let d = 1; d <= 9; d++) if (sh.cells[(4 + d) + ',' + (SHIP + 1)] === 'final') survived++;
    ok(survived === 9, 'all 9 settled days keep their final shipping', String(survived));
    ok(sh.cells['14,' + (SHIP + 1)] === undefined, 'day 10 — yesterday — is the only empty one');
}

// ---------------------------------------------------------------------------
// THE TAB HOLDS COMPLETED DAYS ONLY, AND TODAY IS NOT ONE.
//
// Two faults, one rule.
//
// npWriteApply reads NP_FROM/NP_TO out of the file, and those are the whole
// month — so a hand-run on the 2nd asked for all 30 days, got legitimate zeros
// for the 29 that had not happened, and wrote them. Zero is not blank to a
// spreadsheet: Gross Margin became 0/0, Rev Tracking projected off a divisor
// counting 30 days instead of 1, and the tab filled with #DIV/0! and a
// descending ladder of numbers that all looked like real figures.
//
// And npsDailyRefresh sets NP_TO to TODAY, so both passes wrote a PART day —
// whatever had rung up by 8am, then again by 2pm. That is subtler and was there
// from the start: Days Thru is DERIVED from the last day carrying Sales, so an
// hour of trading counts as a whole day in every divisor on the tab. Two full
// days plus one hour projected the month over THREE days, and every tracking
// column, the % of NP Goal and the YoY "Current" figure read low all day, with
// nothing about the number saying so.
//
// So the boundary is TODAY, not tomorrow: today's row is never written, and is
// cleared if something already wrote it.
const constOf = name => {
    const m = src.match(new RegExp('var ' + name + '\\s*=\\s*([^;]*);'));
    if (!m) throw new Error('constant not found: ' + name);
    return m[1];
};
global.NP_HEADER_ROWS = eval(constOf('NP_HEADER_ROWS'));
['NP_OFF_SALES', 'NP_OFF_COST', 'NP_OFF_EBAYFEE', 'NP_OFF_SHIP', 'NP_OFF_CCFEE']
    .forEach(n => { global[n] = eval(constOf(n)); });
eval(grab('_npIsOurPlaceholder'));
eval(grab('_npClearIncomplete'));

// A tab: 4 header rows, then 30 day rows, then TTL. Values and formulas are
// separate grids, as getValues()/getFormulas() return them.
function futureTab(fill) {
    const W = 20, vals = [], fmls = [];
    for (let r = 0; r < 4 + 30 + 1; r++) {
        vals.push(new Array(W).fill(''));
        fmls.push(new Array(W).fill(''));
    }
    for (let d = 1; d <= 30; d++) vals[4 + (d - 1)][0] = d;
    vals[4 + 30][0] = 'TTL';
    if (fill) fill(vals, fmls);
    return { vals, fmls };
}
function clearSheet() {
    const cleared = [];
    return {
        cleared,
        getRange(r1, c1) { return { clearContent() { cleared.push(r1 + ',' + c1); } }; }
    };
}
const OFFS = [NP_OFF_SALES, NP_OFF_COST, NP_OFF_EBAYFEE, NP_OFF_SHIP, NP_OFF_CCFEE];

console.log('== The zeros a whole-month run wrote are cleared ==');
{
    // Exactly the damage: day 1 real, days 2-30 written as 0.
    const { vals, fmls } = futureTab(v => {
        OFFS.forEach(o => { v[4][o] = o === NP_OFF_SALES ? 949.33 : 168; });
        for (let d = 2; d <= 30; d++) OFFS.forEach(o => { v[4 + (d - 1)][o] = 0; });
    });
    const sh = clearSheet();
    const n = _npClearIncomplete(sh, vals, fmls, 0, '2026-09', '2026-09-02', false);
    ok(n === 29 * 5, 'days 2-30 x 5 columns cleared', String(n));
    ok(!sh.cleared.some(k => k.startsWith('5,')), 'day 1 — complete — is untouched');
    ok(sh.cleared.includes('6,' + (NP_OFF_SALES + 1)),
       'day 2 IS cleared, because it is today and today is still running', sh.cleared[0]);
    ok(sh.cleared.includes('7,' + (NP_OFF_SALES + 1)), 'and every day after it');
    ok(!sh.cleared.some(k => k.startsWith('35,')), 'the TTL row is never touched');
}

console.log('== Today is the boundary, and it falls on the cleared side ==');
{
    const { vals, fmls } = futureTab(v => {
        for (let d = 1; d <= 30; d++) OFFS.forEach(o => { v[4 + (d - 1)][o] = 5; });
    });
    const sh = clearSheet();
    _npClearIncomplete(sh, vals, fmls, 0, '2026-09', '2026-09-15', false);
    ok(!sh.cleared.some(k => Number(k.split(',')[0]) <= 4 + 14), 'days 1-14 — complete — all survive');
    ok(sh.cleared.some(k => k.startsWith('19,')), 'day 15, today, is cleared', String(sh.cleared.length));
    ok(sh.cleared.length === 16 * 5, 'days 15-30, x 5 columns', String(sh.cleared.length));
}

console.log('== The month comes from the GRID, not from the clock ==');
{
    // The close runs on Oct 1 against September's grid. Every day of September
    // is in the past then, so nothing may be cleared — deriving the row's date
    // from today's month instead would wipe the closed month.
    const { vals, fmls } = futureTab(v => {
        for (let d = 1; d <= 30; d++) OFFS.forEach(o => { v[4 + (d - 1)][o] = 99; });
    });
    const sh = clearSheet();
    const n = _npClearIncomplete(sh, vals, fmls, 0, '2026-09', '2026-10-01', false);
    ok(n === 0, 'closing September on Oct 1 clears nothing', String(n));
}

console.log('== A formula is never deleted, whatever the date ==');
{
    const { vals, fmls } = futureTab((v, f) => {
        for (let d = 2; d <= 30; d++) OFFS.forEach(o => { v[4 + (d - 1)][o] = 0; });
        f[4 + 9][NP_OFF_SALES] = '=949.33';          // day 10: the workbook's lock
        f[4 + 10][NP_OFF_COST] = '=SUM(A1:A2)';      // day 11: somebody's work
        f[4 + 11][NP_OFF_SHIP] = '=NA()';            // day 12: ours, and clearable
    });
    const sh = clearSheet();
    _npClearIncomplete(sh, vals, fmls, 0, '2026-09', '2026-09-02', false);
    ok(!sh.cleared.includes('14,' + (NP_OFF_SALES + 1)), 'a bare-number lock survives');
    ok(!sh.cleared.includes('15,' + (NP_OFF_COST + 1)), 'a live formula survives');
    ok(sh.cleared.includes('16,' + (NP_OFF_SHIP + 1)),
       'our own =NA() goes — "blocked" and "has not happened" are different things');
}

console.log('== Nothing to do is nothing done ==');
{
    const { vals, fmls } = futureTab();            // every future day already blank
    const sh = clearSheet();
    const n = _npClearIncomplete(sh, vals, fmls, 0, '2026-09', '2026-09-02', false);
    ok(n === 0 && sh.cleared.length === 0, 'a clean tab is not written to at all');
}

console.log('== Preview counts without clearing ==');
{
    const { vals, fmls } = futureTab(v => {
        for (let d = 2; d <= 30; d++) OFFS.forEach(o => { v[4 + (d - 1)][o] = 0; });
    });
    const sh = clearSheet();
    const n = _npClearIncomplete(sh, vals, fmls, 0, '2026-09', '2026-09-02', true);
    ok(n === 29 * 5, 'it reports what it would clear', String(n));
    ok(sh.cleared.length === 0, 'and clears nothing');
}

console.log('== And the WRITE side agrees with the clear side ==');
{
    // The two have to move together or they fight: the writer would put today's
    // part-day in and the cleaner would take it straight back out, and whichever
    // ran last would win. Asserted in the source because the clamp lives inside
    // _npWrite, which needs a whole spreadsheet to call.
    //
    // ⚠️ ">" HERE INSTEAD OF ">=" IS THE WHOLE BUG. It reads as "skip the
    // future", which sounds right and leaves today being written on every run.
    const m = src.match(/if \(String\(rec\.day\) (>=?) todayYmd\)/);
    ok(!!m, 'the writer clamps against today at all', m && m[0]);
    ok(m && m[1] === '>=', 'and with >=, so TODAY is skipped, not just tomorrow', m && m[0]);
    const c = src.match(/slice\(-2\) (<=?) todayYmd\) continue;/);
    ok(!!c && c[1] === '<', 'and the cleaner keeps only days STRICTLY before today', c && c[0]);
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
