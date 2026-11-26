// DUE TODAY (RED) VS OPEN (AMBER) — Claims & Disputes, 2026-11-25.
//
//   powershell -File scripts/browser-check.ps1 claims-urgency-check.js -Html workspace.html
//
// claims-disputes decides each item's `urgency` ('today' | 'open' | null, see
// urgencyOf there) and `due_day`; the morning mail splits on the same field.
// These checks are about what the tab draws for it: the list split, the card
// edge, the section bar, and the tab badge colour. -Html for the real badges.
//
// Network stubbed once at the top (see CLAUDE.md).
window.fetch = function () { return Promise.reject(new Error('network blocked in browser-check')); };

function mm(key, o) {
    return Object.assign({
        issue_key: key, store_code: 'OVL', direction: 'ebay_only', ebay_order_id: key, amount: 10,
        reversed_at: '2026-11-01T00:00:00Z', state: 'due', state_note: null, review: null, dm: null, history: [],
    }, o || {});
}
function text(html) { var d = document.createElement('div'); d.innerHTML = html; return d.textContent.replace(/\s+/g, ' '); }
function setData(list) {
    _holdData.mgr = { stores: ['OVL'], today: '2026-11-25', timers: { mismatch: 3 }, mismatches: list, cases: [], disputes: [], payments: [] };
    _holdView.mgr = { store: '', show: 'due', kind: '' };
    _holdIndex.mgr = [];
}

t('Due Today comes first, then Open — Due Later, soonest first', function () {
    var list = [
        mm('A', { urgency: 'open', due_day: '2026-12-04' }),
        mm('B', { urgency: 'today', due_day: '2026-11-25' }),
        mm('C', { urgency: 'open', due_day: '2026-11-27' }),
    ];
    setData(list);
    var s = text(_holdList('mgr', 'mismatch', list, {}));
    var iT = s.indexOf('Due Today'), iO = s.indexOf('Open — Due Later');
    if (iT < 0 || iO < 0) return 'missing a heading: ' + s.slice(0, 200);
    if (!(iT < iO)) return 'Open is above Due Today';
    var iB = s.indexOf('B'), iC = s.indexOf(' C ') >= 0 ? s.indexOf(' C ') : s.indexOf('C');
    var heads = s.slice(iO);
    return heads.indexOf('C') < heads.indexOf('A') || 'open list not soonest first';
});

t('nothing due today says so instead of a blank red section', function () {
    var list = [mm('A', { urgency: 'open', due_day: '2026-12-04' })];
    setData(list);
    var s = text(_holdList('mgr', 'mismatch', list, {}));
    return /Nothing due today/.test(s) || s.slice(0, 160);
});

t('all due today: no sub-headings, just the cards (as before)', function () {
    var list = [mm('A', { urgency: 'today' }), mm('B', { urgency: 'today' })];
    setData(list);
    var s = text(_holdList('mgr', 'mismatch', list, {}));
    return !/Open — Due Later|Due Today/.test(s) || 'headings drawn when nothing is open';
});

t('card edge: red for today, amber for open', function () {
    setData([]);
    var r = _holdCard('mgr', 'mismatch', mm('A', { urgency: 'today' }), false, {}, {});
    var a = _holdCard('mgr', 'mismatch', mm('B', { urgency: 'open', due_day: '2026-12-01' }), false, {}, {});
    if (r.indexOf('inset 3px 0 0 ' + _HOLD_C.red.solid) < 0) return 'today card has no red edge';
    if (a.indexOf('inset 3px 0 0 ' + _HOLD_C.amber.solid) < 0) return 'open card has no amber edge';
    return a.indexOf(_HOLD_C.red.solid) < 0 || 'open card still carries red';
});

t('an answer without urgency (older server) reads as due today', function () {
    return _holdUrgency(mm('A')) === 'today' && _holdUrgency(mm('B', { state: 'checked' })) === null
        || 'fallback wrong';
});

t('badge: red count of today; amber count when only open', function () {
    var b = document.getElementById('hold-mgr-badge-mismatch');
    if (!b) return 'no #hold-mgr-badge-mismatch (run with -Html workspace.html)';
    setData([mm('A', { urgency: 'today' }), mm('B', { urgency: 'open', due_day: '2026-12-01' })]);
    _holdPaintBadges('mgr');
    if (b.textContent !== '1') return 'red badge should count 1 due today, got ' + b.textContent;
    if (!/red-alert/.test(b.style.background)) return 'badge not red: ' + b.style.background;
    setData([mm('B', { urgency: 'open', due_day: '2026-12-01' }), mm('C', { urgency: 'open', due_day: '2026-12-02' })]);
    _holdPaintBadges('mgr');
    if (b.textContent !== '2' || b.style.display === 'none') return 'amber badge should show 2 open, got "' + b.textContent + '"';
    return !/red-alert/.test(b.style.background) || 'open-only badge is still red';
});

t('section bar is amber when the group only has open items', function () {
    var h = _holdSectionHead('X', [mm('B', { urgency: 'open' })]);
    return h.indexOf(_HOLD_C.amber.solid) >= 0 || 'no amber bar';
});

t('QuickPortal counts go by due_day (eBay date), not due_on', function () {
    var c = _qpClaimsCounts([{ x: mm('A', { due_on: '2026-11-25', due_day: '2026-11-30', urgency: 'open' }) }], '2026-11-25');
    return c.now === 0 || 'an open return due Nov 30 counted as Today';
});

// Ethan's example, 2026-11-25: Returns with 1 due and others open shows a red 1;
// Cases & Disputes with nothing due and 2 open shows an amber 2.
t('per tab: Returns red 1 with others open, Cases amber 2 when only open', function () {
    var br = document.getElementById('hold-mgr-badge-returns'), bc = document.getElementById('hold-mgr-badge-cases');
    if (!br || !bc) return 'no badges (run with -Html workspace.html)';
    var ret = function (k, u) { return { case_key: 'return:' + k, store_code: 'OVL', kind: 'return', is_open: true,
        ebay_status: 'ITEM_DELIVERED', state: 'due', state_note: 'return_delivered', urgency: u }; };
    var inq = function (k) { return { case_key: 'inquiry:' + k, store_code: 'OVL', kind: 'inquiry', is_open: true,
        state: 'needs_reply', urgency: 'open', due_day: '2026-11-30' }; };
    _holdData.mgr = { stores: ['OVL'], mismatches: [], disputes: [], payments: [],
        cases: [ret('1', 'today'), ret('2', 'open'), ret('3', 'open'), inq('4'), inq('5')] };
    _holdPaintBadges('mgr');
    if (br.textContent !== '1' || !/red-alert/.test(br.style.background)) return 'returns: "' + br.textContent + '" ' + br.style.background;
    if (bc.textContent !== '2' || /red-alert/.test(bc.style.background)) return 'cases: "' + bc.textContent + '" ' + bc.style.background;
    return true;
});
