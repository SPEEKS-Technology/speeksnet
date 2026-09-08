// THE MILEAGE EMAIL IS AN IRS RECORD, and it was filing two of the three fields.
//
// ⚠️ WHAT WENT WRONG. The route was built as a FALLBACK — `e.description || trip`
// — so on every row that carried a description, and they all do, where the trip
// started and ended never printed at all. A mileage log needs the date, the
// business purpose AND the destination. Ethan, 2026-09-04: "it doesn't show the
// fields to and from and it needs to for IRS reporting."
//
// The second bug in the same line: _expPad cuts at the character, so "Dropping
// stuff off at LEE for event and new hire" was sent as "...for eve". A reader
// cannot tell a truncation from a typo in a document somebody is paid from.
//
// Fixtures are Ethan's real August 2026 rows, as shown in the tool.
//
// Run: node scripts/expense-email-check.js [--print]
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'speeks.js');

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

// --- lift the composer out of the shipped file -------------------------------
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const between = (from, to) => {
    const i = src.indexOf(from), j = src.indexOf(to, i);
    if (i < 0 || j < 0) throw new Error('could not slice ' + from.slice(0, 40));
    return src.slice(i, j);
};
const block = [
    between('function _expPad(s, n) {', '\n\nfunction _expCompose'),
    between('function _expCompose() {', '\n\nfunction _expPreviewHtml'),
].join('\n\n');

// The composer reads module state and a handful of tiny formatters; supply them
// rather than lifting half the file.
const HARNESS = `
    var _expMonth = '2026-08';
    var _expPerson = 'Ethan Kushnir';
    var _EXP_FALLBACK_TO = ['ethan.kushnir@speekstechnology.com'];
    function _expMonthLabel() { return 'August 2026'; }
    function _recipientsFor() { return _EXP_FALLBACK_TO; }
    function _expReportTo() { return _recipientsFor(); }
    function _expDate(d) { const [y, m, dd] = String(d).split('-'); return m + '/' + dd + '/' + y; }
    function _expMoney(n) { return '$' + (Number(n) || 0).toFixed(2); }
    function _expRate(r) { return (Number(r) || 0).toFixed(2); }
    function _expRows(kind) { return ROWS.filter(r => r.kind === kind); }
    function _expTotal(kind) { return _expRows(kind).reduce((a, r) => a + (Number(r.amount) || 0), 0); }
`;

// ⚠️ REAL ROWS. The 08/17 pair is the one that was being cut mid-word, and the
// two STL trips are the ones whose route the IRS needs and the email dropped.
const ROWS = [
    { kind: 'mileage', entry_date: '2026-08-05', description: 'STL Visit',
      from_loc: 'Home', to_loc: 'BAL', miles: 238, rate: 0.72, amount: 171.36 },
    { kind: 'mileage', entry_date: '2026-08-06', description: 'STL Visit',
      from_loc: 'MPL', to_loc: 'Home', miles: 246, rate: 0.72, amount: 177.12 },
    { kind: 'mileage', entry_date: '2026-08-17', description: 'Dropping stuff off at LEE for event and new hire',
      from_loc: 'OVL', to_loc: 'LEE', miles: 22, rate: 0.72, amount: 15.84 },
    { kind: 'mileage', entry_date: '2026-08-17', description: 'Dropping stuff off at LEE for event and new hire',
      from_loc: 'LEE', to_loc: 'OVL', miles: 22, rate: 0.72, amount: 15.84 },
];

let compose;
try {
    compose = new Function('ROWS', HARNESS + block + '\nreturn _expCompose;')(ROWS);
} catch (e) {
    console.error('could not lift the composer:\n' + e.message);
    process.exit(1);
}
const out = compose();
const body = out.body;
const lines = body.split('\n');

console.log('\n== The route is in the email at all ==');
{
    // ⚠️ THE WHOLE BUG. Every one of these was absent before, because the route
    // only rendered when the description was empty.
    ok(/Home to BAL/.test(body), 'the first trip names where it went', 'Home to BAL');
    ok(/MPL to Home/.test(body), 'and the return leg names its own route');
    ok(/OVL to LEE/.test(body) && /LEE to OVL/.test(body),
       'the two 08/17 legs are told apart by their routes');
    // Two rows, same date, same purpose, same mileage — the ROUTE is the only
    // thing that distinguishes them, which is exactly why it has to print.
    const legs = lines.filter(l => /08\/17\/2026/.test(l));
    ok(legs.length === 2, 'both 08/17 legs are listed', String(legs.length));
    ok(legs[0] !== legs[1], 'and they are not identical lines any more');
}

console.log('\n== The purpose is not chopped mid-word ==');
{
    ok(!/for eve\b/.test(body), 'no "for eve"');
    ok(!/for even\b/.test(body), 'and no "for even"');
    const cut = lines.find(l => /Dropping/.test(l)) || '';
    ok(/…/.test(cut), 'a purpose too long to fit is marked as shortened', cut.trim().slice(0, 60));
    // Ending on a whole word is the difference between a truncation a reader
    // recognises and one that looks like a typo.
    const shown = (cut.match(/Dropping[^…]*/) || [''])[0].trim();
    ok(!/\s\S{1,2}$/.test(shown), 'and it ends on a whole word', JSON.stringify(shown));
}

console.log('\n== It still adds up, and still lines up ==');
{
    ok(/528 mi/.test(body), 'the mileage total is unchanged');
    ok(/TOTAL DUE: \$380\.16/.test(body), 'the money total is unchanged');
    // Every row and the Total must put their figures in the same columns, or
    // the report reads as three different tables.
    // ⚠️ THE RIGHT EDGE, NOT THE '$'. The amounts are right-aligned, so the
    // dollar sign of $15.84 sits a character further right than the one in
    // $171.36 — measuring the symbol says "misaligned" about a column that is
    // perfectly aligned. (And lastIndexOf('$') can find the RATE's dollar sign.)
    const money = lines.filter(l => /\$\d/.test(l) && !/TOTAL DUE/.test(l))
                       .map(l => l.replace(/\s+$/, '').length);
    ok(new Set(money).size === 1, 'every amount ends in the same column',
       [...new Set(money)].join(','));
    const mi = lines.filter(l => / mi\s*(\$|$)/.test(l)).map(l => l.indexOf(' mi'));
    ok(new Set(mi).size === 1, 'and every mileage figure does too', [...new Set(mi)].join(','));
    ok(lines.every(l => l.length <= 96), 'no line is too wide to read in an email client',
       'longest ' + Math.max(...lines.map(l => l.length)));
}

console.log('\n== The header says what the columns are ==');
{
    const h = lines.find(l => /FROM \/ TO/.test(l)) || '';
    ok(!!h, 'the mileage table is headed');
    ok(/DATE/.test(h) && /PURPOSE/.test(h) && /MILES/.test(h) && /AMOUNT/.test(h),
       'and names every column', h.trim().replace(/\s+/g, ' '));
    const first = lines.findIndex(l => /08\/05\/2026/.test(l));
    ok(lines.indexOf(h) < first, 'and sits above the rows');
}

if (process.argv.indexOf('--print') > -1) {
    console.log('\n' + '-'.repeat(78) + '\nTHE EMAIL\n' + '-'.repeat(78));
    console.log('To: ' + out.email + '\nSubject: ' + out.subject + '\n\n' + body);
}

console.log('\n' + (fails ? fails + ' FAILED' : 'all passed') + '\n');
process.exit(fails ? 1 : 0);
