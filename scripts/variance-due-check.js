// Does the day-based variance deadline behave, against the REAL rows?
// Mirrors the helpers added to speeks.js verbatim.
const _vrCtDay  = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const _vrDayPast = (nowMs, ms, addDays = 0) =>
    !!ms && _vrCtDay(nowMs) > _vrCtDay(ms + addDays * 86400000);

const T = s => new Date(s).getTime();

// The five August periods, exactly as they sit in variance_reply_periods.
const rows = [
    { store: 'WSP', all_clear: true,  due: '2026-09-08T18:02:28Z', asked: 0,  answered: 0 },
    { store: 'BAL', all_clear: false, due: '2026-09-08T18:06:50Z', asked: 10, answered: 0 },
    { store: 'MPL', all_clear: false, due: '2026-09-08T18:17:22Z', asked: 8,  answered: 0 },
    { store: 'LEE', all_clear: false, due: '2026-09-08T18:23:25Z', asked: 8,  answered: 8 },
    { store: 'OVL', all_clear: true,  due: '2026-09-08T18:43:01Z', asked: 0,  answered: 0 },
];

const state = (r, nowMs) => {
    if (r.all_clear) return 'clear';
    if (r.answered >= r.asked) return 'done';
    if (_vrDayPast(nowMs, T(r.due))) return 'over';
    return _vrCtDay(nowMs) === _vrCtDay(T(r.due)) ? 'today' : 'open';
};

let fails = 0;
const eq = (label, got, want) => {
    const ok = got === want;
    if (!ok) fails++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}\n       got ${got}\n       want ${want}`);
};

console.log('all five now share ONE deadline day');
const days = [...new Set(rows.map(r => _vrCtDay(T(r.due))))];
eq('the 40-minute upload spread collapses to one day', days.join(','), '2026-09-08');

console.log('\nthe moment Ethan screenshotted it (Sep 8, 18:09:54 UTC)');
const shot = T('2026-09-08T18:09:54Z');
for (const r of rows) eq(`${r.store}`, state(r, shot), { WSP:'clear', BAL:'today', MPL:'today', LEE:'done', OVL:'clear' }[r.store]);
eq('BAL and MPL finally agree', state(rows[1], shot) === state(rows[2], shot), true);

console.log('\nlate on the 7th day, Central (Sep 8, 11:50pm CT) — still on time');
for (const r of rows.filter(r => r.store === 'BAL' || r.store === 'MPL'))
    eq(`${r.store}`, state(r, T('2026-09-09T04:50:00Z')), 'today');

console.log('\njust past midnight Central (Sep 9, 12:10am CT) — now overdue');
for (const r of rows.filter(r => r.store === 'BAL' || r.store === 'MPL'))
    eq(`${r.store}`, state(r, T('2026-09-09T05:10:00Z')), 'over');

console.log('\na cleared period is never past due, however long it sits');
eq('WSP a year later', state(rows[0], T('2027-09-08T18:00:00Z')), 'clear');

console.log('\nthe due DAY is the store\'s, not UTC\'s');
// 8pm Central on Sep 8 is already Sep 9 in UTC. Reading the date off the UTC
// timestamp would call this a Sep 9 deadline and give the store a free day.
eq('a 2026-09-09T01:00Z deadline is the Sep 8 store day', _vrCtDay(T('2026-09-09T01:00:00Z')), '2026-09-08');
eq('...and is overdue on Sep 9 CT', _vrDayPast(T('2026-09-09T18:00:00Z'), T('2026-09-09T01:00:00Z')), true);
eq('...but not late on Sep 8 CT evening', _vrDayPast(T('2026-09-09T02:00:00Z'), T('2026-09-09T01:00:00Z')), false);

console.log('\nDST: the fall-back weekend does not shift the deadline');
// Nov 1 2026 is the CDT->CST switch. A Oct 31 deadline must still be one day.
eq('Oct 31 deadline, still on time Oct 31 evening', _vrDayPast(T('2026-11-01T02:00:00Z'), T('2026-10-31T20:00:00Z')), false);
eq('Oct 31 deadline, overdue by Nov 1 midday', _vrDayPast(T('2026-11-01T18:00:00Z'), T('2026-10-31T20:00:00Z')), true);

console.log('\nthe 2-day DM-note reply window counts the same way');
const noted = T('2026-09-10T15:00:00Z');   // DM notes land Sep 10
eq('Sep 12 (day 2) is still on time', _vrDayPast(T('2026-09-12T23:00:00Z'), noted, 2), false);
eq('Sep 13 is past it',              _vrDayPast(T('2026-09-13T15:00:00Z'), noted, 2), true);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
