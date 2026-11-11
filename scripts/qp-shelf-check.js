// QUICKPORTAL NEW WIDGETS + MINI SHELVES checks (Ethan, 2026-10-29).
//
//   powershell -File scripts/browser-check.ps1 qp-shelf-check.js
//
// What these hold:
//   · a shelf is a ⅓ block whose key is its contents ("shelf:a,b,c"); three
//     slots, a double mini takes two, and a mini is on the page once
//   · every widget sits in one of the drawer's categories
//   · Goal Pace, Google Reviews and Team Production work their numbers the way
//     their cards say (made-up snapshot below — the real one is store-snapshot)
// Heights were measured in the browser for manager, DM and employee.

_b2bSend = function () { return Promise.resolve({}); };
_qpHeadlinesOn = function () { return true; };

t('a shelf is a third of a row, and its key is its contents', function () {
    if (Math.abs(_qpMaxW('shelf:mcash,mdue') - 1 / 3) > 1e-9) return 'shelf max ' + _qpMaxW('shelf:mcash,mdue');
    if (!_qpIsShelfKey('shelf:mcash') || _qpIsShelfKey('claims')) return 'shelf key test';
    var ids = _qpShelfIds('shelf:mcash,mdue,mnews');
    if (ids.join('|') !== 'mcash|mdue|mnews') return 'ids ' + ids;
    if (_qpShelfKey(ids) !== 'shelf:mcash,mdue,mnews') return 'round trip';
    if (_qpWidgetId('shelf:mcash')) return 'a shelf read as a widget';
    return true;
});

// ONE SIZE since 2026-11-09 (Ethan: "keep all mini widgets the 1 size"): no
// mini is a double any more, and a saved "id~2" counts as one row.
t('a shelf holds three rows; every mini is one row, a saved ~2 included', function () {
    var real = _qpMiniOk;
    try {
        _qpMiniOk = function () { return true; };
        if (_qpShelfUsed(['mcash', 'mdue', 'mnews']) !== 3) return 'three singles';
        if (_qpShelfUsed(['mmix', 'mdue']) !== 2) return 'Customer Mix should be one row';
        if (_qpShelfUsed(['mcash~2']) !== 1) return 'a saved two-row mini should count as one';
        var dbl = Object.keys(QP_MINIS).filter(function (id) { return QP_MINIS[id].double; });
        if (dbl.length) return 'still two-row only: ' + dbl.join(', ');
        return true;
    } finally { _qpMiniOk = real; }
});

t('Customer Mix and Coming Up draw as one-row minis', function () {
    var mix = QP_MINIS.mmix.draw({ today: '2026-11-09', np: [], facts: [
        { store: 'OVL', date: '2026-11-07', total_customers: 10, new_customers: 4, return_customers: 3, recycle_customers: 1, no_deal_customers: 2 }] });
    if (!mix || mix.html || mix.k === undefined || mix.v === undefined) return 'Customer Mix is not one-row: ' + JSON.stringify(mix);
    if (/qp-mix/.test(mix.v)) return 'Customer Mix should have no bar (2026-11-10): ' + mix.v;
    if (mix.v !== '10' || mix.s !== '30% came back') return 'total and returning: ' + mix.v + ' / ' + mix.s;
    var real = [window._scalOccurrences, window._scalTodayISO];
    try {
        window._scalTodayISO = function () { return '2026-11-09'; };
        window._scalOccurrences = function () { return [
            { day: '2026-11-12', first: true, ev: { title: 'Holiday Hours Start' } },
            { day: '2026-11-20', first: true, ev: { title: 'Inventory Count' } }]; };
        var cal = QP_MINIS.mcal.draw();
        if (!cal || cal.html) return 'Coming Up is not one-row';
        if (cal.k !== 'Coming Up · 1 More') return 'k ' + cal.k;
        if (cal.s !== 'Holiday Hours Start') return 's ' + cal.s;
        window._scalOccurrences = function () { return []; };
        if (QP_MINIS.mcal.draw().v !== '—') return 'empty calendar';
        return true;
    } finally { window._scalOccurrences = real[0]; window._scalTodayISO = real[1]; }
});

// 2026-11-10: three minis retired, % to Goal added, Due counts, reset covers minis.
t('What\'s New, SPEEKSNET Use, Live Listings, Goal Pace and Google Reviews are retired; none is in the default', function () {
    var gone = ['mnews', 'musage', 'mlive', 'mpace', 'mreviews'].filter(function (id) { return QP_MINIS[id].avail(); });
    if (gone.length) return 'still offered: ' + gone.join(',');
    var inDef = QPT_MINI_DEFAULT.filter(function (id) { return /^(mnews|musage|mlive|mpace|mreviews)$/.test(id); });
    if (inDef.length) return 'in the default: ' + inDef.join(',');
    if (QPT_MINI_DEFAULT.indexOf('mgoal') === -1) return '% to Goal should be in the default';
    return true;
});

t('% to Goal: net profit over the goal, coloured by the pace', function () {
    // A store manager's view: _qpIsDist is a const, so the role is set where it reads it.
    var keep = [window._qpMyStore, sessionStorage.getItem('speeksUserRole')];
    try {
        sessionStorage.setItem('speeksUserRole', 'manager');
        window._qpMyStore = function () { return 'OVL'; };
        // Ten days in of a 30-day month, $10,000 made against $30,000: on pace (100%,
        // the Live board's % to Goal), 33% of the whole month.
        var d = { today: '2026-11-11', goals: { OVL: 30000 }, np: [] };
        for (var i = 1; i <= 10; i++) d.np.push({ store: 'OVL', date: '2026-11-' + (i < 10 ? '0' + i : i), sales: 2000, np: 1000 });
        var r = QP_MINIS.mgoal.draw(d);
        if (!/>100%</.test(r.v)) return 'v ' + r.v;
        if (!/class="good"/.test(r.v)) return 'on pace should be green: ' + r.v;
        // Goal Pace folded in: $20,000 to go over 20 days left = $1,000 a day.
        if (r.s !== '$1,000 a day · 20 days left') return 's ' + r.s;
        // Half the money: 50% — red.
        d.np.forEach(function (x) { x.np = 500; });
        if (!/class="bad">50%</.test(QP_MINIS.mgoal.draw(d).v)) return 'half pace ' + QP_MINIS.mgoal.draw(d).v;
        d.goals.OVL = 0;
        if (QP_MINIS.mgoal.draw(d).v !== '—') return 'no goal should read —';
        return true;
    } finally { window._qpMyStore = keep[0]; if (keep[1] === null) sessionStorage.removeItem('speeksUserRole'); else sessionStorage.setItem('speeksUserRole', keep[1]); }
});

t('Five-Star Reviews: the count, and where the month is tracking', function () {
    // A store manager's view: _qpIsDist is a const, so the role is set where it reads it.
    var keep = window._qpMyStore, role = sessionStorage.getItem('speeksUserRole');
    try {
        sessionStorage.setItem('speeksUserRole', 'manager');
        window._qpMyStore = function () { return 'OVL'; };
        // 7 five-star reviews by Nov 10 of a 30-day month: tracking to 21.
        var r = QP_MINIS.mstars.draw({ today: '2026-11-11', np: [], facts: [{ store: 'OVL', date: '2026-11-10', five_star_mtd: 7, reviews_today: 1 }] });
        if (r.v !== '7' || r.s !== 'Tracking to 21' || r.right) return JSON.stringify(r);
        return true;
    } finally { window._qpMyStore = keep; if (role === null) sessionStorage.removeItem('speeksUserRole'); else sessionStorage.setItem('speeksUserRole', role); }
});

t('a saved Goal Pace / Google Reviews reads as % to Goal / Five-Star Reviews, once each', function () {
    var keep = window._qpSaved;
    try {
        window._qpSaved = function () { return [{ items: ['qpt:v1'] }, { items: ['qpt:minis', 'mpace', 'mreviews', 'mgoal', 'mcash'] }]; };
        var s = _qptRead();
        if ((s.minis || []).join(',') !== 'mgoal,mstars,mcash') return 'minis ' + s.minis;
        return true;
    } finally { window._qpSaved = keep; }
});

t('In Stock and Cash on Hand: no chart; value + items, total + drawer and safe', function () {
    var keep = [window._qpMyStore, sessionStorage.getItem('speeksUserRole')];
    try {
        sessionStorage.setItem('speeksUserRole', 'manager');
        window._qpMyStore = function () { return 'OVL'; };
        var d = { today: '2026-11-11', np: [], facts: [{ store: 'OVL', date: '2026-11-10', available_count: 258, available_value: 65800 }],
                  cash: [{ store: 'OVL', day: '2026-11-09', total: 4999, drawer: 4898, safe: 101 }, { store: 'OVL', day: '2026-11-10', total: 3600, drawer: 476, safe: 3124 }] };
        var s = QP_MINIS.mqueue.draw(d), c = QP_MINIS.mcash.draw(d);
        if (s.right || c.right) return 'a chart is still drawn';
        if (s.s !== '258 items in stock') return 'in stock s ' + s.s;
        if (c.s !== 'Drawer $476 · Safe $3,124') return 'cash s ' + c.s;
        return true;
    } finally { window._qpMyStore = keep[0]; if (keep[1] === null) sessionStorage.removeItem('speeksUserRole'); else sessionStorage.setItem('speeksUserRole', keep[1]); }
});

t('Buying for corp: the district on the latest day, margin weighted by value', function () {
    var keep = sessionStorage.getItem('speeksUserRole');
    try {
        sessionStorage.setItem('speeksUserRole', 'district manager');
        if (!QP_MINIS.mbuy.avail()) return 'corp should have Buying';
        // OVL $3,000 at 50%, LEE $1,000 at 70% on Nov 10 (LEE's Nov 9 is older): $4,000 at 55%.
        var d = { today: '2026-11-11', np: [], facts: [
            { store: 'LEE', date: '2026-11-09', est_value: 9999, est_margin_pct: 0.1, cust_conv_num: 1, cust_conv_den: 9 },
            { store: 'OVL', date: '2026-11-10', est_value: 3000, est_margin_pct: 0.5, cust_conv_num: 8, cust_conv_den: 10 },
            { store: 'LEE', date: '2026-11-10', est_value: 1000, est_margin_pct: 70, cust_conv_num: 6, cust_conv_den: 10 }] };
        var r = QP_MINIS.mbuy.draw(d);
        if (!/^Bought · District/.test(r.k)) return 'k ' + r.k;
        if (r.v !== _qpHLK(4000)) return 'v ' + r.v;
        if (r.s !== '55% margin · 70% conversion') return 's ' + r.s;
        return true;
    } finally { if (keep === null) sessionStorage.removeItem('speeksUserRole'); else sessionStorage.setItem('speeksUserRole', keep); }
});

t('a full rail: every other tile keeps a greyed + Add that adds nothing; no Swap left', function () {
    if (typeof qptMiniSwap !== 'undefined' || typeof qptSwapPick !== 'undefined') return 'the Swap option should be gone';
    var keep = [_qptState, window._qpMiniOk];
    try {
        window._qpMiniOk = function () { return true; };
        var ids = Object.keys(QP_MINIS);
        _qptState = { order: [], hidden: [], minis: ids.slice(0, 8) };
        var host = document.createElement('div');
        host.id = 'qptDrawer';
        host.innerHTML = '<div class="qpt-dh"><h2></h2></div><div class="qpt-tiles"></div>';
        document.body.appendChild(host);
        try {
            _qptTiles();
            var off = host.querySelectorAll('.qpt-tile.full .qpt-pill.qpt-pill-off');
            var full = host.querySelectorAll('.qpt-tile.full');
            if (!full.length) return 'no full tiles';
            if (off.length !== full.length) return off.length + ' greyed pills on ' + full.length + ' full tiles';
            if ([].some.call(full, function (t) { return t.hasAttribute('onclick'); })) return 'a full tile still has a click';
            if (!/\+ Add/.test(off[0].textContent)) return 'pill says ' + off[0].textContent;
        } finally { host.remove(); }
        return true;
    } finally { _qptState = keep[0]; window._qpMiniOk = keep[1]; }
});

// 2026-11-10 quick-fact minis. Role set where _qpRole reads it.
function _asRole(role, fn) {
    var keep = [sessionStorage.getItem('speeksUserRole'), sessionStorage.getItem('speeksUserName'), window._qpMyStore];
    try { sessionStorage.setItem('speeksUserRole', role); sessionStorage.setItem('speeksUserName', 'Bo Ray'); window._qpMyStore = function () { return 'OVL'; }; return fn(); }
    finally {
        ['speeksUserRole', 'speeksUserName'].forEach(function (k, i) { if (keep[i] === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, keep[i]); });
        window._qpMyStore = keep[2];
    }
}
t('Sales: yesterday from the Live board — net sales, their cost, gross margin', function () {
    var keep = _lvData;
    try {
        return _asRole('manager', function () {
            _lvData = null;
            if (QP_MINIS.msales.draw().s !== 'Syncing…') return 'should wait for the Live board';
            _lvData = { prev: { date: '2026-11-09' }, stores: [{ code: 'OVL', prev: { netToday: 5000, gpToday: 3000 } }] };
            var r = QP_MINIS.msales.draw();
            if (r.v !== _lvMoney(5000, false)) return 'v ' + r.v;
            return r.s === 'Cost $2,000 · 60% gross margin' ? true : 's ' + r.s;
        });
    } finally { _lvData = keep; }
});
t('Open Claims: Returns, Cases, Claims as the numbers; each red if its own is overdue', function () {
    var d = { today: '2026-11-10', _split: {
        returns: { due: [{ x: { due_on: '2026-11-12' } }], waiting: 1 },
        cases: { due: [{ x: { due_on: '2026-11-08' } }], waiting: 2 },
        mismatch: { due: [], waiting: 1 }, payments: { due: [], waiting: 0 } } };
    var r = QP_MINIS.mclaims.draw(d);
    var txt = r.v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (txt !== '2 Returns 3 Cases 1 Claim') return 'v ' + txt;
    if (!/class="bad">3</.test(r.v) || /class="bad">2</.test(r.v)) return 'only Cases has an overdue one: ' + r.v;
    return r.s === '6 open · 1 overdue' ? true : 's ' + r.s;
});
t('Company Snapshot: % to goal big; Buy margin and conversion under it', function () {
    var keep = _lvData;
    try {
        return _asRole('district manager', function () {
            _lvData = { district: { mtdNet: 50000, mtdGp: 29000 } };
            var d = { today: '2026-11-11', goals: { OVL: 30000 }, np: [], facts: [
                { store: 'OVL', date: '2026-11-10', est_value: 3000, est_margin_pct: 0.5, cust_conv_num: 7, cust_conv_den: 10 },
                { store: 'LEE', date: '2026-11-10', est_value: 1000, est_margin_pct: 0.7, cust_conv_num: 7, cust_conv_den: 10 }] };
            for (var i = 1; i <= 10; i++) d.np.push({ store: 'OVL', date: '2026-11-' + (i < 10 ? '0' + i : i), sales: 2000, np: 1000 });
            var r = QP_MINIS.mcompany.draw(d);
            if (QP_MINIS.mcompany.label !== 'Company Snapshot') return 'label ' + QP_MINIS.mcompany.label;
            if (!/>100%</.test(r.v)) return 'v ' + r.v;
            return r.s === 'Buy 55% · Conv 70%' ? true : 's ' + r.s;   // no GM (taken out 2026-11-10)
        });
    } finally { _lvData = keep; }
});
t('B2B: deals still being listed count as deals (WSP read "0 deals · 261 to list")', function () {
    return _asRole('manager', function () {
        var unl = [];
        for (var i = 0; i < 11; i++) unl.push({ deal_id: 'd' + i, unlisted_units: i === 0 ? 161 : 10 });
        var r = QP_MINIS.mb2b.draw({ deals: [], unl: unl });
        if (!/^11/.test(r.v)) return 'v ' + r.v;
        return r.s === '261 units to list' ? true : 's ' + r.s;   // just deals and units (2026-11-10)
    });
});
t('Call Back Matches: in stock now big (any store customer), open call backs under it', function () {
    var keep = window._cbMatchScope;
    try {
        window._cbMatchScope = function () { return ['OVL']; };
        var rows = [
            { store: 'OVL', status: 'open', matches: [{ state: 'suggested', store_code: 'OVL' }] },
            { store: 'LEE', status: 'open', matches: [{ state: 'suggested', store_code: 'OVL' }] },
            { store: 'OVL', status: 'contacted', matches: [{ state: 'suggested', store_code: 'OVL' }] },
            { store: 'OVL', status: 'open', matches: [] },
            { store: 'OVL', status: 'completed', matches: [{ state: 'suggested', store_code: 'OVL' }] }];
        var r = QP_MINIS.mcb.draw(rows);
        if (!/>2</.test(r.v) || !/matches/.test(r.v)) return 'v ' + r.v;
        return r.s === '3 call backs open' ? true : 's ' + r.s;
    } finally { window._cbMatchScope = keep; }
});
t('Employee: Your No Deals and Your Listings from their own row of last week\'s KPIs', function () {
    return _asRole('employee', function () {
        var w = { end: '2026-11-08', emps: [{ employee_name: 'Bo Ray', no_deal_count: 2, no_deal_value: 850, listed_count: 45, listed_retail_price: 13200, listed_sold_pct: 42.6 }] };
        var a = QP_MINIS.mnodeal.draw(w), b = QP_MINIS.mylist.draw(w);
        if (a.v !== '2' || a.s !== '$850 in value') return 'no deals ' + a.v + ' / ' + a.s;
        if (b.v !== '45' || b.s !== '$13.2k listed · 43% sold') return 'listings ' + b.v + ' / ' + b.s;
        if (!QP_MINIS.mnodeal.avail() || !QP_MINIS.mylist.avail() || !QP_MINIS.mbuy.avail()) return 'an employee should have all three';
        return true;
    });
});

t('Top Lister: most listed on last week\'s KPIs, the owner left out', function () {
    var w = { end: '2026-11-08', emps: [
        { employee_name: 'Ethan Kushnir', listed_count: 99, listed_retail_price: 9000 },
        { employee_name: 'Zach Marchesano', listed_count: 45, listed_retail_price: 13200 },
        { employee_name: 'Bo Ray', listed_count: 12, listed_retail_price: 900 }] };
    var r = QP_MINIS.mtop.draw(w);
    if (QP_MINIS.mtop.label !== 'Top Lister' || QP_MINIS.mtop.src !== 'wkpi') return 'not Top Lister on wkpi';
    if (!/^Zach M/.test(r.v)) return 'v ' + r.v;
    if (!/^45 listed/.test(r.s)) return 's ' + r.s;
    return true;
});

t('Buying: the store\'s latest day for a manager, your own last week for an employee — no chart', function () {
    var keep = [window._qpMyStore, sessionStorage.getItem('speeksUserRole'), sessionStorage.getItem('speeksUserName'), _qpMiniSrcState.wkpi.data, _qpMiniSrcState.wkpi.at, window._speeksTestSession];
    try {
        window._speeksTestSession = false;
        window._qpMyStore = function () { return 'OVL'; };
        sessionStorage.setItem('speeksUserRole', 'manager');
        var d = { today: '2026-11-11', np: [], facts: [{ store: 'OVL', date: '2026-11-10', est_value: 2280, est_margin_pct: 0.53, cust_conv_num: 9, cust_conv_den: 10 }] };
        var r = QP_MINIS.mbuy.draw(d);
        if (r.right) return 'the chart line should be gone';
        if (r.s !== '53% margin · 90% conversion') return 'store s ' + r.s;
        sessionStorage.setItem('speeksUserRole', 'employee');
        sessionStorage.setItem('speeksUserName', 'Bo Ray');
        if (!QP_MINIS.mbuy.avail()) return 'employees should have Buying';
        _qpMiniSrcState.wkpi.data = { end: '2026-11-08', emps: [{ employee_name: 'Bo Ray', buying_value: 1000, buying_cost: 400, transaction_count: 8, transaction_converted: 6 }] };
        _qpMiniSrcState.wkpi.at = Date.now();
        r = QP_MINIS.mbuy.draw(d);
        if (r.k !== 'Your Buying · Last Week' || r.s !== '60% margin · 75% conversion') return 'employee ' + r.k + ' / ' + r.s;
        return true;
    } finally {
        window._qpMyStore = keep[0];
        ['speeksUserRole', 'speeksUserName'].forEach(function (k, i) { var v = keep[1 + i]; if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); });
        _qpMiniSrcState.wkpi.data = keep[3]; _qpMiniSrcState.wkpi.at = keep[4]; window._speeksTestSession = keep[5];
    }
});

t('Due: how many are due, overdue in red, the nearest underneath', function () {
    var keep = window._samGatherReminders;
    try {
        window._samGatherReminders = function () { return [
            { kind: 'due', dueGroup: 'week', dueOn: '2026-11-13', title: 'File KPIs' },
            { kind: 'due', dueGroup: 'over', dueOn: '2026-11-08', title: 'Claims Overdue' },
            { kind: 'due', dueGroup: 'today', dueOn: '2026-11-10', title: 'Price B2B' },
            { kind: 'news', title: 'not a deadline' }]; };
        var r = QP_MINIS.mdue.draw();
        if (!/class="bad">3</.test(r.v)) return 'v ' + r.v;
        // Just due and overdue under it — no "Next:" line (2026-11-10).
        if (r.s !== '1 overdue · 1 due today') return 's ' + r.s;
        window._samGatherReminders = function () { return []; };
        if (!/All Clear/.test(QP_MINIS.mdue.draw().v)) return 'empty';
        return true;
    } finally { window._samGatherReminders = keep; }
});

t('Reset Dashboard puts the minis back to the starting set too', function () {
    var keep = [_qptState, window._qptRebuild];
    try {
        window._qptRebuild = function () {};
        _qptState = { order: ['inventory', 'live'], hidden: ['perf'], minis: ['mcash', 'mtop'] };
        qptResetTabs();
        if (_qptState.minis !== null) return 'minis ' + _qptState.minis;
        if (_qptState.hidden.join(',') !== QPT_HIDDEN_DEFAULT.join(',')) return 'hidden ' + _qptState.hidden;
        return true;
    } finally { _qptState = keep[0]; window._qptRebuild = keep[1]; }
});

// EIGHT AT MOST on the rail (Ethan, 2026-11-09).
t('the rail takes eight minis at most; the ninth add does nothing', function () {
    var keep = [_qptState, window._qpMiniOk, window._qptSave, window._qptAfterMini];
    try {
        window._qpMiniOk = function () { return true; };
        window._qptSave = function () {};
        window._qptAfterMini = function () {};
        var ids = Object.keys(QP_MINIS);
        if (ids.length < 9) return 'need nine minis to test, have ' + ids.length;
        _qptState = { order: [], hidden: [], minis: ids.slice(0, 7) };
        qptMiniAdd(ids[7]);
        if (_qptState.minis.length !== 8) return 'the eighth was refused: ' + _qptState.minis.length;
        if (!_qptRailFull()) return 'eight should read as full';
        qptMiniAdd(ids[8]);
        if (_qptState.minis.length !== 8) return 'a ninth got on: ' + _qptState.minis.join(',');
        _qptState = { order: [], hidden: [], minis: ids.slice(0, 10) };
        if (_qptRailToks().length !== 8) return 'an old ten-mini layout should show eight, shows ' + _qptRailToks().length;
        // Removing one from it frees a place: the two past eighth go, not slide up.
        qptMiniRemove(ids[0]);
        if (_qptState.minis.length !== 7) return 'after a remove the old layout should hold seven, holds ' + _qptState.minis.join(',');
        if (_qptRailFull()) return 'a place should be free after a remove';
        return true;
    } finally { _qptState = keep[0]; window._qpMiniOk = keep[1]; window._qptSave = keep[2]; window._qptAfterMini = keep[3]; }
});

t('every widget is in a drawer category, and every mini can draw', function () {
    var bad = Object.keys(QP_WIDGETS).filter(function (id) { return _QP_LIB_SECTIONS.indexOf(QP_WIDGETS[id].section || 'Other') === -1 || !QP_WIDGETS[id].section; });
    if (bad.length) return 'no category: ' + bad.join(', ');
    var mb = Object.keys(QP_MINIS).filter(function (id) { var m = QP_MINIS[id]; return !m.label || !m.sub || !m.icon || typeof m.draw !== 'function' || (['snap', 'page', 'cal', 'recycle', 'wkpi'].indexOf(m.src) === -1 && !/^w:(claims|callbacks|b2b|connect)$/.test(m.src)); });
    if (mb.length) return 'incomplete minis: ' + mb.join(', ');
    if (QP_MINIS.shoutouts || QP_WIDGETS.shoutouts) return 'Customer Shoutouts was dropped (Ethan)';
    return true;
});

// A made-up snapshot: OVL, three October days and one September day.
var SNAP = {
    today: '2026-10-29', goals: { OVL: 55000 },
    np: [
        { store: 'OVL', date: '2026-10-26', sales: 5000, np: 2000 },
        { store: 'OVL', date: '2026-10-27', sales: 6000, np: 3000 },
        { store: 'OVL', date: '2026-10-28', sales: 4000, np: 1000 },
    ],
    facts: [
        { store: 'OVL', date: '2026-09-27', reviews_today: 2 },
        { store: 'OVL', date: '2026-10-26', reviews_today: 1, five_star_mtd: 3, devices_processed: 30, team_production: [{ name: 'Ann Lee', processed: 20, value: 900, top: true }, { name: 'Bo Ray', processed: 10, value: 300 }] },
        { store: 'OVL', date: '2026-10-27', reviews_today: 3, five_star_mtd: 6, devices_processed: 40, team_production: [{ name: 'Ann Lee', processed: 25, value: 1000, top: true }, { name: 'Bo Ray', processed: 15, value: 500 }] },
        { store: 'OVL', date: '2026-10-28', reviews_today: 2, five_star_mtd: 8, devices_processed: 35, processed_value: 1700, team_production: [{ name: 'Bo Ray', processed: 20, value: 800 }, { name: 'Ann Lee', processed: 15, value: 900, top: true }] },
    ],
};

t('Goal Pace: what is left, over the calendar days left (as the Live board counts, since 2026-11-08)', function () {
    var p = _qpPaceOf(SNAP, 'OVL');
    if (p.soFar !== 6000) return 'so far ' + p.soFar;
    // Through Oct 28: $6,000 over 28 calendar days, Sundays included.
    if (Math.abs(p.avg - 6000 / 28) > 1e-9) return 'average ' + p.avg;
    // Oct 29 to Oct 31: three calendar days left.
    if (p.left !== 3) return 'days left ' + p.left;
    if (Math.abs(p.pct - 6000 / 28 * 31 / 55000 * 100) > 1e-9) return 'tracking ' + p.pct;
    if (Math.round(p.need) !== Math.round((55000 - 6000) / 3)) return 'needed ' + p.need;
    if (p.best.date !== '2026-10-27') return 'best day ' + p.best.date;
    if (p.hit) return 'goal not hit yet';
    return true;
});

t('Google Reviews: this month, tracking and last month to the same day', function () {
    var r = _qpReviewsOf(SNAP, 'OVL');
    if (r.mtd !== 6) return 'month to date ' + r.mtd;
    if (r.stars !== 8) return 'five-star ' + r.stars;
    if (r.prev !== 2) return 'last month so far ' + r.prev;
    // 6 reviews by the 28th of a 31-day month: 6 / 28 * 31 = 6.6 -> 7.
    if (r.track !== 7) return 'tracking ' + r.track;
    return true;
});

t('Team Production: the latest report, most processed first, top producer run', function () {
    var tm = _qpTeamOf(SNAP, 'OVL');
    if (tm.last.date !== '2026-10-28') return 'latest ' + tm.last.date;
    if (tm.team[0].name !== 'Bo Ray') return 'first ' + tm.team[0].name;
    if (tm.total !== 35) return 'total ' + tm.total;
    if (tm.topRun !== 3) return 'top producer run ' + tm.topRun;
    return true;
});
