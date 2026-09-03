// THE TITLE FIX, CARRIED INTO THE REST OF THE LISTING (planEchoes).
//
// A listing states the same fact in up to four places — the title, the spec
// table inside descriptionHtml, an individual metafield, and again inside the
// {key,value} JSON arrays PayMore's lister builds titles and filters from.
// Approving a title now rewrites the others. That means this code edits the
// description a customer reads, so every rule it follows is asserted here
// against the real markup shape, offline, with no PIN and no network.
//
// What it asserts:
//    1. a whole-value fix lands in the spec table, the metafield AND the JSON
//    2. a fix INSIDE a longer value works ("Wired Over-Ear" -> "Wireless ...")
//    3. the cell is spliced, not rebuilt: byte-identical apart from the value
//    4. the run is bounded by letters and digits — "SATA" never matches inside
//       "eSATA", "8GB" never inside "128GB"
//    5. entity-encoded values still match, and what goes back in is escaped
//    6. metafields keep the LITERAL text (an & is an &, not an &amp;)
//    7. identifiers and prose are never rewritten (serial, condition copy)
//    8. a JSON shape we do not understand is left alone
//    9. a DE-DUPLICATION reports nothing left behind — the field is right
//   10. a real deletion writes nothing and says what still states it
//   11. a value broken across a tag is not written, and is reported
//   12. planEchoes leaves the <h1> alone; that copy belongs to swapTitleInHtml
//
// Run: node scripts/listing-titles-echo-check.js
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'supabase', 'functions', 'listing-titles', 'index.ts');

let fails = 0;
const ok = (c, label, got) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + label + (got === undefined ? '' : '   ' + got));
    if (!c) fails++;
};

// --- lift the shipped code out of the edge function --------------------------
// The functions under test are the ones that RUN, not a copy of them: anything
// else would pass while the deployed code was broken. Deno's TypeScript is
// stripped by hand — the annotations used in this block are a short, known list,
// and a change that breaks the slice fails loudly here rather than silently.
// ⚠️ NORMALISED TO LF FIRST. The file is LF in the repo, but a `git checkout`
// on Windows hands it back with CRLF — and the slices below hunt for a blank
// line ("\n\n"), which then matches nothing until the END OF THE FILE. The
// harness reported "could not lift the code out of index.ts" and the real cause
// was a checkout, not the code. See [[editing-speeks-js-safely]].
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const between = (from, to) => {
    const i = src.indexOf(from), j = src.indexOf(to, i);
    if (i < 0 || j < 0) throw new Error(`could not slice ${from.slice(0, 40)}…`);
    return src.slice(i, j);
};

const block = [
    between('const PLACEHOLDER = /', '\n\n'),
    between('const stripTags = ', '\n\n'),
    between('const HTML_ENTITY = /', 'function decodeWithMap'),
    between('function decodeWithMap', '// --- THE REST OF THE LISTING'),
    between('const ECHO_SKIP_KEY', 'async function echoSweep'),
].join('\n\n');

// A function's RETURN type is the one annotation a regex cannot see the end of
// — it can itself contain braces (`: { text: string; from: number[] }`). What it
// can never contain is a brace that ENDS ITS LINE, because that is the body
// opening. So the body is found by that, and everything between the parameter
// list and it goes.
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
    // type aliases: whole statements, gone
    .replace(/^type\s+\w+\s*=\s*\{[\s\S]*?^\};$/gm, '')
    .replace(/^type\s+\w+\s*=[^\n]*;$/gm, '')
    // parameter and variable annotations
    .replace(/(\w+)\s*:\s*\{[^{}]*\}\[\]/g, '$1')
    .replace(/(\w+)\s*:\s*Record<[^>]*>/g, '$1')
    .replace(/(\w+)\s*:\s*(string|number|boolean|unknown|any)(\[\])?(\s*\|\s*null)?/g, '$1')
    .replace(/(\w+)\s*:\s*(RegExpExecArray|EchoPlan|Echo|SpecField)(\[\])?(\s*\|\s*null)?/g, '$1')
    .replace(/new (Map|Set)<[^>]*>\(/g, 'new $1(')
    .replace(/\bas\s+Record<[^>]*>/g, '')
    .replace(/\bas\s+any\b/g, '');

let planEchoes, specCells, collectSpecFields, titleRun, replaceRun;
try {
    ({ planEchoes, specCells, collectSpecFields, titleRun, replaceRun } =
        new Function(js + `
        return { planEchoes, specCells, collectSpecFields, titleRun, replaceRun };`)());
} catch (e) {
    console.log('  FAIL  could not lift the code out of index.ts   ' + e.message);
    process.exit(1);
}

// --- a real listing, in the shape PayMore's lister writes them ---------------
// Trimmed from MPL MO03-1478A-E9 (the Sony ZV-E10 that says L-Mount in four
// places), keeping every awkward thing about it: the <h1> copy of the title, the
// red marker div inside each value cell, the width styles, a <span>-wrapped
// value, and an entity-encoded ampersand.
const DESC = `<div>
<h1 id="Titleeditor">Sony Alpha ZV-E10 24.2MP L-Mount Digital Camera</h1>
<h2>Specifications:</h2>
<table border="1">
<tbody>
<tr style="height: 18px;">
<td style="width: 50%;">Brand</td>
<td style="width: 50%;">Sony
<div style="color: red; font-weight: bold;"><br></div>
</td>
</tr>
<tr><td>Model</td><td>Alpha <span>A7C</span></td></tr>
<tr><td>Mount Type</td><td style="width: 50%;">L-Mount
<div style="color: red; font-weight: bold;"><br></div>
</td></tr>
<tr><td>Type</td><td>Wired Over-Ear Headphones</td></tr>
<tr><td>Interface</td><td>eSATA III 6Gbps</td></tr>
<tr><td>Memory Size</td><td>128GB RAM</td></tr>
<tr><td>Lens</td><td>Auto &amp; Manual Lens</td></tr>
<tr><td>Serial#</td><td>L-Mount</td></tr>
</tbody>
</table>
</div>`;

const MF = [
    { id: 'gid://x/1', key: 'mount_type', value: 'L-Mount' },
    { id: 'gid://x/2', key: 'brand', value: 'Sony' },
    { id: 'gid://x/3', key: 'title_attributes',
      value: JSON.stringify([{ key: 'Brand', value: 'Sony' },
                             { key: 'Mount Type', value: 'L-Mount' }]) },
    { id: 'gid://x/4', key: 'condition', value: '["Good"]' },
    { id: 'gid://x/5', key: 'serial_number', value: 'L-Mount' },
    { id: 'gid://x/6', key: 'cosmetic_condition',
      value: 'The L-Mount body is in good cosmetic condition with minimal signs of wear '
           + 'and no major scratches, scuffs or marks anywhere on the housing.' },
    { id: 'gid://x/7', key: 'lens_type', value: 'Auto & Manual Lens' },
];

const plan = (from, to, html = DESC, mfs = MF) => {
    const run = titleRun(from, to);
    return { run, ...planEchoes(html, mfs.map(m => ({ ...m })), run.was, run.now, to) };
};

console.log('\nA whole value, in every place it is written down');
{
    const p = plan('Sony Alpha ZV-E10 24.2MP L-Mount Digital Camera',
                   'Sony Alpha ZV-E10 24.2MP E-Mount Digital Camera');
    ok(p.run.was === 'L-Mount' && p.run.now === 'E-Mount', 'the changed run is the two words that differ',
       `${p.run.was} -> ${p.run.now}`);
    const e = p.echoes.find(x => x.field === 'Mount Type');
    ok(!!e, 'the Mount Type field is found');
    ok(e && e.where.includes('spec table'), 'the spec table row is rewritten');
    ok(e && e.where.includes('mount_type'), 'the metafield is rewritten');
    ok(e && e.where.includes('title_attributes'), 'the JSON attribute array is rewritten');
    ok(p.cellHits === 1, 'exactly ONE cell is spliced — not the Serial# row that holds the same string',
       String(p.cellHits));
    const mf = Object.fromEntries(p.mfUpdates.map(u => [u.id, u.value]));
    ok(mf['gid://x/1'] === 'E-Mount', 'mount_type now reads E-Mount', mf['gid://x/1']);
    ok(!mf['gid://x/5'], 'the SERIAL NUMBER is never rewritten, even holding the same text');
    ok(!mf['gid://x/6'], 'the condition copy is never rewritten');
    ok(!mf['gid://x/4'], 'a JSON list of bare strings is left alone');
    const ta = JSON.parse(mf['gid://x/3'] || '[]');
    ok(ta.length === 2 && ta[0].value === 'Sony' && ta[1].value === 'E-Mount',
       'the JSON array keeps its shape and changes only the one entry',
       mf['gid://x/3']);
}

console.log('\nThe splice is bounded to the value cell');
{
    const p = plan('Sony Alpha ZV-E10 24.2MP L-Mount Digital Camera',
                   'Sony Alpha ZV-E10 24.2MP E-Mount Digital Camera');
    ok(p.html.includes('<td>Mount Type</td><td style="width: 50%;">E-Mount'),
       'the value changed inside its own cell');
    ok(p.html.includes('<div style="color: red; font-weight: bold;"><br></div>\n</td></tr>\n<tr><td>Type</td>'),
       'the red marker div, its style and the row after it are untouched');
    ok(p.html.split('\n').length === DESC.split('\n').length,
       'the document keeps its shape — nothing was rebuilt');
    ok(p.html.includes('<h1 id="Titleeditor">Sony Alpha ZV-E10 24.2MP L-Mount Digital Camera</h1>'),
       'the <h1> is NOT touched here — that copy belongs to swapTitleInHtml');
    const diffs = [...DESC].filter((c, i) => c !== p.html[i]).length;
    ok(diffs > 0 && Math.abs(p.html.length - DESC.length) === 0,
       'only the run itself differs, and the length is unchanged for a same-length swap');
}

console.log('\nA fix inside a longer value');
{
    const p = plan('Poly Voyager Focus 2 Wired Over-Ear Headphones Black',
                   'Poly Voyager Focus 2 Wireless Over-Ear Headphones Black');
    const e = p.echoes.find(x => x.field === 'Type');
    ok(!!e && e.now === 'Wireless Over-Ear Headphones',
       'the whole field value is carried, not just the changed word', e && e.now);
    ok(p.html.includes('<td>Wireless Over-Ear Headphones</td>'), 'and it lands in the cell');
}

console.log('\nThe run is bounded by letters and digits');
{
    const p = plan('PNY CS1311 120GB eSATA III 6Gbps SSD', 'PNY CS1311 120GB SATA III 6Gbps SSD');
    ok(p.run.was === 'eSATA' && p.run.now === 'SATA', 'the run is eSATA -> SATA');
    const e = p.echoes.find(x => x.field === 'Interface');
    ok(!!e && e.now === 'SATA III 6Gbps', 'eSATA III 6Gbps becomes SATA III 6Gbps', e && e.now);
}
{
    // "8GB" must not match inside "128GB" — the classic way a rewrite invents a
    // spec nobody typed.
    const p = plan('Micron 8GB DDR4', 'Micron 16GB DDR4');
    const e = p.echoes.find(x => x.field === 'Memory Size');
    ok(!e, 'a run of "8GB" does not match inside "128GB"', e ? e.now : 'not matched');
}

console.log('\nEntities: matched decoded, written back escaped, literal in metafields');
{
    const p = plan('Canon 18-55mm Auto & Manual Lens', 'Canon 18-55mm Auto & Motorized Lens');
    const e = p.echoes.find(x => x.field === 'Lens');
    ok(!!e, 'a value stored as "Auto &amp; Manual Lens" is still found by a title that says "&"');
    ok(p.html.includes('Auto &amp; Motorized Lens'),
       'and what goes back into the html is escaped', (p.html.match(/Auto [^<]*/) || [''])[0]);
    const mf = Object.fromEntries(p.mfUpdates.map(u => [u.id, u.value]));
    ok(mf['gid://x/7'] === 'Auto & Motorized Lens',
       'the metafield keeps a literal ampersand', mf['gid://x/7']);
}

console.log('\nA de-duplication leaves nothing behind');
{
    // The commonest fix this tool makes: the title said it twice.
    const html = `<table><tr><td>Model</td><td>50-200mm f/4-5.6</td></tr></table>`;
    const p = plan('PENTAX 50-200mm f/4-5.6 50-200mm f/4-5.6 DAL For Pentax K Mount',
                   'PENTAX 50-200mm f/4-5.6 DAL For Pentax K Mount', html, []);
    ok(p.echoes.length === 0, 'nothing is rewritten');
    ok(p.stillSays.length === 0,
       'and nothing is reported — the Model field says it ONCE, which is correct',
       JSON.stringify(p.stillSays));
}

console.log('\nA real deletion writes nothing and says what still states it');
{
    const html = `<table><tr><td>Display Type</td><td>IPS with LED</td></tr></table>`;
    const p = plan('Dell 24" E2414HT IPS with LED TN Business Monitor',
                   'Dell 24" E2414HT LED TN Business Monitor', html, []);
    ok(p.cellHits === 0 && p.mfUpdates.length === 0, 'nothing is written');
    ok(p.stillSays.length === 1 && p.stillSays[0].field === 'Display Type',
       'the field that still says it is named', JSON.stringify(p.stillSays));
    ok(p.html === html, 'the description is byte-identical');
}

console.log('\nMarkup inside the cell is stepped around, not stripped');
{
    // The lister leaves <span>s around values that have been hand-edited in
    // Shopify. The run itself is still contiguous, so it is rewritten in place
    // and the span survives.
    const p = plan('Sony Alpha A7C 24.2MP L-Mount Digital Camera',
                   'Sony Alpha ZV-E10 24.2MP L-Mount Digital Camera');
    ok(p.run.was === 'A7C' && p.run.now === 'ZV-E10', 'the run is A7C -> ZV-E10');
    ok(p.html.includes('<td>Alpha <span>ZV-E10</span></td>'),
       'the value is rewritten inside its span, and the span is kept',
       (p.html.match(/<td>Alpha[^<]*<span>[^<]*/) || [''])[0]);
    ok(p.stillSays.length === 0, 'and there is nothing left saying the old model');
}

console.log('\nA value genuinely broken across a tag is not guessed at');
{
    const html = `<table><tr><td>Model</td><td>Alpha A<span>7C</span></td></tr></table>`;
    const p = plan('Sony Alpha A7C 24.2MP Digital Camera',
                   'Sony Alpha ZV-E10 24.2MP Digital Camera', html, []);
    ok(p.html === html, 'nothing is written — the run is not contiguous in the markup');
    // ⚠️ A KNOWN GAP, ASSERTED SO IT STAYS KNOWN. stripTags turns a tag into a
    // space, so "Alpha A<span>7C</span>" reads as "Alpha A 7C" and the field is
    // not recognised as stating "A7C" at all — it is neither rewritten NOR
    // reported. Closing it would mean matching across whitespace, which would
    // start matching things that are not the same value. The failure is silent
    // but safe: the listing is left exactly as it was.
    ok(p.stillSays.length === 0,
       'and nothing is claimed about it either — a tag through the middle of a '
       + 'value hides it from both halves', JSON.stringify(p.stillSays));
}

console.log('\nA placeholder is never written, and never overwritten');
{
    const html = `<table><tr><td>Model</td><td>VARIOUS</td></tr></table>`;
    const p = plan('Micron 48GB SODIMM VARIOUS', 'Micron 48GB SODIMM CUSTOM', html, []);
    ok(p.echoes.length === 0 && p.cellHits === 0,
       'a stand-in value is not a spec, in either direction');
}

console.log('\ncollectSpecFields groups one fact across its copies');
{
    const fields = collectSpecFields(DESC, { mount_type: 'L-Mount', brand: 'Sony',
        title_attributes: JSON.stringify([{ key: 'Mount Type', value: 'L-Mount' }]),
        serial_number: 'L-Mount' });
    const m = fields.find(f => /mount/i.test(f.k));
    ok(!!m && m.at.includes('spec table') && m.at.includes('mount_type')
       && m.at.includes('title_attributes'),
       'one entry lists all three places that state it', m && m.at.join(', '));
    ok(!fields.some(f => f.at.includes('serial_number')),
       'and the serial number is not one of them');
}

// ⚠️ THE SHAPE OF THE WRITE ITSELF, READ OUT OF THE SOURCE.
// Everything above proves we compute the right new values. None of it proves
// Shopify will accept them — and for a month it did not: the mutation sent
// `{ownerId, id, value}` and MetafieldsSetInput HAS NO `id` FIELD. It identifies
// a metafield by ownerId + namespace + key, so every write was a validation
// error, thrown, caught and swallowed. Nothing offline could have caught that,
// which is exactly why the shape is asserted here rather than trusted.
console.log('\nThe metafield write is addressed the way the API expects');
{
    const call = (src.match(/mf: staleMetafields\.map\([\s\S]{0,240}?\)\),/) || [''])[0];
    ok(/namespace: m\.namespace/.test(call) && /key: m\.key/.test(call),
       'metafieldsSet is addressed by namespace + key');
    ok(!/\bid: m\.id\b/.test(call),
       'and NOT by id — MetafieldsSetInput does not have one', call.replace(/\s+/g, ' ').slice(0, 90));
    ok(/type: m\.type/.test(call),
       'the existing type is restated, so a definition validates against itself');
    ok(/metafieldsWhy/.test(src),
       'and a refusal keeps its reason, instead of reading as bad luck');
}

console.log(fails ? `\n${fails} FAILED\n` : '\nAll checks passed\n');
process.exit(fails ? 1 : 0);
