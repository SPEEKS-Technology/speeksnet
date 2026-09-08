// Where each September restatement actually lands, on BOTH tabs.
//
// sep-fix.gs writes one list of figures into two grids with DIFFERENT strides —
// Sales blocks are 11 wide, Net Profit blocks are 18 — and the same figure is
// Sales at +1 and Cost at +4 in both. That coincidence is what lets one list
// serve two tabs, and it is also what makes a mistake here invisible: a wrong
// base writes a real dollar figure into a real financial cell belonging to a
// DIFFERENT STORE, and nothing throws.
//
// The row is found by day NUMBER, never by arithmetic off a header, because
// September has 30 rows where August had 31. This harness builds both grids,
// runs the real _sepfFindDayRow, and asserts every fix lands on the store and
// day it names.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'sep-fix.gs');
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const grab = name => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
// The declarations are column-aligned with runs of spaces before the '=', so
// matching on a single space silently misses half of them.
const grabVar = name => {
    const m = new RegExp('^var\\s+' + name + '\\s*=', 'm').exec(src);
    if (!m) throw new Error('missing ' + name);
    const i = m.index;
    // A declaration ends at the first ';' that is not inside the value — for the
    // arrays and strings here, the last ';' before a blank line or a new 'var'.
    const rest = src.slice(i);
    const end = rest.search(/;\s*\n(\s*\n|var |function )/);
    if (end < 0) throw new Error('unterminated ' + name);
    return rest.slice(0, end + 1);
};

eval(grab('_sepfFindDayRow'));
eval(grab('_sepfIsBareNumber'));
eval(grab('_sepfA1'));
eval(grabVar('SEPF_TARGETS'));
eval(grabVar('SEPF_COL_SALES'));
eval(grabVar('SEPF_COL_COST'));
eval(grabVar('SEPF_HEADER_ROWS'));
// The notes are referenced by SEPF_FIX, so they have to exist before it is read.
for (const n of src.match(/var SEPF_NOTE_\w+ =/g) || []) eval(grabVar(n.slice(4, -2)));
eval(grabVar('SEPF_FIX'));

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

// A September grid: 4 header rows, days 1..30, then TTL. Every store block gets
// its own day column at its own base, so a base that is off by one block finds
// the day but on the wrong store — which is exactly the bug being hunted.
function grid(bases, stride, days) {
    const width = Math.max(...Object.values(bases)) + stride;
    const rows = [];
    for (let r = 0; r < SEPF_HEADER_ROWS; r++) rows.push(new Array(width).fill(''));
    for (let d = 1; d <= days; d++) {
        const row = new Array(width).fill('');
        for (const [store, base] of Object.entries(bases)) {
            row[base] = d;
            row[base + SEPF_COL_SALES] = store + '-sales-' + d;
            row[base + SEPF_COL_COST] = store + '-cost-' + d;
        }
        rows.push(row);
    }
    const ttl = new Array(width).fill('');
    ttl[0] = 'TTL';
    rows.push(ttl);
    return rows;
}

console.log('every fix lands on the store and day it names, on both tabs');
for (const target of SEPF_TARGETS) {
    const stride = target.tab.indexOf('Net Profit') === 0 ? 18 : 11;
    const values = grid(target.bases, stride, 30);
    for (const f of SEPF_FIX) {
        const base = target.bases[f.store];
        const r = _sepfFindDayRow(values, base, f.day);
        ok(r >= 0, target.tab + ' ' + f.store + ' day ' + f.day + ': row found');
        if (r < 0) continue;
        // The cell it would overwrite must be the one belonging to THIS store on
        // THIS day. The sentinel carries both, so a block or row slip fails here.
        ok(values[r][base + SEPF_COL_SALES] === f.store + '-sales-' + f.day,
            target.tab + ' ' + f.store + ' day ' + f.day + ': sales cell is the right store/day',
            _sepfA1(base + SEPF_COL_SALES) + (r + 1) + ' holds ' + values[r][base + SEPF_COL_SALES]);
        ok(values[r][base + SEPF_COL_COST] === f.store + '-cost-' + f.day,
            target.tab + ' ' + f.store + ' day ' + f.day + ': cost cell is the right store/day',
            _sepfA1(base + SEPF_COL_COST) + (r + 1) + ' holds ' + values[r][base + SEPF_COL_COST]);
    }
}

// A day past the end of the grid must come back -1 rather than running into the
// TTL row — that row's first cell is 'TTL' and its store columns are blank, so a
// loop that did not stop there would return a row of totals to overwrite.
console.log('the search stops at TTL');
{
    const t = SEPF_TARGETS[0];
    const values = grid(t.bases, 11, 30);
    ok(_sepfFindDayRow(values, t.bases.OVL, 31) === -1, 'day 31 in a 30-day month is not found');
    ok(_sepfFindDayRow(values, t.bases.BAL, 31) === -1, 'day 31 at the last block is not found');
}

// The lock idiom: only a bare number may be replaced. Anything with a letter in
// it is somebody's formula and the writer must leave it alone.
console.log('the bare-number lock only matches bare numbers');
ok(_sepfIsBareNumber('=949.33') === true, '=949.33 is a pin');
ok(_sepfIsBareNumber('=5993.75') === true, '=5993.75 is a pin');
ok(_sepfIsBareNumber('=B5-E5') === false, '=B5-E5 is a live formula');
ok(_sepfIsBareNumber('=SUM(B5:B34)') === false, '=SUM(...) is a live formula');
ok(_sepfIsBareNumber('=NA()') === false, '=NA() is a live formula');
ok(_sepfIsBareNumber('') === false, 'an empty cell is not a pin');

// The arithmetic behind the figures, restated from sales-true-daily for Sep 2 so
// a later edit to one number without the other cannot pass unnoticed.
console.log('the Sep 2 figures still equal reported minus drafts');
const EXPECT = {
    OVL: { reported: 6453.72, draftSales: 459.97, reportedCost: 3129.07, draftCost: 245.00 },
    MPL: { reported: 3287.32, draftSales: 229.99, reportedCost: 1341.66, draftCost: 100.00 }
};
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
for (const [store, e] of Object.entries(EXPECT)) {
    const fix = SEPF_FIX.find(f => f.store === store && f.day === 2);
    ok(!!fix, store + ' day 2 is in SEPF_FIX');
    if (!fix) continue;
    ok(fix.sales === r2(e.reported - e.draftSales),
        store + ' day 2 sales', fix.sales + ' == ' + e.reported + ' - ' + e.draftSales);
    ok(fix.cost === r2(e.reportedCost - e.draftCost),
        store + ' day 2 cost', fix.cost + ' == ' + e.reportedCost + ' - ' + e.draftCost);
}

// Only the stores that actually had draft orders on Sep 2 may be restated.
// LEE, WSP and BAL had none, and a fix for one of them would be a day of real
// selling quietly deleted.
console.log('no store without a Sep 2 draft order is restated');
for (const store of ['LEE', 'WSP', 'BAL']) {
    ok(!SEPF_FIX.some(f => f.store === store && f.day === 2),
        store + ' day 2 is left alone');
}

// Every fix must carry a note. An unexplained pin is a number nobody can audit
// later, and the note is the only place the reason survives.
console.log('every fix carries a note');
for (const f of SEPF_FIX) {
    ok(typeof f.note === 'string' && f.note.length > 40,
        f.store + ' day ' + f.day + ' has a note');
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
