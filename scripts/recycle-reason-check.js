// RECYCLE REASON — the required reason dropdown and the review-tab filter.
//
//   powershell -File scripts/browser-check.ps1 recycle-reason-check.js -Html index.html
//
// Needs -Html: the dropdown and the filter are empty <select>s in the page's own
// markup that speeks.js fills, so the thing worth proving is that the real
// modal carries them and the renderer finds them there.
//
// The rule being guarded (Ethan, 2026-10-12): filtering by reason must make the
// totals adjust — every footer line is the total for that reason alone — on
// both the manager's and the DM's side of the tool.

var _sent = [];
window.fetch = function (url, opts) {
    _sent.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ success: true, data: [] }); } });
};

var _now = new Date();
var _m = function (d) { return new Date(_now.getFullYear(), _now.getMonth(), d).toISOString(); };
var ROWS = [
    { id: 'a', store: 'OVL', sku: 'A-1', reason: 'damaged', description: 'cracked', quantity: 1, cost: 40, created_by: 'X', created_at: _m(2), review_verdict: 'against', reviewed_at: _m(3) },
    { id: 'b', store: 'OVL', sku: 'B-1', reason: 'damaged', description: 'dead', quantity: 2, cost: 10, created_by: 'X', created_at: _m(2), review_verdict: 'for', reviewed_at: _m(3) },
    { id: 'c', store: 'LEE', sku: 'C-1', reason: 'low_value', description: 'cheap', quantity: 1, cost: 5, created_by: 'Y', created_at: _m(2), review_verdict: 'denied', reviewed_at: _m(3) },
    { id: 'd', store: 'LEE', sku: 'D-1', reason: 'poor_testing', description: 'flaky', quantity: 1, cost: 7, created_by: 'Y', created_at: _m(2) },
    { id: 'e', store: 'LEE', sku: 'E-1', reason: null, description: 'old row', quantity: 3, cost: 1, created_by: 'Y', created_at: _m(2) },
];

function _asRole(role, store) {
    sessionStorage.setItem('speeksUserRole', role);
    sessionStorage.setItem('speeksUserStore', store);
    sessionStorage.setItem('speeksUserName', 'Tester');
}
function _render(reason) {
    // The GET is store-scoped server-side, so a manager only ever holds their own
    // store's rows — mirror that or the manager test reads every store's money.
    var stores = _recycleStores();
    _recycleMine = ROWS.filter(function (r) { return stores.indexOf(r.store) !== -1; })
        .map(function (r) { return Object.assign({}, r); });
    _recycleQuery = '';
    _recycleReportPreviewing = false;
    _buildRecycleViewFilters(_recycleStores());
    var rs = document.getElementById('recycle-reason-filter');
    rs.value = reason || '';
    renderMyRecycleTable();
    return document.getElementById('recycle-table-wrap');
}
function _foot(wrap) { return wrap.querySelector('tfoot') ? wrap.querySelector('tfoot').textContent.replace(/\s+/g, ' ') : ''; }

t('the real modal carries the reason dropdown and the reason filter', function () {
    var m = document.getElementById('recycleInvModal');
    if (!m) return 'no recycleInvModal in the page';
    if (!m.querySelector('#recycleInvReason')) return 'no #recycleInvReason on New Request';
    if (!m.querySelector('#recycle-panel-view #recycle-reason-filter')) return 'no #recycle-reason-filter on the review tab';
    return true;
});

t('the dropdown opens on a placeholder, then the four reasons in order', function () {
    _buildRecycleReasonPicker();
    var sel = document.getElementById('recycleInvReason');
    var labels = [].map.call(sel.options, function (o) { return o.textContent; });
    if (sel.value !== '') return 'preselected ' + sel.value;
    var want = ['Poor Testing', 'Damaged/Broken', 'Low Value', 'Other'];
    return JSON.stringify(labels.slice(1)) === JSON.stringify(want) || 'options were ' + labels.join(' | ');
});

t('submitting without a reason is refused and nothing is sent', function () {
    _asRole('manager', 'OVL');
    _buildRecycleStorePicker();
    _buildRecycleReasonPicker();
    document.getElementById('recycleInvSku').value = 'X-1';
    document.getElementById('recycleInvQty').value = '1';
    document.getElementById('recycleInvCost').value = '5';
    document.getElementById('recycleInvDescription').value = 'note';
    var before = _sent.length;
    submitRecycleRequest();
    if (_sent.length !== before) return 'it posted without a reason';
    return true;
});

t('submitting with a reason sends the slug', function () {
    document.getElementById('recycleInvReason').value = 'low_value';
    var before = _sent.length;
    submitRecycleRequest();
    var p = _sent[before];
    if (!p) return 'nothing was posted';
    return (p.body.action === 'submit_request' && p.body.reason === 'low_value') || 'posted ' + JSON.stringify(p.body);
});

t('the note is still required alongside the reason', function () {
    _buildRecycleReasonPicker();
    document.getElementById('recycleInvSku').value = 'X-1';
    document.getElementById('recycleInvCost').value = '5';
    document.getElementById('recycleInvReason').value = 'other';
    document.getElementById('recycleInvDescription').value = '';
    var before = _sent.length;
    submitRecycleRequest();
    return _sent.length === before || 'it posted with an empty note';
});

t('DM: all reasons totals everything counted', function () {
    _asRole('district manager', 'CORP');
    // counted = 40 + 20 + 7 + 3 (denied 5 excluded) = 70
    var f = _foot(_render(''));
    return f.indexOf('$70.00') !== -1 || 'footer: ' + f;
});

t('DM: Damaged/Broken narrows every footer line to that reason', function () {
    var w = _render('damaged');
    var f = _foot(w);
    if (w.querySelectorAll('tbody tr').length !== 2) return w.querySelectorAll('tbody tr').length + ' rows, want 2';
    if (f.indexOf('$60.00') === -1) return 'headline should be $60.00: ' + f;
    if (f.indexOf('$40.00') === -1 || f.indexOf('$20.00') === -1) return 'against/for should be $40/$20: ' + f;
    if (f.indexOf('Damaged/Broken') === -1) return 'footer does not say which reason it is the total of: ' + f;
    if (/Denied/.test(f)) return 'a denied line from another reason leaked into the footer';
    return true;
});

t('DM: Low Value shows its denied line and a $0 counted total', function () {
    var f = _foot(_render('low_value'));
    return (f.indexOf('$0.00') !== -1 && /Denied/.test(f) && f.indexOf('$5.00') !== -1) || 'footer: ' + f;
});

t('older rows with no reason stay findable under "No reason (older)"', function () {
    var w = _render('none');
    var opt = [].some.call(document.getElementById('recycle-reason-filter').options, function (o) { return o.value === 'none'; });
    if (!opt) return 'no "none" option offered';
    var f = _foot(w);
    return (w.querySelectorAll('tbody tr').length === 1 && f.indexOf('$3.00') !== -1) || 'footer: ' + f;
});

t('Other with nothing filed shows the reason-specific empty state', function () {
    var w = _render('other');
    return /No .Other. recycle requests/.test(w.textContent) || 'got: ' + w.textContent.slice(0, 200);
});

t('manager side: the filter is there and totals adjust too', function () {
    _asRole('manager', 'LEE');
    var all = _foot(_render(''));
    var pt = _foot(_render('poor_testing'));
    // LEE counted: 7 + 3 = 10 (5 denied excluded); Poor Testing alone = 7
    if (all.indexOf('$10.00') === -1) return 'LEE all-reasons footer: ' + all;
    return pt.indexOf('$7.00') !== -1 || 'LEE Poor Testing footer: ' + pt;
});

t('the reason shows on the row as a tag', function () {
    _asRole('district manager', 'CORP');
    var w = _render('damaged');
    var chip = w.querySelector('.recycle-reason-chip');
    return (chip && chip.textContent === 'Damaged/Broken') || 'no Damaged/Broken tag on the row';
});
