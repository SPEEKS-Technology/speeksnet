// PROJECTS — behaviour checks for speeks.js "24b. MODULE: PROJECTS"
// (the Projects tab of workspace.html).
//
//   powershell -File scripts/browser-check.ps1 projects-check.js
//
// What the list draws, which buttons each person gets in each state, the
// roster-backed "Who's involved" picker, and that the note rules stop a bad
// decision before it reaches the network. Layout is projects-layout-check.js;
// the real workspace.html markup is projects-page-check.js.
//
// The server re-checks every permission (supabase/functions/projects), so these
// guard what is DRAWN — a button the function would refuse is still a bug,
// because it reads as "you can do this" and then fails.

// Deterministic Feature Access: no overrides unless a test sets one.
_featureOv = { role: {}, user: {} };

var DAY = 86400000;
function ago(days) { return new Date(Date.now() - days * DAY).toISOString(); }

// users.id values. Real ones are uuids; anything unique will do here.
var ALEX = 'u-alex', SAM = 'u-sam', KIM = 'u-kim', ETHAN = 'u-ethan', PAT = 'u-pat', GONE = 'u-gone';
var PEOPLE = [
    { id: ALEX,  name: 'Alex OVL',  store: 'OVL',  role: 'manager' },
    { id: ETHAN, name: 'Ethan',     store: 'CORP', role: 'district manager' },
    { id: KIM,   name: 'Kim WSP',   store: 'WSP',  role: 'manager' },
    { id: PAT,   name: 'Pat Viewer', store: 'CORP', role: 'ceo' },
    { id: SAM,   name: 'Sam LEE',   store: 'LEE',  role: 'owner (manager)' },
];
var IDS = { 'Alex OVL': ALEX, 'Sam LEE': SAM, 'Kim WSP': KIM, 'Ethan': ETHAN, 'Pat Viewer': PAT };
function ref(name) { return { id: IDS[name], name: name }; }

function fixture(me, can) {
    return {
        me: { id: IDS[me.trim()] || null, name: me, role: 'manager' },
        can: can,
        people: PEOPLE,
        projects: [
            { id: 1, title: 'Reprice helper', description: 'Drafts prices', status: 'requested', requested_by: 'Alex OVL', requested_by_id: ALEX, involved: [ref('Alex OVL')], created_at: ago(3), updated_at: ago(3) },
            { id: 2, title: 'Old request', description: 'x', status: 'requested', requested_by: 'Sam LEE', requested_by_id: SAM, involved: [ref('Sam LEE')], created_at: ago(9), updated_at: ago(9) },
            { id: 3, title: 'Sent back', description: 'x', status: 'changes_requested', requested_by: 'Alex OVL', requested_by_id: ALEX, involved: [ref('Alex OVL')], decided_by: 'Ethan', decision_note: 'Say what it costs', created_at: ago(5), updated_at: ago(1) },
            { id: 4, title: 'FB extension', description: 'Cross-post', status: 'in_progress', requested_by: 'Sam LEE', requested_by_id: SAM, involved: [ref('Sam LEE'), ref('Kim WSP'), { id: GONE, name: 'Left Company' }], created_at: ago(20), updated_at: ago(2), started_at: ago(10), decided_by: 'Ethan' },
            { id: 5, title: 'Paused thing', description: 'x', status: 'parked', requested_by: 'Alex OVL', requested_by_id: ALEX, involved: [ref('Alex OVL')], created_at: ago(30), updated_at: ago(4) },
            { id: 6, title: 'Capture tool', description: 'x', status: 'completed', outcome: 'incorporate', requested_by: 'Sam LEE', requested_by_id: SAM, involved: [ref('Sam LEE')], created_at: ago(60), updated_at: ago(6), completed_at: ago(6) },
            { id: 7, title: 'No thanks', description: 'x', status: 'declined', requested_by: 'Sam LEE', requested_by_id: SAM, involved: [ref('Sam LEE')], decision_note: 'Not now', created_at: ago(40), updated_at: ago(39) },
            { id: 8, title: 'Changed my mind', description: 'x', status: 'withdrawn', requested_by: 'Alex OVL', requested_by_id: ALEX, involved: [ref('Alex OVL')], created_at: ago(41), updated_at: ago(40) },
        ],
        events: [
            { id: 1, project_id: 4, kind: 'created', actor: 'Sam LEE', created_at: ago(20) },
            { id: 2, project_id: 4, kind: 'approved', actor: 'Ethan', note: 'Go for it', created_at: ago(10) },
        ],
    };
}

// The pane's own pieces, built here because these assert about the renderer's
// output; the page's real markup is projects-page-check.js's job.
function pane() {
    var host = document.getElementById('prj-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'prj-host';
        host.innerHTML = '<span id="prjWaitPip"></span><span id="prjSubtitle"></span><button id="prjNewBtn"></button><div id="prjBody"></div>';
        document.body.appendChild(host);
    }
    return host;
}
function load(me, can, view) {
    pane();
    _prjData = fixture(me, can);
    _prjView = view || null;
    prjRender();
}
function rowIds() {
    return Array.prototype.map.call(document.querySelectorAll('#prjBody .prj-table tbody .prj-id'), function (e) { return e.textContent; }).join(',');
}
function segLabels() {
    return Array.prototype.map.call(document.querySelectorAll('#prjBody .prj-seg-btn'), function (b) { return b.textContent.trim(); });
}
// seesAll mirrors the function: only the DM (projects-approve) gets every
// project; everyone else is sent just the ones they asked for or are on.
var VIEWER   = { view: true, request: false, approve: false, seesAll: false };
var MANAGER  = { view: true, request: true,  approve: false, seesAll: false };
var APPROVER = { view: true, request: true,  approve: true,  seesAll: true };

// ---- the list ------------------------------------------------------------------

t('list: no "Mine only" switch any more', function () {
    load('Pat Viewer', VIEWER);
    return !/mine only/i.test(document.getElementById('prjBody').textContent) || 'Mine only is still drawn';
});
t('list: the status filter counts each group', function () {
    load('Pat Viewer', VIEWER);
    var got = segLabels().join(' | ');
    return got === 'Awaiting Approval · 3 | In Progress · 2 | Completed · 1 | Closed · 2' || got;
});
t('list: lands on the first group with something in it', function () {
    load('Pat Viewer', VIEWER);
    var on = document.querySelector('#prjBody .prj-seg-btn.on');
    return (on && /Awaiting Approval/.test(on.textContent)) || 'landed on ' + (on && on.textContent);
});
t('list: waiting requests, longest-waiting first', function () {
    load('Pat Viewer', VIEWER, 'approval');
    return rowIds() === 'PRJ-2,PRJ-3,PRJ-1' || 'rows ' + rowIds();
});
t('list: switching the filter shows that group', function () {
    load('Pat Viewer', VIEWER);
    prjSetView('active');
    var a = rowIds();
    prjSetView('closed');
    var c = rowIds();
    return (a === 'PRJ-4,PRJ-5' && c === 'PRJ-7,PRJ-8') || 'active ' + a + ' / closed ' + c;
});
t('list: an empty group says so instead of drawing an empty table', function () {
    pane();
    _prjData = fixture('Pat Viewer', VIEWER);
    _prjData.projects = _prjData.projects.filter(function (p) { return p.status !== 'completed'; });
    _prjView = 'done';
    prjRender();
    return (!document.querySelector('#prjBody .prj-table') && /Nothing of yours finished yet/.test(document.getElementById('prjBody').textContent)) || 'empty group drew a table';
});
// "DM can see all of the projects. Everyone else can only see projects they are
// involved in." The filtering is the function's; the page has to SAY which
// list this is, or an empty one reads as "nobody has any projects".
t('list: the DM gets no district note under the tabs (header says it), and a Waiting on You count', function () {
    load('Ethan', APPROVER);
    var meta = document.getElementById('prjSubtitle').textContent;
    var noteEl = document.querySelector('#prjBody .prj-seg-note');
    return (!noteEl && /Waiting on You/.test(meta)) || 'note "' + (noteEl && noteEl.textContent) + '" meta "' + meta + '"';
});
// CEO and MOCD see every project too, by role ("not a switch"), but don't
// decide — so no "waiting on you", just how many there are.
t('list: the CEO / MOCD see every project, counted, with nothing "waiting on you"', function () {
    load('Pat Viewer', { view: true, request: false, approve: false, seesAll: true });
    var noteEl = document.querySelector('#prjBody .prj-seg-note');
    var meta = document.getElementById('prjSubtitle').textContent;
    return (!noteEl && meta === '8 projects') || 'note "' + (noteEl && noteEl.textContent) + '" meta "' + meta + '"';
});
t('list: everyone else is told it is only their own projects', function () {
    load('Alex OVL', MANAGER);
    var note = document.querySelector('#prjBody .prj-seg-note').textContent;
    var meta = document.getElementById('prjSubtitle').textContent;
    return (/you asked for or are part of/.test(note) && /of yours$/.test(meta)) || 'note "' + note + '" meta "' + meta + '"';
});
t('list: the DM\'s empty groups do not say "of yours"', function () {
    pane();
    _prjData = fixture('Ethan', APPROVER);
    _prjData.projects = [];
    _prjView = 'active';
    prjRender();
    var txt = document.getElementById('prjBody').textContent;
    return (/Nothing under way/.test(txt) && !/of yours/.test(txt)) || txt.trim();
});
t('list: each row shows who is involved as names', function () {
    load('Pat Viewer', VIEWER, 'active');
    var tags = Array.prototype.map.call(document.querySelectorAll('#prjBody tbody tr:first-child .prj-tag'), function (e) { return e.textContent; }).join(',');
    return tags === 'Sam LEE,Kim WSP,Left Company' || 'tags ' + tags;
});
t('list: a completed project shows what happens to it next', function () {
    load('Pat Viewer', VIEWER, 'done');
    var chip = document.querySelector('#prjBody .prj-chip');
    return (chip && /Fold into SPEEKSNET/.test(chip.textContent)) || 'chip ' + (chip && chip.textContent);
});
t('list: the request button shows only to someone who can request', function () {
    load('Pat Viewer', VIEWER);
    var hidden = document.getElementById('prjNewBtn').style.display === 'none';
    load('Alex OVL', MANAGER);
    var shown = document.getElementById('prjNewBtn').style.display !== 'none';
    return (hidden && shown) || 'viewer hidden=' + hidden + ', manager shown=' + shown;
});
t('list: the DM\'s tab pip counts the requests waiting on them', function () {
    load('Ethan', APPROVER);
    var pip = document.getElementById('prjWaitPip');
    return (pip.textContent === '2' && pip.style.display !== 'none') || 'pip "' + pip.textContent + '" display ' + pip.style.display;
});
t('list: a requester\'s pip counts the request sent back to them', function () {
    load('Alex OVL', MANAGER);
    return document.getElementById('prjWaitPip').textContent === '1' || 'pip "' + document.getElementById('prjWaitPip').textContent + '"';
});
t('list: titles and descriptions are escaped', function () {
    pane();
    _prjData = fixture('Pat Viewer', VIEWER);
    _prjData.projects[0].title = '<img src=x onerror="window.__prjXss=1">';
    _prjData.projects[0].description = '<b id="prjXssB">x</b>';
    _prjView = 'approval';
    prjRender();
    return (!document.querySelector('#prjBody img') && !document.getElementById('prjXssB') && !window.__prjXss) || 'raw HTML reached the DOM';
});

// ---- who gets which buttons (by users.id) ---------------------------------------

function actions(me, can, id) {
    _prjData = fixture(me, can);
    var html = _prjActionsHtml(_prjById(id));
    var acts = [];
    html.replace(/prjAct\('([a-z_]+)'/g, function (_, a) { acts.push(a); });
    if (/prjEdit\(/.test(html)) acts.push('edit');
    if (/id="prjOutcome"/.test(html)) acts.push('outcome-picker');
    return acts.sort().join(',');
}
function expect(got, want) { return got === want || 'got [' + got + '], want [' + want + ']'; }

t('actions: the DM on a fresh request — approve, decline, ask for changes', function () {
    return expect(actions('Ethan', APPROVER, 2), 'approve,decline,delete,request_changes');
});
t('actions: the requester on their own fresh request — edit or withdraw, no decision', function () {
    return expect(actions('Alex OVL', MANAGER, 1), 'edit,withdraw');
});
t('actions: someone else on a fresh request — nothing to press', function () {
    return expect(actions('Pat Viewer', VIEWER, 1), '');
});
t('actions: a request sent back — the requester edits and resubmits', function () {
    return expect(actions('Alex OVL', MANAGER, 3), 'edit,withdraw');
});
t('actions: a request sent back — the DM can still decline it, not approve it', function () {
    return expect(actions('Ethan', APPROVER, 3), 'decline,delete');
});
t('actions: someone involved in a running project posts updates or sends it for sign-off — no edit, no complete', function () {
    return expect(actions('Kim WSP', MANAGER, 4), 'request_signoff,update');
});
t('actions: whoever asked for a running project can still edit it', function () {
    return expect(actions('Sam LEE', MANAGER, 4), 'edit,request_signoff,update');
});
t('actions: the DM on a running project — edit, update, park, complete', function () {
    return expect(actions('Ethan', APPROVER, 4), 'complete,delete,edit,park,update');
});
t('actions: the DM on a parked project — resume rather than park', function () {
    return expect(actions('Ethan', APPROVER, 5), 'complete,delete,edit,resume,update');
});
t('actions: the DM on a completed project — decides what happens to it', function () {
    return expect(actions('Ethan', APPROVER, 6), 'delete,outcome,outcome-picker');
});
t('actions: anyone else on a completed project — nothing to press', function () {
    return expect(actions('Sam LEE', MANAGER, 6), '');
});
t('actions: declined is final — nothing but the DM\'s Delete', function () {
    return expect(actions('Ethan', APPROVER, 7) + '|' + actions('Sam LEE', MANAGER, 7), 'delete|');
});
// The point of real users: identity is the id, not the spelling.
t('actions: a different person who happens to share a name is NOT the requester', function () {
    _prjData = fixture('Alex OVL', MANAGER);
    _prjData.me = { id: 'u-someone-else', name: 'Alex OVL' };
    var html = _prjActionsHtml(_prjById(1));
    return !/withdraw/.test(html) || 'a namesake got the requester\'s buttons';
});
t('actions: a renamed requester keeps their buttons (same id, new name)', function () {
    _prjData = fixture('Alex OVL', MANAGER);
    _prjData.me = { id: ALEX, name: 'Alexandra OVL' };
    return /withdraw/.test(_prjActionsHtml(_prjById(1))) || 'lost the buttons on a rename';
});
t('actions: with no id on either side, the name decides (test accounts)', function () {
    _prjData = fixture('Alex OVL', MANAGER);
    _prjData.me = { id: null, name: ' alex ovl ' };
    return /withdraw/.test(_prjActionsHtml(_prjById(1))) || 'name fallback failed';
});

// ---- note rules are enforced before the network ---------------------------------

function detailDom() {
    var host = document.getElementById('prj-detail-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'prj-detail-host';
        document.body.appendChild(host);
    }
    host.innerHTML = '<div id="prjDetailEyebrow"></div><div id="prjDetailHead"></div><div id="prjDetailSub"></div>'
        + '<div id="prjDetailBody"></div><div id="prjDetailFooter"></div>';
    return host;
}
function openDetail(me, can, id) {
    detailDom();
    _prjData = fixture(me, can);
    _prjOpenId = id;
    _prjRenderDetail();
}

t('decide: declining without a reason is stopped, and nothing is sent', function () {
    openDetail('Ethan', APPROVER, 2);
    var before = window.__fetches.length;
    prjAct('decline');
    var msg = (document.getElementById('prjMsg') || {}).textContent || '';
    if (window.__fetches.length !== before) return 'a request went out without a note';
    return /why/i.test(msg) || 'message was "' + msg + '"';
});
t('decide: asking for changes without saying what is stopped', function () {
    openDetail('Ethan', APPROVER, 2);
    var before = window.__fetches.length;
    prjAct('request_changes');
    return window.__fetches.length === before || 'a request went out without a note';
});
t('decide: an outcome must be picked before it saves', function () {
    openDetail('Ethan', APPROVER, 6);
    document.getElementById('prjOutcome').value = '';
    var before = window.__fetches.length;
    prjAct('outcome');
    return window.__fetches.length === before || 'saved with no outcome';
});
t('detail: the DM\'s reason sits at the top of a sent-back request', function () {
    openDetail('Alex OVL', MANAGER, 3);
    var c = document.querySelector('#prjDetailBody .prj-callout');
    return (c && /Say what it costs/.test(c.textContent)) || 'no callout with the decision note';
});
t('detail: lists everyone involved, including someone who has left', function () {
    openDetail('Pat Viewer', VIEWER, 4);
    var tags = Array.prototype.map.call(document.querySelectorAll('#prjDetailBody .prj-tag'), function (e) { return e.textContent; }).join(',');
    return tags === 'Sam LEE,Kim WSP,Left Company' || 'tags ' + tags;
});
t('detail: history is newest first', function () {
    openDetail('Pat Viewer', VIEWER, 4);
    var first = document.querySelector('.prj-timeline .prj-ev');
    return (first && /approved/.test(first.textContent)) || 'first entry: ' + (first && first.textContent);
});

// ---- request form + the roster picker -------------------------------------------

function formDom() {
    var host = document.getElementById('prj-form-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'prj-form-host';
        document.body.appendChild(host);
    }
    host.innerHTML = '<div id="prjFormModal" class="show"><span id="prjFormTitle"></span><span id="prjFormSub"></span>'
        + '<input id="prjFTitle"><textarea id="prjFDesc"></textarea>'
        + '<div id="prjFPeople"><span id="prjFChips"></span><input id="prjFPeopleInput"></div><div id="prjFPeopleMenu" hidden></div>'
        + '<span id="prjFormMsg"></span><button id="prjFormSubmit"></button></div>';
    return host;
}
function openForm(me, can, p) {
    formDom();
    _prjData = fixture(me, can);
    _prjEditId = p ? p.id : null;
    _prjFillForm(p || null);
}
function chips() {
    return Array.prototype.map.call(document.querySelectorAll('#prjFChips .prj-chip-pick'), function (c) { return c.firstChild.textContent; }).join(',');
}
function menuNames() {
    return Array.prototype.map.call(document.querySelectorAll('#prjFPeopleMenu .prj-people-opt span'), function (s) { return s.textContent; }).join(',');
}

t('form: no title, no request', function () {
    openForm('Alex OVL', MANAGER);
    document.getElementById('prjFDesc').value = 'Something';
    var before = window.__fetches.length;
    prjSubmitForm();
    var msg = document.getElementById('prjFormMsg').textContent;
    return (window.__fetches.length === before && /title/i.test(msg)) || 'sent=' + (window.__fetches.length !== before) + ' msg="' + msg + '"';
});
t('form: no description, no request', function () {
    openForm('Alex OVL', MANAGER);
    document.getElementById('prjFTitle').value = 'A thing';
    var before = window.__fetches.length;
    prjSubmitForm();
    var msg = document.getElementById('prjFormMsg').textContent;
    return (window.__fetches.length === before && /describe/i.test(msg)) || 'sent=' + (window.__fetches.length !== before) + ' msg="' + msg + '"';
});
t('form: nobody involved, no request', function () {
    openForm('Alex OVL', MANAGER);
    document.getElementById('prjFTitle').value = 'A thing';
    document.getElementById('prjFDesc').value = 'Why';
    prjPeopleRemove(ALEX);
    var before = window.__fetches.length;
    prjSubmitForm();
    var msg = document.getElementById('prjFormMsg').textContent;
    return (window.__fetches.length === before && /involved/i.test(msg)) || 'sent=' + (window.__fetches.length !== before) + ' msg="' + msg + '"';
});
t('picker: a new request starts with me picked', function () {
    openForm('Alex OVL', MANAGER);
    return (chips() === 'Alex OVL' && _prjPicked.join() === ALEX) || 'chips ' + chips() + ' picked ' + _prjPicked.join();
});
t('picker: editing starts with everyone still on the roster', function () {
    openForm('Sam LEE', MANAGER, fixture('Sam LEE', MANAGER).projects[3]);
    return _prjPicked.join() === [SAM, KIM].join() || 'picked ' + _prjPicked.join() + ' (someone who left cannot be re-attached)';
});
t('picker: typing filters the roster by name, store or role', function () {
    openForm('Alex OVL', MANAGER);
    document.getElementById('prjFPeopleInput').value = 'wsp';
    prjPeopleSearch();
    var byStore = menuNames();
    document.getElementById('prjFPeopleInput').value = 'district';
    prjPeopleSearch();
    var byRole = menuNames();
    return (byStore === 'Kim WSP' && byRole === 'Ethan') || 'store→' + byStore + ' role→' + byRole;
});
t('picker: someone already picked is not offered again', function () {
    openForm('Alex OVL', MANAGER);
    document.getElementById('prjFPeopleInput').value = '';
    prjPeopleSearch();
    return menuNames().indexOf('Alex OVL') === -1 || 'Alex offered twice: ' + menuNames();
});
t('picker: Enter adds the highlighted match and clears the box', function () {
    openForm('Alex OVL', MANAGER);
    var input = document.getElementById('prjFPeopleInput');
    input.value = 'kim';
    prjPeopleSearch();
    prjPeopleKey({ key: 'Enter', preventDefault: function () {}, target: input });
    return (chips() === 'Alex OVL,Kim WSP' && input.value === '') || 'chips ' + chips() + ' box "' + input.value + '"';
});
t('picker: Backspace in an empty box removes the last person', function () {
    openForm('Alex OVL', MANAGER);
    prjPeopleAdd(SAM);
    var input = document.getElementById('prjFPeopleInput');
    input.value = '';
    prjPeopleKey({ key: 'Backspace', preventDefault: function () {}, target: input });
    return chips() === 'Alex OVL' || 'chips ' + chips();
});
t('picker: only people on the roster can be added', function () {
    openForm('Alex OVL', MANAGER);
    prjPeopleAdd('u-not-on-roster');
    return _prjPicked.join() === ALEX || 'picked ' + _prjPicked.join();
});
t('picker: names in chips and options are escaped', function () {
    openForm('Alex OVL', MANAGER);
    _prjData.people = _prjData.people.concat([{ id: 'u-x', name: '<img src=x onerror="window.__prjXss2=1">', store: 'OVL', role: 'manager' }]);
    prjPeopleAdd('u-x');
    document.getElementById('prjFPeopleInput').value = '';
    prjPeopleSearch();
    return (!document.querySelector('#prj-form-host img') && !window.__prjXss2) || 'raw HTML from a name reached the DOM';
});
t('form: resubmitting shows what the DM asked for', function () {
    openForm('Alex OVL', MANAGER, fixture('Alex OVL', MANAGER).projects[2]);
    var sub = document.getElementById('prjFormSub').textContent;
    var go = document.getElementById('prjFormSubmit').textContent;
    return (/Say what it costs/.test(sub) && go === 'Resubmit') || 'sub "' + sub + '", button "' + go + '"';
});

// ---- sign-off: the DM approves a finished project too (0187) --------------------
// Ethan, 2026-11-18: "submit a tool for final approval". The people on a running
// project send it for sign-off; the DM approves it as complete or sends it back.
// The base fixture is left alone (other tests count it); these flip project 4
// (Sam asked, Kim involved) into the state under test.

function signoffFixture(me, can, status, extraEvents) {
    _prjData = fixture(me, can);
    var p = _prjById(4);
    p.status = status;
    if (status === 'in_progress' && extraEvents) {
        p.decided_by = 'Ethan';
        p.decision_note = 'The export button is still missing';
    }
    _prjData.events = _prjData.events.concat(extraEvents || []);
    return p;
}
function signoffActions(me, can, status) {
    signoffFixture(me, can, status);
    var html = _prjActionsHtml(_prjById(4));
    var acts = [];
    html.replace(/prjAct\('([a-z_]+)'/g, function (_, a) { acts.push(a); });
    if (/prjEdit\(/.test(html)) acts.push('edit');
    return acts.sort().join(',');
}

t('sign-off: someone involved in a running project can send it for sign-off', function () {
    return expect(signoffActions('Kim WSP', MANAGER, 'in_progress'), 'request_signoff,update');
});
t('sign-off: whoever asked can send it for sign-off too', function () {
    return expect(signoffActions('Sam LEE', MANAGER, 'in_progress'), 'edit,request_signoff,update');
});
t('sign-off: the DM is not offered it — he completes it himself', function () {
    return expect(signoffActions('Ethan', APPROVER, 'in_progress'), 'complete,delete,edit,park,update');
});
t('sign-off: a parked project is resumed before it can be sent', function () {
    return expect(actions('Alex OVL', MANAGER, 5), 'edit,update');
});
t('sign-off: someone not on the project cannot send it', function () {
    return expect(signoffActions('Alex OVL', MANAGER, 'in_progress'), '');
});
t('sign-off: the DM on a finished project — approve as complete, send back, edit, update', function () {
    return expect(signoffActions('Ethan', APPROVER, 'awaiting_signoff'), 'complete,delete,edit,return_signoff,update');
});
t('sign-off: the requester waiting on sign-off can still edit and post updates, not decide', function () {
    return expect(signoffActions('Sam LEE', MANAGER, 'awaiting_signoff'), 'edit,update');
});
t('sign-off: someone involved waiting on sign-off can post updates only', function () {
    return expect(signoffActions('Kim WSP', MANAGER, 'awaiting_signoff'), 'update');
});
t('sign-off: a viewer gets nothing to press', function () {
    return expect(signoffActions('Pat Viewer', VIEWER, 'awaiting_signoff'), '');
});
t('sign-off: it waits in Awaiting Approval, and counts on the DM\'s pip', function () {
    pane();
    signoffFixture('Ethan', APPROVER, 'awaiting_signoff');
    _prjView = 'approval';
    prjRender();
    var ids = rowIds();
    var pip = document.getElementById('prjWaitPip').textContent;
    var chip = Array.prototype.some.call(document.querySelectorAll('#prjBody .prj-chip'), function (c) { return c.textContent === 'Awaiting Sign-Off'; });
    return (ids.indexOf('PRJ-4') !== -1 && pip === '3' && chip) || 'rows ' + ids + ', pip ' + pip + ', chip ' + chip;
});
t('sign-off: it is not counted against the requester — it is waiting on the DM', function () {
    pane();
    signoffFixture('Sam LEE', MANAGER, 'awaiting_signoff');
    _prjView = null;
    prjRender();
    var pip = document.getElementById('prjWaitPip');
    return (pip.style.display === 'none' || pip.textContent === '0') || 'Sam\'s pip shows ' + pip.textContent;
});
t('sign-off: sending it back without saying what is left is stopped, and nothing is sent', function () {
    // The form tests above leave their stand-in popup marked open, and _prjSay
    // writes to whichever popup is open — close it, as the real page would be.
    var form = document.getElementById('prjFormModal');
    if (form) form.classList.remove('show');
    detailDom();
    signoffFixture('Ethan', APPROVER, 'awaiting_signoff');
    _prjOpenId = 4;
    _prjRenderDetail();
    var before = window.__fetches.length;
    prjAct('return_signoff');
    var msg = (document.getElementById('prjMsg') || {}).textContent || '';
    return (window.__fetches.length === before && /still needs doing/.test(msg)) || 'sent=' + (window.__fetches.length !== before) + ' msg="' + msg + '"';
});
t('sign-off: once sent back, the DM\'s note leads the popup', function () {
    detailDom();
    signoffFixture('Sam LEE', MANAGER, 'in_progress', [
        { id: 3, project_id: 4, kind: 'signoff_requested', actor: 'Sam LEE', created_at: ago(1) },
        { id: 4, project_id: 4, kind: 'signoff_returned', actor: 'Ethan', note: 'The export button is still missing', created_at: ago(0) },
    ]);
    _prjOpenId = 4;
    _prjRenderDetail();
    var c = document.querySelector('#prjDetailBody .prj-callout');
    var hist = document.querySelector('.prj-timeline .prj-ev');
    return (c && /sent it back/.test(c.textContent) && /export button/.test(c.textContent) && hist && /sent it back/.test(hist.textContent))
        || 'callout "' + (c && c.textContent) + '", newest history "' + (hist && hist.textContent) + '"';
});
t('sign-off: the note stops leading once work moves on (an update after it)', function () {
    detailDom();
    signoffFixture('Sam LEE', MANAGER, 'in_progress', [
        { id: 4, project_id: 4, kind: 'signoff_returned', actor: 'Ethan', note: 'x', created_at: ago(1) },
        { id: 5, project_id: 4, kind: 'update', actor: 'Sam LEE', note: 'Added it', created_at: ago(0) },
    ]);
    _prjOpenId = 4;
    _prjRenderDetail();
    return !document.querySelector('#prjDetailBody .prj-callout') || 'stale callout still drawn';
});

// ---- capitalization: Title Case on buttons, tabs, chips (Ethan, 2026-11-18) -----
// "Edit and Resubmit", not "Edit and resubmit". Short joining words stay lower.

var MINOR = { a: 1, an: 1, and: 1, as: 1, at: 1, by: 1, for: 1, in: 1, into: 1, of: 1, on: 1, or: 1, the: 1, to: 1 };
function notTitleCase(label) {
    return String(label).replace(/[·\d＋+]/g, ' ').split(/[\s]+/).filter(Boolean).some(function (w, i) {
        var first = w.split('-').some(function (part) { return /^[a-z]/.test(part) && !(i > 0 && MINOR[part]); });
        return first;
    });
}
function buttonLabels(html) {
    var out = [];
    html.replace(/<button[^>]*>([^<]+)<\/button>/g, function (_, txt) { out.push(txt.trim()); });
    return out;
}

t('caps: every popup button is Title Case, in every state', function () {
    var bad = [];
    [['Ethan', APPROVER], ['Alex OVL', MANAGER], ['Sam LEE', MANAGER], ['Kim WSP', MANAGER]].forEach(function (who) {
        [1, 2, 3, 4, 5, 6].forEach(function (id) {
            _prjData = fixture(who[0], who[1]);
            buttonLabels(_prjActionsHtml(_prjById(id))).forEach(function (l) { if (notTitleCase(l)) bad.push(l); });
        });
        ['in_progress', 'awaiting_signoff'].forEach(function (s) {
            signoffFixture(who[0], who[1], s);
            buttonLabels(_prjActionsHtml(_prjById(4))).forEach(function (l) { if (notTitleCase(l)) bad.push(l); });
        });
    });
    return !bad.length || 'not Title Case: ' + bad.filter(function (l, i) { return bad.indexOf(l) === i; }).join(' | ');
});
t('caps: Ethan\'s example — "Edit and Resubmit"', function () {
    _prjData = fixture('Alex OVL', MANAGER);
    return /Edit and Resubmit/.test(_prjActionsHtml(_prjById(3))) || 'button text: ' + buttonLabels(_prjActionsHtml(_prjById(3))).join(' | ');
});
t('caps: status chips, filter tabs and outcomes are Title Case', function () {
    var labels = Object.keys(PRJ_STATUS).map(function (k) { return PRJ_STATUS[k].label; })
        .concat(PRJ_VIEWS.map(function (v) { return v.label; }))
        .concat(Object.keys(PRJ_OUTCOME).map(function (k) { return PRJ_OUTCOME[k]; }));
    var bad = labels.filter(notTitleCase);
    return !bad.length || 'not Title Case: ' + bad.join(' | ');
});
t('caps: the request form\'s button and titles are Title Case in all three modes', function () {
    var bad = [];
    [null, fixture('Alex OVL', MANAGER).projects[2], fixture('Sam LEE', MANAGER).projects[3]].forEach(function (p) {
        openForm('Alex OVL', MANAGER, p);
        ['prjFormTitle', 'prjFormSubmit'].forEach(function (id) {
            var txt = document.getElementById(id).textContent;
            if (notTitleCase(txt)) bad.push(txt);
        });
    });
    return !bad.length || 'not Title Case: ' + bad.join(' | ');
});

// ---- Feature Access: defaults, and the wiring that puts the tab in Workspace -----
// The projects edge function holds the same defaults (DEFAULTS there). If one of
// these fails after a deliberate change, change the function too.

function sees(key, role) { return _featureEffectiveVisible(key, 'role-' + role, 'Someone'); }

t('access: the tab is for store managers and up', function () {
    var yes = ['district-manager', 'ceo', 'mocd', 'manager', 'owner-manager'].filter(function (r) { return !sees('nav-projects', r); });
    var no = ['assistant-manager', 'employee', 'store'].filter(function (r) { return sees('nav-projects', r); });
    return (!yes.length && !no.length) || 'should see but cannot: ' + yes + ' | should not but can: ' + no;
});
t('access: store managers, MOCD and the DM can ask; the CEO and below-manager cannot', function () {
    var yes = ['district-manager', 'mocd', 'manager', 'owner-manager'].filter(function (r) { return !sees('projects-request', r); });
    var no = ['ceo', 'assistant-manager', 'employee', 'store'].filter(function (r) { return sees('projects-request', r); });
    return (!yes.length && !no.length) || 'should but cannot: ' + yes + ' | should not but can: ' + no;
});
t('access: only the DM decides by default', function () {
    var who = ['district-manager', 'ceo', 'mocd', 'manager', 'owner-manager', 'assistant-manager', 'employee']
        .filter(function (r) { return sees('projects-approve', r); });
    return who.join(',') === 'district-manager' || 'can approve: ' + who.join(',');
});
t('access: a per-person override hands approval to someone else', function () {
    _featureOv = { role: {}, user: { 'projects-approve': { 'cover person': true } } };
    var ok = _featureEffectiveVisible('projects-approve', 'role-manager', 'Cover Person') === true;
    _featureOv = { role: {}, user: {} };
    return ok || 'user override did not grant approval';
});
t('wiring: Projects earns the Workspace nav link (it is MOCD\'s only tab there)', function () {
    return (_SECTION_TABS['workspace.html'] || []).indexOf('nav-projects') !== -1 || 'nav-projects not in workspace.html section keys';
});
t('wiring: no trace of the old projects.html page', function () {
    var left = [];
    if (_SECTION_TABS['projects.html']) left.push('_SECTION_TABS');
    if (_FA_SHELLS.indexOf('projects.html') !== -1) left.push('_FA_SHELLS');
    if (_QP_PAGE_NAMES.projects) left.push('_QP_PAGE_NAMES');
    if (typeof initProjectsPage === 'function') left.push('initProjectsPage');
    return left.length === 0 || 'still wired: ' + left.join(', ');
});
t('wiring: a realtime ping refreshes an open list', function () {
    return ((_RT_TOOL_CHECKS.projects || []).indexOf('prjRealtimeRefresh') !== -1) || 'projects not in _RT_TOOL_CHECKS';
});
t('wiring: Jump search lands on the Workspace tab', function () {
    return JUMP_PLACES.some(function (p) { return p.page === 'workspace.html' && p.hash === 'projects' && p.kind === 'tab'; }) || 'no Jump entry for workspace.html#projects';
});

// ---- can't-undo actions: red, after Edit, press twice; DM can delete (2026-11-21) ----

function footBtn(action) {
    return document.querySelector('#prjDetailFooter button[onclick*="prjAct(\'' + action + '\'"]');
}
t('undo-proof: Withdraw is red and comes after Edit, not dressed as Cancel', function () {
    openDetail('Alex OVL', MANAGER, 1);
    var w = footBtn('withdraw');
    if (!w) return 'no Withdraw button';
    if (w.classList.contains('kpi-cancel-btn')) return 'Withdraw still wears kpi-cancel-btn';
    if (!w.classList.contains('prj-danger')) return 'Withdraw is not red';
    var html = document.getElementById('prjDetailFooter').innerHTML;
    return html.indexOf('prjEdit(') < html.indexOf("prjAct('withdraw'") || 'Withdraw comes before Edit';
});
t('undo-proof: the first press of Withdraw only arms it — nothing is sent', function () {
    openDetail('Alex OVL', MANAGER, 1);
    var w = footBtn('withdraw');
    var before = window.__fetches.length;
    prjAct('withdraw', w);
    var sent = window.__fetches.length !== before;
    var armed = /click again/i.test(w.textContent) && w.classList.contains('prj-armed');
    _prjDisarm(w);
    return (!sent && armed) || 'sent=' + sent + ' label="' + w.textContent + '"';
});
t('undo-proof: the second press of Withdraw sends it', function () {
    openDetail('Alex OVL', MANAGER, 1);
    var w = footBtn('withdraw');
    prjAct('withdraw', w);
    var before = window.__fetches.length;
    prjAct('withdraw', w);
    return window.__fetches.length > before || 'the second press sent nothing';
});
t('undo-proof: Decline and Mark Complete arm first too', function () {
    var bad = [];
    [['decline', 2], ['complete', 4]].forEach(function (c) {
        openDetail('Ethan', APPROVER, c[1]);
        var note = document.getElementById('prjNote'); if (note) note.value = 'reason';
        var b = footBtn(c[0]);
        var before = window.__fetches.length;
        prjAct(c[0], b);
        if (window.__fetches.length !== before) bad.push(c[0] + ' sent on the first press');
        if (b) _prjDisarm(b);
    });
    return bad.length === 0 || bad.join('; ');
});
t('undo-proof: Approve and Start and Post Update still go on one press', function () {
    openDetail('Ethan', APPROVER, 2);
    var before = window.__fetches.length;
    prjAct('approve', footBtn('approve'));
    return window.__fetches.length > before || 'approve waited for a second press';
});
t('delete: the DM gets Delete on every project, closed ones included (with a Close)', function () {
    var missing = [];
    for (var id = 1; id <= 8; id++) {
        openDetail('Ethan', APPROVER, id);
        if (!footBtn('delete')) missing.push('PRJ-' + id);
    }
    openDetail('Ethan', APPROVER, 7);
    var close = /closeAllModals\(\)/.test(document.getElementById('prjDetailFooter').innerHTML);
    return (missing.length === 0 && close) || 'no Delete on ' + missing.join(',') + (close ? '' : '; no Close on a declined one');
});
t('delete: managers never get Delete, even on their own request', function () {
    var shown = [];
    [1, 3, 5, 8].forEach(function (id) { openDetail('Alex OVL', MANAGER, id); if (footBtn('delete')) shown.push('PRJ-' + id); });
    return shown.length === 0 || 'Delete drawn for a manager on ' + shown.join(',');
});
