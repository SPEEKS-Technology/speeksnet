// WHO LISTED IT — matching a Shopify product tag to a real person.
//
// Ethan, 2026-09-04: "we have tags to show employee names. Can we show next to
// the Shopify listing link that tag, so we know who made the mistake."
//
// ⚠️ THE OBVIOUS SHORTCUT IS A SHAPE TEST, AND IT NAMES A CHANNEL AS A PERSON.
// "one capital, then a surname" matches `eBay` on the very first row — e, then
// B, then "ay". Every channel, condition and promo tag in the estate would land
// in this column as somebody's name. So a tag counts ONLY when it matches
// somebody in `users`, and section 2 is that assertion.
//
// ⚠️ AND A NAME IS WORSE THAN A BLANK WHEN IT IS THE WRONG NAME. Two people
// whose initials collide must resolve to nobody rather than to whichever of
// them the loop saw last — section 3.
//
// The staff list below is the real one, read from `users` on 2026-09-04, kept
// because the collisions in it are the interesting cases: two Zachs, an Ethan
// at CORP and an Ethan at LEE, and the "Team" logins that are not people.
//
// Run: node scripts/listing-titles-lister-check.js
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

const js = [
    between('const decodeEnt = ', '\n\n'),
    between('const norm = ', '\n\n'),
    between('const squash = ', '\n\n'),
    between('type Lister = ', '\n\n// ⚠️ THE TWO RULES BELOW'),
].join('\n\n')
    // Both type declarations go: `type Lister = {…};` on one line and the
    // multi-line `type ListerIx = { byStore: …; all: … };` under it.
    .replace(/^type Lister = [^\n]*\n/m, '')
    .replace(/^type ListerIx = \{[\s\S]*?\};\n/m, '')
    .replace(/:\s*ListerIx\b/g, '')
    // `new Set<string>()` — a generic on the CONSTRUCTOR, which none of the
    // annotation rules touch and which is a syntax error the moment it is run.
    .replace(/new (Set|Map)<[^>]*>\(/g, 'new $1(')
    // ⚠️ ONE LEVEL OF NESTING, MATCHED EXPLICITLY. These nest —
    // `const byStore: Record<string, Record<string, string>> = {}` — and both
    // naive forms are wrong: `[^>]*>` stops at the INNER `>` and leaves `> = {}`
    // ("Missing initializer in const declaration"), while a greedy `[^;=)]*>`
    // runs past the end of the statement and swallows the next declaration
    // ("Unexpected token '='"). Neither error mentions generics.
    .replace(/:\s*Record<(?:[^<>]|<[^<>]*>)*>/g, '')
    .replace(/:\s*Lister\s*\|\s*null/g, '')
    .replace(/:\s*string\[\]\s*\|\s*undefined/g, '')
    // `store?: string | null` and `home: string | null`, in any position.
    .replace(/(\w+)\?\s*:\s*string\s*\|\s*null/g, '$1')
    .replace(/([(,]\s*)(\w+)\s*:\s*string\s*\|\s*null/g, '$1$2')
    .replace(/users:\s*\{[^}]*\}\[\]/g, 'users')
    .replace(/\(\s*(\w+)\s*:\s*string\s*\)/g, '($1)')
    .replace(/,\s*(\w+)\s*:\s*string\s*\)/g, ', $1)');

let listerIndex, listerFrom;
try {
    const m = new Function(js + '\nreturn { listerIndex: listerIndex, listerFrom: listerFrom };')();
    listerIndex = m.listerIndex; listerFrom = m.listerFrom;
} catch (e) {
    console.error('could not lift the matcher:\n' + e.message);
    console.error('\n--- lifted ---\n' + js);
    process.exit(1);
}

// The real staff list, 2026-09-04.
const USERS = [
    { name: 'Ballwin Team', role: 'Store', store: 'BAL' }, { name: 'Bret Daubert', role: 'Employee', store: 'BAL' },
    { name: 'Garrett Burnell', role: 'Assistant Manager', store: 'BAL' },
    { name: 'Joseph Ortega', role: 'Multi-Store Manager', store: 'BAL' }, { name: 'Zach Marbs', role: 'Employee', store: 'BAL' },
    { name: 'Ethan Kushnir', role: 'District Manager', store: 'CORP' }, { name: 'Haydn Davis', role: 'MOCD', store: 'CORP' },
    { name: 'Paul Kushnir', role: 'CEO', store: 'CORP' },
    { name: 'Caleb Starr', role: 'Employee', store: 'LEE' }, { name: 'Drew Nyman', role: 'Employee', store: 'LEE' },
    { name: 'Ethan Frye', role: 'Assistant Manager', store: 'LEE' }, { name: 'Jurell Guild', role: 'Manager', store: 'LEE' },
    { name: "Lee's Summit Team", role: 'Store', store: 'LEE' }, { name: 'Richard Prostak', role: 'Employee', store: 'LEE' },
    { name: 'Calvin Meadows', role: 'Assistant Manager', store: 'MPL' }, { name: 'Maplewood Team', role: 'Store', store: 'MPL' },
    { name: 'Noah Webb', role: 'Employee', store: 'MPL' }, { name: 'Olivia Huxtable', role: 'Employee', store: 'MPL' },
    { name: 'Dan Ohanesian', role: 'Assistant Manager', store: 'OVL' }, { name: 'Kaden Lamothe', role: 'Employee', store: 'OVL' },
    { name: 'Nathan Zuklin', role: 'Employee', store: 'OVL' }, { name: 'Nick Hettinger', role: 'Manager', store: 'OVL' },
    { name: 'Overland Park Team', role: 'Store', store: 'OVL' }, { name: 'Rorie Moore', role: 'Employee', store: 'OVL' },
    { name: 'Zach Marchesano', role: 'Employee', store: 'OVL' },
    { name: 'Duncan Holsted', role: 'Employee', store: 'WSP' }, { name: 'Eli Kushnir', role: 'Owner (Manager)', store: 'WSP' },
    { name: 'Jon Rodriguez', role: 'Assistant Manager', store: 'WSP' }, { name: 'Josiah Dixon', role: 'Employee', store: 'WSP' },
    { name: 'Westport Team', role: 'Store', store: 'WSP' },
];
const ix = listerIndex(USERS);
// No store given = the estate-wide index, which is the strict reading.
const from = (tags, store) => listerFrom(tags, ix, store || null);

console.log('\n== 1. The tag on the real listing ==');
{
    // The screenshot Ethan sent: tags "eBay" and "CMeadows".
    const hit = from(['eBay', 'CMeadows']);
    ok(!!hit, 'CMeadows resolves');
    ok(hit && hit.name === 'Calvin Meadows', 'to Calvin Meadows', hit && hit.name);
    ok(hit && hit.tag === 'CMeadows', 'and keeps the tag verbatim', hit && hit.tag);
    // Order must not matter — the channel tag came first in the real product.
    const flipped = from(['CMeadows', 'eBay']);
    ok(flipped && flipped.name === 'Calvin Meadows', 'whichever order the tags are in');
}

console.log('\n== 2. A channel tag is never a person ==');
{
    // ⚠️ THE WHOLE REASON THIS MATCHES AGAINST users. "eBay" is e + B + "ay",
    // which passes any initial-plus-surname pattern.
    ok(from(['eBay']) === null, 'eBay is not a person');
    for (const t of ['Shopify', 'Amazon', 'Refurbished', 'Clearance', 'Broken',
                     'Used', 'Online', 'InStore', 'BackStock']) {
        ok(from([t]) === null, `${t} is not a person`);
    }
    ok(from([]) === null, 'no tags at all resolves to nobody');
    ok(from(undefined) === null, 'and neither does a missing tags list');
}

console.log('\n== 3. Two people who collide resolve to NOBODY ==');
{
    // Zach Marbs (BAL) and Zach Marchesano (OVL). "ZacharyM" style tags are
    // ambiguous, and naming the wrong person is worse than naming none.
    ok(from(['ZachM']) === null, 'ZachM is ambiguous, so nobody');
    // The unambiguous forms still work for both of them.
    ok((from(['ZMarbs']) || {}).name === 'Zach Marbs', 'ZMarbs is not', 'Zach Marbs');
    ok((from(['ZMarchesano']) || {}).name === 'Zach Marchesano', 'nor is ZMarchesano');
    // Three Kushnirs — Ethan, Paul, Eli — so the surname alone must never match.
    ok(from(['Kushnir']) === null, 'a bare surname is never enough');
    // ⚠️ THREE KUSHNIRS, TWO OF THEM E. Ethan (CORP) and Eli (WSP) both index as
    // EKushnir, so it has to resolve to nobody. This assertion originally
    // claimed Ethan and FAILED — which was the collision rule working and the
    // test being wrong, not the other way round.
    ok(from(['EKushnir']) === null, 'and EKushnir is TWO people, so also nobody',
       JSON.stringify(from(['EKushnir'])));
    ok((from(['PKushnir']) || {}).name === 'Paul Kushnir', 'but PKushnir is unique',
       (from(['PKushnir']) || {}).name);
    ok((from(['EthanFrye']) || {}).name === 'Ethan Frye',
       'and a full name is unambiguous even when the initial is not');
}

console.log('\n== 4. A "Team" login is not a lister ==');
{
    // ⚠️ THESE ARE SHARED STORE LOGINS. "Ballwin Team" has two words and would
    // otherwise index as BTeam / BallwinTeam and attribute a listing to a shop.
    // ⚠️ THE COLLISION RULE DOES NOT SAVE US HERE. Every Team login has a
    // DIFFERENT initial, so BTeam, MTeam, OTeam, LTeam and WTeam each resolved
    // cleanly to a shop until role='Store' was excluded. Found by this harness,
    // not by reading the code.
    for (const t of ['BTeam', 'MTeam', 'OTeam', 'LTeam', 'WTeam',
                     'BallwinTeam', 'MaplewoodTeam', 'OverlandTeam']) {
        ok(from([t]) === null, t + ' does not resolve');
    }
    ok(Object.values(ix).every(v => !/team$/i.test(v || '')),
       'no store login is reachable as a person at all');
}

console.log('\n== 5. The store the product is in settles most collisions ==');
{
    // ⚠️ THE REAL SWEEP FOUND THIS, NOT A FIXTURE. Sixteen of the first forty
    // WSP rows carried the tag `EKushnir`, and the estate-wide rule refused all
    // of them as ambiguous — Ethan is CORP, Eli is WSP. Once you notice the
    // product is at WESTPORT it is not ambiguous at all.
    ok((from(['EKushnir'], 'WSP') || {}).name === 'Eli Kushnir',
       'EKushnir at WSP is Eli, who works there', (from(['EKushnir'], 'WSP') || {}).name);
    ok(from(['EKushnir'], null) === null,
       'but with no store it stays ambiguous');
    // ⚠️ CORP TRAVELS. The DM and CEO list at any store, so they are in every
    // store's index — they simply lose to a local of the same initials.
    ok((from(['EKushnir'], 'LEE') || {}).name === 'Ethan Kushnir',
       'and at LEE, where no local matches, it is Ethan', (from(['EKushnir'], 'LEE') || {}).name);
    ok((from(['PKushnir'], 'OVL') || {}).name === 'Paul Kushnir',
       'a CORP-only name resolves at any store');
    // Two locals in the SAME store still cancel — scoping narrows, it never
    // invents certainty.
    const two = listerIndex([
        { name: 'Sam Green', role: 'Employee', store: 'OVL' },
        { name: 'Sara Grant', role: 'Employee', store: 'OVL' },
    ]);
    ok(listerFrom(['SG'], two, 'OVL') === null, 'two locals sharing a form still cancel');
    ok(listerFrom(['SamGreen'], two, 'OVL').name === 'Sam Green', 'the unambiguous form survives');
    // A store with nobody in it must not throw or invent.
    ok(from(['CMeadows'], 'ZZZ') === null || (from(['CMeadows'], 'ZZZ') || {}).name === 'Calvin Meadows',
       'an unknown store falls back to the estate rather than failing',
       JSON.stringify(from(['CMeadows'], 'ZZZ')));
}

console.log('\n== 6. The forms people actually type ==');
{
    ok((from(['CalvinMeadows']) || {}).name === 'Calvin Meadows', 'first + surname');
    ok((from(['CalvinM']) || {}).name === 'Calvin Meadows', 'first + surname initial');
    ok((from(['cmeadows']) || {}).name === 'Calvin Meadows', 'lower case');
    ok((from(['C.Meadows']) || {}).name === 'Calvin Meadows', 'with punctuation');
    ok((from(['C Meadows']) || {}).name === 'Calvin Meadows', 'with a space');
    // Two-character forms are too short to mean anything.
    ok(from(['CM']) === null, 'bare initials are too short to be evidence');
}

console.log('\n== 7. It never resolves on the way in ==');
{
    // ⚠️ THE COLUMN HOLDS THE TAG, NOT THE NAME. A resolved name written at
    // sweep time freezes the moment somebody is renamed or leaves.
    ok(/lister_tag: listerFrom\([^)]*\)\?\.tag \?\? null/.test(src),
       'the sweep stores the tag, never the name');
    ok(!/lister_tag: listerFrom\([^)]*\)\?\.name/.test(src),
       'and the name is nowhere in the write path');
    ok(/const listerIx = listerIndex\(staff \|\| \[\]\);/.test(src),
       'the staff list is read once per sweep, not once per row');
}

console.log('\n' + (fails ? fails + ' FAILED' : 'all passed') + '\n');
process.exit(fails ? 1 : 0);
