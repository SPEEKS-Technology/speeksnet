// Where does the reviews block think the month's total and projection live?
//
// It used to think "row 35, always", which is true only in a 31-day month.
// month-rollover.gs deletes a day row when the new month is shorter, so on
// 2026-09-01 the grid ended at row 33 and row 35 held the PROJECTION — served
// to the dashboard as the month-to-date count, 26x too big, with no error
// anywhere.
//
// The row-finding loop is sliced out of the shipped .gs and run against the
// four month shapes rather than retyped here, so this tests what deploys.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'hub-reviews-file.gs');
const src = fs.readFileSync(SRC, 'utf8');

// Just the scan: from `var lastDay` to the projRow assignment.
const from = src.indexOf('var lastDay = 4;');
const to = src.indexOf('var projRow', from);
if (from < 0 || to < 0) { console.error('FAILED: could not find the row scan'); process.exit(1); }
const scan = src.slice(from, src.indexOf('\n', to) + 1);

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

// A month tab's AE column: four header rows, then day numbers, then the total
// and projection rows (labelled, not numbered) below the grid.
const sheetFor = days => {
    const col = [];
    for (let d = 1; d <= days; d++) col.push([d]);
    col.push(['Total']);       // the MAX row
    col.push(['Projected']);   // the projection row
    col.push(['']);
    return col;                // index 0 === AE4
};

const run = days => {
    const grid = sheetFor(days);
    // Stand in for the Apps Script objects the scan touches.
    const tab = { getRange: () => ({ getValues: () => grid }) };
    const data = {};
    let out = null;
    // eslint-disable-next-line no-new-func
    const fn = new Function('tab', 'data', scan + ' return { lastDay: lastDay, totalRow: totalRow, projRow: projRow };');
    out = fn(tab, data);
    return out;
};

console.log('== The grid ends where the month does ==');
const cases = [
    // days, lastDay row, total row, projection row
    [31, 34, 35, 36],   // August — the layout the old code assumed
    [30, 33, 34, 35],   // September — the one that broke it
    [29, 32, 33, 34],   // a leap February
    [28, 31, 32, 33],   // an ordinary February
];
for (const [days, lastDay, totalRow, projRow] of cases) {
    const r = run(days);
    ok(r.lastDay === lastDay && r.totalRow === totalRow && r.projRow === projRow,
       days + '-day month: total at row ' + totalRow + ', projection at ' + projRow,
       'got lastDay=' + r.lastDay + ' total=' + r.totalRow + ' proj=' + r.projRow);
}

console.log('== The September figures that were served ==');
// The real payload on 2026-09-01: BAL had 36 five-star reviews, E40=1 day thru,
// E39=26 buying days, so the projection cell held 36/1*26 = 936. Reading row 35
// in a 30-day month picks up exactly that.
const sep = run(30);
ok(sep.totalRow === 34, 'the real total was one row above where it was read', 'row ' + sep.totalRow);
ok(sep.projRow === 35, 'and row 35 — the old address — held the projection', 'row ' + sep.projRow);
ok(36 * 26 === 936, 'which is why BAL reported 936 instead of 36');
ok(936 + 962 + 988 + 1170 + 1092 === 5148, 'and the company tile read 5,148');

console.log('== A layout it does not recognise reports nothing ==');
// Confidently serving the wrong cell is what this whole exercise was about, so
// the guard returns `data` untouched rather than falling through. A bail shows
// up here as the row fields never being assigned.
ok(run(27).lastDay === undefined, '27 rows is not a month — bails instead of guessing');
ok(run(40).lastDay === undefined, 'and so does a grid that runs off the end');
ok(run(28).lastDay === 31 && run(31).lastDay === 34, '28 and 31 both still read');

console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
