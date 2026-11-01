// "THE TITLE NAMES 2 SEPARATE THINGS BUT NEVER SAYS IT IS A BUNDLE."
//
// The accusation is only true when the two things are two PRODUCTS. A computer
// reciting its own CPU and RAM is one product, and every false bundle this rule
// has raised was that shape. The latest: three Dell PowerEdge servers at WSP,
// denied "Not a bundle" on 2026-10-21, because neither host list knew a server.
//
// What it asserts:
//    1. the three PowerEdge titles, with the fields ?peek= returned, are silent
//    2. a server named only by its Type field is silent too
//    3. "Server RAM" / "Server CPU" are parts, so a Xeon plus server memory still
//       IS a bundle — the shape the rule was written for
//    4. the real bundles in the estate still fire, and the desktop still does not
//
// Run: node scripts/listing-titles-bundle-check.js
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

// ⚠️ THE DECISION, LIFTED WHOLE — from the category match to the finding — so
// the harness tests the rule rather than a paraphrase of it. analyse() supplies
// `collection`, `specType`, `brokenTitle` and `tryAppend`; they are passed in.
const strip = s => s
    .replace(/:\s*\[string,\s*RegExp\]\[\]/g, '')
    .replace(/\(a:\s*string\[\]\)/g, '(a)');
const consts = strip([
    between('const MAJOR_CATEGORIES', '\n\n'),
    between('const BUNDLE_WORDS', '\n\n'),
].join('\n\n'));
const decision = strip(between('  let cats = MAJOR_CATEGORIES', '\n  // ⚠️⚠️ RETIRED 2026-08-28'));

let decide;
try {
    decide = new Function('original', 'collection', 'specType',
        consts + '\nvar title = original, brokenTitle = false, findings = [];\n'
        + 'var tryAppend = function (w) { if (title.length + w.length + 1 > 80) return false; title += " " + w; return true; };\n'
        + decision + '\nreturn findings;');
} catch (e) {
    console.error('could not lift the decision:\n' + e.message);
    console.error('\n--- decision block ---\n' + decision.slice(0, 900));
    process.exit(1);
}
const bundled = (title, collection, type) =>
    decide(title, collection || '', type || '').some(f => f.code === 'undeclared-bundle');

console.log('\n== 1. The three WSP denials, 2026-10-21 ==');
[
    ['Dell PowerEdge 32GB RAM Xeon E5620 R510', 'General/Other', '32GB RAM Xeon E5620'],
    ['Dell PowerEdge Server R530 32GB RAM 2x Xeon E5-2620V3', 'General/Other', 'Server'],
    ['Dell PowerEdge 2x Xeon E5-2630V3 64GB RAM R530', 'General/Other', '2x Xeon E5-2630V3 64GB RAM'],
].forEach(([t, c, ty]) => ok(!bundled(t, c, ty), 'not a bundle: ' + t));

console.log('\n== 2. A server the title never calls one ==');
ok(!bundled('HP 2x Xeon Gold 6130 128GB RAM 1U', 'General/Other', 'Rack Server'),
    'Type = Rack Server is a host');
ok(!bundled('HPE ProLiant DL380 Gen9 2x Xeon E5-2650 64GB RAM', 'General/Other', ''),
    'ProLiant in the title is a host');

console.log('\n== 3. Server PARTS are not a server ==');
ok(bundled('Intel Xeon E5-2680 V4 CPU 64GB Server RAM DDR4', 'General/Other', ''),
    'Xeon + "Server RAM" still a bundle');
ok(bundled('Samsung 2x 32GB DDR4 ECC with Server CPU Xeon E5-2690', 'General/Other', 'Server Memory'),
    'Type = Server Memory is not a host');

console.log('\n== 4. What already held still holds ==');
ok(bundled('Core i9-13900k and 2x16GB DDR5 FlareX', 'General/Other', ''), 'CPU + RAM still a bundle');
ok(bundled('GeForce RTX 4060 Ti 1TB SSD MSI', 'General/Other', ''), 'GPU + SSD still a bundle');
ok(!bundled('Dell Inspiron 3910 D32M Core i5-12400 2.50GHz 12GB RAM 256GB SSD 1TB HDD', 'Windows Desktops', ''),
    'a desktop is still one product');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
