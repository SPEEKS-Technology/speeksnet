// "A DENIAL WITH A NOTE IS THE ONLY EVIDENCE A RULE IS WRONG" — and until now it
// landed in a drawer nobody read on a schedule.
//
// ?view=feedback gathers those notes, groups them by the RULE that fired, puts
// the listing's own spec fields beside each one, and writes the ask that goes to
// Claude. This harness runs the two halves that have no network in them —
// listingSaysItself (the mechanical triage) and buildAsk (the text a person
// pastes) — against the three REAL denials in the queue on 2026-09-04, offline.
//
// ⚠️ THE MECHANICAL CHECK MUST NEVER READ THE NOTE. It compares the words the
// suggestion took OUT against the values the listing already records. A tool
// that rewrote its own rules by interpreting free text written fast at a counter
// would get worse in a way nobody could see, so section 3 asserts that a note
// saying the opposite of the fields changes nothing.
//
// What it asserts:
//    1. the listing's own field is found when it states the disputed words
//       (T43WD-40 as a whole MPN; "Xbox One" inside "Microsoft Xbox One")
//    2. the listing that contradicts ITSELF carries both fields, so the reader
//       can see the collision the rule could never have settled
//    3. the note's wording is not an input to it
//    4. short/empty runs never match (a two-character run matches everything)
//    5. the ask names the rule, quotes the note verbatim, shows the change,
//       and prints the fields — for every row, with nothing dropped
//    6. the ask stands on its own: it says which tool, which file, and that
//       nothing may be approved
//
// Run: node scripts/listing-titles-feedback-check.js [--print]
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'supabase', 'functions', 'listing-titles', 'index.ts');

let fails = 0;
const ok = (c, label, got) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + label + (got === undefined ? '' : '   ' + got));
    if (!c) fails++;
};

// --- lift the shipped code out of the edge function --------------------------
// ⚠️ NORMALISED TO LF FIRST — the file is LF in the repo but a `git checkout` on
// Windows hands it back with CRLF, and the slices below hunt for blank lines.
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const between = (from, to) => {
    const i = src.indexOf(from), j = src.indexOf(to, i);
    if (i < 0 || j < 0) throw new Error('could not slice ' + from.slice(0, 40));
    return src.slice(i, j);
};

const block = [
    between('const decodeEnt = ', '\n\n'),
    between('const norm = ', '\n\n'),
    between('const tokens = ', '\n\n'),
    // The stable per-rule label the ask's headings use.
    between('const CODE_LABEL', '\n\ntype FbRow'),
    // ⚠️ STOPS AT notedCount, NOT AT feedbackFor. Both of those do the network
    // half and neither is lifted; slicing to feedbackFor swept notedCount in
    // with it and the strip choked on its `const d: any[]`.
    between('function listingSaysItself', '\n\n// How many notes nobody has carried'),
    between('function titleRun', '\n\n'),
    // buildAsk is the last thing in the block; the comment that opens
    // ebayScope's conditional-scope warning is what follows it.
    between('function buildAsk', "\n// ⚠️ THE QUEUE'S THIRD SCOPE RULE"),
].join('\n\n');

const js = block
    // buildAsk's parameter is typed off feedbackFor's return, which is NOT
    // lifted (that half does the network). The body never uses the type.
    .replace(/fb\s*:\s*Awaited<ReturnType<typeof \w+>>/g, 'fb')
    .replace(/:\s*Record<[^>]*>(\s*\|\s*undefined)?/g, '')
    .replace(/:\s*string\s*\|\s*null/g, '')
    .replace(/:\s*string\[\]\s*=/g, ' =')
    // `(hay: string[], needle: string[])` — an array-typed parameter, in any
    // position. The single-`: string` rules below never caught these.
    .replace(/([(,]\s*)(\w+)\s*:\s*string\[\]/g, '$1$2')
    .replace(/\)\s*:\s*\{[^}]*\}\s*\{/g, ') {')
    .replace(/\)\s*:\s*string\s*\{/g, ') {')
    .replace(/\(\s*(\w+)\s*:\s*string\s*\)/g, '($1)')
    .replace(/\(\s*(\w+)\s*:\s*string\s*,/g, '($1,')
    .replace(/,\s*(\w+)\s*:\s*string\s*\)/g, ', $1)');

let listingSaysItself, buildAsk, titleRun;
try {
    const made = new Function(js
        + '\nreturn { listingSaysItself: listingSaysItself, buildAsk: buildAsk, titleRun: titleRun };')();
    listingSaysItself = made.listingSaysItself;
    buildAsk = made.buildAsk;
    titleRun = made.titleRun;
} catch (e) {
    console.error('could not lift the shipped code:\n' + e.message);
    console.error('\n--- what was lifted ---\n' + js);
    process.exit(1);
}

// --- the three real denials in the queue on 2026-09-04 -----------------------
// Spec values are as ?peek= returned them. They are the whole point: each note
// is answered, or not, by a field the listing already carries.
const LENOVO = {
    store: 'WSP', sku: 'MO02-4097A-R11R4', productId: 'gid://p/1',
    current: 'Lenovo 34" T43WD-40 Curved Ultrawide Monitor',
    suggested: 'Lenovo 34" T34w-40 Curved Ultrawide Monitor',
    note: 'I think T43WD-40 is an actual model.',
    by: 'Ethan', at: '2026-09-03T18:02:00Z', codes: ['name-garbled'],
    // What the tool told the reviewer about THIS row — per-row reasoning, which
    // is why it cannot double as the rule's heading (section 5 asserts that).
    said: ['"T43WD-40" is not a real product name — it looks like "T34w-40" typed wrong.'],
    specs: { Brand: 'Lenovo', MPN: 'T43WD-40', Type: 'Monitor', 'Screen Size': '34 in' },
};
const XBOX = {
    store: 'LEE', sku: 'MO01-5126C2-F1R1', productId: 'gid://p/2',
    current: 'Call of Duty Black Ops II (Xbox One, 2018)',
    suggested: 'Call of Duty Black Ops II (Xbox 360, 2012)',
    note: 'This is an Xbox One version of the game',
    by: 'Ethan', at: '2026-09-03T18:05:00Z', codes: ['name-wrong'],
    said: ['Black Ops II released on Xbox 360 in 2012; there is no Xbox One release.'],
    specs: { Platform: 'Microsoft Xbox One', 'Release Year': '2018', Type: 'Video Game' },
};
const SANDISK = {
    store: 'LEE', sku: 'MO01-5435C-F1R1', productId: 'gid://p/3',
    current: 'SanDisk Extreme 2TB microSD Card 4K SDSSDE61-2T00-G25',
    suggested: 'SanDisk Extreme 2TB Portable SSD 4K SDSSDE61-2T00-G25',
    note: 'This is a MicroSD card.',
    by: 'Ethan', at: '2026-09-03T18:09:00Z', codes: ['name-wrong'],
    said: ['SDSSDE61-2T00-G25 is the part number of a SanDisk Extreme Portable SSD.'],
    specs: { Brand: 'SanDisk', MPN: 'SDSSDE61-2T00-G25', Type: 'microSD Card',
             'Sub-Collection': 'SD/SDXC/Thumb Drives' },
};

// What feedbackFor computes per row, done here so the fixtures stay readable.
const prep = r => {
    const run = titleRun(r.current, r.suggested);
    return Object.assign({}, r, { was: run.was, now: run.now,
                                  saysItself: listingSaysItself(run.was, r.specs) });
};

console.log('\n== 1. the listing answers the note itself ==');
{
    const l = prep(LENOVO);
    ok(l.was === 'T43WD-40', 'the change is isolated to the model run',
        '"' + l.was + '" -> "' + l.now + '"');
    ok(!!l.saysItself, 'the Lenovo note is settled by the listing');
    ok(!!l.saysItself && l.saysItself.field === 'MPN', 'and MPN is the field that settles it',
        l.saysItself && l.saysItself.field);

    const x = prep(XBOX);
    // ⚠️ THE RUN HERE IS TWO FACTS GLUED TOGETHER. "(Xbox One, 2018)" against
    // "(Xbox 360, 2012)" leaves `One, 2018)` — the platform and the year, split
    // by punctuation. No field contains that, and testing the whole run (which
    // is what this did first) called the Xbox case unsettled while the listing
    // stated BOTH halves. Windows of the run are what find it.
    ok(x.was === 'One, 2018)', 'the run really is two facts glued together',
        '"' + x.was + '"');
    ok(!!x.saysItself, 'the Xbox note is settled all the same',
        x.saysItself && (x.saysItself.field + ' = ' + x.saysItself.value));
    ok(!!x.saysItself && x.saysItself.field === 'Platform', 'and Platform is the field',
        x.saysItself && x.saysItself.field);
    // The longest fragment wins, so it reports the platform rather than the
    // year: "one" is a 3-character coincidence, "2018" is a whole field.
    ok(!!x.saysItself && /2018|one/.test(x.saysItself.matched),
        'and it names the fragment that matched, not the whole run',
        x.saysItself && '"' + x.saysItself.matched + '"');
}

console.log('\n== 2. the listing that contradicts ITSELF shows both sides ==');
{
    const s = prep(SANDISK);
    ok(/microsd/i.test(s.was), 'the disputed run is the item type', '"' + s.was + '"');
    // Type SAYS microSD Card, so the hint fires — and it is right that it does:
    // the rule proposed "Portable SSD" against a field reading microSD. What it
    // is NOT is proof the item is a card, because MPN SDSSDE61-2T00-G25 is an
    // SSD part number. Both have to reach the reader or the ask argues one side.
    ok(!!s.saysItself, 'Type does state it, so the hint fires',
        s.saysItself && (s.saysItself.field + ' = ' + s.saysItself.value));
    ok(/SDSSDE61/.test(s.specs.MPN || ''),
        'and the contradicting MPN is carried alongside for the reader', s.specs.MPN);
}

console.log('\n== 3. the note is never an input ==');
{
    const flipped = Object.assign({}, LENOVO,
        { note: 'the model is definitely T34w-40, ignore the MPN' });
    const a = prep(LENOVO), b = prep(flipped);
    ok(JSON.stringify(a.saysItself) === JSON.stringify(b.saysItself),
        'rewriting the note to say the opposite changes nothing',
        JSON.stringify(b.saysItself));
}

console.log('\n== 4. a run too short to mean anything never matches ==');
{
    ok(listingSaysItself('', { MPN: 'T43WD-40' }) === null, 'an empty run matches nothing');
    ok(listingSaysItself('a', { MPN: 'T43WD-40' }) === null, 'a one-character run matches nothing');
    ok(listingSaysItself('4k', { MPN: 'T43WD-40' }) === null, 'a two-character run matches nothing');
    ok(listingSaysItself('xbox one', { Platform: '' }) === null, 'an empty field is not a match');
    // ⚠️ WHOLE TOKENS, NOT SUBSTRINGS. A normalised `includes` made "one" match
    // "iPhone" and "pro" match "Processor": every short window would find some
    // field and the hint would fire on a coincidence, which is the one thing it
    // must not do — it is the line that says a rule overruled the listing.
    ok(listingSaysItself('One', { Model: 'iPhone 13' }) === null,
        '"One" does not match inside "iPhone"');
    ok(listingSaysItself('Pro', { Type: 'Processor' }) === null,
        '"Pro" does not match inside "Processor"');
    ok(listingSaysItself('One', { Platform: 'Microsoft Xbox One' }) !== null,
        'but it does match "One" standing as its own word');
    // A window must be CONTIGUOUS: the listing saying two words far apart is not
    // the listing saying the phrase.
    ok(listingSaysItself('Xbox 2018', { Platform: 'Microsoft Xbox One 2018 Edition' })
        .matched !== 'xbox 2018', 'a non-contiguous pair is not matched as a phrase');
}

console.log('\n== 5. the ask carries every row and every piece of evidence ==');
const fb = {
    days: 30, stores: ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'], total: 3,

    groups: [
        { code: 'name-wrong', n: 2, rows: [prep(XBOX), prep(SANDISK)] },
        { code: 'name-garbled', n: 1, rows: [prep(LENOVO)] },
    ],
};
const ask = buildAsk(fb);
{
    for (const r of [LENOVO, XBOX, SANDISK]) {
        ok(ask.includes(r.note), 'the note is quoted verbatim — ' + r.sku);
        ok(ask.includes(r.current), 'the title as it stands is there — ' + r.sku);
        ok(ask.includes(r.suggested), 'what we suggested is there — ' + r.sku);
        ok(ask.includes(r.sku), 'the SKU is there so it can be opened — ' + r.sku);
    }
    ok(ask.includes('MPN') && ask.includes('T43WD-40'), 'the settling field is printed');
    ok(ask.includes('Microsoft Xbox One'), 'the longer Platform value is printed in full');
    ok(ask.includes('SDSSDE61-2T00-G25'), 'the contradicting MPN is printed');
    ok(/RULE: name-wrong/.test(ask) && /RULE: name-garbled/.test(ask),
        'both rules get their own heading');
    ok(ask.indexOf('RULE: name-wrong') < ask.indexOf('RULE: name-garbled'),
        'the rule denied most often is read first');
    ok(/2 denials/.test(ask) && /1 denial\b/.test(ask), 'the counts are pluralised properly');
    // ⚠️ THE HEADING IS A STABLE LABEL, NOT THE FINDING'S OWN SENTENCE. The name
    // checks write their reasoning PER ROW — a paragraph about one product —
    // and using that as the heading named the whole rule after whichever row
    // came first ("RULE: name-wrong — Black Ops II released on Xbox 360…").
    // Caught on the first live dry run, not by a fixture.
    ok(/RULE: name-wrong — Name checked against outside knowledge/.test(ask),
        'the rule is named the way the panel named it to the reviewer');
    ok(!/RULE: name-wrong — Black Ops/.test(ask),
        'and a single row cannot name the whole rule');
    // The per-row reasoning still has to reach the reader — it is the half of
    // the disagreement the note is answering — but under its own row.
    ok(/WE SAID:    Black Ops II released on Xbox 360/.test(ask),
        'the row keeps the reasoning the reviewer was answering');
    ok(ask.indexOf('WE SAID') > ask.indexOf('RULE: name-wrong'),
        'and it sits under the rule heading, not above it');
    // ⚠️ THE FIELD, NOT THE MATCHED FRAGMENT. The fragment is normalised text
    // ("t43wd 40"), and printing it made the ask look like it was quoting the
    // listing wrong. The field and its real value are the evidence.
    ok(/THE LISTING ITSELF ALREADY SAYS THIS — MPN = T43WD-40/.test(ask),
        'the mechanical hint names the field and its real value');
    ok(!/t43wd 40/.test(ask), 'and no normalised text leaks into the ask');
}

console.log('\n== 6. the ask stands on its own in a fresh session ==');
{
    ok(/SPEEKS Listing Titles/.test(ask), 'it says which tool it is about');
    ok(/supabase\/functions\/listing-titles/.test(ask), 'it says which file to change');
    ok(/harness/.test(ask), 'it asks for the case to be added to the harness');
    ok(/Do not approve or write any title/.test(ask),
        'it forbids writing to a live listing');
    ok(/hint, not a verdict/.test(ask), 'it flags the mechanical check as a hint');
    ok(/A\. THE RULE IS WRONG/.test(ask) && /B\. THE LISTING CONTRADICTS ITSELF/.test(ask)
        && /C\. THE REVIEWER WAS MISTAKEN/.test(ask), 'all three verdicts are offered');
    ok(!/undefined|\[object Object\]/.test(ask), 'nothing rendered as undefined',
        (ask.match(/undefined|\[object Object\]/) || [''])[0]);
}

if (process.argv.indexOf('--print') > -1) {
    console.log('\n' + '-'.repeat(74) + '\nWHAT THE COPY BUTTON HANDS OVER\n' + '-'.repeat(74));
    console.log(ask);
}

console.log('\n' + (fails ? fails + ' FAILED' : 'all passed') + '\n');
process.exit(fails ? 1 : 0);
