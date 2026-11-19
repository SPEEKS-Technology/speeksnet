// SUBMIT A TICKET (was Submit an Idea) — behaviour checks. Dev tracker Phase 3
// part 2 (docs/plans/dev-tracker-HANDOFF.md, D3).
//
//   powershell -File scripts/browser-check.ps1 submit-ticket-check.js
//
// The popup every store uses. What these pin down:
//   - it posts the NEW fields (Type, Area, Description, Attachment) with the
//     PIN — the idea-submit function makes a ticket only when a PIN comes with
//     the post, and falls back to the old email-only path without one
//   - "Submitted" only after the server says so, with the ticket's number
//   - "A project I want to build" never posts a ticket: it hands the text to
//     the Projects request form, and is offered only to people who may request
//   - My Tickets words each status for the person who asked, and shows the
//     Won't do reason
//
// fetch is stubbed ONCE, here (the _b2bSend rule in CLAUDE.md): submitIdea
// awaits it, so a stub restored in a test's finally would be gone before the
// answer is read. Only idea-submit is answered; anything else still hits the
// runner's blocked fetch and is reported.

var IDEA_SENT = [];
var IDEA_ANSWER = { success: true, ticket: { id: 1234, title: 'x', status: 'triage' }, emailed: true };
(function () {
    var blocked = window.fetch;
    window.fetch = function (u, opts) {
        if (String(u).indexOf('/idea-submit') === -1) return blocked.apply(this, arguments);
        IDEA_SENT.push({ url: String(u), opts: opts || {} });
        var body = (opts && opts.method === 'POST') ? IDEA_ANSWER : { success: true, me: { name: 'Browser Check', test: false }, types: [], areas: [], tickets: [] };
        return Promise.resolve({ ok: body.success !== false, status: 200, json: function () { return Promise.resolve(body); } });
    };
})();

// The PIN, set only for the synchronous part of a call (fetch is invoked before
// submitIdea's first await) and always put back: the page's own init runs
// after this file (CLAUDE.md, "Verifying a change").
function withPin(fn) {
    var was = sessionStorage.getItem('speeksUserPin');
    sessionStorage.setItem('speeksUserPin', '9999');
    try { return fn(); } finally {
        if (was === null) sessionStorage.removeItem('speeksUserPin'); else sessionStorage.setItem('speeksUserPin', was);
    }
}
function ideaFresh() {
    var old = document.getElementById('ideaModal');
    if (old) old.remove();
    _ideaData = null;
    injectIdeaModal();
    _ideaResetForm();
    return document.getElementById('ideaModal');
}
function opts(id) {
    return Array.prototype.map.call(document.getElementById(id).options, function (o) { return o.value; });
}

t('popup: titled Submit a Ticket, with New Ticket and My Tickets tabs', function () {
    var m = ideaFresh();
    var h = m.querySelector('.modal-header h3').textContent;
    if (h !== 'Submit a Ticket') return 'title: ' + h;
    return (!!document.getElementById('ideaTabNew') && !!document.getElementById('ideaTabMine')) || 'missing a tab';
});
t('form: posts Type, Area, Description, Attachment — not the old Name / Category', function () {
    ideaFresh();
    var names = Array.prototype.map.call(document.querySelectorAll('#ideaForm [name]'), function (f) { return f.name; }).join(',');
    return names === 'Type,Area,Description,Attachment' || 'fields: ' + names;
});
t('form: the types 0188 seeded, and Area starts on "Not sure"', function () {
    _featureOv = { role: {}, user: { 'projects-request': { 'browser check': false } } };
    try {
        ideaFresh();
        var ty = opts('ideaType').join(',');
        if (ty !== 'bug,suggestion,improvement,task') return 'types: ' + ty;
        var a = document.getElementById('ideaArea');
        return (a.value === '' && a.options[0].text === 'Not sure') || 'area starts on ' + a.value;
    } finally { _featureOv = { role: {}, user: {} }; }
});
t('form: the server\'s lists replace the fallback, without dev-only types', function () {
    ideaFresh();
    _ideaData = { types: [{ key: 'bug', label: 'Bug' }, { key: 'question', label: 'Question' }], areas: [{ key: 'b2b', label: 'B2B' }], tickets: [] };
    _featureOv = { role: {}, user: { 'projects-request': { 'browser check': false } } };
    try {
        _ideaFillLists();
        return (opts('ideaType').join(',') === 'bug,question' && opts('ideaArea').join(',') === ',b2b') || opts('ideaType') + ' / ' + opts('ideaArea');
    } finally { _featureOv = { role: {}, user: {} }; _ideaData = null; }
});
t('project: offered to someone who can request a project, not to anyone else', function () {
    _featureOv = { role: {}, user: { 'projects-request': { 'browser check': true } } };
    try {
        ideaFresh();
        if (opts('ideaType').indexOf(IDEA_PROJECT) === -1) return 'not offered to a requester';
        _featureOv = { role: {}, user: { 'projects-request': { 'browser check': false } } };
        ideaFresh();
        return opts('ideaType').indexOf(IDEA_PROJECT) === -1 || 'offered without projects-request';
    } finally { _featureOv = { role: {}, user: {} }; }
});
t('project: choosing it hides Area and the file, and relabels the button', function () {
    _featureOv = { role: {}, user: { 'projects-request': { 'browser check': true } } };
    try {
        ideaFresh();
        document.getElementById('ideaType').value = IDEA_PROJECT;
        ideaTypeChanged();
        if (document.getElementById('ideaAreaWrap').style.display !== 'none') return 'Area still shown';
        if (document.getElementById('ideaFile').parentElement.style.display !== 'none') return 'file still shown';
        if (document.getElementById('ideaProjectNote').style.display === 'none') return 'no explanation';
        var b = document.getElementById('submitIdeaBtn').textContent;
        if (b !== 'Open the Project Request') return 'button: ' + b;
        document.getElementById('ideaType').value = 'bug';
        ideaTypeChanged();
        return document.getElementById('submitIdeaBtn').textContent === 'Submit Ticket' || 'button did not come back';
    } finally { _featureOv = { role: {}, user: {} }; }
});
t('project: submitting it sends no ticket — it carries the text to Projects', function () {
    _featureOv = { role: {}, user: { 'projects-request': { 'browser check': true } } };
    // On the Workspace already: switch tab rather than navigate (navigating
    // would take the harness with it).
    var wrap = document.createElement('div'); wrap.className = 'ws-wrap'; document.body.appendChild(wrap);
    var realSwitch = switchWorkspaceTab, switched = null;
    switchWorkspaceTab = function (n) { switched = n; };
    var sent = IDEA_SENT.length;
    try {
        ideaFresh();
        document.getElementById('ideaType').value = IDEA_PROJECT;
        document.getElementById('ideaDesc').value = 'A Chrome extension for eBay';
        withPin(function () { submitIdea(); });
        if (IDEA_SENT.length !== sent) return 'a ticket was posted';
        if (switched !== 'projects') return 'did not go to Projects (' + switched + ')';
        return sessionStorage.getItem('speeksPrjRequestDraft') === 'A Chrome extension for eBay' || 'draft not carried';
    } finally {
        switchWorkspaceTab = realSwitch; wrap.remove();
        sessionStorage.removeItem('speeksPrjRequestDraft');
        _featureOv = { role: {}, user: {} };
    }
});
t('projects: the carried text opens the request form, once', function () {
    var realNew = prjNew, opened = 0, realData = _prjData;
    var desc = document.createElement('textarea'); desc.id = 'prjFDesc'; document.body.appendChild(desc);
    prjNew = function () { opened++; };
    try {
        _prjData = { can: { request: true } };
        sessionStorage.setItem('speeksPrjRequestDraft', 'Build me a thing');
        _prjOpenDraft();
        _prjOpenDraft();
        if (opened !== 1) return 'opened ' + opened + ' times';
        if (desc.value !== 'Build me a thing') return 'description: ' + desc.value;
        _prjData = { can: { request: false } };
        sessionStorage.setItem('speeksPrjRequestDraft', 'Not allowed');
        _prjOpenDraft();
        if (opened !== 1) return 'opened for someone who cannot request';
        return sessionStorage.getItem('speeksPrjRequestDraft') === null || 'draft left behind';
    } finally {
        prjNew = realNew; _prjData = realData; desc.remove();
        sessionStorage.removeItem('speeksPrjRequestDraft');
    }
});
t('submit: no description, no post', function () {
    ideaFresh();
    var sent = IDEA_SENT.length;
    withPin(function () { submitIdea(); });
    if (IDEA_SENT.length !== sent) return 'posted an empty ticket';
    return /Describe/.test(document.getElementById('ideaError').textContent) || 'error: ' + document.getElementById('ideaError').textContent;
});
t('submit: no PIN, no post — and it says why', function () {
    ideaFresh();
    document.getElementById('ideaDesc').value = 'Something';
    var was = sessionStorage.getItem('speeksUserPin');
    sessionStorage.removeItem('speeksUserPin');
    var sent = IDEA_SENT.length;
    try { submitIdea(); } finally { if (was !== null) sessionStorage.setItem('speeksUserPin', was); }
    if (IDEA_SENT.length !== sent) return 'posted without a PIN (it would land on the old email-only path)';
    return /PIN/.test(document.getElementById('ideaError').textContent) || 'error: ' + document.getElementById('ideaError').textContent;
});
function mineStage(tickets, me) {
    ideaFresh();
    _ideaData = { me: me || { name: 'Browser Check', test: false }, types: [{ key: 'bug', label: 'Bug' }], areas: [{ key: 'b2b', label: 'B2B' }], tickets: tickets };
    var r;
    withPin(function () { _ideaRenderMine(); r = document.getElementById('ideaMineBody'); });
    return r;
}
t('my tickets: each status in the submitter\'s words', function () {
    var now = new Date().toISOString();
    var b = mineStage([
        { id: 1001, title: 'A', type: 'bug', area: 'b2b', status: 'triage', created_at: now },
        { id: 1002, title: 'B', type: 'bug', area: null, status: 'in_progress', created_at: now },
        { id: 1003, title: 'C', type: 'bug', area: null, status: 'on_prerelease', created_at: now },
    ]);
    var chips = Array.prototype.map.call(b.querySelectorAll('.prj-chip'), function (c) { return c.textContent; }).join(',');
    return chips === 'Waiting for review,Being worked on,Being tested' || chips;
});
t("my tickets: Won't do shows why", function () {
    var b = mineStage([{ id: 1004, title: 'D', type: 'bug', area: 'b2b', status: 'wont_do', reason: 'Already on the eBay page', created_at: new Date().toISOString() }]);
    var w = b.querySelector('.idea-mine-why');
    return (w && /Already on the eBay page/.test(w.textContent)) || 'no reason shown';
});
t('my tickets: escapes what people typed', function () {
    var b = mineStage([{ id: 1005, title: '<img src=x onerror=alert(1)>', type: 'bug', area: null, status: 'triage', created_at: new Date().toISOString() }]);
    return !b.querySelector('img') || 'a title became markup';
});
t('my tickets: empty, and a test account, each say something', function () {
    var b = mineStage([]);
    if (!/Nothing yet/.test(b.textContent)) return 'empty: ' + b.textContent;
    b = mineStage([], { name: 'Test DM', test: true });
    return /Test accounts/.test(b.textContent) || 'test: ' + b.textContent;
});

// ---- the two that wait on an answer: LAST, and chained ----------------------
// Every test above runs synchronously in one block and rebuilds the popup; an
// answer resolves after all of them. So these run at the end, one after the
// other, on a popup nothing else touches, and the cleanup waits for them.
var SUBMIT_DONE = (function () {
    ideaFresh();
    document.getElementById('ideaType').value = 'suggestion';
    document.getElementById('ideaArea').value = 'b2b';
    document.getElementById('ideaDesc').value = 'Sort the B2B list by brand';
    var sent = IDEA_SENT.length;
    var p = withPin(function () { return submitIdea(); });
    return { sent: sent, done: p };
})();
t('submit: posts the fields with the PIN, then shows the ticket number', function () {
    var post = IDEA_SENT[SUBMIT_DONE.sent];
    if (!post || post.opts.method !== 'POST') return 'nothing posted';
    if ((post.opts.headers || {})['x-user-pin'] !== '9999') return 'no x-user-pin header';
    var fd = post.opts.body;
    if (fd.get('Type') !== 'suggestion' || fd.get('Area') !== 'b2b' || fd.get('Description') !== 'Sort the B2B list by brand') {
        return 'body: ' + fd.get('Type') + ' / ' + fd.get('Area') + ' / ' + fd.get('Description');
    }
    return SUBMIT_DONE.done.then(function () {
        if (document.getElementById('ideaForm').style.display !== 'none') return 'form still showing';
        var h = document.getElementById('ideaSuccessHead').textContent;
        return h === 'SN-1234 Submitted!' || 'heading: ' + h;
    });
});
var REFUSAL_DONE = SUBMIT_DONE.done.then(function () {
    _ideaResetForm();
    document.getElementById('ideaDesc').value = 'Test account try';
    IDEA_ANSWER = { success: false, error: "Test accounts can't submit tickets." };
    return withPin(function () { return submitIdea(); });
});
t('submit: a refusal is shown, never "Submitted"', function () {
    return REFUSAL_DONE.then(function () {
        if (document.getElementById('ideaSuccess').style.display !== 'none') return 'showed Submitted';
        return /Test accounts/.test(document.getElementById('ideaError').textContent) || 'error: ' + document.getElementById('ideaError').textContent;
    });
});
// Leave nothing behind for the page's own init.
REFUSAL_DONE.then(function () { var m = document.getElementById('ideaModal'); if (m) m.remove(); _ideaData = null; });
