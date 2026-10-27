// QUICKPORTAL CUSTOMIZE checks — Undo, the live preview, the "New" mark.
//
//   powershell -File scripts/browser-check.ps1 qp-customize-check.js
//
// Ethan, 2026-10-25 (after the drag-and-drop review): Undo, a preview of the
// page after a drop, one action per card middle, layouts saved to the person,
// and a New mark in the drawer. The saving itself is the qp-layout edge
// function (0158) — smoke-tested against the live function, not here: the
// harness blocks the network.

_b2bSend = function () { return Promise.resolve({}); };

function page(rows) {
    var old = document.getElementById('qp-host');
    if (old) old.remove();
    var main = document.createElement('main');
    main.id = 'qp-host';
    main.innerHTML = rows.map(function (r) {
        return '<div class="qp-row">' + r.map(function (k) {
            return '<div class="qp-cell"><section data-qp-block="' + k + '"></section></div>';
        }).join('') + '</div>';
    }).join('');
    document.body.appendChild(main);
    return main;
}
function sig(main, rows) {
    return rows.map(function (r) { return r.items.filter(function (k) { return _qpKeyShown(main, k); }).join('+'); }).filter(Boolean).join(' / ');
}
var MANAGER = [['feed', 'actions', 'command'], ['chart', 'leaderboard']];

t('a dry run gives the layout the drop would, and changes nothing', function () {
    var main = page(MANAGER);
    var before = main.innerHTML;
    _qpDrag = { key: 'kpis', add: 'kpis' };
    var t0 = { zone: 'left', key: 'leaderboard', row: 1, beforeKey: 'leaderboard', full: true };
    var plan = _qpBumpPlan(main, { key: 'kpis', add: 'kpis' }, t0);
    t0.bump = plan; t0.full = false;
    var dry = _qpDropAt(main, { key: 'kpis' }, t0, true);
    _qpDrag = null;
    if (main.innerHTML !== before) return 'the page changed';
    if (!dry) return 'no rows';
    return sig(main, dry) === sig(main, _qpPairWidgets(main, plan.rows)) ? true : sig(main, dry) + ' vs plan ' + sig(main, plan.rows);
});

t('a refused drop dry-runs to nothing', function () {
    var main = page(MANAGER);
    var dry = _qpDropAt(main, { key: 'command' }, { zone: 'left', key: 'command', row: 0, beforeKey: 'command' }, true);
    return dry === null ? true : 'got ' + sig(main, dry);
});

t('Undo keeps the last 30 steps', function () {
    _qpUndo = [];
    for (var i = 0; i < 35; i++) _qpUndoPush([{ items: ['feed', 'k' + i], w: null }]);
    var n = _qpUndo.length, last = _qpUndo[_qpUndo.length - 1][0].items[1], first = _qpUndo[0][0].items[1];
    _qpUndo = [];
    return n === 30 && last === 'k34' && first === 'k5' ? true : n + ' steps, ' + first + '…' + last;
});

t('a step is a copy: later changes to the rows do not rewrite it', function () {
    _qpUndo = [];
    var rows = [{ items: ['feed', 'actions'], w: [2, 1] }];
    _qpUndoPush(rows);
    rows[0].items.push('command'); rows[0].w[0] = 9;
    var s = _qpUndo[0][0];
    _qpUndo = [];
    return s.items.join() === 'feed,actions' && s.w[0] === 2 ? true : JSON.stringify(s);
});

t('New: recent and unseen only', function () {
    var w = QP_WIDGETS.docs, was = w.added;
    var day = function (n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); };
    w.added = day(3);
    var a = _qpIsNew('docs', []), b = _qpIsNew('docs', ['docs']);
    w.added = day(45);
    var c = _qpIsNew('docs', []);
    w.added = was;
    return a && !b && !c ? true : 'recent ' + a + ', seen ' + b + ', old ' + c;
});

t('every widget has a date it joined the drawer', function () {
    var missing = Object.keys(QP_WIDGETS).filter(function (id) { return !/^\d{4}-\d\d-\d\d$/.test(QP_WIDGETS[id].added || ''); });
    return missing.length ? 'no date: ' + missing.join(', ') : true;
});

// The preview names a card by what it will hold after the drop (Ethan,
// 2026-10-25: dragging To Do out of "To Do + News" showed To Do twice). A
// widget still in the drawer is not built, so it goes by its own name.
t('preview names: a drawer widget goes by its name, a plain card by its label', function () {
    var main = page([['chart', 'leaderboard']]);
    main.querySelector('[data-qp-block="chart"]').setAttribute('data-qp-label', 'Performance Chart');
    var rows = [{ items: ['chart', 'b2b'], w: null }];
    var a = _qpPreviewName(main, 'b2b', rows), b = _qpPreviewName(main, 'chart', rows);
    return a === 'Business-to-Business' && b === 'Performance Chart' ? true : a + ' / ' + b;
});

// WEEKLY KPIs headline (Ethan, 2026-10-25: option A) and the roles from manager
// down getting Customize — and with it the headline cards — with no switch.
var KPI_H = { period: 'Week ending Oct 25, 2026', metrics: [
    { t: 'Buying Value', rule: null, my: '$10,679', st: '$28,395', has: true, bad: false },
    { t: 'Margin', rule: 'margin', my: '54.9%', st: '53.9%', has: true, bad: false },
    { t: 'Conversion', rule: 'conversion', my: '82.9%', st: '83.0%', has: true, bad: true },
    { t: 'Variance', rule: 'variance', my: '-', st: '-', has: false, bad: false },
    { t: 'No Deals', rule: 'nodeals', my: '20', st: '34', has: true, bad: true },
    { t: 'Trans. Time', rule: 'time', my: '11.9', st: '5.7', has: true, bad: false },
    { t: 'Listed Dev.', rule: null, my: '28', st: '219', has: true, bad: false },
] };
function kpiText(h) { var d = document.createElement('div'); d.innerHTML = _QP_HL_BUILD.kpis(h).replace(/></g, '> <'); return d.textContent.replace(/\s+/g, ' ').trim(); }

t('Weekly KPIs: on-target count leaves out what has no goal or no figure', function () {
    var s = kpiText(KPI_H);
    return /^Week Ending Oct 25, 2026 2 ?of 4 on target 2 to work on this week/.test(s) ? true : s;
});

t('Weekly KPIs: each miss with its goal and the store, on target on one line', function () {
    var s = kpiText(KPI_H);
    if (!/Conversion 82\.9% Goal 85% Store 83\.0%/.test(s)) return 'conversion: ' + s;
    if (!/No Deals 20 Max 7 Store 34/.test(s)) return 'no deals: ' + s;
    return /On Target Margin · Transaction Time ✓$/.test(s) ? true : 'on target: ' + s;
});

t('Weekly KPIs: in a card with tabs, no store figures and no caption for on target', function () {
    var s = kpiText(Object.assign({}, KPI_H, { compact: true }));
    if (/Store/.test(s)) return 'store shown: ' + s;
    return /On Target Margin · Transaction Time$/.test(s) ? true : s;
});

t('Weekly KPIs: all on target, and no KPIs yet, say so', function () {
    var all = kpiText({ period: 'Week ending Oct 25, 2026', metrics: KPI_H.metrics.map(function (m) { return Object.assign({}, m, { bad: false }); }) });
    var none = kpiText({ period: 'Week ending Oct 25, 2026', none: true });
    if (!/Every KPI on target/.test(all)) return all;
    return /no KPIs for you yet/.test(none) ? true : none;
});

t('Weekly KPIs is a Command Center tab QuickPortal knows', function () {
    var p = QP_FAMILIES.command.pieces.find(function (x) { return x.key === 'kpis'; });
    return p && p.ids.indexOf('cc-tab-kpis') !== -1 ? true : 'missing';
});

t('a layout that breaks a size rule is re-fitted, never built', function () {
    var main = page([]);
    var out = _qpSettle(main, [{ items: ['command', 'feed', 'actions'], w: null }, { items: ['chart', 'leaderboard', 'kpis'], w: null }]);
    var bad = out.filter(function (r) { return _qpRowWhyNot(main, r.items, r.w); });
    return bad.length ? 'still breaks: ' + sig(main, bad) : true;
});

// SCROLL BARS FIT THE CARD (Ethan, 2026-10-26: Your Feed's bottom arrow was cut
// off by the card's rounded corner). Measured with the real styles.css: the
// feed list, and a feed tab split out into its own card, stop clear of the
// 18px corner instead of running into it.
t('a scrolling feed list stops above the card\'s rounded corner', function () {
    var host = document.createElement('div');
    host.style.cssText = 'width:420px;height:350px;display:flex;';
    host.innerHTML = '<div class="qp-row" style="width:100%"><div class="qp-cell" style="width:100%;height:350px">'
        + '<section class="speeks-action-menu qp-part" data-qp-block="feed:news" style="height:350px"><div class="sam-board" style="height:100%">'
        + '<div class="sam-card" style="height:100%;display:flex;flex-direction:column"><div class="sam-feed" style="flex:1 1 auto;min-height:0;overflow:auto">'
        + new Array(40).join('<div style="height:30px">line</div>') + '</div></div></div></section></div></div>';
    document.body.appendChild(host);
    var card = host.querySelector('.sam-card'), list = host.querySelector('.sam-feed');
    var rad = parseFloat(getComputedStyle(card).borderBottomRightRadius) || 0;
    var gap = card.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom;
    host.remove();
    if (!rad) return 'card has no radius in this harness (styles.css not applied?)';
    return gap >= rad * 0.6 ? true : 'list ends ' + Math.round(gap) + 'px above a ' + rad + 'px corner';
});

// Goal and store as two tags of their own (Ethan, 2026-10-26: "cramped").
t('Weekly KPIs: a miss shows its goal and the store as separate tags', function () {
    var d = document.createElement('div');
    d.innerHTML = _QP_HL_BUILD.kpis(KPI_H);
    var tags = Array.from(d.querySelectorAll('.qp-kpi-tag')).map(function (x) { return x.textContent; });
    return tags.join(' | ') === 'Goal 85% | Store 83.0% | Max 7 | Store 34' ? true : tags.join(' | ');
});

// An assistant manager's / employee's own Listing Goals card (2026-10-26).
t('My Listing Goals: today\'s goal and role, the week as a seven-day strip', function () {
    var was = [window._empWeek, window._empGoalToday, window._empRoleToday];
    window._empWeek = { goal: 30, done: 18, roleDesc: '', days: { Mon: { goal: 6, result: 8 }, Tue: { goal: 6, result: 4 }, Wed: { goal: 6, result: 6 } } };
    window._empGoalToday = 6; window._empRoleToday = 'Lister 1';
    var b = _qpAiMyListing(4), d = document.createElement('div');
    d.innerHTML = b.body.replace(/></g, '> <');
    var s = d.textContent.replace(/\s+/g, ' ').trim();
    window._empWeek = was[0]; window._empGoalToday = was[1]; window._empRoleToday = was[2];
    if (b.count !== '6') return 'count ' + b.count;
    if (!/^6 ?to list today Lister 1 This Week · 18 of 30 listed · 12 to go 8 Mon 4 Tue 6 Wed – Thu – Fri – Sat – Sun Open My Listing Goals/.test(s)) return s;
    // Seven days; Tue missed its goal (4 of 6) so it is amber, Mon and Wed green.
    d.innerHTML = b.body;
    var cols = Array.from(d.querySelectorAll('.qp-ai-col')).map(function (c) { return c.classList.contains('warn') ? 'w' : 'g'; }).join('');
    return d.querySelectorAll('.qp-ai-day').length === 7 && cols.slice(0, 3) === 'gwg' ? true : 'columns ' + cols;
});

// A multi-store manager's layout is kept per store (2026-10-26).
t('a multi-store manager saves a layout per store; everyone else one', function () {
    var keep = {}; ['speeksUserName', 'speeksUserStore', 'speeksMultiStore'].forEach(function (k) { keep[k] = sessionStorage.getItem(k); });
    sessionStorage.setItem('speeksUserName', 'Pat Example'); sessionStorage.setItem('speeksUserStore', 'MPL');
    sessionStorage.removeItem('speeksMultiStore');
    var one = _qpStoreKey();
    sessionStorage.setItem('speeksMultiStore', 'true');
    var mpl = _qpStoreKey();
    sessionStorage.setItem('speeksUserStore', 'BAL');
    var bal = _qpStoreKey();
    Object.keys(keep).forEach(function (k) { if (keep[k] === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, keep[k]); });
    return one === QP_LAYOUT_KEY + 'pat example' && mpl === QP_LAYOUT_KEY + 'pat example@mpl' && bal === QP_LAYOUT_KEY + 'pat example@bal'
        ? true : [one, mpl, bal].join(' / ');
});

// 2026-10-26 (Ethan, from a multi-store manager's real login):
// 1. A save is pinned to the store it was made on — switching BAL → MPL inside
//    the half-second debounce used to save BAL's layout as MPL's.
t('a waiting save goes out as the store it was made on', function () {
    var keep = {}; ['speeksUserName', 'speeksUserStore', 'speeksMultiStore', 'speeksTestSession'].forEach(function (k) { keep[k] = sessionStorage.getItem(k); });
    var sent = [], realFetch = window.fetch;
    window.fetch = function (url, init) { if (String(url).indexOf('qp-layout') !== -1) sent.push(JSON.parse(init.body)); return Promise.resolve({ json: function () { return {}; } }); };
    try {
        sessionStorage.setItem('speeksUserName', 'Pat Example'); sessionStorage.setItem('speeksMultiStore', 'true');
        sessionStorage.setItem('speeksUserStore', 'BAL');
        _qpSave([{ items: ['feed', 'actions'], w: null }]);
        sessionStorage.setItem('speeksUserStore', 'MPL');      // the switch, before the debounce fires
        _qpFlushSave();
    } finally {
        window.fetch = realFetch;
        Object.keys(keep).forEach(function (k) { if (keep[k] === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, keep[k]); });
        try { localStorage.removeItem(QP_LAYOUT_KEY + 'pat example@bal'); } catch (_) {}
    }
    if (sent.length !== 1) return sent.length + ' saves sent';
    return sent[0].store === 'BAL' && sent[0].user === 'Pat Example' ? true : 'sent as ' + sent[0].store;
});

// 2. A tab's label stays put when its count gets shorter ("0/15" → "0/2"):
//    a checklist tab reserves its longest period's count (_qpAiCntRoom).
t('an Action Items tab label does not move when its count changes length', function () {
    var host = document.createElement('div');
    host.style.cssText = 'width:420px';
    var tabs = function (cnt) {
        return '<div data-qp-block="actions"><div class="qp-ai-tabs ew-seg">'
            + '<button type="button" class="toggle-btn active"><span class="lab">Manager</span> <span class="qp-ai-cnt" style="min-width:4ch">' + cnt + '</span></button>'
            + '<button type="button" class="toggle-btn">Cleaning <span class="qp-ai-cnt">0/16</span></button>'
            + '<button type="button" class="toggle-btn">Goals <span class="qp-ai-cnt">4</span></button></div></div>';
    };
    document.body.appendChild(host);
    host.innerHTML = tabs('0/15');
    var a = host.querySelector('.lab').getBoundingClientRect().left;
    host.innerHTML = tabs('0/2');
    var b = host.querySelector('.lab').getBoundingClientRect().left;
    host.remove();
    return Math.abs(a - b) < 0.5 ? true : '"Manager" moved ' + (b - a).toFixed(1) + 'px';
});

// 3. Every miss line's Goal and Store tags are the same widths, lined up.
t('Weekly KPIs tags are even: same widths, lined up', function () {
    var host = document.createElement('div');
    host.style.cssText = 'width:560px';
    host.innerHTML = '<div class="qp-hl">' + _QP_HL_BUILD.kpis({ period: 'Week ending Oct 25, 2026', metrics: [
        { t: 'Conversion', rule: 'conversion', my: '82.0%', st: '79.0%', has: true, bad: true },
        { t: 'Variance', rule: 'variance', my: '-1.16%', st: '-0.96%', has: true, bad: true },
        { t: 'Margin', rule: 'margin', my: '55.0%', st: '54.0%', has: true, bad: false },
    ] }) + '</div>';
    document.body.appendChild(host);
    var rows = Array.from(host.querySelectorAll('.qp-kpi-v')).map(function (v) {
        return Array.from(v.querySelectorAll('.qp-kpi-tag')).map(function (x) { var r = x.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; });
    });
    host.remove();
    if (rows.length !== 2) return rows.length + ' miss lines';
    var same = rows[0].every(function (p, i) { return Math.abs(p[0] - rows[1][i][0]) <= 1 && Math.abs(p[1] - rows[1][i][1]) <= 1; });
    return same ? true : JSON.stringify(rows);
});

// EVERY TAB CENTRED (Ethan, 2026-10-26: "make sure all tabs have their text
// centered for all widgets and all roles"). Measured with the real styles.css:
// the label + count sits in the middle of its button, within a pixel, in each
// kind of tab bar a card or widget uses.
t('every tab bar centres its text', function () {
    var host = document.createElement('div');
    host.style.cssText = 'width:440px';
    var bars = {
        'Action Items': '<div data-qp-block="actions"><div class="qp-ai-tabs ew-seg"><button class="toggle-btn active">Manager <span class="qp-ai-cnt">1/15</span></button><button class="toggle-btn">Cleaning <span class="qp-ai-cnt">0/16</span></button><button class="toggle-btn">Goals <span class="qp-ai-cnt">0</span></button></div></div>',
        'Your Feed': '<div data-qp-block="feed"><div class="sam-ftabs ew-seg"><button class="toggle-btn active">All <span class="qp-ai-cnt">3</span></button><button class="toggle-btn">Due <span class="qp-ai-cnt">0</span></button><button class="toggle-btn">To Do <span class="qp-ai-cnt">2</span></button><button class="toggle-btn">News <span class="qp-ai-cnt">1</span></button></div></div>',
        'Widget': '<div data-qp-block="stats"><div class="qp-ai-tabs ew-seg"><button class="toggle-btn active">Champions</button><button class="toggle-btn">Awards</button><button class="toggle-btn">Records</button></div></div>',
        'Command Center': '<div data-qp-block="command"><div class="cc-widget"><div class="cc-tabbar"><div class="ew-seg cc-seg"><button class="toggle-btn active"><span class="cc-tl">Live Dashboard</span><span class="cc-ts">Live</span></button><button class="toggle-btn">eBay</button><button class="toggle-btn"><span class="cc-tl">Scorecard</span><span class="cc-ts">Score</span></button></div></div></div></div>',
        'Command Center, four tabs': '<div data-qp-block="command"><div class="cc-widget qp-many-tabs"><div class="cc-tabbar"><div class="ew-seg cc-seg"><button class="toggle-btn active"><span class="cc-tl">Live Dashboard</span><span class="cc-ts">Live</span></button><button class="toggle-btn">eBay</button><button class="toggle-btn"><span class="cc-tl">Scorecard</span><span class="cc-ts">Score</span></button><button class="toggle-btn"><span class="cc-tl">Weekly KPIs</span><span class="cc-ts">KPIs</span></button></div></div></div></div>',
        'Period switch': '<div data-qp-block="actions"><span class="qp-hl-switch"><button class="on">Daily</button><button>Weekly</button><button>Monthly</button></span></div>',
    };
    var off = [];
    document.body.appendChild(host);
    Object.keys(bars).forEach(function (name) {
        host.innerHTML = bars[name];
        Array.from(host.querySelectorAll('button')).forEach(function (b) {
            var r = document.createRange();
            r.selectNodeContents(b);
            var parts = Array.from(r.getClientRects()).filter(function (x) { return x.width > 0; });
            if (!parts.length) return;
            var left = Math.min.apply(null, parts.map(function (x) { return x.left; }));
            var right = Math.max.apply(null, parts.map(function (x) { return x.right; }));
            var br = b.getBoundingClientRect();
            var d = (left + right) / 2 - (br.left + br.right) / 2;
            if (Math.abs(d) > 1) off.push(name + ' "' + b.textContent.trim() + '" ' + d.toFixed(1) + 'px');
        });
    });
    host.remove();
    return off.length ? 'off centre: ' + off.join('; ') : true;
});

// ONLY CUSTOMIZE PAGES ARE HELD TO HALF A ROW (Ethan, 2026-10-26: the store
// board's one Live card sat at half the screen; MOCD's full Live table was
// squeezed into half). The District Command Center keeps a full row until it
// has headline cards of its own.
t('without Customize nothing is held under a full row; the District card never is', function () {
    var real = _qpHeadlinesOn;
    try {
        _qpHeadlinesOn = function () { return false; };
        var off = [_qpMaxW('command'), _qpMaxW('feed'), _qpMaxW('claims'), _qpNeedsPartner('command')];
        _qpHeadlinesOn = function () { return true; };
        var on = [_qpMaxW('command'), _qpMaxW('feed'), _qpMaxW('district'), _qpNeedsPartner('district')];
        var got = off.join(',') + ' / ' + on.join(',');
        return got === '1,1,1,false / 0.5,0.5,1,false' ? true : got;
    } finally { _qpHeadlinesOn = real; }
});

// THE DISTRICT ACTION ITEMS CARDS (Ethan, 2026-10-26, option B): the five
// stores, worst first, from the same reads as the district popups.
function textOf(b) {
    var d = document.createElement('div');
    d.innerHTML = b.body.replace(/></g, '> <');
    return d.textContent.replace(/\s+/g, ' ').trim();
}
t('District Cleaning: stores fully done, then each store worst first', function () {
    var was = dmAuditData;
    var day = function (done, total) { return { daily: { items: [], total: total, completed: done }, weekly: { items: [], total: 4, completed: 4 } }; };
    dmAuditData = { OVL: day(16, 16), LEE: day(12, 16), WSP: day(3, 16), MPL: day(16, 16), BAL: day(8, 16) };
    try {
        var b = _qpAiDmCleaning(4, 'actions'), s = textOf(b);
        if (b.count !== '2/5') return 'count ' + b.count;
        if (!/^2 ?of 5 stores done/.test(s)) return s;
        var order = (s.match(/\b(OVL|LEE|WSP|MPL|BAL)\b/g) || []).join(',');
        if (order !== 'WSP,BAL,LEE,OVL,MPL') return 'order ' + order;
        _qpAiPeriod['actions|dmcleaning'] = 'weekly';
        var w = _qpAiDmCleaning(4, 'actions');
        delete _qpAiPeriod['actions|dmcleaning'];
        return w.count === '5/5' ? true : 'weekly count ' + w.count;
    } finally { dmAuditData = was; }
});
t('District Team Goals: stores with nothing set come first', function () {
    var g = getMonthlyGoals, i = getStoreInitiatives;
    var n = { OVL: 4, LEE: 0, WSP: 6, MPL: 2, BAL: 0 };
    getMonthlyGoals = function (st) { return { goals: new Array(n[st]).fill({ title: 'x' }) }; };
    getStoreInitiatives = function () { return { initiatives: [] }; };
    try {
        var b = _qpAiDmGoals(4), s = textOf(b);
        if (b.count !== '3/5') return 'count ' + b.count;
        var order = (s.match(/\b(OVL|LEE|WSP|MPL|BAL)\b/g) || []).join(',');
        // All five, each Set or Not Set (pills, 2026-10-26).
        return order === 'LEE,BAL,MPL,OVL,WSP' && /LEE Not Set BAL Not Set MPL Set OVL Set WSP Set/.test(s) ? true : order + ' :: ' + s;
    } finally { getMonthlyGoals = g; getStoreInitiatives = i; }
});
t('District Listing Goals: listed is results, a store with no goal says Not Set', function () {
    var was = [allDistrictGoalsData, _dmxGoalsLoaded, targetFor, goalIsSetThisWeek];
    var today = new Date(); today.setHours(12, 0, 0, 0);
    var iso = today.toISOString().slice(0, 10);
    allDistrictGoalsData = [
        { store: 'OVL', date: iso, employee: 'A', goal: 40, result: 30 },
        { store: 'OVL', date: iso, employee: 'B', goal: 20, result: 20 },
        { store: 'LEE', date: iso, employee: 'C', goal: 50, result: 10 },
    ];
    _dmxGoalsLoaded = true;
    targetFor = function (st) { return st === 'OVL' ? 100 : 80; };
    goalIsSetThisWeek = function (st) { return st !== 'BAL'; };
    try {
        var b = _qpAiDmListing(4), s = textOf(b);
        if (b.count !== '60/420') return 'count ' + b.count + ' :: ' + s;
        if (!/BAL Not Set/.test(s) || s.indexOf('BAL') > s.indexOf('LEE')) return 'BAL first, Not Set :: ' + s;
        return /OVL 50\/100/.test(s) && /LEE 10\/80/.test(s) ? true : s;
    } finally { allDistrictGoalsData = was[0]; _dmxGoalsLoaded = was[1]; targetFor = was[2]; goalIsSetThisWeek = was[3]; }
});
