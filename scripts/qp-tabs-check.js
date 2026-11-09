// QUICKPORTAL TABS checks — the saved state, the rows a tab is cut into, and
// that the old row layouts and the tabs one never read each other.
//
//   powershell -File scripts/browser-check.ps1 qp-tabs-check.js
//
// Ethan, 2026-11-06: Your Feed on top, the dashboard as tabs he can hide and
// reorder, mini widgets on a rail (speeks.js, QUICKPORTAL TABS).

_b2bSend = function () { return Promise.resolve({}); };
sessionStorage.setItem('speeksUserName', 'Tabs Check');
var _saved = null;
_qpSaved = function () { return _saved; };
_qpSave = function (rows) { _saved = rows; };

t('a tab of 1–3 cards is one row; more are cut as evenly as they go', function () {
    var n = function (k) { return _qptChunk(Array.from({ length: k }, function (_, i) { return 'c' + i; })).map(function (r) { return r.length; }).join('·'); };
    var got = [1, 2, 3, 4, 5, 6, 7, 9].map(n).join(' ');
    return got === '1 2 3 2·2 3·2 3·3 3·2·2 3·3·3' ? true : got;
});

t('nothing saved: every tab in order, Company & Tools hidden', function () {
    _saved = null;
    var s = _qptRead();
    if (s.order.join(',') !== QPT_TABS.map(function (t) { return t.k; }).join(',')) return 'order ' + s.order;
    if (s.hidden.join(',') !== 'company') return 'hidden ' + s.hidden;
    return s.minis === null ? true : 'minis ' + s.minis;
});

t('the state saves as rows qp-layout accepts, and reads back the same', function () {
    var st = { order: ['company', 'live', 'perf', 'claims', 'health', 'sales', 'customers', 'inventory'], hidden: ['customers', 'perf'], minis: ['mpace~2', 'mreviews', 'mtop', 'mcal', 'mdue', 'mcash', 'mnews'] };
    var rows = _qptEncode(st);
    var KEY = /^[a-z0-9:_,.-]{1,80}$/i;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].items.length > 6) return 'row ' + i + ' has ' + rows[i].items.length + ' items';
        var bad = rows[i].items.filter(function (k) { return !KEY.test(k); });
        if (bad.length) return 'not a key: ' + bad.join(' ');
    }
    _saved = rows;
    var s = _qptRead();
    if (s.order.join() !== st.order.join()) return 'order ' + s.order;
    if (s.hidden.join() !== st.hidden.join()) return 'hidden ' + s.hidden;
    return s.minis.join() === st.minis.join() ? true : 'minis ' + s.minis;
});

t('nothing hidden and no minis are saved as such, not as the defaults', function () {
    _saved = _qptEncode({ order: _qptDefaults().order, hidden: [], minis: [] });
    var s = _qptRead();
    if (s.hidden.length) return 'hidden ' + s.hidden;
    return Array.isArray(s.minis) && !s.minis.length ? true : 'minis ' + s.minis;
});

t('a tab a release adds after a save shows up at the end; unknown keys are dropped', function () {
    _saved = [{ items: ['qpt:v1'], w: null }, { items: ['qpt:order', 'perf', 'gone', 'live'], w: null }, { items: ['qpt:minis', 'nope', 'mdue'], w: null }];
    var s = _qptRead();
    if (s.order.slice(0, 2).join() !== 'perf,live') return 'order ' + s.order;
    if (s.order.length !== QPT_TABS.length) return 'length ' + s.order.length;
    return s.minis.join() === 'mdue' ? true : 'minis ' + s.minis;
});

t('an old row layout is not read as tabs, and a tabs layout is not read as rows', function () {
    _saved = [{ items: ['feed', 'actions'], w: null }, { items: ['chart', 'leaderboard'], w: null }];
    var s = _qptRead();
    if (s.hidden.join() !== 'company') return 'old rows changed the tabs: ' + JSON.stringify(s);
    // _qpLayout drops a qpt: layout to the default stack (phones and tablets).
    var src = String(_qpLayout);
    return /qpt:v1/.test(src) ? true : '_qpLayout does not check for a tabs layout';
});

t('every tab card key is a widget, a built-in block or a family piece', function () {
    var bad = [];
    QPT_TABS.forEach(function (t) {
        (t.keys || []).forEach(function (k) {
            var o = _qpParse(k);
            if (QP_WIDGETS[k] || (o && (!o.shell || QP_FAMILIES[o.fam].pieces.some(function (p) { return p.key === o.pieces[0]; }))) || ['actions', 'chart', 'feed'].indexOf(k) !== -1) return;
            bad.push(t.k + ':' + k);
        });
    });
    return bad.length ? bad.join(' ') : true;
});

t('a layout saved with the old Action Items & Claims tab reads as Claims & Disputes', function () {
    _saved = [{ items: ['qpt:v1'], w: null }, { items: ['qpt:order', 'todo', 'live'], w: null }, { items: ['qpt:hidden', 'todo'], w: null }];
    var s = _qptRead();
    if (s.order[0] !== 'claims') return 'order ' + s.order;
    if (s.order.indexOf('todo') !== -1) return 'todo still there';
    return s.hidden.join() === 'claims' ? true : 'hidden ' + s.hidden;
});

t('Action Items are on the rail, not in a tab', function () {
    var inTab = QPT_TABS.filter(function (t) { return (t.keys || []).indexOf('actions') !== -1; });
    return inTab.length ? 'in ' + inTab.map(function (t) { return t.k; }) : true;
});

t('Store Health draws as one card; a pane of one card is left alone', function () {
    var h = QPT_TABS.filter(function (t) { return t.k === 'health'; })[0];
    if (!h || !h.merge) return 'health tab is not marked merge';
    var one = document.createElement('section');
    one.innerHTML = '<div class="qp-row"><div class="qp-cell"><div data-qp-block="kpis"></div></div></div>';
    _qptMerge(one);
    if (one.classList.contains('qpt-merge') || one.querySelector('.qpt-mh')) return 'merged a single card';
    var two = document.createElement('section');
    two.innerHTML = '<div class="qp-row"><div class="qp-cell"><div data-qp-block="command:ebay"></div></div>'
        + '<div class="qp-cell"><div data-qp-block="command:score"></div></div></div>';
    _qptMerge(two);
    if (!two.classList.contains('qpt-merge') || !two.querySelector('.qpt-hv')) return 'two cards not merged';
    return true;
});

t('What Needs Fixing: a box a part in its own shape; eBay splits seller level from categories', function () {
    var pane = document.createElement('section');
    pane.innerHTML = '<div class="qp-row"><div class="qp-cell"><div data-qp-block="command:ebay"></div></div>'
        + '<div class="qp-cell"><div data-qp-block="command:score"></div></div></div>';
    var keep = { e: _qpHL.ebay, s: _qpHL.score };
    try {
        _qpHL.ebay = { crit: 1, warn: 1, clear: 6, perf: [0, 0], top: [1, 1], chips: [],
            rates: [{ name: 'Defect Rate', val: '0.49%', sev: 'bad' }, { name: 'Late Shipment', val: '0.5%', sev: 'good' }, { name: 'Cases Closed', val: '0.1%', sev: 'good' }, { name: 'Tracking', val: '96.8%', sev: 'warn' }],
            perfChips: [{ name: 'Projected High', val: 'Cameras · Phones', cls: 'warn' }] };
        _qpHL.score = null;
        var parts = _qptHealthParts(pane);
        if (parts.length !== 2) return 'parts ' + parts.length;
        var e = parts[0];
        if (e.kind !== 'ebay' || e.sev !== 'bad' || e.fix.length !== 3) return 'eBay ' + JSON.stringify({ k: e.kind, s: e.sev, n: e.fix.length });
        if (e.rates.length !== 4 || e.cats[0].list.join() !== 'Cameras,Phones') return 'eBay pieces';
        // Eight slices: 4 rates + 1 flagged category + 3 clear category levels.
        if (e.segs.length !== 8 || e.segs.filter(function (x) { return x === 'good'; }).length !== 5) return 'segs ' + e.segs;
        if (!parts[1].wait) return 'Scorecard drew with no data';
        var body = _qptBody(e);
        if (body.indexOf('Seller Level') === -1 || body.indexOf('Performance') === -1 || body.indexOf('qpt-fix') !== -1) return 'eBay body not split';
        return true;
    } finally { _qpHL.ebay = keep.e; _qpHL.score = keep.s; }
});

t('a ring is a slice a metric, not filled by the share clear', function () {
    var r = _qptRing({ segs: ['good', 'good', 'good', 'good', 'good', 'good', 'good', 'bad'], big: 1, bigSev: 'bad' });
    // Slices take the palette's fills (styles.css ONE PALETTE), red first.
    if ((r.match(/--qs-bad-fill/g) || []).length !== 1 || (r.match(/--qs-good-fill/g) || []).length !== 7) return r;
    return /^<div class="qpt-ring" style="background:conic-gradient\(var\(--qs-bad-fill/.test(r) ? true : 'red slice not first: ' + r.slice(0, 120);
});

t('DM Store Health is one store at a time, read from the district board', function () {
    var keep = { rows: _dccRows, watch: _dcWatch };
    try {
        _dccRows = [{ store: 'MPL', cats: [{ k: 'Projected · very high', v: 'Cameras, Phones', s: 'w' }], defect: '0.2', late: '0', cases: '0', track: '99',
            official: null, audit: { pct: 69.7 }, score: 6, scCats: [{ name: 'Social Media Post', score: 0 }], week: 'Nov 2' }];
        _dcWatch = { flags: [{ store: 'MPL', metric: 'listing', state: 'critical', value: 25, miss_run: 28 }, { store: 'OVL', metric: 'margin', state: 'warn', value: 50 }] };
        var out = [];
        _qptStoreParts('MPL', function (name, o) { _qptPart(out, name, o); });
        var names = out.map(function (p) { return p.name; }).join(',');
        if (names !== 'Matrix,eBay,Scorecard & Audit,Store KPIs') return 'parts ' + names;
        var m = out[0];
        if (m.metrics.length !== 3 || m.fix.length !== 1 || m.metrics[2].sub !== 'Missed 28 days in a row') return 'matrix ' + JSON.stringify(m.metrics);
        // Judged as the store card judges it: a projected very-high category is red.
        if (out[1].cats[0].sev !== 'bad' || out[1].cats[0].list.join() !== 'Cameras,Phones') return 'ebay ' + JSON.stringify(out[1].cats);
        if (out[2].fix.length !== 2) return 'scorecard fix ' + out[2].fix.length + ' (audit + Social Media Post; the scorecard tile is not counted)';
        return true;
    } finally { _dccRows = keep.rows; _dcWatch = keep.watch; }
});

t('Sales & Goals: one card (Scoreboard); DM rows worst pace first with buying beside', function () {
    var s = QPT_TABS.filter(function (t) { return t.k === 'sales'; })[0];
    if (!s || s.merge !== 'sales') return 'sales tab not merged';
    var keep = _qpSnap.data;
    var main = document.createElement('main');
    var pane = document.createElement('section');
    pane.className = 'qpt-pane';
    pane.innerHTML = '<div class="qp-row"><div class="qp-cell"><div data-qp-block="dpace"></div></div><div class="qp-cell"><div data-qp-block="dbuying"></div></div></div>';
    main.appendChild(pane);
    try {
        _qptMerge(pane, 'sales');
        if (pane.getAttribute('data-merge') !== 'sales' || !pane.hasAttribute('data-qpt-dist')) return 'not a DM sales merge';
        _qpSnap.data = window._qpSnapSample ? _qpSnapSample() : null;
        if (!_qpSnap.data) return 'no sample snapshot';
        _qptRenderSales(main);
        var rows = Array.from(pane.querySelectorAll('.qpt-sb tbody tr'));
        if (rows.length !== STORE_CODES.length) return 'rows ' + rows.length;
        var pcts = rows.map(function (r) { var b = r.querySelector('.qpt-sb-tr b'); return b ? parseFloat(b.textContent) : 1e9; });
        for (var i = 1; i < pcts.length; i++) if (pcts[i] < pcts[i - 1]) return 'not worst first: ' + pcts;
        return /gross/i.test(pane.textContent) ? 'GP on screen' : true;
    } finally { _qpSnap.data = keep; }
});

t('Goal pace matches the Live board: calendar days, Sundays included (real Nov 1-7 numbers)', function () {
    // daily_np and monthly_np_goals as they were on 2026-11-08 (read from the database).
    var np = { BAL: [194, 2462, -163, 1158, 834, 2868, 1001.10], LEE: [677, 1842, 1200, 1969, 1422, 1807, 2028.42] };
    var d = { today: '2026-11-08', goals: { BAL: 33000, LEE: 47000 }, np: [] };
    Object.keys(np).forEach(function (s) { np[s].forEach(function (v, i) { d.np.push({ store: s, date: '2026-11-0' + (i + 1), sales: 1000, np: v }); }); });
    var bal = _qpPaceOf(d, 'BAL'), lee = _qpPaceOf(d, 'LEE');
    // The Live board's Month view: so far ÷ (7/30), over the goal.
    var want = function (so, g) { return so / 7 * 30 / g * 100; };
    if (Math.abs(bal.pct - want(bal.soFar, 33000)) > 0.01 || Math.round(bal.pct) !== 108) return 'BAL ' + bal.pct;
    if (Math.round(lee.pct) !== 100) return 'LEE ' + lee.pct;
    if (bal.left !== 23 || Math.round(bal.need) !== Math.round((33000 - bal.soFar) / 23)) return 'BAL need ' + bal.need + ' left ' + bal.left;
    // On pace exactly when averaging covers what is needed.
    return (bal.avg >= bal.need) === (bal.pct >= 100) ? true : 'avg/need disagree with pct';
});

t('My KPIs alone in its tab: the wide scorecard (design A), misses first, no-goal row apart', function () {
    var html = _QP_HL_BUILD.kpis({ wide: true, period: 'Week ending Nov 8, 2026', metrics: [
        { t: 'Buying Value', rule: null, my: '$12.4k', st: '$48.6k', has: true, bad: false },
        { t: 'Margin', rule: 'margin', my: '53.8%', st: '54.2%', has: true, bad: false },
        { t: 'Conversion', rule: 'conversion', my: '81.3%', st: '85.9%', has: true, bad: true },
        { t: 'Trans. Time', rule: 'time', my: '17.2', st: '13.1', has: true, bad: true },
        { t: 'Listed Dev.', rule: null, my: '41', st: '210', has: true, bad: false }] });
    var d = document.createElement('div'); d.innerHTML = html;
    var tiles = Array.from(d.querySelectorAll('.qp-kw-t'));
    if (tiles.length !== 3) return 'tiles ' + tiles.length;
    if (!tiles[0].classList.contains('bad') || !tiles[1].classList.contains('bad') || !tiles[2].classList.contains('good')) return 'misses not first';
    if (tiles[1].querySelector('.qp-kw-v').textContent !== '17.2 min') return 'time unit: ' + tiles[1].querySelector('.qp-kw-v').textContent;
    if (d.querySelectorAll('.qp-kw-i').length !== 2) return 'no-goal row';
    var p = Array.from(d.querySelectorAll('.qp-kw-pills .qpt-vp')).map(function (x) { return x.textContent; }).join('|');
    return p === '1 of 3 On Target|2 To Work On' ? true : 'pills ' + p;
});

t('Customers is one frame: cards stay visible inside one header', function () {
    var c = QPT_TABS.filter(function (t) { return t.k === 'customers'; })[0];
    if (!c || c.merge !== 'frame') return 'customers not a frame';
    var pane = document.createElement('section');
    pane.className = 'qpt-pane'; pane.setAttribute('data-tab', 'customers');
    pane.innerHTML = '<div class="qp-row"><div class="qp-cell"><div data-qp-block="dreviews"></div></div><div class="qp-cell"><div data-qp-block="dlost"></div></div></div>';
    _qptMerge(pane, 'frame');
    if (pane.getAttribute('data-merge') !== 'frame' || !pane.classList.contains('qpt-frame')) return 'not framed';
    if (!pane.hasAttribute('data-qpt-dist')) return 'DM pane not marked district';
    if (pane.querySelector('.qpt-mt').textContent !== 'Customers') return 'title ' + pane.querySelector('.qpt-mt').textContent;
    return pane.querySelector('.qp-row') ? true : 'cards gone';
});
