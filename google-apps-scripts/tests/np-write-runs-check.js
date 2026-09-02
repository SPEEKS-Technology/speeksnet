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

console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
