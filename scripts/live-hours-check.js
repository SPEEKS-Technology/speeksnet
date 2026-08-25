// The two windows in shopify-live, over a whole week, hour by hour.
//
// These were ONE function until 20 Aug, and conflating them put a green "open"
// pill on the dashboard at 08:15 on a Sunday. They answer different questions:
//
//   isRefreshWindow  how often we call Shopify   every day 08:00-21:00
//   isTrading        are the doors open          Mon-Fri 10-19, Sat 10-16, never Sun
//
// The functions are pulled out of the deployed TypeScript and run directly, so
// this checks the real source rather than a copy of the rules that could drift
// away from it. No browser, no network — it is arithmetic.
const fs = require('fs');
const SRC = 'c:/Users/User/Documents/GitHub/speeksnet/supabase/functions/shopify-live/index.ts';

const src = fs.readFileSync(SRC, 'utf8');
const grab = (name) => {
    const m = src.match(new RegExp('function ' + name + '\\s*\\(c: Central\\): boolean \\{([\\s\\S]*?)\\n\\}'));
    if (!m) throw new Error('could not find ' + name + ' in ' + SRC);
    // Strip the TS type annotation and rebuild as plain JS.
    return new Function('c', m[1]);
};
const isRefreshWindow = grab('isRefreshWindow');
const isTrading = grab('isTrading');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let fails = 0;
const ok = (c, l, g) => { console.log('  ' + (c ? 'PASS ' : 'FAIL ') + l + (g === undefined ? '' : '   ' + g)); if (!c) fails++; };

// What each function SHOULD say, written out independently of the source.
const wantRefresh = (dow, h) => h >= 8 && h < 21;
const wantTrading = (dow, h) =>
    dow === 0 ? false : dow === 6 ? (h >= 10 && h < 16) : (h >= 10 && h < 19);

const bad = [];
const rows = [];
for (let dow = 0; dow < 7; dow++) {
    let line = '';
    for (let h = 0; h < 24; h++) {
        const c = { dow, hour: h };
        const r = !!isRefreshWindow(c), t = !!isTrading(c);
        if (r !== wantRefresh(dow, h)) bad.push(`refresh ${DAYS[dow]} ${h}:00 = ${r}`);
        if (t !== wantTrading(dow, h)) bad.push(`trading ${DAYS[dow]} ${h}:00 = ${t}`);
        // O = trading (green pill), · = refreshing but shut (grey pill), space = paused
        line += t ? 'O' : (r ? '·' : ' ');
    }
    rows.push(DAYS[dow] + ' |' + line + '|');
}

console.log('\n### the week, hour by hour   (O = open pill, · = grey, blank = paused)');
console.log('    |' + Array.from({ length: 24 }, (_, h) => String(h % 10)).join('') + '|');
rows.forEach(r => console.log('    ' + r));
console.log('');

ok(bad.length === 0, 'both windows match their stated hours at all 168 hours',
    bad.length ? bad.slice(0, 6).join(', ') : '168/168');

// The specific things that were wrong, named so a regression is unmistakable.
ok(!isTrading({ dow: 0, hour: 8 }) && !isTrading({ dow: 0, hour: 14 }),
    'never open on a Sunday', 'Sun 08:00 and 14:00 both closed');
ok(!isTrading({ dow: 1, hour: 8 }) && isTrading({ dow: 1, hour: 10 }),
    'Monday opens at 10, not at 08 with the refresh window', '08:00 shut, 10:00 open');
ok(isTrading({ dow: 6, hour: 15 }) && !isTrading({ dow: 6, hour: 16 }),
    'Saturday still shuts at 4', '15:00 open, 16:00 shut');
ok(isTrading({ dow: 5, hour: 18 }) && !isTrading({ dow: 5, hour: 19 }),
    'weekdays shut at 7', 'Fri 18:00 open, 19:00 shut');
// The grey state has to exist, or "closed but not final" has nowhere to live.
ok(isRefreshWindow({ dow: 0, hour: 12 }) && !isTrading({ dow: 0, hour: 12 }),
    'a Sunday noon is refreshing but shut — the grey pill', 'refresh true, trading false');
ok(isRefreshWindow({ dow: 3, hour: 20 }) && !isTrading({ dow: 3, hour: 20 }),
    'and so is 8pm on a Wednesday', 'refresh true, trading false');
// The refresh window must still cover every trading hour, or the pill would go
// green while the numbers behind it had stopped moving.
const uncovered = [];
for (let dow = 0; dow < 7; dow++) for (let h = 0; h < 24; h++)
    if (isTrading({ dow, hour: h }) && !isRefreshWindow({ dow, hour: h }))
        uncovered.push(DAYS[dow] + ' ' + h);
ok(uncovered.length === 0, 'every trading hour is inside the refresh window',
    uncovered.length ? uncovered.join(', ') : 'all covered');

console.log('\n' + (fails ? fails + ' FAILED' : 'the two windows are what they claim to be'));
process.exit(fails ? 1 : 0);
