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

const sent = [];
global.GmailApp = { sendEmail: (to, subj, plain, opts) => sent.push({ to, subj, plain, html: opts && opts.htmlBody }) };

let src = ['netprofit-sheet.gs', 'netprofit-summary.gs', 'netprofit-rollover.gs',
           'netprofit-alerts.gs', 'netprofit-schedule.gs']
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

console.log('\n=== _npaDiff: what counts as a change ===');
const before = { days: { 'OVL:3': 2410.55, 'OVL:4': 900.00, 'LEE:3': 1200.00, 'WSP:9': 500.00 }, month: {} };
const after  = { days: {
  'OVL:3': 1902.18,   // -508.37  material, big
  'OVL:4': 1000.00,   // +100.00  under the reporting threshold
  'LEE:3': 1420.00,   // +220.00  material, but "minor" (under NPA_BIG_CHANGE)
  'WSP:9': 500.00,    //  0       unchanged
  'BAL:7': 4000.00,   // FIRST FILL — must never count as a change
}, month: {} };
const d = _npaDiff(before, after);
const by = {};
d.forEach(x => { by[x.store + ':' + x.day] = x; });
check(d.length === 2, `two material changes (got ${d.length}: ${d.map(x => x.store + ':' + x.day).join(', ')})`);
check(!!by['OVL:3'] && Math.abs(by['OVL:3'].delta + 508.37) < 0.005, 'OVL day 3 reported at -508.37');
check(!!by['LEE:3'] && Math.abs(by['LEE:3'].delta - 220) < 0.005, 'LEE day 3 reported at +220.00');
check(!by['OVL:4'], 'a $100 move is under the threshold and not reported');
check(!by['WSP:9'], 'an unchanged figure is not reported');
check(!by['BAL:7'], 'a day filled for the FIRST time is not a change');
check(d[0].store === 'OVL', 'sorted biggest move first');
check(_npaDiff(null, after).length === 0, 'no snapshot (first run of a month) reports nothing');

console.log('\n=== failure alert names who fixes it ===');
sent.length = 0;
_npaSendFailure('The 2pm daily refresh', 'OVL: collector returned HTTP 500',
  'Claude — the collector is failing, not the sheet.');
check(sent.length === 1, 'one email sent');
check(/did not complete/.test(sent[0].subj), `subject says what happened: "${sent[0].subj}"`);
check(/Who fixes it/.test(sent[0].html), 'body carries a "Who fixes it" block');
check(/HTTP 500/.test(sent[0].plain), 'plain-text alternative carries the detail');

console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
process.exit(fail ? 1 : 0);
