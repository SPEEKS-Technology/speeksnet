// Aging Inventory is PAUSED (2026-10-06): no catalog entry, nothing visible,
// no reminder checks. Delete this file when the tool is restored.
t('catalog has no aging keys', function () {
    const k = FEATURE_CATALOG.map(f => f.key);
    return (!k.includes('widget-aging-inventory') && !k.includes('cap-aging-dm')) || 'aging key still in FEATURE_CATALOG';
});
t('DM sees nothing', function () {
    sessionStorage.setItem('speeksUserRole', 'District Manager');
    sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
    return (!_agEnabled() && !_agIsDM() && !_agIsStoreUser()) || 'DM still resolves aging on';
});
t('manager sees nothing, no dot', function () {
    sessionStorage.setItem('speeksUserRole', 'Manager');
    sessionStorage.setItem('speeksUserName', 'Test Manager');
    _agMyItemsCache = [{ status: 'open', due_at: new Date(Date.now() - 864e5).toISOString() }];
    const ok = !_agIsStoreUser() && !_agDotNeeded();
    _agMyItemsCache = [];
    return ok || 'manager still resolves aging on';
});
t('reminder checks are no-ops', function () {
    const f = window.fetch; let called = 0; window.fetch = function () { called++; return f.apply(this, arguments); };
    try { checkAgingInvReminders(); checkAgingInvDmReminders(); } finally { window.fetch = f; }
    return called === 0 || 'a reminder check still fetched';
});
t('Ctrl+K has no visible aging entry', function () {
    return !_featureEffectiveVisible('widget-aging-inventory', 'role-district-manager', 'Ethan Kushnir') || 'still visible';
});

// Needs the real page: run with -Html workspace.html. Without it these skip.
['District Manager', 'Manager', 'Assistant Manager', 'CEO'].forEach(function (role) {
    t('workspace tab hidden for ' + role, function () {
        var tab = document.getElementById('ws-tab-aging');
        if (!tab) return true; // no page inlined
        sessionStorage.setItem('speeksUserRole', role);
        sessionStorage.setItem('speeksUserName', 'Ethan Kushnir');
        sessionStorage.setItem('speeksUserStore', 'ALL');
        try { applyRoleBasedUI(); } catch (e) { /* the sweep runs before anything that needs the network */ }
        return tab.style.display === 'none' || ('visible: display=' + tab.style.display);
    });
});
t('#aging deep link opens the brief', function () {
    if (!document.getElementById('ws-tab-aging')) return true;
    sessionStorage.setItem('speeksUserRole', 'District Manager');
    try { switchWorkspaceTab('aging'); } catch (e) { /* loaders may fail offline */ }
    var pane = document.getElementById('ws-pane-aging');
    return !pane.classList.contains('active') || 'aging pane opened';
});
