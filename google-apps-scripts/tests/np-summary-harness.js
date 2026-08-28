// Offline harness: rebuild the NET PROFIT tab exactly as npProbeSummary and
// npProbeGrid measured it, then run npSummaryPreview against it. Catches
// off-by-one row maths and wrong A1 ranges before anything real is written.
const fs = require('fs');
const path = 'c:/Users/User/Documents/GitHub/speeksnet/google-apps-scripts/';

const R = 50, C = 107;
const values = Array.from({ length: R }, () => Array(C).fill(''));
const formulas = Array.from({ length: R }, () => Array(C).fill(''));

const BASES = { OVL: 0, LEE: 18, WSP: 36, MPL: 54, BAL: 72, TTL: 90 };
const LBLOFF = { OVL: 7, LEE: 6, WSP: 7, MPL: 7, BAL: 7, TTL: 6 }; // where "GP"/"Net Profit" text sits

function L(i0) { let n = i0 + 1, s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - r) / 26); } return s; }

let prevBase = null;
for (const [name, b] of Object.entries(BASES)) {
  values[0][b + 3] = '% of GP Goal';
  // NOTE: the real tab divides EVERY block by OVL's $E$2 — a copy-paste bug.
  formulas[0][b + 4] = `=IFERROR(INDEX(FILTER(${L(b + 12)}5:${L(b + 12)}35, ${L(b + 12)}5:${L(b + 12)}35<>""), COUNTA(FILTER(${L(b + 12)}5:${L(b + 12)}35, ${L(b + 12)}5:${L(b + 12)}35<>"")))/$E$2,"")`;
  // row 2 is a chain: only OVL holds a real date, TTL's link was never joined
  if (b === 0) values[1][b + 1] = new Date(2026, 6, 1);
  else if (name !== 'TTL') formulas[1][b + 1] = '=' + L(prevBase + 1) + '2';
  if (name !== 'TTL') {
    values[1][b + 2] = name;
    values[1][b + 3] = 'NP Goal';
  } else {
    values[1][b + 3] = 'TTL';   // the company block's own title, NOT a goal label
  }
  prevBase = b;
  // day rows 5..35 -> idx 4..34
  for (let d = 1; d <= 31; d++) {
    values[3 + d][b] = d;
    if (name !== 'TTL' && d <= 26) values[3 + d][b + 1] = 1000 + d;
    if (d === 34) {}  // Sales through the 26th
    formulas[3 + d][b + 3] = `=IF(ISBLANK(${L(b + 1)}${3 + d + 1}),"",(${L(b + 2)}${3 + d + 1}/${d})*${L(b + 2)}$40)`;
  }
  values[35][b] = 'TTL';
  formulas[35][b + 1] = `=SUM(${L(b + 1)}5:${L(b + 1)}35)`;

  values[37][b + 1] = 'Last month';
  values[37][b + LBLOFF[name]] = 'GP';
  values[38][b + LBLOFF[name]] = 'Net Profit';
  values[39][b + 1] = 'Days this month';
  values[40][b + 1] = 'Days Thru month';
  values[41][b + 1] = 'Net GP MTD';
  values[42][b + 1] = 'Net GP Tracking';
  values[43][b + 1] = 'Net GP MoM';
  if (name === 'OVL') { values[39][b + 2] = 31; values[40][b + 2] = 0; }
  else { formulas[39][b + 2] = '=C40'; formulas[40][b + 2] = '=C41'; }
  formulas[41][b + 2] = `=${L(b + 12)}36`;
  formulas[42][b + 2] = `=(${L(b + 2)}43/${L(b + 2)}41)*${L(b + 2)}40`;
  formulas[43][b + 2] = `=(${L(b + 2)}43/${L(b + 5)}39)-1`;
}
// YoY blocks exist only on OVL, LEE, TTL
for (const name of ['OVL', 'LEE', 'TTL']) {
  const b = BASES[name];
  values[40][b + 4] = 'YoY '; values[40][b + 5] = 'Revenue';
  values[41][b + 4] = 'Last';
  values[42][b + 4] = 'Current';
  values[43][b + 4] = 'Inc/Dec';
  const t = L(b + 3);
  formulas[42][b + 5] = `=IFERROR(INDEX(FILTER(${t}5:${t}35, ${t}5:${t}35<>""), COUNTA(FILTER(${t}5:${t}35, ${t}5:${t}35<>""))), "")`;
  formulas[43][b + 5] = `=(${L(b + 5)}43/${L(b + 5)}42)-1`;
}
formulas[41][95] = '=X42+F42';
formulas[42][95] = '=F43+X43+AN36';
values[45][94] = 'Same Store';
values[46][94] = 'YoY'; values[46][95] = 'Revenue';
values[47][94] = 'Last'; formulas[47][95] = '=X42+F42';
values[48][94] = 'Current'; formulas[48][95] = '=X43+F43';
values[49][94] = 'Inc/Dec'; formulas[49][95] = '=(CR49/CR48)-1';

// --- Apps Script stubs -----------------------------------------------------
const out = [];
global.Logger = { log: (...a) => {
  let i = 0;
  const s = typeof a[0] === 'string' ? a[0].replace(/%s/g, () => String(a[++i])).replace(/%%/g, '%') : String(a[0]);
  out.push(s);
} };
const rangeSet = [];
function mkRange(a1) {
  return { getA1Notation: () => a1,
           setFormula: v => rangeSet.push([a1, 'F', v]),
           setValue: v => rangeSet.push([a1, 'V', v]),
           setNumberFormat: () => {}, setNote: () => {} };
}
const sheet = {
  getLastRow: () => R, getLastColumn: () => C,
  getRange: (...a) => a.length === 1
    ? mkRange(a[0])
    : { getValues: () => values, getFormulas: () => formulas },
  getConditionalFormatRules: () => [],
  setConditionalFormatRules: () => {},
};
global.SpreadsheetApp = {
  openById: () => ({ getSheetByName: () => sheet }),
  newConditionalFormatRule: () => { const o = {}; ['whenFormulaSatisfied','setBackground','setFontColor','setRanges'].forEach(m => o[m] = () => o); o.build = () => ({ getRanges: () => [] }); return o; },
};
global.Utilities = { formatDate: (d, tz, fmt) => (fmt === 'yyyy-MM' ? d.toISOString().slice(0,7) : d.toISOString().slice(0,10)) };
global.__NOW = new Date();
global.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) };
global.Session = { getScriptTimeZone: () => 'America/Chicago' };
global.UrlFetchApp = { fetch: (url) => {
  const days = [];
  const ym = /from=([\d-]+)/.exec(url)[1].slice(0, 7);
  const n = new Date(Date.UTC(+ym.slice(0,4), +ym.slice(5,7), 0)).getUTCDate();
  for (let d = 1; d <= n; d++) days.push({ day: `${ym}-${String(d).padStart(2,'0')}`,
    net_sales: 1000, cost: 500, ebay_fee: 60, shipping_cost: 40, cc_fee: 30 });
  return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ days }) };
} };

let src = fs.readFileSync(path + 'netprofit-sheet.gs', 'utf8')
        + '\n' + fs.readFileSync(path + 'netprofit-summary.gs', 'utf8');
src = src.replace(/^var /gm, 'globalThis.').replace(/^function /gm, 'globalThis.$&');
eval(src.replace(/globalThis\.function (\w+)/g, 'globalThis.$1 = function $1'));

npSummaryPreview();
console.log(out.join('\n'));
