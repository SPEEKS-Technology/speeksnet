// LISTING GOALS — PAST WEEKS. Needs the real modal markup:
//
//   powershell -File scripts/browser-check.ps1 listing-goals-past-weeks-check.js -Html index.html
//
// What it guards, from the approved mockup (Ethan, 2026-09-16) and the data
// traps found while building it:
//   - Today stays the default, and opening the modal always lands there
//   - every week label is "Mon D – Mon D", so the labels line up
//   - the "Last week" tag shows on the newest week only, and keeps its space
//   - the arrows stop at the four-week window
//   - every percent bubble is one width, and they share a right edge
//   - a floater's day at another store shows that store and still counts
//   - two people with the same first name stay two people (Ethan K / Ethan F)
//   - no KPI filed reads as a dash, not 0%
//
// No network: _lgpw.data is seeded directly. Dates are built from today, the
// same way the code builds them, so the check does not rot as weeks pass.

function _pwMonday(weeksBack) {
    var d = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7 * weeksBack);
    return d.toISOString().split('T')[0];
}
function _pwDay(ds, n) {
    var d = new Date(ds + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().split('T')[0];
}

var W1 = _pwMonday(1), W1_END = _pwDay(W1, 6);
function _pwRows(store, employee, roles, goal) {
    return roles.map(function (r, i) {
        return { date: _pwDay(W1, i), store: store, employee: employee, role: r, goal: r === 'OFF' ? 0 : goal };
    });
}

var OVL = {
    store: 'OVL', market: ['OVL', 'LEE', 'WSP'], weeks: [],
    goals: []
        // A lister: 5 working days at 19, one off → goal 95, listed 88 → 93%
        .concat(_pwRows('OVL', 'Maya Torres', ['L1', 'L2', 'L1', 'L3', 'L1', 'OFF'], 19))
        // Same first name as the next person, different store, same market.
        .concat(_pwRows('OVL', 'Ethan Kushnir', ['B1', 'B1', 'OFF', 'B2', 'B1', 'B1'], 3))
        .concat(_pwRows('LEE', 'Ethan Frye', ['L1', 'L1', 'L1', 'L1', 'L1', 'L1'], 19))
        // A floater: 3 days here, marked OFF here but L1 at LEE on day 4.
        .concat(_pwRows('OVL', 'Zach Marchesano', ['L2', 'L2', 'L2', 'OFF', 'OFF', 'OFF'], 19))
        .concat([{ date: _pwDay(W1, 3), store: 'LEE', employee: 'Zach Marchesano', role: 'L1', goal: 19 }])
        // Roles set, but no KPI filed.
        .concat(_pwRows('OVL', 'Riley Chen', ['B2', 'OFF', 'B2', 'B2', 'OFF', 'B2'], 6))
        // A LEE floater OVL never used: OVL still saved Off / blank rows for him,
        // which is what real data looks like. He must not get a row here.
        .concat(_pwRows('OVL', 'Pat Loaner', ['OFF', '-', 'OFF', 'OFF', 'OFF', 'OFF'], 0)),
    listed: [
        { weekEnd: W1_END, store: 'OVL', employee: 'Maya Torres', listed: 88 },
        { weekEnd: W1_END, store: 'OVL', employee: 'Ethan Kushnir', listed: 20 },
        { weekEnd: W1_END, store: 'LEE', employee: 'Ethan Frye', listed: 200 },
        { weekEnd: W1_END, store: 'OVL', employee: 'Zach Marchesano', listed: 80 },
        // Listings filed, but never given a seat: no row, and not in the summary.
        { weekEnd: W1_END, store: 'OVL', employee: 'Sam Noseat', listed: 30 },
    ],
};

function _pwSetup() {
    window.isMultiStoreManager = function () { return false; };
    goalsTargetStore = 'OVL';
    _goalsFloaters.OVL = [{ name: 'Zach Marchesano', claimedBy: null, available: true, mine: false, homeStore: 'OVL' }];
    _lgpw.data = { OVL: { at: Date.now(), payload: OVL } };
    _lgpw.failed = {};
    // Visible, so the layout checks measure real boxes.
    var m = document.getElementById('listingGoalsModal');
    m.style.display = 'block'; m.style.position = 'static'; m.style.width = '1100px';
    m.style.transform = 'none'; m.style.opacity = '1'; m.style.visibility = 'visible';
}
function _pwRow(name) {
    var rows = document.querySelectorAll('#goals-pane-past .lgpw-row:not(.lgpw-hdr)');
    for (var i = 0; i < rows.length; i++) {
        var n = rows[i].querySelector('.lgpw-name');
        if (n && n.firstChild && n.firstChild.textContent.trim() === name) return rows[i];
    }
    return null;
}
function _pwChips(row) {
    return [].map.call(row.querySelectorAll('.lgpw-chip'), function (c) { return c.textContent.trim(); }).join(' ');
}

t('markup: the Today pane still holds the editor, and the total row is still its sibling', function () {
    var today = document.getElementById('goals-pane-today');
    if (!today) return 'no #goals-pane-today';
    if (!today.contains(document.getElementById('goals-manager-body'))) return 'the roster left the Today pane';
    // _setMSGoalsChrome finds the total row with this exact sibling selector.
    return !!document.querySelector('#goals-manager-body ~ .goals-total-row')
        || '#goals-manager-body ~ .goals-total-row no longer matches — the MSM chrome toggle would break';
});

t('markup: Today is the default view, week arrows hidden', function () {
    if (document.getElementById('goals-pane-today').hidden) return 'Today pane starts hidden';
    if (!document.getElementById('goals-pane-past').hidden) return 'Past pane starts visible';
    return document.getElementById('lgpw-wk').classList.contains('away') || 'week arrows visible on Today';
});

t('switching to Past weeks shows the grid and the arrows', function () {
    _pwSetup();
    lgpwSetView(true);
    if (document.getElementById('goals-pane-today').hidden !== true) return 'Today pane still showing';
    if (getComputedStyle(document.getElementById('goals-pane-today')).display !== 'none') return 'Today pane hidden attr beaten by CSS';
    if (document.getElementById('lgpw-wk').classList.contains('away')) return 'arrows still hidden';
    return !!_pwRow('Maya Torres') || 'no rows rendered';
});

t('a lister row: seats, daily goals, listed / goal, percent', function () {
    var r = _pwRow('Maya Torres');
    if (_pwChips(r) !== 'L1 L2 L1 L3 L1 Off') return 'chips: ' + _pwChips(r);
    var n = r.querySelector('.lgpw-tot-n').textContent.replace(/\s+/g, ' ').trim();
    if (n !== '88 / 95') return 'total: ' + n;
    var p = r.querySelector('.lgpw-pct');
    return (p.textContent === '93%' && p.classList.contains('warn')) || 'pct: ' + p.textContent + ' ' + p.className;
});

t('a floater: the day at another store shows that store and still counts', function () {
    var r = _pwRow('Zach Marchesano');
    if (!r) return 'floater not on the grid';
    if (_pwChips(r) !== 'L2 L2 L2 LEE Off Off') return 'chips: ' + _pwChips(r);
    if (!r.querySelector('.lgpw-float')) return 'no Floater tag';
    var n = r.querySelector('.lgpw-tot-n').textContent.replace(/\s+/g, ' ').trim();
    return n === '80 / 76' || 'total should count the LEE day (19×4): ' + n;
});

t('two people with the same first name stay separate', function () {
    var k = _pwRow('Ethan Kushnir');
    if (!k) return 'Ethan Kushnir missing';
    if (_pwRow('Ethan Frye')) return 'Ethan Frye (LEE only) leaked onto the OVL grid';
    var n = k.querySelector('.lgpw-tot-n').textContent.replace(/\s+/g, ' ').trim();
    return n === '20 / 15' || 'Ethan Kushnir merged with Ethan Frye: ' + n;
});

t('a floater another store only marked Off does not get a row', function () {
    return !_pwRow('Pat Loaner') || 'a line of Offs for someone who never worked here';
});

t('someone with listings but no seat that week is left off', function () {
    return !_pwRow('Sam Noseat') || 'a "30 / 0" row for someone with no roles set';
});

t("the goal banner is Today's, and hides on Past weeks", function () {
    var h = document.querySelector('#listingGoalsModal .district-kpi-header');
    if (!h) return 'no banner in the markup';
    if (getComputedStyle(h).display !== 'none') return 'banner still showing on Past weeks';
    lgpwSetView(false);
    var back = getComputedStyle(h).display !== 'none';
    _lgpw.data = { OVL: { at: Date.now(), payload: OVL } };
    lgpwSetView(true);
    return back || 'banner did not come back on Today';
});

t('no KPI filed reads as a dash, not 0%', function () {
    var r = _pwRow('Riley Chen');
    var p = r.querySelector('.lgpw-pct');
    if (p.textContent !== '—' || !p.classList.contains('none')) return 'pct: ' + p.textContent;
    return /^—/.test(r.querySelector('.lgpw-tot-n').textContent.trim()) || 'listed should be a dash';
});

t('store summary is this store only', function () {
    var v = document.querySelector('#goals-pane-past .lgpw-sum-v').textContent.replace(/\s+/g, ' ').trim();
    // OVL goals: Maya 95 + Ethan K 15 + Zach 57 + Riley 24 = 191. Listed: 88+20+80 = 188
    // — Sam Noseat's 30 is NOT in it, because he is not on the grid.
    return v === '188 / 191' || 'summary: ' + v;
});

t('every percent bubble in the rows is one width and shares a right edge', function () {
    var ps = document.querySelectorAll('#goals-pane-past .lgpw-tot .lgpw-pct');
    if (ps.length < 4) return 'only ' + ps.length + ' bubbles';
    var w = ps[0].getBoundingClientRect().width, right = ps[0].getBoundingClientRect().right;
    if (w < 30) return 'bubbles not laid out (width ' + w + ')';
    for (var i = 1; i < ps.length; i++) {
        var b = ps[i].getBoundingClientRect();
        if (Math.abs(b.width - w) > 0.5) return 'widths differ: ' + w + ' vs ' + b.width + ' (' + ps[i].textContent + ')';
        if (Math.abs(b.right - right) > 0.5) return 'right edges differ: ' + right + ' vs ' + b.right;
    }
    return true;
});

t('week labels: same "Mon D – Mon D" shape, tag on newest only, arrows stay put', function () {
    var prevX = null, out = [];
    for (var w = 0; w < 4; w++) {
        _lgpw.week = w; lgpwRender();
        var txt = document.getElementById('lgpw-wk-text').textContent;
        if (!/^[A-Z][a-z]{2} \d{1,2} – [A-Z][a-z]{2} \d{1,2}$/.test(txt)) return 'week ' + w + ' label: ' + txt;
        var tagAway = document.getElementById('lgpw-tag').classList.contains('away');
        if ((w === 0) === tagAway) return 'Last week tag wrong on week ' + w;
        if (getComputedStyle(document.getElementById('lgpw-tag')).display === 'none') return 'tag lost its space on week ' + w;
        var x = document.getElementById('lgpw-next').getBoundingClientRect().left;
        if (prevX !== null && Math.abs(x - prevX) > 0.5) return 'next arrow moved on week ' + w + ': ' + prevX + ' → ' + x;
        prevX = x;
        out.push(txt);
    }
    return out[0] !== out[1] || 'weeks did not change';
});

t('arrows stop at the four-week window', function () {
    _lgpw.week = 0; lgpwRender();
    if (!document.getElementById('lgpw-next').disabled) return 'next enabled on last week';
    lgpwStep(-1);
    if (_lgpw.week !== 0) return 'stepped past last week';
    for (var i = 0; i < 6; i++) lgpwStep(1);
    if (_lgpw.week !== 3) return 'week ' + _lgpw.week + ' after stepping back 6';
    return document.getElementById('lgpw-prev').disabled || 'prev enabled on the oldest week';
});

t('a week with no roles says so', function () {
    _lgpw.week = 2; lgpwRender();
    var m = document.querySelector('#goals-pane-past .lgpw-msg');
    return (m && /No roles were set/.test(m.textContent)) || 'no empty-week message';
});

t('opening the modal always lands on Today', function () {
    lgpwSetView(true);
    var realToggle = window.toggleModal, realCan = window._canAssignGoalRoles;
    window.toggleModal = function () {};
    window._canAssignGoalRoles = function () { return true; };
    try { openListingGoals(); } finally { window.toggleModal = realToggle; window._canAssignGoalRoles = realCan; }
    return (!document.getElementById('goals-pane-today').hidden && document.getElementById('goals-pane-past').hidden)
        || 'opened on Past weeks';
});

t('a failed fetch shows a message, not a spinner forever', function () {
    _lgpw.data = {}; _lgpw.failed = { OVL: true };
    _lgpw.past = true; lgpwRender();
    var m = document.querySelector('#goals-pane-past .lgpw-msg');
    var ok = (m && m.classList.contains('err')) || 'no error message';
    // Leave last week on screen, so a -Keep run opens on something to look at.
    _pwSetup(); lgpwSetView(true);
    return ok;
});
