// Where the reviews block reads its month total and projection.
//
// This has now been wrong twice, in opposite directions, and both are asserted
// here because both were plausible-looking answers:
//
//   1. PINNED TO ROW 35. Right in a 31-day month only. On 2026-09-01 the grid
//      had lost a row, so 35 held the PROJECTION — every store reported exactly
//      26x its real count and the company tile read 5,148 against a goal of 185.
//
//   2. SCANNED THE DAY COLUMN. Looked safer — read the sheet rather than assume
//      — and was wrong on its first run. month-rollover.gs renumbers the day
//      column of each STORE block, found from the header row; the reviews
//      mini-table at AE:AK is not one of them, so after the 31-to-30 rollover it
//      read 1..29 then 31, day 30's row being the one deleted. The scan stopped
//      at 29, put the total two rows high, and served 0 for every store while
//      the projection cell answered with the total.
//
// Both files now derive the rows from _hubRows() in Code.gs, which is the same
// arithmetic month-rollover.gs used to size the grid in the first place.
const fs = require('fs');
const path = require('path');

const HUB = path.join(__dirname, '..', 'hub-code.gs');
const REV = path.join(__dirname, '..', 'hub-reviews-file.gs');
const hubSrc = fs.readFileSync(HUB, 'utf8');
const revSrc = fs.readFileSync(REV, 'utf8');

const grab = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('missing ' + name);
    return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
eval(grab(hubSrc, '_hubRows'));

let fails = 0;
const ok = (c, l, g) => {
    console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g));
    if (!c) fails++;
};

console.log('== It uses the hub arithmetic, not its own ==');
ok(/_hubRows\(new Date\(\)\)/.test(revSrc), 'the reviews block calls _hubRows');
ok(!/AE4:AE40/.test(revSrc), 'and no longer scans the day column');
ok(!/getRange\(c \+ '35'\)/.test(revSrc), 'and is not pinned to row 35');
ok(/R\.buyTotal/.test(revSrc) && /R\.buyProj/.test(revSrc), 'total and projection both come from it');

console.log('== The rows it now reads ==');
// The reviews block lives on the BUY tab and shares its geometry: day 1 on row
// 4, the MAX row under the last day, the projection under that.
const aug = _hubRows(new Date(2026, 7, 15));
ok(aug.buyTotal === 35 && aug.buyProj === 36,
   '31-day month: 35 and 36 — the documented AF35 / AF36',
   aug.buyTotal + ' / ' + aug.buyProj);
const sep = _hubRows(new Date(2026, 8, 2));
ok(sep.buyTotal === 34 && sep.buyProj === 35,
   '30-day month: 34 and 35', sep.buyTotal + ' / ' + sep.buyProj);
ok(sep.buyLast === 33, 'and the grid it reads ends at 33', String(sep.buyLast));

console.log('== Both ways of getting it wrong ==');
// 1. Pinned to 35 in September: that is the projection row.
ok(sep.buyProj === 35, 'pinned-to-35 read the projection', 'proj row is ' + sep.buyProj);
ok(36 * 26 === 936 && 936 + 962 + 988 + 1170 + 1092 === 5148,
   'which is how BAL 36 became 936 and the tile read 5,148');
// 2. The scan stopped at day 29, so lastDay was 32 rather than 33.
const scanned = 4 + 28;
ok(scanned === 32, 'the scan stopped at day 29 -> lastDay 32', String(scanned));
ok(scanned + 1 === 33 && scanned + 2 === 34,
   'so it read row 33 (a blank day) as the total and row 34 (the real total) as the projection');
ok(sep.buyTotal === scanned + 2,
   'which is exactly why every store reported mtd 0 with proj equal to its real count');

console.log(fails ? '\n' + fails + ' FAILED' : '\nall pass');
process.exit(fails ? 1 : 0);
