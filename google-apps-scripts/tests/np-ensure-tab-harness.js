// Focused harness for _npsEnsureTab — the auto-roll that fires unattended at
// 2pm on the 1st of each month. Stubs _nprRoll so this tests the DECISION
// (which month rolls to which, and whether it fires at all), not the clearing,
// which np-roll-harness.js already covers.
const fs = require('fs');
const path = 'c:/Users/User/Documents/GitHub/speeksnet/google-apps-scripts/';

const out = [];
global.Logger = { log: (...a) => {
  let i = 0;
  const s = typeof a[0] === 'string' ? a[0].replace(/%s/g, () => String(a[++i])) : String(a[0]);
  out.push(s);
} };

let tabs = new Set();
global.SpreadsheetApp = {
  openById: () => ({ getSheetByName: n => (tabs.has(n) ? { name: n } : null) }),
};
global.Utilities = { formatDate: (d, tz, f) => (f === 'yyyy-MM' ? d.toISOString().slice(0, 7) : d.toISOString().slice(0, 10)) };
global.Session = { getScriptTimeZone: () => 'America/Chicago' };
global.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) };
global.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{"days":[]}' }) };
global.ScriptApp = { getProjectTriggers: () => [] };

let src = ['netprofit-sheet.gs', 'netprofit-summary.gs', 'netprofit-rollover.gs', 'netprofit-schedule.gs']
  .map(f => fs.readFileSync(path + f, 'utf8')).join('\n');
src = src.replace(/^var /gm, 'globalThis.').replace(/^function /gm, 'globalThis.$&');
eval(src.replace(/globalThis\.function (\w+)/g, 'globalThis.$1 = function $1'));

// Stub the actual roll: record the decision, create the tab.
const rolls = [];
_nprRoll = function (preview) {
  rolls.push({ from: NPR_SOURCE_YM, to: NPR_TARGET_YM, preview });
  if (!preview) tabs.add(_npTabName(NPR_TARGET_YM));
};

let fail = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fail++; };

console.log('=== Oct 1: September exists, October does not ===');
tabs = new Set(['Net Profit Sep 26']);
rolls.length = 0;
let r = _npsEnsureTab('2026-10');
check(rolls.length === 1, 'rolled exactly once');
check(rolls[0] && rolls[0].from === '2026-09', `rolled FROM 2026-09 (got ${rolls[0] && rolls[0].from})`);
check(rolls[0] && rolls[0].to === '2026-10', `rolled TO 2026-10 (got ${rolls[0] && rolls[0].to})`);
check(rolls[0] && rolls[0].preview === false, 'rolled for real, not a preview');
check(r === true, 'reported success');
check(tabs.has('Net Profit Oct 26'), 'October tab now exists');
check(NPR_SOURCE_YM === '2026-09' && NPR_TARGET_YM === '2026-10',
  'globals restored to their committed defaults');

console.log('\n=== same day, second run: October already exists ===');
rolls.length = 0;
r = _npsEnsureTab('2026-10');
check(rolls.length === 0, 'did not roll again');
check(r === true, 'still reported success');

console.log('\n=== Jan 1: the year boundary ===');
tabs = new Set(['Net Profit Dec 26']);
rolls.length = 0;
_npsEnsureTab('2027-01');
check(rolls.length === 1 && rolls[0].from === '2026-12',
  `Jan 2027 rolls from Dec 2026 (got ${rolls[0] && rolls[0].from})`);
check(tabs.has('Net Profit Jan 27'), 'new tab is "Net Profit Jan 27", not "Jan 26"');

console.log('\n=== Sept 1: no August tab to roll from, and none needed ===');
tabs = new Set(['Net Profit Sep 26']);
rolls.length = 0;
r = _npsEnsureTab('2026-09');
check(rolls.length === 0, 'September already exists — no roll attempted');
check(r === true, 'reported success');

console.log('\n=== a gap: neither the month nor its predecessor exists ===');
tabs = new Set(['Net Profit Sep 26']);
rolls.length = 0;
r = _npsEnsureTab('2026-12');
check(rolls.length === 0, 'refused to roll from a month that is not there');
check(r === false, 'reported failure rather than pretending');
check(out.some(l => l.indexOf('no tab "Net Profit Dec 26"') >= 0),
  'said which tab was missing');

console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
process.exit(fail ? 1 : 0);
