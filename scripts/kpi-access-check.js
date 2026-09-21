// STORE KPIs — the delegable all-stores view (cap-kpi-dm).
//
//   powershell -File scripts/browser-check.ps1 kpi-access-check.js -Html workspace.html
//
// Needs -Html because the thing being checked IS an attribute on the real
// element: the store picker in workspace.html's Store KPIs header. Building the
// markup inside the check would only prove the copy agrees with itself.
//
// What this guards. Before 2026-09-21 the picker was role-classes-only, so the
// DM's version of the tab — every store's weekly and monthly grid — could not be
// lent to anybody, and covering a KPI meeting meant handing over a login. It is
// a Feature Access key now. The risk that creates is the picker and the edge
// function disagreeing: a manager who can put OVL on screen must NOT be offered
// an Edit button, because kpi-manage answers that save with a 403. Most of the
// file is that second half.

function _srcOf(fn) {
    return String(fn)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// Every test below moves the signed-in identity around, so put it back after —
// otherwise a later test inherits whatever the last one left.
function asUser(role, store, msm, fn) {
    var keep = {
        role:  sessionStorage.getItem('speeksUserRole'),
        store: sessionStorage.getItem('speeksUserStore'),
        msm:   sessionStorage.getItem('speeksMultiStore'),
        view:  (typeof _kpiViewStore !== 'undefined') ? _kpiViewStore : null,
    };
    try {
        sessionStorage.setItem('speeksUserRole', role);
        sessionStorage.setItem('speeksUserStore', store);
        if (msm) sessionStorage.setItem('speeksMultiStore', 'true');
        else sessionStorage.removeItem('speeksMultiStore');
        return fn();
    } finally {
        if (keep.role  === null) sessionStorage.removeItem('speeksUserRole');   else sessionStorage.setItem('speeksUserRole', keep.role);
        if (keep.store === null) sessionStorage.removeItem('speeksUserStore');  else sessionStorage.setItem('speeksUserStore', keep.store);
        if (keep.msm   === null) sessionStorage.removeItem('speeksMultiStore'); else sessionStorage.setItem('speeksMultiStore', keep.msm);
        try { _kpiViewStore = keep.view; } catch (e) {}
    }
}

// ---- the catalog entry -----------------------------------------------------

t('cap-kpi-dm is in the catalog, so Feature Access can actually show it', function () {
    var f = FEATURE_CATALOG.find(function (x) { return x.key === 'cap-kpi-dm'; });
    if (!f) return 'no cap-kpi-dm entry — the picker is ungrantable again';
    if (f.tab !== 'widgets' || f.group !== 'Workspace') return 'filed under ' + f.tab + '/' + f.group + ', not widgets/Workspace beside its siblings';
    var missing = ['district-manager', 'ceo', 'mocd'].filter(function (r) { return f.def.indexOf(r) === -1; });
    if (missing.length) return 'default lost ' + missing.join(', ') + ' — roles that had the picker before would lose it';
    return f.def.indexOf('manager') === -1
        || 'manager is in the DEFAULT — that hands every store the whole district without anyone granting it';
});

t('cap-kpi-dm is offered on the Delegation tab', function () {
    // The whole point of the change: lend it for a meeting, take it back after.
    // _faCoverageTools drops anything managers hold by default, which is why the
    // test above cares that "manager" stays out of def.
    return _faCoverageTools().some(function (f) { return f.key === 'cap-kpi-dm'; })
        || 'not in _faCoverageTools — it can be set per role but not delegated';
});

// ---- the markup ------------------------------------------------------------

t('the Store KPIs picker carries the feature key and keeps its role gate', function () {
    var sel = document.getElementById('kpiModalStoreSelect');
    if (!sel) return 'kpiModalStoreSelect is not on the page';
    if (sel.getAttribute('data-feature') !== 'cap-kpi-dm') return 'no data-feature="cap-kpi-dm" — applyRoleBasedUI never asks about an override';
    if (!sel.classList.contains('dynamic-module-block')) return 'left the role sweep, so nothing gates it at all';
    // The classes stay: an override ADDS to the roles that already had it rather
    // than replacing them. Drop them and a grant becomes the only way in.
    var lost = ['role-district-manager', 'role-ceo', 'role-mocd'].filter(function (c) { return !sel.classList.contains(c); });
    return lost.length === 0 || 'lost ' + lost.join(', ') + ' — those roles now need an explicit grant';
});

t('the picker still lists all five stores', function () {
    var sel = document.getElementById('kpiModalStoreSelect');
    var got = Array.prototype.map.call(sel.options, function (o) { return o.value; }).join(',');
    return got === 'OVL,LEE,WSP,MPL,BAL' || 'options are ' + got;
});

// ---- who may still SAVE ----------------------------------------------------

t('a DM may edit any store', function () {
    return asUser('district manager', 'ALL', false, function () {
        _kpiViewStore = 'OVL';
        return _kpiCanEditNumbers() || 'the DM lost the Edit button on OVL';
    });
});

t('a manager may edit their own store', function () {
    return asUser('manager', 'LEE', false, function () {
        _kpiViewStore = 'LEE';
        return _kpiCanEditNumbers() || 'a manager lost Edit on their OWN store — the regression that matters most';
    });
});

t('a manager lent the picker gets NO Edit button on another store', function () {
    // The 403 this exists to prevent: kpi-manage answers a cross-store save with
    // "Cannot submit for another store", so offering the button is a dead end.
    return asUser('manager', 'LEE', false, function () {
        _kpiViewStore = 'OVL';
        return _kpiCanEditNumbers() === false || 'Edit offered on OVL to the LEE manager — that save comes back 403';
    });
});

t('an ASM is scoped the same way', function () {
    return asUser('assistant manager', 'WSP', false, function () {
        _kpiViewStore = 'MPL';
        if (_kpiCanEditNumbers()) return 'ASM offered Edit on a store that is not theirs';
        _kpiViewStore = 'WSP';
        return _kpiCanEditNumbers() || 'ASM lost Edit on their own store';
    });
});

t('an MSM covers both managed stores and neither of the others', function () {
    // An MSM signs in as role 'manager' with speeksMultiStore set, so a check
    // written against the role string would silently test a plain manager.
    return asUser('manager', 'BAL', true, function () {
        _kpiViewStore = 'MPL';
        if (!_kpiCanEditNumbers()) return 'MSM lost Edit on MPL, which they manage';
        _kpiViewStore = 'BAL';
        if (!_kpiCanEditNumbers()) return 'MSM lost Edit on BAL, which they manage';
        _kpiViewStore = 'OVL';
        return _kpiCanEditNumbers() === false || 'MSM offered Edit on OVL, which they do not manage';
    });
});

t('an employee is offered nothing', function () {
    return asUser('employee', 'OVL', false, function () {
        _kpiViewStore = 'OVL';
        return _kpiCanEditNumbers() === false || 'an employee was offered the Edit button';
    });
});

t('_kpiSyncHeaderBtns asks the store-aware check, not a role list', function () {
    var src = _srcOf(_kpiSyncHeaderBtns);
    if (src.indexOf('_kpiCanEditNumbers') === -1) return 'it is back to its own role test — a borrowed picker will offer a 403 button';
    return src.indexOf("'district manager'") === -1
        || 'a hand-rolled role comparison came back alongside the helper';
});

// ---- where the picker opens ------------------------------------------------

t('a manager lent the picker opens on their own store, not OVL', function () {
    var sel = document.getElementById('kpiModalStoreSelect');
    return asUser('manager', 'WSP', false, function () {
        _kpiViewStore = null;
        sel.value = 'OVL';
        _kpiSeedStorePicker();
        return sel.value === 'WSP' || 'opened on ' + sel.value + ' — their own store is the one they would have to go looking for';
    });
});

t('a DM keeps whatever store was selected', function () {
    var sel = document.getElementById('kpiModalStoreSelect');
    return asUser('district manager', 'ALL', false, function () {
        _kpiViewStore = null;
        sel.value = 'MPL';
        _kpiSeedStorePicker();
        return sel.value === 'MPL' || 'the DM was moved to ' + sel.value + ' — ALL matches no option, so nothing should have happened';
    });
});

t('an MSM routed here by a store card opens on THAT store', function () {
    var sel = document.getElementById('kpiModalStoreSelect');
    return asUser('manager', 'BAL', true, function () {
        _kpiViewStore = 'MPL';
        sel.value = 'OVL';
        _kpiSeedStorePicker();
        return sel.value === 'MPL' || 'opened on ' + sel.value + ' — the feed card asked for MPL';
    });
});
