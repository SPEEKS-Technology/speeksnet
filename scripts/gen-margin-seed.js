// Generates supabase/migrations/0006_margin_guide_seed.sql from the parsed
// workbook (sheets.json, produced by parse.js).
const fs = require('fs');
const path = require('path');
const S = JSON.parse(fs.readFileSync(path.join(__dirname, 'sheets.json'), 'utf8'));

const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const qn = s => (s === null || s === undefined || s === '' ? 'null' : q(s));
const out = [];

/* ---------------- 1. tiers ---------------- */
// The ten distinct triples in MarginBreakdown. Nine follow team = start + 20;
// 'checkout_salvage' (15/30/35) does not, and is used by exactly one row — Broken
// CHECKOUT on Checkout Consoles. Ethan confirmed 2026-07-29 that this is
// DELIBERATE, not a typo: a broken console going out through Checkout really is
// squeezed tighter than the ladder's usual shape. Do not normalize it to 15/35/40.
const TIERS = [
  ['premium',          'Premium',          40, 60, 75],
  ['high',             'High',             35, 55, 65],
  ['strong',           'Strong',           30, 50, 60],
  ['standard',         'Standard',         30, 50, 55],
  ['moderate',         'Moderate',         25, 45, 55],
  ['value',            'Value',            25, 45, 50],
  ['low',              'Low',              20, 40, 50],
  ['salvage',          'Salvage',          20, 40, 45],
  ['deep',             'Deep Salvage',     15, 35, 40],
  ['checkout_salvage', 'Checkout Salvage', 15, 30, 35],
];
const tierBySig = {};
TIERS.forEach(([slug, , lo, hi, mgr], i) => { tierBySig[`${lo}/${hi}/${mgr}`] = i + 1; });

/* ---------------- 2. conditions ---------------- */
const CONDITIONS = [
  ['NEW',             'Sealed or new-in-box. Apple products must scan with an "S" before the serial.', 1],
  ['Used-A/Mint',     'No cosmetic damage, fully functional, and complete.', 2],
  ['Used-B/Used-C',   'Scratches, dents or heavy wear, and/or missing pieces. Still functional.', 3],
  ['Broken',          'Cracks, LCD problems, or functionality issues. Anything needing repair is Broken.', 4],
  ['CHECKOUT',        'Priced through the Checkout program rather than listed on eBay. On phones this is the bad-IMEI route.', 5],
  ['Broken CHECKOUT', 'Broken and routed through the Checkout program.', 6],
];

/* ---------------- 3. devices + help key mapping ---------------- */
const hl = S['HelpLanguage'];
const hlRows = Object.keys(hl).map(Number).sort((a, b) => a - b);
const gh = (r, c) => (hl[r] && hl[r][c] ? String(hl[r][c].v) : '');
const blocks = [];
for (const r of hlRows) {
  const h = gh(r, 'B').trim();
  if (/^REMINDERS/i.test(h)) blocks.push({ row: r, key: h.replace(/^REMINDERS\s*-\s*/i, '').trim() });
}
const helpKeys = new Set(blocks.map(b => b.key));

const HELP_ALIAS = {
  'Speakers': 'Audio/Home Theatre',
  'Receivers': 'Audio/Home Theatre',
  'Subwoofers': 'Audio/Home Theatre',
  'Home Theatre Systems': 'Audio/Home Theatre',
  'Large/Heavy Item': 'Miscellaneous',
  'Medium Item': 'Miscellaneous',
  'Small Item': 'Miscellaneous',
  'Handheld Consoles': 'Handheld Game Console',
  'Apple Watch': 'Apple Smart Watch',
};
const helpKeyFor = dev => HELP_ALIAS[dev] || (helpKeys.has(dev) ? dev : null);

/* ---------------- 4. bands: parse the free-text Model column ---------------- */
function parseBand(model) {
  const t = String(model).replace(/\s+/g, ' ').trim();
  const num = s => parseFloat(String(s).replace(/,/g, ''));
  let m;
  if ((m = /(?:Greater Than|Over)\s*\$([\d,]+)/i.exec(t)))            return { min: num(m[1]), max: null };
  if ((m = /\$([\d,]+)\s*or Greater/i.exec(t)))                        return { min: num(m[1]), max: null };
  if ((m = /(?:Between|Bewteen)\s*\$([\d,]+)\s*(?:and|-|–)\s*\$([\d,]+)/i.exec(t)))
                                                                       return { min: num(m[1]), max: num(m[2]) };
  if ((m = /Less Th[ae]n\s*\$([\d,]+)/i.exec(t)))                      return { min: 0, max: num(m[1]) };
  return { min: 0, max: null, plain: t };   // no price split at all
}
const money = n => '$' + Number(n).toLocaleString('en-US');
function bandLabel(b, plainText) {
  if (b.plain) return plainText;
  if (b.max === null) return money(b.min) + '+';
  if (b.min === 0)    return 'Under ' + money(b.max);
  return money(b.min) + ' – ' + money(b.max);
}

/* ---------------- 5. walk MarginBreakdown ---------------- */
const mb = S['MarginBreakdown'];
const gb = (r, c) => (mb[r] && mb[r][c] ? mb[r][c].v : '');
const pct = v => Math.round(parseFloat(v) * 1000) / 10;

const devices = [];      // { category, device, help_key, bands: Map(label -> {b, conds:[]}) }
const devIndex = new Map();
for (const r of Object.keys(mb).map(Number).sort((a, b) => a - b)) {
  if (r < 3) continue;
  const cat = String(gb(r, 'A') || '').trim();
  const dev = String(gb(r, 'B') || '').trim();
  if (!cat || !dev) continue;
  const model = String(gb(r, 'C') || '').trim();
  const cond  = String(gb(r, 'D') || '').trim();
  const sig   = `${pct(gb(r, 'E'))}/${pct(gb(r, 'F'))}/${pct(gb(r, 'G'))}`;
  const tier  = tierBySig[sig];
  if (!tier) throw new Error('unmapped triple ' + sig + ' at row ' + r);

  const dk = cat + '||' + dev;
  if (!devIndex.has(dk)) {
    const d = { category: cat, device: dev, help_key: helpKeyFor(dev), bands: new Map() };
    if (!d.help_key) throw new Error('no help block for device: ' + dev);
    devIndex.set(dk, d);
    devices.push(d);
  }
  const d = devIndex.get(dk);
  const parsed = parseBand(model);
  const label = bandLabel(parsed, model.replace(/\s+/g, ' ').trim());
  if (!d.bands.has(label)) d.bands.set(label, { ...parsed, label, conds: [] });
  d.bands.get(label).conds.push({ cond, tier });
}

// Video Games: the workbook's reminders carry flat per-game pay below $20.
const vg = devices.find(d => d.device === 'Video Games');
if (vg) {
  vg.bands.set('$10 – $20', { min: 10, max: 20, label: '$10 – $20', flat: [1, 2], conds: [] });
  vg.bands.set('Under $10', { min: 0,  max: 10, label: 'Under $10', flat: [0.5, 1], conds: [] });
  // the existing "$20+" band keeps its percentage tiers
}

/* ---------------- 6. help language ---------------- */
const TYPOS = [
  [/Corosion/g, 'Corrosion'], [/SCRACTES/g, 'SCRATCHES'], [/Aperature/g, 'Aperture'],
  [/MarksOn/g, 'Marks On'], [/Power Supply's/g, 'Power Supplies'],
  [/cannot be upgraded or upgraded easily/g, 'cannot be upgraded easily'],
  [/its a permanent flaw/g, "it's a permanent flaw"], [/ {2,}/g, ' '],
];
const fixText = s => TYPOS.reduce((acc, [re, to]) => acc.replace(re, to), String(s)).trim();

const GATES = [
  'MUST SHOW AN "S" IN FRONT OF THE SERIAL', 'FIND MY MAC MUST BE TURNED OFF',
  'MOTHERBOARDS MUST BE TESTED', 'MUST GO OUTSIDE AND HAVE THE CUSTOMER FLY',
  'NO MDM ON THE DEVICE', 'MUST GET IT CLEARED WITH THE MANAGER',
  'We Only Buy Monitors That Are 120Hz', "GET YOUR MANAGER INVOLVED",
  "DON'T GUESS! GET HELP FROM A TEAM MEMBER", 'DO NOT BUY ANY BROKEN ACCESSORIES',
  'Broken Headphones Should Not Be Purchased', "DON'T BUY AT ALL",
  'All Film Cameras Must Be Tested', 'ALWAYS USE CHECKOUT PRICING',
  'CHECK TO SEE IF CHECKOUT PROGRAM HAS PRICING', 'MUST STILL HAVE THEIR WARRANTY STICKER',
];
const MUSTS = [
  'Must Be Considered Broken', 'ALWAYS REMOVE ICLOUD', 'ALWAYS REMOVE ANY ACCOUNT',
  'ALWAYS WIPE THE DEVICE', 'ALWAYS REMOVE THE DJI ACCOUNT', 'MATCH YOUR CAMERA',
  'MATCH YOUR LENS', 'iCloud Is Removed', 'Tablets Bend Easily',
  'SERVICE Battery/High Cycle Count', 'ALWAYS Check For Bright/Dark Spots',
  'Laptop Can Charge And Stay On', 'Look For Damage To The Contacts', 'Look For Bent Pins',
  'Burn Marks On The Top Side', 'COSMETIC CONDITION IS EVERYTHING',
  'Buying UNTESTED', 'Look For Any Bends',
];
const DROP = ['GAMES BETWEEN $0 - $10', 'GAMES BETWEEN $10 - $20'];
const has = (body, list) => list.some(k => body.toUpperCase().includes(k.toUpperCase()));

function bullets(cellText) {
  return String(cellText).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .reduce((acc, line) => {
      if (line.startsWith('*')) acc.push(line.replace(/^\*\s*/, ''));
      else if (acc.length) acc[acc.length - 1] += ' ' + line;   // wrapped continuation
      return acc;
    }, [])
    .map(fixText).filter(Boolean);
}

const helpItems = [];   // { key, kind, body, gate, must, sort }
const rebuttals = [];   // { key, name, say, why, conds, sort }

// Hand-written spoken lines for the five devices already reviewed with Ethan.
const SAY = require('./margin-say-lines.json');

const COND_RULES = [
  [/hygiene|band hygiene/i,                                      ['Used-A/Mint', 'Used-B/Used-C']],
  [/battery|cycle count/i,                                       ['Used-A/Mint', 'Used-B/Used-C', 'Broken']],
  [/carrier lock|carrier brand|locked/i,                         ['Used-B/Used-C', 'CHECKOUT']],
  [/untested/i,                                                  ['Broken', 'CHECKOUT']],
  [/scratch|dents|cosmetic|casing wear|case condition|yellowing|screen coating|screen condition|label damage|disc condition|shine|keyboard wear|physical sag|glass damage|display fading|sun damage|slot wear/i,
                                                                 ['Used-B/Used-C']],
];
const condsFor = name => (COND_RULES.find(([re]) => re.test(name)) || [null, []])[1];

for (let i = 0; i < blocks.length; i++) {
  const key = blocks[i].key;
  const start = blocks[i].row;
  const end = i + 1 < blocks.length ? blocks[i + 1].row : 1e9;
  const gather = col => hlRows.filter(r => r > start && r < end).map(r => gh(r, col)).join('\n');

  [['B', 'reminder'], ['D', 'condition'], ['F', 'testing']].forEach(([col, kind]) => {
    bullets(gather(col)).forEach((body, idx) => {
      if (has(body, DROP)) return;
      // "Check For Genuine Apple Parts" on Android devices — copy-paste from the
      // Apple blocks. Ethan: "can be dropped".
      if (/^Android/i.test(key) && /Genuine Apple Parts/i.test(body)) return;
      helpItems.push({
        key, kind, body,
        gate: has(body, GATES), must: has(body, MUSTS),
        sort: (idx + 1) * 10,
      });
    });
  });

  bullets(gather('H')).forEach((body, idx) => {
    const m = /^([^:]{2,60}):\s*(.+)$/s.exec(body);
    const name = m ? m[1].trim() : body.slice(0, 40);
    const why  = m ? m[2].trim() : body;
    rebuttals.push({
      key, name, why,
      say: (SAY[key] && SAY[key][name]) || null,
      conds: condsFor(name),
      sort: (idx + 1) * 10,
    });
  });
}

/* ---------------- 7. emit ---------------- */
out.push(`-- ============================================================================
-- Margin Guide — seed data, generated from "Buyer Margin Guide v1.0.xlsm".
-- ----------------------------------------------------------------------------
-- DO NOT hand-edit. Regenerate with scripts/gen-margin-seed.js against the
-- workbook, or edit the data in the tool once the DM editor ships.
--
-- Source counts: ${devices.length} devices, ${devices.reduce((n, d) => n + d.bands.size, 0)} bands,
-- ${devices.reduce((n, d) => n + [...d.bands.values()].reduce((k, b) => k + b.conds.length, 0), 0)} band/condition rows,
-- ${helpItems.length} help items (${helpItems.filter(h => h.gate).length} gates), ${rebuttals.length} rebuttals.
--
-- Transformations applied on the way in:
--   * free-text price bands  -> numeric price_min / price_max
--   * Motherboard's bands mislabeled "Storage ..." lose the wrong name entirely
--   * "Bewteen" / "Less Then" / Corosion / SCRACTES / Aperature / Power Supply's fixed
--   * Video Games gains two flat-pay bands from its own reminder text
--   * "Check For Genuine Apple Parts" dropped from the two Android blocks
--   * hard preconditions flagged is_gate; they render above the ladder
-- ============================================================================

truncate public.mg_band_conditions, public.mg_bands, public.mg_devices,
         public.mg_help_items, public.mg_rebuttals, public.mg_tiers,
         public.mg_conditions restart identity cascade;
`);

out.push('\n-- tiers ---------------------------------------------------------------------');
out.push('insert into public.mg_tiers (id, slug, name, start_pct, team_pct, mgr_pct, sort_order) values');
out.push(TIERS.map(([slug, name, lo, hi, mgr], i) =>
  `  (${i + 1}, ${q(slug)}, ${q(name)}, ${lo}, ${hi}, ${mgr}, ${(i + 1) * 10})`).join(',\n') + ';');

out.push('\n-- condition grades ----------------------------------------------------------');
out.push('insert into public.mg_conditions (name, blurb, sort_order) values');
out.push(CONDITIONS.map(([n, b, s]) => `  (${q(n)}, ${q(b)}, ${s})`).join(',\n') + ';');

out.push('\n-- devices -------------------------------------------------------------------');
out.push('insert into public.mg_devices (id, category, device, help_key, sort_order) values');
out.push(devices.map((d, i) =>
  `  (${i + 1}, ${q(d.category)}, ${q(d.device)}, ${q(d.help_key)}, ${(i + 1) * 10})`).join(',\n') + ';');
out.push(`select setval(pg_get_serial_sequence('public.mg_devices', 'id'), ${devices.length});`);

out.push('\n-- bands ---------------------------------------------------------------------');
const bandRows = [];
let bandId = 0;
devices.forEach((d, di) => {
  [...d.bands.values()]
    .sort((a, b) => b.min - a.min)
    .forEach((b, bi) => {
      bandId++;
      b._id = bandId;
      bandRows.push(`  (${bandId}, ${di + 1}, ${q(b.label)}, ${b.min}, ${b.max === null ? 'null' : b.max}, ` +
        `${b.flat ? "'flat'" : "'percent'"}, ${b.flat ? b.flat[0] : 'null'}, ${b.flat ? b.flat[1] : 'null'}, ${(bi + 1) * 10})`);
    });
});
out.push('insert into public.mg_bands (id, device_id, label, price_min, price_max, pay_mode, flat_low, flat_high, sort_order) values');
out.push(bandRows.join(',\n') + ';');
out.push(`select setval(pg_get_serial_sequence('public.mg_bands', 'id'), ${bandId});`);

out.push('\n-- band x condition -> tier --------------------------------------------------');
const bcRows = [];
devices.forEach(d => [...d.bands.values()].forEach(b =>
  b.conds.forEach(c => bcRows.push(`  (${b._id}, ${q(c.cond)}, ${c.tier})`))));
out.push('insert into public.mg_band_conditions (band_id, condition, tier_id) values');
out.push(bcRows.join(',\n') + ';');

out.push('\n-- reminders / condition help / testing tips ---------------------------------');
out.push('insert into public.mg_help_items (help_key, kind, body, is_gate, is_must, sort_order) values');
out.push(helpItems.map(h =>
  `  (${q(h.key)}, ${q(h.kind)}, ${q(h.body)}, ${h.gate}, ${h.must && !h.gate}, ${h.sort})`).join(',\n') + ';');

out.push('\n-- rebuttals ----------------------------------------------------------------');
out.push('insert into public.mg_rebuttals (help_key, name, say, why, conditions, sort_order) values');
out.push(rebuttals.map(r =>
  `  (${q(r.key)}, ${q(r.name)}, ${qn(r.say)}, ${q(r.why)}, ` +
  `${r.conds.length ? `array[${r.conds.map(q).join(', ')}]::text[]` : `'{}'::text[]`}, ${r.sort})`).join(',\n') + ';');

const dest = path.join('c:/Users/User/Documents/GitHub/speeksnet/supabase/migrations/0006_margin_guide_seed.sql');
fs.writeFileSync(dest, out.join('\n') + '\n');

console.log('devices          ', devices.length);
console.log('bands            ', bandId);
console.log('band/cond rows   ', bcRows.length);
console.log('help items       ', helpItems.length, '| gates', helpItems.filter(h => h.gate).length, '| musts', helpItems.filter(h => h.must && !h.gate).length);
console.log('rebuttals        ', rebuttals.length, '| with say', rebuttals.filter(r => r.say).length, '| condition-tagged', rebuttals.filter(r => r.conds.length).length);
console.log('flat-pay bands   ', bandRows.filter(r => r.includes("'flat'")).length);
console.log('\nGATES:');
helpItems.filter(h => h.gate).forEach(h => console.log('  [' + h.key + '] ' + h.body.slice(0, 88)));

// ---------------------------------------------------------------------------
// Same data as the .sql above, as compact arrays-of-arrays. Posted straight to
// the margin-guide edge fn with curl, so a 116KB payload never has to be
// retyped by hand to get into the database.
// ---------------------------------------------------------------------------
const payload = {
  tiers: TIERS.map(([slug, name, lo, hi, mgr], i) => [i + 1, slug, name, lo, hi, mgr, (i + 1) * 10]),
  conditions: CONDITIONS.map(([n, b, srt]) => [n, b, srt]),
  devices: devices.map((d, i) => [i + 1, d.category, d.device, d.help_key, (i + 1) * 10]),
  bands: [],
  band_conditions: [],
  help_items: helpItems.map(h => [h.key, h.kind, h.body, h.gate, h.must && !h.gate, h.sort]),
  rebuttals: rebuttals.map(r => [r.key, r.name, r.say, r.why, r.conds, r.sort]),
};
devices.forEach((d, di) => {
  [...d.bands.values()].sort((a, b) => b.min - a.min).forEach((b, bi) => {
    payload.bands.push([b._id, di + 1, b.label, b.min, b.max,
      b.flat ? 'flat' : 'percent', b.flat ? b.flat[0] : null, b.flat ? b.flat[1] : null, (bi + 1) * 10]);
    b.conds.forEach(c => payload.band_conditions.push([b._id, c.cond, c.tier]));
  });
});
fs.writeFileSync(path.join(__dirname, 'margin-seed-payload.json'), JSON.stringify(payload));
console.log('payload rows     ', Object.entries(payload).map(([k, v]) => k + '=' + v.length).join(' '));
