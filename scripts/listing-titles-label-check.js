// THE LABEL CHECK — a title code or capacity the listing's own label contradicts.
//
// Ethan, 2026-11-05 ("lets go option b"). Every newly name-checked listing that
// names a part has its photos read for the label (LABEL_SYSTEM). The answer is
// turned into an ordinary name verdict by labelVerdict, and analyse's name block
// judges it like any other — so this harness lifts BOTH, real code, no paraphrase.
//
// What it asserts:
//    1. hasPartCode picks part codes and MPNs, not bare sizes or speeds
//    2. labelVerdict refuses anything it cannot verify: a quote not in the title,
//       a photo that does not exist or did not load, a placeholder, no `seen`,
//       and the same value written differently
//    3. it uses the TITLE's spelling of the quote, so analyse's exact indexOf finds it
//    4. through the real decision: a label read is a one-click name-wrong fix,
//       sent to the photo, with a repeating field corrected — never "a typo",
//       never "outside knowledge"
//
// Run: node scripts/listing-titles-label-check.js
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

// The same type-stripping the name-dispute harness uses, plus the label helpers'
// own signatures.
const strip = s => s
    .replace(/function labelVerdict\([^)]*\)\s*:\s*NameVerdict\s*\|\s*null\s*\{/,
             'function labelVerdict(title, ms, urls, fetched) {')
    .replace(/function hasPartCode\([^)]*\)\s*:\s*boolean\s*\{/,
             'function hasPartCode(title, specs) {')
    .replace(/:\s*Record<[^>]*>(\s*\|\s*undefined)?/g, '')
    .replace(/\)\s*:\s*(number|boolean|\[number,\s*number\])\s*\{/g, ') {')
    .replace(/(\w)\??\s*:\s*\[number,\s*number\]/g, '$1')
    .replace(/:\s*number\[\]\[\]/g, '')
    .replace(/(\w+)\s*:\s*number\b(?=\s*[,)])/g, '$1')
    .replace(/([(,]\s*)(\w+)\s*:\s*string\[\]/g, '$1$2')
    .replace(/\(\s*(\w+)\s*:\s*string\s*\)/g, '($1)')
    .replace(/\(\s*(\w+)\s*:\s*string\s*,/g, '($1,')
    .replace(/,\s*(\w+)\s*:\s*string\s*\)/g, ', $1)')
    .replace(/([(,]\s*)(\w+)\??\s*:\s*string\b/g, '$1$2')
    .replace(/\)\s*:\s*\{[^{}]*\}\s*\|\s*null\s*\{/g, ') {');

// --- 1-3: the two pure helpers -------------------------------------------------
let hasPartCode, labelVerdict;
try {
    const code = strip([
        between('const PLACEHOLDER = ', '\n\n'),
        between('function hasPartCode', '\n\n// The label answer'),
        between('function labelVerdict', '\n\nasync function labelCheck'),
    ].join('\n\n'));
    const f = new Function(code + '\nreturn { hasPartCode: hasPartCode, labelVerdict: labelVerdict };')();
    hasPartCode = f.hasPartCode; labelVerdict = f.labelVerdict;
} catch (e) {
    console.error('could not lift the label helpers:\n' + e.message);
    process.exit(1);
}

console.log('\n== 1. Which listings name a part ==');
for (const t of ['ADATA AD4U266638G19-B 8GB (1x8GB) RAM DDR4 2666MHz',
                 'Samsung 2.5" T7 2TB USB-C to USB-C SSD MU-PC2T0T',
                 'HP Pavilion 14" 14M-BA013DX i3-7100U 2.4GHz 8GB RAM 500GB HDD',
                 'Sony PlayStation 5 Slim Digital CFI-2115 825GB']) {
    ok(hasPartCode(t, {}), `part code in "${t.slice(0, 40)}…"`);
}
for (const t of ['Apple iPhone 13 128GB Blue Unlocked', 'Logitech Wireless Mouse',
                 'Seagate 2TB 7200RPM 3.5" HDD', 'Nintendo Switch OLED 64GB 1080p']) {
    ok(!hasPartCode(t, {}), `no part code in "${t}"`);
}
ok(hasPartCode('Dell Latitude Laptop', { MPN: 'P72G002' }), 'a filled MPN counts');
ok(!hasPartCode('Dell Latitude Laptop', { MPN: 'N/A' }), 'a placeholder MPN does not');
ok(!hasPartCode('Dell Latitude Laptop', { MPN: 'Latitude' }), 'nor an MPN with no digits');

console.log('\n== 2. labelVerdict refuses what it cannot verify ==');
const URLS = ['https://x/1.jpg', 'https://x/2.jpg', 'https://x/3.jpg'];
const LOADED = [true, true, true];
const ADATA = 'ADATA AD4U266628G19-B 8GB (1x8GB) RAM DDR4 2666MHz';
const good = { title_text: 'AD4U266628G19-B', label_text: 'AD4U266638G19-B', photo: 2,
               seen: "the stick's label reads AD4U266638G19-B" };
ok(!!labelVerdict(ADATA, [good], URLS, LOADED), 'a clean read is accepted');
const refuse = (what, m, urls, loaded) =>
    ok(labelVerdict(ADATA, [Object.assign({}, good, m)], urls || URLS, loaded || LOADED) === null, what);
refuse('a quote that is not in the title', { title_text: 'AD4U266648G19-B' });
refuse('photo 0', { photo: 0 });
refuse('photo past the end', { photo: 4 });
refuse('a photo that did not load', {}, URLS, [true, false, true]);
refuse('no `seen`', { seen: '  ' });
refuse('a placeholder replacement', { label_text: '[actual part number]' });
refuse('the same value with a dash dropped', { title_text: 'AD4U266628G19-B', label_text: 'ad4u266628g19b' });
refuse('a serial number offered as the fix', { label_text: 'serial 12345' });
{
    const v = labelVerdict(ADATA, [{ title_text: 'nope', label_text: 'x', photo: 1, seen: 'a' }, good], URLS, LOADED);
    ok(v && v.correct_text === 'AD4U266638G19-B', 'a bad first mismatch does not hide a good second one');
}

console.log('\n== 3. The title\'s own spelling of the quote is used ==');
{
    const v = labelVerdict('HP Pavilion 14" 14m-ba013dx i3', [{ title_text: '14M-BA013DX',
        label_text: '14-BA013DX', photo: 1, seen: 'the base label reads 14-ba013dx' }], URLS, LOADED);
    ok(v && v.wrong_text === '14m-ba013dx', 'the span as the title writes it', v && v.wrong_text);
    ok(v && v.source === 'label' && v.photo.answer === 'ours' && v.photo.url === URLS[0],
       'carries the photo as "ours", with its url');
    ok(v && /^Photo 1 shows the base label reads/.test(v.why), 'the reason is the photo', v && v.why);
}

// --- 4: through analyse's real decision ----------------------------------------
const helpers = strip([
    between('const decodeEnt = ', '\n\n'),
    between('const norm = ', '\n\n'),
    between('const tokens = ', '\n\n'),
    between('const IDENTITY_FIELDS = [', '\n\ntype NameVerdict'),
    between('function listingSaysItself', '\n\n// How many notes nobody has carried'),
    between('function fieldBacksCorrection', '\n\n// ⚠️ EVERY FAILED DESIGN'),
].join('\n\n'));
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
    process.exit(1);
}

console.log('\n== 4. Through the real decision ==');
{
    // BAL's ADATA, with the MPN repeating the title's typo.
    const v = labelVerdict(ADATA, [good], URLS, LOADED);
    const r = decide(v, ADATA, { specs: { Brand: 'ADATA', MPN: 'AD4U266628G19-B' } });
    const f = r.findings[0] || {};
    ok(f.code === 'name-wrong' && f.severity === 3, 'name-wrong, severity 3 — not "garbled"', f.code);
    ok(r.fixable && f.fixable, 'one click');
    ok(r.title === 'ADATA AD4U266638G19-B 8GB (1x8GB) RAM DDR4 2666MHz', 'the suggested title', r.title);
    ok(/^The title says "AD4U266628G19-B"; it should be "AD4U266638G19-B"\. Look at photo 2: the stick's label reads AD4U266638G19-B\./.test(f.says),
       'says what the photo shows', f.says);
    ok((f.says.match(/label reads/g) || []).length === 1, 'and says it once', f.says);
    ok(/MPN field \("AD4U266628G19-B"\) says otherwise, and approving corrects that field too/.test(f.says),
       'and that the MPN is corrected with it', f.says);
    ok(/^Settled by photo 2 of this listing/.test(f.warn || ''), 'sends the reviewer to the photo', f.warn);
    ok(f.photo && f.photo.n === 2 && f.photo.url === URLS[1], 'the photo rides on the finding');
}
{
    // No field repeats the title: the photo must still count, not "outside knowledge".
    const T = 'HP Pavilion 14" 14M-BA031DX i3-7100U 2.4GHz 8GB RAM 500GB HDD';
    const v = labelVerdict(T, [{ title_text: '14M-BA031DX', label_text: '14M-BA013DX', photo: 3,
        seen: 'the base label reads 14M-BA013DX' }], URLS, LOADED);
    const r = decide(v, T, { specs: { Brand: 'HP', Model: 'Pavilion' } });
    const f = r.findings[0] || {};
    ok(f.code === 'name-wrong' && r.fixable, 'a fix with no field involved', f.code);
    ok(!/outside product knowledge/.test(f.warn || ''), 'never worded as outside knowledge', f.warn);
    ok(/Look at photo 3: the base label reads 14M-BA013DX\./.test(f.says), 'and points at the photo', f.says);
    ok(f.photo && f.photo.n === 3, 'and still carries the photo');
}
{
    // A capacity: the Samsung T7's label says 2TB.
    const T = 'Samsung T7 1TB USB-C Portable SSD MU-PC2T0T';
    const v = labelVerdict(T, [{ title_text: '1TB', label_text: '2TB', photo: 1,
        seen: 'the drive label reads 2TB' }], URLS, LOADED);
    const r = decide(v, T, { specs: { Brand: 'Samsung', Capacity: '1TB' } });
    const f = r.findings[0] || {};
    ok(r.title === 'Samsung T7 2TB USB-C Portable SSD MU-PC2T0T' && r.fixable,
       'capacity corrected in one click', r.title);
    ok(/Capacity field \("1TB"\) says otherwise, and approving corrects that field too/.test(f.says),
       'and the Capacity field with it', f.says);
}

console.log('\n' + (fails ? fails + ' FAILED' : 'all passed') + '\n');
process.exit(fails ? 1 : 0);
