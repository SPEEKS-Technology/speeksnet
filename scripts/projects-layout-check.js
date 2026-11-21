// PROJECTS LAYOUT — does the Projects tab fit, at phone, tablet and desktop widths.
//
//   powershell -File scripts/browser-check.ps1 projects-layout-check.js
//   powershell -File scripts/browser-check.ps1 projects-layout-check.js -WindowSize 1440,900
//
// Measures with the real styles.css loaded (the runner links it). Run twice:
// media queries read the WINDOW, not the stage a check builds, so each run
// measures only the stage widths on its own side of the 900px line.
//
// "Broken" here = something wider than the frame that is not inside a wrapper
// built to scroll. The list's table sits in .prj-table-wrap, which scrolls
// sideways on purpose — that is allowed; the page itself growing is not.

_featureOv = { role: {}, user: {} };

function stage(width, html) {
    var host = document.getElementById('layout-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'layout-host';
        document.body.appendChild(host);
    }
    host.style.cssText = 'width:' + width + 'px;overflow:hidden;';
    host.innerHTML = html;
    void host.offsetHeight;
    return host;
}

function overflowing(host) {
    var bad = [];
    var limit = host.getBoundingClientRect().right;
    host.querySelectorAll('*').forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.width === 0) return;
        if (r.right > limit + 1) {
            var p = el.parentElement, scrollable = false;
            while (p && p !== host) {
                var s = getComputedStyle(p);
                if (s.overflowX === 'auto' || s.overflowX === 'scroll') { scrollable = true; break; }
                p = p.parentElement;
            }
            if (!scrollable) bad.push((el.className || el.tagName) + ' right@' + Math.round(r.right) + ' > ' + Math.round(limit));
        }
    });
    return bad;
}

// Long, unbroken words on purpose: a pasted URL or a product code in a title is
// exactly what pushes a cell wider than its column.
var LONG = 'https://github.com/SPEEKS-Technology/some-really-long-repository-name/tree/feature/branch';
var PEOPLE = [
    { id: 'a', name: 'Alexandra Longname-Hyphenated', store: 'OVL', role: 'manager' },
    { id: 'b', name: 'Bartholomew Ng', store: 'LEE', role: 'owner (manager)' },
    { id: 'k', name: 'Kim', store: 'WSP', role: 'manager' },
];
var P = function (id, status, extra) {
    var base = { id: id, title: 'Project ' + id, description: 'What it does for the stores, in a sentence or two. It needs a Claude seat and read access to the reprice export.', status: status,
        requested_by: 'Alexandra Longname-Hyphenated', requested_by_id: 'a',
        involved: [{ id: 'a', name: 'Alexandra Longname-Hyphenated' }, { id: 'b', name: 'Bartholomew Ng' }, { id: 'k', name: 'Kim' }],
        created_at: new Date(Date.now() - 3 * 86400000).toISOString(), updated_at: new Date().toISOString() };
    for (var k in extra) base[k] = extra[k];
    return base;
};
function fixture() {
    return {
        me: { id: 'e', name: 'Ethan', role: 'district manager' },
        can: { view: true, request: true, approve: true },
        people: PEOPLE,
        projects: [
            P(1, 'requested', { title: 'Supercalifragilisticexpialidocious-reprice-queue-helper-v2' }),
            P(2, 'changes_requested', { description: LONG }),
            P(3, 'in_progress'),
            P(5, 'completed', { outcome: 'incorporate' }),
        ],
        events: [],
    };
}
// The pane as workspace.html builds it: the .ws-tool-panel card and its head.
function renderPane(width) {
    var host = stage(width, '<div class="card ws-tool-panel ws-panel ws-panel-projects"><div class="ws-head"><div class="ws-head-main">'
        + '<div class="ws-head-titles"><span class="ws-head-eyebrow">Workspace</span><span class="ws-head-title">Projects</span></div></div>'
        + '<div class="ws-head-controls"><span id="prjSubtitle" class="ws-head-meta"></span><button id="prjNewBtn" class="kpi-update-trigger-btn">＋ Request Project</button></div></div>'
        + '<div class="ws-scroll" id="prjBody"></div></div><span id="prjWaitPip"></span>');
    _prjData = fixture();
    _prjView = 'approval';
    prjRender();
    void host.offsetHeight;
    return host;
}

[390, 820, 1440].filter(function (w) { return (w > 900) === (window.innerWidth > 900); }).forEach(function (w) {
    t('list @' + w + ': nothing spills past the frame (the table may scroll inside its wrapper)', function () {
        var bad = overflowing(renderPane(w));
        return bad.length === 0 || bad.slice(0, 4).join(' ; ');
    });
    t('list @' + w + ': every status button and row has a real size', function () {
        renderPane(w);
        var flat = Array.prototype.filter.call(document.querySelectorAll('#layout-host .prj-seg-btn, #layout-host .prj-row'), function (el) {
            var r = el.getBoundingClientRect();
            return r.width < 60 || r.height < 20;
        });
        return flat.length === 0 || flat.length + ' element(s) collapsed';
    });
});

t('list: a long description is clipped to two lines in its row', function () {
    renderPane(window.innerWidth > 900 ? 1440 : 820);
    var d = document.querySelector('#layout-host .prj-row-desc');
    var lh = parseFloat(getComputedStyle(d).lineHeight) || 17;
    return d.getBoundingClientRect().height <= lh * 2 + 2 || 'description is ' + Math.round(d.getBoundingClientRect().height) + 'px tall';
});

// ONE PILL SIZE PER COLUMN (Ethan, 2026-11-21): every status chip is as wide as
// the widest one in view, and so is every name chip — on each tab, the longest
// label still on one line.
t('list @1440: status pills are one width, name pills are one width, on every tab', function () {
    renderPane(1440);
    var bad = [];
    ['approval', 'active', 'done', 'closed'].forEach(function (v) {
        prjSetView(v);
        ['.prj-chip', '.prj-tag'].forEach(function (sel) {
            var els = document.querySelectorAll('#layout-host .prj-table ' + sel);
            if (els.length < 2) return;
            var widths = {}, tall = 0;
            Array.prototype.forEach.call(els, function (e) {
                var r = e.getBoundingClientRect();
                widths[Math.round(r.width)] = 1;
                if (r.height > 26) tall++;
            });
            var ws = Object.keys(widths);
            if (ws.length !== 1) bad.push(v + ' ' + sel + ' widths ' + ws.join('/'));
            if (tall) bad.push(v + ' ' + sel + ': ' + tall + ' wrapped');
        });
    });
    return bad.length === 0 || bad.join('; ');
});

// CENTERED COLUMNS (Ethan, 2026-11-21): Who's Involved, Requested By, Status and
// Updated sit centred under their headers, on every status tab — including the
// Completed badge with its outcome ("Completed · Ready for SPEEKSNET"), which
// once outgrew its column and sat off-centre.
t('list @1440: the four short columns are centred under their headers, on every tab', function () {
    renderPane(1440);
    var bad = [];
    ['approval', 'active', 'done', 'closed'].forEach(function (v) {
        prjSetView(v);
        var row = document.querySelector('#layout-host .prj-table tbody tr');
        if (!row) return;
        ['prj-col-people', 'prj-col-by', 'prj-col-status', 'prj-col-date'].forEach(function (c) {
            var th = document.querySelector('#layout-host th.' + c), td = row.querySelector('td.' + c);
            var hr = document.createRange(); hr.selectNodeContents(th);
            var kids = td.querySelectorAll('.prj-tag, .prj-chip');
            var box;
            if (kids.length) {
                box = { l: 1e9, r: -1e9 };
                Array.prototype.forEach.call(kids, function (k) { var b = k.getBoundingClientRect(); box.l = Math.min(box.l, b.left); box.r = Math.max(box.r, b.right); });
            } else { var tr = document.createRange(); tr.selectNodeContents(td); var b = tr.getBoundingClientRect(); box = { l: b.left, r: b.right }; }
            var h = hr.getBoundingClientRect();
            var off = Math.abs((h.left + h.right) / 2 - (box.l + box.r) / 2);
            if (off > 3) bad.push(v + ' ' + c + ' off by ' + Math.round(off) + 'px');
        });
    });
    return bad.length === 0 || bad.join('; ');
});

// The detail footer carries the most buttons (DM on a fresh request: note +
// three decisions). On a narrow screen they must wrap, not run off the edge.
[390, 820].forEach(function (w) {
    t('detail footer @' + w + ': the DM\'s decision buttons all fit', function () {
        _prjData = fixture();
        var html = _prjActionsHtml(_prjById(1));
        var host = stage(w, '<div class="modal-menu manage-menu prj-detail-modal show" style="position:static;transform:none;width:100%;max-width:100%;">'
            + '<div class="manage-footer prj-detail-foot">' + html + '</div></div>');
        var bad = overflowing(host);
        if (bad.length) return bad.slice(0, 3).join(' ; ');
        var btns = host.querySelectorAll('.prj-foot-btns button');
        var squashed = Array.prototype.filter.call(btns, function (b) { return b.getBoundingClientRect().width < 40; });
        return (btns.length >= 3 && squashed.length === 0) || btns.length + ' buttons, ' + squashed.length + ' squashed';
    });
});

// The form body is .manage-content: a flex column. Its children shrank to fit
// rather than the body scrolling, and every textarea came out one line tall —
// found by eye in the browser pane, so now measured here.
t('form: the description keeps its rows inside the popup body', function () {
    var host = stage(640, '<div class="manage-content prj-form" style="height:240px;">'
        + '<label class="form-label-caps">A</label><input class="form-input-lg">'
        + '<label class="form-label-caps">B</label><textarea class="form-input-lg" rows="6"></textarea>'
        + '<label class="form-label-caps">C</label><div class="prj-people"><input class="prj-people-input"></div></div>');
    var ta = host.querySelector('textarea');
    return ta.getBoundingClientRect().height >= 100 || 'textarea squashed to ' + Math.round(ta.getBoundingClientRect().height) + 'px';
});

// Cancel and the submit button are one size (Ethan, 2026-11-21) — and on a
// phone they share the row instead of running off it. The @media rule follows
// the real window, so this measures at the width the window actually is.
t('form footer: Cancel and the submit button are the same size, inside the frame', function () {
    var w = window.innerWidth > 900 ? 1440 : 390;
    var host = stage(w, '<div id="prjFormModal" class="modal-menu manage-menu prj-form-modal show" style="position:static;transform:none;width:100%;max-width:100%;">'
        + '<div class="manage-footer flex-end"><span class="prj-msg"></span>'
        + '<button class="btn-secondary prj-form-btn">Cancel</button><button class="btn-primary prj-form-btn">Send for Approval</button></div></div>');
    var bad = overflowing(host);
    if (bad.length) return bad.slice(0, 3).join(' ; ');
    var b = host.querySelectorAll('.prj-form-btn');
    var r0 = b[0].getBoundingClientRect(), r1 = b[1].getBoundingClientRect();
    return (Math.abs(r0.width - r1.width) < 1 && Math.abs(r0.height - r1.height) < 1 && r1.height < 50)
        || '@' + w + ': cancel ' + Math.round(r0.width) + 'x' + Math.round(r0.height) + ', submit ' + Math.round(r1.width) + 'x' + Math.round(r1.height);
});

t('picker @390: a full set of long-named chips wraps inside the box', function () {
    _prjData = fixture();
    var host = stage(390, '<div class="manage-content prj-form" style="height:auto;"><div class="prj-people" id="prjFPeople"><span class="prj-people-chips" id="prjFChips"></span>'
        + '<input id="prjFPeopleInput" class="prj-people-input"></div><div class="prj-people-menu" id="prjFPeopleMenu" hidden></div></div>');
    _prjPicked = ['a', 'b', 'k'];
    _prjRenderPicked();
    void host.offsetHeight;
    var bad = overflowing(host);
    return bad.length === 0 || bad.slice(0, 3).join(' ; ');
});

t('detail body @390: a long description wraps inside the popup', function () {
    _prjData = fixture();
    _prjData.projects[1].description = LONG + LONG + ' ' + LONG;
    var host = stage(390, '<div id="prjDetailEyebrow"></div><div id="prjDetailHead"></div><div id="prjDetailSub"></div>'
        + '<div class="manage-content prj-detail-body" id="prjDetailBody" style="height:auto;max-height:none;overflow:visible;"></div><div id="prjDetailFooter"></div>');
    _prjOpenId = 2;
    _prjRenderDetail();
    void host.offsetHeight;
    var bad = overflowing(host);
    return bad.length === 0 || bad.slice(0, 3).join(' ; ');
});
