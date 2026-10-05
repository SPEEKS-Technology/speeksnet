// STORE CALENDAR — the popup that replaced the Google Calendar embed.
//
//   powershell -File scripts/browser-check.ps1 store-calendar-check.js -Html index.html -WindowSize 1440,900
//   powershell -File scripts/browser-check.ps1 store-calendar-check.js -Html index.html -WindowSize 820,1180
//
// Needs -Html: the calendar draws into #scalRoot / #scalHeadExtra, which only
// exist in the page's real markup. Run at both sizes — the layout checks at the
// bottom measure, and a desktop that fits proves nothing about a tablet.
//
// Who-can-do-what is drawn here and ENFORCED in the store-calendar edge
// function. These checks cover the drawing; the function's own rules were
// tested against its source with fake users when it was written.

// Saves go through postWrite. Stubbed once, here, so no test ever reaches the
// network (CLAUDE.md: a per-test stub is gone before the send runs).
var __scalPosts = [];
window.postWrite = function (url, payload) {
    __scalPosts.push({ url: url, payload: payload });
    var ev = Object.assign({ id: 'new-' + __scalPosts.length, created_by: 'Browser Check' }, payload.event || {});
    // Type actions answer with the type, as the edge function does.
    var cur = _scalTypes.filter(function (x) { return x.key === payload.key; })[0];
    var category = payload.action === 'type_remove' ? Object.assign({}, cur, { active: false })
        : { key: 'k' + __scalPosts.length, label: payload.label, color: payload.color, sort: 500, active: true };
    return Promise.resolve({ success: true, event: ev, id: payload.id, category: category });
};

function _iso(d) { return _scalISO(d); }
var _now = new Date();
var _m0 = new Date(_now.getFullYear(), _now.getMonth(), 1);
function _day(n) { return _iso(new Date(_m0.getFullYear(), _m0.getMonth(), n)); }

function _seed() {
    _scal.events = [
        { id: 'c-all', scope: 'company', store: null, stores: ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'], title: 'District meeting', event_date: _day(8), all_day: false, start_time: '09:00:00', end_time: null, category: 'meeting', notes: '', repeats_yearly: false, created_by: 'Ethan' },
        { id: 'c-bal', scope: 'company', store: null, stores: ['BAL'], title: 'BAL only notice', event_date: _day(10), all_day: true, category: 'other', repeats_yearly: false },
        { id: 's-ovl', scope: 'store', store: 'OVL', stores: null, title: 'Window cleaning', event_date: _day(2), all_day: true, category: 'maintenance', repeats_yearly: false },
        { id: 's-lee', scope: 'store', store: 'LEE', stores: null, title: 'LEE truck', event_date: _day(5), all_day: true, category: 'delivery', repeats_yearly: false },
        { id: 's-mpl', scope: 'store', store: 'MPL', stores: null, title: 'MPL floor reset', event_date: _day(13), all_day: true, category: 'other', repeats_yearly: false },
        // Always tomorrow, so always editable: since 2026-10-05 a past event
        // can't be, and the dates above go past as the month goes on.
        { id: 's-fut', scope: 'store', store: 'OVL', stores: null, title: 'Tomorrow at OVL', event_date: _iso(_scalAddDays(_scalParse(_scalTodayISO()), 1)), all_day: true, category: 'maintenance', repeats_yearly: false },
        { id: 'c-fut', scope: 'company', store: null, stores: ['OVL'], title: 'Tomorrow company', event_date: _iso(_scalAddDays(_scalParse(_scalTodayISO()), 1)), all_day: true, category: 'other', repeats_yearly: false }
    ];
    _scal.loaded = true;
    // Types are mutable now (the DM edits them) — every test starts from the seed.
    _scalSetTypes(_SCAL_TYPE_SEED.map(function (r) { return { key: r[0], label: r[1], color: r[2], sort: r[3] }; }));
}

function _as(role, store, multi) {
    closeAllModals();
    sessionStorage.setItem('speeksUserRole', role);
    sessionStorage.setItem('speeksUserStore', store);
    sessionStorage.setItem('speeksUserPin', 'test-pin');
    if (multi) sessionStorage.setItem('speeksMultiStore', 'true'); else sessionStorage.removeItem('speeksMultiStore');
    _seed();
    toggleCalendar();
    return document.getElementById('scalRoot');
}
function _text(el) { return el ? el.textContent.replace(/\s+/g, ' ') : ''; }

t('markup: the Google embed is gone and the calendar has somewhere to draw', function () {
    var m = document.getElementById('calendarDropdown');
    if (!m) return 'no #calendarDropdown';
    if (m.querySelector('iframe')) return 'the Google iframe is still in the popup';
    if (!document.getElementById('scalRoot')) return 'no #scalRoot';
    if (!document.getElementById('scalHeadExtra')) return 'no #scalHeadExtra in the header';
    var h3 = m.querySelector('.modal-header h3');
    if (!h3 || h3.textContent.trim() !== 'Store Calendar') return 'title is "' + (h3 && h3.textContent) + '"';
    var btn = document.querySelector('[data-tip="Store Calendar"]');
    return (btn && /toggleCalendar/.test(btn.getAttribute('onclick'))) || 'nav button lost its label or handler';
});

t('manager: sees own store + company events for it, and can add', function () {
    var root = _as('manager', 'OVL');
    var txt = _text(root);
    if (txt.indexOf('Window cleaning') < 0) return 'own store event missing';
    if (txt.indexOf('LEE truck') >= 0) return 'another store\'s event is showing';
    if (txt.indexOf('District meeting') < 0) return 'company event for all stores missing';
    if (txt.indexOf('BAL only notice') >= 0) return 'a BAL-only company event shows at OVL';
    if (!root.querySelector('.scal-chip-company .scal-lock')) return 'company chip has no lock';
    if (!/Add event/.test(txt)) return 'no Add event button';
    if (!root.querySelector('.scal-cell.clickable')) return 'days are not clickable';
    // The header carries Calendar / Company Events tabs, and no store tag
    // (2026-10-05: "Where it says WSP, get rid of that for all stores").
    return !document.querySelector('#scalHeadExtra .scal-store-pill') || 'the store tag is back in the header';
});

t('manager: a company event opens read-only with the lock notice', function () {
    _as('manager', 'OVL');
    _scalOpenDetail('c-all');
    var p = document.querySelector('#calendarDropdown .scal-panel');
    if (!p) return 'no panel';
    var txt = _text(p);
    if (!/can't edit or delete/.test(txt)) return 'missing the read-only notice';
    if (p.querySelector('.scal-btn-danger') || /Edit/.test(_text(p.querySelector('.scal-pfoot')))) return 'manager got edit/delete on a company event';
    return /Posted by Ethan/.test(txt) || 'no "posted by"';
});

t('manager: own event opens with Edit and Delete', function () {
    _as('manager', 'OVL');
    _scalOpenDetail('s-fut');
    var foot = document.querySelector('#calendarDropdown .scal-pfoot');
    return (foot && /Delete/.test(foot.textContent) && /Edit/.test(foot.textContent)) || 'no Edit/Delete on own event';
});

t('owner (manager) counts as the store manager', function () {
    var root = _as('owner (manager)', 'WSP');
    return /Add event/.test(_text(root)) || 'WSP owner cannot add';
});

t('ASM / employee / store TV: read-only', function () {
    var bad = [];
    ['assistant manager', 'employee', 'store'].forEach(function (r) {
        var root = _as(r, 'OVL');
        if (/Add event/.test(_text(root))) bad.push(r + ' has Add event');
        if (root.querySelector('.scal-cell.clickable:not([data-has])')) bad.push(r + ' can click an empty day');
        if (_text(root).indexOf('Window cleaning') < 0) bad.push(r + ' cannot see the store calendar');
    });
    _as('employee', 'OVL'); _scalOpenDetail('s-ovl');
    if (document.querySelector('#calendarDropdown .scal-pfoot')) bad.push('employee got actions on a store event');
    return bad.length ? bad.join('; ') : true;
});

t('MSM: All / BAL / MPL chips like the DM, opens on All, can add to both, not OVL', function () {
    // 2026-10-05: no header toggle — the same chip row corporate has, with
    // only the MSM's two stores.
    var root = _as('manager', 'BAL', true);
    if (Array.from(document.querySelectorAll('#scalHeadExtra button')).some(function (b) { return /^(BAL|MPL)$/.test(b.textContent.trim()); })) return 'the old BAL/MPL header toggle is still there';
    var chips = Array.from(root.querySelectorAll('.scal-fchip')).map(function (b) { return b.textContent.trim(); });
    if (chips.join() !== 'All,BAL,MPL') return 'chips: ' + chips.join();
    if (_scal.store !== 'ALL') return 'opened on ' + _scal.store + ', not All';
    var txt = _text(root);
    if (txt.indexOf('BAL only notice') < 0 || txt.indexOf('MPL floor reset') < 0) return 'All is missing a BAL or MPL event';
    if (txt.indexOf('LEE truck') >= 0 || txt.indexOf('Window cleaning') >= 0) return 'All shows another store\'s events';
    if (!/Add event/.test(txt)) return 'cannot add from All';
    // Adding: the DM-style "Show on" picker (2026-10-05), ticked to both from All.
    _scalOpenEdit(null, _day(6));
    var boxes = Array.from(document.querySelectorAll('input[name="scalEStores"]'));
    if (boxes.map(function (b) { return b.value + (b.checked ? '+' : '-'); }).join() !== 'BAL+,MPL+') return 'from All the picker should tick BAL and MPL: ' + boxes.map(function (b) { return b.value + b.checked; }).join();
    if (document.getElementById('scalEStore')) return 'the old Store dropdown is still there';
    if (document.getElementById('scalESave').textContent !== 'Save to Both Stores') return 'save button: ' + document.getElementById('scalESave').textContent;
    boxes[0].checked = false; _scalSyncStoreSave();
    if (document.getElementById('scalESave').textContent !== 'Save to MPL') return 'one store ticked, button reads ' + document.getElementById('scalESave').textContent;
    document.getElementById('scalETitle').value = 'MPL from All';
    var before = __scalPosts.length;
    _scalSaveStore();
    if (!__scalPosts[before] || __scalPosts[before].payload.event.store !== 'MPL') return 'the store picked was not the one posted';
    _scal.saving = false; _scalClosePanel();
    _scalSetStore('BAL');
    _scalOpenEdit(null, _day(6));
    var b2 = Array.from(document.querySelectorAll('input[name="scalEStores"]')).filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    if (b2.join() !== 'BAL') return 'from the BAL view only BAL should be ticked: ' + b2.join();
    _scalClosePanel(); _scalSetStore('ALL');
    _scalSetStore('BAL');
    root = document.getElementById('scalRoot');
    if (!/Add event/.test(_text(root))) return 'cannot add at BAL';
    if (_text(root).indexOf('BAL only notice') < 0) return 'BAL company notice missing';
    _scalSetStore('MPL');
    root = document.getElementById('scalRoot');
    if (_text(root).indexOf('MPL floor reset') < 0) return 'MPL event missing after switching';
    if (!/Add event/.test(_text(root))) return 'cannot add at MPL';
    return !_scalCanWriteStore('OVL') || 'MSM can write OVL';
});

t('district: all stores, tagged, with tabs and store filter, no Add', function () {
    var bad = [];
    ['district manager', 'ceo', 'mocd'].forEach(function (r) {
        var root = _as(r, r === 'mocd' ? 'OVL' : 'CORP');
        var txt = _text(root);
        if (_scal.store !== 'ALL') bad.push(r + ' opened on ' + _scal.store);
        ['Window cleaning', 'LEE truck', 'MPL floor reset', 'BAL only notice'].forEach(function (s) { if (txt.indexOf(s) < 0) bad.push(r + ' missing ' + s); });
        if (!root.querySelector('.scal-chip-tagged b')) bad.push(r + ' store events not tagged');
        if (!/Company Events/.test(_text(document.getElementById('scalHeadExtra')))) bad.push(r + ' no Company events tab');
        if (/Add event/.test(txt)) bad.push(r + ' has store Add event');
    });
    _as('district manager', 'CORP');
    _scalSetStore('LEE');
    var txt = _text(document.getElementById('scalRoot'));
    if (txt.indexOf('LEE truck') < 0 || txt.indexOf('Window cleaning') >= 0) bad.push('LEE filter wrong');
    if (txt.indexOf('BAL only notice') >= 0) bad.push('LEE filter shows a BAL-only company event');
    return bad.length ? bad.join('; ') : true;
});

t('company tab: store picks drive the post button', function () {
    _as('district manager', 'CORP');
    _scalSetTab('company');
    var b = document.getElementById('scalCPost');
    if (!b || b.textContent !== 'Post to all 5 stores') return 'button reads "' + (b && b.textContent) + '"';
    var boxes = document.querySelectorAll('input[name="scalCStores"]');
    boxes[0].checked = false; _scalSyncPostLabel();
    if (b.textContent !== 'Post to 4 stores') return 'after one untick: "' + b.textContent + '"';
    boxes.forEach(function (x, i) { x.checked = i === 4; }); _scalSyncPostLabel();
    if (b.textContent !== 'Post to BAL') return 'one store: "' + b.textContent + '"';
    _scalPickAll();
    return b.textContent === 'Post to all 5 stores' || 'All stores did not reset';
});

t('company tab: lists only company events, upcoming vs past', function () {
    _as('district manager', 'CORP');
    _scal.events.push({ id: 'c-old', scope: 'company', stores: ['OVL'], title: 'Old thing', event_date: '2020-01-01', all_day: true, category: 'other', repeats_yearly: false });
    _scalSetTab('company');
    var txt = _text(document.querySelector('#calendarDropdown .scal-crows'));
    if (txt.indexOf('Window cleaning') >= 0) return 'a store event is in the company list';
    if (txt.indexOf('Old thing') >= 0) return 'a 2020 event is in Upcoming';
    _scalSetCompanyList('past');
    return _text(document.querySelector('#calendarDropdown .scal-crows')).indexOf('Old thing') >= 0 || 'Past is missing the 2020 event';
});

t('save: a store event posts the PIN, scope and store, and lands on the calendar', function () {
    _as('manager', 'OVL');
    _scalOpenEdit(null, _day(20));
    document.getElementById('scalETitle').value = 'HVAC service';
    document.getElementById('scalEAllDay').checked = false;
    document.getElementById('scalEStart').value = '10:00';
    // Promises in this runner settle after EVERY test has run, by which time
    // later tests have re-seeded _scal. So the send is asserted synchronously
    // (postWrite is called before the first await). The save's own continuation
    // runs after that too, so it lands in whichever events array is current
    // then — which is what the follow-up checks, not the one seeded here.
    var before = __scalPosts.length;
    var done = _scalSaveStore();
    var p = __scalPosts[before];
    if (!p) return 'nothing was posted';
    if (p.payload.pin !== 'test-pin') return 'no pin in the payload';
    if (p.payload.event.scope !== 'store' || p.payload.event.store !== 'OVL') return 'wrong scope/store: ' + JSON.stringify(p.payload.event);
    if (p.payload.event.start_time !== '10:00' || p.payload.event.all_day) return 'time not sent';
    if (!/Saving/.test(_text(document.querySelector('#calendarDropdown .scal-pfoot')))) return 'no Saving… state while it sends';
    return done.then(function () {
        return _scal.events.some(function (e) { return e.title === 'HVAC service'; }) || 'saved event never reached the calendar';
    });
});

t('save: an empty title is caught before posting', function () {
    _as('manager', 'OVL');
    _scalOpenEdit(null, _day(3));
    var before = __scalPosts.length;
    _scalSaveStore();
    if (__scalPosts.length !== before) return 'posted with no title';
    return /title/.test(document.getElementById('scalEError').textContent) || 'no error shown';
});

t('occurrences: multi-day spans, yearly repeats, Feb 29', function () {
    _scal.events = [
        { id: 'a', scope: 'store', store: 'OVL', title: 'Span', event_date: '2026-10-30', end_date: '2026-11-02', all_day: true, repeats_yearly: false },
        { id: 'b', scope: 'company', stores: ['OVL'], title: 'Yearly', event_date: '2025-12-25', all_day: true, repeats_yearly: true },
        { id: 'c', scope: 'store', store: 'OVL', title: 'Leap', event_date: '2024-02-29', all_day: true, repeats_yearly: true }
    ];
    var nov = _scalOccurrences('2026-11-01', '2026-11-30', 'OVL').filter(function (o) { return o.ev.id === 'a'; });
    if (nov.length !== 2 || nov[0].first) return 'span in Nov: ' + nov.length + ' days';
    var dec = _scalOccurrences('2027-12-01', '2027-12-31', 'OVL').filter(function (o) { return o.ev.id === 'b'; });
    if (dec.length !== 1 || dec[0].day !== '2027-12-25') return 'yearly not on 2027-12-25';
    if (_scalOccurrences('2024-12-01', '2024-12-31', 'OVL').some(function (o) { return o.ev.id === 'b'; })) return 'yearly shows before its first year';
    var feb27 = _scalOccurrences('2027-02-01', '2027-03-31', 'OVL').filter(function (o) { return o.ev.id === 'c'; });
    if (feb27.length) return 'Feb 29 drawn in 2027 on ' + feb27[0].day;
    return _scalOccurrences('2028-02-29', '2028-02-29', 'OVL').length === 1 || 'Feb 29 missing in 2028';
});

t('escaping: an event title cannot inject markup', function () {
    _as('manager', 'OVL');
    _scal.events.push({ id: 'x', scope: 'store', store: 'OVL', title: '<img src=x onerror=alert(1)>', event_date: _day(4), all_day: true, category: 'other' });
    _scalRender();
    return !document.querySelector('#scalRoot img') || 'title rendered as HTML';
});

// ---- layout: measured, at whatever -WindowSize the run uses ----
t('layout: the month fits the popup with no sideways scroll, all rows visible', function () {
    var root = _as('manager', 'OVL');
    var body = root.querySelector('.scal-body');
    if (root.scrollWidth > root.clientWidth + 1) return 'root scrolls sideways (' + root.scrollWidth + ' > ' + root.clientWidth + ')';
    if (body.scrollWidth > body.clientWidth + 1) return 'calendar body scrolls sideways';
    var cells = root.querySelectorAll('.scal-cell');
    var tiny = Array.from(cells).filter(function (c) { return c.getBoundingClientRect().height < 60 || c.getBoundingClientRect().width < 40; });
    if (tiny.length) return tiny.length + ' day cells are crushed (' + Math.round(tiny[0].getBoundingClientRect().width) + 'x' + Math.round(tiny[0].getBoundingClientRect().height) + ')';
    var legend = root.querySelector('.scal-legend').getBoundingClientRect();
    var modal = document.getElementById('calendarDropdown').getBoundingClientRect();
    return legend.bottom <= modal.bottom + 1 || 'legend is cut off below the popup';
});

t('layout: a chip stays inside its day cell', function () {
    var root = _as('manager', 'OVL');
    // Chips no longer live inside the cell element (see _scalWeekRowHTML): the
    // single-day stack carries the day it belongs to, so measure against that cell.
    var chip = root.querySelector('.scal-singles .scal-chip-company');
    if (!chip) return 'no chip';
    var day = chip.closest('.scal-singles').getAttribute('data-day');
    var c = chip.getBoundingClientRect(), cell = root.querySelector('.scal-cell[data-day="' + day + '"]').getBoundingClientRect();
    return (c.left >= cell.left - 1 && c.right <= cell.right + 1) || 'chip overflows its cell';
});

t('layout: the side sheet sits inside the popup', function () {
    _as('manager', 'OVL');
    _scalOpenEdit(null, _day(6));
    var p = document.querySelector('#calendarDropdown .scal-panel').getBoundingClientRect();
    var m = document.getElementById('calendarDropdown').getBoundingClientRect();
    if (p.width < 300) return 'sheet is ' + Math.round(p.width) + 'px wide';
    var save = document.querySelector('#calendarDropdown .scal-pfoot .scal-btn-primary').getBoundingClientRect();
    if (save.bottom > m.bottom + 1 || save.height < 30) return 'Save button is off the bottom or squashed';
    return (p.right <= m.right + 1 && p.left >= m.left - 1) || 'sheet escapes the popup';
});

t('layout: the Company events tab has a usable form and list', function () {
    _as('district manager', 'CORP');
    _scalSetTab('company');
    var root = document.getElementById('scalRoot');
    if (root.scrollWidth > root.clientWidth + 1) return 'company tab scrolls sideways';
    var picks = document.querySelectorAll('#calendarDropdown .scal-pick');
    var small = Array.from(picks).filter(function (x) { return x.getBoundingClientRect().width < 44; });
    if (small.length) return small.length + ' store picks under 44px wide';
    var row = document.querySelector('#calendarDropdown .scal-crow');
    return (row && row.getBoundingClientRect().height > 30) || 'no visible company row';
});

t('types: every chip carries its type colour, and the key lists only what is on screen', function () {
    var root = _as('manager', 'OVL');
    var chips = root.querySelectorAll('.scal-chip');
    var bare = Array.from(chips).filter(function (c) { return !c.querySelector('.scal-cdot'); });
    if (bare.length) return bare.length + ' chips have no type dot';
    var key = document.querySelector('#calendarDropdown .scal-types');
    if (!key) return 'no type key';
    var labels = Array.from(key.children).map(function (s) { return s.textContent; });
    // The seed holds meeting, other and maintenance at OVL this month.
    if (labels.indexOf('Meetings') < 0 || labels.indexOf('Maintenance/Repairs') < 0) return 'key missing a type on screen: ' + labels.join(', ');
    if (labels.indexOf('Pay Day') >= 0) return 'key lists a type that is not on screen';
    return Object.keys(_SCAL_CATEGORIES).every(function (c) { return _SCAL_CAT_COLORS[c]; }) || 'a type has no colour';
});

// ---- 2026-10-01 round two: spanning bars, equal sizes, legend wording ----
function _spanSeed() {
    // A 3-day company event inside one week, and a 4-day store event that
    // crosses a Saturday into the next week. Dates are found, not hard-coded,
    // so the check holds whatever month it runs in.
    var sun = null;
    for (var d = 1; d <= 7; d++) { if (new Date(_m0.getFullYear(), _m0.getMonth(), d).getDay() === 0) { sun = d; break; } }
    var wed = sun + 7 + 3, fri = sun + 7 + 5;
    _scal.events.push({ id: 'span3', scope: 'company', stores: ['OVL'], title: 'Three day thing', event_date: _day(wed - 1), end_date: _day(wed + 1), all_day: true, category: 'promo' });
    _scal.events.push({ id: 'span4', scope: 'store', store: 'OVL', title: 'Crosses the weekend', event_date: _day(fri), end_date: _day(fri + 3), all_day: true, category: 'staffing' });
    _scalRender();
    return { wed: wed, fri: fri };
}
function _barsMatching(re) {
    return Array.from(document.querySelectorAll('#scalRoot .scal-bar')).filter(function (b) { return re.test(b.textContent); });
}

t('bars: a 3-day event is ONE bar spanning three days, not three chips', function () {
    _as('manager', 'OVL');
    var d = _spanSeed();
    var three = _barsMatching(/Three day thing/);
    if (three.length !== 1) return three.length + ' bars for the 3-day event';
    if (Array.from(document.querySelectorAll('#scalRoot .scal-singles')).some(function (s) { return /Three day thing/.test(s.textContent); }))
        return 'the 3-day event also appears as a single-day chip';
    var b = three[0].getBoundingClientRect();
    var c1 = document.querySelector('#scalRoot .scal-cell[data-day="' + _day(d.wed - 1) + '"]').getBoundingClientRect();
    var c3 = document.querySelector('#scalRoot .scal-cell[data-day="' + _day(d.wed + 1) + '"]').getBoundingClientRect();
    if (b.left < c1.left - 1 || b.left > c1.left + 12) return 'bar does not start in its first day';
    if (b.right > c3.right + 1 || b.right < c3.right - 12) return 'bar does not end in its last day';
    return (b.top > c1.top + 20) || 'bar sits on top of the day numbers';
});

t('bars: an event across the weekend is two bars, flat where it continues', function () {
    _as('manager', 'OVL');
    _spanSeed();
    var bars = _barsMatching(/Crosses the weekend/);
    if (bars.length !== 2) return bars.length + ' segments, expected 2';
    if (!bars[0].classList.contains('cont-r') || bars[0].classList.contains('cont-l')) return 'first segment ends are wrong';
    if (!bars[1].classList.contains('cont-l') || bars[1].classList.contains('cont-r')) return 'second segment ends are wrong';
    return true;
});

t('bars: overlapping spans stack in lanes and never overlap each other', function () {
    _as('manager', 'OVL');
    var d = _spanSeed();
    _scal.events.push({ id: 'span3b', scope: 'store', store: 'OVL', title: 'Overlaps it', event_date: _day(d.wed), end_date: _day(d.wed + 2), all_day: true, category: 'training' });
    _scalRender();
    var a = _barsMatching(/Three day thing|Overlaps it/).map(function (b) { return b.getBoundingClientRect(); });
    if (a.length !== 2) return a.length + ' bars';
    var overlap = !(a[0].bottom <= a[1].top + 0.5 || a[1].bottom <= a[0].top + 0.5);
    return !overlap || 'two bars drawn on top of each other';
});

t('bars: clicking an empty part of a day still reaches the day', function () {
    _as('manager', 'OVL');
    var d = _spanSeed();
    var el = document.querySelector('#scalRoot .scal-cell[data-day="' + _day(d.wed) + '"]');
    // The popup fades in over 0.15s, and until that ends it is visibility:hidden
    // — so a hit-test straight after opening sees through it to the overlay.
    // Nobody can click that fast; skip the fade for the measurement.
    var modal = document.getElementById('calendarDropdown');
    modal.style.transition = 'none'; void modal.offsetHeight;
    var cell = el.getBoundingClientRect();
    var m = modal.getBoundingClientRect();
    var y = Math.min(cell.bottom, m.bottom) - 6;
    var hit = document.elementFromPoint(cell.left + cell.width / 2, y);
    modal.style.transition = '';
    return hit === el || 'the bottom of the day is covered by ' + (hit && hit.className)
        + ' (cell ' + Math.round(cell.top) + '-' + Math.round(cell.bottom) + ', popup ' + Math.round(m.top) + '-' + Math.round(m.bottom) + ', y ' + Math.round(y) + ', vh ' + innerHeight + ')';
});

t('week view: a spanning event is one bar there too', function () {
    _as('manager', 'OVL');
    var d = _spanSeed();
    var wd = _scalParse(_day(d.wed));
    _scal.view = 'week';
    _scal.weekStart = _scalAddDays(wd, -wd.getDay());
    _scalRender();
    var n = _barsMatching(/Three day thing/).length;
    _scal.view = 'month';
    return n === 1 || n + ' bars in week view';
});

t('legend says Company-Wide Event / Store Event; district has no "pick a store" line', function () {
    _as('manager', 'OVL');
    var t1 = _text(document.querySelector('#calendarDropdown .scal-legend'));
    if (t1.indexOf('Company-Wide Event') < 0 || t1.indexOf('Store Event') < 0) return 'manager legend: ' + t1;
    _as('district manager', 'CORP');
    var t2 = _text(document.querySelector('#calendarDropdown .scal-legend'));
    if (/Pick a store|Showing what/.test(t2)) return 'district hint still there: ' + t2;
    return (t2.indexOf('Company-Wide Event') >= 0 && t2.indexOf('Store Event') >= 0) || 'district legend: ' + t2;
});

t('sizes: the store chips are all one width, and the two tabs are one width', function () {
    _as('district manager', 'CORP');
    var w = Array.from(document.querySelectorAll('#scalRoot .scal-fchip')).map(function (b) { return Math.round(b.getBoundingClientRect().width); });
    if (w.length !== 6) return w.length + ' store chips';
    if (Math.max.apply(null, w) - Math.min.apply(null, w) > 1) return 'chip widths differ: ' + w.join(',');
    var tabs = Array.from(document.querySelectorAll('#scalHeadExtra .scal-seg button')).map(function (b) { return Math.round(b.getBoundingClientRect().width); });
    // The DM has a third tab (Event types); all of them must match.
    return (tabs.length >= 2 && Math.max.apply(null, tabs) - Math.min.apply(null, tabs) <= 1) || 'tab widths: ' + tabs.join(',');
});

// ---- 2026-10-01 round three: no Today, Ethan's type names, key = what's on screen ----
t('toolbar: the Today button is gone, and Month / Week / List are one width', function () {
    _as('manager', 'OVL');
    var bar = document.querySelector('#scalRoot .scal-toolbar');
    if (/\bToday\b/.test(_text(bar))) return 'Today is still in the toolbar';
    var w = Array.from(bar.querySelectorAll('.scal-actions .scal-seg button')).map(function (b) { return Math.round(b.getBoundingClientRect().width); });
    return (w.length === 3 && Math.max.apply(null, w) - Math.min.apply(null, w) <= 1) || 'view button widths: ' + w.join(',');
});

t('types: the eight names are Ethan\'s, word for word', function () {
    var want = { meeting: 'Meetings', hours: 'Holiday/Hour Changes', payday: 'Pay Day', celebration: 'Birthday/Anniversary',
        staffing: 'Staffing/PTO', travel: 'Travel', community: 'Events', delivery: 'B2B Pickups' };
    var bad = Object.keys(want).filter(function (k) { return _SCAL_CATEGORIES[k] !== want[k]; });
    return !bad.length || 'wrong: ' + bad.map(function (k) { return k + '=' + _SCAL_CATEGORIES[k]; }).join(', ');
});

t('key: week view lists only that week\'s types', function () {
    _as('manager', 'OVL');
    // The seed has maintenance on the 2nd and a meeting on the 8th. The week of
    // the 8th holds the meeting and not the maintenance (unless they share a week).
    // The always-tomorrow events would land in any week, so they sit this one out.
    _scal.events = _scal.events.filter(function (e) { return e.id !== 's-fut' && e.id !== 'c-fut'; });
    var d8 = _scalParse(_day(8));
    _scal.view = 'week';
    _scal.weekStart = _scalAddDays(d8, -d8.getDay());
    _scalRender();
    var labels = Array.from(document.querySelectorAll('#calendarDropdown .scal-types > span')).map(function (s) { return s.textContent; });
    var sameWeek = _scalISO(_scal.weekStart) <= _day(2);
    _scal.view = 'month';
    if (labels.indexOf('Meetings') < 0) return 'week key is missing Meetings: ' + labels.join(', ');
    return sameWeek || labels.indexOf('Maintenance/Repairs') < 0 || 'week key lists a type from another week';
});

t('key: month view counts the spill-over days the grid shows', function () {
    _as('manager', 'OVL');
    // An event on the last day drawn before the 1st (only when the month does
    // not start on a Sunday) must still be in the key.
    if (_m0.getDay() === 0) return true;
    _scal.events.push({ id: 'spill', scope: 'store', store: 'OVL', title: 'Spill', event_date: _iso(_scalAddDays(_m0, -1)), all_day: true, category: 'opening' });
    _scalRender();
    var labels = Array.from(document.querySelectorAll('#calendarDropdown .scal-types > span')).map(function (s) { return s.textContent; });
    return labels.indexOf('Store Opening') >= 0 || 'spill-over day not in the key: ' + labels.join(', ');
});

// ---- 2026-10-01 round four: 18 types, Title Case, DM-only Event Types tab ----
t('types: 18 seeded, every word of every name starts with a capital', function () {
    _as('manager', 'OVL');
    var labels = _scalTypes.map(function (x) { return x.label; });
    if (labels.length !== 18) return labels.length + ' types';
    var bad = labels.filter(function (l) { return l.split(/[\s\/-]+/).some(function (w) { return w && w[0] !== w[0].toUpperCase(); }); });
    if (bad.length) return 'not Title Case: ' + bad.join(', ');
    return _scalActiveTypes()[_scalActiveTypes().length - 1] === 'other' || 'Other is not last';
});

t('types tab: DM, CEO and MOCD get it; managers and the MSM do not', function () {
    // Widened from DM-only on 2026-10-05: "CEO and MOCD can have access to event types too".
    var bad = [];
    [['district manager', 'CORP', true, false], ['ceo', 'CORP', true, false], ['mocd', 'OVL', true, false], ['manager', 'OVL', false, false], ['manager', 'BAL', false, true]].forEach(function (c) {
        _as(c[0], c[1], c[3]);
        var has = /Event Types/.test(_text(document.getElementById('scalHeadExtra')));
        if (has !== c[2]) bad.push(c[0] + (c[3] ? ' (MSM)' : '') + (has ? ' sees' : ' does not see') + ' the tab');
    });
    _as('manager', 'OVL'); _scalSetTab('types');
    if (/Add a Type/.test(_text(document.getElementById('scalRoot')))) bad.push('a manager can open the types tab by calling it');
    return bad.length ? bad.join('; ') : true;
});

t('types tab: Other cannot be removed; removing posts the key; adding posts name + colour', function () {
    _as('district manager', 'CORP');
    _scalSetTab('types');
    var rows = Array.from(document.querySelectorAll('#scalRoot .scal-trow'));
    var other = rows.filter(function (r) { return /Other/.test(r.querySelector('.scal-tname').textContent); })[0];
    if (!other || other.querySelector('.danger')) return 'Other has a remove button';
    var before = __scalPosts.length;
    _scalRemoveType('travel');
    var p = __scalPosts[before];
    if (!p || p.payload.action !== 'type_remove' || p.payload.key !== 'travel' || p.payload.pin !== 'test-pin') return 'remove payload: ' + JSON.stringify(p && p.payload);
    document.getElementById('scalTName').value = 'vendor visits';
    _scalPickTypeColor('#0891b2');
    if (document.getElementById('scalTName').value !== 'vendor visits') return 'picking a colour wiped the name';
    _scalSaveType();
    var q = __scalPosts[before + 1];
    return (q && q.payload.action === 'type_add' && q.payload.label === 'vendor visits' && q.payload.color === '#0891b2') || 'add payload: ' + JSON.stringify(q && q.payload);
});

t('removed type: gone from the dropdown, still labels its old events, kept when editing one', function () {
    _as('manager', 'OVL');
    var list = _scalTypes.map(function (x) { return x.key === 'maintenance' ? Object.assign({}, x, { active: false }) : x; });
    _scalSetTypes(list);
    _scalOpenEdit(null, _day(3));
    var opts = Array.from(document.querySelectorAll('#scalECat option')).map(function (o) { return o.value; });
    if (opts.indexOf('maintenance') >= 0) return 'a removed type is offered for a new event';
    _scalClosePanel();
    if (_SCAL_CATEGORIES.maintenance !== 'Maintenance/Repairs') return 'the removed type lost its name';
    _scalOpenEdit('s-fut');   // seeded as maintenance
    var sel = document.getElementById('scalECat');
    return (sel && sel.value === 'maintenance') || 'editing an old event dropped its removed type (' + (sel && sel.value) + ')';
});

t('types: the server list replaces the seed, in its order', function () {
    _scalSetTypes([{ key: 'zeta', label: 'Zeta', color: '#000000', sort: 5 }, { key: 'other', label: 'Other', color: '#94a3b8', sort: 999 }]);
    var ok = _scalActiveTypes().join() === 'zeta,other' && _SCAL_CAT_COLORS.zeta === '#000000' && !_SCAL_CATEGORIES.meeting;
    _scalSetTypes(_SCAL_TYPE_SEED.map(function (r) { return { key: r[0], label: r[1], color: r[2], sort: r[3] }; }));
    return ok || 'server list did not replace the seed';
});

// ---- 2026-10-04: Upcoming/Past one width, month by month, edit a type ----
function _companySeed() {
    // Two past months and two upcoming months of company events.
    var y = _now.getFullYear(), m = _now.getMonth();
    function at(dm, d) { return _iso(new Date(y, m + dm, d)); }
    // Replaces the base seed's company events: whether those are past or upcoming
    // depends on the day the check runs, and this test must not.
    _scal.events = _scal.events.filter(function (e) { return e.scope !== 'company'; }).concat([
        { id: 'u1', scope: 'company', stores: ['OVL'], title: 'Later today', event_date: _scalTodayISO(), all_day: true, category: 'meeting' },
        { id: 'p1', scope: 'company', stores: ['OVL'], title: 'Two months ago', event_date: at(-2, 10), all_day: true, category: 'meeting' },
        { id: 'p2', scope: 'company', stores: ['OVL'], title: 'Last month A', event_date: at(-1, 5), all_day: true, category: 'meeting' },
        { id: 'p3', scope: 'company', stores: ['OVL'], title: 'Last month B', event_date: at(-1, 20), all_day: true, category: 'meeting' },
        { id: 'u2', scope: 'company', stores: ['OVL'], title: 'Next month', event_date: at(1, 3), all_day: true, category: 'meeting' }
    ]);
}

t('company tab: Upcoming and Past are one width', function () {
    _as('district manager', 'CORP');
    _scalSetTab('company');
    var w = Array.from(document.querySelectorAll('#scalRoot .scal-chead .scal-seg button')).map(function (b) { return Math.round(b.getBoundingClientRect().width); });
    return (w.length === 2 && Math.abs(w[0] - w[1]) <= 1) || 'widths: ' + w.join(',');
});

t('company tab: Upcoming is this month only, and the arrows step forward a month', function () {
    // 2026-10-05: "only need to show upcoming events for current month, so
    // maybe offer the ability to switch what month you look at there as well".
    _as('district manager', 'CORP');
    _companySeed();
    _scalSetTab('company');
    var root = document.getElementById('scalRoot');
    var label = _text(root.querySelector('.scal-pastmonth'));
    if (label.indexOf(_SCAL_MONTHS[_now.getMonth()] + ' ' + _now.getFullYear()) !== 0) return 'opened on ' + label;
    var txt = _text(root.querySelector('.scal-crows'));
    if (txt.indexOf('Later today') < 0) return 'this month\'s event missing';
    if (txt.indexOf('Next month') >= 0) return 'next month\'s event shown in this month';
    if (!root.querySelector('.scal-pastnav [aria-label="Older month"]').disabled) return 'can step back before this month';
    root.querySelector('.scal-pastnav [aria-label="Newer month"]').click();
    txt = _text(document.querySelector('#scalRoot .scal-crows'));
    return (txt.indexOf('Next month') >= 0 && txt.indexOf('Later today') < 0) || 'next month did not show its own events: ' + txt.slice(0, 120);
});

t('company tab: a yearly event shows in the month of each repeat', function () {
    _as('district manager', 'CORP');
    // First date: today, a year ago. This year's repeat is today, so it is in
    // THIS month's Upcoming list on any day the check runs.
    var lastYear = _iso(new Date(_now.getFullYear() - 1, _now.getMonth(), _now.getDate()));
    _scal.events.push({ id: 'yr', scope: 'company', stores: ['OVL'], title: 'Yearly thing', event_date: lastYear, all_day: true, category: 'meeting', repeat: 'yearly' });
    _scalSetTab('company');
    var row = Array.from(document.querySelectorAll('#scalRoot .scal-crow')).filter(function (r) { return /Yearly thing/.test(r.textContent); })[0];
    if (!row) return 'a yearly event is missing from the month it repeats in';
    return _text(row.querySelector('.scal-cdate')).indexOf(String(_now.getDate())) >= 0 || 'shown on the wrong day: ' + _text(row.querySelector('.scal-cdate'));
});

t('celebrations: a company birthday shows on every store, even one it wasn\'t posted to', function () {
    _as('manager', 'OVL');
    _scal.events.push({ id: 'bday', scope: 'company', stores: ['BAL'], title: 'BAL person birthday', event_date: _iso(_scalAddDays(_scalParse(_scalTodayISO()), 1)), all_day: true, category: 'celebration', repeat: 'yearly' });
    _scal.events.push({ id: 'sbday', scope: 'store', store: 'BAL', title: 'BAL store-posted birthday', event_date: _iso(_scalAddDays(_scalParse(_scalTodayISO()), 1)), all_day: true, category: 'celebration' });
    var shows = _scalShowsOn(_scal.events.filter(function (e) { return e.id === 'bday'; })[0], 'OVL');
    if (!shows) return 'a company birthday posted to BAL does not show at OVL';
    if (_scalShowsOn(_scal.events.filter(function (e) { return e.id === 'sbday'; })[0], 'OVL')) return 'a birthday a STORE posted leaks to other stores';
    _scal.upMonth = _iso(_scalAddDays(_scalParse(_scalTodayISO()), 1)).slice(0, 7);   // tomorrow's month
    _scalSetTab('company');
    return _text(document.getElementById('scalRoot')).indexOf('BAL person birthday') >= 0 || 'OVL\'s view-only list is missing the company birthday';
});

t('version: v3.9.1', function () {
    return APP_VERSION === '3.9.1' || 'APP_VERSION is ' + APP_VERSION;
});

t('company tab: Past is one month at a time, newest first, arrows step between months', function () {
    _as('district manager', 'CORP');
    _companySeed();
    _scalSetTab('company');
    _scalSetCompanyList('past');
    var root = document.getElementById('scalRoot');
    var txt = _text(root.querySelector('.scal-crows'));
    if (txt.indexOf('Last month A') < 0 || txt.indexOf('Last month B') < 0) return 'last month not shown first: ' + txt.slice(0, 120);
    if (txt.indexOf('Two months ago') >= 0) return 'two months of past events on screen at once';
    if (txt.indexOf('Last month B') > txt.indexOf('Last month A')) return 'not newest first within the month';
    var newer = root.querySelector('.scal-pastnav [aria-label="Newer month"]');
    if (!newer.disabled) return 'can step newer than the newest past month';
    root.querySelector('.scal-pastnav [aria-label="Older month"]').click();
    txt = _text(document.querySelector('#scalRoot .scal-crows'));
    if (txt.indexOf('Two months ago') < 0 || txt.indexOf('Last month A') >= 0) return 'older arrow did not move one month back: ' + txt.slice(0, 120);
    return document.querySelector('#scalRoot .scal-pastnav [aria-label="Older month"]').disabled || 'can step older than the oldest month with events';
});

t('types: the pencil loads a type, Save posts type_edit with its key, Cancel clears it', function () {
    _as('district manager', 'CORP');
    _scalSetTab('types');
    _scalEditType('travel');
    var name = document.getElementById('scalTName');
    if (!name || name.value !== 'Travel') return 'form did not load the type: ' + (name && name.value);
    if (!document.querySelector('#scalRoot .scal-trow.editing')) return 'the row being edited is not highlighted';
    name.value = 'travel / visits';
    _scalPickTypeColor('#0284c7');
    if (document.getElementById('scalTName').value !== 'travel / visits') return 'picking a colour wiped the edited name';
    var before = __scalPosts.length;
    _scalSaveType();
    var p = __scalPosts[before];
    if (!p || p.payload.action !== 'type_edit' || p.payload.key !== 'travel' || p.payload.label !== 'travel / visits' || p.payload.color !== '#0284c7')
        return 'edit payload: ' + JSON.stringify(p && p.payload);
    _scal.saving = false;
    _scalEditType('travel'); _scalEditType(null);
    return /Add a Type/.test(_text(document.querySelector('#scalRoot .scal-cform'))) || 'Cancel did not go back to Add';
});

t('types: Other can be recoloured but not renamed or removed', function () {
    _as('district manager', 'CORP');
    _scalSetTab('types');
    _scalEditType('other');
    var name = document.getElementById('scalTName');
    if (!name.disabled) return 'Other\'s name can be edited';
    var otherRow = Array.from(document.querySelectorAll('#scalRoot .scal-trow')).filter(function (r) { return r.querySelector('.scal-tname').textContent === 'Other'; })[0];
    if (otherRow.querySelector('.danger')) return 'Other has a remove button';
    return !!otherRow.querySelector('[aria-label="Edit Other"]') || 'Other has no edit button';
});

// ---- 2026-10-04 round two: Repeat dropdown, counts, wording ----
function _startsOf(ev, from, to) { return _scalRepeatStarts(ev, from, to); }

t('repeat: daily, weekly, monthly, quarterly, yearly land where they should', function () {
    var bad = [];
    var d = _startsOf({ event_date: '2026-10-05', repeat: 'daily' }, '2026-10-07', '2026-10-09');
    if (d.join() !== '2026-10-07,2026-10-08,2026-10-09') bad.push('daily: ' + d.join());
    var w = _startsOf({ event_date: '2026-10-05', repeat: 'weekly' }, '2026-10-06', '2026-10-31');
    if (w.join() !== '2026-10-12,2026-10-19,2026-10-26') bad.push('weekly: ' + w.join());
    var m = _startsOf({ event_date: '2026-10-15', repeat: 'monthly' }, '2026-12-01', '2027-02-28');
    if (m.join() !== '2026-12-15,2027-01-15,2027-02-15') bad.push('monthly: ' + m.join());
    var q = _startsOf({ event_date: '2026-10-15', repeat: 'quarterly' }, '2026-10-01', '2027-07-31');
    if (q.join() !== '2026-10-15,2027-01-15,2027-04-15,2027-07-15') bad.push('quarterly: ' + q.join());
    var y = _startsOf({ event_date: '2026-10-28', repeat: 'yearly' }, '2028-01-01', '2028-12-31');
    if (y.join() !== '2028-10-28') bad.push('yearly: ' + y.join());
    var before = _startsOf({ event_date: '2026-10-15', repeat: 'weekly' }, '2026-09-01', '2026-09-30');
    if (before.length) bad.push('repeats before its first date: ' + before.join());
    return bad.length ? bad.join('; ') : true;
});

t('repeat: the 31st skips months without one instead of shifting', function () {
    var m = _startsOf({ event_date: '2026-10-31', repeat: 'monthly' }, '2026-10-01', '2027-03-31');
    return m.join() === '2026-10-31,2026-12-31,2027-01-31,2027-03-31' || 'monthly on the 31st: ' + m.join();
});

t('repeat: rows from before 0138 (repeats_yearly only) still repeat yearly', function () {
    return _scalRepeatOf({ repeats_yearly: true }) === 'yearly' && _scalRepeatOf({ repeat: 'weekly' }) === 'weekly'
        && _scalRepeatOf({}) === 'none' || 'repeat fallback wrong';
});

t('repeat: a weekly event draws on every week of the month', function () {
    _as('manager', 'OVL');
    _scal.events.push({ id: 'wk', scope: 'store', store: 'OVL', title: 'Weekly huddle', event_date: _day(1), all_day: true, category: 'meeting', repeat: 'weekly' });
    _scalRender();
    var n = (_text(document.getElementById('scalRoot')).match(/Weekly huddle/g) || []).length;
    var expect = Math.ceil(new Date(_m0.getFullYear(), _m0.getMonth() + 1, 0).getDate() / 7);
    return n >= expect || n + ' weekly chips, expected at least ' + expect;
});

t('repeat: the form offers Never/Daily/Weekly/Monthly/Quarterly/Yearly and posts the pick', function () {
    _as('manager', 'OVL');
    _scalOpenEdit(null, _day(4));
    var sel = document.getElementById('scalERepeat');
    if (!sel) return 'no Repeat dropdown';
    var labels = Array.from(sel.options).map(function (o) { return o.textContent; });
    if (labels.join() !== 'Never,Daily,Weekly,Monthly,Quarterly,Yearly') return 'options: ' + labels.join();
    if (document.getElementById('scalEYearly')) return 'the old Repeats yearly checkbox is still there';
    document.getElementById('scalETitle').value = 'Quarterly audit';
    sel.value = 'quarterly';
    var before = __scalPosts.length;
    _scalSaveStore();
    var p = __scalPosts[before];
    return (p && p.payload.event.repeat === 'quarterly') || 'posted: ' + JSON.stringify(p && p.payload.event);
});

t('types tab: counts read "1 Event" / "N Events", and an unused type shows nothing', function () {
    _as('district manager', 'CORP');
    _scalSetTab('types');
    var counts = {};
    Array.from(document.querySelectorAll('#scalRoot .scal-trow')).forEach(function (r) {
        counts[r.querySelector('.scal-tname').textContent] = r.querySelector('.scal-tcount').textContent;
    });
    if (counts['Meetings'] !== '1 Event') return 'Meetings shows "' + counts['Meetings'] + '"';
    if (counts['Pay Day'] !== '') return 'unused Pay Day shows "' + counts['Pay Day'] + '"';
    return !/Not used yet|event\b/.test(_text(document.querySelector('#scalRoot .scal-trows'))) || 'old wording still in the list';
});

t('wording: Event Types / Add a Type, no explanations; Company Event titles capitalised', function () {
    _as('district manager', 'CORP');
    _scalSetTab('types');
    var root = document.getElementById('scalRoot');
    if (root.querySelector('.scal-clist .scal-sub')) return 'the Event Types explanation is still there';
    if (_text(root.querySelector('.scal-clist .scal-title')) !== 'Event Types') return 'list title: ' + _text(root.querySelector('.scal-clist .scal-title'));
    if (_text(root.querySelector('.scal-cform .scal-title')) !== 'Add a Type') return 'form title: ' + _text(root.querySelector('.scal-cform .scal-title'));
    _scalEditType('travel');
    if (/Renaming/.test(_text(document.querySelector('#scalRoot .scal-cform')))) return 'the renaming explanation is still there';
    _scalSetTab('company');
    root = document.getElementById('scalRoot');
    if (_text(root.querySelector('.scal-clist .scal-title')) !== 'Upcoming Company Events') return 'list title: ' + _text(root.querySelector('.scal-clist .scal-title'));
    if (_text(root.querySelector('.scal-cform .scal-title')) !== 'New Company Event') return 'form title: ' + _text(root.querySelector('.scal-cform .scal-title'));
    _scalEditCompany('c-fut');
    return _text(document.querySelector('#scalRoot .scal-cform .scal-title')) === 'Edit Company Event' || 'edit title wrong';
});

// ---- 2026-10-05: past events locked, end date greyed for timed, no name hint ----
function _pastSeed() {
    var y = _iso(_scalAddDays(_scalParse(_scalTodayISO()), -3));
    _scal.events.push({ id: 'pst', scope: 'store', store: 'OVL', title: 'Done already', event_date: y, all_day: true, category: 'other', repeat: 'none' });
    _scal.events.push({ id: 'pstc', scope: 'company', stores: ['OVL'], title: 'Past company', event_date: y, all_day: true, category: 'meeting', repeat: 'none' });
    _scal.events.push({ id: 'pstw', scope: 'store', store: 'OVL', title: 'Weekly from before', event_date: y, all_day: true, category: 'meeting', repeat: 'weekly' });
}

t('past: a past store event opens with Delete only, and the edit form refuses it', function () {
    _as('manager', 'OVL');
    _pastSeed();
    _scalOpenDetail('pst');
    var foot = _text(document.querySelector('#calendarDropdown .scal-pfoot'));
    if (/Edit/.test(foot) || !/Delete/.test(foot)) return 'past event actions: ' + foot;
    _scalOpenEdit('pst');
    if (_scal.panel && _scal.panel.kind === 'edit') return 'the edit form opened for a past event';
    _scalOpenDetail('pstw');
    return /Edit/.test(_text(document.querySelector('#calendarDropdown .scal-pfoot'))) || 'a repeating event that started in the past lost its Edit';
});

t('past: Past Company Events have no pencil, and cannot be loaded into the form', function () {
    _as('district manager', 'CORP');
    _pastSeed();
    _scalSetTab('company');
    _scalSetCompanyList('past');
    var row = Array.from(document.querySelectorAll('#scalRoot .scal-crow')).filter(function (r) { return /Past company/.test(r.textContent); })[0];
    if (!row) return 'past company event not listed';
    if (row.querySelector('[aria-label^="Edit"]')) return 'a past company event has an edit button';
    if (!row.querySelector('.danger')) return 'a past company event lost its delete button';
    _scalEditCompany('pstc');
    if (_scal.companyForm && _scal.companyForm.id === 'pstc') return 'a past company event loaded into the edit form';
    // The detail sheet lives on the Calendar tab. (Not document.body as a
    // fallback: the page's text includes this check's own source.)
    _scalSetTab('calendar');
    _scalOpenDetail('pstc');
    var panel = document.querySelector('#calendarDropdown .scal-panel');
    if (!panel) return 'detail sheet did not open';
    return !/Edit in Company Events/.test(_text(panel)) || 'detail sheet offers to edit a past company event';
});

t('ends: the end date is greyed out and cleared unless All day is on', function () {
    _as('manager', 'OVL');
    _scalOpenEdit(null, _day(12));
    var end = document.getElementById('scalEEnd');
    if (end.disabled) return 'end date disabled while All day is on';
    end.value = _day(14);
    var box = document.getElementById('scalEAllDay');
    box.checked = false; _scalAllDayChanged('scalE', false);
    if (!end.disabled || end.value) return 'end date not greyed and cleared when All day goes off';
    if (_scalReadForm('scalE').end_date !== null) return 'a timed event still sends an end date';
    box.checked = true; _scalAllDayChanged('scalE', true);
    return !end.disabled || 'end date stayed greyed when All day came back on';
});

t('types: no explanation under the Name field when adding', function () {
    _as('district manager', 'CORP');
    _scalSetTab('types');
    var hint = document.querySelector('#scalRoot .scal-cform .scal-field .scal-hint');
    return !hint || !hint.textContent.trim() || 'still says: ' + hint.textContent;
});

t('MSM: ticking both stores saves one copy to each', function () {
    _as('manager', 'BAL', true);
    _scalOpenEdit(null, _day(6));
    document.getElementById('scalETitle').value = 'Both stores';
    var before = __scalPosts.length;
    // The first copy posts synchronously; the second only after the first
    // resolves, which in this runner is after every test — so check it then.
    var done = _scalSaveStore();
    if (!__scalPosts[before] || __scalPosts[before].payload.event.store !== 'BAL') return 'first copy did not go to BAL';
    return done.then(function () {
        var sent = __scalPosts.slice(before).filter(function (p) { return p.payload.event && p.payload.event.title === 'Both stores'; })
            .map(function (p) { return p.payload.event.store; });
        return sent.join() === 'BAL,MPL' || 'copies posted to: ' + sent.join();
    });
});

// ---- 2026-10-05: everyone sees Company Events read-only; end date required ----
t('company events: every non-corporate role gets a view-only tab for its own store(s)', function () {
    var bad = [];
    [['manager', 'OVL', false], ['assistant manager', 'OVL', false], ['employee', 'OVL', false], ['store', 'OVL', false], ['manager', 'BAL', true]].forEach(function (c) {
        _as(c[0], c[1], c[2]);
        var who = c[0] + (c[2] ? ' (MSM)' : '');
        if (!/Company Events/.test(_text(document.getElementById('scalHeadExtra')))) { bad.push(who + ' has no Company Events tab'); return; }
        _scalSetTab('company');
        var root = document.getElementById('scalRoot');
        if (root.querySelector('form, .scal-cform')) bad.push(who + ' got the post form');
        if (root.querySelector('.scal-crow button')) bad.push(who + ' got edit/delete buttons');
        var txt = _text(root);
        if (c[2]) {
            if (txt.indexOf('BAL only notice') < 0) bad.push('MSM is missing the BAL notice');
        } else {
            if (txt.indexOf('District meeting') < 0 && _day(8) >= _scalTodayISO()) bad.push(who + ' is missing an all-store company event');
            if (txt.indexOf('BAL only notice') >= 0) bad.push(who + ' sees a BAL-only company event');
        }
    });
    _as('district manager', 'CORP'); _scalSetTab('company');
    if (!document.querySelector('#scalRoot .scal-cform')) bad.push('the DM lost the post form');
    return bad.length ? bad.join('; ') : true;
});

t('ends: an all-day event starts with the end = the start, and the start drags it along', function () {
    _as('manager', 'OVL');
    _scalOpenEdit(null, _day(12));
    var end = document.getElementById('scalEEnd'), start = document.getElementById('scalEDate');
    if (!end.required) return 'end date is not required for an all-day event';
    if (end.value !== start.value) return 'end did not start as the start date: ' + end.value;
    if (/optional/i.test(_text(document.querySelector('label[for="scalEEnd"]')))) return 'still labelled optional';
    start.value = _day(15); _scalStartChanged('scalE');
    if (end.value !== _day(15)) return 'moving the start past the end did not drag it: ' + end.value;
    end.value = '';
    document.getElementById('scalETitle').value = 'No end';
    var before = __scalPosts.length;
    _scalSaveStore();
    if (__scalPosts.length !== before) return 'saved with no end date';
    return /end date/.test(document.getElementById('scalEError').textContent) || 'no error for a missing end date';
});
