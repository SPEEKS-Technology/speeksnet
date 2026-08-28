// Offline harness for netprofit-rollover.gs. Rebuilds the measured tab, fills
// the day grid and summary with July-like data, then runs the blank-in-place
// preview AND apply, recording every cell touched.
const fs = require('fs');
const path = 'c:/Users/User/Documents/GitHub/speeksnet/google-apps-scripts/';

const R = 50, C = 107;
const values = Array.from({ length: R }, () => Array(C).fill(''));
const formulas = Array.from({ length: R }, () => Array(C).fill(''));
const notes = Array.from({ length: R }, () => Array(C).fill(''));

const BASES = { OVL: 0, LEE: 18, WSP: 36, MPL: 54, BAL: 72, TTL: 90 };
const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
function L(i0) { let n = i0 + 1, s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - r) / 26); } return s; }

for (const [name, b] of Object.entries(BASES)) {
  values[0][b + 3] = '% of GP Goal';
  values[1][b + 3] = name === 'TTL' ? 'TTL' : 'NP Goal';
  if (name !== 'TTL') values[1][b + 4] = 50000;          // a goal, must be cleared
  for (let d = 1; d <= 31; d++) {
    values[3 + d][b] = d;
    if (name !== 'TTL') {
      values[3 + d][b + 1] = 1000 + d;   // Sales
      values[3 + d][b + 4] = 500;        // Cost
      values[3 + d][b + 9] = 60;         // eBay Fee
      values[3 + d][b + 10] = 40;        // Shipping
      values[3 + d][b + 11] = 30;        // CC Fee
      notes[3 + d][b + 1] = 'carried note that must not survive';
    }
    formulas[3 + d][b + 2] = '=SOMETHING';   // Total  — a formula, must survive
    formulas[3 + d][b + 12] = '=NPFORMULA';  // NP     — a formula, must survive
  }
  values[35][b] = 'TTL';
  formulas[35][b + 1] = `=SUM(${L(b + 1)}5:${L(b + 1)}35)`;
  values[37][b + 1] = 'Last month';
  values[39][b + 1] = 'Days this month';
  values[40][b + 1] = 'Days Thru month';
  if (name === 'TTL') {
    formulas[37][b + 2] = '=C38+U38+AM38+BE38+BW38';   // roll-up, must survive
    formulas[37][b + 5] = '=F38+X38+AP38+BH38+BZ38';
    formulas[38][b + 5] = '=F39+X39+AP39+BH39+BZ39';
  } else {
    values[37][b + 2] = 139875.87;   // last-month revenue, must be cleared
    values[37][b + 5] = 73690.22;    // last-month GP
    values[38][b + 5] = 62700.45;    // last-month NP
  }
  if (name === 'OVL') { values[39][b + 2] = 31; values[40][b + 2] = 31; }
  else { formulas[39][b + 2] = '=C40'; formulas[40][b + 2] = '=C41'; }
}
for (const name of ['OVL', 'LEE', 'TTL']) {
  const b = BASES[name];
  values[40][b + 4] = 'YoY';
  values[41][b + 4] = 'Last';
  if (name === 'TTL') formulas[41][b + 5] = '=F42+X42+AP42';
  else values[41][b + 5] = 132120.44;   // YoY base, must be cleared
}

// --- stubs ------------------------------------------------------------------
const out = [];
global.Logger = { log: (...a) => {
  let i = 0;
  const s = typeof a[0] === 'string' ? a[0].replace(/%s/g, () => String(a[++i])).replace(/%%/g, '%') : String(a[0]);
  out.push(s);
} };
const touched = { content: [], note: [], set: [] };
function a1(r1, c1) { return L(c1 - 1) + r1; }
function col(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
// getRangeList takes A1 strings, including ranges like "B5:B35"
function expand(a) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(a);
  if (!m) return [a];
  const out = [];
  for (let r = +m[2]; r <= +m[4]; r++) out.push(m[1] + r);
  return out;
}
function hit(bucket, grid, a) {
  for (const c of expand(a)) {
    bucket.push(c);
    const m = /^([A-Z]+)(\d+)$/.exec(c);
    grid[+m[2] - 1][col(m[1])] = '';
  }
}
function mkRange(r1, c1, nR = 1, nC = 1) {
  return {
    getA1Notation: () => a1(r1, c1),
    getFormula: () => formulas[r1 - 1][c1 - 1],
    getValues: () => values, getFormulas: () => formulas,
    clearContent: () => { for (let i = 0; i < nR; i++) { touched.content.push(a1(r1 + i, c1)); values[r1 - 1 + i][c1 - 1] = ''; } },
    clearNote: () => { for (let i = 0; i < nR; i++) { touched.note.push(a1(r1 + i, c1)); notes[r1 - 1 + i][c1 - 1] = ''; } },
    setValue: v => { touched.set.push([a1(r1, c1), v]); values[r1 - 1][c1 - 1] = v; },
    setFormula: () => {}, setNumberFormat: () => {}, setNote: () => {},
  };
}
const sheet = {
  getName: () => 'Net Profit Sep 26',
  getLastRow: () => R, getLastColumn: () => C, getIndex: () => 3,
  getRange: (...a) => a.length === 1
    ? mkRange(Number(/\d+/.exec(a[0])[0]), 1)
    : mkRange(a[0], a[1], a[2] || 1, a[3] || 1),
  getRangeList: (list) => ({
    clearContent: () => list.forEach(a => hit(touched.content, values, a)),
    clearNote: () => list.forEach(a => hit(touched.note, notes, a)),
  }),
  getConditionalFormatRules: () => [], setConditionalFormatRules: () => {},
};
global.SpreadsheetApp = {
  openById: () => ({
    getSheetByName: n => (n === 'Net Profit Sep 26' ? sheet : null),
    getSheets: () => [{ getName: () => 'Net Profit Sep 26' }],
  }),
};
global.Utilities = { formatDate: d => d.toISOString().slice(0, 10) };
global.Session = { getScriptTimeZone: () => 'America/Chicago' };
global.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) };
global.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{"days":[]}' }) };

let src = ['netprofit-sheet.gs', 'netprofit-summary.gs', 'netprofit-rollover.gs']
  .map(f => fs.readFileSync(path + f, 'utf8')).join('\n');
src = src.replace(/^var /gm, 'globalThis.').replace(/^function /gm, 'globalThis.$&');
eval(src.replace(/globalThis\.function (\w+)/g, 'globalThis.$1 = function $1'));

NPR_BLANK_YM = '2026-09';
npRollBlankApply();
console.log(out.join('\n'));

// --- assertions -------------------------------------------------------------
const cleared = new Set(touched.content);
let fail = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fail++; };
console.log('\n=== assertions ===');
check(touched.content.length === 775 + 26, `cleared ${touched.content.length} cells (775 day + 26 summary: 5 cells x 6 blocks, less the 4 TTL roll-up formulas)`);
for (const s of STORES) {
  const b = BASES[s];
  check(cleared.has(L(b + 1) + '5') && cleared.has(L(b + 1) + '35'), `${s} Sales column cleared end to end`);
  check(!cleared.has(L(b + 2) + '5'), `${s} Total column (a formula) untouched`);
  check(!cleared.has(L(b + 12) + '5'), `${s} NP column (a formula) untouched`);
  check(cleared.has(L(b + 4) + '2'), `${s} NP Goal cleared`);
  check(cleared.has(L(b + 2) + '38') && cleared.has(L(b + 5) + '39'), `${s} last-month values cleared`);
}
const tb = BASES.TTL;
check(!cleared.has(L(tb + 1) + '5'), 'TTL day grid untouched');
check(!cleared.has(L(tb + 2) + '38'), 'TTL last-month roll-up FORMULA kept');
check(!cleared.has(L(tb + 5) + '39'), 'TTL last-month NP roll-up FORMULA kept');
check(cleared.has('F42') && cleared.has('X42'), 'YoY base cleared at OVL and LEE');
check(!cleared.has(L(tb + 5) + '42'), 'TTL YoY roll-up FORMULA kept');
const thru = touched.set.find(x => x[0] === 'C41');
check(thru && thru[1] === 0, 'Days Thru reset to 0');
check(!touched.set.some(x => x[0] === 'U41'), 'LEE Days Thru (=C41 chain) not written');
check(notes[4][1] === '', 'carried note on a cleared day cell is gone');
console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
