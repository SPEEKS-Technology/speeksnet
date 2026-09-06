// Does the Sales tab's YoY "Last" get THIS month a year ago — and only that cell?
//
// The bug being tested for is a number that is right to the cent, in the right
// cell, in the right format, and a month out: September 2026's tab comparing
// itself against August 2025 because the rollover copied the cell forward. A
// harness for that has to assert on the MONTH KEY, not just on "a figure was
// written" — so every fixture below starts in the carried state (August's
// figures in September's cells) and the assertions name the September values.
//
// The real sales-yoy.gs is loaded whole into a vm context with Apps Script's
// globals stubbed, and the real NPX_YOY_2025 is lifted out of
// netprofit-summary.gs — the two files this fix spans, neither paraphrased.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(DIR, 'sales-yoy.gs'), 'utf8').replace(/\r\n/g, '\n');
const npx = fs.readFileSync(path.join(DIR, 'netprofit-summary.gs'), 'utf8').replace(/\r\n/g, '\n');

// The one copy of 2025, read out of the file that owns it. Brace-counted rather
// than regexed to the first '};' — the map is nested objects, and a lazy match
// would take OVL's row and call it the whole map.
function grabMap(source, name) {
    const start = source.indexOf('var ' + name + ' = {');
    if (start < 0) throw new Error('missing ' + name);
    const open = source.indexOf('{', start);
    let depth = 0, end = -1;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    if (end < 0) throw new Error('unterminated ' + name);
    return vm.runInNewContext('(' + source.slice(open, end + 1) + ')');
}
const YOY_2025 = grabMap(npx, 'NPX_YOY_2025');

const sandbox = {
    NPX_YOY_2025: YOY_2025,
    Logger: { log: () => {} },
    Utilities: { formatDate: () => '2026-09' },
    SpreadsheetApp: {},
};
vm.runInNewContext(src, sandbox);
const { _syoyPlan, _syoyBases, _syoyBlockOf, _syoyA1, _syoyIsBareNumber, _syoyIsPlusChain } = sandbox;

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};
const find = (res, a1) => res.plan.find(p => p.a1 === a1);

// ---------------------------------------------------------------------------
// A Sales tab, built the way the workbook builds one: 11 columns per store, the
// store code in the header rows, a day grid, then the footer strip with the YoY
// block four rows under it. `yoy` says which blocks exist and what their "Last"
// currently holds — the carried figure, in every fixture here.
//
// Column offsets inside a block are the ones measured on the March 2026 tab:
// label at +4, value at +5.
const W = 11;
function tab(opts) {
    const stores = opts.stores;                    // [{code, base}]
    const totals = opts.totals || [];              // [{base, row, last, formula}]
    const days = opts.days || 30;
    const width = opts.width || 66;
    const values = [], formulas = [];
    const blank = () => new Array(width).fill('');
    for (let r = 0; r < 60; r++) { values.push(blank()); formulas.push(blank()); }

    // header rows: "September 2026 | OVL | GP Goal | $81,000"
    stores.forEach(s => {
        values[1][s.base + 1] = 'September 2026';
        values[1][s.base + 2] = s.code;
        values[1][s.base + 3] = 'GP Goal';
        values[3][s.base] = 'Date';
    });
    // the TTL block carries its own goal cell and NO store code — the thing that
    // must not be mistaken for the last store's block.
    values[1][55 + 1] = 'September 2026';
    values[1][55 + 3] = 'GP Goal';

    for (let d = 1; d <= days; d++) {
        stores.forEach(s => { values[3 + d][s.base] = d; });
        values[3 + d][55] = d;
    }
    values[4 + days][0] = 'TTL';

    // the footer: "Last month", the day counts, and the Net GP strip the YoY
    // block sits beside.
    const fLast = 37, fDays = 39, fThru = 40, fMtd = 41, fTrack = 42, fMom = 43;
    stores.concat([{ code: 'TTL', base: 55 }]).forEach(s => {
        values[fLast][s.base + 1] = 'Last month';
        values[fDays][s.base + 1] = 'Days this month';
        values[fThru][s.base + 1] = 'Days Thru month';
        values[fMtd][s.base + 1] = 'Net GP MTD';
        values[fTrack][s.base + 1] = 'Net GP Tracking';
        values[fMom][s.base + 1] = 'Net GP MoM';
    });

    // the YoY blocks. Labels at +4, values at +5, four rows starting on the
    // "Days Thru month" row — as found on the real tab.
    const yoy = opts.yoy || [];
    yoy.forEach(b => {
        const r = b.row === undefined ? fThru : b.row;
        values[r][b.base + 4] = 'YoY ';                 // trailing space, as typed
        values[r][b.base + 5] = 'Revenue';
        values[r + 1][b.base + 4] = 'Last';
        values[r + 2][b.base + 4] = 'Current';
        values[r + 3][b.base + 4] = 'Inc/Dec';
        if (b.last !== undefined) values[r + 1][b.base + 5] = b.last;
        if (b.lastFormula) formulas[r + 1][b.base + 5] = b.lastFormula;
        values[r + 2][b.base + 5] = b.current === undefined ? 104146.20 : b.current;
        formulas[r + 2][b.base + 5] = b.currentFormula || '=INDEX(FILTER(D5:D35,D5:D35<>""),1)';
        values[r + 3][b.base + 5] = -0.014;
        formulas[r + 3][b.base + 5] = '=(' + _syoyA1(b.base + 5, r + 2) + '/' + _syoyA1(b.base + 5, r + 1) + ')-1';
    });
    return { values, formulas };
}

const SEP = { OVL: 92304.08, LEE: 72414.06, WSP: 69307.11 };
const AUG = { OVL: 105622.08, LEE: 52224.24, WSP: 61892.07 };

// ---------------------------------------------------------------------------
console.log('the map itself: the three same-store shops have a September 2025');
for (const [store, want] of Object.entries(SEP)) {
    ok(YOY_2025[store] && YOY_2025[store]['09'] === want,
        store + " NPX_YOY_2025['09'] is the 2025 tab's own TTL", '$' + want);
}
console.log('...and MPL and BAL have no 2025 at all');
ok(!YOY_2025.MPL, 'MPL has no 2025');
ok(!YOY_2025.BAL, 'BAL has no 2025');
console.log('...and the August figures the September tab was found holding are real');
for (const [store, aug] of Object.entries(AUG)) {
    ok(YOY_2025[store]['08'] === aug, store + " '08' is what the tab was carrying", '$' + aug);
}

// ---------------------------------------------------------------------------
// The September 2026 tab as found: five stores, YoY blocks for the three with a
// 2025, a TTL block summing two of them, and a Same Store block below.
console.log('\nSeptember 2026, as found — every carried August figure is replaced');
const sep = tab({
    stores: [{ code: 'OVL', base: 0 }, { code: 'LEE', base: 11 }, { code: 'WSP', base: 22 },
             { code: 'MPL', base: 33 }, { code: 'BAL', base: 44 }],
    yoy: [{ base: 0, last: AUG.OVL }, { base: 11, last: AUG.LEE }, { base: 22, last: AUG.WSP },
          { base: 55, last: AUG.OVL + AUG.LEE, lastFormula: '=F42+Q42' },
          { base: 55, row: 46, last: AUG.OVL + AUG.LEE + AUG.WSP }],
});
const res = _syoyPlan(sep.values, sep.formulas, '2026-09', YOY_2025);

ok(JSON.stringify(res.bases) === JSON.stringify({ OVL: 0, LEE: 11, WSP: 22, MPL: 33, BAL: 44 }),
    'the five store blocks are read off the tab', JSON.stringify(res.bases));
ok(res.blocks.length === 5, 'five YoY blocks found (3 stores, TTL, Same Store)',
    res.blocks.map(b => (b.store || 'total') + '@' + _syoyA1(b.col, b.row)).join(' '));
ok(res.blocks.filter(b => !b.store).length === 2,
    'the TTL and Same Store blocks are NOT attributed to BAL');

// The three store cells: right address, right month.
const CELLS = { OVL: 'F42', LEE: 'Q42', WSP: 'AB42' };
for (const [store, a1] of Object.entries(CELLS)) {
    const p = find(res, a1);
    ok(!!p && p.level === 'write', store + ' YoY "Last" @' + a1 + ' is written');
    if (!p) continue;
    ok(p.to === SEP[store], store + ' gets SEPTEMBER 2025', p.from + ' -> ' + p.to);
    ok(p.to !== AUG[store], store + ' does not get August 2025 again');
    ok(typeof p.note === 'string' && /September 2025/.test(p.note),
        store + "'s note names the month it holds");
}

// The totals: a chain over the three cells, not a frozen sum.
{
    const ttl = find(res, _syoyA1(60, 41));
    ok(!!ttl && ttl.level === 'write' && ttl.formula === true,
        'the TTL "Last" is rewritten as a formula', ttl && ttl.to);
    ok(!!ttl && ttl.to === '=F42+Q42+AB42',
        'and it sums all three same-store shops, not the two it had', ttl && ttl.to);
    const same = find(res, _syoyA1(60, 47));
    ok(!!same && same.to === '=F42+Q42+AB42',
        'the Same Store block gets the same chain', same && same.to);
}

// Nothing else. This is the assertion that would have caught a stride slip: the
// only cells in the plan are the five "Last" cells.
{
    const touched = res.plan.filter(p => p.level === 'write' || p.level === 'clear').map(p => p.a1).sort();
    ok(touched.length === 5, 'exactly five cells are touched', touched.join(' '));
    const currents = ['F43', 'Q43', 'AB43', 'F44', 'Q44', 'AB44'];
    ok(!currents.some(a1 => touched.indexOf(a1) >= 0),
        '"Current" and "Inc/Dec" are never written');
    ok(!res.plan.some(p => p.row < 36), 'no cell in the day grid or its headers is touched');
}

// ---------------------------------------------------------------------------
console.log('\nrunning it twice changes nothing the second time');
{
    const done = tab({
        stores: [{ code: 'OVL', base: 0 }, { code: 'LEE', base: 11 }, { code: 'WSP', base: 22 }],
        yoy: [{ base: 0, last: SEP.OVL }, { base: 11, last: SEP.LEE }, { base: 22, last: SEP.WSP },
              { base: 55, lastFormula: '=F42+Q42+AB42', last: 234025.25 }],
    });
    const r2 = _syoyPlan(done.values, done.formulas, '2026-09', YOY_2025);
    ok(!r2.plan.some(p => p.level === 'write' || p.level === 'clear'),
        'a correct tab plans no writes',
        r2.plan.map(p => p.level + '@' + p.a1).join(' '));
    ok(r2.plan.filter(p => p.level === 'already').length === 4, 'all four read as already right');
}

// ---------------------------------------------------------------------------
console.log('\na store with no comparable year is emptied, not left holding a number');
{
    // WSP's June: it opened mid-June 2025 and the map deliberately has no '06'.
    // The carried May figure in that cell is the bug in its purest form.
    const jun = tab({
        stores: [{ code: 'OVL', base: 0 }, { code: 'LEE', base: 11 }, { code: 'WSP', base: 22 }],
        yoy: [{ base: 0, last: 109923.94 }, { base: 11, last: 54412.59 }, { base: 22, last: 44000 }],
        days: 30,
    });
    const r3 = _syoyPlan(jun.values, jun.formulas, '2026-06', YOY_2025);
    ok(!YOY_2025.WSP['06'], 'the map has no WSP June 2025 (its opening month)');
    const wsp = find(r3, 'AB42');
    ok(!!wsp && wsp.level === 'clear', 'WSP June YoY "Last" is cleared', wsp && wsp.from);
    ok(find(r3, 'F42').to === YOY_2025.OVL['06'], 'OVL still gets its June 2025');
    // and the total must then be OVL+LEE only — WSP has nothing to add.
    const ttl = find(r3, _syoyA1(60, 41));
    ok(!ttl || ttl.to === undefined || ttl.to === '=F42+Q42',
        'the total falls back to the two stores that have a June', ttl && ttl.to);
}

// ---------------------------------------------------------------------------
console.log('\na formula in a "Last" cell is somebody\'s work and is left alone');
{
    const wired = tab({
        stores: [{ code: 'OVL', base: 0 }, { code: 'LEE', base: 11 }, { code: 'WSP', base: 22 }],
        yoy: [{ base: 0, last: AUG.OVL, lastFormula: '=IMPORTRANGE("abc","Sales Sep 25!B36")' },
              { base: 11, last: AUG.LEE }, { base: 22, last: AUG.WSP },
              { base: 55, last: AUG.OVL + AUG.LEE, lastFormula: '=F42+Q42' }],
    });
    const r4 = _syoyPlan(wired.values, wired.formulas, '2026-09', YOY_2025);
    const p = find(r4, 'F42');
    ok(!!p && p.level === 'skip', 'the IMPORTRANGE cell is skipped');
    ok(r4.warnings.some(w => /IMPORTRANGE/.test(w)), 'and it is warned about, not swallowed');
    ok(find(r4, 'Q42').level === 'write', 'the other stores are still fixed');
    // ⚠️ AND THE TOTAL STILL SUMS ALL THREE. Dropping OVL from the chain because
    // this run could not write its cell would put two stores' "Last" against
    // three stores' "Current" — the two-against-three fiction, reintroduced by a
    // fix. The chain is "the stores with a comparable year", not "the cells this
    // run happened to write"; only a store with no 2025 at all leaves it.
    const ttl = find(r4, _syoyA1(60, 41));
    ok(!!ttl && ttl.to === '=F42+Q42+AB42',
        'the total still spans every store with a September 2025', ttl && ttl.to);
}

// ---------------------------------------------------------------------------
console.log('\nblock attribution and the label guards');
{
    const bases = { OVL: 0, LEE: 11, WSP: 22, MPL: 33, BAL: 44 };
    ok(_syoyBlockOf(bases, 4) === 'OVL', "OVL's YoY label column belongs to OVL");
    ok(_syoyBlockOf(bases, 48) === 'BAL', "BAL's block reaches column 48");
    ok(_syoyBlockOf(bases, 59) === null, 'the TTL block belongs to no store');
    ok(_syoyBlockOf(bases, 60) === null, 'nor does anything past it');

    // A "YoY" with something else under it is not a YoY block. The workbook has
    // "YoY" text in other places and a four-row assumption would write into
    // whatever sat below one of them.
    const odd = tab({ stores: [{ code: 'OVL', base: 0 }], yoy: [] });
    odd.values[41][4] = 'YoY';
    odd.values[42][4] = 'Margin';
    const r5 = _syoyPlan(odd.values, odd.formulas, '2026-09', YOY_2025);
    ok(!r5.blocks.length, 'a "YoY" without "Last" under it is not a block');
    ok(!r5.plan.length, 'and nothing is planned from it');
    ok(r5.warnings.some(w => /not "Last"/.test(w)), 'it is reported rather than ignored');
}

// ---------------------------------------------------------------------------
// Measured on the live Sales Sep 26 tab, 2026-09-03, by salesYoyPreview:
//   4 blocks — OVL@F41 LEE@Q41 WSP@AB41 total@BI41
//   BI41 held '=Q41+F41+AB41'  (the same three cells, LEE first)
//   BI42 holds '=F42+Q42+Z35+AK35+AV35'  (five stores)
console.log('\nthe live September geometry: term order is not a change');
{
    const live = tab({
        stores: [{ code: 'OVL', base: 0 }, { code: 'LEE', base: 11 }, { code: 'WSP', base: 22 },
                 { code: 'MPL', base: 33 }, { code: 'BAL', base: 44 }],
        yoy: [{ base: 0, row: 39, last: AUG.OVL }, { base: 11, row: 39, last: AUG.LEE },
              { base: 22, row: 39, last: AUG.WSP },
              { base: 55, row: 39, last: AUG.OVL + AUG.LEE + AUG.WSP,
                lastFormula: '=Q41+F41+AB41',
                currentFormula: '=F42+Q42+Z35+AK35+AV35' }],
    });
    const r6 = _syoyPlan(live.values, live.formulas, '2026-09', YOY_2025);
    ok(r6.blocks.map(b => (b.store || 'total') + '@' + _syoyA1(b.col, b.row)).join(' ')
        === 'OVL@F41 LEE@Q41 WSP@AB41 total@BI41',
        'the four blocks are found where the live preview found them');
    const ttl = find(r6, 'BI41');
    ok(!!ttl && ttl.level === 'already',
        '=Q41+F41+AB41 is already the same-store sum and is left as typed', ttl && ttl.why);
    const written = r6.plan.filter(p => p.level === 'write' || p.level === 'clear').map(p => p.a1).sort();
    ok(written.join(' ') === 'AB41 F41 Q41', 'only the three store cells are written', written.join(' '));
    ok(!r6.plan.some(p => p.a1 === 'BI42'),
        'the five-store "Current" is reported, not rewritten, by default');
    ok(r6.warnings.length === 0, 'and the tab produces no warnings', r6.warnings.join(' | '));
}

console.log('\nSYOY_SAME_STORE_CURRENT: the company row, when it is asked for');
{
    const live = tab({
        stores: [{ code: 'OVL', base: 0 }, { code: 'LEE', base: 11 }, { code: 'WSP', base: 22 },
                 { code: 'MPL', base: 33 }, { code: 'BAL', base: 44 }],
        yoy: [{ base: 0, row: 39, last: SEP.OVL }, { base: 11, row: 39, last: SEP.LEE },
              { base: 22, row: 39, last: SEP.WSP },
              { base: 55, row: 39, lastFormula: '=F41+Q41+AB41',
                currentFormula: '=F42+Q42+Z35+AK35+AV35' }],
    });
    sandbox.SYOY_SAME_STORE_CURRENT = true;
    const on = _syoyPlan(live.values, live.formulas, '2026-09', YOY_2025);
    const cur = find(on, 'BI42');
    ok(!!cur && cur.level === 'write' && cur.to === '=F42+Q42+AB42',
        'the five-store Current becomes the three same-store cells', cur && cur.to);
    ok(!!cur && /MPL and BAL/.test(cur.note || ''),
        'and its note says which stores left and why');
    ok(!on.plan.some(p => ['F42', 'Q42', 'AB42'].indexOf(p.a1) >= 0),
        "no STORE's own Current is touched — only the company block's");

    // A Current that is not a plus-chain is somebody else's construction.
    const odd = tab({
        stores: [{ code: 'OVL', base: 0 }, { code: 'LEE', base: 11 }, { code: 'WSP', base: 22 }],
        yoy: [{ base: 0, row: 39, last: SEP.OVL }, { base: 11, row: 39, last: SEP.LEE },
              { base: 22, row: 39, last: SEP.WSP },
              { base: 55, row: 39, lastFormula: '=F41+Q41+AB41',
                currentFormula: '=SUM(D35,O35,Z35,AK35,AV35)' }],
    });
    const r7 = _syoyPlan(odd.values, odd.formulas, '2026-09', YOY_2025);
    ok(find(r7, 'BI42').level === 'skip', 'a SUM() Current is skipped, not rewritten');
    ok(r7.warnings.some(w => /SUM\(/.test(w)), 'and warned about');
    sandbox.SYOY_SAME_STORE_CURRENT = false;
    const off = _syoyPlan(live.values, live.formulas, '2026-09', YOY_2025);
    ok(!off.plan.some(p => p.a1 === 'BI42'), 'switched off, the row is untouched again');
}

console.log('\nthe replace guards');
ok(_syoyIsBareNumber('=105622.08') === true, '=105622.08 is a bare number');
ok(_syoyIsBareNumber('=SUM(B5:B35)') === false, '=SUM(...) is not');
ok(_syoyIsPlusChain('=F42+Q42+AB42') === true, '=F42+Q42+AB42 is a plus-chain');
ok(_syoyIsPlusChain('=F42+Q42*2') === false, 'anything else is not');
ok(_syoyIsPlusChain('=SUM(F42:AB42)') === false, 'a SUM range is not a plus-chain');
ok(_syoyIsPlusChain('=IMPORTRANGE("x","y")') === false, 'nor is an IMPORTRANGE');

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
