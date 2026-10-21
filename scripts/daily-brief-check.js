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
    var body = document.createElement('div');
    body.id = 'dailyBriefBody';
    document.body.appendChild(body);
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
