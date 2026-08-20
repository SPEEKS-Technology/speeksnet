// The bug that shipped: an edit anchored on a unique string landed inside a
// DIFFERENT function from the variables it referenced, so `chosenCategory is not
// defined` threw on every real publish. esbuild parses it happily — an undefined
// identifier is only an error at runtime — and dry runs return before reaching it.
//
// So: parse the file and report, for each identifier of interest, which
// top-level function every reference sits in. More than one owner, or an owner
// that is not where it is declared, is the smell.
const fs = require('fs');
const esbuild = require('esbuild');
const P = process.argv[2] || 'c:/Users/User/Documents/GitHub/speeksnet/supabase/functions/ebay-sync/index.ts';
const src = fs.readFileSync(P, 'utf8');
const lines = src.split(/\r?\n/);

// Top-level function declarations, by line.
const fns = [];
lines.forEach((l, i) => {
    const m = l.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (m) fns.push({ line: i + 1, name: m[1] });
});
const owner = n => {
    let cur = '(top level)';
    for (const f of fns) { if (f.line <= n) cur = f.name; else break; }
    return cur;
};

const NAMES = process.argv[3]
    ? process.argv[3].split(',')
    : ['chosenCategory', 'lockedCategory', 'descriptionCleaned', 'lockRow',
       'rawDescription', 'marketOverwhelms', 'suggestedShare', 'bestShare',
       'suggestedInMarket', 'categoryId', 'categoryName'];

let bad = 0;
for (const nm of NAMES) {
    const re = new RegExp('\\b' + nm.replace(/[$]/g, '\\$') + '\\b');
    const hits = [];
    lines.forEach((l, i) => {
        const t = l.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        if (re.test(l)) hits.push({ line: i + 1, fn: owner(i + 1) });
    });
    if (!hits.length) { console.log(nm.padEnd(20) + '  (no references)'); continue; }
    const owners = [...new Set(hits.map(h => h.fn))];
    const flag = owners.length > 1 ? '   <<< SPANS ' + owners.length + ' FUNCTIONS' : '';
    if (owners.length > 1) bad++;
    console.log(nm.padEnd(20) + hits.length + ' refs in: ' + owners.join(', ') + flag);
    if (owners.length > 1) hits.forEach(h => console.log('      line ' + h.line + '  ' + h.fn));
}
console.log('\n' + (bad ? bad + ' identifier(s) referenced from more than one function — check each' : 'every identifier stays inside one function'));
process.exit(bad ? 1 : 0);
