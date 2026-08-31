// LISTING TITLES — the screen-size rule, and the carrier that already stated the
// lock status. Added 2026-08-31.
//
// This is an ANALYSER harness, not a rendering one: listing-titles-check.js
// photographs the panel from fixtures, and nothing there can tell you whether a
// rule fires on the right products. So this file does the other half.
//
// ⚠️ IT SLICES THE RULES OUT OF index.ts AND EVALUATES THEM. It never retypes a
// regex. The opaque-part-code guard in that file sat DEAD for three days because
// a patch script ate the backslashes off \d and \s and the copy in review looked
// right — a test that retypes the pattern would have passed all three days.
// PART ONE below asserts the sliced patterns are the real ones.
//
//   node scripts/listing-titles-screen-check.js
//     PART ONE  — the slice, and the rules on hand-written cases. No network.
//   T_OVL=shpat_… T_LEE=… T_WSP=… T_MPL=… T_BAL=… node scripts/…
//     PART TWO also — every live in-scope product at the stores whose token is
//     set, which is the only way to see a rule fire somewhere nobody expected.
//     Tokens are in the shopify_stores table; none are stored here.

const fs = require('fs');
const REPO = 'c:/Users/User/Documents/GitHub/speeksnet';
const SRC_PATH = REPO + '/supabase/functions/listing-titles/index.ts';
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const EBAY_TITLE_MAX = 80;

let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

// --- lift the rules out of the edge function ---------------------------------
function sliceDecl(startRe) {
  const m = SRC.match(startRe);
  if (!m) throw new Error('could not find ' + startRe + ' in index.ts');
  const isConst = /^const /.test(m[0]);
  const out = [];
  for (const ln of SRC.slice(m.index).split('\n')) {
    out.push(ln);
    if (isConst ? /;\s*$/.test(ln) : /^\}/.test(ln)) break;
  }
  return out.join('\n');
}

const DECLS = [
  /^const PLACEHOLDER = /m,
  /^const CARRIERS = /m,
  /^function lockStatedByCarrier/m,
  /^const SCREEN_SHELVES = /m,
  /^const SCREEN_NOT = /m,
  /^function screenSizePresent/m,
  /^function screenSizeText/m,
].map(sliceDecl).join('\n\n')
  // The ONLY transformation: drop the TypeScript annotations. Nothing inside a
  // regex literal or a string is touched.
  .replace(/: string \| null(?=\s*\{)/g, '')
  .replace(/: (string|boolean|number)(?=[,)])/g, '')
  .replace(/\)\s*: (string|boolean|number)(?: \| null)?\s*\{/g, ') {');

const R = eval(DECLS + '\n;({ PLACEHOLDER, CARRIERS, lockStatedByCarrier, SCREEN_SHELVES,'
  + ' SCREEN_NOT, screenSizePresent, screenSizeText })');

console.log('\nPART ONE — the slice, and the rules themselves');

// 1. The slice brought back real patterns, not the letters that survive a script
//    eating backslashes. Every one of these is a character class that the dead
//    part-code guard lost.
ok(String(R.CARRIERS).includes('\\b') && String(R.CARRIERS).length > 200,
   'CARRIERS survived the slice with its word boundaries', String(R.CARRIERS).length + ' chars');
ok(/\\d/.test(String(R.screenSizePresent)) && /\\\\d/.test(String(R.screenSizePresent)),
   'screenSizePresent kept both its \\d and its escaped \\\\d');
ok(String(R.SCREEN_SHELVES).includes('\\b') && String(R.SCREEN_NOT).includes('\\b'),
   'both shelf patterns kept their word boundaries');

// 2. THE BUG THAT STARTED THIS. valuePresent() squashes both sides and asks for a
//    substring, so 6.1" -> "61" was found inside "iPhone 16 128GB" and the rule
//    said the size was already there. Two live rows, two stores.
ok(R.screenSizePresent('Factory Unlocked Apple iPhone 16 128GB Black MYAP3LL/A', '6.1"') === false,
   '6.1" is NOT found in "iPhone 16 128GB" (the squash false positive)');
ok(R.screenSizePresent('Factory Unlocked Apple iPhone 16 128GB Teal MYAW3LL/A', '6.1"') === false,
   '6.1" is NOT found in "iPhone 16 128GB Teal" either');

// 3. It still finds a size that IS there, however it is written.
ok(R.screenSizePresent('Dell Latitude 7420 14" i7 16GB RAM 512GB SSD', '14"') === true,
   'an inch mark counts as present');
ok(R.screenSizePresent('HP Chromebook x360 14in Celeron N4120 4GB RAM', '14in') === true,
   '"14in" counts as present');
ok(R.screenSizePresent('Apple MacBook Pro 16 inch M1 Pro 512GB', '16"') === true,
   '"16 inch" counts as present');
ok(R.screenSizePresent('Samsung Galaxy Tab A8 10.5 Inch 32GB', '10.5"') === true,
   '"10.5 Inch" counts as present');

// 4. ⚠️ A BARE NUMBER COUNTS AS PRESENT ON PURPOSE. "13" inside "iPhone 13" is a
//    false PRESENT, and it costs one quiet row. Demanding the inch mark would
//    give a false MISSING, which puts a wrong suggestion in front of a manager.
//    Between a rule that stays quiet and a rule that is wrong out loud, quiet.
ok(R.screenSizePresent('Factory Unlocked Apple iPhone 13 128GB Starlight', '13"') === true,
   'a bare number counts as present — deliberately quiet, never wrong out loud');

// 5. The shelf gate. Phones and tablets are the point; a case is not.
for (const shelf of ['Apple iPhone', 'Android Phones Samsung Phone', 'Apple iPad',
                     'Android Tablet Other Android Tablet', 'Windows Laptops HP Laptop',
                     'Apple Computers Apple MacBook (M-Chip and A-Chip)', 'Monitor',
                     'Windows Desktop/AIO Windows AIO']) {
  ok(R.SCREEN_SHELVES.test(shelf) && !R.SCREEN_NOT.test(shelf), 'shelf is in scope: ' + shelf);
}
for (const shelf of ['Phone Cases', 'Laptop Chargers', 'Tablet Screen Protector',
                     'Phone Repair Parts', 'Laptop Replacement Screen']) {
  ok(R.SCREEN_SHELVES.test(shelf) && R.SCREEN_NOT.test(shelf),
     'shelf is excluded by SCREEN_NOT: ' + shelf);
}
ok(!R.SCREEN_SHELVES.test('Headphones'), '"Headphones" does not read as a phone shelf');
ok(!R.SCREEN_SHELVES.test('Video Games Sony PlayStation 4'), 'a games shelf is out of scope');

// 6. The unit mark is ours, the number is the listing's, and a value that is not
//    a screen measurement is refused rather than guessed at.
ok(R.screenSizeText('14in') === '14"', '"14in" is normalised to 14"');
ok(R.screenSizeText('6.1"') === '6.1"', 'an inch mark is left alone');
ok(R.screenSizeText('1920 x 1080') === null, 'a resolution is not a screen size', '1920 > 120');
ok(R.screenSizeText('2"') === null, 'two inches is not a screen', 'under the 3" floor');
ok(R.screenSizeText('Yes') === null, 'a value with no number is refused');

// 7. THE CARRIER. Ethan, 2026-08-31: "Verizon and T-Mobile are in fact stating it
//    is a T-Mobile device." Those titles were being scored as though the fact was
//    missing, which drags a complete title's strength down.
for (const t of ['Verizon Apple iPhone 13 128GB Midnight MLA23LL/A',
                 'T-Mobile Samsung Galaxy A15 5G 4GB RAM 64GB SM-A156U Blue',
                 'TracFone Samsung Galaxy A14 5G 4GB RAM 64GB SM-S146VL Black',
                 'Consumer Cellular Apple iPad 1st Gen 16GB White MCA14LL/A',
                 'AT&T Apple iPhone 12 64GB Black']) {
  ok(R.lockStatedByCarrier(t, 'Network Locked') === true, 'carrier states the lock: ' + t.slice(0, 42));
}
// ⚠️ ONLY A LOCKED STATUS. A title saying "Verizon" over a spec reading Unlocked
// is a contradiction, not a statement, and must stay missing.
ok(R.lockStatedByCarrier('Verizon Apple iPhone 13 128GB Midnight', 'Unlocked') === false,
   'a carrier does NOT satisfy an Unlocked spec');
ok(R.lockStatedByCarrier('Factory Unlocked Apple iPhone 15 128GB Pink', 'Network Locked') === false,
   'a title with no carrier does not satisfy a locked spec');

// --- PART TWO: the live estate ----------------------------------------------
const STORES = [
  ['OVL', 'paymore-overland-park.myshopify.com', process.env.T_OVL],
  ['LEE', 'paymore-lees-summit.myshopify.com', process.env.T_LEE],
  ['WSP', 'paymore-westport.myshopify.com', process.env.T_WSP],
  ['MPL', 'paymore-maplewood.myshopify.com', process.env.T_MPL],
  ['BAL', 'paymore-ballwin.myshopify.com', process.env.T_BAL],
].filter(s => s[2]);

const stripTags = s => s.replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
  .replace(/&#0*39;|&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
function parseSpecs(html) {                       // same shape as the edge fn's
  const specs = {};
  for (const row of (html.match(/<tr[\s\S]*?<\/tr>/gi) || [])) {
    const cells = row.match(/<td[\s\S]*?<\/td>/gi) || [];
    if (cells.length !== 2) continue;
    const key = stripTags(cells[0]).replace(/[?:]+$/, '').trim();
    const value = stripTags(cells[1]);
    if (key && value) specs[key] = value;
  }
  return specs;
}
const Q = `query($cursor: String) {
  products(first: 100, after: $cursor, query: "status:active inventory_total:>0 published_status:published") {
    pageInfo { hasNextPage endCursor }
    nodes { id title descriptionHtml }
  }
}`;
async function gql(shop, token, variables) {
  const r = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: Q, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

(async () => {
  if (!STORES.length) {
    console.log('\nPART TWO — skipped, no store tokens in the environment');
  } else {
    console.log(`\nPART TWO — the live estate (${STORES.map(s => s[0]).join(', ')})`);
    let fires = 0, offShelf = 0, noRoom = 0, lockStated = 0, scanned = 0;
    const overLong = [], repeats = [], odd = [];
    const byShelf = new Map();

    for (const [code, shop, token] of STORES) {
      let cursor = null; const all = [];
      for (let p = 0; p < 200; p++) {
        const d = await gql(shop, token, { cursor });
        all.push(...d.products.nodes);
        if (!d.products.pageInfo.hasNextPage) break;
        cursor = d.products.pageInfo.endCursor;
      }
      scanned += all.length;
      for (const p of all) {
        const specs = parseSpecs(p.descriptionHtml || '');
        const title = (p.title || '').trim();
        const shelf = `${(specs['Collection'] || '').trim()} ${(specs['Sub-Collection'] || '').trim()}`.trim();

        const ls = String(specs['Lock Status'] || '').trim();
        if (ls && R.lockStatedByCarrier(title, ls)) lockStated++;

        const ss = String(specs['Screen Size'] || '').trim();
        if (!ss || R.PLACEHOLDER.test(ss)) continue;
        if (R.screenSizePresent(title, ss)) continue;
        if (!(R.SCREEN_SHELVES.test(shelf) && !R.SCREEN_NOT.test(shelf))) {
          offShelf++; odd.push(`${code} [${shelf}] ${ss} :: ${title}`); continue;
        }
        const text = R.screenSizeText(ss);
        if (!text) continue;
        if (title.length + 1 + text.length > EBAY_TITLE_MAX) { noRoom++; continue; }
        const out = `${title} ${text}`;
        fires++;
        byShelf.set(shelf, (byShelf.get(shelf) || 0) + 1);
        if (out.length > EBAY_TITLE_MAX) overLong.push(out);
        // A measurement must never be added twice — the whole point of the
        // presence test is that the second copy is invisible to a squash.
        if ((out.match(new RegExp(text.replace(/[.\\"]/g, '\\$&'), 'g')) || []).length > 1) repeats.push(out);
      }
    }

    console.log(`  scanned ${scanned} in-scope products`);
    console.log(`  missing-screen-size fires: ${fires}`);
    console.log(`  Lock Status rows now counted as stated by a carrier: ${lockStated}`);
    for (const [s, n] of [...byShelf.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(3)}  ${s}`);

    ok(overLong.length === 0, 'no suggestion exceeds the 80-character eBay limit', overLong[0] || '');
    ok(repeats.length === 0, 'no suggestion states the measurement twice', repeats[0] || '');
    // ⚠️ NOT AN ASSERTION THAT IT IS ZERO. A Screen Size on a shelf outside the
    // gate is the interesting case — it means either the gate is too narrow or a
    // spec table is being filled in somewhere new. Printed to be read, not to fail.
    if (offShelf) {
      console.log(`  NOTE ${offShelf} product(s) carry a Screen Size on a shelf outside the gate:`);
      for (const o of odd.slice(0, 10)) console.log('        ' + o);
    }
    ok(fires > 0, 'the rule fires on the live estate at all', fires + ' rows');
    // The gate exists so this stays a phone-and-tablet rule. If most of the
    // firing has moved to some other shelf, the rule has drifted from its brief.
    const mobile = [...byShelf.entries()]
      .filter(([s]) => /phone|ipad|tablet/i.test(s)).reduce((a, [, n]) => a + n, 0);
    ok(mobile / Math.max(fires, 1) >= 0.6,
       'most of the firing is still phones and tablets', `${mobile}/${fires}`);
  }

  console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
