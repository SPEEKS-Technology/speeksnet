// KPI — the DM row added with "+ Add Ethan Kushnir (DM)" can be taken off again.
//
//   powershell -File scripts/browser-check.ps1 kpi-remove-dm-check.js
//
// Before 2026-11-15 the only way to undo the add was to clear every box and
// Save (the delete-on-empty rule). Now the DM / CEO row carries "✕ Remove"
// while editing; roster rows never do.

var _posted = [];
var _renders = 0;
_kpiPostEntry = function (body) { _posted.push(body); return new Promise(function () {}); };
_kpiRenderWeekly = function () { _renders++; };
_kpiRenderMonthly = function () { _renders++; };
_kpiResolveStore = function () { return 'OVL'; };
confirm = function () { return true; };
try { localStorage.setItem('speeksAuthCache', JSON.stringify({ users: [{ name: 'Ethan Kushnir', role: 'District Manager' }] })); } catch (e) {}
sessionStorage.setItem('speeksUserRole', 'manager');
sessionStorage.setItem('speeksUserName', 'Mia Manager');
sessionStorage.setItem('speeksUserPin', '1234');

function _period(dmEntry) {
    return { period_end_date: '2026-11-15', is_editable: true, entries: [
        { employee_name: 'Alice Adams' }, dmEntry, { employee_name: 'Bob Baker' }] };
}

t('DM row shows Remove while editing; roster rows do not', function () {
    var html = _kpiEmpRowsHtml(_period({ employee_name: 'Ethan Kushnir', _selfAdded: true }).entries, '2026-11-15', true, false);
    var n = (html.match(/_kpiRemoveExtra\(/g) || []).length;
    if (n !== 1) return 'expected 1 Remove button, got ' + n;
    return /_kpiRemoveExtra\('2026-11-15',1\)/.test(html) || 'button points at the wrong row';
});

t('no Remove outside edit mode', function () {
    var html = _kpiEmpRowsHtml(_period({ employee_name: 'Ethan Kushnir', id: 9 }).entries, '2026-11-15', false, false);
    return !/_kpiRemoveExtra\(/.test(html) || 'Remove shown in view mode';
});

t('unsaved DM row is dropped locally, no server call', function () {
    _kpiCurrentTab = 'weekly';
    _kpiPeriodsData = [_period({ employee_name: 'Ethan Kushnir', _selfAdded: true })];
    _posted = []; _renders = 0;
    _kpiRemoveExtra('2026-11-15', 1);
    var names = _kpiPeriodsData[0].entries.map(function (e) { return e.employee_name; }).join(',');
    if (names !== 'Alice Adams,Bob Baker') return 'entries now: ' + names;
    if (_posted.length) return 'posted to the server for an unsaved row';
    return _renders === 1 || 'expected one re-render, got ' + _renders;
});

t('saved DM row sends delete_entry for that name', function () {
    _kpiPeriodsData = [_period({ employee_name: 'Ethan Kushnir', id: 42 })];
    _posted = [];
    _kpiRemoveExtra('2026-11-15', 1);
    var b = _posted[0];
    if (!b) return 'nothing posted';
    if (b.action !== 'delete_entry' || b.employee_name !== 'Ethan Kushnir' || b.store !== 'OVL' || b.period_type !== 'weekly')
        return 'wrong body: ' + JSON.stringify(b);
    return true;
});

t('a roster row cannot be removed even if called directly', function () {
    _kpiPeriodsData = [_period({ employee_name: 'Ethan Kushnir', _selfAdded: true })];
    _posted = [];
    _kpiRemoveExtra('2026-11-15', 0);
    return _kpiPeriodsData[0].entries.length === 3 || 'Alice was removed';
});
