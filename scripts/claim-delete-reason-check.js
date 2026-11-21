// CLAIM DELETE REQUESTS CARRY A REASON (Ethan, 2026-11-21: "add a notes field
// when a user requests to delete an insurance claim, so I know why they are
// trying to delete the claim").
//
// What must hold:
//   - the trash button opens a dialog with a reason box, not a bare confirm();
//   - Send with an empty box is refused in the dialog and posts nothing;
//   - a filled box posts action=request_delete WITH the reason;
//   - the DM's Delete Requests list prints the reason, and says so plainly when
//     an old request has none.
//
// Run: powershell -File scripts/browser-check.ps1 claim-delete-reason-check.js

// fetch is stubbed ONCE, at the top, for the same reason _b2bSend is in the B2B
// suites: the send happens in a promise callback after the test returns.
var CDR_POSTS = [];
window.fetch = function (url, opts) {
    if (opts && opts.method === 'POST') CDR_POSTS.push(JSON.parse(opts.body || '{}'));
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ success: true, data: [] }); } });
};

t('trash opens a reason dialog', function () {
    requestClaimDelete('claim-1', false);
    var m = document.getElementById('claimDelReqModal');
    if (!m) return 'no #claimDelReqModal after requestClaimDelete';
    if (!m.querySelector('#claimDelReqReason')) return 'dialog has no reason box';
    return true;
});

t('empty reason is refused and posts nothing', function () {
    requestClaimDelete('claim-1', false);
    var before = CDR_POSTS.length;
    document.querySelector('#claimDelReqModal [data-act="send"]').click();
    var err = document.getElementById('claimDelReqErr');
    if (CDR_POSTS.length !== before) return 'posted with an empty reason';
    if (!err || err.style.display === 'none') return 'no error shown for empty reason';
    if (!document.getElementById('claimDelReqModal')) return 'dialog closed on an empty reason';
    return true;
});

t('a reason is posted with the request', function () {
    requestClaimDelete('claim-2', true);
    var m = document.getElementById('claimDelReqModal');
    if (!/loss claim/.test(m.textContent)) return 'INR-with-child warning missing';
    document.getElementById('claimDelReqReason').value = '  Duplicate of case 12345  ';
    m.querySelector('[data-act="send"]').click();
    var p = CDR_POSTS[CDR_POSTS.length - 1];
    if (!p) return 'nothing posted';
    if (p.action !== 'request_delete' || p.id !== 'claim-2') return 'wrong payload ' + JSON.stringify(p);
    if (p.reason !== 'Duplicate of case 12345') return 'reason not trimmed/sent: ' + JSON.stringify(p.reason);
    return true;
});

t('DM list shows the reason, and says when there is none', function () {
    var host = document.createElement('div');
    host.id = 'claims-oversight-body';
    document.body.appendChild(host);
    var now = new Date().toISOString();
    _oversightAll = [
        { id: 'a', store: 'OVL', case_number: 'C-1', reason_type: 'Damage', status: 'in_progress', created_at: now,
          delete_requested_at: now, delete_requested_by: 'Sam', delete_reason: 'Opened on the <wrong> order' },
        { id: 'b', store: 'LEE', case_number: 'C-2', reason_type: 'Loss', status: 'in_progress', created_at: now,
          delete_requested_at: now, delete_requested_by: 'Pat', delete_reason: null },
    ];
    renderClaimsOversight();
    var txt = host.textContent;
    host.remove();
    if (txt.indexOf('Why: Opened on the <wrong> order') < 0) return 'reason not printed (or not escaped): ' + txt.slice(0, 300);
    if (txt.indexOf('No reason given') < 0) return 'old request without a reason not labelled';
    return true;
});
