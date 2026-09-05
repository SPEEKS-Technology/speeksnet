// The three projection formulas, generated rather than typed.
//
// Measured by npTtlRowProbe on 2026-09-02. Every store block agrees, on 29-30
// of its 31 day rows, on one shape per column:
//
//   OVL  D  =IF(ISBLANK(B#),"",(C#/A#)*C$42)      Rev Tracking
//   OVL  H  =IF(ISBLANK(B#),"",(G#/A#)*C$42)      GP Tracking
//   OVL  O  =IF(ISBLANK(B#),"",(N#/A#)*C$42)      NP Tracking
//
// The exceptions are what the fix is for, and every one is right BY ACCIDENT on
// the row it sits on: row 5 divides by a literal 1, row 6 by a literal 2 in four
// blocks, row 5 reads GP where the column reads GP Total, and row 5 multiplies
// by a RELATIVE C42 that walks to C43 — Days Thru — one row down. The TTL
// block's NP Tracking divides by the literal 1 on ALL 31 rows and reads CY,
// that day's NP, instead of the cumulative — and that one is not right past
// day 1.
//
// ⚠️ AND THEN THE FIX ITSELF SHIPPED A BUG, WHICH IS WHY THE GUARD IS PINNED
// HERE. Rewriting the guard as ISBLANK(CN#) — the TTL block's own sales column,
// which is more correct than the OVL column it had — broke it, because
// ISBLANK IS FALSE FOR A CELL HOLDING A FORMULA THAT RETURNS "". The stores'
// Sales columns are written values so ISBLANK worked; the TTL block's Sales is
// =IF(ISBLANK(B5),"",T5+B5+AL5), a formula, so the guard never fired and the
// company's tracking computed on all 31 rows. Every consumer reads the LAST
// NON-EMPTY cell of the day range, so it read row 35 — day 31's fully decayed
// projection, 6,135.15 x 30 / 31 = 5,937.24 — over a 284,400 goal, and printed
// 2.1% where the truth was 64.7%.
//
// The guard is now  x=""  which is true for an empty cell AND for a formula
// returning "". A real zero is unaffected: 0="" is FALSE in Sheets.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'netprofit-sheet.gs'), 'utf8')
    .replace(/\r\n/g, '\n');
const grab = name => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
const constOf = name => {
    const m = src.match(new RegExp('var ' + name + '\\s*=\\s*([^;]*);'));
    if (!m) throw new Error('constant not found: ' + name);
    return '(' + m[1] + ')';
};
global.NP_BASES      = eval(constOf('NP_BASES'));
global.NP_TTL_BASE   = eval(constOf('NP_TTL_BASE'));
global.NP_OFF_SALES  = eval(constOf('NP_OFF_SALES'));
global.NP_TRACKING   = eval((src.match(/var NP_TRACKING = (\[[\s\S]*?\]);/) || [])[1]);
eval(grab('_npColLetter'));
eval(grab('_npTrackFormula'));

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '\n        ' + g));
    if (!c) fails++;
};
const spec = name => {
    const s = NP_TRACKING.filter(x => x.name === name)[0];
    if (!s) throw new Error('no spec named ' + name);
    return s;
};
const baseOf = st => (st === 'TTL' ? NP_TTL_BASE : NP_BASES[st]);
const DAYS_THIS = 42, DAYS_THRU = 43, TTL_ROW = 36;
const ALL = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL', 'TTL'];
const day = (st, name, row) => _npTrackFormula(baseOf(st), spec(name), row, DAYS_THIS, 0);
const ttl = (st, name) => _npTrackFormula(baseOf(st), spec(name), TTL_ROW, DAYS_THIS, DAYS_THRU);

console.log('== It reproduces the shape the tab already agrees on ==');
// Verbatim from the probe, with # resolved to row 20 — far from both ends, so
// nothing can be right by accident — and the guard in its corrected form.
const EXPECTED = [
    ['OVL', 'Rev Tracking', '=IF(B20="","",(C20/A20)*C$42)'],
    ['OVL', 'GP Tracking',  '=IF(B20="","",(G20/A20)*C$42)'],
    ['OVL', 'NP Tracking',  '=IF(B20="","",(N20/A20)*C$42)'],
    ['LEE', 'Rev Tracking', '=IF(T20="","",(U20/S20)*U$42)'],
    ['LEE', 'GP Tracking',  '=IF(T20="","",(Y20/S20)*U$42)'],
    ['LEE', 'NP Tracking',  '=IF(T20="","",(AF20/S20)*U$42)'],
    ['WSP', 'Rev Tracking', '=IF(AL20="","",(AM20/AK20)*AM$42)'],
    ['WSP', 'GP Tracking',  '=IF(AL20="","",(AQ20/AK20)*AM$42)'],
    ['WSP', 'NP Tracking',  '=IF(AL20="","",(AX20/AK20)*AM$42)'],
    ['MPL', 'Rev Tracking', '=IF(BD20="","",(BE20/BC20)*BE$42)'],
    ['MPL', 'GP Tracking',  '=IF(BD20="","",(BI20/BC20)*BE$42)'],
    ['MPL', 'NP Tracking',  '=IF(BD20="","",(BP20/BC20)*BE$42)'],
    ['BAL', 'Rev Tracking', '=IF(BV20="","",(BW20/BU20)*BW$42)'],
    ['BAL', 'GP Tracking',  '=IF(BV20="","",(CA20/BU20)*BW$42)'],
    ['BAL', 'NP Tracking',  '=IF(BV20="","",(CH20/BU20)*BW$42)']
];
EXPECTED.forEach(([store, name, want]) => {
    const got = day(store, name, 20);
    ok(got === want, store + ' ' + name,
       got === want ? undefined : 'want ' + want + '\n        got  ' + got);
});

console.log('== The guard, which is the whole reason this file exists ==');
{
    // ⚠️ ISBLANK ANYWHERE IN A DAY-ROW FORMULA IS THE 2.1% BUG COMING BACK.
    let isblank = [];
    ALL.forEach(st => NP_TRACKING.forEach(sp => {
        if (day(st, sp.name, 20).indexOf('ISBLANK') >= 0) isblank.push(st + ' ' + sp.name);
    }));
    ok(isblank.length === 0,
       'no day-row formula uses ISBLANK — it is FALSE for a formula returning ""',
       isblank.join(', '));

    // The TTL block is the block that proved it, so it is asserted by name.
    ok(day('TTL', 'NP Tracking', 20) === '=IF(CN20="","",(CZ20/CM20)*CO$42)',
       'the company NP Tracking guards on CN="" and reads the CUMULATIVE column',
       day('TTL', 'NP Tracking', 20));
    ok(day('TTL', 'Rev Tracking', 20) === '=IF(CN20="","",(CO20/CM20)*CO$42)',
       'and so does Rev Tracking', day('TTL', 'Rev Tracking', 20));
    ok(day('TTL', 'GP Tracking', 20) === '=IF(CN20="","",(CS20/CM20)*CO$42)',
       'and GP Tracking', day('TTL', 'GP Tracking', 20));

    const np = day('TTL', 'NP Tracking', 20);
    ok(!/\/1\)/.test(np), 'never divides by the literal 1', np);
    ok(/CZ20/.test(np) && !/CY20/.test(np),
       'CZ (NP Total), not CY (that day\'s NP) — the two agree only on day 1', np);
}

console.log('== Day 1 proves the old shape was right only by accident ==');
{
    ok(day('OVL', 'Rev Tracking', 5) === '=IF(B5="","",(C5/A5)*C$42)',
       'row 5 divides by A5, not by a literal 1', day('OVL', 'Rev Tracking', 5));
    ok(/C\$42/.test(day('OVL', 'Rev Tracking', 5)),
       'and multiplies by an ABSOLUTE C$42 — a relative C42 walks to Days Thru');
}

console.log('== The TTL ROW takes IFERROR, not a guard ==');
{
    // Its Sales cell is a SUM, which returns 0 rather than "" for an empty
    // month, so no ="" test can blank it. What actually fails on the 1st is the
    // division: Days Thru is 0. IFERROR blanks exactly that and nothing else.
    ok(ttl('OVL', 'Rev Tracking') === '=IFERROR((B36/C$43)*C$42,"")',
       'OVL: the month\'s Sales over Days Thru, times days in month',
       ttl('OVL', 'Rev Tracking'));
    ok(ttl('OVL', 'GP Tracking') === '=IFERROR((F36/C$43)*C$42,"")',
       'GP Tracking uses F — GP — because GP Total is empty on that row',
       ttl('OVL', 'GP Tracking'));
    ok(ttl('OVL', 'NP Tracking') === '=IFERROR((M36/C$43)*C$42,"")',
       'NP Tracking uses M — NP — for the same reason', ttl('OVL', 'NP Tracking'));
    ok(ttl('BAL', 'NP Tracking') === '=IFERROR((CG36/BW$43)*BW$42,"")',
       'and the same shape lands on BAL\'s columns', ttl('BAL', 'NP Tracking'));
    ok(ttl('TTL', 'NP Tracking') === '=IFERROR((CY36/CO$43)*CO$42,"")',
       'and on the company block', ttl('TTL', 'NP Tracking'));

    let bad = [];
    ALL.forEach(st => NP_TRACKING.forEach(sp => {
        const f = ttl(st, sp.name);
        if (f.indexOf('IFERROR') !== 1) bad.push(st + ' ' + sp.name + ': ' + f);
        // Its own day cell reads "TTL", so dividing by it would be #VALUE!.
        if (new RegExp('/' + _npColLetter(baseOf(st)) + TTL_ROW).test(f)) {
            bad.push(st + ' ' + sp.name + ' divides by the TTL day cell: ' + f);
        }
    }));
    ok(bad.length === 0, 'every TTL-row cell is IFERROR-wrapped and none divides by "TTL"',
       bad.join('\n        '));
}

console.log('== Divisors are absolute, and the two rows never mix ==');
{
    // A relative divisor is how the tab drifted in the first place, and a day
    // row that reached for Days Thru would project off the wrong divisor twice.
    let bad = [];
    ALL.forEach(st => NP_TRACKING.forEach(sp => {
        [day(st, sp.name, 5), day(st, sp.name, 35), ttl(st, sp.name)].forEach(f => {
            if (/[A-Z](42|43)\)/.test(f.replace(/\$(42|43)/g, '#'))) {
                bad.push(st + ' ' + sp.name + ': ' + f);
            }
        });
        if (day(st, sp.name, 12).indexOf('$43') >= 0) {
            bad.push(st + ' ' + sp.name + ' (day row reaches for Days Thru)');
        }
    }));
    ok(bad.length === 0, 'no relative reference to row 42 or 43, and no day row uses $43',
       bad.join('\n        '));
}

console.log('== A hand run always writes shipping ==');
{
    // NP_SKIP_SHIP is a global and one Apps Script project is one global scope
    // that survives between executions, so an 8am pass leaves it TRUE. A manual
    // npWriteApply would then skip the one column somebody ran it to fill.
    const m = src.match(/function npWriteApply\(\)\s*\{([^}]*)\}/);
    ok(!!m && /NP_SKIP_SHIP\s*=\s*false/.test(m[1]),
       'npWriteApply resets NP_SKIP_SHIP before writing', m && m[1].trim());
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
