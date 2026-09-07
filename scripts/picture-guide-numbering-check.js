// Lifts the REAL numbering functions out of speeks.js (no copy) and checks them
// against the three printouts. The whole point of the Picture Guide is that the
// numbers are computed, so this is the one piece that has to be provably right.
const fs = require('fs');
const src = fs.readFileSync('c:/Users/User/Documents/GitHub/speeksnet/speeks.js', 'utf8');

const from = src.indexOf('function _pgSequence()');
const to   = src.indexOf('function pgPick(');
if (from < 0 || to < 0) { console.error('FAIL: could not find the numbering block'); process.exit(1); }
const block = src.slice(from, to);

let _pgState = { catId: 1, applies: {}, reps: {} };
let SHOTS = [];
const _pgShots = () => SHOTS;
const ctx = { _pgState, _pgShots };
const fn = new Function('_pgState', '_pgShots',
  block + '\nreturn { _pgSequence, _pgNum, _pgLive, _pgTotal, _pgDefaultApplies };');
const api = fn(_pgState, _pgShots);

// The tablet sheet, in order, with the ids the seed would give it.
SHOTS = [
  { id: 1,  label: 'Home/Lock Screen' },
  { id: 2,  label: 'Everything Included', cond: 'Everything Included' },
  { id: 3,  label: 'About Phone' },
  { id: 4,  label: 'Storage Information' },
  { id: 5,  label: 'Setting Unlock Screen', cond: 'Unlock screen set' },
  { id: 6,  label: 'LCD Flaws', cond: 'LCD flaws', rep: true },
  { id: 7,  label: 'Screen Off' },
  { id: 8,  label: 'Back of Tablet' },
  { id: 9,  label: 'Bottom Side of Tablet' },
  { id: 10, label: 'Top Side of Tablet' },
  { id: 11, label: 'Top Corner of Tablet' },
  { id: 12, label: 'Opposite Top Corner of Tablet' },
  { id: 13, label: 'Bottom Corner of Tablet' },
  { id: 14, label: 'Opposite Bottom Corner of Tablet' },
  { id: 15, label: 'Cosmetic Flaws', cond: 'Cosmetic flaws', rep: true },
  { id: 16, label: 'Extra Accessories', cond: 'Extra accessories', rep: true },
];

let fails = 0;
const nums = () => api._pgSequence().map(api._pgNum).join(' ');
function is(what, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}\n       got  ${got}\n       want ${want}`);
}

// 1. Everything applies -> the printed page, straight 1..16.
api._pgDefaultApplies();
is('all conditionals on', nums(), '1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16');
is('all on: total', api._pgTotal(), 16);

// 2. THE RULE, as Ethan stated it: "if the optional one is not applicable then
//    the next one is the true #2". Switch off Everything Included -> About Phone
//    becomes 2, and everything behind it closes up.
api._pgDefaultApplies();
_pgState.applies[2] = false;
is('Everything Included off -> About Phone is 2',
   api._pgSequence()[2] && api._pgNum(api._pgSequence()[2]), '2');
is('...and the skipped slot reads N/A', api._pgNum(api._pgSequence()[1]), 'N/A');
is('...and the total drops by one', api._pgTotal(), 15);

// 3. A clean tablet: no box, no unlock screen, no LCD flaws, no scratches, no
//    extras. Five conditionals off -> eleven photos numbered 1..11 with no gaps.
api._pgDefaultApplies();
[2, 5, 6, 15, 16].forEach(id => { _pgState.applies[id] = false; });
is('clean tablet: only the always-shots are numbered',
   api._pgLive().map(api._pgNum).join(' '), '1 2 3 4 5 6 7 8 9 10 11');
is('clean tablet: total', api._pgTotal(), 11);

// 4. The printed "+": three LCD flaws makes shot 6 a RANGE, and everything after
//    it shifts by two. This is what the paper writes as "4+" and cannot resolve.
api._pgDefaultApplies();
_pgState.reps[6] = 3;
is('LCD flaws x3 occupies 6-8', api._pgNum(api._pgSequence()[5]), '6–8');
is('...Screen Off moves from 7 to 9', api._pgNum(api._pgSequence()[6]), '9');
is('...total is 18, not 16', api._pgTotal(), 18);

// 5. A repeatable that is switched OFF must not consume its range.
api._pgDefaultApplies();
_pgState.reps[6] = 4;
_pgState.applies[6] = false;
is('repeatable off ignores its count', api._pgNum(api._pgSequence()[6]), '6');
is('...total unaffected by the stale count', api._pgTotal(), 15);

// 6. Ticks are keyed by shot id, so a DM reordering the sheet must not re-point
//    them. Move Screen Off above LCD Flaws and the SAME shots stay off.
api._pgDefaultApplies();
_pgState.applies[6] = false;
const before = api._pgLive().map(r => r.s.id).join(',');
SHOTS = [SHOTS[0], SHOTS[1], SHOTS[2], SHOTS[3], SHOTS[4], SHOTS[6], SHOTS[5], ...SHOTS.slice(7)];
const after = api._pgLive().map(r => r.s.id).sort((a, b) => a - b).join(',');
is('reorder does not re-point the ticks', after, before.split(',').sort((a, b) => a - b).join(','));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
