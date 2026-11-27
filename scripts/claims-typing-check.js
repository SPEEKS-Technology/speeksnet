// A NOTE BEING TYPED SURVIVES A REDRAW (2026-11-27) — see renderHoldItems.
//
//   powershell -File scripts/browser-check.ps1 claims-typing-check.js -Html workspace.html
//
// Ethan: "when typing, it'll sometimes just get rid of what I'm typing". The
// list redraws by itself when the background eBay read lands, so these draw,
// type, change the data (a card added ABOVE, so positions shift) and draw again.
// -Html for the real #hold-mgr-* / #hold-ov-confirm panels.

var _ttRole = sessionStorage.getItem('speeksUserRole');
var _ttName = sessionStorage.getItem('speeksUserName');
var _ttStore = sessionStorage.getItem('speeksUserStore');
window.fetch = function () { return Promise.reject(new Error('network blocked in browser-check')); };

function inr(key, o) {
    return Object.assign({
        case_key: key, store_code: 'BAL', kind: 'case', case_type: 'ITEM_NOT_RECEIVED', ebay_id: key,
        order_no: '24-15268-' + key.replace(/\D/g, ''), amount: 39.99, is_open: true, outcome: null, item_title: 'Lens ' + key,
        opened_at: '2026-11-20T00:00:00Z', state: 'due', state_note: null, review: null, dm: null, history: [],
    }, o || {});
}
function posOf(ctx, key) {
    return _holdIndex[ctx].findIndex(function (e) { return _holdKeyOf(e) === 'ebay_case|' + key; });
}

t('manager note survives a redraw that adds a card above it', function () {
    if (!document.getElementById('hold-mgr-cases')) return 'no #hold-mgr-cases (run with -Html workspace.html)';
    _holdData.mgr = { stores: ['BAL'], timers: { ebay_case: 2 }, cases: [inr('case:2')], mismatches: [], disputes: [], payments: [] };
    _holdOpenForm.mgr = { id: 'ebay_case|case:2', mode: 'status' };
    renderHoldItems('mgr');
    var i = posOf('mgr', 'case:2');
    var ta = document.getElementById('hold-note-mgr-' + i);
    if (!ta) return 'no note box drawn for case:2 (index ' + i + ')';
    ta.value = 'Buyer shipped it back, tracking 1Z99';
    // A hidden element can't take focus; the tool's panels start hidden.
    for (var el = ta; el; el = el.parentElement) if (el.style && el.style.display === 'none') el.style.display = 'block';
    ta.focus(); ta.setSelectionRange(5, 5);
    // Headless Chrome may not give the page focus at all; then only the text is checked.
    var canFocus = document.activeElement === ta;
    // The eBay read lands: a new case appears ahead of it.
    _holdData.mgr.cases = [inr('case:1', { opened_at: '2026-11-01T00:00:00Z' }), inr('case:2')];
    renderHoldItems('mgr');
    var j = posOf('mgr', 'case:2');
    var again = document.getElementById('hold-note-mgr-' + j);
    if (!again) return 'note box gone after redraw';
    if (again.value !== 'Buyer shipped it back, tracking 1Z99') return 'note lost: "' + again.value + '"';
    if (canFocus && document.activeElement !== again) return 'cursor not put back in the box';
    if (canFocus && again.selectionStart !== 5) return 'caret moved to ' + again.selectionStart;
    var other = document.getElementById('hold-note-mgr-' + posOf('mgr', 'case:1'));
    if (other && other.value) return 'note landed on the neighbouring card';
    return true;
});

t('a card that left the list takes its note with it, nothing else gets it', function () {
    _holdData.mgr.cases = [inr('case:1')];
    _holdOpenForm.mgr = { id: 'ebay_case|case:1', mode: 'status' };
    renderHoldItems('mgr');
    var ta = document.getElementById('hold-note-mgr-' + posOf('mgr', 'case:1'));
    return !ta || ta.value === '' || 'case:1 got "' + ta.value + '"';
});

t('DM send-back note survives a redraw', function () {
    if (!document.getElementById('hold-ov-confirm')) return 'no #hold-ov-confirm';
    var q = function (k) { return { type: 'ebay_case', key: k, review_key: k, store_code: 'BAL', state: 'dm_review', why: 'not in stock', resolved_by: 'Pat', resolved_note: 'Back in store', resolved_at: '2026-11-26T15:00:00Z', amount: 10 }; };
    _holdData.ov = { stores: ['BAL'], cases: [], mismatches: [], disputes: [], payments: [], dmQueue: [q('case:b')] };
    renderHoldItems('ov');
    document.getElementById('hold-dm-note-0').value = 'Call eBay and get the case number';
    _holdData.ov.dmQueue = [q('case:a'), q('case:b')];
    renderHoldItems('ov');
    var a = document.getElementById('hold-dm-note-0'), b = document.getElementById('hold-dm-note-1');
    if (!b || b.value !== 'Call eBay and get the case number') return 'lost: "' + (b && b.value) + '"';
    return a.value === '' || 'went to the wrong card';
});

t('put sessionStorage back', function () {
    [['speeksUserRole', _ttRole], ['speeksUserName', _ttName], ['speeksUserStore', _ttStore]].forEach(function (p) {
        if (p[1] == null) sessionStorage.removeItem(p[0]); else sessionStorage.setItem(p[0], p[1]);
    });
    return true;
});
