// VARIANCE — the DM can END a period.
//
//   powershell -File scripts/browser-check.ps1 variance-end-check.js -Html workspace.html
//
// Ethan, 2026-10-12: a manager never replied and is overdue; he isn't going to
// make them do it this time, but the "Variance Replies Due" card kept pinging
// him with no way to stop it. Ending a period (0146 ended_at) must silence
// every reminder about it on BOTH sides, lock the notes, keep the report, and
// be reversible.
//
// One fetch stub for the whole file. Each call captures the response at CALL
// time, so async tests that interleave cannot read each other's data.

var _posts = [];
var _getData = [];
window.fetch = function (url, opts) {
    if (opts && opts.method === 'POST') {
        var b = JSON.parse(opts.body);
        _posts.push(b);
        var out = { success: true };
        if (b.action === 'end_period') {
            out.ended_at = b.ended === false ? null : new Date().toISOString();
            out.ended_by = b.ended === false ? null : b.by;
        }
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(out); } });
    }
    var data = _getData.slice();
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ success: true, data: data }); } });
};

// The runner starts every t() synchronously and awaits the promises together,
// so async tests would interleave on shared globals (the role, the reminder
// cache). _seq chains each one onto the last so they run strictly in order.
var _chain = Promise.resolve();
function _seq(fn) { var r = _chain.then(fn); _chain = r.then(function () {}, function () {}); return r; }

function _as(role, store) {
    sessionStorage.setItem('speeksUserRole', role);
    sessionStorage.setItem('speeksUserStore', store);
    sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
}
var DAY = 86400000;
function _period(extra) {
    // Uploaded ten days ago, due three days ago, nothing explained: the overdue
    // store from the screenshot.
    return Object.assign({
        id: 'p1', store: 'OVL', date_from: '2026-09-01', date_to: '2026-09-30',
        uploaded_at: new Date(Date.now() - 10 * DAY).toISOString(),
        manager_due_at: new Date(Date.now() - 3 * DAY).toISOString(),
        all_clear: false, dm_notes_at: null, dm_reviewed_at: null,
        items: 4, answered: 0, awaiting_reply: 0, mgr_replied: 0,
    }, extra || {});
}
function _bubbleLive() {
    var b = document.getElementById('varianceAlertBubble');
    return !!b && getComputedStyle(b).display !== 'none';
}
var _items = [
    { id: 'i1', order_number: '1001', sku: 'A', item_title: 'Thing', variance_pct: -30, gm_note: 'sold low, cracked', needs_reply: true },
    { id: 'i2', order_number: '1002', sku: 'B', item_title: 'Other', variance_pct: -20, gm_note: null, needs_reply: true },
];
function _render(period) {
    _vrCurrent = { period: period, items: _items.map(function (i) { return Object.assign({}, i); }), team_variance: null };
    _vrPeriods = [period];
    _vrEditing = false; _vrUploadOpen = false;
    renderVarianceReplies();
    return document.getElementById('vr-body');
}
function _shown(id) { var e = document.getElementById(id); return !!e && e.style.display !== 'none'; }

t('DM: an overdue period with no replies still raises the review card', function () { return _seq(function () {
    _as('district manager', 'CORP');
    _getData = [_period()];
    return checkVarianceDmReminders().then(function () {
        return _bubbleLive() || 'the open overdue period raised nothing — the test is not exercising the card';
    });
}); });

t('DM: the same period ENDED raises nothing', function () { return _seq(function () {
    _as('district manager', 'CORP');
    // Start from a live card so "hidden" is the transition, not the default.
    _getData = [_period()];
    return checkVarianceDmReminders().then(function () {
        if (!_bubbleLive()) return 'precondition: card was not live';
        _getData = [_period({ ended_at: new Date().toISOString(), ended_by: 'Ethan Kushnir' })];
        return checkVarianceDmReminders();
    }).then(function (r) {
        if (typeof r === 'string') return r;
        return !_bubbleLive() || 'the card is still up for an ended period';
    });
}); });

t('manager: an ended period lights no dot and owes nothing', function () { return _seq(function () {
    _as('manager', 'OVL');
    _getData = [_period({ ended_at: new Date().toISOString() })];
    return checkVarianceReminders().then(function () {
        if (_vrMyPeriodsCache.length) return 'the ended period is still in the manager reminder cache';
        return !_vrDotNeeded() || 'the dot is still needed';
    });
}); });

t('manager: the open overdue period still nags (control)', function () { return _seq(function () {
    _as('manager', 'OVL');
    _getData = [_period()];
    return checkVarianceReminders().then(function () {
        return _vrDotNeeded() || 'an open overdue period lights no dot — the control is broken';
    });
}); });

t('DM view of an overdue open period offers End period', function () { return _seq(function () {
    _as('district manager', 'CORP');
    var body = _render(_period());
    if (!/End period/.test(body.innerHTML)) return 'no End period button';
    return !/Reopen period/.test(body.innerHTML) || 'Reopen shown on an open period';
}); });

t('DM view of an ended period: banner, Reopen, no Edit, no pink missed cells', function () { return _seq(function () {
    _as('district manager', 'CORP');
    var body = _render(_period({ ended_at: new Date().toISOString(), ended_by: 'Ethan Kushnir' }));
    if (!/was ended by Ethan Kushnir/.test(body.textContent)) return 'no ended banner naming who';
    if (!/Reopen period/.test(body.innerHTML)) return 'no Reopen button';
    if (/>End period</.test(body.innerHTML)) return 'End still offered on an ended period';
    if (_shown('vr-edit-btn')) return 'the DM can still Edit notes on an ended period';
    if (/background:#fee2e2/.test(body.innerHTML)) return 'unexplained lines are still painted as missed';
    if (!/sold low, cracked/.test(body.textContent)) return 'the explanation that DID come in is not readable';
    return true;
}); });

t('manager view of an ended period is read-only with the banner', function () { return _seq(function () {
    _as('manager', 'OVL');
    var body = _render(_period({ ended_at: new Date().toISOString(), ended_by: 'Ethan Kushnir' }));
    if (!/no more replies are needed/.test(body.textContent)) return 'manager sees no banner';
    if (_shown('vr-edit-btn')) return 'the manager can still Edit on an ended period';
    if (/End period|Reopen period/.test(body.innerHTML)) return 'a manager is offered the DM control';
    var sub = _vrSubtitleText();
    return !/overdue/i.test(sub) || 'subtitle still says overdue: ' + sub;
}); });

t('End then Reopen posts end_period and flips the view each way', function () { return _seq(function () {
    _as('district manager', 'CORP');
    _getData = [];
    _render(_period());
    var before = _posts.length;
    return vrEndPeriod('p1', true).then(function () {
        var p = _posts[before];
        if (!p || p.action !== 'end_period' || p.ended !== true) return 'end posted ' + JSON.stringify(p);
        if (!_vrCurrent.period.ended_at) return 'the open period did not take the ended stamp';
        if (!/Reopen period/.test(document.getElementById('vr-body').innerHTML)) return 'view did not flip to ended';
        return vrEndPeriod('p1', false).then(function () {
            var q = _posts[before + 1];
            if (!q || q.ended !== false) return 'reopen posted ' + JSON.stringify(q);
            if (_vrCurrent.period.ended_at) return 'reopen left the stamp';
            return /End period/.test(document.getElementById('vr-body').innerHTML) || 'view did not flip back';
        });
    });
}); });
