// PICTURE QUALITY RECHECK ON THE ROW — the states Ethan asked for 2026-10-16.
//
//   powershell -File scripts/browser-check.ps1 pq-recheck-check.js
//
// While Recheck runs only the buttons change — "Checking…" and Dismiss, both
// disabled; no greyed row (tried and taken back the same day). Afterwards it
// stays in its slot in the tab it was pressed from — "✓ Passed On Recheck" over
// the old, struck-through findings, or "Rechecked — Still Needs:" over the new
// ones. All of it lives in _pqPlaces.rechecked, so a reload clears it ("a
// passed on recheck row should go away after a refresh").

function pqFake(id, verdict, text) {
    return { productId: id, sku: 'SKU-' + id, title: 'Listing ' + id, verdict: verdict, sheetName: 'RAM',
             reviewedAt: '2026-10-16T13:00:00Z', photos: [], findings: [{ code: 'framing', text: text || 'Photo 1 is turned.' }] };
}
function pqReset(rows) {
    _ecStore = 'OVL';
    _pqPlaces = { store: null, order: new Map(), done: new Map(), rechecked: new Map() };
    _pqData = { queue: rows, shop: 'x.myshopify.com' };
    _pqPlace('retake', rows); _pqPlace('fix', rows); _pqPlace('pass', rows);
}

t('while checking, only the buttons change: Checking… and Dismiss, both disabled, on every tab that has Recheck', function () {
    var bad = [];
    ['retake', 'fix'].forEach(function (v) {
        _pqChecking.add('A'); _pqBusy.add('A');
        var h = _pqRow(pqFake('A', v), null, null);
        _pqChecking.delete('A'); _pqBusy.delete('A');
        var d = document.createElement('div'); d.innerHTML = h;
        var btns = [].slice.call(d.querySelectorAll('.pq-acts button'));
        var chk = btns.find(function (b) { return b.textContent.trim() === 'Checking…'; });
        var dis = btns.find(function (b) { return b.textContent.trim() === 'Dismiss'; });
        if (!chk || !chk.disabled || !dis || !dis.disabled) bad.push(v + ': buttons');
        if (/pq-row-checking|pq-reviewing|Reviewing The Photos/.test(h)) bad.push(v + ': greyed row is back');
    });
    return bad.length ? bad.join('; ') : true;
});

t('a pass stays in its slot in the tab it was pressed from, as it was', function () {
    var before = pqFake('A', 'retake', 'Old finding');
    pqReset([before, pqFake('B', 'retake')]);
    _pqPlaces.rechecked.set('A', { tier: 'retake', before: before, verdict: 'pass', at: new Date() });
    _pqData.queue = [Object.assign({}, before, { verdict: 'pass', findings: [] }), pqFake('B', 'retake')];
    var p = _pqPlace('retake', _pqData.queue);
    if (p.map(function (x) { return x.r.productId; }).join() !== 'A,B') return 'order ' + p.map(function (x) { return x.r.productId; }).join();
    var h = _pqRow(p[0].r, p[0].done, p[0].rc);
    return (h.indexOf('Passed On Recheck') >= 0 && h.indexOf('pq-why-fixed') >= 0 && h.indexOf('Old finding') >= 0
        && h.indexOf('pq-row-passed') >= 0) || 'pass row markup wrong';
});

t('a still-flagged recheck that changed verdict stays in its own tab, with the new findings', function () {
    var before = pqFake('A', 'retake', 'Old finding');
    pqReset([before]);
    _pqPlaces.rechecked.set('A', { tier: 'retake', before: before, verdict: 'fix', at: new Date() });
    _pqData.queue = [pqFake('A', 'fix', 'New finding')];
    var inRetake = _pqPlace('retake', _pqData.queue), inFix = _pqPlace('fix', _pqData.queue);
    if (inRetake.length !== 1 || inFix.length !== 0) return 'retake ' + inRetake.length + ', fix ' + inFix.length;
    var h = _pqRow(inRetake[0].r, inRetake[0].done, inRetake[0].rc);
    return (h.indexOf('Still Needs') >= 0 && h.indexOf('New finding') >= 0 && h.indexOf('pq-why-fixed') < 0) || 'still-needs markup wrong';
});

t('a reload (fresh _pqPlaces) drops the passed row', function () {
    var before = pqFake('A', 'retake');
    var rows = [Object.assign({}, before, { verdict: 'pass', findings: [] })];
    pqReset(rows);
    return _pqPlace('retake', rows).length === 0 || 'passed row still shown after reset';
});
