// ===========================================================================
// DAILY STORE MESSAGES — drafting is opt-in (2026-09-29)
//
//   powershell -File scripts/browser-check.ps1 daily-brief-check.js
//
// The 7:15 run now stages each store that earned a message with an EMPTY
// message: kind and facts are there, the sentence is not. The card must:
//   - offer Draft Message only on a card with no text
//   - never count an undrafted, untyped card toward Approve All
//   - raise a short feed nudge that names no stores
//   - POST ?action=draft and put the returned sentence on the card
// ===========================================================================

if (typeof _b2bSend === 'function') { _b2bSend = function () { return Promise.resolve({}); }; }

sessionStorage.setItem('speeksUserRole', 'District Manager');
sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
sessionStorage.setItem('speeksUserPin', '0000');
// Real clock would make every assertion depend on whether the run is before noon.
_dbPastWindow = function () { return false; };

(function () {
    var claim = document.createElement('div');
    claim.id = 'claimAlertBubble';
    document.body.appendChild(claim);
    // The modal wraps the body, as in index.html, so _dbAsk has somewhere to go.
    var modal = document.createElement('div');
    modal.id = 'dailyBriefModal';
    var body = document.createElement('div');
    body.id = 'dailyBriefBody';
    modal.appendChild(body);
    document.body.appendChild(modal);
})();

function _dbFixture() {
    return [
        { id: 11, store: 'OVL', status: 'pending', kind: 'praise', message: '', ref_date: '2026-09-28', facts: {}, signals: [] },
        { id: 12, store: 'LEE', status: 'pending', kind: 'mixed', message: '', ref_date: '2026-09-28', facts: {}, signals: [] },
        { id: 13, store: 'WSP', status: 'pending', kind: 'praise', message: 'Huge buying day WSP!', ref_date: '2026-09-28', facts: {}, signals: [] },
    ];
}

function _dbCardFor(store) {
    var cards = document.querySelectorAll('#dailyBriefBody .dbr-card');
    for (var i = 0; i < cards.length; i++) {
        if ((cards[i].querySelector('.dbr-chip') || {}).textContent === store) return cards[i];
    }
    return null;
}

t('undrafted cards offer Draft Message, a drafted one does not', function () {
    _dbDrafts = _dbFixture(); _dbEdits = {}; _dbBusy = {}; _dbRun = { ok: true, ran_at: 'x', drafted: 3 };
    _dbRenderReview(true);
    var has = function (s) { var c = _dbCardFor(s); return !!(c && /Draft Message/.test(c.innerHTML)); };
    if (!has('OVL') || !has('LEE')) return 'undrafted card missing Draft Message';
    if (has('WSP')) return 'drafted card still offers Draft Message';
    return true;
});

t('Draft All counts only undrafted; Approve All only cards with text', function () {
    _dbDrafts = _dbFixture(); _dbEdits = {}; _dbBusy = {};
    _dbRenderReview(true);
    var h = document.querySelector('#dailyBriefBody .dbr-head').innerHTML;
    if (!/Draft All 2/.test(h)) return 'expected Draft All 2';
    // Only WSP has text, so there is no bulk approve.
    if (/Approve All/.test(h)) return 'Approve All shown with only one sendable card';
    // Typing into OVL makes two sendable.
    _dbEdits['11'] = 'Great day OVL';
    _dbRenderReview(true);
    h = document.querySelector('#dailyBriefBody .dbr-head').innerHTML;
    return /Approve All 2/.test(h) || 'expected Approve All 2 after typing, got: ' + h.replace(/\s+/g, ' ').slice(0, 300);
});

t('feed nudge is short and names no stores', function () {
    var saved = _dbFetch;
    _dbFetch = function () { return Promise.resolve({ ok: true, date: '2026-09-29', drafts: _dbFixture(), run: { ok: true } }); };
    return checkDailyBriefDrafts().then(function () {
        _dbFetch = saved;
        var el = document.getElementById('dailyBriefAlertBubbleText');
        var txt = el ? el.textContent : '';
        if (!/Store Messages to Review/.test(txt)) return 'title: ' + txt;
        if (!/3 stores earned a message/.test(txt)) return 'summary: ' + txt;
        if (/OVL|LEE|WSP/.test(txt)) return 'names a store: ' + txt;
        return document.getElementById('dailyBriefAlertBubble').style.display === 'flex' || 'bubble not raised';
    });
});

// Deferred a tick: the feed-nudge check above swaps _dbDrafts when its stubbed
// fetch resolves, which would otherwise land in the middle of this one.
t('Draft Message posts ?action=draft and fills the card', function () {
  return new Promise(function (r) { setTimeout(r, 50); }).then(function () {
    _dbDrafts = _dbFixture(); _dbEdits = {}; _dbBusy = {};
    var posted = null;
    var savedFetch = window.fetch, savedCheck = checkDailyBriefDrafts;
    checkDailyBriefDrafts = function () { return Promise.resolve(); };
    window.fetch = function (u, o) {
        posted = { url: String(u), body: o && o.body };
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true, id: 11, message: 'Beautiful day OVL!' }); } });
    };
    return _dbDraft('11').then(function (ok) {
        window.fetch = savedFetch; checkDailyBriefDrafts = savedCheck;
        if (!ok) return 'returned false';
        if (!posted || !/\?action=draft$/.test(posted.url)) return 'posted to ' + (posted && posted.url);
        if (JSON.parse(posted.body).id !== '11') return 'body ' + posted.body;
        var c = _dbCardFor('OVL');
        var ta = c && c.querySelector('textarea');
        if (!ta || ta.value !== 'Beautiful day OVL!') return 'textarea: ' + (ta && ta.value);
        return !/Draft Message/.test(c.innerHTML) || 'Draft Message still offered after drafting';
    });
  });
});

t('Approve & Send is greyed until there is text, and wakes on typing', function () {
    _dbDrafts = _dbFixture(); _dbEdits = {}; _dbBusy = {};
    _dbRenderReview(true);
    var ap = document.getElementById('dbApprove-11'), done = document.getElementById('dbApprove-13');
    if (!ap || !ap.disabled) return 'undrafted card offers Approve';
    if (!done || done.disabled) return 'drafted card has Approve greyed';
    var ta = _dbCardFor('OVL').querySelector('textarea');
    ta.value = 'Great day OVL'; _dbOnEdit('11', ta);
    if (ap.disabled) return 'typing did not enable Approve';
    ta.value = '  '; _dbOnEdit('11', ta);
    return ap.disabled || 'clearing the text left Approve enabled';
});

// ---------------------------------------------------------------------------
// 2026-10-21: every Approve / Skip went dead in the Claude desktop browser pane,
// where native confirm() returns false at once and never shows a dialog. These
// run with confirm() answering false and alert() throwing, i.e. exactly that
// browser, and drive the in-modal question instead. fetch is stubbed: nothing
// leaves the harness.
// ---------------------------------------------------------------------------
function _dbPaneLike(posts, reply) {
    var saved = { fetch: window.fetch, confirm: window.confirm, alert: window.alert, check: checkDailyBriefDrafts };
    window.confirm = function () { return false; };
    window.alert = function (m) { throw new Error('alert() called: ' + m); };
    checkDailyBriefDrafts = function () { return Promise.resolve(); };
    window.fetch = function (u, o) {
        posts.push({ url: String(u), body: JSON.parse((o && o.body) || '{}') });
        var j = reply ? reply(posts[posts.length - 1]) : { ok: true };
        return Promise.resolve({ ok: j.ok !== false, status: j.ok === false ? 409 : 200, json: function () { return Promise.resolve(j); } });
    };
    return function () {
        window.fetch = saved.fetch; window.confirm = saved.confirm; window.alert = saved.alert;
        checkDailyBriefDrafts = saved.check;
    };
}
function _dbFixtureReady() {
    return [
        { id: 21, store: 'LEE', status: 'pending', kind: 'mixed', message: 'Huge processing and listing day!', ref_date: '2026-10-20', facts: {}, signals: [] },
        { id: 22, store: 'OVL', status: 'pending', kind: 'praise', message: 'Great day OVL', ref_date: '2026-10-20', facts: {}, signals: [] },
    ];
}
// The runner starts every promise test at once, and _dbAsk closes whatever
// question is already open, so these must take turns. The queue starts after
// the 50ms the Draft Message test above waits, since both swap _dbDrafts.
var _dbQueue = new Promise(function (r) { setTimeout(r, 150); });
function _dbSerial(fn) {
    var p = _dbQueue.then(fn);
    _dbQueue = p.then(function () {}, function () {});
    return p;
}
function _dbTick() { return new Promise(function (r) { setTimeout(r, 0); }); }

t('Approve & Send asks in the modal and posts the edited text, with confirm() dead', function () { return _dbSerial(function () {
  return (function () {
    _dbDrafts = _dbFixtureReady(); _dbEdits = { '22': 'Edited OVL line' }; _dbBusy = {}; _dbNotice = '';
    _dbRenderReview(true);
    var posts = [], restore = _dbPaneLike(posts);
    var p = _dbDecide('22', 'approved');
    return _dbTick().then(function () {
        var ask = document.getElementById('dbAsk');
        if (!ask) { restore(); return 'no in-modal question appeared'; }
        if (!/Edited OVL line/.test(ask.textContent)) { restore(); return 'question does not show the edited text'; }
        document.getElementById('dbAskOk').click();
        return p.then(function (ok) {
            restore();
            if (!ok) return 'returned false';
            if (posts.length !== 1) return posts.length + ' posts';
            var b = posts[0].body;
            if (b.id !== '22' || b.status !== 'approved' || b.message !== 'Edited OVL line') return 'body ' + JSON.stringify(b);
            return !document.getElementById('dbAsk') || 'question left open';
        });
    });
  })();
}); });

t('Cancel on the in-modal question posts nothing', function () { return _dbSerial(function () {
    _dbDrafts = _dbFixtureReady(); _dbEdits = {}; _dbBusy = {};
    var posts = [], restore = _dbPaneLike(posts);
    var p = _dbDecide('21', 'skipped');
    return _dbTick().then(function () {
        if (!document.getElementById('dbAsk')) { restore(); return 'no question for Skip'; }
        _dbAskClose(false);
        return p.then(function (ok) { restore(); return (!ok && !posts.length) || 'cancel still posted'; });
    });
}); });

t('Approve All asks once and posts every ready draft', function () { return _dbSerial(function () {
    _dbDrafts = _dbFixtureReady(); _dbEdits = {}; _dbBusy = {};
    var posts = [], restore = _dbPaneLike(posts);
    var p = _dbApproveAll();
    return _dbTick().then(function () {
        var ask = document.getElementById('dbAsk');
        if (!ask || !/LEE/.test(ask.textContent) || !/OVL/.test(ask.textContent)) { restore(); return 'question missing or incomplete'; }
        document.getElementById('dbAskOk').click();
        return p.then(function () {
            restore();
            var ids = posts.map(function (x) { return x.body.id + ':' + x.body.status; }).sort().join(',');
            return ids === '21:approved,22:approved' || 'posted ' + ids;
        });
    });
}); });

t('Skip All asks once and posts skipped for each', function () { return _dbSerial(function () {
    _dbDrafts = _dbFixtureReady(); _dbEdits = {}; _dbBusy = {};
    var posts = [], restore = _dbPaneLike(posts);
    var p = _dbSkipAll();
    return _dbTick().then(function () {
        if (!document.getElementById('dbAsk')) { restore(); return 'no question'; }
        document.getElementById('dbAskOk').click();
        return p.then(function () {
            restore();
            var ids = posts.map(function (x) { return x.body.id + ':' + x.body.status; }).sort().join(',');
            return ids === '21:skipped,22:skipped' || 'posted ' + ids;
        });
    });
}); });

t('a backend refusal is shown in the modal, not swallowed', function () { return _dbSerial(function () {
    _dbDrafts = _dbFixtureReady(); _dbEdits = {}; _dbBusy = {}; _dbNotice = '';
    var posts = [], restore = _dbPaneLike(posts, function () { return { ok: false, error: 'already approved' }; });
    var p = _dbDecide('21', 'approved');
    return _dbTick().then(function () {
        document.getElementById('dbAskOk').click();
        return p.then(function (ok) {
            restore();
            if (ok) return 'reported success';
            var b = document.querySelector('#dailyBriefBody .dbr-banner.red');
            return (b && /already approved/.test(b.textContent)) || 'no in-modal error line';
        });
    });
}); });
