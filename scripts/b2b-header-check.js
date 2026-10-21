// B2B HEADER — checks that need the REAL markup.
//
//   powershell -File scripts/browser-check.ps1 b2b-header-check.js -Html b2b.html
//
// Separate from b2b-check.js on purpose. These assert about the DOM as
// b2b.html actually declares it -- ids, role classes, data-feature,
// which element sits inside which -- and that needs the page inlined, which is
// what -Html does. Keeping them here means the main suite stays runnable with
// no page at all and cannot start failing for want of a flag.
//
// The alternative was building the markup inside the check, which proves only
// that the copy agrees with itself -- and the whole point of these is that the
// role gate and Feature Access are driven by attributes on the real elements.

// Local copy of b2b-check.js's helper. Duplicated rather than shared because
// the runner loads exactly one check file, and five lines in two places beats a
// module system this project deliberately does not have.
//
// Why it exists at all: three checks in the main suite have failed against
// working code because the word they searched for was in the comment explaining
// it. speeks.js is heavily commented on purpose, so a bare substring search
// over a function's text searches prose as much as code.
function _srcOf(fn) {
    return String(fn)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// The header was NOT the right place -- Nick, 2026-09-10: "you put this in the
// COMPLETEly wrong spot... this was meant for the per item listing actions".
// The menu moved to the listing rows; these now guard the header staying as it
// was, since it has just been churned and put back.
t('trial: the header keeps its own buttons, ungrouped', function () {
    var ids = ['b2bDelReqBtn', 'b2bCaptureDlBtn', 'b2bFeedbackBtn', 'b2bNewBtn'];
    var missing = ids.filter(function (id) { return !document.getElementById(id); });
    if (missing.length) return 'missing from the header: ' + missing.join(', ');
    return !document.getElementById('b2bActionsMenu')
        || 'the header actions menu came back — it belongs on the rows';
});
t('trial: the header buttons kept their gates through the churn', function () {
    // These were moved into a menu and moved back out. The role classes and the
    // feature key are what actually gate them, and a copy-paste that drops one
    // is invisible until the wrong person sees the wrong button.
    var cap = document.getElementById('b2bCaptureDlBtn');
    var del = document.getElementById('b2bDelReqBtn');
    if (cap.getAttribute('data-feature') !== 'b2b-capture-download') return 'Capture lost its feature key';
    if (!cap.classList.contains('role-none')) return 'Capture lost role-none, so everyone can see it';
    if (!del.classList.contains('dynamic-module-flex')) return 'Delete Requests left the role sweep';
    // Feedback is deliberately ungated: no role- classes at all means everyone.
    var fb = document.getElementById('b2bFeedbackBtn');
    return Array.from(fb.classList).filter(function (c) { return c.indexOf('role-') === 0; }).length === 0
        || 'Feedback picked up a role gate — it is meant to be for everyone';
});

// Every modal the B2B code opens has to exist in the page. The 2026-09-26 merge
// of pre-release into feat/b2b-split-listing-locations dropped
// #b2bMoveLinesModal: the button still rendered, toggleModal() found nothing,
// and Move Lines did nothing for anybody -- no error, so b2b-check.js (which
// has no page) passed throughout. Found only by clicking it, on 2026-10-05.
t('every modal the B2B code opens is in b2b.html', function () {
    var ids = {};
    Object.keys(window).forEach(function (k) {
        if (!/^_?b2b/i.test(k) || typeof window[k] !== 'function') return;
        var re = /toggleModal\(\s*'([A-Za-z0-9_-]+)'/g, m, src = _srcOf(window[k]);
        while ((m = re.exec(src))) ids[m[1]] = k;
    });
    var found = Object.keys(ids);
    if (found.indexOf('b2bMoveLinesModal') < 0) return 'the scan no longer sees Move Lines open its modal';
    var missing = found.filter(function (id) { return !document.getElementById(id); });
    return !missing.length || 'opened but not in the page: '
        + missing.map(function (id) { return id + ' (by ' + ids[id] + ')'; }).join(', ');
});

// The Overview tab was removed on 2026-09-10 (its renderer and router are gone),
// and a merge put the button back in operations.html: it rendered for CEO and DM,
// and clicking it did nothing. Same failure as the Move Lines modal, other way
// round -- the page outlived the code. Found by clicking it on 2026-10-14.
t('the removed Overview tab is not in the page', function () {
    return !document.getElementById('b2bViewOverviewBtn') || 'the Overview button is back, with no view behind it';
});

// ---------------------------------------------------------------------------
// THE DEAL WORKSPACE (2026-10 consistency overhaul) -- against the real modal
// ---------------------------------------------------------------------------
// _b2bShowDeal switches the ONE deal modal between the workspace and the old
// layout per screen, and a stage not yet ported must get its old header and
// footer back exactly. That is a claim about real elements, so it lives here.
_b2bSend = function () { return Promise.resolve({}); };
var _wsHdrDeal = {
    id: 'wh1', ref: 'DL-0412', stage: 'completed', pricing_store: 'OVL', listing_store: 'OVL', listing_stores: ['OVL'],
    client: { company: 'Harbor Point Dental' }, pickup_date: '2026-10-09', stage_changed_at: '2026-10-24T15:00:00Z',
    intake_kind: 'pickup',
};
function _wsOpen(deal) {
    _b2bModalDeal = deal; _b2bModalItems = []; _b2bProofs = [];
    _b2bStageView(deal);
    return document.getElementById('b2bDealModal');
}

t('ws the workspace slots are in the deal modal', function () {
    var m = document.getElementById('b2bDealModal');
    var miss = ['b2bDealChip', 'b2bDealRail', 'b2bDealMoreBtn', 'b2bDealMenu']
        .filter(function (id) { var el = document.getElementById(id); return !el || !m.contains(el); });
    return !miss.length || 'missing from #b2bDealModal: ' + miss.join(', ');
});
t('ws a finished deal opens on the workspace: rail, chip, no footer', function () {
    var m = _wsOpen(_wsHdrDeal);
    if (!m.classList.contains('b2b-ws-on')) return 'not in workspace mode';
    if (document.getElementById('b2bDealRail').hidden) return 'no rail';
    if (document.getElementById('b2bDealChip').innerHTML.indexOf('Completed') === -1) return 'no stage chip';
    if (document.getElementById('b2bDealFooter').style.display !== 'none') return 'the old footer is still showing';
    return document.getElementById('b2bDealDeleteBtn').style.display === 'none' || 'the old trashcan is still in the header';
});
t('ws deletion and decline live in the ... menu, decline only where it is allowed', function () {
    var role = sessionStorage.getItem('speeksUserRole');
    sessionStorage.setItem('speeksUserRole', 'mocd');
    try {
        _wsOpen(_wsHdrDeal);
        var done = document.getElementById('b2bDealMenu').textContent;
        _wsOpen(Object.assign({}, _wsHdrDeal, { stage: 'quote' }));
        var live = document.getElementById('b2bDealMenu').textContent;
        if (done.indexOf('Request Deletion') === -1) return 'no deletion request on a finished deal';
        if (done.indexOf('Decline') > -1) return 'a completed deal can be declined';
        return live.indexOf('Decline Deal') > -1 || 'corp cannot decline a deal out with the client';
    } finally { sessionStorage.setItem('speeksUserRole', role); }
});
t('ws an unported stage gets its old header and footer back', function () {
    _wsOpen(_wsHdrDeal);
    _b2bShowDeal({ stage: 'pricing', delDeal: _wsHdrDeal, title: 'Price The Pickup', sub: 'old sub', body: '<p>x</p>',
                   footer: '<button id="wsOldFoot">Close</button>' });
    var m = document.getElementById('b2bDealModal');
    if (m.classList.contains('b2b-ws-on')) return 'still in workspace mode';
    if (!document.getElementById('b2bDealRail').hidden) return 'the rail stayed';
    if (document.getElementById('b2bDealFooter').style.display === 'none') return 'the footer stayed hidden';
    if (!document.getElementById('wsOldFoot')) return 'the footer lost its buttons';
    if (document.getElementById('b2bDealSub').textContent !== 'old sub') return 'the subtitle was dropped';
    if (document.getElementById('b2bDealMoreBtn').style.display !== 'none') return 'the ... menu stayed';
    return document.getElementById('b2bDealDeleteBtn').style.display !== 'none' || 'the trashcan did not come back';
});

// The CEO mini CRM was retired on 2026-10-21 (0151): its button, its modal and
// every crm* function went together. A merge that brings one back without the
// rest is a button that opens nothing -- the Overview tab's failure again.
t('the retired CEO CRM is not in the page or the code', function () {
    if (document.getElementById('crmGearBtn')) return 'the CRM Settings button is back';
    if (document.getElementById('crmModal')) return 'the CRM modal is back';
    var left = ['crmOpen', 'crmRender', 'crmSaveSettings', 'crmRefreshBadge', '_b2bCanCrm', 'b2bLogTouch', 'b2bDraftOutreach']
        .filter(function (k) { return typeof window[k] !== 'undefined'; });
    if (left.length) return 'still defined: ' + left.join(', ');
    // The badge class outlived it on purpose: Delete Requests wears it.
    return document.querySelector('#b2bDelReqBtn .crm-badge') ? true : 'Delete Requests lost its count badge';
});
