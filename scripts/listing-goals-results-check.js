// LISTING GOALS — results off the Day End Report, temps, and Store Efficiency
// this week. 2026-09-24.
//
//   powershell -File scripts/browser-check.ps1 listing-goals-results-check.js
//
// listing_goals.result is written the morning after by day-end-ingest. These
// checks pin down what the manager's widget makes of it (last day + week to
// date per person, the store's pair above the roster), the 0-2 temps
// stepper's row, and the Store Efficiency board's in-progress week.

// A Mon-Sat week starting Mon 2026-09-21; "today" is Thu 09-24. Dates are in the
// form listing-goals GET returns them (en-US locale strings).
var TODAY = '9/24/2026';
var MON = new Date(2026, 8, 21); MON.setHours(0, 0, 0, 0);
var DATA = [
    { date: '9/21/2026', employee: 'Zach Marbs',    role: 'L1',  goal: 19, result: 15 },
    { date: '9/22/2026', employee: 'Zach Marbs',    role: 'L1',  goal: 19, result: 20 },
    { date: '9/23/2026', employee: 'Zach Marbs',    role: 'OFF', goal: 0,  result: 0 },
    { date: '9/24/2026', employee: 'Zach Marbs',    role: 'L1',  goal: 19, result: null },
    { date: '9/22/2026', employee: 'Bret Daubert',  role: 'B1',  goal: 3,  result: 1 },
    { date: '9/23/2026', employee: 'Bret Daubert',  role: 'B1',  goal: 3,  result: null },
    { date: '9/23/2026', employee: 'Temp',          role: 'TEMP', goal: 20, result: 18 },
    // Last week's Saturday: counts as a "last day" but never toward this week.
    { date: '9/19/2026', employee: 'Garrett Burnell', role: 'L1', goal: 9, result: 12 }
];
function dr() { return _goalsDayRows(DATA, TODAY, MON); }

// --- per person ---------------------------------------------------------------

t('each day this week before today gets its own chip', function () {
    // Zach: Mon 15/19, Tue 20/19, Wed Off — three day chips — and Thu (today)
    // none, because today has no report yet.
    var html = _goalsResultLine('Zach Marbs', dr());
    var days = (html.match(/class="gr-chip gr-(?!week)[a-z]+"/g) || []).length;
    if (days !== 3) return 'expected 3 day chips, got ' + days + ': ' + html;
    if (!/<span class="gr-d">Mon<\/span><b>15<\/b>\/19/.test(html)) return 'Mon chip wrong: ' + html;
    if (!/gr-off"><span class="gr-d">Wed<\/span>Off/.test(html)) return 'Wed Off chip missing: ' + html;
    return !/>Thu</.test(html) || 'today got a chip';
});

t('the week is its own chip, set apart by a divider', function () {
    // 15 + 20 + 0 = 35 of 19 + 19 + 0 = 38 → 92%, near.
    var html = _goalsResultLine('Zach Marbs', dr());
    if (!/gr-sep/.test(html)) return 'no divider before the week';
    return /gr-chip gr-week gr-near"><span class="gr-d">Week<\/span><b>35<\/b>\/38/.test(html) || 'got: ' + html;
});

t('a day the report has not reached shows a dash, not a 0', function () {
    // Bret's Wed row has result null — the ingest has not run for it yet.
    var html = _goalsResultLine('Bret Daubert', dr());
    if (/<span class="gr-d">Wed<\/span><b>0<\/b>/.test(html)) return 'a missing report read as 0 listed';
    return /gr-wait[^>]*><span class="gr-d">Wed<\/span><b>—<\/b>\/3/.test(html) || 'got: ' + html;
});

t('a person with no rows before today gets no line at all', function () {
    return _goalsResultLine('Nobody Here', dr()) === '' || 'expected an empty line';
});

t('names match exactly — two Zachs do not merge', function () {
    // _goalsSameName would call "Zach Marchesano" the same person as "Zach
    // Marbs" (first-name prefix). This line must not.
    return _goalsResultLine('Zach Marchesano', dr()) === '' || 'Zach Marchesano picked up Zach Marbs’ rows';
});

// Was "on a Monday, last Saturday shows alone". Ethan changed the rule on
// 2026-09-28 (a1ad0ea): THIS WEEK ONLY, so a Monday shows nothing — Saturday
// closes the previous week and says nothing about the one ahead.
t('on a Monday, nothing shows — not last Saturday, not a week chip', function () {
    // Garrett has no row this week; his last day is last Saturday.
    var html = _goalsResultLine('Garrett Burnell', dr());
    if (/gr-d">Sat</.test(html)) return 'last Saturday is still shown on a Monday: ' + html;
    return !/gr-week/.test(html) || 'last week leaked into this week: ' + html;
});

t('six days of chips plus the week fit a phone row without overflow', function () {
    var rows = [];
    ['9/21/2026', '9/22/2026', '9/23/2026', '9/24/2026', '9/25/2026', '9/26/2026'].forEach(function (d, i) {
        rows.push({ date: d, employee: 'Six Day', role: 'L1', goal: 19, result: [25, 12, 19, 3, 30, 18][i] });
    });
    // "Today" the Sunday, so all six days sit in this week before today.
    var six = _goalsDayRows(rows, '9/27/2026', MON);
    var host = document.createElement('div');
    host.style.cssText = 'width:230px;';   // the name column on a 390px phone
    host.innerHTML = _goalsResultLine('Six Day', six);
    document.body.appendChild(host);
    try {
        var chips = host.querySelectorAll('.gr-chip');
        if (chips.length !== 7) return 'expected 6 day chips + week, got ' + chips.length;
        var lim = host.getBoundingClientRect().right + 0.5, bad = [];
        chips.forEach(function (c) { if (c.getBoundingClientRect().right > lim) bad.push(c.textContent); });
        return bad.length === 0 || 'chips past the edge: ' + bad.join(', ');
    } finally { host.remove(); }
});

// --- the store's pair -----------------------------------------------------------

t('the store line sums everyone on the last day, temp included', function () {
    // Wed: Zach Off (0 goal), Bret 3 goal / no result yet, Temp 20 / 18.
    // Listed 18 of 23 — Bret's unknown result does not count as a 0 listed
    // because only KNOWN results are summed, but his goal stands.
    var html = _goalsStoreResultHtml(dr());
    return /Wed listed<\/span><b class="gr-near">18<\/b><small>\/ 23 · 78%<\/small>/.test(html) || 'got: ' + html;
});

t('the store week to date adds up the whole week', function () {
    // Mon 15/19, Tue 21/22, Wed 18/23 = 54 / 64.
    var html = _goalsStoreResultHtml(dr());
    return /Week to date<\/span><b class="gr-near">54<\/b><small>\/ 64 · 84%<\/small>/.test(html) || 'got: ' + html;
});

// --- temps -----------------------------------------------------------------------

t('a temp row is recognised by its role, not its name', function () {
    if (!_goalsIsTempRow({ employee: 'Temp', role: 'TEMP' })) return 'TEMP role not recognised';
    return !_goalsIsTempRow({ employee: 'Temp', role: 'L1' }) || 'a person called Temp was taken for the temp';
});

function withTempRow(count, prior, fn) {
    var host = document.createElement('div');
    host.innerHTML = _goalsTempRowHtml('-ZZ', count, prior, null);
    document.body.appendChild(host);
    // stepGoalsTemp recomputes and autosaves the live widget; neither exists
    // in the harness in a useful form, so they are stubbed for the call.
    var rc = window.recomputeGoalDisplays, sa = window.scheduleGoalsAutosave;
    window.recomputeGoalDisplays = function () {};
    window.scheduleGoalsAutosave = function () {};
    try { return fn(); }
    finally { window.recomputeGoalDisplays = rc; window.scheduleGoalsAutosave = sa; host.remove(); }
}

t('zero temps saves no temp row', function () {
    return withTempRow(0, 0, function () {
        return _goalsTempPayload('-ZZ') === null || 'saved a temp row at zero';
    });
});

t('the stepper goes 0 → 1 → 2 and stops at 2', function () {
    return withTempRow(0, 0, function () {
        stepGoalsTemp('-ZZ', 1);
        if (_goalsTempCount('-ZZ') !== 1) return 'one + did not make 1';
        stepGoalsTemp('-ZZ', 1);
        stepGoalsTemp('-ZZ', 1);
        if (_goalsTempCount('-ZZ') !== 2) return 'went past 2: ' + _goalsTempCount('-ZZ');
        stepGoalsTemp('-ZZ', -1); stepGoalsTemp('-ZZ', -1); stepGoalsTemp('-ZZ', -1);
        return _goalsTempCount('-ZZ') === 0 || 'went below 0: ' + _goalsTempCount('-ZZ');
    });
});

t('two temps save ONE row worth 40', function () {
    return withTempRow(2, 0, function () {
        var p = _goalsTempPayload('-ZZ');
        if (!p) return 'no temp row at 2';
        return (p.employee === 'Temp' && p.role === 'TEMP' && p.goal === '40') || 'payload: ' + JSON.stringify(p);
    });
});

t('a saved Temp row reads back as its count', function () {
    if (_goalsTempCountOf({ role: 'TEMP', goal: 20 }) !== 1) return '20 did not read as 1';
    if (_goalsTempCountOf({ role: 'TEMP', goal: 40 }) !== 2) return '40 did not read as 2';
    if (_goalsTempCountOf({ role: 'TEMP', goal: 140 }) !== 2) return 'a hand-edited 140 was not clamped to 2';
    return _goalsTempCountOf({ role: 'L1', goal: 20 }) === 0 || 'a non-temp row counted as temps';
});

t('the temps add 20 each to today and to the week', function () {
    return withTempRow(2, 40, function () {
        var tp = _goalsPaintTemp('-ZZ');
        if (tp.today !== 40) return 'today added ' + tp.today;
        if (tp.week !== 80) return 'week added ' + tp.week + ', expected 40 earlier + 40 today';
        return document.getElementById('goal-display-temp-ZZ').innerText === '40' || 'display did not show 40';
    });
});

t('the temp stepper is not a role dot', function () {
    // updateRoleLocks and the staffed count read .role-dot / .goals-edit-roles.
    // A temp must not take a seat or count as staff.
    var html = _goalsTempRowHtml('', 1, 0, null);
    if (/role-dot/.test(html)) return 'the temp row carries a role dot';
    return !/goals-edit-roles/.test(html) || 'the temp row sits in a roles group';
});

// --- Store Efficiency, this week ---------------------------------------------------

t('Store Efficiency offers This Week, measured through yesterday', function () {
    var wk = _dmxWeeksBack(0);
    _dmxCap[wk] = [{
        store: 'OVL', people: [1, 2, 3, 4], hours: 160, capacity: 400, planned: 300,
        adjusted: 120, adjustedToDate: 90, through: '2026-09-23',
        actual: 81, efficiency: 0.9, assignedDays: 16, estimated: false
    }];
    _dmxCapWeek = wk;
    var html = _dmxEfficiencyPane();
    if (!/This Week/.test(html)) return 'no This Week button';
    if (!/through Wed/.test(html)) return 'the range does not say which day it runs through';
    // Staffed For must be the goals of the days Listed covers (90), not the
    // whole week so far including today (120).
    if (!/<td class="dmx-num">90<\/td>/.test(html)) return 'Staffed For is not adjustedToDate';
    return /90%/.test(html) || 'efficiency not 90%';
});

t('a week with no finished days reads as not in yet, never a red 0%', function () {
    var wk = _dmxWeeksBack(0);
    _dmxCap[wk] = [{
        store: 'OVL', people: [1], hours: 40, capacity: 100, planned: 75,
        adjusted: 19, adjustedToDate: 0, through: '2026-09-20',
        actual: 0, efficiency: null, assignedDays: 1, estimated: false
    }];
    _dmxCapWeek = wk;
    var html = _dmxEfficiencyPane();
    if (/Below target/.test(html)) return 'painted a verdict on a week with no days in';
    return /No days in yet/.test(html) || 'got: ' + html.slice(0, 200);
});

t('mid-week, the roles tag is judged on the days so far, not all six', function () {
    // Through Wed = 3 open days. 4 people × 3 = 12 slots; 11 set is fine and
    // must NOT be tagged — the bug was 22/36 on a store that had set every seat.
    var wk = _dmxWeeksBack(0);
    var mon = new Date(wk + 'T12:00:00'), wed = new Date(mon); wed.setDate(mon.getDate() + 2);
    var through = wed.toLocaleDateString('en-CA');
    _dmxCap[wk] = [{
        store: 'OVL', people: [1, 2, 3, 4], hours: 160, capacity: 400, planned: 300,
        adjusted: 120, adjustedToDate: 90, through: through,
        actual: 81, efficiency: 0.9, assignedDays: 15, assignedDaysToDate: 11, estimated: false
    }];
    _dmxCapWeek = wk;
    var html = _dmxEfficiencyPane();
    if (/\/24 roles|\/36 roles/.test(html)) return 'still judged against the whole week: ' + (html.match(/\d+\/\d+ roles/) || [''])[0];
    if (/\d+\/12 roles/.test(html)) return 'tagged a store that set 11 of 12 seats';
    // And a store that genuinely left seats empty is still caught: 5 of 12.
    _dmxCap[wk][0].assignedDaysToDate = 5;
    html = _dmxEfficiencyPane();
    return /5\/12 roles/.test(html) || 'a thin week so far was not tagged: ' + (html.match(/dmx-role[^>]*>[^<]*/) || [''])[0];
});

// --- the Total line's actual ---------------------------------------------------------

t('the Total line carries the actual listed so far this week', function () {
    // Same sum as the store's Week to date: 54 listed of 64 → 84%, near.
    var html = _goalsTotalListedHtml(dr());
    return /^Listed so far <b class="gr-near">54<\/b> of 64 · 84%$/.test(html) || 'got: ' + html;
});

t('on a Monday the Total line says nothing rather than 0 of 0', function () {
    // No day of the week is done yet — today is the Monday itself.
    var monday = _goalsDayRows(DATA, '9/21/2026', MON);
    return _goalsTotalListedHtml(monday) === '' || 'got: ' + _goalsTotalListedHtml(monday);
});
