// _mrResetReviews and _mrSundayZeros, against a fake Buy tab shaped like the
// real Buy Oct 26 on 2026-10-05: September's review counts still in AF:AJ, the
// day column reading 1..29, 28, 30 (the 30->31 insert copies the day-28 row and
// nothing renumbered it), AK's TTL formula only on days 2-5, and every Sunday's
// Buy/Sell cell blank because the roll clears typed values and a 0 is one.
//
//   node google-apps-scripts/tests/mr-buy-repair-check.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'month-rollover.gs'), 'utf8').replace(/\r\n/g, '\n');
const grab = name => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
const konst = name => {
    const m = src.match(new RegExp('var ' + name + ' = ([^;]+);'));
    if (!m) throw new Error('missing var ' + name);
    return 'var ' + name + ' = ' + m[1] + ';\n';
};
eval(['MR_STORES', 'MR_BUY_WIDTH', 'MR_BUY_FIRST_ROW', 'MR_HEADER_ROWS', 'MR_REVIEW_WIDTH',
      'MR_BUY_SUNDAY_ZERO'].map(konst).join('')
   + ['_mrPad', '_mrDaysIn', '_mrSundays', '_mrBases', '_mrDayRows', '_mrReviewBase', '_mrColLetter',
      '_mrA1', '_mrIsBareNumberFormula', '_mrResetReviews', '_mrSundayZeros'].map(grab).join('\n'));

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

// ---- a fake Sheet over a values grid and a formulas grid ----
const fakeTab = (values, formulas) => {
    const writes = [];
    return {
        writes, values, formulas,
        getLastRow: () => values.length,
        getLastColumn: () => values[0].length,
        getRange: (r, c, nr, nc) => ({
            getValues: () => values.slice(r - 1, r - 1 + (nr || 1)).map(row => row.slice(c - 1, c - 1 + (nc || 1))),
            getFormulas: () => formulas.slice(r - 1, r - 1 + (nr || 1)).map(row => row.slice(c - 1, c - 1 + (nc || 1))),
            setValues: grid => grid.forEach((row, i) => row.forEach((v, j) => {
                const R = r - 1 + i, C = c - 1 + j;
                writes.push([R, C]);
                if (typeof v === 'string' && v[0] === '=') { formulas[R][C] = v; values[R][C] = '(f)'; }
                else { formulas[R][C] = ''; values[R][C] = v; }
            })),
            setValue: v => { writes.push([r - 1, c - 1]); values[r - 1][c - 1] = v; formulas[r - 1][c - 1] = ''; },
        }),
    };
};

// The real geometry: blocks of 5 from column A (OVL at A, day column A, Buy B,
// Sell C, D, week col E), header row 1, day 1 on row 4 (index 3), reviews AE:AK.
const REV = 30, DAY1 = 3, W = 37;
const buyOct = () => {
    const rows = 4 + 31 + 4;
    const v = [], f = [];
    for (let r = 0; r < rows; r++) { v.push(new Array(W).fill('')); f.push(new Array(W).fill('')); }
    ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'].forEach((s, i) => { v[0][i * 5 + 1] = s; v[2][REV + 1 + i] = s; });
    v[0][26] = 'TTL';
    v[2][REV] = 'Date'; v[2][REV + 6] = 'TTL';
    for (let d = 1; d <= 31; d++) {
        const r = DAY1 + d - 1;
        for (let i = 0; i < 5; i++) v[r][i * 5] = d;          // store grid: renumbered, correct
        // The company TTL block at Z has its own day column, broken the same way
        // (the live preview reported Z33 28->30). This is what the first locator
        // picked. AA:AD are formulas.
        v[r][25] = d <= 29 ? d : (d === 30 ? 28 : 31);
        for (let c = 26; c <= 29; c++) f[r][c] = '=SUM(B' + (r + 1) + ',G' + (r + 1) + ')';
        v[r][REV] = d <= 29 ? d : (d === 30 ? 28 : 30);       // reviews: 1..29, 28, 30
        // September's leftover counts, plus a real October figure on days 2-3.
        for (let i = 0; i < 5; i++) v[r][REV + 1 + i] = (d === 1) ? '' : d + i;
        // A weekday buy figure on day 2, so the zeros prove they never overwrite.
        if (d === 2) v[r][1] = 4170;
    }
    // AK's formula only survives on days 2-5, as in the screenshot.
    for (let d = 2; d <= 5; d++) {
        const n = DAY1 + d;
        f[DAY1 + d - 1][REV + 6] = `=IF(COUNT(AF${n}:AJ${n})=0,"",SUM(AF${n}:AJ${n}))`;
    }
    // A real formula in a Sunday Sell cell must be left alone.
    f[DAY1 + 11 - 1][2] = '=B14*2';
    // The footer: TTL row with MAX formulas, and labels whose numbers are not days.
    v[DAY1 + 31][0] = 'TTL';
    f[DAY1 + 31][REV + 1] = '=IFERROR(MAX(AF4:AF34),0)';
    v[DAY1 + 32][0] = 'Days thru Month'; v[DAY1 + 32][4] = 4;
    return fakeTab(v, f);
};

console.log('== reviews block, October 2026 as found ==');
let tab = buyOct();
let rv = _mrResetReviews(tab, 31, true);
ok(!rv.warn, 'found and accepted', rv.warn);
ok(rv.col === 'AE', 'at AE', rv.col);
ok(tab.writes.length === 0, 'the preview writes nothing', String(tab.writes.length));
ok(rv.relabelled.length === 2 && /AE33 28->30/.test(rv.relabelled[0]) && /AE34 30->31/.test(rv.relabelled[1]),
   'names the two broken day labels', rv.relabelled.join(' '));
ok(rv.ttl === 27, 'TTL formula missing on 27 of 31 rows', String(rv.ttl));
ok(rv.cleared === 30 * 5, 'every typed count would be cleared (days 2-31, five stores)', String(rv.cleared));

rv = _mrResetReviews(tab, 31, false);
const col = c => tab.values.slice(DAY1, DAY1 + 31).map(r => r[c]);
ok(col(REV).join(',') === Array.from({ length: 31 }, (_, i) => i + 1).join(','), 'day column now 1..31');
ok(col(REV + 1).every(x => x === ''), 'OVL counts all cleared');
ok(col(REV + 5).every(x => x === ''), 'BAL counts all cleared');
ok(tab.formulas[DAY1 + 6][REV + 6] === '=IF(COUNT(AF10:AJ10)=0,"",SUM(AF10:AJ10))',
   'AK10 (day 7) has the TTL formula, on its own row', tab.formulas[DAY1 + 6][REV + 6]);
ok(tab.formulas[DAY1 + 30][REV + 6] === '=IF(COUNT(AF34:AJ34)=0,"",SUM(AF34:AJ34))',
   'AK34 (day 31) too', tab.formulas[DAY1 + 30][REV + 6]);
ok(tab.formulas[DAY1 + 31][REV + 1] === '=IFERROR(MAX(AF4:AF34),0)', 'the footer row is untouched');
ok(tab.writes.every(([r, c]) => c >= REV && c < REV + 7 && r >= DAY1 && r < DAY1 + 31),
   'every write landed inside AE4:AK34');
ok(tab.values[DAY1 + 29][25] === 28 && tab.formulas[DAY1][26] === '=SUM(B4,G4)',
   'the company block at Z:AD is untouched');
const again = _mrResetReviews(tab, 31, true);
ok(again.relabelled.length === 0 && again.ttl === 0 && again.cleared === 0, 'a second run finds nothing to do');

console.log('== it refuses a block that does not line up ==');
tab = buyOct();
tab.values.splice(DAY1, 0, new Array(W).fill('')); tab.formulas.splice(DAY1, 0, new Array(W).fill(''));
for (let r = DAY1; r < DAY1 + 32; r++) { tab.values[r][REV] = tab.values[r + 1] ? tab.values[r + 1][REV] : ''; }
tab.values[DAY1][REV] = '';
// store grid now starts a row lower than the reviews day 1
for (let r = 0; r < tab.values.length; r++) for (let i = 0; i < 5; i++) {
    if (r === DAY1) tab.values[r][i * 5] = '';
}
rv = _mrResetReviews(tab, 31, false);
ok(!!rv.warn && tab.writes.length === 0, 'day 1 on different rows -> left alone, nothing written', rv.warn);
tab = buyOct();
rv = _mrResetReviews(tab, 30, false);
ok(!!rv.warn && tab.writes.length === 0, 'wrong day count -> left alone', rv.warn);

console.log('== Sunday zeros, October 2026 ==');
ok(_mrSundays('2026-10').join(',') === '4,11,18,25', 'October Sundays are 4, 11, 18, 25');
tab = buyOct();
let z = _mrSundayZeros(tab, '2026-10', true);
ok(z.written.length === 4 * 5 * 2 - 1, '39 cells planned (one Sunday Sell is a formula)', String(z.written.length));
ok(tab.writes.length === 0, 'the preview writes nothing');
z = _mrSundayZeros(tab, '2026-10', false);
const cell = (d, c) => tab.values[DAY1 + d - 1][c];
ok(cell(4, 1) === 0 && cell(4, 2) === 0, 'OVL B7/C7 (Sun 4th) = 0');
ok(cell(25, 21) === 0 && cell(25, 22) === 0, 'BAL Sun 25th = 0');
ok(tab.formulas[DAY1 + 10][2] === '=B14*2', 'a real formula on a Sunday is left in place');
ok(cell(2, 1) === 4170, 'a weekday figure is untouched');
ok(cell(3, 1) === '', 'a blank weekday stays blank — only Sundays are zeroed');
ok(cell(4, 3) === '' && cell(4, 4) === '', 'columns other than Buy/Sell are not touched');
z = _mrSundayZeros(tab, '2026-10', false);
ok(z.written.length === 0 && z.kept === 39, 'a second run writes nothing and keeps all 39', z.kept + ' kept');
tab.values[DAY1 + 3][6] = 512;                             // LEE keyed a real Sunday figure
const t2 = buyOct(); t2.values[DAY1 + 3][6] = 512;
_mrSundayZeros(t2, '2026-10', false);
ok(t2.values[DAY1 + 3][6] === 512, 'a figure already keyed on a Sunday is never overwritten');

console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
