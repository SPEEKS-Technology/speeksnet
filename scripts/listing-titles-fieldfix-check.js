// FIELD CORRECTIONS — a title fix carries its own "Platform = Apple II".
//
// Ethan, 2026-09-30: "the idea of this system is the beginning parts of listing
// review by fixing titles and adjusting parts of the listing that reflected the
// poor title." Three feedback fixes had just landed as TITLES ONLY: the run-carry
// (planEchoes) cannot place a rewrite, so Platform went on saying PC under a
// title saying Apple II. planFieldFixes writes a NAMED field's value everywhere
// the listing states that field. The fixtures below are the shapes of those three
// real listings (LEE Might and Magic, Meraki MS250, Gogeta PSA slab).
//
// What it asserts:
//    1. the spec-table row, the metafield and every attribute-array entry move
//    2. a cell's marker <div> survives — spliced, never rebuilt
//    3. What's Included, which has no spec row, is swapped where the
//       description prints it ("Items included in this sale")
//    4. a field the listing does not have is reported, never invented
//    5. a field already right is neither rewritten nor reported missing
//    6. bad input is refused: placeholders, markup, too many, missing parts
//    7. other fields and other keys inside the same arrays are untouched
//
// Run: node scripts/listing-titles-fieldfix-check.js
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

const block = [
    between('const PLACEHOLDER = /', '\n\n'),
    between('const stripTags = ', '\n\n'),
    between('const HTML_ENTITY = /', 'function decodeWithMap'),
    between('function decodeWithMap', '// --- THE REST OF THE LISTING'),
    between('function specCells(', '\n}\n') + '\n}\n',
    between('function jsonPairs(', '\n}\n') + '\n}\n',
    between('type FieldFix = ', 'async function handlePost('),
].join('\n\n');

// Same approach as listing-titles-echo-check.js: return types go by locating
// the body's opening brace, then the annotations this block uses.
function stripReturnTypes(s) {
    let out = '', i = 0;
    for (;;) {
        const at = s.indexOf('function ', i);
        if (at < 0) { out += s.slice(i); break; }
        const open = s.indexOf('(', at);
        let depth = 0, close = open;
        for (; close < s.length; close++) {
            if (s[close] === '(') depth++;
            else if (s[close] === ')' && --depth === 0) break;
        }
        let body = close;
        while (body < s.length && !(s[body] === '{' && /^[ \t]*\r?\n/.test(s.slice(body + 1)))) body++;
        out += s.slice(i, close + 1) + ' ';
        i = body;
    }
    return out;
}
const js = stripReturnTypes(block)
    .replace(/^type\s+\w+\s*=\s*\{[^\n]*\};$/gm, '')
    .replace(/(\w+)\s*:\s*\{[^{}]*\}(\[\])?/g, '$1')
    .replace(/(\w+)\s*:\s*Record<[^>]*>/g, '$1')
    .replace(/(\w+)\s*:\s*(string|number|boolean|unknown|any)(\[\])?(\s*\|\s*null)?/g, '$1')
    .replace(/(\w+)\s*:\s*(RegExpExecArray|Echo|FieldFix)(\[\])?(\s*\|\s*null)?/g, '$1')
    .replace(/new (Map|Set)<[^>]*>\(/g, 'new $1(')
    .replace(/\(\s*(\w+)\s+as\s+any\s*\)/g, '$1')
    .replace(/\bas\s+Record<[^>]*>/g, '');

let parseFieldFixes, planFieldFixes;
try {
    ({ parseFieldFixes, planFieldFixes } = new Function(js
        + '\nreturn { parseFieldFixes, planFieldFixes };')());
} catch (e) {
    ok(false, 'could not lift the code out of index.ts', e.message);
    process.exit(1);
}

const row = (k, v) => `<tr style="height: 18px;"> <td style="width: 50%;"> ${k} </td> `
    + `<td style="width: 50%; color:black; "> ${v} <div style="color:red; font-weight: bold;"></div> </td> </tr>`;
const table = rows => `<table><tbody>${rows.map(([k, v]) => row(k, v)).join('')}</tbody></table>`;
const mf = (key, value, id) => ({ id: id || 'gid://mf/' + key, key, value });
const pairs = o => JSON.stringify(Object.entries(o).map(([key, value]) => ({ key, value })));

console.log('\n== 1. Might and Magic: every place the field is stated ==');
{
    const html = '<h1>Might and Magic Book One Secret of the Inner Sanctum (Apple II, 1986)</h1>'
        + table([['Platform', 'PC'], ['Game Name', 'Might and Magic II Book One'], ['Release Year', '1986']]);
    const mfs = [
        mf('platform', 'PC'), mf('game_name', 'Might and Magic II Book One'),
        mf('model', 'II Might and Magic II'), mf('brand', 'Apple'),
        mf('filter_attributes', pairs({ Platform: 'PC', 'Game Name': 'Might and Magic II Book One',
                                        Brand: 'Apple', Model: 'II Might and Magic II' })),
        mf('title_attributes', pairs({ 'Game Name': 'Might and Magic II Book One', Platform: 'PC',
                                       'Release Year': '1986' })),
    ];
    const fixes = parseFieldFixes([
        { field: 'Platform', value: 'Apple II' },
        { field: 'Game Name', value: 'Might and Magic Book One: Secret of the Inner Sanctum' },
        { field: 'Model', value: 'Might and Magic Book One' }]);
    const r = planFieldFixes(html, mfs, fixes);
    ok(r.html.includes('> Apple II <div'), 'spec row Platform -> Apple II');
    ok(!/> PC </.test(r.html), 'and PC is gone from the table');
    ok(r.html.includes('> Might and Magic Book One: Secret of the Inner Sanctum <div'), 'spec row Game Name moved');
    ok(r.html.includes('<div style="color:red; font-weight: bold;"></div>'), "the cell's marker div survives");
    ok(r.html.includes('> 1986 <'), 'Release Year untouched');
    ok(r.mfUpdates.get('gid://mf/platform') === 'Apple II', 'custom.platform');
    ok(r.mfUpdates.get('gid://mf/game_name') === 'Might and Magic Book One: Secret of the Inner Sanctum', 'custom.game_name');
    ok(r.mfUpdates.get('gid://mf/model') === 'Might and Magic Book One', 'custom.model');
    ok(!r.mfUpdates.has('gid://mf/brand'), 'Brand untouched');
    const fa = JSON.parse(r.mfUpdates.get('gid://mf/filter_attributes') || '[]');
    const byKey = Object.fromEntries(fa.map(p => [p.key, p.value]));
    ok(byKey.Platform === 'Apple II' && byKey.Model === 'Might and Magic Book One' && byKey.Brand === 'Apple',
       'filter_attributes: the named keys move, Brand stays', JSON.stringify(byKey));
    const ta = JSON.parse(r.mfUpdates.get('gid://mf/title_attributes') || '[]');
    ok(ta.map(p => p.key).join() === 'Game Name,Platform,Release Year', 'title_attributes keeps its order');
    ok(r.notFound.length === 0, 'nothing reported missing', r.notFound.join());
}

console.log("\n== 2. Meraki: What's Included has no spec row, the description line moves ==");
{
    const old = 'Cisco Meraki 48-Port 10 Gigabit/Multi-Gigabit Ethernet Switch MS250-48LP-HW Unclaimed';
    const neu = 'Cisco Meraki MS250-48LP-HW 48-Port Gigabit PoE+ Switch Unclaimed';
    const html = `<h2>Items included in this sale:</h2><span><div>${old}</div></span>`
        + table([['Type', '10 Gigabit/Multi-Gigabit Ethernet Switch']]);
    const mfs = [mf('type', '10 Gigabit/Multi-Gigabit Ethernet Switch'), mf('whats_include', old)];
    const r = planFieldFixes(html, mfs, parseFieldFixes([
        { field: 'Type', value: 'Gigabit PoE+ Ethernet Switch' },
        { field: "What's Included", value: neu }]));
    ok(r.html.includes(`<div>${neu}</div>`), 'the Items-included line is the new value');
    ok(!r.html.includes(old), 'and the old one is gone');
    ok(r.mfUpdates.get('gid://mf/whats_include') === neu, "What's Included finds whats_include");
    ok(r.html.includes('> Gigabit PoE+ Ethernet Switch <div'), 'Type row moved');
}

console.log("\n== 2b. Canon AE-1: What's Included printed one item per line ==");
{
    const head = '<h2><span>Items included in this sale:</span></h2>'
        + '<div style="display: flex; flex-direction: column;">\n    ';
    const html = head + '<span><div>Canon AE-1 Program 35mm SLR Film Camera</div></span>'
        + '<span><div>Shoulder/Neck Strap</div></span><span><div>Camera Body Cap</div></span>\n  </div><p>note</p>';
    const neu = 'Canon FD 50mm f/1.8 Lens, Zoom Lens, Vivitar Flash, Camera Bag, Lens Cap, Shoulder/Neck Strap';
    const r = planFieldFixes(html, [mf('whats_include', 'Shoulder/Neck Strap, Camera Body Cap')],
        parseFieldFixes([{ field: "What's Included", value: neu }]));
    const lines = [...r.html.matchAll(/<span><div>([\s\S]*?)<\/div><\/span>/g)].map(m => m[1]);
    ok(lines[0] === 'Canon AE-1 Program 35mm SLR Film Camera', "the title's own line is kept first", lines[0]);
    ok(lines.slice(1).join(', ') === neu, 'then one line per new item', lines.slice(1).join(' | '));
    ok(!r.html.includes('Camera Body Cap'), 'the old items are gone');
    ok(r.html.endsWith('\n  </div><p>note</p>'), 'the container and what follows are untouched');
    // A list somebody edited by hand is reported, never overwritten.
    const hand = html.replace('Camera Body Cap', 'Body Cap (added by hand)');
    const r2 = planFieldFixes(hand, [mf('whats_include', 'Shoulder/Neck Strap, Camera Body Cap')],
        parseFieldFixes([{ field: "What's Included", value: neu }]));
    ok(r2.html === hand && /edit it by hand/.test(r2.notFound.join()), 'a mismatched list is left and reported',
       r2.notFound.join());
}

console.log('\n== 3. Gogeta: N/A rows are real rows, and get real values ==');
{
    const html = table([['Model', 'Gogeta SSB PSA'], ['MPN', 'N/A'], ['Type', 'N/A']]);
    const mfs = [mf('model', 'Gogeta SSB PSA'),
                 mf('filter_attributes', pairs({ Model: 'Gogeta SSB PSA', MPN: 'N/A', Type: 'N/A' }))];
    const r = planFieldFixes(html, mfs, parseFieldFixes([
        { field: 'MPN', value: 'BT11-012' }, { field: 'Type', value: 'Trading Card' }]));
    ok(r.html.includes('> BT11-012 <div') && r.html.includes('> Trading Card <div'), 'both N/A rows filled');
    ok(!r.mfUpdates.has('gid://mf/mpn'), 'no custom.mpn is invented');
    const fa = Object.fromEntries(JSON.parse(r.mfUpdates.get('gid://mf/filter_attributes')).map(p => [p.key, p.value]));
    ok(fa.MPN === 'BT11-012' && fa.Model === 'Gogeta SSB PSA', 'filter_attributes: MPN moves, Model stays');
}

console.log('\n== 4/5. Missing fields are reported; right fields are left alone ==');
{
    const html = table([['Platform', 'Apple II']]);
    const r = planFieldFixes(html, [mf('platform', 'Apple II')], parseFieldFixes([
        { field: 'Platform', value: 'Apple II' }, { field: 'Color', value: 'Black' }]));
    ok(r.html === html && r.mfUpdates.size === 0, 'an already-right field writes nothing');
    ok(r.notFound.join() === 'Color', 'a field the listing lacks is reported, not created', r.notFound.join());
}

console.log('\n== 6. Bad input is refused ==');
{
    ok(typeof parseFieldFixes([{ field: 'MPN', value: 'N/A' }]) === 'string', 'a placeholder value');
    ok(typeof parseFieldFixes([{ field: 'Type', value: '<b>x</b>' }]) === 'string', 'markup');
    ok(typeof parseFieldFixes([{ field: '', value: 'x' }]) === 'string', 'no field name');
    ok(typeof parseFieldFixes(new Array(13).fill({ field: 'A', value: 'b' })) === 'string', 'more than 12');
    ok(typeof parseFieldFixes('Platform=Apple II') === 'string', 'not a list');
    const none = parseFieldFixes(undefined);
    ok(Array.isArray(none) && none.length === 0, 'absent means none, not an error');
}

console.log('\n' + (fails ? fails + ' FAILED' : 'all passed') + '\n');
process.exit(fails ? 1 : 0);
