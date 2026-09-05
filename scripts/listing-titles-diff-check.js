// THE NOW / SUGGESTED DIFF — the two lines a reviewer reads before clicking
// Approve, and therefore the two lines that must not lie about what will happen.
//
// ⚠️ THE CHANGED RUN IS NOT THE SAME THING AS THE CHANGED WORDS. _ltRun finds a
// single span between a common head and a common tail. That is exactly right
// for a replacement, and wrong the moment a title gains a word in the MIDDLE and
// another at the END:
//
//   now        Broken Unlocked Apple iPhone 15 Plus 128GB 26.6 MTXT3LL/A Read
//   suggested  Broken Unlocked Apple iPhone 15 Plus 6.7" 128GB 26.6 MTXT3LL/A Read Pink
//
// The head stops at "Plus" and the tail never starts, so the run swallows
// everything between — and the Now line struck "128GB 26.6 MTXT3LL/A Read"
// through in red, claiming the tool was DELETING words it keeps verbatim. Red
// means removed on this screen. Saying it about kept words is a lie about the
// action somebody is one click away from taking.
//
// It appeared the moment the screen size started being PLACED after the model
// instead of appended, so it is a direct cost of that fix and belongs here.
//
// What this asserts:
//   1. the real iPhone row: nothing struck out, only the two added words green
//   2. a genuine replacement still marks both sides
//   3. a pure deletion still marks the deleted words — and does not weld the
//      halves together, which is the older bug this file must not undo
//   4. repeated words are counted, not set-matched
//   5. every rendering is still character-for-character the original title
//
// Run: node scripts/listing-titles-diff-check.js
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'speeks.js');

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
    between('const _ecEsc = s =>', '\n\nconst _ecMoney'),
    between('function _ltRun(from, to) {', '\n\n// One side of that diff'),
    between('// ⚠️ THE CHANGED RUN IS NOT THE SAME THING', '\n\n// WHAT THE SUGGESTION TOOK OUT'),
    between('function _ltDiff(from, to) {', '\n\n// The current title, with the words it LOSES'),
    between('function _ltGone(from, to) {', '\n\n// WHAT WAS DISMISSED'),
].join('\n\n');

let _ltDiff, _ltGone;
try {
    const m = new Function(js + '\nreturn { _ltDiff: _ltDiff, _ltGone: _ltGone };')();
    _ltDiff = m._ltDiff; _ltGone = m._ltGone;
} catch (e) {
    console.error('could not lift the diff:\n' + e.message);
    console.error('\n--- lifted ---\n' + js);
    process.exit(1);
}

// The marked words on one side, and the plain text with the markup stripped.
// ⚠️ UNESCAPE BOTH. The marked words are HTML-escaped like everything else, so
// a comparison against `6.7"` fails on `6.7&quot;` — a green tick's worth of
// difference that reads as a broken diff. Inch marks are in half these titles.
const unesc = s => s
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const marked = html => (html.match(/<mark[^>]*>(.*?)<\/mark>/g) || [])
    .map(m => unesc(m.replace(/<[^>]*>/g, '')));
const plain = html => unesc(html.replace(/<[^>]*>/g, ''));

console.log('\n== 1. The row that exposed it: WSP MO02-4723A-E2 ==');
{
    const now = 'Broken Unlocked Apple iPhone 15 Plus 128GB 26.6 MTXT3LL/A Read';
    const sug = 'Broken Unlocked Apple iPhone 15 Plus 6.7" 128GB 26.6 MTXT3LL/A Read Pink';
    const gone = _ltGone(now, sug), add = _ltDiff(now, sug);
    // ⚠️ THE WHOLE POINT. Nothing is being removed, so nothing may be red.
    ok(marked(gone).length === 0, 'nothing on the Now line is struck through',
       JSON.stringify(marked(gone)));
    ok(JSON.stringify(marked(add)) === JSON.stringify(['6.7"', 'Pink']),
       'and exactly the two added words are green', JSON.stringify(marked(add)));
    ok(plain(gone) === now, 'the Now line still reads as the real title');
    ok(plain(add) === sug, 'and the Suggested line as the real suggestion');
}

console.log('\n== 2. A genuine replacement still marks both sides ==');
{
    const now = 'Call of Duty: Black Ops II (Microsoft Xbox One, 2018)';
    const sug = 'Call of Duty: Black Ops II (Microsoft Xbox 360, 2012)';
    ok(JSON.stringify(marked(_ltGone(now, sug))) === JSON.stringify(['One,', '2018)']),
       'the old values are struck through', JSON.stringify(marked(_ltGone(now, sug))));
    ok(JSON.stringify(marked(_ltDiff(now, sug))) === JSON.stringify(['360,', '2012)']),
       'and the new ones marked as added', JSON.stringify(marked(_ltDiff(now, sug))));
}

console.log('\n== 3. A pure deletion still shows, and is not welded ==');
{
    // ⚠️ THE OLDER BUG THIS FILE MUST NOT UNDO. A build that concatenated the
    // head and tail with a conditional space rendered "GoPro Hero11 Black 27MP
    // Action Camera" as "27MPAction Camera" — the SAVED title was always right,
    // but this is the line read before approving.
    const now = 'GoPro Hero11 Black 27MP 360 Action Camera CHDHX-111';
    const sug = 'GoPro Hero11 Black 27MP Action Camera CHDHX-111';
    const gone = _ltGone(now, sug);
    ok(JSON.stringify(marked(gone)) === JSON.stringify(['360']),
       'the deleted word is struck through', JSON.stringify(marked(gone)));
    ok(marked(_ltDiff(now, sug)).length === 0, 'and the Suggested line marks nothing');
    ok(plain(gone) === now, 'the Now line is the real title, spacing and all');
    ok(!/27MPAction/.test(plain(gone)), 'and the halves are not welded together');
    ok(plain(_ltDiff(now, sug)) === sug, 'the Suggested line is the real suggestion');
}

console.log('\n== 4. Repeated words are counted, not set-matched ==');
{
    // ⚠️ A SET WOULD SAY "Black is on both sides" AND MARK NOTHING. Losing one
    // of two identical words is a real edit and has to show.
    const now = 'Sony WH-1000XM4 Black Black Headphones';
    const sug = 'Sony WH-1000XM4 Black Headphones';
    ok(JSON.stringify(marked(_ltGone(now, sug))) === JSON.stringify(['Black']),
       'one of the two Blacks is struck through', JSON.stringify(marked(_ltGone(now, sug))));
    // And the reverse: gaining a duplicate marks the new one.
    ok(JSON.stringify(marked(_ltDiff(sug, now))) === JSON.stringify(['Black']),
       'and gaining one marks the new one', JSON.stringify(marked(_ltDiff(sug, now))));
}

console.log('\n== 5. Nothing is ever added to or lost from the text ==');
{
    const pairs = [
        ['A B C', 'A B C'],
        ['A B C', 'A X C'],
        ['A B C', 'A B C D'],
        ['A B C D', 'A B C'],
        ['Lenovo 34" T43WD-40 Monitor', 'Lenovo 34" T43WD-40 WQHD VA Monitor'],
        ['Apple iPad 10.2" 64GB', 'Apple iPad 10.2" 64GB Silver'],
    ];
    let good = 0;
    for (const [a, b] of pairs) {
        if (plain(_ltGone(a, b)) === a && plain(_ltDiff(a, b)) === b) good++;
        else console.log('    mismatch: ' + JSON.stringify([a, b, plain(_ltGone(a, b)), plain(_ltDiff(a, b))]));
    }
    ok(good === pairs.length, 'both lines round-trip to the real strings',
       good + '/' + pairs.length);
    // An identical pair marks nothing at all.
    ok(marked(_ltGone('A B C', 'A B C')).length === 0
       && marked(_ltDiff('A B C', 'A B C')).length === 0,
       'and an unchanged title marks nothing');
    // Quotes have to survive escaping, since inch marks are everywhere here.
    ok(plain(_ltDiff('Apple iPad 64GB', 'Apple iPad 10.2" 64GB')) === 'Apple iPad 10.2" 64GB',
       'an inch mark survives the escaping intact');
}

console.log('\n' + (fails ? fails + ' FAILED' : 'all passed') + '\n');
process.exit(fails ? 1 : 0);
