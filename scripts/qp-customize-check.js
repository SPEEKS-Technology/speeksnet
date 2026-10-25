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
