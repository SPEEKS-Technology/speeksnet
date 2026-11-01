// RECYCLE "RECYCLED IN POS" — the manager-side tick on an approved line (0159).
//
//   powershell -File scripts/browser-check.ps1 recycle-pos-check.js -Html index.html -WindowSize 1440,900
//
// -WindowSize matters: at the default (phone) width .tbl-stack hides the header
// row and stacks each line into a card, so the column-shift test measures nothing.
//
// The rule being guarded (Ethan, 2026-10-28): the box appears only after the DM
// has ruled For or Against store, it stamps who ticked it, and it lives on the
// manager's side of the tool (the DM's review select is unchanged).

var _sent = [];
var _reply = { success: true };
window.fetch = function (url, opts) {
    _sent.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(_reply); } });
};

var _now = new Date();
var _m = function (d) { return new Date(_now.getFullYear(), _now.getMonth(), d).toISOString(); };
var ROWS = [
    { id: 'pend', store: 'OVL', sku: 'P-1', description: 'pending', quantity: 1, cost: 1, created_at: _m(2) },
    { id: 'agn',  store: 'OVL', sku: 'A-1', description: 'against', quantity: 1, cost: 1, created_at: _m(2), review_verdict: 'against', reviewed_at: _m(3) },
    { id: 'for',  store: 'OVL', sku: 'F-1', description: 'for',     quantity: 1, cost: 1, created_at: _m(2), review_verdict: 'for', reviewed_at: _m(3), pos_done_at: _m(4), pos_done_by: 'Sam ASM' },
    { id: 'den',  store: 'OVL', sku: 'D-1', description: 'denied',  quantity: 1, cost: 1, created_at: _m(2), review_verdict: 'denied', reviewed_at: _m(3) },
    { id: 'ign',  store: 'OVL', sku: 'I-1', description: 'ignore',  quantity: 1, cost: 1, created_at: _m(2), review_verdict: 'ignore', reviewed_at: _m(3) },
];

function _asRole(role) {
    sessionStorage.setItem('speeksUserRole', role);
    sessionStorage.setItem('speeksUserStore', 'OVL');
    sessionStorage.setItem('speeksUserName', 'Tester');
}
function _render() {
    _recycleMine = ROWS.map(function (r) { return Object.assign({}, r); });
    _recycleQuery = '';
    _recycleReportPreviewing = false;
    _buildRecycleViewFilters(_recycleStores());
    renderMyRecycleTable();
    return document.getElementById('recycle-table-wrap');
}
function _rowOf(wrap, sku) {
    return [].slice.call(wrap.querySelectorAll('tbody tr')).filter(function (tr) { return tr.textContent.indexOf(sku) !== -1; })[0];
}

t('manager: the box shows on For and Against lines only', function () {
    _asRole('manager');
    var wrap = _render();
    var want = { 'P-1': false, 'A-1': true, 'F-1': true, 'D-1': false, 'I-1': false };
    for (var sku in want) {
        var tr = _rowOf(wrap, sku);
        if (!tr) return 'no row for ' + sku;
        var has = !!tr.querySelector('.recycle-pos-box input[type=checkbox]');
        if (has !== want[sku]) return sku + ': box ' + (has ? 'shown' : 'missing');
    }
    return true;
});

t('manager: a ticked line is checked and shows who did it', function () {
    _asRole('manager');
    var tr = _rowOf(_render(), 'F-1');
    if (!tr.querySelector('.recycle-pos-box input').checked) return 'not checked';
    var by = tr.querySelector('.recycle-pos-by');
    if (!by || by.textContent.indexOf('Sam ASM') === -1) return 'no stamp: ' + (by && by.textContent);
    var tr2 = _rowOf(_render(), 'A-1');
    if (tr2.querySelector('.recycle-pos-box input').checked) return 'unticked line rendered checked';
    if (tr2.querySelector('.recycle-pos-by')) return 'unticked line has a stamp';
    return true;
});

t('DM view has no POS box (unchanged)', function () {
    _asRole('district manager');
    var wrap = _render();
    return wrap.querySelector('.recycle-pos-box') ? 'box shown on the DM side' : true;
});

// Ticking must not move a single column. The stamp ("Jurell Guild · Oct 28") is
// wider than the checkbox label, and in a nowrap cell it used to widen the Status
// column the moment the box was ticked, shoving everything to its right over
// (Ethan, 2026-10-28). Measured against the real styles.css at desktop width.
t('ticking does not shift any column', function () {
    _asRole('manager');
    var wrap = document.getElementById('recycle-table-wrap');
    var host = document.createElement('div');
    host.style.cssText = 'position:absolute; left:0; top:0; width:1200px; background:#fff;';
    var parent = wrap.parentNode, next = wrap.nextSibling;
    host.appendChild(wrap); document.body.appendChild(host);
    try {
        var now = new Date().toISOString();
        var cols = function (done) {
            _recycleMine = [{ id: 'z', store: 'OVL', sku: 'Z-1', description: 'x', quantity: 1, cost: 1, created_at: now,
                review_verdict: 'against', reviewed_at: now, pos_done_at: done ? now : null, pos_done_by: done ? 'Jurell Guild' : null }];
            _recycleQuery = ''; _recycleReportPreviewing = false;
            renderMyRecycleTable();
            return [].slice.call(wrap.querySelectorAll('thead th')).map(function (th) { return Math.round(th.getBoundingClientRect().left); }).join(',');
        };
        var before = cols(false), after = cols(true);
        if (before.replace(/0|,/g, '') === '') return 'table did not lay out: ' + before;
        if (before !== after) return 'columns moved: ' + before + ' -> ' + after;
        var by = wrap.querySelector('.recycle-pos-by');
        if (!by || by.getBoundingClientRect().width < 40) return 'stamp collapsed: ' + (by && by.getBoundingClientRect().width);
        return true;
    } finally { parent.insertBefore(wrap, next); host.remove(); }
});

// Every Review dropdown in the DM's column is one width, whatever it currently
// says. On desktop the .tbl-stack td is a content-sized table-cell, and _ddFit's
// min(want, 100%) floor resolved to nothing there, so each box shrank to its own
// label — "Against Store" wide, "Ignore" narrow (Ethan, 2026-10-28).
t('DM review dropdowns are all the same width', function () {
    _asRole('district manager');
    var wrap = document.getElementById('recycle-table-wrap');
    var host = document.createElement('div');
    host.style.cssText = 'position:absolute; left:0; top:0; width:1200px; background:#fff;';
    var parent = wrap.parentNode, next = wrap.nextSibling;
    host.appendChild(wrap); document.body.appendChild(host);
    try {
        var now = new Date().toISOString();
        _recycleMine = ['against', 'ignore', 'for', 'denied', ''].map(function (v, i) {
            return { id: 'w' + i, store: 'OVL', sku: 'W-' + i, description: 'x', quantity: 1, cost: 1, created_at: now,
                review_verdict: v || null, reviewed_at: v ? now : null };
        });
        _recycleQuery = ''; _recycleReportPreviewing = false;
        renderMyRecycleTable();
        // The page swaps each <select> for a .dd-host face from an observer, after
        // this function returns. A native select is already as wide as its longest
        // option, so measuring before the swap passes with or without the bug.
        _ddScan(wrap);
        var ws = [].slice.call(wrap.querySelectorAll('.recycle-review-cell')).map(function (c) {
            var el = c.querySelector('.dd-btn');
            if (!el) return 'no .dd-btn=0';
            return el.textContent.trim() + '=' + Math.round(el.getBoundingClientRect().width);
        });
        var nums = ws.map(function (x) { return +x.split('=').pop(); });
        if (nums.length !== 5 || !nums[0]) return 'did not lay out: ' + ws.join(', ');
        return nums.every(function (n) { return n === nums[0]; }) || 'widths differ: ' + ws.join(', ');
    } finally { parent.insertBefore(wrap, next); host.remove(); }
});

// Async — kept last: the runner does not wait for it before the next t(), and
// a later test re-rendering _recycleMine would pull the row out from under it.
t('ticking posts set_pos_done with the user and patches the row', function () {
    _asRole('manager');
    _render();
    _sent = [];
    _reply = { success: true, data: { pos_done_at: _m(5), pos_done_by: 'Tester' } };
    return setRecyclePosDone('agn', true, null).then(function () {
        var b = _sent[0] && _sent[0].body;
        if (!b || b.action !== 'set_pos_done' || b.id !== 'agn' || b.done !== true || b.by !== 'Tester') return 'bad payload ' + JSON.stringify(b);
        var row = _recycleMine.filter(function (r) { return r.id === 'agn'; })[0];
        if (row.pos_done_by !== 'Tester') return 'row not patched';
        var tr = _rowOf(document.getElementById('recycle-table-wrap'), 'A-1');
        if (!tr.querySelector('.recycle-pos-box input').checked) return 'not re-rendered checked';
        return true;
    });
});
