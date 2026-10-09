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

// Needs the real page: run with -Html workspace.html.
// The tab must be ABSENT from the markup. An earlier version checked its
// display after applyRoleBasedUI and passed falsely: the headless window counts
// as a phone, where data-mobile="hide" hides it anyway, while a desktop DM still
// saw it — the sweep reads role classes, never FEATURE_CATALOG.
t('workspace.html has no aging tab button', function () {
    if (!document.getElementById('ws-pane-aging')) return 'run with -Html workspace.html';
    return !document.getElementById('ws-tab-aging') || 'ws-tab-aging is still in the markup';
});
t('#aging deep link opens the brief', function () {
    sessionStorage.setItem('speeksUserRole', 'District Manager');
    try { switchWorkspaceTab('aging'); } catch (e) { /* loaders may fail offline */ }
    var pane = document.getElementById('ws-pane-aging');
    return (pane && !pane.classList.contains('active')) || 'aging pane opened';
});
