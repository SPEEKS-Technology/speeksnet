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
].join('\n\n');

const js = block
    .replace(/\(\s*s\s*:\s*string\s*\)/g, '(s)')
    .replace(/\(\s*t\s*:\s*string\s*\)\s*:\s*\w+\s*=>/g, '(t) =>')
    .replace(/\(\s*t\s*:\s*string\s*\)/g, '(t)')
    .replace(/function (\w+)\(([^)]*)\)\s*:\s*[^{]+\{/g,
             (_m, n, p) => `function ${n}(${p.replace(/\s*:\s*string/g, '')}) {`)
    .replace(/\(_m\s*:\s*string,\s*inner\s*:\s*string\)/g, '(_m, inner)')
    .replace(/new Set<[^>]*>\(/g, 'new Set(')
    .replace(/const (\w+) = \(([^)]*)\)\s*:\s*(string|boolean)(\s*\|\s*null)?\s*=>/g,
             (_m, n, p) => `const ${n} = (${p.replace(/\s*:\s*string/g, '')}) =>`);

let shelfNoun, isProductNoun, depluralise, singularToken, GENERIC_SHELF, PRODUCT_NOUNS;
try {
    ({ shelfNoun, isProductNoun, depluralise, singularToken, GENERIC_SHELF, PRODUCT_NOUNS } =
        new Function(js + `
        return { shelfNoun, isProductNoun, depluralise, singularToken,
                 GENERIC_SHELF, PRODUCT_NOUNS };`)());
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

console.log('\n' + (fails ? `${fails} FAILED` : 'all passed'));
process.exit(fails ? 1 : 0);
