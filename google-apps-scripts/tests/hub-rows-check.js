// The hub's row numbers, which used to be typed in and are now derived.
//
// The whole safety argument for that change is one claim: in a 31-DAY month the
// derived rows are the SAME rows the old code had hard-coded. If that holds,
// pasting the new Code.gs cannot change a single figure in August, October or
// December — it only starts being right in the short months where the old file
// was silently reading the wrong cells.
//
// _hubRows is sliced out of the shipped .gs rather than retyped, so this tests
// what gets pasted.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'hub-code.gs');
const src = fs.readFileSync(SRC, 'utf8');

const grab = name => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    const j = src.indexOf('\n}\n', i);
    return src.slice(i, j + 2);
};
eval(grab('_hubRows') + '\n' + grab('_hubPad'));

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

console.log('== A 31-day month reproduces the old hard-coded rows ==');
// August 2026 — the layout every constant in the old file was written for.
const aug = _hubRows(new Date(2026, 7, 15));
ok(aug.days === 31, 'August has 31 days', String(aug.days));
ok(aug.salesTotal === 36, 'sales totals row is 36 (was "B36", "F36", "H36"…)', String(aug.salesTotal));
ok(aug.salesFirst === 5 && aug.salesLast === 35, 'sales day grid is 5:35 (was "B5:B35")',
   aug.salesFirst + ':' + aug.salesLast);
ok(aug.buyTotal === 35, 'buying totals row is 35 (was "C35")', String(aug.buyTotal));
ok(aug.buyProj === 36, 'buying projection row is 36 (was "C36")', String(aug.buyProj));
ok(aug.buyFirst === 4 && aug.buyLast === 34, 'buy day grid is 4:34 (was "C4:C34")',
   aug.buyFirst + ':' + aug.buyLast);

console.log('== September 2026 — the month that broke it ==');
const sep = _hubRows(new Date(2026, 8, 2));
ok(sep.days === 30, 'September has 30 days', String(sep.days));
ok(sep.salesTotal === 35, 'sales totals moved to 35, so row 36 was blank', String(sep.salesTotal));
ok(sep.buyTotal === 34, 'buying totals moved to 34…', String(sep.buyTotal));
ok(sep.buyProj === 35, '…so the old BuyVal address, C35, was the PROJECTION', String(sep.buyProj));
// The proof from the live payload: BAL bought 1,657 on Sep 1 and the hub
// reported 43,082 — the projection, 1,657 x 26 buying days.
ok(1657 * 26 === 43082, 'which is why BAL reported $43,082 bought on the 1st');

console.log('== Every month length lands somewhere sane ==');
for (const [y, m, days] of [[2026, 0, 31], [2026, 1, 28], [2028, 1, 29], [2026, 3, 30], [2026, 10, 30]]) {
    const r = _hubRows(new Date(y, m, 10));
    const good = r.days === days
        && r.salesLast === 4 + days && r.salesTotal === 5 + days
        && r.buyLast === 3 + days && r.buyTotal === 4 + days && r.buyProj === 5 + days;
    ok(good, y + '-' + String(m + 1).padStart(2, '0') + ' (' + days + " days): totals under the last day",
       'sales ' + r.salesTotal + ', buy ' + r.buyTotal + '/' + r.buyProj);
}

console.log('== Day arrays stay 31 long whatever the month ==');
// Several consumers index these by day-1 and assume a fixed width.
const short = _hubPad([1, 2, 3], 0);
ok(short.length === 31, 'padded up to 31', String(short.length));
ok(short[3] === 0 && short[30] === 0, 'with the same value a blank row gave');
ok(_hubPad([1, 2, 3], null)[30] === null, 'or null, where null was the convention');
const full = new Array(31).fill(7);
ok(_hubPad(full, 0).length === 31, 'a full month is left alone', String(_hubPad(full, 0).length));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
