// QUICKPORTAL SIZE checks — can a widget always be placed, with no dead space.
//
//   powershell -File scripts/browser-check.ps1 qp-size-check.js
//
// Ethan, 2026-10-25: on a manager's default page (Your Feed + Action Items +
// Command Center, then the chart + Leaderboard) every row was full, a new row
// of its own was refused, and with one ⅓-only widget there was no layout at
// all that left no gap. Two changes: a built-in card may take ⅔ beside a ⅓-only
// widget (_qpCap), and a drop into a full row makes room (_qpBumpPlan).
//
// The page here is bare rows of empty blocks: the layout reads only keys,
// rows and whether a block is shown, never what is in it.

_b2bSend = function () { return Promise.resolve({}); };
// A Customize page: only those are held to half a row (_qpMaxW, 2026-10-26),
// and this page has no Customize bar to look at.
_qpHeadlinesOn = function () { return true; };
// Store KPIs may be ½ since 2026-10-28; these checks are about the ⅓-only
// rules, which still exist (Due Dates), so they keep it ⅓ as their example.
_QP_WIDGET_MAXW.kpis = 1 / 3;

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
function shown(main, rows) {
    return rows.map(function (r) { return r.items.filter(function (k) { return _qpKeyShown(main, k); }).join('+'); }).filter(Boolean).join(' / ');
}
function noGaps(main, rows) {
    var bad = rows.filter(function (r) { return _qpRowWhyNot(main, r.items, r.w); });
    return bad.length ? 'rows with a gap: ' + shown(main, bad) : true;
}
var MANAGER = [['feed', 'actions', 'command'], ['chart', 'leaderboard']];

t('a built-in card takes ⅔ beside a ⅓-only widget, and only then', function () {
    if (Math.abs(_qpCap('command', ['command', 'kpis']) - 2 / 3) > 1e-9) return 'command beside kpis: ' + _qpCap('command', ['command', 'kpis']);
    if (Math.abs(_qpCap('chart', ['kpis', 'chart']) - 2 / 3) > 1e-9) return 'chart beside kpis: ' + _qpCap('chart', ['kpis', 'chart']);
    if (_qpCap('command', ['command', 'claims']) !== 0.5) return 'command beside a ½ widget should stay ½';
    if (_qpCap('command', ['feed', 'command']) !== 0.5) return 'two built-ins should stay ½';
    if (_qpCap('command', ['command', 'kpis', 'feed']) !== 0.5) return 'a row of three should stay ½';
    if (_qpCap('claims', ['claims', 'kpis']) !== 0.5) return 'a widget never stretches';
    return true;
});

t('a ⅔ + ⅓ row is no gap; a ½ widget + ⅓ still is', function () {
    var main = page([]);
    if (_qpRowWhyNot(main, ['command', 'kpis'], null)) return 'command + kpis refused: ' + _qpRowWhyNot(main, ['command', 'kpis'], null);
    if (!_qpRowWhyNot(main, ['claims', 'kpis'], null)) return 'claims + kpis should leave a gap';
    var s = _qpShareIn(['kpis', 'command'], 'command');
    if (Math.abs(s - 2 / 3) > 1e-9) return 'command share ' + s;
    return true;
});

t('Add puts a ⅓-only widget on a full manager page with no gap', function () {
    var main = page(MANAGER);
    var rows = _qpCurrentRows(main).concat([{ items: ['kpis'], w: null }]);
    var out = _qpPairWidgets(main, rows);
    if (out.every(function (r) { return r.items.indexOf('kpis') === -1 || r.items.length === 1; })) return 'kpis still alone: ' + shown(main, out);
    return noGaps(main, out);
});

t('a second ⅓ widget joins without a gap', function () {
    var main = page([['feed', 'actions'], ['chart', 'leaderboard'], ['kpis', 'command']]);
    var out = _qpPairWidgets(main, _qpCurrentRows(main).concat([{ items: ['variance'], w: null }]));
    return noGaps(main, out);
});

t('dragging a widget onto any card edge of a full page makes room', function () {
    var main = page(MANAGER);
    var fails = [];
    ['kpis', 'claims'].forEach(function (id) {
        _qpDrag = { key: id, add: id };
        Array.from(main.querySelectorAll('.qp-cell')).forEach(function (cell) {
            var key = _qpKey(cell.firstElementChild);
            var rowEl = cell.parentElement;
            var t0 = { zone: 'left', key: key, row: Array.from(main.querySelectorAll(':scope > .qp-row')).indexOf(rowEl), beforeKey: key };
            var plan = _qpBumpPlan(main, { key: id, add: id }, t0);
            if (!plan) { fails.push(id + ' beside ' + key); return; }
            var g = noGaps(main, plan.rows);
            if (g !== true) fails.push(id + ' beside ' + key + ': ' + g);
            if (!/Moves (Up|Down)$/.test(plan.say)) fails.push(id + ' beside ' + key + ' says "' + plan.say + '"');
        });
    });
    _qpDrag = null;
    return fails.length ? fails.join('; ') : true;
});

t('a new-row slot takes a ⅓ widget when a card can join it', function () {
    var main = page(MANAGER);
    _qpDrag = { key: 'kpis', add: 'kpis' };
    var plan = _qpBumpPlan(main, { key: 'kpis', add: 'kpis' }, { zone: 'gap', before: null });
    _qpDrag = null;
    if (!plan) return 'refused';
    if (plan.keys.length < 2) return 'kpis alone: ' + shown(main, plan.rows);
    return noGaps(main, plan.rows);
});

t('the chart still never shares a row with two others', function () {
    var main = page(MANAGER);
    var plan = _qpBumpPlan(main, { key: 'kpis', add: 'kpis' }, { zone: 'right', key: 'chart', row: 1, beforeKey: 'leaderboard' });
    if (!plan) return 'refused';
    var bad = plan.rows.filter(function (r) { return r.items.indexOf('chart') !== -1 && r.items.length > 2; });
    return bad.length ? 'chart row: ' + shown(main, bad) : true;
});

// NEVER LOCKED OUT (Ethan, same day: he could not pull Need You — "Waiting On
// You" — out of B2B to make a card of its own).
var HIS_PAGE = [['feed', 'chart'], ['leaderboard', 'claims', 'actions'], ['b2b', 'command:ebay', 'command']];

t('a tab pulled out of B2B lands at every + slot and card edge', function () {
    var main = page(HIS_PAGE);
    var drag = { fam: 'b2b', piece: 'need', from: 'b2b' };
    var fails = [];
    _qpDrag = drag;
    [0, 1, 2, null].forEach(function (b) {
        var plan = _qpBumpPlan(main, drag, { zone: 'gap', before: b });
        if (!plan) fails.push('slot ' + b);
        else if (noGaps(main, plan.rows) !== true) fails.push('slot ' + b + ': ' + noGaps(main, plan.rows));
    });
    Array.from(main.querySelectorAll(':scope > .qp-row')).forEach(function (rowEl, ri) {
        Array.from(rowEl.querySelectorAll('.qp-cell')).forEach(function (cell) {
            var key = _qpKey(cell.firstElementChild);
            var plan = _qpBumpPlan(main, drag, { zone: 'left', key: key, row: ri, beforeKey: key });
            if (!plan) fails.push('beside ' + key);
            else if (plan.key !== 'b2b:need') fails.push('placed as ' + plan.key);
            else if (noGaps(main, plan.rows) !== true) fails.push('beside ' + key + ': ' + noGaps(main, plan.rows));
        });
    });
    _qpDrag = null;
    return fails.length ? fails.join('; ') : true;
});

t('the last resort re-fits a page nothing simpler can', function () {
    var main = page([]);
    // Three ⅓-only widgets and two ½ ones in an order no row of neighbours fits.
    var rows = _qpRepack(main, ['kpis', 'claims', 'variance', 'b2b', 'monthly', 'feed']);
    if (!rows) return 'no fit found';
    return noGaps(main, rows);
});

// Every page a manager could build from these cards, every drawer widget not
// on it, every + slot and every card edge: the drop must land, with no gap.
t('sweep: no page leaves a widget nowhere to go', function () {
    var BUILT = ['feed', 'actions', 'command', 'chart', 'leaderboard'];
    var WIDGETS = ['claims', 'callbacks', 'b2b', 'connect', 'monthly', 'kpis', 'variance'];
    var seed = 7, rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    var fails = [];
    for (var n = 0; n < 60 && fails.length < 5; n++) {
        var on = WIDGETS.filter(function () { return rnd() < 0.4; });
        var cards = BUILT.concat(on).sort(function () { return rnd() - 0.5; });
        var start = _qpRepack(page([]), cards);
        if (!start) continue;
        var main = page(start.map(function (r) { return r.items; }));
        WIDGETS.filter(function (w) { return on.indexOf(w) === -1; }).forEach(function (id) {
            var drag = { key: id, add: id };
            _qpDrag = drag;
            var tries = [{ zone: 'gap', before: null }, { zone: 'gap', before: 0 }];
            Array.from(main.querySelectorAll(':scope > .qp-row')).forEach(function (rowEl, ri) {
                Array.from(rowEl.querySelectorAll('.qp-cell')).forEach(function (cell) {
                    var key = _qpKey(cell.firstElementChild);
                    tries.push({ zone: 'left', key: key, row: ri, beforeKey: key });
                });
            });
            tries.forEach(function (tt) {
                var plan = _qpBumpPlan(main, drag, tt);
                if (!plan) fails.push(id + ' ' + (tt.key || 'slot') + ' on ' + start.map(function (r) { return r.items.join('+'); }).join(' / '));
            });
        });
    }
    _qpDrag = null;
    return fails.length ? fails.slice(0, 5).join('; ') : true;
});

// KEEP ITS SIDE (Ethan, 2026-10-25): B2B was far left; recombining Waiting On
// You into it left B2B alone, and it was moved onto the RIGHT end of the
// Command Center row. A card that changes rows keeps its place from the left.
t('a card left alone keeps its side when it joins another row', function () {
    var main = page([['feed', 'chart'], ['command', 'command:ebay'], ['b2b']]);
    var out = _qpPairWidgets(main, _qpCurrentRows(main));
    var r = out.find(function (x) { return x.items.indexOf('b2b') !== -1; });
    if (r.items[0] !== 'b2b') return 'far-left B2B landed at ' + r.items.join('+');
    main = page([['feed', 'chart'], ['command', 'command:ebay'], ['actions', 'b2b']]);
    var rows = _qpCurrentRows(main);
    rows[2].items.shift();
    out = _qpPairWidgets(main, rows);
    r = out.find(function (x) { return x.items.indexOf('b2b') !== -1; });
    return r.items[0] === 'b2b' ? true : 'B2B (now alone) landed at ' + r.items.join('+');
});
