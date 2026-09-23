// CLAIMS & DISPUTES — the Mismatches / eBay Cases tabs (0102, 0103, claims-disputes).
//
//   powershell -File scripts/browser-check.ps1 claims-disputes-check.js -Html operations.html
//
// Needs -Html: half of these assert that the tabs and panels the renderer
// writes into actually exist in the page's markup, in both the manager modal
// and the DM oversight modal.
//
// Fixtures are shaped like the live claims-disputes list response for OVL on
// 2026-09-22, INCLUDING the server's `state` — the front end draws state, it
// never derives it (see the section banner in speeks.js), so these check that
// each state renders right rather than re-testing the rule. The rule itself is
// in the edge function's stateOf.

// Network is blocked in the harness; record instead. Stubbed once, at the top
// (see b2b-check.js for why never per-test).
var _posts = [];
window.fetch = function (url, opts) {
    _posts.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ success: true, swept: {} }); } });
};
sessionStorage.setItem('speeksUserStore', 'OVL');
sessionStorage.setItem('speeksUserName', 'Harness Manager');

var DAY = 86400000;
var ago = function (d) { return new Date(Date.now() - d * DAY).toISOString(); };
var ahead = function (d) { return new Date(Date.now() + d * DAY).toISOString(); };

function fixture() {
    return {
        success: true, rollout: ['OVL'], stores: ['OVL'], today: '2026-09-22', monthEnd: false,
        timers: { mismatch: 3, ebay_case: 2, dispute: 3 },
        waiting: { mismatch: 0, ebay_case: 4, dispute: 0 },
        sync: [{ store_code: 'OVL', synced_at: ago(0.01), ok: true, detail: 'return ok; inquiry ok; casemanagement ok; detail ok (34)' }],
        disputeSync: [
            { store_code: 'OVL', source: 'shopify', synced_at: ago(0.01), ok: true, detail: '11 read' },
            { store_code: 'OVL', source: 'ebay', synced_at: ago(0.01), ok: true, detail: '4 read' },
        ],
        // Shaped like the live 2026-09-23 read: Shopify chargebacks nobody had
        // answered, one eBay dispute whose response window had already shut, and
        // one contested in time.
        disputes: [
            { dispute_key: 'shopify:15012200614', source: 'shopify', external_id: '15012200614', store_code: 'OVL',
              order_no: '#MO02-6573', amount: 199.99, currency: 'USD', dispute_type: 'CHARGEBACK',
              reason: 'PRODUCT_UNACCEPTABLE', reason_code: '13.3', status_raw: 'NEEDS_RESPONSE',
              is_open: true, needs_response: true, response_overdue: false, responded_at: null,
              opened_at: ago(15), respond_by: ahead(4), review: null, history: [], state: 'needs_reply', due_on: '2026-09-23' },
            { dispute_key: 'shopify:10902732957', source: 'shopify', external_id: '10902732957', store_code: 'OVL',
              order_no: '#MO04-2728', amount: 109.99, currency: 'USD', dispute_type: 'CHARGEBACK',
              reason: 'PRODUCT_UNACCEPTABLE', status_raw: 'NEEDS_RESPONSE',
              is_open: true, needs_response: true, response_overdue: false, responded_at: null,
              opened_at: ago(8), respond_by: ahead(1), review: null, history: [], state: 'needs_reply', due_on: '2026-09-23' },
            // nobody answered and the window shut: still unanswered, but responding is no longer the fix
            { dispute_key: 'ebay:5010444789', source: 'ebay', external_id: '5010444789', store_code: 'OVL',
              order_no: '01-15084-49541', amount: 459.99, currency: 'USD', dispute_type: 'CHARGEBACK',
              reason: 'FRAUD', status_raw: 'OPEN', seller_response: 'SELLER_RESPONSE_OVERDUE',
              is_open: true, needs_response: true, response_overdue: true, responded_at: null,
              // what the server sends once the window has shut (0113)
              missed_window: true, state_note: 'missed_window',
              opened_at: ago(20), respond_by: null, review: null, history: [], state: 'needs_reply', due_on: '2026-09-23' },
            { dispute_key: 'ebay:5010537350', source: 'ebay', external_id: '5010537350', store_code: 'OVL',
              order_no: '22-14693-60794', amount: 114.99, currency: 'USD', dispute_type: 'CHARGEBACK',
              reason: 'SIGNIFICANTLY_NOT_AS_DESCRIBED', status_raw: 'OPEN', seller_response: 'SELLER_CONTEST',
              is_open: true, needs_response: false, response_overdue: false, responded_at: ago(1),
              opened_at: ago(1), respond_by: ahead(5), review: null, history: [], state: 'answered', due_on: null },
            { dispute_key: 'shopify:9887580262', source: 'shopify', external_id: '9887580262', store_code: 'OVL',
              order_no: '#KS01-5180', amount: 349.99, currency: 'USD', dispute_type: 'CHARGEBACK',
              reason: 'FRAUDULENT', status_raw: 'WON', is_open: false, needs_response: false, response_overdue: false,
              responded_at: ago(40), opened_at: ago(60), closed_at: ago(3), outcome: 'won',
              review: null, history: [], state: 'settled', due_on: null },
        ],
        claims: [
            { id: 'c-279', store: 'OVL', case_number: 'SHP9D-082626130855', price: 279.99, reason_type: 'Shopify Claim — Loss', status: 'recovered', created_at: '2026-08-26T12:00:00Z' },
            { id: 'c-1000', store: 'OVL', case_number: 'SHPJG-070926200022', price: 1000, reason_type: 'Shopify Claim — Damage', status: 'recovered', created_at: '2026-07-10T12:00:00Z' },
        ],
        mismatches: [
            { issue_key: 'OVL:05-14978-78547:ebay_only', store_code: 'OVL', ebay_order_id: '05-14978-78547', direction: 'ebay_only',
              reversed_at: '2026-08-26T15:00:00Z', reversal_kind: 'refund', amount: 279.99, times_alerted: 7, resolved_at: null,
              review: null, history: [], state: 'due', due_on: '2026-08-29' },
            { issue_key: "OVL:08-1'5042:shopify_only", store_code: 'OVL', ebay_order_id: "08-1'5042", direction: 'shopify_only',
              reversed_at: ago(12), reversal_kind: 'refund', amount: 239.99, times_alerted: 1, resolved_at: null,
              review: { status: 'resolved', note: 'Won Shopify insurance claim SHPJG-0709, money recovered', by_name: 'Nick', updated_at: ago(1) },
              history: [{ action: 'resolved', by_name: 'Nick', at: ago(1), note: 'Won claim' }, { action: 'still_open', by_name: 'Nick', at: ago(4) }],
              state: 'resolved', due_on: null },
            { issue_key: 'OVL:25-15154:shopify_only', store_code: 'OVL', ebay_order_id: '25-15154', direction: 'shopify_only',
              reversed_at: ago(10), reversal_kind: 'cancel', amount: 84.99, times_alerted: 0, resolved_at: ago(0.2), review: null, history: [],
              state: 'settled', due_on: null },
            { issue_key: 'OVL:01-1:ebay_only', store_code: 'OVL', ebay_order_id: '01-1', direction: 'ebay_only',
              reversed_at: ago(5), reversal_kind: 'cancel', amount: 50, times_alerted: 0, resolved_at: null,
              review: { status: 'still_open', note: 'Waiting on buyer', by_name: 'Nick', updated_at: ago(1) }, history: [],
              state: 'checked', due_on: '2026-09-24' },
        ],
        cases: [
            { case_key: 'return:5329126806', store_code: 'OVL', kind: 'return', ebay_id: '5329126806', order_id: '05-14978-78547',
              item_id: '358821835141', buyer: 'starrywishesboutique', reason: 'REMORSE · WRONG_SIZE', ebay_status: 'ITEM_READY_TO_SHIP / READY_FOR_SHIPPING',
              is_open: true, amount: 159.92, opened_at: ago(8), respond_by: ahead(1), review: null, history: [], state: 'due', due_on: '2026-09-16' },
            // refunded INR, eBay ruled against us — the one with a hand-filed claim
            { case_key: 'case:5384751302', store_code: 'OVL', kind: 'case', case_type: 'ITEM_NOT_RECEIVED', ebay_id: '5384751302',
              order_id: '358000000001-10080000000001', item_id: '358000000001', is_open: false, amount: 279.99, opened_at: '2026-08-16T10:00:00Z',
              ebay_status: 'CLOSED', outcome: 'refunded', outcome_detail: 'eBay ruled for the buyer', review: null, history: [],
              state: 'needs_claim', due_on: '2026-09-22', claim: null },
            // refunded INR with no claim anywhere
            { case_key: 'inquiry:5385009994', store_code: 'OVL', kind: 'inquiry', ebay_id: '5385009994', order_id: '358000000002-10080000000002',
              is_open: false, amount: 89.99, opened_at: '2026-08-14T10:00:00Z', ebay_status: 'CLOSED', outcome: 'refunded',
              outcome_detail: 'Voluntary refund completed 2026-08-18', review: null, history: [], state: 'needs_claim', due_on: '2026-09-22', claim: null },
            // INR whose claim is open
            { case_key: 'inquiry:1', store_code: 'OVL', kind: 'inquiry', ebay_id: '1', is_open: true, amount: 40, opened_at: ago(6),
              ebay_status: 'WAITING_BUYER_RESPONSE', review: null, history: [], state: 'covered', due_on: null,
              claim: { id: 'c-x', case_number: 'SHPX-1', status: 'in_progress' } },
            // escalated return, closed
            { case_key: 'case:5386807520', store_code: 'OVL', kind: 'case', case_type: 'RETURN', ebay_id: '5386807520', is_open: false,
              amount: 84.99, opened_at: ago(8), closed_at: ago(8), ebay_status: 'CS_CLOSED', outcome: 'no_refund', review: null, history: [],
              state: 'settled', due_on: null, claim: null },
        ],
    };
}
function load(ctx, show) {
    _holdData[ctx] = fixture();
    _holdView[ctx] = { store: '', show: show || 'due' };
    _holdOpenForm[ctx] = null;
    renderHoldItems(ctx);
}
var html = function (id) { return document.getElementById(id).innerHTML; };

// --- markup ------------------------------------------------------------------
t('manager modal has all four tabs and their panels', function () {
    var miss = ['view', 'mismatch', 'returns', 'cases'].filter(function (x) {
        return !document.getElementById('claims-tab-' + x) || !document.getElementById('claims-panel-' + x);
    });
    if (miss.length) return 'missing tab/panel: ' + miss.join(', ');
    // the New Claim panel is still there; only its tab is gone
    if (!document.getElementById('claims-panel-new')) return 'the New Claim panel went missing';
    return !document.getElementById('claims-tab-new') || 'the New Claim tab is back — it should be a button on the list';
});
t('oversight modal keeps the claims body inside its Claims panel', function () {
    var ids = ['ov-tab-claims', 'ov-panel-claims', 'ov-panel-mismatch', 'ov-panel-cases', 'hold-ov-mismatch', 'hold-ov-cases', 'claims-oversight-body'];
    var miss = ids.filter(function (id) { return !document.getElementById(id); });
    if (miss.length) return 'missing: ' + miss.join(', ');
    return document.getElementById('ov-panel-claims').contains(document.getElementById('claims-oversight-body')) || 'oversight body moved';
});
t('New Claim no longer offers Item Not Received — INRs come from eBay now', function () {
    var opts = [].slice.call(document.querySelectorAll('#claim-reason option')).map(function (o) { return o.value; });
    if (!opts.length) return 'claim-reason select missing';
    return opts.indexOf('Item Not Received') < 0 || 'still offered: ' + opts.join(', ');
});
t('the tool is renamed in both headers and the menu', function () {
    var titles = [].slice.call(document.querySelectorAll('#claimsModal .tool-head-title, #claimsOversightModal .tool-head-title'))
        .map(function (e) { return e.textContent.trim(); });
    if (titles.length !== 2 || titles.some(function (x) { return x !== 'Claims & Disputes'; })) return 'titles: ' + titles.join(' | ');
    var copy = document.body.cloneNode(true);
    [].slice.call(copy.querySelectorAll('script')).forEach(function (s) { s.remove(); });
    return !/Insurance Claims/.test(copy.innerHTML) || '"Insurance Claims" still appears in the markup';
});

// --- rollout -------------------------------------------------------------------
t('rollout: a live store gets its lists, not the waiting line', function () {
    load('mgr');
    var bad = ['mismatch', 'returns', 'cases'].filter(function (t2) {
        var h = html('hold-mgr-' + t2);
        return h.indexOf('switched on') >= 0 || h.indexOf('Refresh') < 0;
    });
    return !bad.length || 'a live store got the waiting line on: ' + bad.join();
});

// --- views ---------------------------------------------------------------------
t('Needs attention shows due + needs-claim only, and never a checked-in one', function () {
    load('mgr');
    var m = html('hold-mgr-mismatch'), c = html('hold-mgr-cases');
    if (m.indexOf('05-14978-78547') < 0) return 'due mismatch missing';
    if (m.indexOf('>01-1<') >= 0) return 'a checked-in mismatch is on the Needs attention list';
    if (m.indexOf('25-15154') >= 0 || m.indexOf("08-1") >= 0) return 'a settled/resolved mismatch is on it';
    if (c.indexOf('5384751302') < 0 || c.indexOf('5385009994') < 0) return 'refunded INRs missing';
    if (c.indexOf('SHPX-1') >= 0) return 'an INR covered by an open claim is on it';
    return html('hold-mgr-returns').indexOf('5329126806') >= 0 || 'the due return is not listed';
});
t('Checked in view shows the check-in and when it comes back', function () {
    load('mgr', 'waiting');
    var m = html('hold-mgr-mismatch');
    if (m.indexOf('>01-1<') < 0) return 'checked-in mismatch missing';
    if (m.indexOf('back on the list Sep 24') < 0) return 'return date missing or read as UTC: ' + (m.match(/back on the list[^<]*/) || ['none'])[0];
    return html('hold-mgr-cases').indexOf('SHPX-1') >= 0 || 'covered INR should show its claim here';
});
t('the "shows once it has been open N days" line is gone', function () {
    load('mgr');
    var both = html('hold-mgr-cases') + html('hold-mgr-mismatch');
    return !/Shows once it has been open/.test(both) || 'the timeframe line is still there';
});
// Two views only (Ethan, 2026-09-22). A resolved item still has to be reachable
// to be reopened, so it sits in the second view; a settled one drops off.
t('there are two views, named as Ethan asked, and neither is the old Resolved one', function () {
    load('mgr');
    var labels = Object.keys(_HOLD_VIEWS).map(function (k) { return _HOLD_VIEWS[k].label; });
    if (labels.join(' | ') !== 'Needs Attention | Status Changed/Claim Open') return 'views are: ' + labels.join(' | ');
    return !_HOLD_VIEWS.closed || 'the resolved/settled view is still there';
});
t('a resolved item keeps its reason and its Reopen, in the second view', function () {
    load('mgr', 'waiting');
    var m = html('hold-mgr-mismatch');
    if (m.indexOf('Won Shopify insurance claim SHPJG-0709') < 0) return 'resolution reason not shown';
    if (m.indexOf('Resolved by Nick') < 0) return 'resolver not shown';
    return /Reopen/.test(m) || 'resolved item has no Reopen';
});
// The finished ones fold away; the ones still moving stay in the open list
// (Ethan, 2026-09-22). A settled item is in this view at all because linking an
// already-recovered claim settles an item at once, and it used to vanish.
t('the second view folds the finished ones into a Resolved dropdown', function () {
    load('mgr', 'waiting');
    var m = html('hold-mgr-mismatch');
    var cut = m.indexOf('<details style="margin-top:14px;"');
    if (cut < 0) return 'no Resolved dropdown';
    var open = m.slice(0, cut), folded = m.slice(cut);
    if (folded.indexOf('Resolved (2)') < 0) return 'the dropdown does not count the finished ones';
    if (open.indexOf('>01-1<') < 0) return 'the checked-in one is not in the open list';
    if (open.indexOf('25-15154') >= 0) return 'a settled one is in the open list';
    if (folded.indexOf('25-15154') < 0) return 'the settled one is not in the dropdown';
    return folded.indexOf("08-1'5042") >= 0 || 'the resolved one is not in the dropdown';
});

// --- INR ---------------------------------------------------------------------
t('INR titles: inquiry, escalated INR and escalated return read differently', function () {
    load('mgr');
    var due = html('hold-mgr-cases');
    if (due.indexOf('Item not received — escalated to eBay') < 0) return 'escalated INR title missing';
    if (due.indexOf('>Item not received<') < 0) return 'inquiry title missing';
    // A settled escalated return is no longer listed anywhere, so the wording is
    // asserted on the namer itself.
    return _holdCaseTitle({ kind: 'case', case_type: 'RETURN' }) === 'Return — escalated to eBay'
        || 'escalated return reads: ' + _holdCaseTitle({ kind: 'case', case_type: 'RETURN' });
});
t('a refunded INR says so, and offers a claim — not Resolve', function () {
    load('mgr');
    var c = html('hold-mgr-cases');
    if (c.indexOf('The buyer was refunded') < 0) return 'refund banner missing';
    if (c.indexOf('Open or link a claim') < 0) return 'no claim action';
    var card = c.slice(c.indexOf('5385009994') - 3000, c.indexOf('5385009994') + 3000);
    return card.indexOf('Update status') < 0 || 'a refunded INR offers Update status (it can only be closed by a claim)';
});
t('claim form: the same-amount claim is offered first as the likely match', function () {
    load('mgr');
    var i = _holdIndex.mgr.findIndex(function (e) { return e.it.case_key === 'case:5384751302'; });
    _holdToggleForm('mgr', i, 'claim');
    i = _holdIndex.mgr.findIndex(function (e) { return e.it.case_key === 'case:5384751302'; });
    var sel = document.getElementById('hold-link-mgr-' + i);
    if (!sel) return 'no link picker';
    if (sel.options[0].value !== 'c-279') return 'first option is ' + sel.options[0].text;
    return /Likely match/.test(sel.options[0].text) || 'first option not marked as the likely match';
});
t('claim form: no false match for an INR with no same-amount claim', function () {
    load('mgr');
    var i = _holdIndex.mgr.findIndex(function (e) { return e.it.case_key === 'inquiry:5385009994'; });
    _holdToggleForm('mgr', i, 'claim');
    i = _holdIndex.mgr.findIndex(function (e) { return e.it.case_key === 'inquiry:5385009994'; });
    var box = html('hold-mgr-cases');
    if (!document.getElementById('hold-cl-mgr-' + i + '-num')) return 'open-a-claim fields missing';
    if (document.getElementById('hold-cl-mgr-' + i + '-value').value !== '89.99') return 'value not prefilled from the INR';
    return box.indexOf('Likely match') < 0 || 'a $1000 / $279.99 claim was offered as a match for $89.99';
});
t('Link claim posts the INR key and the chosen claim', function () {
    load('mgr');
    var i = _holdIndex.mgr.findIndex(function (e) { return e.it.case_key === 'case:5384751302'; });
    _holdToggleForm('mgr', i, 'claim');
    i = _holdIndex.mgr.findIndex(function (e) { return e.it.case_key === 'case:5384751302'; });
    var before = _posts.length;
    _holdLinkClaim('mgr', i);
    var p = _posts[before];
    return (p && p.body.action === 'link_claim' && p.body.item_type === 'ebay_case' && p.body.item_key === 'case:5384751302' && p.body.claim_id === 'c-279' && p.body.by_name === 'Harness Manager')
        || 'posted ' + JSON.stringify(p && p.body);
});
t('Save claim needs a claim number, then posts the claim fields', function () {
    load('mgr');
    var i = _holdIndex.mgr.findIndex(function (e) { return e.it.case_key === 'inquiry:5385009994'; });
    _holdToggleForm('mgr', i, 'claim');
    i = _holdIndex.mgr.findIndex(function (e) { return e.it.case_key === 'inquiry:5385009994'; });
    var before = _posts.length;
    _holdOpenClaim('mgr', i);
    if (_posts.length !== before) return 'posted without a claim number';
    document.getElementById('hold-cl-mgr-' + i + '-num').value = '9400-TEST';
    document.getElementById('hold-cl-mgr-' + i + '-reason').value = 'USPS Claim';
    _holdOpenClaim('mgr', i);
    var b = (_posts[before] || {}).body || {};
    return (b.action === 'open_claim' && b.item_key === 'inquiry:5385009994' && b.case_number === '9400-TEST'
        && b.reason_type === 'USPS Claim — Loss' && b.price === 89.99) || 'posted ' + JSON.stringify(b);
});

// --- actions -------------------------------------------------------------------
t('Resolved without a reason is refused before anything is sent', function () {
    load('mgr');
    _holdToggleForm('mgr', 0, 'status');
    var ta = document.getElementById('hold-note-mgr-0');
    if (!ta) return 'update form did not open';
    ta.value = 'ok';
    var before = _posts.length;
    _holdSave('mgr', 0, 'resolved');
    return _posts.length === before || 'a reasonless resolution was posted';
});
t('Resolved with a reason posts key, status, note and name', function () {
    load('mgr');
    _holdToggleForm('mgr', 0, 'status');
    document.getElementById('hold-note-mgr-0').value = 'Refunded Shopify #OV01-1234 today';
    var before = _posts.length;
    _holdSave('mgr', 0, 'resolved');
    var b = (_posts[before] || {}).body || {};
    return (b.action === 'review' && b.item_type === 'mismatch' && b.item_key === 'OVL:05-14978-78547:ebay_only'
        && b.status === 'resolved' && /OV01-1234/.test(b.note) && b.by_name === 'Harness Manager') || 'posted ' + JSON.stringify(b);
});
t('Still open may be sent with no note', function () {
    load('mgr');
    _holdToggleForm('mgr', 0, 'status');
    var before = _posts.length;
    _holdSave('mgr', 0, 'still_open');
    var p = _posts[before];
    return (p && p.body.status === 'still_open') || 'still_open was not posted';
});
t('a key with a quote in it cannot break the buttons', function () {
    load('mgr', 'waiting');
    var btns = document.getElementById('hold-mgr-mismatch').querySelectorAll('button[onclick]');
    var bad = [].slice.call(btns).filter(function (b) { return /'/.test(b.getAttribute('onclick').replace(/'(mgr|status|claim)'/g, '')); });
    return !bad.length || 'an onclick carries raw text: ' + bad[0].getAttribute('onclick');
});

t('switchClaimsTab shows exactly one panel, and Save Claim only on New Claim', function () {
    switchClaimsTab('mismatch');
    var shown = ['new', 'view', 'mismatch', 'cases'].filter(function (x) {
        return document.getElementById('claims-panel-' + x).style.display !== 'none';
    });
    if (shown.join() !== 'mismatch') return 'visible panels: ' + shown.join();
    return document.getElementById('submitClaimBtn').style.display === 'none' || 'Save Claim shows on Mismatches';
});

// --- layout ------------------------------------------------------------------
t('layout: cards and the claim form never scroll sideways at phone width', function () {
    var box = document.createElement('div');
    box.style.cssText = 'width:358px; position:absolute; left:0; top:0;';
    document.body.appendChild(box);
    try {
        _holdData.mgr = fixture(); _holdIndex.mgr = [];
        _holdOpenForm.mgr = { id: 'ebay_case|case:5384751302', mode: 'claim' };
        var all = ['due', 'waiting'].map(function (v) {
            _holdView.mgr = { store: '', show: v };
            return _holdList('mgr', 'mismatch', _holdData.mgr.mismatches, {}) + _holdList('mgr', 'ebay_case', _holdData.mgr.cases, null);
        }).join('');
        box.innerHTML = all;
        if (box.scrollWidth > 359) return 'list is ' + box.scrollWidth + 'px wide in a 358px box';
        var wide = [].slice.call(box.querySelectorAll('div')).filter(function (c) { return c.scrollWidth > c.clientWidth + 1 && c.clientWidth > 0; });
        return !wide.length || wide.length + ' element(s) overflow, first: ' + wide[0].outerHTML.slice(0, 120);
    } finally { box.remove(); load('mgr'); }
});

// --- matches Seller Hub (OVL, 2026-09-22 screenshots) ---------------------------
// eBay stores its deadlines as end-of-day Pacific (06:59:59Z the next morning).
// Seller Hub said "Issue refund by: Sep 23" for respond_by 2026-09-24T06:59:59Z,
// and "Resolve by Sep 24" for an inquiry's 2026-09-25T07:00:00Z.
t('deadlines print as the Pacific day Seller Hub shows', function () {
    var a = _holdEbayDay('2026-09-24T06:59:59.000Z'), b = _holdEbayDay('2026-09-25T07:00:00.000Z');
    return (a === 'Sep 23' && b === 'Sep 24') || 'got ' + a + ' / ' + b + ', want Sep 23 / Sep 24';
});
t('return wording follows the status the way Seller Hub words it', function () {
    var w = function (st) { var x = _holdReturnAction({ ebay_status: st }); return x.text + (x.ours ? '*' : ''); };
    var got = [w('ITEM_DELIVERED / ITEM_DELIVERED'), w('RETURN_LABEL_PENDING / WAITING_FOR_RETURN_LABEL'),
               w('ITEM_READY_TO_SHIP / READY_FOR_SHIPPING'), w('ITEM_SHIPPED / ITEM_SHIPPED')].join(' | ');
    var want = 'Return delivered — issue refund by* | Provide return shipping label by* | Waiting for buyer to ship | Return shipped';
    return got === want || 'got ' + got;
});
t('a return card leads with the item title, decoded, and its deadline', function () {
    var f = fixture();
    f.cases[0].item_title = '2026 Apple MacBook Neo 13&#34; A18 Pro';
    f.cases[0].ebay_status = 'ITEM_DELIVERED / ITEM_DELIVERED';
    f.cases[0].respond_by = '2026-09-24T06:59:59.000Z';
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var c = html('hold-mgr-returns');
    // innerHTML serialises a quote inside text as a bare ", so that is what a
    // decoded-then-escaped title reads back as.
    if (c.indexOf('MacBook Neo 13" A18 Pro') < 0) return 'title missing or not decoded';
    if (c.indexOf('&amp;#34;') >= 0) return 'entity shown to the manager';
    return c.indexOf('Return delivered — issue refund by Sep 23') >= 0 || 'deadline line missing';
});
t('an inquiry says Request ID and hides the legacy item-transaction order id', function () {
    load('mgr');
    var c = html('hold-mgr-cases');
    if (c.indexOf('Request ID') < 0) return 'no Request ID label';
    return c.indexOf('358000000002-10080000000002') < 0 || 'legacy order id shown as an order number';
});

// --- an escalated return is one card (0104) -------------------------------------
// The server folds the return into the case eBay opened for it; the card shows
// both ids, the Seller Hub order number from the return, and links the return.
t('an escalated return shows as one card carrying both ids and the real order number', function () {
    var f = fixture();
    f.cases = [{
        case_key: 'case:5386454189', store_code: 'OVL', kind: 'case', case_type: 'RETURN', ebay_id: '5386454189',
        order_id: '358800976266-10083162811525', item_id: '358800976266', item_title: 'Touch Dynamic Edge Ultra 22&#34;',
        is_open: true, ebay_status: 'OPEN', amount: 774.99, opened_at: '2026-09-08T12:00:00Z', respond_by: null,
        state: 'due', due_on: '2026-08-31', history: [],
        'return': { case_key: 'return:5327924452', ebay_id: '5327924452', order_id: '07-14822-45851', amount: 774.99, opened_at: '2026-08-29T12:00:00Z' }
    }];
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var c = html('hold-mgr-cases');
    var miss = ['Case ID', '5386454189', 'Return ID', '5327924452', '07-14822-45851', 'ReturnDetails?returnId=5327924452', 'Return opened', 'Escalated']
        .filter(function (s) { return c.indexOf(s) < 0; });
    if (miss.length) return 'missing: ' + miss.join(', ');
    return c.indexOf('358800976266-10083162811525') < 0 || 'legacy order id shown as an order number';
});

// --- the tab row (Ethan, 2026-09-22) ------------------------------------------
// Equal widths are measured further down, with the modal forced visible — here
// it is only the air Ethan asked for between the tabs and the panel under them.
t('the tab row keeps air above the panel', function () {
    var row = document.querySelector('.claims-tabs');
    if (!row) return 'no .claims-tabs row in the page markup';
    var pad = parseInt((row.parentElement.style.padding || '').split(' ')[2] || '0', 10);
    return pad >= 18 || 'only ' + pad + 'px under the tabs';
});
t('the tool uses the site palette, not its own red and green', function () {
    var bad = [_HOLD_STATE.due.fg, _HOLD_STATE.due.bg, _HOLD_STATE.resolved.fg, _HOLD_STATE.resolved.bg]
        .filter(function (c) { return ['#b91c1c', '#fee2e2', '#047857', '#d1fae5'].indexOf(c) >= 0; });
    if (bad.length) return 'still on the old palette: ' + bad.join(', ');
    var badge = document.getElementById('hold-mgr-badge-cases');
    return badge.getAttribute('style').indexOf('var(--red-alert)') >= 0 || 'the badge is not the site red';
});

// --- a mismatch only stays open for an insurance claim (Ethan, 2026-09-22) ------
t('a mismatch offers Insurance Claim, never a bare Still open', function () {
    load('mgr');
    _holdToggleForm('mgr', 0, 'status');
    var m = html('hold-mgr-mismatch');
    if (m.indexOf('Insurance Claim') < 0) return 'no Insurance Claim button';
    if (/>Still open</.test(m)) return 'a mismatch still offers Still open';
    if (m.indexOf('_holdInsuranceClaim(') < 0) return 'the button does not call _holdInsuranceClaim';
    return /Mark resolved/.test(m) || 'Mark resolved is gone';
});
t('an eBay case keeps Still open — only returns lose the check-in', function () {
    var f = fixture();
    f.cases = [{ case_key: 'case:99', store_code: 'OVL', kind: 'case', case_type: 'RETURN', ebay_id: '99',
                 is_open: true, ebay_status: 'OPEN', amount: 50, opened_at: ago(6), review: null, history: [],
                 state: 'due', due_on: '2026-09-16' }];
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    _holdToggleForm('mgr', _holdIndex.mgr.length - 1, 'status');
    var c = html('hold-mgr-cases');
    if (c.indexOf('Insurance Claim') >= 0) return 'an eBay case offers the mismatch button';
    return />Still open</.test(c) || 'no Still open on an eBay case';
});

// Nothing may be written before the claim is saved: closing the form used to
// leave the mismatch checked in as though a claim existed (Ethan, 2026-09-22).



t('a mismatch with a claim shows the claim and offers no status buttons', function () {
    var f = fixture();
    f.mismatches = [f.mismatches[0]];   // on its own, or a neighbour's buttons answer for it
    f.mismatches[0].state = 'covered';
    f.mismatches[0].claim = { id: 'c-279', case_number: 'SHP9D-082626130855', status: 'in_progress' };
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'waiting' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var m = html('hold-mgr-mismatch');
    if (m.indexOf('SHP9D-082626130855') < 0) return 'the claim is not on the card';
    if (/Update status|Insurance Claim/.test(m)) return 'a claimed mismatch still offers a status change';
    return /Check-ins happen on the claim/.test(m) || 'does not say the claim took over';
});

t('the card no longer counts the emails, and the toolbar drops the rollout line', function () {
    load('mgr');
    var m = html('hold-mgr-mismatch'), c = html('hold-mgr-cases');
    if (/Emailed/.test(m)) return 'the email count is still on the card';
    return !/added one at a time|Live for/.test(m + c) || 'the rollout line is still there';
});


// --- Returns stand apart from cases (Ethan, 2026-09-22) ------------------------
t('returns list on their own tab; INRs and escalations stay with the cases', function () {
    load('mgr');
    var r = html('hold-mgr-returns'), c = html('hold-mgr-cases');
    if (r.indexOf('5329126806') < 0) return 'the open return is not on the Returns tab';
    if (c.indexOf('5329126806') >= 0) return 'the return is also on Cases';
    if (c.indexOf('5384751302') < 0 || c.indexOf('5385009994') < 0) return 'the INRs are not with the cases';
    return r.indexOf('5384751302') < 0 || 'an INR landed on the Returns tab';
});
t('each tab counts only its own badge', function () {
    load('mgr');
    var m = document.getElementById('hold-mgr-badge-mismatch').textContent;
    var r = document.getElementById('hold-mgr-badge-returns').textContent;
    var c = document.getElementById('hold-mgr-badge-cases').textContent;
    // Cases counts its own 2 PLUS the 3 unanswered disputes, because disputes
    // are worked on that tab (0112) — a badge that ignored them would be quiet
    // about the most expensive thing on it.
    return (m === '1' && r === '1' && c === '5') || 'badges ' + m + '/' + r + '/' + c + ', want 1/1/5';
});
t('switchClaimsTab still shows exactly one panel, Returns included', function () {
    switchClaimsTab('returns');
    var shown = ['new', 'view', 'mismatch', 'returns', 'cases'].filter(function (x) {
        return document.getElementById('claims-panel-' + x).style.display !== 'none';
    });
    return shown.join() === 'returns' || 'visible panels: ' + shown.join();
});
t('the oversight modal has the same four tabs and panels', function () {
    var miss = ['claims', 'mismatch', 'returns', 'cases'].filter(function (x) {
        return !document.getElementById('ov-tab-' + x) || !document.getElementById('ov-panel-' + x);
    });
    return !miss.length || 'missing: ' + miss.join(', ');
});
t('the claim card says Check-ins with a capital C', function () {
    var f = fixture();
    f.mismatches = [f.mismatches[0]];
    f.mismatches[0].state = 'covered';
    f.mismatches[0].claim = { id: 'c-279', case_number: 'SHP9D-082626130855', status: 'in_progress' };
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'waiting' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    return html('hold-mgr-mismatch').indexOf('— Check-ins happen on the claim') >= 0 || 'still lower-case';
});

// The mismatch's claim form lives on the card, like an INR's (Ethan, 2026-09-22:
// "much cleaner than a second popup"), and nothing is written until it is saved.
t('Insurance Claim opens the claim form on the card and writes nothing', function () {
    load('mgr');
    _holdToggleForm('mgr', 0, 'status');
    var before = _posts.length;
    _holdInsuranceClaim('mgr', 0);
    if (_posts.length !== before) return 'it posted ' + JSON.stringify(_posts[before].body);
    var m = html('hold-mgr-mismatch');
    if (m.indexOf('hold-cl-mgr-0-num') < 0) return 'the claim form did not open on the card';
    return /linked to this mismatch/.test(m) || 'the form does not say it links to the mismatch';
});
t('saving it opens the claim against the mismatch, in one call', function () {
    load('mgr');
    _holdToggleForm('mgr', 0, 'claim');
    document.getElementById('hold-cl-mgr-0-num').value = 'SHPTEST-1';
    var before = _posts.length;
    _holdOpenClaim('mgr', 0);
    var b = (_posts[before] || {}).body || {};
    return (b.action === 'open_claim' && b.item_type === 'mismatch' && b.item_key === 'OVL:05-14978-78547:ebay_only'
        && b.case_number === 'SHPTEST-1') || 'posted ' + JSON.stringify(b);
});
// A parcel that turns up after the buyer was refunded is eBay's to give back.
t('a delivered refunded INR says so, and can be resolved without a claim', function () {
    var f = fixture();
    f.cases = [f.cases[1]];
    f.cases[0].tracking_status = 'DELIVERED';
    f.cases[0].tracking_carrier = 'UPS';
    f.cases[0].tracking_number = '1ZKE76310312244230';
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var c = html('hold-mgr-cases');
    if (c.indexOf('>Delivered') < 0) return 'the delivered status is not shown';
    if (c.indexOf('1ZKE76310312244230') < 0) return 'no tracking number';
    if (c.indexOf('eBay covers a delivered item-not-received') < 0) return 'does not say eBay covers it';
    return /Delivered — Resolve it/.test(c) || 'no way to resolve it without a claim';
});
t('an open return is listed but not worked, newest stage first', function () {
    var f = fixture();
    var mk = function (id, st, days) {
        return { case_key: 'return:' + id, store_code: 'OVL', kind: 'return', ebay_id: id, is_open: true,
                 ebay_status: st, amount: 10, opened_at: ago(days), review: null, history: [], state: 'due', due_on: '2026-09-16' };
    };
    f.cases = [mk('r1', 'RETURN_LABEL_PENDING / WAITING_FOR_RETURN_LABEL', 1), mk('r2', 'ITEM_DELIVERED / ITEM_DELIVERED', 2),
               mk('r3', 'ITEM_READY_TO_SHIP / READY_FOR_SHIPPING', 3), mk('r4', 'ITEM_SHIPPED / ITEM_SHIPPED', 4)];
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var r = html('hold-mgr-returns');
    var order = ['r2', 'r4', 'r3', 'r1'].map(function (x) { return r.indexOf('>' + x + '<'); });
    if (order.some(function (x) { return x < 0; })) return 'a return is missing: ' + order.join();
    for (var i = 1; i < order.length; i++) if (order[i] < order[i - 1]) return 'wrong order: delivered, shipped, not shipped, needs label';
    if (/Update status|Check-in due/.test(r)) return 'a return still offers a check-in';
    return !/Needs Attention/.test(r) || 'the returns tab still has the view dropdown';
});
t('no "Read from eBay" line on any tab', function () {
    load('mgr');
    var all = html('hold-mgr-returns') + html('hold-mgr-cases') + html('hold-mgr-mismatch');
    return !/Read from eBay/.test(all) || 'the read-time line is still there';
});
t('the item number is gone; a case shows the order number instead', function () {
    var f = fixture();
    f.cases[1].order_no = '05-14978-78547';
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var c = html('hold-mgr-cases') + html('hold-mgr-returns');
    if (/Item 3588/.test(c)) return 'the item number is still on the card';
    return c.indexOf('05-14978-78547') >= 0 || 'the order number is not shown';
});

// --- who gets which of the two tools (Ethan, 2026-09-22) -----------------------
t('a DM, the CEO and the MOCD land in the oversight tool; a manager in their own', function () {
    var opened = [];
    var realOv = window.openClaimsOversight, realMgr = window.openClaimsModal;
    var realOvTab = window.switchOversightTab, realMgrTab = window.switchClaimsTab;
    window.openClaimsOversight = function () { opened.push('ov'); };
    window.openClaimsModal = function () { opened.push('mgr'); };
    window.switchOversightTab = function (t) { opened.push('ov:' + t); };
    window.switchClaimsTab = function (t) { opened.push('mgr:' + t); };
    try {
        ['CEO', 'District Manager', 'MOCD', 'Manager', 'Store'].forEach(function (role) {
            sessionStorage.setItem('speeksUserRole', role);
            openClaimsTool('mismatch');
        });
        var got = opened.join(' ');
        var want = 'ov ov:mismatch ov ov:mismatch ov ov:mismatch mgr mgr:mismatch mgr mgr:mismatch';
        return got === want || 'got: ' + got;
    } finally {
        sessionStorage.setItem('speeksUserRole', 'Manager');
        window.openClaimsOversight = realOv; window.openClaimsModal = realMgr;
        window.switchOversightTab = realOvTab; window.switchClaimsTab = realMgrTab;
    }
});
t('the Claims tab is where "view" lands for both', function () {
    var seen = [];
    var realOv = window.openClaimsOversight, realOvTab = window.switchOversightTab;
    window.openClaimsOversight = function () {}; window.switchOversightTab = function (t) { seen.push(t); };
    try {
        sessionStorage.setItem('speeksUserRole', 'CEO');
        openClaimsTool('view');
        return seen.join() === 'claims' || 'oversight opened on ' + seen.join();
    } finally {
        sessionStorage.setItem('speeksUserRole', 'Manager');
        window.openClaimsOversight = realOv; window.switchOversightTab = realOvTab;
    }
});
// The buyer has already been refunded on a needs-claim INR, so asking whether we
// are about to refund them reads as a second refund (Ethan, 2026-09-22).
t('a refunded INR does not ask whether we are refunding the buyer', function () {
    var f = fixture();
    f.cases = [f.cases[1]];
    f.cases[0].tracking_status = 'DELIVERED';
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' };
    _holdOpenForm.mgr = { id: 'ebay_case|case:5384751302', mode: 'status' };
    renderHoldItems('mgr');
    var open = html('hold-mgr-cases');
    if (/Refunding the buyer\?/.test(open)) return 'it still asks about refunding the buyer';
    // with the form open that same button reads "Close", so check it shut
    _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var shut = html('hold-mgr-cases');
    if (shut.indexOf('Delivered — Resolve it') < 0) return 'the delivered button lost its capital';
    return /— Even though the buyer was refunded/.test(shut) || 'the delivered note lost its capital';
});



// Measured, not asserted about strings. flex:1 1 0 inside a max-content row is a
// trap: the row comes out the SUM of the natural label widths, so every tab gets
// the AVERAGE one, and "Cases & Disputes" then wrote itself out past the grey bar
// (Ethan, 2026-09-22 — it spilled 27px here). Grid sizes each 1fr track to the
// widest label instead. The modal is hidden until it is opened, so everything up
// the chain has to be forced visible first — measuring it as-is reads all zeros
// and passes anything.
t('every tab is the same width and none spills out of the row', function () {
    var row = document.getElementById('ov-tab-claims').parentElement;
    for (var el = row; el && el !== document.documentElement; el = el.parentElement) {
        var cs = getComputedStyle(el);
        if (cs.display === 'none') el.style.setProperty('display', 'block', 'important');
        if (cs.visibility === 'hidden') el.style.setProperty('visibility', 'visible', 'important');
        if (cs.opacity === '0') el.style.setProperty('opacity', '1', 'important');
    }
    var tabs = ['claims', 'mismatch', 'returns', 'cases'].map(function (t) {
        var b = document.getElementById('ov-tab-' + t);
        b.style.display = '';
        var badge = document.getElementById('hold-ov-badge-' + t);
        if (badge && t !== 'claims') { badge.textContent = '13'; badge.style.display = 'inline-block'; }
        return b;
    });
    if (!row.clientWidth) return 'measured nothing — the modal never became visible';
    var w = tabs.map(function (b) { return Math.round(b.getBoundingClientRect().width); });
    if (Math.max.apply(null, w) - Math.min.apply(null, w) > 1) return 'tab widths differ: ' + w.join('/');
    // scrollWidth/clientWidth, not rects: a label overflowing its own button is
    // invisible to the button's box but shows up here.
    return row.scrollWidth <= row.clientWidth
        || 'the labels spill ' + (row.scrollWidth - row.clientWidth) + 'px out of the row';
});

// The design ships now, the data store by store (Ethan, 2026-09-22). A manager at
// a store that is not switched on yet sees the same four tabs as everyone else,
// each saying what is coming — not a tab bar that grows a tab one morning.
t('the tabs are in the markup, not painted in once the server answers', function () {
    var hidden = ['mismatch', 'returns', 'cases'].filter(function (t) {
        return ['claims-tab-' + t, 'ov-tab-' + t].some(function (id) {
            var b = document.getElementById(id);
            return b && b.style.display === 'none';
        });
    });
    return !hidden.length || 'still hidden in the markup: ' + hidden.join();
});
t('a store that is not switched on gets the tabs and a line about it', function () {
    _holdData.mgr = { success: true, stores: [], mismatches: [], cases: [], sync: [] };
    _holdView.mgr = { store: '', show: 'due' };
    renderHoldItems('mgr');
    var want = {
        mismatch: 'Refund mismatches',
        returns: 'eBay returns',
        cases: 'eBay cases and disputes',
    };
    for (var t2 in want) {
        var h = html('hold-mgr-' + t2);
        if (h.indexOf(want[t2] + " aren't switched on") < 0) return t2 + ' tab does not say what is coming: ' + h.slice(0, 120);
        if (h.indexOf('Refresh') >= 0) return t2 + ' tab drew the toolbar for a store with no data';
    }
    // and the badges stay quiet rather than reading 0
    return document.getElementById('hold-mgr-badge-returns').style.display === 'none'
        || 'a badge showed for a store that is not switched on';
});

// Filing a claim is a button on the claims list, not a fifth tab (Ethan,
// 2026-09-22). Claims stays lit while the form is up, because Cancel and Save
// both land back on it.
t('New Claim is a button on the claims list, and Cancel comes back', function () {
    var btns = [].slice.call(document.querySelectorAll('#claims-panel-view button'))
        .filter(function (b) { return /New Claim/.test(b.textContent); });
    if (btns.length !== 1) return 'expected one New Claim button on the list, found ' + btns.length;
    if (!/startNewClaim/.test(btns[0].getAttribute('onclick') || '')) return 'the button does not open the form';

    startNewClaim();
    if (document.getElementById('claims-panel-new').style.display === 'none') return 'the form did not open';
    if (document.getElementById('claims-panel-view').style.display !== 'none') return 'the list stayed up behind the form';
    if (!document.getElementById('claims-tab-view').classList.contains('active')) return 'no tab is lit while the form is up';
    var cancel = document.getElementById('cancelClaimBtn');
    if (!cancel || cancel.style.display === 'none') return 'no way out of the form';
    if (document.getElementById('submitClaimBtn').style.display === 'none') return 'Save Claim is hidden on the form';

    switchClaimsTab('view');
    if (document.getElementById('claims-panel-new').style.display !== 'none') return 'Cancel left the form up';
    return document.getElementById('cancelClaimBtn').style.display === 'none'
        || 'Cancel/Save still show on the claims list';
});
t('a cancelled claim does not leave its typing in the next one', function () {
    startNewClaim();
    document.getElementById('claim-case-number').value = 'SHP-TYPED-IN-ERROR';
    document.getElementById('claim-price').value = '99.99';
    switchClaimsTab('view');
    startNewClaim();
    var left = ['claim-case-number', 'claim-price'].filter(function (id) {
        return document.getElementById(id).value !== '';
    });
    return !left.length || 'still filled in: ' + left.join();
});

// Cases & Disputes runs by what eBay is doing, not by our own state ranks
// (Ethan, 2026-09-22): escalated cases, then open INRs, then refunded ones
// needing a claim, then the delivered ones (which eBay pays back for the asking).
t('Cases & Disputes orders escalations, then open INRs, then delivered last', function () {
    var f = fixture();
    // an open escalated case, so every band is represented
    f.cases.push({ case_key: 'case:9999', store_code: 'OVL', kind: 'case', case_type: 'RETURN', ebay_id: '9999',
        is_open: true, amount: 100, opened_at: ago(3), ebay_status: 'CS_OPEN', review: null, history: [], state: 'due', due_on: '2026-09-20' });
    f.cases[2].tracking_status = 'DELIVERED';   // the $89.99 refunded INR
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var h = html('hold-mgr-cases');
    var at = function (id) { return h.indexOf(id); };
    var esc = at('9999'), openInr = at('>1<'), needs = at('5384751302'), delivered = at('5385009994');
    if (esc < 0 || needs < 0 || delivered < 0) return 'a band is missing from the list';
    if (esc > needs) return 'the escalated case is not first';
    if (needs > delivered) return 'the delivered INR is not last';
    return true;
});
// A delivered return is money we owe back, so its line is red whatever the
// deadline says — the two-day rule left one black and the next one red.
t('a delivered return reads red even when the deadline is days off', function () {
    var f = fixture();
    f.cases[0].ebay_status = 'ITEM_DELIVERED / ITEM_DELIVERED';
    f.cases[0].respond_by = ahead(6);           // well outside the two-day window
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var h = html('hold-mgr-returns');
    var i = h.indexOf('Return delivered');
    if (i < 0) return 'the delivered line is missing';
    var span = h.slice(h.lastIndexOf('<span', i), i);
    return span.indexOf(_HOLD_C.red.fg) >= 0 || 'the delivered line is not red: ' + span;
});

// ANSWER EBAY FIRST (0107, narrowed by 0108). A case eBay is waiting on cannot be
// CHECKED IN — and nobody can assert their way past it, because the "I responded"
// button was cut the day it shipped. Only eBay's own history clears it. Marking
// it resolved, with a reason, is still allowed.
function awaitingFixture() {
    var f = fixture();
    f.cases = [{
        case_key: 'case:5384957079', store_code: 'OVL', kind: 'case', case_type: 'RETURN', ebay_id: '5384957079',
        order_no: '24-14843-32595', item_title: 'Asus Custom PC Ryzen 5 5600X', is_open: true, amount: 799.99,
        opened_at: ago(40), respond_by: ago(8), ebay_status: 'OPEN', buyer_acted_at: ago(40), seller_replied_at: null,
        review: null, history: [], state: 'needs_reply', due_on: '2026-09-22', claim: null, awaiting_reply: true,
    }];
    return f;
}
t('a case eBay is waiting on says so, and offers no way to claim a reply', function () {
    _holdData.mgr = awaitingFixture(); _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var h = html('hold-mgr-cases');
    if (h.indexOf('eBay needs a reply from us') < 0) return 'the chip does not say eBay needs a reply from us';
    if (/responded/i.test(h)) return 'a self-certification button is back';
    if (h.indexOf('clears itself on the next read') < 0) return 'it does not say what actually clears it';
    return /Update status/.test(h) || 'there is no way to resolve it either';
});
t('its status form drops Still open and keeps Mark resolved', function () {
    _holdData.mgr = awaitingFixture(); _holdView.mgr = { store: '', show: 'due' };
    var idx = 0;
    renderHoldItems('mgr');
    idx = _holdIndex.mgr.findIndex(function (e) { return e.type === 'ebay_case' && e.it.case_key === 'case:5384957079'; });
    if (idx < 0) return 'the case never made it into the index';
    _holdOpenForm.mgr = { id: 'ebay_case|case:5384957079', mode: 'status' };
    renderHoldItems('mgr');
    var h = html('hold-mgr-cases');
    if (/'still_open'/.test(h)) return 'Still open is still offered';
    if (!/Mark resolved/.test(h)) return 'Mark resolved is gone';
    return /off the table until eBay shows our reply/.test(h) || 'it does not say why Still open is missing';
});
t('an answered case says so and goes back to the normal flow', function () {
    var f = awaitingFixture();
    f.cases[0].seller_replied_at = ago(1);
    f.cases[0].awaiting_reply = false;
    f.cases[0].state = 'due';
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var h = html('hold-mgr-cases');
    if (h.indexOf('We answered eBay') < 0) return 'it does not say we answered';
    // Scoped to THIS card: the tab legitimately holds other items that do need
    // a reply, so a whole-page regex here would only ever test the fixture.
    var card = cardAround(h, f.cases[0].ebay_id);
    if (!card) return 'the answered case is not listed';
    return !/needs a reply from us/.test(card) || 'it still reads as needing a reply from us';
});
t('an unanswered case outranks everything else on the tab', function () {
    var f = fixture();
    f.cases.push(awaitingFixture().cases[0]);
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var h = html('hold-mgr-cases');
    var first = h.indexOf('5384957079'), inr = h.indexOf('5385009994');
    if (first < 0) return 'the unanswered case is not listed';
    return (inr < 0 || first < inr) || 'the unanswered case is not first';
});

// --- payment disputes and chargebacks (0112) ---------------------------------
// The point of this layer is that a dispute nobody answers is lost by default,
// so most of these are about the tool refusing to let one look handled.

// The rendered card around a marker. Math.max is not decoration: slice() with a
// negative start counts from the END of the string, so a card near the top of
// the tab silently returned the wrong text and the test "failed" against
// perfectly good markup.
function cardAround(h, needle) {
    var i = h.indexOf(needle);
    return i < 0 ? '' : h.slice(Math.max(0, i - 3000), i + 2500);
}
// Is there a real SECTION HEADING for this label — not merely the words, which
// now also appear in the "Also on this tab" note at the bottom. Matching on the
// heading's own markup is the only way to tell the two apart.
function hasHeading(h, label) {
    return new RegExp('letter-spacing:\\.7px;[^>]*>' + label + '</span>').test(h);
}

t('disputes show on the Cases & Disputes tab, above the cases', function () {
    load('mgr');
    var h = html('hold-mgr-cases');
    if (h.indexOf('Shopify chargebacks') < 0) return 'no Shopify chargebacks heading';
    if (h.indexOf('eBay payment disputes') < 0) return 'no eBay payment disputes heading';
    var d = h.indexOf('#MO02-6573'), c = h.indexOf('eBay cases');
    if (d < 0) return 'the unanswered chargeback is not listed';
    return (c < 0 || d < c) || 'disputes are below the cases';
});

t('a Shopify chargeback names Shopify, not eBay', function () {
    load('mgr');
    var h = html('hold-mgr-cases');
    var card = cardAround(h, '#MO02-6573');
    if (!card) return 'the chargeback is not listed';
    // "needs a reply from us", not "is waiting on us" — the reply is ours, and
    // Ethan asked for the chip to say so (2026-09-23).
    if (!/Shopify needs a reply from us/.test(card)) return 'it does not say Shopify needs a reply from us';
    if (/is waiting on us/.test(card)) return 'the old passive wording is back';
    return !/eBay needs a reply from us/.test(card) || 'a Shopify chargeback is pointing at eBay';
});

t('an overdue dispute says the window shut, and does not promise responding fixes it', function () {
    load('mgr');
    var h = html('hold-mgr-cases');
    var card = cardAround(h, '01-15084-49541');
    if (!card) return 'the overdue dispute is not listed';
    // Renamed in 0113: "Missed reply window", Ethan's words, because eBay takes
    // no late reply and "overdue" sounds like something you can still catch up on.
    if (!/Missed reply window/.test(card)) return 'it is not labelled as a missed window';
    if (!/We missed the window to respond/.test(card)) return 'it does not explain that the window closed';
    return !/clears itself on the next read/.test(card) || 'it still claims responding will clear it';
});

t('an unanswered dispute cannot be checked in — no Still open button', function () {
    load('mgr');
    var idx = _holdIndex.mgr.findIndex(function (e) { return e.type === 'dispute' && e.it.needs_response; });
    if (idx < 0) return 'no unanswered dispute was rendered';
    _holdToggleForm('mgr', idx, 'status');
    var h = html('hold-mgr-cases');
    var form = h.slice(h.indexOf('hold-note-mgr-'));
    if (/>Still open</.test(form)) return 'Still open is offered on a dispute nobody answered';
    return />Mark resolved</.test(form) || 'Mark resolved is missing — a dispute settled another way has nowhere to go';
});

t('the server, not the button, is what refuses a check-in', function () {
    load('mgr');
    var idx = _holdIndex.mgr.findIndex(function (e) { return e.type === 'dispute' && e.it.needs_response; });
    var entry = _holdIndex.mgr[idx];
    _posts.length = 0;
    return _holdSave('mgr', idx, 'still_open').then(function () {
        var p = _posts.filter(function (x) { return x.body && x.body.action === 'review'; })[0];
        if (!p) return 'nothing was posted';
        if (p.body.item_type !== 'dispute') return 'posted item_type ' + p.body.item_type;
        return p.body.item_key === entry.it.dispute_key || 'posted the wrong key: ' + p.body.item_key;
    });
});

t('an answered dispute is out of Needs Attention and into Status Changed', function () {
    load('mgr', 'due');
    if (html('hold-mgr-cases').indexOf('22-14693-60794') >= 0) return 'an answered dispute is still in Needs Attention';
    load('mgr', 'waiting');
    var h = html('hold-mgr-cases');
    if (h.indexOf('22-14693-60794') < 0) return 'the answered dispute is in neither view';
    return /Answered — waiting on them/.test(h) || 'it does not say we are waiting on them';
});

t('a finished dispute folds into the Resolved dropdown', function () {
    load('mgr', 'waiting');
    var h = html('hold-mgr-cases');
    var i = h.indexOf('#KS01-5180');
    if (i < 0) return 'the won dispute is not listed';
    return h.lastIndexOf('<details', i) > h.lastIndexOf('</details>', i) || 'a settled dispute is not inside the fold';
});

t('the soonest deadline leads among the ones waiting on us', function () {
    load('mgr');
    var h = html('hold-mgr-cases');
    // #MO04-2728 is due tomorrow, #MO02-6573 in four days
    var soon = h.indexOf('#MO04-2728'), later = h.indexOf('#MO02-6573');
    if (soon < 0 || later < 0) return 'both chargebacks should be listed';
    return soon < later || 'the later deadline is listed first';
});

t('the tab badge counts unanswered disputes', function () {
    load('mgr');
    var n = _holdDueCounts('mgr');
    // three need a response in the fixture
    return n.cases >= 3 || 'cases badge is ' + n.cases + ', which cannot include the three unanswered disputes';
});

t('a dispute read failure names which site went quiet', function () {
    var f = fixture();
    f.disputeSync = [{ store_code: 'OVL', source: 'shopify', synced_at: ago(0.01), ok: false, detail: 'no Shopify credentials' }];
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var h = html('hold-mgr-cases');
    if (h.indexOf("Couldn't read disputes") < 0) return 'no dispute failure banner';
    return /Shopify for OVL/.test(h) || 'the banner does not name Shopify and the store';
});

t('no disputes at all means no headings, not an empty section', function () {
    var f = fixture();
    f.disputes = [];
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var h = html('hold-mgr-cases');
    return (h.indexOf('payment disputes') < 0 && h.indexOf('Shopify chargebacks') < 0)
        || 'an empty disputes heading is drawn anyway';
});

t('the Shopify link uses the shop handle, not the store code', function () {
    load('mgr');
    var h = html('hold-mgr-cases');
    var card = cardAround(h, '#MO02-6573');
    if (!/admin\.shopify\.com/.test(card)) return 'no Shopify admin link';
    if (/store\/ovl\//.test(card)) return 'it built the URL from the store code — that admin page does not exist';
    return /store\/paymore-overland-park\/payments\/disputes/.test(card)
        || 'link is not the shop handle disputes page';
});

t('each of the four kinds is named on its own card', function () {
    var f = fixture();
    // an escalated non-INR case, so all four kinds are present at once
    f.cases.push({ case_key: 'case:9999', store_code: 'OVL', kind: 'case', case_type: 'RETURN', ebay_id: '9999',
        is_open: true, amount: 100, opened_at: ago(3), ebay_status: 'CS_OPEN', review: null, history: [], state: 'due', due_on: '2026-09-20' });
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var h = html('hold-mgr-cases');
    var want = ['Chargeback', 'Payment dispute', 'Item not received', 'Case — escalated'];
    var missing = want.filter(function (w) { return h.indexOf(w) < 0; });
    return !missing.length || 'no chip says: ' + missing.join(', ');
});

t('the sections keep the order Ethan asked for: disputes, cases, then INRs', function () {
    var f = fixture();
    f.cases.push({ case_key: 'case:9999', store_code: 'OVL', kind: 'case', case_type: 'RETURN', ebay_id: '9999',
        is_open: true, amount: 100, opened_at: ago(3), ebay_status: 'CS_OPEN', review: null, history: [], state: 'due', due_on: '2026-09-20' });
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var h = html('hold-mgr-cases');
    var dis = h.indexOf('eBay payment disputes'), cases = h.indexOf('eBay cases'), inr = h.indexOf('Item not received');
    if (dis < 0 || cases < 0 || inr < 0) return 'a heading is missing: ' + dis + '/' + cases + '/' + inr;
    return (dis < cases && cases < inr) || 'order is wrong: disputes@' + dis + ' cases@' + cases + ' inr@' + inr;
});

t('a group with nothing in this view draws no heading', function () {
    var f = fixture();
    // every dispute answered -> nothing for either dispute heading in Needs Attention
    f.disputes.forEach(function (x) { x.needs_response = false; x.state = 'answered'; x.is_open = true; });
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var h = html('hold-mgr-cases');
    if (hasHeading(h, 'eBay payment disputes')) return 'an empty dispute heading is still drawn';
    return hasHeading(h, 'Item not received') || 'the INR heading vanished too — only empty groups should drop';
});

// Ethan, 2026-09-23: "Can you make the headers pop more, It took me a second to
// even realize they were there." A divider nobody sees is not dividing anything.
t('a section heading is loud enough to see: dark, ruled, and counted', function () {
    load('mgr');
    var h = html('hold-mgr-cases');
    var i = h.indexOf('SHOPIFY CHARGEBACKS') >= 0 ? h.indexOf('SHOPIFY CHARGEBACKS') : h.indexOf('Shopify chargebacks');
    if (i < 0) return 'no Shopify chargebacks heading';
    var head = h.slice(Math.max(0, i - 700), i + 300);
    if (/color:#94a3b8/.test(head) && !/slate-charcoal/.test(head)) return 'the heading is still the faint grey';
    if (!/border-bottom:2px solid/.test(head)) return 'no rule under the heading';
    return /slate-charcoal/.test(head) || 'the heading text is not the dark colour';
});

t('a section with something needing a reply gets the red bar and a count', function () {
    load('mgr');
    var h = html('hold-mgr-cases');
    var i = h.indexOf('Shopify chargebacks');
    var head = h.slice(Math.max(0, i - 700), i + 400);
    // two of the three fixture chargebacks are unanswered and in this view
    if (head.indexOf('var(--red-alert)') < 0) return 'the bar is not red for a group that needs a reply';
    return />2</.test(head) || 'no count on the heading';
});

// "Also where are the eBay payment disputes?" — WSP's one dispute was answered,
// so its group was dropped and nothing said so.
t('a group that exists but is all handled says where it went', function () {
    var f = fixture();
    // every eBay dispute answered; the Shopify ones still need us
    f.disputes.forEach(function (x) {
        if (x.source === 'ebay') { x.needs_response = false; x.response_overdue = false; x.state = 'answered'; x.is_open = true; }
    });
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var h = html('hold-mgr-cases');
    if (hasHeading(h, 'eBay payment disputes')) return 'an empty heading is drawn instead of the note';
    if (h.indexOf('Also on this tab') < 0) return 'nothing tells you the eBay disputes exist';
    if (!/2 eBay payment disputes/.test(h)) return 'the note does not count them: ' + h.slice(h.indexOf('Also on this tab'), h.indexOf('Also on this tab') + 200);
    return /Status Changed/.test(h) || 'the note does not say which view to look in';
});

t('the note is singular for one, plural for many', function () {
    var f = fixture();
    f.disputes = f.disputes.filter(function (x) { return x.source === 'ebay' && x.state === 'answered'; });
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var h = html('hold-mgr-cases');
    if (!/1 eBay payment dispute\b/.test(h)) return 'not singular for one';
    return !/1 eBay payment disputes/.test(h) || 'it says "1 eBay payment disputes"';
});

t('the heading count matches the list under it', function () {
    load('mgr');
    var h = html('hold-mgr-cases');
    var i = h.indexOf('Shopify chargebacks');
    var head = h.slice(i, i + 400);
    var m = head.match(/>(\d+)<\/span>/);
    if (!m) return 'no count found on the heading';
    // the fixture has two unanswered Shopify chargebacks in Needs Attention
    var listed = _holdIndex.mgr.filter(function (e) {
        return e.type === 'dispute' && e.it.source !== 'ebay' && _HOLD_VIEWS.due.states.indexOf(e.it.state) >= 0;
    }).length;
    return Number(m[1]) === listed || 'heading says ' + m[1] + ', list has ' + listed;
});

// --- the honesty rule and the shut window (0113) ------------------------------
// Ethan: "I don't want them to be able to resolve something that isn't actually
// resolved and then that money could just get lost in the wind." The server
// decides this (stateOf); these check the card says the right thing about it.

t('a resolution the site disagrees with stays red and names who said it', function () {
    var f = fixture();
    var d = f.disputes[0];                       // unanswered Shopify chargeback
    d.state = 'needs_reply';
    d.state_note = 'resolution_disputed';
    d.resolution_disputed_since = ago(3);
    d.review = { status: 'resolved', note: 'Refunded the buyer already', by_name: 'Dana', updated_at: ago(3) };
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var h = html('hold-mgr-cases');
    var card = cardAround(h, '#MO02-6573');
    if (!card) return 'the contested item dropped off the list entirely';
    if (!/Marked resolved — site disagrees/.test(card)) return 'the chip does not flag the disagreement';
    if (card.indexOf('Dana') < 0) return 'it does not name who resolved it';
    if (card.indexOf('Refunded the buyer already') < 0) return 'it does not quote what they said';
    return /still shows no response from us/.test(card) || 'it does not say the site disagrees';
});

t('a contested resolution does not also show the green Resolved box', function () {
    var f = fixture();
    var d = f.disputes[0];
    d.state = 'needs_reply';
    d.state_note = 'resolution_disputed';
    d.resolution_disputed_since = ago(1);
    d.review = { status: 'resolved', note: 'Refunded the buyer already', by_name: 'Dana', updated_at: ago(1) };
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var card = cardAround(html('hold-mgr-cases'), '#MO02-6573');
    return card.indexOf('Resolved by Dana') < 0
        || 'the card says both resolved and not resolved at once';
});

t('inside the grace period it warns; past it, it says the DM already has it', function () {
    function render(daysAgo) {
        var f = fixture();
        var d = f.disputes[0];
        d.state = 'needs_reply'; d.state_note = 'resolution_disputed';
        d.resolution_disputed_since = ago(daysAgo);
        d.review = { status: 'resolved', note: 'Handled it on the phone', by_name: 'Dana', updated_at: ago(daysAgo) };
        _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
        renderHoldItems('mgr');
        return cardAround(html('hold-mgr-cases'), '#MO02-6573');
    }
    var fresh = render(0), stale = render(4);
    if (!/it goes to the DM/.test(fresh)) return 'a fresh one does not warn about escalation';
    if (/already gone to the DM/.test(fresh)) return 'a fresh one claims it has already escalated';
    return /already gone to the DM/.test(stale) || 'an old one does not say it escalated';
});

t('a shut reply window reads as missed, not as something to go and answer', function () {
    var f = fixture();
    var d = f.disputes[2];                       // the eBay SELLER_RESPONSE_OVERDUE one
    d.missed_window = true; d.state_note = 'missed_window';
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var card = cardAround(html('hold-mgr-cases'), '01-15084-49541');
    if (!/Missed reply window/.test(card)) return 'the chip does not say the window was missed';
    if (!/no longer takes one/.test(card)) return 'it does not say a late response is not accepted';
    return !/clears itself on the next read/.test(card) || 'it still promises that responding clears it';
});

t('an eBay case past its deadline says so in the words of a case', function () {
    var f = awaitingFixture();
    f.cases[0].missed_window = true;
    f.cases[0].state_note = 'missed_window';
    f.cases[0].respond_by = ago(6);
    _holdData.mgr = f; _holdView.mgr = { store: '', show: 'due' }; _holdOpenForm.mgr = null;
    renderHoldItems('mgr');
    var card = cardAround(html('hold-mgr-cases'), f.cases[0].ebay_id);
    if (!/Missed reply window/.test(card)) return 'the chip does not say the window was missed';
    if (!/does not take a late reply/.test(card)) return 'it does not explain why answering will not help';
    return !/answer it on eBay and this clears itself/.test(card)
        || 'it still tells them to go and answer it';
});
