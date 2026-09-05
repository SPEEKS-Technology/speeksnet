// "THE TITLE NEVER SAYS WHAT THE ITEM IS" — the accusation, and the word we
// propose to fix it with.
//
// This path is the one place the tool ADDS words to a live listing on one click,
// so a wrong word here is damage a reviewer has to notice before they click. A
// shelf census over all 4,034 products on 2026-09-03 found it doing exactly that
// on six rows ("… General/Other", "… Video Gaming", "… Cameras/Lense") while
// staying silent on 24 rows whose shelf named the product perfectly. Both halves
// are asserted below, offline, with no PIN and no network.
//
// What it asserts:
//    1. the shelf vocabulary that MUST produce a word (RAM, Motherboard,
//       Graphics Card (GPU), Power Supply, CPU & Motherboard Combos)
//    2. the shelf vocabulary that MUST produce silence — every department name
//       the census actually found reaching a live suggestion
//    3. a slash means "one of these" and we do not know which
//    4. a parenthetical survives only as an ACRONYM
//    5. the brand is stripped when the title already says it
//    6. depluralising is not a bare trailing "s" (Lenses, Switches, Glasses)
//    7. plurals in a TITLE count as naming the product (Monitors, Keyboards)
//    8. the proposal must contain a known product word — the gate that stops a
//       department name nobody has thought of reaching a title
//
// Run: node scripts/listing-titles-noun-check.js
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
    if (i < 0 || j < 0) throw new Error(`could not slice ${from.slice(0, 40)}…`);
    return src.slice(i, j);
};

const block = [
    between('const decodeEnt = ', '\n\n'),
    between('const norm = ', '\n\n'),
    between('const tokens = ', '\n\n'),
    between('const PLACEHOLDER = /', '\n\n'),
    between('const PRODUCT_NOUNS = [', '// Measurements and capacities are not'),
    between('const escapeRe = ', '// ============ WHICH WORDS'),
    between('const EBAY_TITLE_MAX', '\n\n'),
    between('const SECONDARY_SPEC =', '\n// Matched case-insensitively'),
    between('function placeAfter', '\n\n'),
].join('\n\n');

const js = block
    // A tuple-array annotation (TRIM_RANK) and an inline object-array one
    // (`hits: { v: string; rank: number }[]`). Both are whole-declaration
    // annotations, so the value they precede is untouched.
    .replace(/:\s*\[RegExp,\s*number\]\[\]/g, '')
    .replace(/:\s*\{[^{}]*\}\[\]/g, '')
    .replace(/\s+as\s+(number|string|boolean)\b/g, '')
    // Any parameter annotated `: string`, wherever it sits in the list. The
    // rules further down only ever caught the first or the last.
    .replace(/([(,]\s*)(\w+)\s*:\s*string\b/g, '$1$2')
    // ⚠️ Record<> CONTAINS A COMMA, so it has to go before any rule that splits a
    // parameter list on one. alsoInSpecs takes Record<string, string> | undefined.
    .replace(/:\s*Record<[^>]*>(\s*\|\s*undefined)?/g, '')
    .replace(/\)\s*:\s*string\[\]\s*\{/g, ') {')
    .replace(/:\s*string\[\]\s*=/g, ' =')
    // Any single string parameter: (s: string), (t: string), (was: string).
    .replace(/\(\s*(\w+)\s*:\s*string\s*\)/g, '($1)')
    .replace(/\(\s*(\w+)\s*:\s*string\s*,/g, '($1,')
    .replace(/,\s*(\w+)\s*:\s*string\s*\)/g, ', $1)')
    .replace(/\(\s*s\s*:\s*string\s*\)/g, '(s)')
    .replace(/\(\s*t\s*:\s*string\s*\)\s*:\s*\w+\s*=>/g, '(t) =>')
    .replace(/\(\s*t\s*:\s*string\s*\)/g, '(t)')
    .replace(/function (\w+)\(([^)]*)\)\s*:\s*[^{]+\{/g,
             (_m, n, p) => `function ${n}(${p.replace(/\s*:\s*string/g, '')}) {`)
    .replace(/\(_m\s*:\s*string,\s*inner\s*:\s*string\)/g, '(_m, inner)')
    .replace(/new Set<[^>]*>\(/g, 'new Set(')
    .replace(/const (\w+) = \(([^)]*)\)\s*:\s*(string|boolean)(\s*\|\s*null)?\s*=>/g,
             (_m, n, p) => `const ${n} = (${p.replace(/\s*:\s*string/g, '')}) =>`);

let shelfNoun, isProductNoun, depluralise, singularToken, GENERIC_SHELF, PRODUCT_NOUNS,
    alsoInSpecs, SECONDARY_SPEC, trimToFit, placeAfter;
try {
    ({ shelfNoun, isProductNoun, depluralise, singularToken, GENERIC_SHELF, PRODUCT_NOUNS,
       alsoInSpecs, SECONDARY_SPEC, trimToFit, placeAfter } =
        new Function(js + `
        return { shelfNoun, isProductNoun, depluralise, singularToken,
                 GENERIC_SHELF, PRODUCT_NOUNS, alsoInSpecs, SECONDARY_SPEC,
                 trimToFit, placeAfter };`)());
} catch (e) {
    console.log('  FAIL  could not lift the code out of index.ts   ' + e.message);
    process.exit(1);
}

// =============================================================================
console.log('\n1. THE SHELVES THAT MUST PRODUCE A WORD');
// Every one of these is a real Sub-Collection value from the census, on a real
// title that was told "no safe automatic fix" the day before this shipped.
[
    ['Graphics Card (GPU)', 'Asus Radeon RX 6700 XT',        'Graphics Card GPU'],
    ['Graphics Card (GPU)', 'NVIDIA GeForce GTX 980 Ti',     'Graphics Card GPU'],
    ['Motherboard',         'Asus ROG Maximus IX Hero',      'Motherboard'],
    ['RAM',                 'Corsair Vengeance RGB Pro',     'RAM'],
    ['Power Supply',        'Corsair',                       'Power Supply'],
    ['Hard Drive',          'Seagate Barracuda 2TB 7200RPM', 'Hard Drive'],
    ['Processor (CPU)',     'Intel Core i9-13900K 5.8GHz',   'Processor CPU'],
    ['Microphones',         'Shure SM7B Dynamic XLR',        'Microphone'],
    ['Nintendo Consoles',   'Wii U 32GB Deluxe',             'Nintendo Console'],
    ['Security Cameras',    'Arlo Pro 4 Spotlight 2K',       'Security Camera'],
    ['Console Only',        'Sony PlayStation 4 Slim 1TB',   'Console Only'],
    ['Other Speaker',       'Klipsch R-51M Bookshelf Pair',  'Speaker'],
    ['Other Camera Lens',   'Tamron 28-75mm f/2.8 Di III',   'Camera Lens'],
    ['Other Headphones Brands', 'Sennheiser HD 600 Open',    'Headphones'],
    // ⚠️ THE ROW THAT STARTED THIS. Ethan, on a CPU/motherboard combo:
    // "Would this title be fine knowing that?" It would not — and the listing
    // was holding the answer on its own shelf the whole time.
    ['CPU & Motherboard Combos', 'Gigabyte B760M Aorus Elite LGA 1700',
     'CPU Motherboard Combo'],
].forEach(([shelf, title, want]) =>
    ok(shelfNoun(shelf, title, true) === want,
       `"${shelf}" on "${title.slice(0, 34)}"`, '-> ' + JSON.stringify(shelfNoun(shelf, title, true))));

// =============================================================================
console.log('\n2. THE SHELVES THAT MUST PRODUCE SILENCE');
// ⚠️ THE FIRST FIVE WERE LIVE ONE-CLICK SUGGESTIONS ON 2026-09-03. Each one made
// a real title worse, and each was one Approve away from a customer reading it.
[
    ['General/Other',   'Asus Blu-ray Disc Rewriter'],
    ['General/Other',   'Corsair 3 x PWM QL Fans Reverse'],
    ['General/Other',   'Lian Li GGF Edition'],
    ['General/Other',   'cord stuff need it'],
    ['Video Gaming',    'Nintendo Wii U Gamepad'],
    ['Cameras/Lenses',  'GoPro Hero Session'],
    // Departments, not products.
    ['Computer Part',   'Athlon 3000G'],
    ['Tools',           'Milwaukee 2562-20 M12 12V'],
    ['Milwaukee Tool',  'New Milwaukee 2562-20 M12 12V'],  // brand strips to "Tool"
    ['Other PC Parts',  'Lian Li GGF Edition'],
    ['Smart Home Devices', 'Google Nest Mini 2nd Gen'],
    ['Accessory Only',  'Nintendo Wii U Gamepad'],
    ['Aftermarket Gaming', 'GameSir-G7 Pro'],
    ['Keyboard/Mouse',  'Logitech MX Master 3S'],
    ['Amplifiers/PreAmps', 'Marantz PM6007'],
    // Placeholders.
    ['N/A',             'Mobile Pixels Duex Pro'],
    ['',                'Mobile Pixels Duex Pro'],
    ['Other',           'Mobile Pixels Duex Pro'],
].forEach(([shelf, title]) =>
    ok(shelfNoun(shelf, title) === null,
       `"${shelf}" proposes nothing`, '-> ' + JSON.stringify(shelfNoun(shelf, title))));

// =============================================================================
console.log('\n2b. AN AMPERSAND IS TRUSTED ON THE SHELF, NEVER IN THE DEPARTMENT');
// ⚠️ THE PRODUCT-WORD GATE DOES NOT CATCH THESE ON ITS OWN. "Cameras & Photo"
// contains a real product word, so only the LEVEL it came from tells us it is a
// department name. Collection is where PayMore keeps those.
ok(shelfNoun('Cameras & Photo', 'Canon PowerShot G7 X Mark III') === null,
   'Cameras & Photo as a DEPARTMENT proposes nothing',
   JSON.stringify(shelfNoun('Cameras & Photo', 'Canon PowerShot G7 X Mark III')));
ok(shelfNoun('Audio & Video', 'New Roku Streaming Stick 4K') === null,
   'Audio & Video as a DEPARTMENT proposes nothing');
ok(shelfNoun('CPU & Motherboard Combos', 'Gigabyte B760M Aorus Elite', true)
     === 'CPU Motherboard Combo',
   'the one real ampersand on the SHELF still works');
ok(shelfNoun('CPU & Motherboard Combos', 'Gigabyte B760M Aorus Elite') === null,
   'and the same value is refused when it arrives as a department');

// =============================================================================
console.log('\n3. THE BRAND IS ALREADY IN THE TITLE');
ok(shelfNoun('Canon Digital Camera', 'Canon EOS Rebel T6 18MP') === 'Digital Camera',
   'Canon shelf on a Canon title drops the brand');
ok(shelfNoun('Sony Controllers', 'Sony DualSense Midnight Black') === 'Controller',
   'Sony Controllers -> Controller');
ok(shelfNoun('Lenovo Laptop', 'Lenovo ThinkPad X1 Carbon Gen 9') === 'Laptop',
   'Lenovo Laptop -> Laptop');
ok(shelfNoun('HP Laptop', 'Dell Latitude 5420 i5') === 'HP Laptop',
   'a DIFFERENT brand is kept — it is information the title lacks');
// ⚠️ THIS IS WHY STRIPPING BEATS REJECTING. The old rule threw the whole value
// away when its first word repeated, so "Sony Controllers" on a Sony title
// proposed nothing at all.
ok(shelfNoun('Sony Digital Camera', 'Sony Alpha ZV-E10 24.2MP') === 'Digital Camera',
   'the remainder is used, not the whole value discarded');

// =============================================================================
console.log('\n4. DEPLURALISING IS NOT A BARE TRAILING "s"');
// The bare-s version shipped "GoPro Hero Session NO VISIBLE SERIAL Cameras/Lense"
// as a live suggestion. These are the words it gets wrong.
ok(depluralise('Camera Lenses') === 'Camera Lens', 'Lenses -> Lens', depluralise('Camera Lenses'));
ok(depluralise('Camera Lens') === 'Camera Lens', 'Lens is already singular', depluralise('Camera Lens'));
ok(depluralise('Network Switches') === 'Network Switch', 'Switches -> Switch', depluralise('Network Switches'));
ok(depluralise('Batteries') === 'Battery', 'Batteries -> Battery', depluralise('Batteries'));
ok(depluralise('Smart Glasses') === 'Smart Glasses', 'Glasses stays plural', depluralise('Smart Glasses'));
ok(depluralise('Beats Headphones') === 'Beats Headphones', 'Headphones stays plural', depluralise('Beats Headphones'));
ok(depluralise('Apple AirPods') === 'Apple AirPods', 'AirPods stays plural', depluralise('Apple AirPods'));
ok(depluralise('Windows Laptops') === 'Windows Laptop', 'only the LAST word changes', depluralise('Windows Laptops'));
ok(depluralise('RAM') === 'RAM', 'a three-letter acronym is untouched', depluralise('RAM'));
ok(depluralise('CPU & Motherboard Combos') === 'CPU & Motherboard Combo', 'Combos -> Combo');

// =============================================================================
console.log('\n5. A PLURAL IN THE TITLE COUNTS AS NAMING THE PRODUCT');
// ⚠️ FALSE ACCUSATIONS. All four of these were in the missing-noun list on
// 2026-09-03 while saying, in the title, exactly what they are.
[
    ['Bargain Bin Monitors: Assorted Brands & Sizes!', 'monitors'],
    ['Bargain Bin Keyboards: Gaming & Office Deals!',  'keyboards'],
    ['Bargain Tech Bags: Top Brands & Deals!',         'bags'],
    ['PayMore Pokemon Bargain Bin Cards $1 to $19',    'cards'],
].forEach(([title, word]) =>
    ok(isProductNoun(word), `"${title.slice(0, 38)}" says ${word}`));
ok(isProductNoun('gamepad'), 'gamepad is a product word (Nintendo Wii U Gamepad)');
ok(isProductNoun('calculator'), 'calculator is a product word (TI-84+ CE)');
ok(isProductNoun('psu'), 'psu is a product word (1000W Modular PSU)');
ok(isProductNoun('smartwatch'), 'a compound still matches by its ending');
// ⚠️ AND THE SHORT ENDINGS STILL MUST NOT. This is the rule the endsWith bound
// exists for, and singularising must not have opened it up.
ok(!isProductNoun('briefcase'), 'briefcase is not a case');
ok(!isProductNoun('keycards'), 'keycards is not a card');

// =============================================================================
console.log('\n6. THE PRODUCT-WORD GATE ON WHAT WE ADD');
ok(!/[Cc]omputer/.test(String(shelfNoun('Computer Part', 'Athlon 3000G'))),
   'a department name never reaches a title');
ok(shelfNoun('Firewalls', 'Fortinet FortiGate 60F') === null,
   'a real product we have no word for is SILENCE, not a guess');
ok(shelfNoun('Virtual Reality VR', 'Meta Quest 3 128GB') === null,
   'and so is one whose shelf we cannot vouch for');
// The gate is one-directional on purpose: a gap in the list must never become an
// accusation, only a missing suggestion.
ok(isProductNoun('firewall') === false && shelfNoun('Firewalls', 'x') === null,
   'a gap in the list costs a suggestion, never a false accusation');
ok(String(shelfNoun('Wireless Gaming Controller', 'GameSir-G7 Pro ZZZ Edition'))
     === 'Wireless Gaming Controller',
   'a long, specific Type is allowed — the fit test decides, not a char cap');

// =============================================================================
console.log('\n7. THE SOURCE ORDER AND THE MESSAGE ARE WIRED (source-level)');
const analyseBlock = src.slice(src.indexOf('THE TITLE NEVER SAYS WHAT THE ITEM IS'),
                               src.indexOf('--- 1: money on the table'));
ok(/\[specType, false\][\s\S]{0,120}Sub-Collection"\], true\][\s\S]{0,120}\[collection, false\]/
     .test(analyseBlock),
   'Type, then Sub-Collection, then Collection — most specific first');
ok(analyseBlock.includes('shelfNoun(String(v || "").trim(), title, shelfLevel)'),
   'every source goes through the same gauntlet');
// ⚠️ EXACTLY ONE SOURCE MAY CARRY AN AMPERSAND, and it is the shelf.
ok((analyseBlock.match(/, true\]/g) || []).length === 1,
   'only Sub-Collection is trusted at shelf level');
// ⚠️ WE KNOW THE WORD AND CANNOT FIT IT. Saying "no safe automatic fix" there
// throws away the answer the listing was holding.
ok(/is the missing word/.test(analyseBlock) && /characters, so something has to come out/.test(analyseBlock),
   'when the word will not fit, the finding SAYS the word');
ok(!/const singular = noun\.replace/.test(src),
   'the old bare-trailing-s depluraliser is gone from the source');
ok(!/const generic = \/\^\(computer/.test(src),
   'the old inline generic regex is gone from the source');
// ⚠️ NEVER TRUNCATE TO MAKE ROOM. Appending " Bundle" to a 79-character Asus
// title once dropped the "4050" to buy the space, and shipped as a suggestion.
ok(/if \(title\.length \+ 1 \+ word\.length > EBAY_TITLE_MAX\) return false;/.test(src),
   'an addition that does not fit is simply not made');

// =============================================================================
console.log('\n8. WHICH WORDS THE TITLE IS NOT THE ONLY PLACE FOR');
// The real OVL row, verbatim from ?peek=.
const COMBO = {
    'Collection': 'Computer Part', 'Sub-Collection': 'CPU & Motherboard Combos',
    'Motherboard Brand': 'Gigabyte', 'Motherboard Model': 'B760M Aorus Elite',
    'CPU Brand': 'Intel', 'CPU Model': 'Core I5-13600KF',
    'Processor Speed': '3.50GHz', 'CPU MPN': 'SRMBE', 'Cores': '14 Core',
    'Thread Count': '20 Thread', 'Socket': 'LGA 1700', 'Chipset': 'Intel B760',
    'Form Factor': 'microATX', 'Memory': '4x DDR5 Slots',
    'Storage': '2x M.2 NVMe Gen 4.0 x 4 Slot 4x Sata III 6Gbit/s Port',
    'I/O Ports': '2x 3.5mm Headphone/Microphone Combo Ethernet Port 3x USB-A 3.2 Gen 1 Port',
    'Condition': 'Good', 'UPC': '889523035023', 'Serial#': 'X310M613 231350052107',
};
const COMBO_TITLE = 'Gigabyte B760M Aorus Elite LGA 1700 Intel Core I5-13600KF 3.50GHz microATX';
const cut = alsoInSpecs(COMBO_TITLE, COMBO);
// ⚠️ CHEAPEST FIRST, SOCKET LAST. The order is the only opinion in this path,
// and it is what decides which fact gets spent when room has to be made.
ok(cut.join(' | ') === '3.50GHz | microATX | LGA 1700',
   'clock speed, then form factor, then the socket LAST', cut.join(' | '));
// ⚠️⚠️ THE FAILURE THAT WOULD MATTER. "Motherboard Brand" and "CPU Model" do not
// appear in TITLE_SPECS verbatim, so a DENY-LIST built on "not in TITLE_SPECS"
// would have told a reviewer it is safe to cut the brand and the model.
ok(!cut.includes('Gigabyte'), 'NEVER the brand');
ok(!cut.includes('B760M Aorus Elite'), 'NEVER the model');
ok(!cut.includes('Core I5-13600KF'), 'NEVER the processor');
ok(!cut.includes('Intel'), 'NEVER the CPU brand');
// Present in the specs, absent from the title — nothing to offer cutting.
ok(!cut.includes('14 Core') && !cut.includes('Intel B760'),
   'only words the title actually says');
// Identifiers and prose are not trim candidates.
ok(!cut.some(v => /889523035023|X310M613|Good/.test(v)), 'never a serial, UPC or condition');
// ⚠️ THE BOUNDARY RULE IS THE SHARED ONE. "ATX" must not match inside "microATX",
// or a reviewer is told to cut a substring of another word.
ok(alsoInSpecs('Asus X99-A LGA 2011-v3 Intel Core i7-6800K 6 Core 3.40GHz ATX',
               { 'Processor Speed': '3.40GHz', 'Cores': '6 Core',
                 'Socket': 'LGA 2011-v3', 'Form Factor': 'ATX' })
     .join(' | ') === '3.40GHz | 6 Core | ATX | LGA 2011-v3',
   'BAL\'s combo, with ATX standing alone');
ok(alsoInSpecs('Gigabyte B760M microATX', { 'Form Factor': 'ATX' }).length === 0,
   'ATX inside microATX is not a match');
ok(alsoInSpecs('Some Title', undefined).length === 0, 'no spec table, nothing to say');
ok(alsoInSpecs('Some Title 3.50GHz', { 'Processor Speed': 'N/A' }).length === 0,
   'a placeholder is not a candidate');
ok(alsoInSpecs(COMBO_TITLE, COMBO).length <= 4, 'the list is capped so the message stays readable');
// ⚠️ AN ALLOW-LIST, NOT A DENY-LIST — a field we have not thought about costs a
// candidate, never a wrong one. This is the same one-directional safety as the
// product-word gate, and it is the whole reason SECONDARY_SPEC is written out.
ok(SECONDARY_SPEC.test('Processor Speed') && SECONDARY_SPEC.test('Socket')
   && SECONDARY_SPEC.test('Form Factor') && SECONDARY_SPEC.test('Cores'),
   'the secondary fields are named explicitly');
ok(!SECONDARY_SPEC.test('Brand') && !SECONDARY_SPEC.test('Motherboard Model')
   && !SECONDARY_SPEC.test('Storage') && !SECONDARY_SPEC.test('Screen Size'),
   'and the fields buyers type are not');

// The message only appears where we know the word AND it will not fit.
ok(/const cuttable = noun \? alsoInSpecs\(original, extra\?\.specs\) : \[\];/.test(src),
   'computed only when we have a word');
ok(analyseBlock.includes('from the title takes nothing out of the listing.')
   && analyseBlock.includes('The spec table already states'),
   'and the finding says what it means in English');

// =============================================================================
console.log('\n9. MAKING ROOM BY SPENDING A FACT THE LISTING KEEPS');
// ⚠️ THE MOST DANGEROUS THING IN THIS FILE. Every other suggestion adds words or
// removes a mistake; this one DELETES A TRUE FACT from a live title to buy space.
// It is allowed only because the value is one the SPEC TABLE also states, chosen
// by name from a published order, the fewest that will do.
const ADD = 'CPU Motherboard Combo';

// ⚠️ THE ANSWER ETHAN TYPED BY HAND. He was shown "no safe automatic fix", wrote
// the title himself, and asked why the tool could not: "clock speed might not be
// as important as CPU Motherboard combo right?" This asserts the tool now
// produces HIS title, character for character.
const ovl = trimToFit(COMBO_TITLE, ADD, COMBO);
ok(ovl && ovl.title + ' ' + ADD
     === 'Gigabyte B760M Aorus Elite LGA 1700 Intel Core I5-13600KF CPU Motherboard Combo',
   "reaches the title Ethan wrote by hand", ovl && (ovl.title + ' ' + ADD));
ok(ovl && (ovl.title + ' ' + ADD).length === 79, 'and it is 79 of 80',
   ovl && (ovl.title + ' ' + ADD).length);
ok(ovl && ovl.gone.join(' + ') === '3.50GHz + microATX',
   'spending the clock speed and the form factor', ovl && ovl.gone.join(' + '));
// ⚠️ AND KEEPING THE SOCKET. "LGA 1700 motherboard" is a real search; a clock
// speed is implied by the CPU model number standing next to it. If this ever
// flips, the tool is deleting the most searched thing on the row.
ok(ovl && !ovl.gone.includes('LGA 1700') && ovl.title.includes('LGA 1700'),
   'the socket survives — it is the thing people search');

// BAL needs only three characters, so only one fact is spent.
const BAL_T = 'Asus X99-A LGA 2011-v3 Intel Core i7-6800K 6 Core 3.40GHz ATX';
const BAL_S = { 'Processor Speed': '3.40GHz', 'Cores': '6 Core',
                'Socket': 'LGA 2011-v3', 'Form Factor': 'ATX' };
const bal = trimToFit(BAL_T, ADD, BAL_S);
ok(bal && bal.gone.length === 1 && bal.gone[0] === '3.40GHz',
   'the FEWEST that will do, never a tidy-up', bal && bal.gone.join(' + '));
ok(bal && (bal.title + ' ' + ADD).length <= 80, 'and the result fits', bal && (bal.title + ' ' + ADD).length);

// A title that already fits is not this function's business.
ok(trimToFit('Short Title', ADD, COMBO) === null, 'a title with room is left alone');
// Nothing spendable -> null, and the finding falls back to naming the word.
ok(trimToFit(COMBO_TITLE, ADD, { 'Brand': 'Gigabyte', 'Model': 'B760M Aorus Elite' }) === null,
   'no spendable fact means NO suggestion, not a guess');
// ⚠️ NEVER MORE THAN THREE. A title needing four facts removed to name itself is
// a listing for a person to look at, and a suggestion that guts a title is one
// nobody trusts enough to read the next one.
const many = trimToFit(COMBO_TITLE, 'A Very Long Product Name That Cannot Possibly Fit Here', COMBO);
ok(many === null || many.gone.length <= 3, 'at most three facts are ever spent',
   many && many.gone.length);
// ⚠️ NEVER A STUB. Brand plus model is the floor.
ok((trimToFit('Corsair 3.50GHz', ADD, { 'Processor Speed': '3.50GHz' }) || {}).title === undefined,
   'never trims a title down to a stub');
// ⚠️ ONLY VALUES THE SPEC TABLE STATES. This is the entire safety argument: the
// words leave the TITLE, never the LISTING.
ok(ovl && ovl.gone.every(v => Object.values(COMBO).includes(v)),
   'every word spent is one the spec table still holds');

// ⚠️ THE BANNED BEHAVIOUR IS STILL BANNED. capTitle cut on a word boundary from
// the END and once dropped the "4050" out of an Asus title to buy room for
// " Bundle" — it did not know what it was deleting. Nothing here may do that.
ok(/if \(title\.length \+ 1 \+ word\.length > EBAY_TITLE_MAX\) return false;/.test(src),
   'tryAppend still refuses an addition that does not fit');
ok(analyseBlock.includes('const room = trimToFit(title, noun, extra?.specs);')
   && analyseBlock.includes('if (!applied) { title = original; trimmed = []; }'),
   'and a trim that fails to land puts the title back');
ok(analyseBlock.includes('...(trimmed.length ? { trimmed } : {}),'),
   'what was spent is carried to the row so it can be shown in red');

// =============================================================================
console.log('\n10. WHERE A MEASUREMENT GOES IN THE TITLE');
// ⚠️ MEASURED AGAINST THE ESTATE, NOT AGAINST TASTE. Ethan, on three phones with
// the screen size stuck on the end: "do you think this is the best spot in the
// title for them?" Every phone, tablet, laptop and monitor title at the five
// stores that ALREADY carries a screen size puts it immediately after the model:
//     WiFi Only Apple iPad Pro 12.9" 6th Gen 128GB Space Gray MP5X3LL/A
//     T-Mobile Samsung Galaxy Tab S9 FE 10.9" 128GB Gray SM-X518U
//     Dell Inspiron 3521 15.6" i3-3227U 1.9GHz 6GB RAM 500GB HDD
// Each pair below is a REAL queued row and what appending was producing.
[
    ['Factory Unlocked Apple iPhone Air 256GB Cloud White NG194LL/A', 'iPhone Air', '6.5"',
     'Factory Unlocked Apple iPhone Air 6.5" 256GB Cloud White NG194LL/A'],
    ['Factory Unlocked Apple iPhone 17 Pro Max 256GB Deep Blue MFXJ4LL/A', 'iPhone 17 Pro Max', '6.9"',
     'Factory Unlocked Apple iPhone 17 Pro Max 6.9" 256GB Deep Blue MFXJ4LL/A'],
    ['Consumer Cellular Apple iPad 1st Gen 16GB White MCA14LL/A', 'iPad 1st Gen', '8.3"',
     'Consumer Cellular Apple iPad 1st Gen 8.3" 16GB White MCA14LL/A'],
    ['WiFi Only Amazon Kindle Colorsoft 16GB Black R7528', 'Kindle Colorsoft', '7"',
     'WiFi Only Amazon Kindle Colorsoft 7" 16GB Black R7528'],
    // ⚠️ THE ROW THAT KILLS "BEFORE THE STORAGE". Two capacities, and the Storage
    // one is the SECOND — that rule lands the screen size inside the memory.
    ['TracFone Samsung Galaxy A14 5G 4GB RAM 64GB SM-S146VL Black', 'Galaxy A14 5G', '6.6"',
     'TracFone Samsung Galaxy A14 5G 6.6" 4GB RAM 64GB SM-S146VL Black'],
    // ⚠️ AND THE TWO WORST THINGS APPENDING DID: after a parenthetical note, and
    // after a hand-typed warning. Both were live suggestions.
    ['Broken Unlocked Apple iPhone 14 128GB 26.2 MPUX3LL/A (Bad Battery 77%)', 'iPhone 14', '6.1"',
     'Broken Unlocked Apple iPhone 14 6.1" 128GB 26.2 MPUX3LL/A (Bad Battery 77%)'],
    ['T-Mobile Google Pixel 10a 128GB Obsidian GA10052-US NO SIM TRAY', 'Pixel 10a', '6.3"',
     'T-Mobile Google Pixel 10a 6.3" 128GB Obsidian GA10052-US NO SIM TRAY'],
    ['HP Chromebook x360 Celeron N4120 1.1GHz 4GB RAM 32GB', 'Chromebook x360', '14"',
     'HP Chromebook x360 14" Celeron N4120 1.1GHz 4GB RAM 32GB'],
].forEach(([now, model, size, want]) =>
    ok(placeAfter(now, size, model) === want,
       '"' + model + '" -> ' + size, placeAfter(now, size, model)));

// ⚠️ NO MODEL TO ANCHOR TO IS NOT A GUESS — it is null, and the caller appends,
// which is what this path always did. A wrong POSITION is a worse title, and a
// worse title approved in one click is the failure this whole screen guards.
ok(placeAfter('Some Untitled Thing 128GB', '6.1"', '') === null,
   'no model means no placement');
ok(placeAfter('Some Untitled Thing 128GB', '6.1"', 'iPhone 14') === null,
   'a model the title does not say means no placement');
// The boundary rule is shared, so a model name inside a longer word is not a hit.
ok(placeAfter('Apple iPhone 14Plus 128GB', '6.1"', 'iPhone 14') === null,
   '"iPhone 14" does not match inside "iPhone 14Plus"');
// Nothing but the insertion changes.
const before = 'Factory Unlocked Apple iPhone Air 256GB Cloud White NG194LL/A';
const after = placeAfter(before, '6.5"', 'iPhone Air');
ok(after.replace(' 6.5"', '') === before, 'the rest of the title is untouched', after);
ok((after.match(/"/g) || []).length === 1, 'exactly one inch mark is added');

// The closure still owns the length rule, and still refuses what will not fit.
ok(/const tryPlace = \(word: string, after: string\): boolean => \{\s*\n\s*if \(title\.length \+ 1 \+ word\.length > EBAY_TITLE_MAX\) return false;/.test(src),
   'an addition that does not fit is still not made, wherever it would go');
ok(src.includes('if (placed === null) return tryAppend(word);'),
   'and appending is the fallback, not an error');
ok(src.includes('tryPlace(text, String(extra?.specs?.["Model"] || "").trim())'),
   'the screen size is anchored to the Model the spec table records');

// ⚠️ TWO RULES CAN ADD THE SCREEN SIZE, AND THEY MUST AGREE ON WHERE IT GOES.
// The dedicated rule above places it after the model. lazy-title adds it too —
// but only when a SECOND detail is missing as well — and it used to append
// everything to the end. So the same fact landed in two different places
// depending on whether an unrelated field happened to be blank:
//
//   WSP MO02-4613A-E2, screen only   → "iPhone 11 6.1" 64GB 18.5 MWJJ2LL/A READ"
//   WSP MO02-4723A-E2, screen+colour → "…128GB 26.6 MTXT3LL/A Read 6.7" Pink"
//
// (Ethan, 2026-09-04: "why is the screen size and color for this one at the end
// and the one beneath it where it should be in the middle?") Asserted on the
// SOURCE because the branch lives mid-way through analyse, which needs a Shopify
// row to call — and a divergence here is invisible until someone photographs it.
ok(/const isScreen = m\.k === "Screen Size";/.test(src),
   'lazy-title singles the screen size out from the fields it appends');
ok(/const placed = isScreen\s*\n\s*\? tryPlace\(text, String\(extra\?\.specs\?\.\["Model"\] \|\| ""\)\.trim\(\)\)/.test(src),
   'and places it after the same Model anchor, not on the end');
// Everything that is NOT a screen size or a colour still appends, so a new
// special case cannot quietly become the default.
ok(/\n\s*: tryAppend\(text\);/.test(src),
   'and every other field still appends');
// Through screenSizeText for the same reason: a spec of `6.7` or `6.7 in` has to
// come out as `6.7"` whichever rule adds it.
ok(/const text = isScreen \? \(screenSizeText\(m\.v\) \|\| m\.v\) : m\.v;/.test(src),
   'and writes the measurement the same way the other rule does');
ok(/added\.push\(`\$\{m\.k\} \$\{text\}`\)/.test(src),
   'and the reason names what was actually inserted, not the raw spec');

// --- WHERE A COLOUR GOES -----------------------------------------------------
// ⚠️ MEASURED, NOT GUESSED. Of the 207 titles across the estate that already
// carry their Color value, only 59 (29%) end on it; of the 148 that do not, 82
// are followed by a PART NUMBER — the dominant shape at nearly 7:1:
//
//   Google Nest Hub 1st Gen Smart Speaker White 10395A-H0A
//   Apple AirPods Max Wireless Over-Ear Headphones Silver MGYJ3AM/A
//
// (Ethan, 2026-09-04: "Color should probably also not be the last word as other
// listings have it in the middle I believe." Not the middle — before the part
// number.) The census route is ?colors=1&store=ALL&secret=.
console.log('\n== 11. The colour goes before the part number ==');
{
    const place = new Function('squash', `
        ${between('const TITLE_UNIT =', '\n\nfunction placeAfter')
            .replace(/\(w: string\): boolean/g, '(w)')
            .replace(/\(title: string, word: string\): string \| null/g, '(title, word)')}
        return { isTitlePartCode: isTitlePartCode, placeBeforePartCode: placeBeforePartCode };
    `)(v => String(v).toLowerCase().replace(/[^a-z0-9]/g, ''));

    // The row Ethan was looking at.
    ok(place.placeBeforePartCode(
        'Broken Unlocked Apple iPhone 15 Plus 6.7" 128GB 26.6 MTXT3LL/A Read', 'Pink')
        === 'Broken Unlocked Apple iPhone 15 Plus 6.7" 128GB 26.6 Pink MTXT3LL/A Read',
       'Pink lands before MTXT3LL/A, not after Read',
       place.placeBeforePartCode('Broken Unlocked Apple iPhone 15 Plus 6.7" 128GB 26.6 MTXT3LL/A Read', 'Pink'));

    // ⚠️ A MEASUREMENT IS NOT A PART NUMBER. titleWorthy's version of this test
    // calls "128GB" a part code — letters, a digit, no vowel in "GB" — which is
    // harmless when REJECTING a value and wrong when finding a position, and
    // would have put the colour in the middle of the specs.
    for (const m of ['128GB', '64GB', '44MM', '2025', '720G', '15', '6.7"', '902XL']) {
        ok(!place.isTitlePartCode(m), `"${m}" is not read as a part number`);
    }
    for (const p of ['MTXT3LL/A', '10395A-H0A', 'TMRV07P5G', 'XT2513-1',
                     'MC007791', 'A3140', 'CUH-ZVR1', 'MGYJ3AM/A']) {
        ok(place.isTitlePartCode(p), `"${p}" is`);
    }

    // The 29% with no part number at all: nothing to anchor to, so the caller
    // appends. null is how it says so.
    ok(place.placeBeforePartCode('New HP 64XL Tri-color Ink Cartridge', 'Black') === null,
       'a title with no part number returns null, so the caller appends');
    // Never before the first word — a colour cannot lead a title.
    ok(place.placeBeforePartCode('A3140 Beats Solo4', 'Pink') === null,
       'and a part code in first position is not an anchor');

    // The closure obeys the same 80-character rule as every other addition.
    ok(/const tryPlaceColour = \(word: string\): boolean => \{\s*\n\s*if \(title\.length \+ 1 \+ word\.length > EBAY_TITLE_MAX\) return false;/.test(src),
       'an addition that does not fit is still not made');
    ok(/: m\.k === "Color" \? tryPlaceColour\(text\)/.test(src),
       'and lazy-title routes the colour through it');
}

console.log('\n' + (fails ? `${fails} FAILED` : 'all passed'));
process.exit(fails ? 1 : 0);
