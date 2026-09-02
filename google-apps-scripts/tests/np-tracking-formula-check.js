// The three projection formulas, generated rather than typed.
//
// Measured by npTtlRowProbe on 2026-09-02. Every store block agrees, on 29-30
// of its 31 day rows, on one shape per column:
//
//   OVL  D  =IF(ISBLANK(B#),"",(C#/A#)*C$42)      Rev Tracking
//   OVL  H  =IF(ISBLANK(B#),"",(G#/A#)*C$42)      GP Tracking
//   OVL  O  =IF(ISBLANK(B#),"",(N#/A#)*C$42)      NP Tracking
//
// The exceptions are what this fix is for, and every one of them is right BY
// ACCIDENT on the row it sits on:
//   * row 5 divides by the literal 1 — identical to /A5 only because A5 is 1
//   * row 6 divides by the literal 2, in four blocks
//   * row 5 reads F (that day's GP) where the column reads G (cumulative) —
//     the same number on day 1 and only on day 1
//   * row 5 multiplies by a RELATIVE C42, which walks to C43 (Days Thru) the
//     moment anyone fills it down
//   * the TTL block's NP Tracking divides by the literal 1 on ALL 31 ROWS and
//     reads CY (that day's NP) instead of CZ (cumulative). That one is not
//     right by accident past day 1, and it is the company % of NP Goal.
//
// These assertions are the reference. If _npTrackFormula ever stops reproducing
// the majority shape of a column that is already correct, this fails — which is
// the only cheap way to know that a "fix" is not quietly rewriting 186 working
// financial formulas into something else.
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
const DAYS_THIS = 42, DAYS_THRU = 43, TTL_ROW = 36;
const day = (store, name, row) =>
    _npTrackFormula(store === 'TTL' ? NP_TTL_BASE : NP_BASES[store], spec(name), row, DAYS_THIS, 0);
const ttl = (store, name) =>
    _npTrackFormula(store === 'TTL' ? NP_TTL_BASE : NP_BASES[store], spec(name), TTL_ROW,
                    DAYS_THIS, DAYS_THRU);

console.log('== It reproduces the shape the tab already agrees on ==');
// Verbatim from the probe, with # resolved to row 20 — a row far from both ends
// so nothing can be right by accident.
const EXPECTED = [
    ['OVL', 'Rev Tracking', '=IF(ISBLANK(B20),"",(C20/A20)*C$42)'],
    ['OVL', 'GP Tracking',  '=IF(ISBLANK(B20),"",(G20/A20)*C$42)'],
    ['OVL', 'NP Tracking',  '=IF(ISBLANK(B20),"",(N20/A20)*C$42)'],
    ['LEE', 'Rev Tracking', '=IF(ISBLANK(T20),"",(U20/S20)*U$42)'],
    ['LEE', 'GP Tracking',  '=IF(ISBLANK(T20),"",(Y20/S20)*U$42)'],
    ['LEE', 'NP Tracking',  '=IF(ISBLANK(T20),"",(AF20/S20)*U$42)'],
    ['WSP', 'Rev Tracking', '=IF(ISBLANK(AL20),"",(AM20/AK20)*AM$42)'],
    ['WSP', 'GP Tracking',  '=IF(ISBLANK(AL20),"",(AQ20/AK20)*AM$42)'],
    ['WSP', 'NP Tracking',  '=IF(ISBLANK(AL20),"",(AX20/AK20)*AM$42)'],
    ['MPL', 'Rev Tracking', '=IF(ISBLANK(BD20),"",(BE20/BC20)*BE$42)'],
    ['MPL', 'GP Tracking',  '=IF(ISBLANK(BD20),"",(BI20/BC20)*BE$42)'],
    ['MPL', 'NP Tracking',  '=IF(ISBLANK(BD20),"",(BP20/BC20)*BE$42)'],
    ['BAL', 'Rev Tracking', '=IF(ISBLANK(BV20),"",(BW20/BU20)*BW$42)'],
    ['BAL', 'GP Tracking',  '=IF(ISBLANK(BV20),"",(CA20/BU20)*BW$42)'],
    ['BAL', 'NP Tracking',  '=IF(ISBLANK(BV20),"",(CH20/BU20)*BW$42)']
];
EXPECTED.forEach(([store, name, want]) => {
    const got = day(store, name, 20);
    ok(got === want, store + ' ' + name, got === want ? undefined : 'want ' + want + '\n        got  ' + got);
});

console.log('== The TTL block, which is where the fault is ==');
{
    // The company Rev Tracking already matches, except for its guard column.
    ok(day('TTL', 'Rev Tracking', 20) === '=IF(ISBLANK(CN20),"",(CO20/CM20)*CO$42)',
       'Rev Tracking now guards on CN — its OWN sales — not on B, which is OVL\'s',
       day('TTL', 'Rev Tracking', 20));
    ok(day('TTL', 'GP Tracking', 20) === '=IF(ISBLANK(CN20),"",(CS20/CM20)*CO$42)',
       'GP Tracking likewise', day('TTL', 'GP Tracking', 20));
    // The one that was actually broken on every row.
    const got = day('TTL', 'NP Tracking', 20);
    ok(got === '=IF(ISBLANK(CN20),"",(CZ20/CM20)*CO$42)',
       'NP Tracking divides by the DAY NUMBER and reads the CUMULATIVE column', got);
    ok(!/\/1\)/.test(got), 'and no longer by the literal 1', got);
    ok(/CZ20/.test(got) && !/CY20/.test(got),
       'CZ (NP Total) not CY (that day\'s NP) — the two agree only on day 1', got);
}

console.log('== Day 1 proves the old shape was right only by accident ==');
{
    // (C5/1)*C42 and (C5/A5)*C$42 return the same number, because A5 is 1. The
    // generated form is the one that survives being filled down.
    ok(day('OVL', 'Rev Tracking', 5) === '=IF(ISBLANK(B5),"",(C5/A5)*C$42)',
       'row 5 divides by A5, not by a literal 1', day('OVL', 'Rev Tracking', 5));
    ok(/C\$42/.test(day('OVL', 'Rev Tracking', 5)),
       'and multiplies by an ABSOLUTE C$42 — a relative C42 walks to Days Thru');
}

console.log('== The TTL ROW, which never had these at all ==');
{
    ok(ttl('OVL', 'Rev Tracking') === '=IF(ISBLANK(B36),"",(B36/C$43)*C$42)',
       'OVL: the month\'s Sales over Days Thru, times days in month', ttl('OVL', 'Rev Tracking'));
    ok(ttl('OVL', 'GP Tracking') === '=IF(ISBLANK(B36),"",(F36/C$43)*C$42)',
       'GP Tracking uses F — GP — because GP Total is empty on that row',
       ttl('OVL', 'GP Tracking'));
    ok(ttl('OVL', 'NP Tracking') === '=IF(ISBLANK(B36),"",(M36/C$43)*C$42)',
       'NP Tracking uses M — NP — for the same reason', ttl('OVL', 'NP Tracking'));
    ok(ttl('BAL', 'NP Tracking') === '=IF(ISBLANK(BV36),"",(CG36/BW$43)*BW$42)',
       'and the same shape lands on BAL\'s columns', ttl('BAL', 'NP Tracking'));
    // The whole reason the TTL row needs a different divisor.
    NP_TRACKING.forEach(sp => {
        const f = ttl('OVL', sp.name);
        ok(!/\/A36/.test(f), sp.name + ': never divides by A36, which reads "TTL"', f);
        ok(/C\$43/.test(f), sp.name + ': divides by Days Thru at C$43');
    });
}

console.log('== Both divisors are absolute, in every generated cell ==');
{
    // A relative divisor is exactly how the tab drifted in the first place.
    let bad = [];
    ['OVL', 'LEE', 'WSP', 'MPL', 'BAL', 'TTL'].forEach(st => {
        NP_TRACKING.forEach(sp => {
            [day(st, sp.name, 5), day(st, sp.name, 35), ttl(st, sp.name)].forEach(f => {
                // Every reference to the days rows must carry a $.
                if (/[A-Z](42|43)\)/.test(f.replace(/\$(42|43)/g, '#'))) bad.push(st + ' ' + sp.name + ': ' + f);
            });
        });
    });
    ok(bad.length === 0, 'no relative reference to row 42 or 43 anywhere', bad.join('\n        '));
}

console.log('== The day-row form never mentions the days-thru row ==');
{
    // Mixing them would project the month off the wrong divisor twice.
    let bad = [];
    ['OVL', 'LEE', 'WSP', 'MPL', 'BAL', 'TTL'].forEach(st => {
        NP_TRACKING.forEach(sp => {
            const f = day(st, sp.name, 12);
            if (f.indexOf('$43') >= 0) bad.push(st + ' ' + sp.name + ': ' + f);
        });
    });
    ok(bad.length === 0, 'a day row divides by its own day number only', bad.join('\n        '));
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
