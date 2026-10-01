// "THE LISTING GETS THE LAST WORD ON ITS OWN IDENTITY."
//
// The name check judges "against outside product knowledge, not against your own
// listing" — by design, because that is the only way to catch a name that is
// wrong in every field at once. But it was never shown the listing's own fields,
// so it confidently proposed overwriting them. The first three denials anyone
// bothered to write a note about were all this same bug:
//
//   MPN = T43WD-40      → "not a real product name, it means T34w-40"
//   Platform = Xbox One → "there is no Xbox One release, use Xbox 360"
//   Type = microSD Card → "the part number says Portable SSD"
//
// ⚠️ AND APPROVING WOULD HAVE MADE IT WORSE. name-wrong is in CORRECTING_CODES,
// so the fix rewrites the spec fields that "still state something false" — it
// would have overwritten the very MPN and Platform that were right, inside the
// description a customer reads.
//
// ⚠️ DOWNGRADED, NOT SUPPRESSED, and section 3 is the reason. Going quiet
// whenever the listing agrees with itself would lose the Sony a7 IV mangled to
// "OX 7 IV" — the case where a lister typed one error into every field, which is
// the single most valuable thing this check has ever caught.
//
// What it asserts:
//    1. all three real denials now raise name-disputed, not name-wrong/garbled
//    2. and nothing is proposed: no suggested title, never fixable
//    3. a garbled name the listing does NOT vouch for still gets corrected
//    4. only IDENTITY fields can veto — Color or Screen Size cannot
//    5. the wording tells the reviewer what to do with both outcomes
//
// Run: node scripts/listing-titles-name-dispute-check.js
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'supabase', 'functions', 'listing-titles', 'index.ts');

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const between = (from, to) => {
    const i = src.indexOf(from), j = src.indexOf(to, i);
    if (i < 0 || j < 0) throw new Error('could not slice ' + from.slice(0, 40));
    return src.slice(i, j);
};

// ⚠️ THE DECISION, LIFTED WHOLE. analyse() is 400 lines and needs a Shopify row,
// so what is lifted is the block that decides WHICH finding to raise, wrapped in
// a function taking the same names it reads. Anything less and the harness would
// be testing a paraphrase of the rule rather than the rule.
const strip = s => s
    .replace(/:\s*Record<[^>]*>(\s*\|\s*undefined)?/g, '')
    // changedSpan / typoDistance / isMisspelling / listingSaysItself's cover
    .replace(/\)\s*:\s*(number|boolean|\[number,\s*number\])\s*\{/g, ') {')
    .replace(/(\w)\??\s*:\s*\[number,\s*number\]/g, '$1')
    .replace(/:\s*number\[\]\[\]/g, '')
    .replace(/(\w+)\s*:\s*number\b(?=\s*[,)])/g, '$1')
    .replace(/([(,]\s*)(\w+)\s*:\s*string\[\]/g, '$1$2')
    .replace(/\(\s*(\w+)\s*:\s*string\s*\)/g, '($1)')
    .replace(/\(\s*(\w+)\s*:\s*string\s*,/g, '($1,')
    .replace(/,\s*(\w+)\s*:\s*string\s*\)/g, ', $1)');

const helpers = strip([
    between('const decodeEnt = ', '\n\n'),
    between('const norm = ', '\n\n'),
    between('const tokens = ', '\n\n'),
    between('const IDENTITY_FIELDS = [', '\n\ntype NameVerdict'),
    between('function listingSaysItself', '\n\n// How many notes nobody has carried'),
].join('\n\n'));

// ⚠️ SLICED SHORT ON PURPOSE, so the closing brace is added here. The slice ends
// before the "Quote not found" comment, which sits INSIDE the outer `if` — so
// the outer brace is still open at that point and the harness closes it.
const decision = strip(between(
    '  if (nameVerdict && nameVerdict.verdict !== "ok") {',
    '\n    // Quote not found in the title')) + '\n}';

let decide;
try {
    decide = new Function('nameVerdict', 'title', 'extra',
        'var EBAY_TITLE_MAX = 80;\n' + helpers
        + '\nvar findings = [], fixable = false;\n' + decision
        + '\nreturn { findings: findings, title: title, fixable: fixable };');
} catch (e) {
    console.error('could not lift the decision:\n' + e.message);
    console.error('\n--- decision block ---\n' + decision.slice(0, 900));
    process.exit(1);
}

const run = (title, verdict, specs) =>
    decide(verdict, title, { specs: specs || {} });

// --- the three real denials, with the fields ?peek= actually returned ---------
console.log('\n== 1. The three notes people wrote ==');
const CASES = [
    { what: 'Lenovo monitor',
      title: 'Lenovo 34" T43WD-40 WQHD VA Business Monitor',
      v: { verdict: 'garbled', wrong_text: 'T43WD-40', correct_text: 'T34w-40',
           why: 'Lenovo model numbers encode panel size; a 34" is a T34w' },
      specs: { Brand: 'Lenovo', MPN: 'T43WD-40', Type: 'Business Monitor',
               'Screen Size': '34"' },
      field: 'MPN' },
    { what: 'Black Ops II',
      title: 'Call of Duty: Black Ops II (Microsoft Xbox One, 2018)',
      v: { verdict: 'wrong', wrong_text: 'Microsoft Xbox One',
           correct_text: 'Microsoft Xbox 360',
           why: 'Black Ops II released on Xbox 360 in 2012' },
      specs: { Platform: 'Microsoft Xbox One', 'Release Year': '2018' },
      field: 'Platform' },
    { what: 'SanDisk',
      title: 'SanDisk Extreme 2TB 30MB/s V30 microSD Card 4K SDSSDE61-2T00-G25',
      v: { verdict: 'wrong', wrong_text: 'microSD Card', correct_text: 'Portable SSD',
           why: 'Part number SDSSDE61-2T00-G25 is a SanDisk Extreme Portable SSD' },
      specs: { Brand: 'SanDisk', Model: 'Extreme', MPN: 'SDSSDE61-2T00-G25',
               Type: 'microSD Card' },
      field: 'Type' },
    // ⚠️ MPL's Rokinon, denied 2026-09-04: "This is a 2.2 lens. Shown in the
    // pictures". The same bug on a field IDENTITY_FIELDS had not reached.
    //
    // Worth keeping because our knowledge was RIGHT about the lens everyone
    // knows — the 16mm ED AS UMC CS is f/2.0 — and still lost. Samyang/Rokinon
    // sell the CINE version of that optic marked T2.2, so 2.2 on the barrel is
    // a real marking on a real variant. A check that cannot be wrong about a
    // famous product is a check that has not met the second version of it.
    { what: 'Rokinon lens',
      title: 'Rokinon AS UMC CS 16mm f/2.2 EF For Canon EF Mount Manual Lens',
      v: { verdict: 'wrong', wrong_text: 'f/2.2', correct_text: 'f/2.0',
           why: 'The Rokinon 16mm ED AS UMC CS lens is f/2.0' },
      specs: { Brand: 'Rokinon', Model: 'AS UMC CS', Collection: 'Camera Lens',
               'Maximum Aperture': 'f/2.2' },
      field: 'Maximum Aperture' },
    // ⚠️ OVL Dell Precision 5520, denied 2026-09-28: "Suggesting a different
    // processor, this is incorrect." Photo 3 is Windows reporting the 6820HQ;
    // the bottom plate says Precision 5520. Our "the 5520 is Kaby Lake" was wrong.
    { what: 'Dell Precision 5520',
      title: 'Dell Precision 5520 15.6" i7-6820HQ 2.7GHz 32GB RAM 512GB SSD Quadro M1200',
      v: { verdict: 'wrong', wrong_text: 'i7-6820HQ 2.7GHz', correct_text: 'i7-7820HQ 2.9GHz',
           why: 'The Precision 5520 shipped with 7th-gen Kaby Lake CPUs, not the 6820HQ' },
      specs: { Brand: 'Dell', Model: 'Precision', MPN: '5520', 'Release Year': '2018',
               'Screen Size': '15.6"', Processor: 'i7-6820HQ', Color: 'Silver' },
      field: 'Processor' },
    // ⚠️ LEE Kingston HyperX Fury, denied 2026-09-24: "ITS 2X4 STICKS TO = 8GB".
    // HX424C15FB/4 is one 4GB stick, and the photos show two of them.
    { what: 'Kingston 2x4GB',
      title: 'Kingston HyperX Fury 8GB (2x4GB) RAM DDR4 2400MHz HX424C15FB/4',
      v: { verdict: 'wrong', wrong_text: '8GB (2x4GB)', correct_text: '4GB',
           why: 'Part number HX424C15FB/4 is a single 4GB module, not an 8GB kit' },
      specs: { Brand: 'Kingston', Model: 'HyperX Fury', MPN: 'HX424C15FB/4',
               'Memory Size': '8GB (2x4GB) RAM' },
      field: 'Memory Size' },
];
for (const c of CASES) {
    const r = run(c.title, c.v, c.specs);
    const f = r.findings[0] || {};
    ok(r.findings.length === 1, `${c.what}: one finding`, String(r.findings.length));
    ok(f.code === 'name-disputed', `${c.what}: it is name-disputed`, f.code);
    // ⚠️ THE TITLE MUST NOT MOVE. This is the whole point — the old branch
    // rewrote `title` in place and set fixable, which is what put a one-click
    // Approve on a correction that was wrong.
    ok(r.title === c.title, `${c.what}: the title is untouched`);
    ok(r.fixable === false, `${c.what}: and nothing is offered to approve`);
    ok(f.fixable === false, `${c.what}: the finding is not fixable either`);
    ok(f.severity === 1, `${c.what}: lowest severity, it is not a claim of wrong`,
       String(f.severity));
    ok(new RegExp(c.field).test(f.says || ''), `${c.what}: it names the field that disagrees`,
       c.field);
}

console.log('\n== 2. It says what to do with EITHER answer ==');
{
    const f = run(CASES[0].title, CASES[0].v, CASES[0].specs).findings[0];
    ok(/nothing\s+here settles it/i.test(f.says), 'it admits it cannot tell');
    ok(/dismiss this/i.test(f.warn), 'if the listing is right: dismiss');
    ok(/fix it in Shopify/i.test(f.warn), 'if the field is wrong: fix the field');
    // ⚠️ THE TRAP WORTH NAMING. Correcting only the title leaves the spec field
    // still saying the old thing, in the description a customer reads.
    ok(/correcting the title alone/i.test(f.warn),
       'and it warns that a title-only fix leaves the field behind');
    ok(/We thought:/.test(f.says), 'the original reasoning is kept, not thrown away');
}

console.log('\n== 3. A name the listing does NOT vouch for is still corrected ==');
{
    // The Sony a7 IV mangled to "OX 7 IV" — the single most valuable catch this
    // check has made. Nothing in the listing states it, so nothing vetoes it.
    const r = run('Sony OX 7 IV 33MP Mirrorless Digital Camera',
        { verdict: 'garbled', wrong_text: 'OX 7 IV', correct_text: 'a7 IV',
          why: 'The alpha character was mangled' },
        { Brand: 'Sony', Type: 'Mirrorless Camera' });
    const f = r.findings[0] || {};
    ok(f.code === 'name-garbled', 'it is still name-garbled', f.code);
    ok(/a7 IV/.test(r.title), 'and the correction is still applied', r.title);
    ok(r.fixable === true, 'and still offered as a one-click fix');
}

console.log('\n== 4. Only IDENTITY fields can veto a correction ==');
{
    // ⚠️ NOT ALL SPECS. An incidental field holding the same words must not
    // protect them — otherwise a Color of "Red" vetoes every fix mentioning red.
    const r = run('Sony OX 7 IV 33MP Mirrorless Digital Camera',
        { verdict: 'garbled', wrong_text: 'OX 7 IV', correct_text: 'a7 IV' },
        { Color: 'OX 7 IV', 'Screen Size': 'OX 7 IV' });
    ok((r.findings[0] || {}).code === 'name-garbled',
       'Color and Screen Size do not veto', (r.findings[0] || {}).code);
    // Move the same words into an identity field and it flips.
    const r2 = run('Sony OX 7 IV 33MP Mirrorless Digital Camera',
        { verdict: 'garbled', wrong_text: 'OX 7 IV', correct_text: 'a7 IV' },
        { Model: 'OX 7 IV' });
    ok((r2.findings[0] || {}).code === 'name-disputed',
       'but Model does', (r2.findings[0] || {}).code);
    // A listing with no spec table at all must behave exactly as before.
    const r3 = run('Sony OX 7 IV 33MP Mirrorless Digital Camera',
        { verdict: 'garbled', wrong_text: 'OX 7 IV', correct_text: 'a7 IV' }, {});
    ok((r3.findings[0] || {}).code === 'name-garbled',
       'and no spec table changes nothing', (r3.findings[0] || {}).code);
    // ⚠️ FOCAL LENGTH IS IN THE LIST WITHOUT A DENIAL BEHIND IT, so it gets its
    // own assertion rather than riding on the Rokinon case above. A lens is
    // named by its length as much as by its aperture, and "16mm should be 14mm"
    // is the identical failure waiting to happen.
    const r4 = run('Rokinon AS UMC CS 16mm f/2.2 EF For Canon EF Mount Manual Lens',
        { verdict: 'wrong', wrong_text: '16mm', correct_text: '14mm',
          why: 'The AS UMC CS in this mount is the 14mm' },
        { Brand: 'Rokinon', 'Focal Length': '16mm' });
    ok((r4.findings[0] || {}).code === 'name-disputed',
       'and Focal Length vetoes too', (r4.findings[0] || {}).code);
}

console.log('\n== 4b. "2280mm" is fixed, field and all (reversed 2026-09-30) ==');
{
    // Held back as house style after the SN570 denial (09-15), then denied again
    // on the SN580 (09-25). Ethan, 09-30: the tool is there to say what to change
    // it TO. 2280 is a size CODE (22 x 80); "2280mm" is 2.28 metres, and nobody
    // searching "2280" matches it. Both drives, both verdicts the model gives.
    for (const [model, gen] of [['Blue SN570', '3.0'], ['Blue SN580', '4.0']]) {
        const title = `Western Digital WD 2280mm ${model} 1TB M.2 NVMe Gen ${gen} x 4 SSD`;
        for (const verdict of ['garbled', 'wrong']) {
            const r = run(title,
                { verdict, wrong_text: '2280mm', correct_text: '2280',
                  why: 'M.2 form factor is 2280, not "2280mm"' },
                { Brand: 'Western Digital WD', Model: model,
                  'Sub-Collection': 'Hard Drive (HDD, SSD)', 'Form Factor': '2280mm' });
            const f = r.findings[0] || {};
            ok(f.code === 'name-garbled', `${model} (${verdict}): an ordinary fix`, f.code);
            ok(r.fixable === true && r.title === title.replace('2280mm', '2280'),
               `${model} (${verdict}): 2280mm -> 2280 is offered`, r.title);
            ok(/Form Factor has the same mistake/.test(f.says || ''),
               `${model} (${verdict}): and it says the field gets corrected too`, f.says);
        }
    }
    // ⚠️ ONLY the unit comes off. Form Factor still vetoes any other change.
    const r = run('Western Digital WD 2280mm Blue SN580 1TB M.2 NVMe SSD',
        { verdict: 'wrong', wrong_text: '2280mm', correct_text: '2230' },
        { 'Form Factor': '2280mm' });
    ok((r.findings[0] || {}).code === 'name-disputed',
       'a different size is still disputed', (r.findings[0] || {}).code);
}

console.log('\n== 5. The existing guards still hold ==');
{
    // A placeholder correction must still be dropped entirely — the guard that
    // stopped "[actual game title]" reaching a live storefront.
    const r = run('v (Neo Geo MVS, 1994)',
        { verdict: 'wrong', wrong_text: 'v', correct_text: '[actual game title]' },
        { Platform: 'Neo Geo MVS' });
    ok(r.findings.length === 0, 'a placeholder correction raises nothing',
       String(r.findings.length));
    // A quote the model could not point at is still dropped.
    const r2 = run('Lenovo 34" T43WD-40 Monitor',
        { verdict: 'wrong', wrong_text: 'NOT IN THE TITLE', correct_text: 'x' },
        { MPN: 'NOT IN THE TITLE' });
    ok(r2.findings.length === 0, 'an unquotable claim raises nothing',
       String(r2.findings.length));
    // verdict ok raises nothing, spec table or not.
    ok(run('Anything', { verdict: 'ok' }, { MPN: 'x' }).findings.length === 0,
       'an ok verdict raises nothing');
}

console.log('\n== 6. A field vouches only if it states the part being changed (LEE Anne Pro, 2026-09-19) ==');
{
    // "Anne Pro 01" -> "Anne Pro 2". Brand = "Anne Pro" held the longest window,
    // so the row went name-disputed and named Brand as the field to doubt. The
    // only thing in question was "01", and Model = II agrees with the fix.
    const title = 'Anne Pro 01 Wireless Keyboard Black';
    const v = { verdict: 'wrong', wrong_text: 'Anne Pro 01', correct_text: 'Anne Pro 2',
                why: 'Model is the Anne Pro 2, not "01"' };
    const specs = { Brand: 'Anne Pro', Model: 'II', MPN: 'N/A', Type: 'Wireless Keyboard',
                    'Sub-Collection': 'Keyboard/Mouse', Collection: 'PC/USB Peripherals',
                    Color: 'Black' };
    const r = run(title, v, specs);
    const f = r.findings[0] || {};
    ok(f.code === 'name-wrong', 'it is name-wrong, not name-disputed', f.code);
    ok(r.title === 'Anne Pro 2 Wireless Keyboard Black', 'and the correction is applied', r.title);
    ok(r.fixable === true, 'and offered to approve');
    // The rule still bites when a field really does state the changed part.
    const r2 = run(title, v, Object.assign({}, specs, { Model: 'Anne Pro 01' }));
    ok((r2.findings[0] || {}).code === 'name-disputed',
       'but a Model of "Anne Pro 01" still vetoes it', (r2.findings[0] || {}).code);
}

console.log('\n== 7. A respelling is a fix, even when a field has the same typo (OVL, 2026-09-22) ==');
{
    const TYPOS = [
        { what: 'Sansui receiver', field: 'Type',
          title: 'Sansui Stereo System 3300 Stereo Reviever 3300',
          fixed: 'Sansui Stereo System 3300 Stereo Receiver 3300',
          v: { wrong_text: 'Reviever', correct_text: 'Receiver', why: '"Receiver" is misspelled' },
          specs: { Brand: 'Sansui', Model: 'Stereo System 3300', MPN: '3300',
                   Type: 'Stereo Reviever', Collection: 'General/Other' } },
        { what: 'Analogue Super NT', field: 'Model',
          title: 'Analogue Super NT Super Famicon Console System',
          fixed: 'Analogue Super NT Super Famicom Console System',
          v: { wrong_text: 'Super Famicon', correct_text: 'Super Famicom',
               why: "Nintendo's console is the Super Famicom, misspelled here" },
          specs: { Brand: 'Analogue', Model: 'Super NT Super Famicon', MPN: 'N/A',
                   Type: 'Console System', Collection: 'Other Gaming' } },
    ];
    for (const c of TYPOS) {
        // Whichever verdict the model hands back, a respelling is a typo.
        for (const verdict of ['garbled', 'wrong']) {
            const r = run(c.title, Object.assign({ verdict }, c.v), c.specs);
            const f = r.findings[0] || {};
            ok(f.code === 'name-garbled', `${c.what} (${verdict}): name-garbled`, f.code);
            ok(r.title === c.fixed && r.fixable === true,
               `${c.what} (${verdict}): the fix is offered`, r.title);
        }
        const f = run(c.title, Object.assign({ verdict: 'garbled' }, c.v), c.specs).findings[0] || {};
        ok(new RegExp(`own ${c.field} has the same misspelling`).test(f.says || ''),
           `${c.what}: it says the ${c.field} field has the same typo`, f.says);
    }
    // ⚠️ THE LINE HOLDS. A digit is a fact, and a different word is a different
    // product — these stay disputed however close the letters are.
    const near = run('Acme Widget Portable SSD',
        { verdict: 'garbled', wrong_text: 'Widget', correct_text: 'Gadget' },
        { Model: 'Widget' });
    ok((near.findings[0] || {}).code === 'name-disputed',
       'a word 3 edits away is not a respelling', (near.findings[0] || {}).code);
    const short = run('Sony Arc Soundbar', { verdict: 'garbled', wrong_text: 'Arc', correct_text: 'Arch' },
        { Model: 'Arc' });
    ok((short.findings[0] || {}).code === 'name-disputed',
       'nor is a word under 4 letters', (short.findings[0] || {}).code);
}

console.log('\n' + (fails ? fails + ' FAILED' : 'all passed') + '\n');
process.exit(fails ? 1 : 0);
