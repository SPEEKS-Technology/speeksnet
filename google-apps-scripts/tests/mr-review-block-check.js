// Finding the Google-reviews mini-table on a Buy tab.
//
// It was invisible to month-rollover.gs from the day it was built. _mrBases
// locates a block by finding a store code in the header rows and snapping to a
// MR_BUY_WIDTH boundary; the reviews table at AE:AK carries the same five store
// codes, but the main blocks are to its LEFT and win the left-to-right scan.
// Found by nothing, so renumbered by nothing and cleared by nothing — which is
// why September's day column read 1..29 then 31, and why August's final review
// counts were still sitting in the September tab this morning.
//
// This locator writes over a region of a live spreadsheet, and one column too
// far left is five stores' buying data. So it is tested against the real tab
// shape, and against the shapes that should make it refuse.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'month-rollover.gs');
// ⚠️ Normalised to LF first. The .gs files in this folder are CRLF, and slicing
// a function by looking for a line that is exactly "}" silently finds nothing
// when the line ending is "\r\n".
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const grab = name => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
const MR_BUY_WIDTH = 5;
const MR_REVIEW_WIDTH = Number((src.match(/var MR_REVIEW_WIDTH = (\d+);/) || [])[1]);
eval(grab('_mrDayRows') + '\n' + grab('_mrReviewBase'));

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

// A Buy tab: 4 header rows, five 5-wide store blocks from column B (index 1),
// each with its own day column, then the reviews table at AE (index 30).
// Day 1 lands on row 4, i.e. index 3.
const REV_BASE = 30;
const buyTab = (days, opts) => {
    opts = opts || {};
    const width = 40;
    const rows = [];
    for (let r = 0; r < 4 + days + 4; r++) rows.push(new Array(width).fill(''));
    // Header: store codes in row 1 for the blocks, row 3 for the reviews table.
    ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'].forEach((code, i) => { rows[0][1 + i * 5 + 1] = code; });
    ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'].forEach((code, i) => { rows[2][REV_BASE + 1 + i] = code; });
    rows[2][REV_BASE] = 'Date';
    // Day columns: the store blocks' bases and the reviews table's own.
    for (let d = 1; d <= days; d++) {
        const r = 3 + (d - 1);
        for (let i = 0; i < 5; i++) rows[r][1 + i * 5] = d;
        rows[r][REV_BASE] = opts.revDays === false ? '' : d;
    }
    // Footers below the grid carry numbers of their own — "Buying Days in Month
    // 26" — and they must not be mistaken for day rows.
    rows[4 + days][0] = 'Buying Days in Month';
    rows[4 + days][1] = 26;
    rows[4 + days + 1][0] = 'Days thru Month';
    rows[4 + days + 1][1] = 2;
    return rows;
};

const bases = { OVL: 1, LEE: 6, WSP: 11, MPL: 16, BAL: 21 };
const FIRST = 1;   // MR_BUY_FIRST_ROW

console.log('== It finds the reviews table, not a store block ==');
for (const days of [31, 30, 29, 28]) {
    const got = _mrReviewBase(buyTab(days), bases, FIRST, 40, MR_BUY_WIDTH);
    ok(got === REV_BASE, days + '-day tab: found column index ' + REV_BASE + ' (AE)', 'got ' + got);
}

console.log('== It cannot land on the buying data ==');
const got = _mrReviewBase(buyTab(30), bases, FIRST, 40, MR_BUY_WIDTH);
ok(got >= 26, 'never left of the last store block (index 26 = AA)', 'got ' + got);
ok(got !== 1 && got !== 6 && got !== 11 && got !== 16 && got !== 21,
   'and never on a store block base', 'got ' + got);
// The region it would write: base .. base+width-1
const end = Math.min(got + MR_REVIEW_WIDTH, 40);
ok(got > 21 + MR_BUY_WIDTH - 1, 'the write region starts past BAL', got + '..' + (end - 1));
ok(MR_REVIEW_WIDTH === 7, 'and is 7 columns wide (AE:AK)', String(MR_REVIEW_WIDTH));

console.log('== It refuses rather than guessing ==');
ok(_mrReviewBase(buyTab(30, { revDays: false }), bases, FIRST, 40, MR_BUY_WIDTH) === -1,
   'no day numbers in the reviews column -> -1, block left alone');
// A tab with nothing to the right of the blocks at all.
const narrow = buyTab(30).map(r => r.slice(0, 26));
ok(_mrReviewBase(narrow, bases, FIRST, 26, MR_BUY_WIDTH) === -1,
   'a tab without the block -> -1');

console.log('== The footer numbers do not extend a day grid ==');
// "Buying Days in Month 26" sits in a store block's own column. _mrDayRows only
// accepts a day that is exactly one more than the last, which is what stops 26
// from being read as day 26 all over again.
const t = buyTab(30);
const rowsFound = _mrDayRows(t, 1, FIRST);
ok(Object.keys(rowsFound).length === 30, 'a 30-day tab has exactly 30 day rows',
   String(Object.keys(rowsFound).length));
ok(rowsFound[30] === 3 + 29, 'day 30 is the last of them', 'row index ' + rowsFound[30]);

console.log('== What September actually looked like ==');
// Day 30's row was the one deleted, and with no renumber the column read
// 1..29 then 31 — which is why a reader that trusted it stopped at 29.
const sep = buyTab(30);
sep[3 + 29][REV_BASE] = 31;                 // the un-renumbered leftover
const sepRows = _mrDayRows(sep, REV_BASE, FIRST);
ok(sepRows[30] === undefined, 'no day 30 in the reviews column, as observed');
ok(Object.keys(sepRows).length === 29, 'the sequence stopped at 29',
   String(Object.keys(sepRows).length));
// The locator still finds the block — 1 and 2 are all it needs — so the
// renumber can repair it.
ok(_mrReviewBase(sep, bases, FIRST, 40, MR_BUY_WIDTH) === REV_BASE,
   'and the block is still found, so the renumber fixes it');

console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
