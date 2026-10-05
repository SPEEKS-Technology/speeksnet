// "THERE ARE MULTIPLE STORAGE DEVICES" — spec-conflict on a two-drive PC.
//
// OVL, denied twice on 2026-09-22 with that note. The Cooler Master build
// (KS01-7824A-E10) has Storage 1 = 1TB SSD and Storage 2 = 2TB HDD, and its
// title says "3TB Storage" — the total. spec-conflict only ever compared the
// title against Storage 1, so it called a correct title a severity-3
// contradiction, and because spec-conflict marks a title broken, it also
// blocked every append the row would otherwise have had.
//
// What it asserts:
//    1. the real listing, with its real spec table, raises nothing
//    2. the title may state the total in either unit, or any one drive
//    3. a title that matches no drive and not the total still fires, and the
//       message names the drives rather than blaming Storage 1 alone
//    4. a one-drive listing behaves exactly as before
//
// Run: node scripts/listing-titles-storage-check.js
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

// ⚠️ THE BLOCK, LIFTED WHOLE — the same reason the name-dispute harness lifts
// its decision rather than restating it: a paraphrase proves only itself.
const strip = s => s
    .replace(/\(\s*(\w+)\s*:\s*string\s*\)/g, '($1)')
    .replace(/\(\s*(\w+)\s*:\s*number\s*\)/g, '($1)')
    .replace(/new Map<[^>]*>>?\(\)/g, 'new Map()')
    .replace(/new Set<[^>]*>\(\)/g, 'new Set()')
    .replace(/!\./g, '.').replace(/!\)/g, ')').replace(/\)!\]/g, ')]');

const helpers = [
    between('const PLACEHOLDER = ', '\n\n'),
    between('const TITLE_SPECS = [', '\n\n'),
].join('\n\n');
const block = strip(between(
    "  // THE TITLE CONTRADICTS THE LISTING'S OWN SPEC TABLE.",
    '\n  // A TITLE THAT STOPS MID-PHRASE'));

let check;
try {
    check = new Function('original', 'extra',
        helpers + '\nvar findings = [];\n' + block + '\nreturn findings;');
} catch (e) {
    console.error('could not lift the block:\n' + e.message);
    process.exit(1);
}
const run = (title, specs) => check(title, { specs });

// The Cooler Master's spec table, as the storefront served it on 2026-09-23.
const COOLER = {
    Collection: 'Custom Gaming PC', 'Case Brand': 'Cooler Master', Model: 'Custom PC',
    'Processor Brand': 'Intel', Processor: 'Core i9-9900K', 'Processor Speed': '3.60GHz',
    'Memory (RAM)': '32GB RAM', 'Memory Size + Type': '32GB (4x8GB) DDR4',
    'Storage 1': '1TB', 'Storage Type 1': 'SSD', 'Storage 2': '2TB', 'Storage Type 2': 'HDD',
    'GPU/Graphics Card Brand': 'Nvidia', 'GPU/Graphics Card Model': 'GeForce RTX 3080',
    VRAM: '12GB',
};
const COOLER_TITLE = 'Cooler Master PC Core i9-9900K 32GB RAM 3TB Storage RTX 3080 12GB Liquid Cooled';

console.log('\n== 1. The denied listing ==');
{
    const f = run(COOLER_TITLE, COOLER);
    ok(!f.some(x => x.code === 'spec-conflict'), 'KS01-7824A-E10 raises no spec-conflict',
       f.map(x => x.says).join(' | '));
}

console.log('\n== 2. Any one drive, or the total in either unit ==');
{
    const two = { 'Storage 1': '512GB', 'Storage 2': '2TB' };
    for (const t of ['PC 2.5TB Storage', 'PC 2512GB Storage', 'PC 512GB SSD 2TB HDD',
                     'PC 2TB HDD', 'PC 512GB SSD']) {
        ok(!run(t, two).some(x => x.code === 'spec-conflict'), `"${t}" agrees`);
    }
    // The storefront writes a bare "1 TB" as often as "1TB".
    ok(!run(COOLER_TITLE, Object.assign({}, COOLER, { 'Storage 1': '1 TB' }))
        .some(x => x.code === 'spec-conflict'), 'a spaced "1 TB" still sums');
}

console.log('\n== 3. A title matching nothing still fires, and names the drives ==');
{
    const f = run('Cooler Master PC 32GB RAM 4TB Storage', COOLER)
        .find(x => x.code === 'spec-conflict');
    ok(!!f, 'a 4TB title on a 1TB + 2TB build is a conflict');
    ok(/1TB \+ 2TB/.test((f || {}).says || ''), 'it lists the drives', (f || {}).says);
    ok(/3TB together/.test((f || {}).says || ''), 'and their total', (f || {}).says);
    ok(f && f.severity === 3 && f.fixable === false, 'still severity 3, still report-only');
}

console.log('\n== 4. One drive: unchanged ==');
{
    const f = run('PC 32GB RAM 3TB Storage', { 'Storage 1': '1TB' })
        .find(x => x.code === 'spec-conflict');
    ok(!!f, 'a 3TB title on a single 1TB drive is still a conflict');
    ok(/own Storage 1 field says 1TB/.test((f || {}).says || ''),
       'with the old wording', (f || {}).says);
    // The line that has always held: a title with RAM and storage must not fight
    // a spec naming only one of them.
    ok(!run('PC 8GB RAM 512GB SSD', { 'Storage 1': '512GB' }).some(x => x.code === 'spec-conflict'),
       'RAM and storage in one title do not fight');
}

console.log('\n' + (fails ? fails + ' FAILED' : 'all passed') + '\n');
process.exit(fails ? 1 : 0);
