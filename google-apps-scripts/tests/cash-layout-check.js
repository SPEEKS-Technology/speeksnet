// _parseCash against both Cash Management layouts of the Day End Report.
//
// Until 2026-10-02:  Buying Drawer Balance / PayStation Balance / Safe Balance /
//                    Cash Balance (the drawer) / Total Cash on Hand
// From  2026-10-03:  Safe Balance / Buying Drawer Balance / Total Cash on Hand
//
// The new layout made every drawer NO MATCH. "Buying Drawer Balance" is the
// drawer now, but was the WRONG pot in the old layout, so it must only be taken
// when "Cash Balance" is absent and the three add up.
//
//   node google-apps-scripts/tests/cash-layout-check.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'sales-email-import.gs'), 'utf8').replace(/\r\n/g, '\n');
const grab = name => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
const konst = name => {
    const i = src.indexOf('var ' + name + ' ');
    if (i < 0) throw new Error('missing var ' + name);
    return src.slice(i, src.indexOf(';', i) + 1) + '\n';
};
eval(['CASH_DRAWER_LABELS', 'CASH_DRAWER_NEW_LAYOUT', 'CASH_SAFE_LABELS', 'CASH_TOTAL_LABELS',
      'CASH_STOPS', 'CASH_TOTAL_TOLERANCE'].map(konst).join('')
   + ['_money', '_valueAfterLabel', '_findLabeledNear', '_parseCash'].map(grab).join('\n'));

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

// getPlainBody() puts each card cell on its own line, with a trend delta after.
const card = (label, amt) => label + '\n$' + amt + '\n▲ 0%\n';
const grid = '$100 X 3\n$50 X 0\n$20 X 2\n';

console.log('== old layout (to 2026-10-02) ==');
const old = 'Cash Management \n'
    + card('Buying Drawer Balance', '9,999.00')
    + card('PayStation Balance', '50.00')
    + card('Safe Balance', '3,325.00')
    + card('Cash Balance', '1,160.00') + 'Cash Drawer Cash count bills\n' + grid
    + card('Total Cash on Hand', '4,485.00');
let c = _parseCash(old);
ok(c.drawer === 1160, 'drawer is Cash Balance, not Buying Drawer Balance', c.drawer);
ok(c.safe === 3325 && c.total === 4485 && !c.why, 'safe, total, and it adds up', JSON.stringify(c));

// The old layout with an empty Cash Balance card must NOT fall through to the
// Buying Drawer Balance figure: that was the wrong pot of money.
const oldEmpty = old.replace(card('Cash Balance', '1,160.00'), 'Cash Balance\n\n');
c = _parseCash(oldEmpty);
ok(c.drawer === null, 'old layout, empty Cash Balance -> blank, never the other pot', c.drawer);

console.log('== new layout (from 2026-10-03) — BAL\'s real figures ==');
const neu = 'Cash Management \n'
    + card('Safe Balance', '400.00')
    + card('Buying Drawer Balance', '345.00')
    + card('Total Cash on Hand', '745.00')
    + 'Can’t display denominations since last entry in the ledger wasn’t a cash \n';
c = _parseCash(neu);
ok(c.drawer === 345, 'drawer read from Buying Drawer Balance', c.drawer);
ok(c.safe === 400 && c.total === 745 && !c.why, 'safe and total unchanged, nothing flagged', JSON.stringify(c));

const lee = card('Safe Balance', '5,000.00') + card('Buying Drawer Balance', '3,095.00') + card('Total Cash on Hand', '8,095.00');
ok(_parseCash(lee).drawer === 3095, 'LEE: thousands separator', _parseCash(lee).drawer);

console.log('== new layout that does not add up is refused ==');
const bad = card('Safe Balance', '400.00') + card('Buying Drawer Balance', '100.00') + card('Total Cash on Hand', '745.00');
c = _parseCash(bad);
ok(c.drawer === null, 'safe + drawer != total -> drawer left blank', c.drawer);
ok(/refused/.test(c.why || ''), 'and says why', c.why);
const noTotal = card('Safe Balance', '400.00') + card('Buying Drawer Balance', '345.00');
ok(_parseCash(noTotal).drawer === null, 'no total to check against -> blank');

console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
