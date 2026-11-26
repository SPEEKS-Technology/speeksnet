// EVERY "RESOLVED" IS FACT-CHECKED, AND THE DM ANSWERS WHAT THE SITES DON'T
// BACK UP (0164, 2026-11-03) — the front-end half.
//
//   powershell -File scripts/browser-check.ps1 claims-fact-check-check.js -Html workspace.html
//
// -Html because the To Confirm tab and its badge are declared in workspace.html,
// and the DM's feed card is created next to the real #claimAlertBubble.
// claims-disputes is stubbed: the server decides states and the DM queue; these
// checks are about what the front end draws and posts for them.
//
// Stubbed ONCE at the top (see CLAUDE.md): a POST's send lands in a promise
// callback, after a per-test stub would already have been restored.

var _fcPosts = [];
var _fcAlerts = { success: true, today: '2026-11-03', stores: ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'], dueAlerts: [], dmQueue: [] };
var _fcList = null;
window.fetch = function (url, opts) {
    var u = String(url);
    if (opts && opts.method === 'POST') {
        var b = JSON.parse(opts.body);
        b._url = u;
        _fcPosts.push(b);
        // ok: unrestocked-returns answers { ok }, claims-disputes { success }.
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ success: true, ok: true }); } });
    }
    if (/claims-disputes\?action=alerts/.test(u)) {
        return Promise.resolve({ json: function () { return Promise.resolve(JSON.parse(JSON.stringify(_fcAlerts))); } });
    }
    if (/claims-disputes\?stores=/.test(u) && _fcList) {
        return Promise.resolve({ json: function () { return Promise.resolve(JSON.parse(JSON.stringify(_fcList))); } });
    }
    return Promise.reject(new Error('network blocked in browser-check'));
};
function as(role) {
    sessionStorage.setItem('speeksUserRole', role);
    sessionStorage.setItem('speeksUserName', 'Check User');
    sessionStorage.setItem('speeksUserStore', 'ALL');
}
function inr(o) {
    return Object.assign({
        case_key: 'case:1', store_code: 'BAL', kind: 'case', case_type: 'ITEM_NOT_RECEIVED', ebay_id: '1',
        order_no: '24-15268-48846', amount: 39.99, is_open: false, outcome: 'refunded', item_title: 'Test lens',
        opened_at: '2026-10-27T00:00:00Z', state: 'due', state_note: null, review: null, dm: null, history: [],
    }, o || {});
}
function draw(it, form) {
    _holdIndex.mgr = [];
    _holdOpenForm.mgr = form ? { id: 'ebay_case|' + it.case_key, mode: form } : null;
    _holdData.mgr = _holdData.mgr || { timers: { ebay_case: 2 } };
    return _holdCard('mgr', 'ebay_case', it, false, {}, {});
}
function text(html) { var d = document.createElement('div'); d.innerHTML = html; return d.textContent.replace(/\s+/g, ' '); }

t('page declares the To Confirm tab, its badge and its panel', function () {
    if (!document.getElementById('ov-tab-confirm')) return 'no #ov-tab-confirm (run with -Html workspace.html)';
    if (!document.getElementById('hold-ov-badge-confirm')) return 'no badge';
    if (!document.getElementById('hold-ov-confirm')) return 'no panel';
    var tabs = document.getElementById('ov-tab-confirm').parentElement;
    return tabs.contains(document.getElementById('ov-tab-claims')) || 'not in the oversight tab bar';
});

t('refunded INR, returned to us: says restock it, resolves, no Still open', function () {
    var h = draw(inr({ state_note: 'returned_to_us', tracking_status: 'RETURNED' }), 'status');
    var x = text(h);
    if (!/Returned to us — restock it/.test(x)) return 'chip: ' + x.slice(0, 200);
    if (!/sent this back to us/.test(x)) return 'no carrier box';
    if (!/Restocked — Resolve it|Close/.test(x)) return 'no resolve button';
    if (/Still open/.test(x)) return 'a refunded INR offered Still open';
    if (/Refunding the buyer\? Open a claim/.test(x)) return 'offered "Refunding the buyer?" on one already refunded';
    return /Resolved is checked/.test(x) || 'form does not say a resolution is checked';
});

t('refunded INR, never scanned: find it, not a claim', function () {
    var x = text(draw(inr({ state_note: 'never_scanned', tracking_status: 'MANIFEST' })));
    if (!/Never scanned — find it/.test(x)) return 'chip';
    if (!/never scanned this parcel/.test(x)) return 'box';
    if (/Open or link a claim/.test(x)) return 'offered a claim on a parcel the carrier never had';
    return /Found it — Resolve it/.test(x) || 'button';
});

t('refunded INR, delivered with no claim: call eBay', function () {
    var x = text(draw(inr({ state_note: 'delivered_after_refund', tracking_status: 'DELIVERED' })));
    if (!/Delivered — call eBay/.test(x)) return 'chip';
    if (!/call eBay for it rather than filing a claim/.test(x)) return 'box: ' + x.slice(0, 300);
    return /Delivered — Resolve it/.test(x) || 'button';
});

// eBay's 30-day payback window (2026-11-06). Dates are built from today so the
// check doesn't rot: the card counts days left in the viewer's local day.
function dayFromNow(n) {
    var d = new Date(); d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

t('delivered refund prints eBay\'s last payback day and the days left', function () {
    var x = text(draw(inr({ state_note: 'delivered_after_refund', tracking_status: 'DELIVERED', payback_by: dayFromNow(5) })));
    if (!/eBay pays it back only until/.test(x)) return 'no payback line: ' + x.slice(0, 400);
    if (!/5 days left/.test(x)) return 'no days-left count';
    return /waits 3 days/.test(x) || 'does not say a 24-48h payback is waited for';
});

// Ethan, 2026-11-06: past eBay's window with no claim it is written off —
// settled, off the managers' list, nothing to press.
t('delivered refund past the window: written off, nothing to do', function () {
    var x = text(draw(inr({ state: 'settled', state_note: 'written_off', tracking_status: 'DELIVERED', payback_by: dayFromNow(-3) })));
    if (!/Written off — eBay's window closed/.test(x)) return 'chip: ' + x.slice(0, 200);
    if (/call eBay/.test(x)) return 'still says to call eBay';
    if (!/ran out on/.test(x)) return 'box';
    if (/pays it back only until/.test(x)) return 'still printed a live window';
    if (/Open or link a claim|Resolve another way/.test(x)) return 'offered an action on a written-off item';
    return true;
});

t('lost in transit: says eBay pays if it lands in time; no date, no line', function () {
    var x = text(draw(inr({ state: 'needs_claim', tracking_status: 'IN_TRANSIT', payback_by: dayFromNow(10) })));
    if (!/If it shows delivered by/.test(x)) return 'no delivered-in-time line';
    var y = text(draw(inr({ state: 'needs_claim', tracking_status: 'IN_TRANSIT' })));
    return !/If it shows delivered by/.test(y) || 'printed a delivered-by line with no payback date';
});

t('lost in transit: claim first, resolving still possible', function () {
    var x = text(draw(inr({ state: 'needs_claim', tracking_status: 'IN_TRANSIT' })));
    if (!/Lost in transit — needs a claim/.test(x)) return 'chip';
    if (!/Open or link a claim/.test(x)) return 'no claim button';
    return /Resolve another way/.test(x) || 'no resolve button';
});

t('waiting on the DM: amber, quotes the manager, says why', function () {
    var x = text(draw(inr({ state: 'dm_review', review: { status: 'resolved', by_name: 'Pat', note: 'Returned to us via lost in mail.' },
        dm: { pending: true, why: 'Shopify doesn\'t show the device back in stock', resolved_by: 'Pat', resolved_note: 'Returned to us via lost in mail.', resolved_at: '2026-11-03T15:00:00Z' } })));
    if (!/Waiting on DM/.test(x)) return 'chip';
    if (!/Pat marked this resolved/.test(x)) return 'who';
    if (!/waiting on the DM to confirm/.test(x)) return 'block';
    if (!/doesn't show the device back in stock/.test(x)) return 'why missing';
    return !/Resolved by Pat/.test(x) || 'also drew the green "Resolved by" block';
});

// 2026-11-04: re-read after the click and still contradicted → back in Needs
// Attention for the manager, red, not the amber "waiting on the DM".
t('marked resolved but not done: back on the manager\'s list, red, says what the system saw', function () {
    var x = text(draw(inr({ state: 'due', review: { status: 'resolved', by_name: 'Pat', note: 'We got refunded. all is good.' },
        dm: { pending: true, kind: 'not_done', why: 'The buyer was refunded: eBay\'s payouts show $179.85 refunded from us and not credited back', resolved_by: 'Pat', resolved_note: 'We got refunded. all is good.', resolved_at: '2026-10-09T15:00:00Z' } })));
    if (!/Marked resolved — not done/.test(x)) return 'chip: ' + x.slice(0, 160);
    if (!/Pat marked this resolved .*it isn't done/.test(x)) return 'block: ' + x.slice(0, 300);
    if (!/\$179\.85 refunded from us/.test(x)) return 'why missing';
    if (/waiting on the DM to confirm/.test(x)) return 'still says it is waiting on the DM';
    if (_HOLD_VIEWS.due.states.indexOf('due') < 0) return 'due is not a Needs Attention state';
    return !/Resolved by Pat/.test(x) || 'also drew the green "Resolved by" block';
});

t('sent back: chip says so, the DM\'s reason is on the card', function () {
    var x = text(draw(inr({ state: 'due', state_note: 'never_scanned', review: { status: 'resolved', by_name: 'Pat', note: 'found it' },
        dm: { pending: false, status: 'denied', by: 'Ethan', note: 'Not in stock — find the lens and restock it', at: '2026-11-03T18:00:00Z', resolved_by: 'Pat', resolved_note: 'found it' } })));
    if (!/Sent back by DM/.test(x)) return 'chip: ' + x.slice(0, 160);
    if (!/The DM sent this back — Ethan/.test(x)) return 'block';
    return /Not in stock — find the lens and restock it/.test(x) || 'reason missing';
});

// 2026-11-10: a send-back on a missed-window case only undoes the resolution —
// the server keeps it hushed, and the card reads as the quiet case, not a to-do.
t('sent back but hushed (missed window): reads as the quiet case, not "Sent back by DM"', function () {
    var it = inr({ state: 'needs_reply', state_note: 'missed_window', missed_window: true, hush: 'missed_window',
        review: { status: 'resolved', by_name: 'Pat', note: 'Didn\'t respond via ebay, nothing to be done.' },
        dm: { pending: false, status: 'denied', by: 'Ethan', note: 'Still open on eBay, let it ride out', at: '2026-11-10T18:00:00Z', resolved_by: 'Pat' } });
    var x = text(draw(it));
    if (/Sent back by DM/.test(x)) return 'chip still says sent back: ' + x.slice(0, 160);
    return /Missed reply window/.test(x) || 'chip: ' + x.slice(0, 160);
});

t('DM To Confirm list: renders, send back needs a reason, posts against the review key', function () {
    as('District Manager');
    _holdData.ov = { stores: ['BAL'], cases: [inr({ state: 'dm_review' })], mismatches: [], disputes: [], payments: [],
        dmQueue: [{ type: 'ebay_case', key: 'case:1', review_key: 'inquiry:1', store_code: 'BAL', state: 'dm_review',
            why: 'Shopify doesn\'t show the device back in stock', resolved_by: 'Pat', resolved_note: 'Returned to us via lost in mail.',
            resolved_at: '2026-11-03T15:00:00Z', amount: 39.99, order: '24-15268-48846', kind: 'case', case_type: 'ITEM_NOT_RECEIVED' }] };
    renderHoldItems('ov');
    var panel = document.getElementById('hold-ov-confirm');
    var x = panel.textContent.replace(/\s+/g, ' ');
    if (!/1 resolution · \$39\.99/.test(x)) return 'header: ' + x.slice(0, 160);
    if (!/Pat said/.test(x) || !/The system says:/.test(x)) return 'both accounts not shown';
    var badge = document.getElementById('hold-ov-badge-confirm');
    if (!badge || badge.textContent !== '1' || badge.style.display === 'none') return 'badge not painted';
    _fcPosts = [];
    var before = (window.__suppressedDialogs || []).length;
    return _holdDmAnswer(0, 'dm_send_back').then(function () {
        if (_fcPosts.length) return 'sent back with no reason';
        document.getElementById('hold-dm-note-0').value = 'Not in stock — find it and restock it';
        _fcList = JSON.parse(JSON.stringify(_holdData.ov));
        _fcList.success = true;
        return _holdDmAnswer(0, 'dm_send_back').then(function () {
            var p = _fcPosts[0];
            if (!p) return 'nothing posted';
            if (p.action !== 'dm_send_back') return 'action ' + p.action;
            if (p.item_key !== 'inquiry:1') return 'posted against ' + p.item_key + ', not the review key';
            return p.note === 'Not in stock — find it and restock it' || 'note ' + p.note;
        });
    });
});

// 2026-11-14: a Never Came Back mark on the Returned But Not Back In Stock
// report sits on the same list, and is answered through unrestocked-returns.
// The runner fires every t() at once and settles promises after, so this waits
// for the To Confirm test above — both use _holdData.ov, _fcPosts and the
// hold-dm-note-0 box, and running alongside it breaks it.
t('To Confirm: Never Came Back line renders and answers through unrestocked-returns', function () {
    return Promise.all((window.__pending || []).slice()).then(nbLine);
});
function nbLine() {
    as('District Manager');
    _holdData.ov = { stores: ['WSP'], cases: [], mismatches: [], disputes: [], payments: [],
        dmQueue: [{ type: 'unrestocked', key: 'WSP:1:2', review_key: 'WSP:1:2', store_code: 'WSP', state: 'dm_review',
            why: 'Shopify still has MO02-X at 0 on hand and it has not sold again, so nothing shows whether it came back',
            resolved_by: 'Eli', resolved_note: 'Never came back — refunded without a return', resolved_at: '2026-11-13T18:45:00Z',
            amount: 108.99, order: '#MO02-8171', title: 'Test game', fact_kind: 'unverifiable' }] };
    renderHoldItems('ov');
    var panel = document.getElementById('hold-ov-confirm');
    var x = panel.textContent.replace(/\s+/g, ' ');
    if (!/Not back in stock/.test(x)) return 'kind chip missing: ' + x.slice(0, 200);
    if (!/Test game/.test(x) || !/Eli said/.test(x)) return 'title / account missing';
    if (!/Confirm never came back/.test(x)) return 'confirm label';
    var link = panel.querySelector('a[href*="restock="]');
    if (!link || !/WSP%3A1%3A2/.test(link.getAttribute('href'))) return 'no restock card link';
    _fcPosts = [];
    _fcList = JSON.parse(JSON.stringify(_holdData.ov)); _fcList.success = true;
    document.getElementById('hold-dm-note-0').value = 'Fine — eBay ding not worth it';
    return _holdDmAnswer(0, 'dm_confirm').then(function () {
        var p = _fcPosts[0];
        if (!p) return 'nothing posted';
        if (!/unrestocked-returns/.test(p._url)) return 'posted to ' + p._url;
        if (p.action !== 'nb_confirm' || p.key !== 'WSP:1:2') return 'action/key ' + p.action + ' ' + p.key;
        if (!p.who || p.who.role !== 'District Manager') return 'who not sent';
        _fcPosts = [];
        document.getElementById('hold-dm-note-0').value = '';
        return _holdDmAnswer(0, 'dm_send_back').then(function () {
            if (_fcPosts.length) return 'denied with no reason';
            document.getElementById('hold-dm-note-0').value = 'Ship it back next time';
            return _holdDmAnswer(0, 'dm_send_back').then(function () {
                var q = _fcPosts[0];
                return (q && q.action === 'nb_deny' && q.note === 'Ship it back next time') || 'deny post: ' + JSON.stringify(q);
            });
        });
    });
}

t('DM feed card: shows for the DM only, no snooze, opens To Confirm', function () {
    if (!document.getElementById('claimAlertBubble')) return 'no #claimAlertBubble in the page';
    var cfg = _samReminderCfg().find(function (r) { return r.key === 'claimsConfirm'; });
    if (!cfg) return 'no claimsConfirm feed entry';
    if (cfg.noSnooze !== true) return 'snoozeable';
    if (cfg.action !== "openClaimsTool('confirm')") return 'action ' + cfg.action;
    _fcAlerts.dmQueue = [{ type: 'mismatch', key: 'm', store_code: 'MPL', amount: 449.99 }, { type: 'ebay_case', key: 'c', store_code: 'LEE', amount: 209.99 }];
    as('District Manager');
    return checkClaimsConfirmAlerts().then(function () {
        var c = _samGatherReminders().find(function (r) { return r.key === 'claimsConfirm'; });
        if (!c) return 'not in the DM feed';
        // The feed Title-Cases its lines (_qpCapLines), so match either case.
        if (!/2 resolutions \(\$659\.98\)/i.test(c.snippet)) return 'snippet: ' + c.snippet;
        as('Manager');
        return checkClaimsConfirmAlerts().then(function () {
            var m = _samGatherReminders().find(function (r) { return r.key === 'claimsConfirm'; });
            if (m) return 'a store manager got the DM card';
            as('District Manager');
            _fcAlerts.dmQueue = [];
            return checkClaimsConfirmAlerts().then(function () {
                return !_samGatherReminders().find(function (r) { return r.key === 'claimsConfirm'; }) || 'stayed with an empty queue';
            });
        });
    });
});

// LISTED, NOT NOTIFIED (claims-disputes hushOf, Ethan 2026-11-07): a case we
// replied to, or past a window eBay won't reopen, stays on the list but is not
// counted on the badge or the QuickPortal, and its card drops the red edge.
// A delivered / label-needed return keeps counting.
t('hushed cases: listed, not counted; act-now return still counted', function () {
    var hushed = inr({ case_key: 'case:h1', kind: 'case', case_type: 'RETURN', is_open: true, outcome: null,
        state: 'needs_reply', state_note: 'missed_window', missed_window: true, awaiting_reply: true, hush: 'missed_window' });
    var replied = inr({ case_key: 'case:h2', kind: 'case', case_type: 'RETURN', is_open: true, outcome: null,
        state: 'due', hush: 'replied' });
    var live = inr({ case_key: 'case:h3', kind: 'case', case_type: 'RETURN', is_open: true, outcome: null, state: 'needs_reply', awaiting_reply: true });
    var ret = inr({ case_key: 'return:r1', kind: 'return', case_type: null, is_open: true, outcome: null,
        state: 'due', state_note: 'return_delivered', ebay_status: 'ITEM_DELIVERED / ITEM_DELIVERED' });
    _holdData.chk = { cases: [hushed, replied, live, ret], disputes: [{ dispute_key: 'ebay:1', state: 'needs_reply', hush: 'missed_window' }], mismatches: [], payments: [] };
    var n = _holdDueCounts('chk');
    if (n.cases !== 1) return 'cases badge should count only the live one, got ' + n.cases;
    if (n.returns !== 1) return 'delivered return should count, got ' + n.returns;
    var q = _qpClaimsSplit(_holdData.chk);
    if (q.cases.due.length !== 1) return 'QuickPortal due should be 1, got ' + q.cases.due.length;
    if (q.cases.waiting < 3) return 'hushed items should count as waiting, got ' + q.cases.waiting;
    _holdIndex.chk = [];
    var html = _holdCard('chk', 'ebay_case', replied, false, {}, {});
    if (/inset 3px 0 0/.test(html)) return 'hushed card still has the red edge';
    if (html.indexOf('Replied — waiting on eBay') < 0) return 'replied chip missing';
    delete _holdData.chk; delete _holdIndex.chk;
    return true;
});
