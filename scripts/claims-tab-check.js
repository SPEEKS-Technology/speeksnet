// CLAIMS & DISPUTES AS A WORKSPACE TAB (2026-10-06) — was two SPEEKS Tools popups.
//
//   powershell -File scripts/browser-check.ps1 claims-tab-check.js -Html workspace.html
//
// Asserts about the REAL markup (-Html), because the move is markup: the two
// popups' bodies now live in #ws-pane-claims under their old ids, and every
// function in the CLAIMS & DISPUTES section finds its elements by those ids.

function vis(id) { var e = document.getElementById(id); return !!e && e.style.display !== 'none'; }
function as(role, store) {
    sessionStorage.setItem('speeksUserRole', role);
    sessionStorage.setItem('speeksUserName', 'Check User');
    sessionStorage.setItem('speeksUserStore', store || 'ALL');
}

t('page has the pane, both tab buttons, and no popups left', function () {
    if (!document.getElementById('ws-pane-claims')) return 'run with -Html workspace.html';
    var miss = ['ws-tab-claims', 'ws-tab-claimsdm', 'claims-ws-store', 'claims-ws-ov', 'claimsFooter',
        'claims-panel-new', 'claims-panel-view', 'claims-panel-mismatch', 'claims-panel-returns', 'claims-panel-cases', 'claims-panel-payments',
        'ov-panel-claims', 'claims-oversight-body', 'hold-ov-mismatch', 'hold-ov-payments', 'hold-mgr-badge-cases', 'submitClaimBtn']
        .filter(function (id) { return !document.getElementById(id); });
    if (miss.length) return 'missing: ' + miss.join(', ');
    if (document.getElementById('claimsModal') || document.getElementById('claimsOversightModal')) return 'a popup is still in the page';
    return true;
});
t('no id is duplicated in the page', function () {
    var seen = {}, dup = [];
    document.querySelectorAll('[id]').forEach(function (e) { if (seen[e.id]) dup.push(e.id); seen[e.id] = 1; });
    var claimsDup = dup.filter(function (id) { return /claim|hold-|ov-/.test(id); });
    return !claimsDup.length || 'duplicated: ' + claimsDup.join(', ');
});
t('SPEEKS Tools no longer lists the tool', function () {
    return !document.querySelector('.tools-item[data-feature^="tool-claims"]') || 'still in the tools panel';
});
t('tab buttons carry the two feature keys and role gates', function () {
    var s = document.getElementById('ws-tab-claims'), d = document.getElementById('ws-tab-claimsdm');
    if (s.getAttribute('data-feature') !== 'tool-claims-store') return 'store button key';
    if (d.getAttribute('data-feature') !== 'tool-claims-oversight') return 'DM button key';
    if (!s.classList.contains('role-manager') || !s.classList.contains('role-owner-manager')) return 'store roles';
    if (!d.classList.contains('role-district-manager') || !d.classList.contains('role-ceo')) return 'DM roles';
    return true;
});
t('Feature Access: both keys are Workspace widgets now', function () {
    var a = FEATURE_CATALOG.find(function (f) { return f.key === 'tool-claims-store'; });
    var b = FEATURE_CATALOG.find(function (f) { return f.key === 'tool-claims-oversight'; });
    if (!a || !b) return 'a key is missing from FEATURE_CATALOG';
    if (a.tab !== 'widgets' || a.group !== 'Workspace' || b.tab !== 'widgets' || b.group !== 'Workspace') return 'not in Workspace';
    if (String(a.def) !== 'manager,owner-manager' || String(b.def) !== 'district-manager,ceo') return 'defaults changed';
    return true;
});
t('manager: the tab opens the store tool on the claims list', function () {
    as('Manager', 'OVL');
    switchWorkspaceTab('claims');
    if (!document.getElementById('ws-pane-claims').classList.contains('active')) return 'pane not active';
    if (!vis('claims-ws-store') || vis('claims-ws-ov')) return 'wrong view';
    if (!vis('claims-panel-view') || vis('claims-panel-new')) return 'not on the list';
    if (vis('claimsFooter')) return 'empty footer showing';
    return document.getElementById('claim-store').value === 'OVL' || 'store picker not built';
});
t('manager: New Claim shows the form and its footer, Cancel hides it', function () {
    startNewClaim();
    if (!vis('claims-panel-new') || !vis('claimsFooter') || !vis('submitClaimBtn')) return 'form/footer not shown';
    switchClaimsTab('view');
    return (!vis('claimsFooter') && vis('claims-panel-view')) || 'footer stayed';
});
t('manager: openClaimsTool(sub-tab) lands on that sub-tab', function () {
    openClaimsTool('mismatch');
    return (vis('claims-panel-mismatch') && document.getElementById('claims-tab-mismatch').classList.contains('active')) || 'not on mismatches';
});
t('DM: the tab opens the oversight view', function () {
    as('District Manager');
    openClaimsTool('cases');
    if (!vis('claims-ws-ov') || vis('claims-ws-store')) return 'wrong view';
    if (!vis('ov-panel-cases') || vis('ov-panel-claims')) return 'not on cases';
    if (!document.getElementById('ws-tab-claimsdm').classList.contains('active')) return 'DM tab not lit';
    return /every store/.test(document.getElementById('claims-ws-sub').textContent) || 'subtitle';
});
t('the old popup openers still work, through the tab', function () {
    as('District Manager');
    switchWorkspaceTab('brief');
    openClaimsOversight();
    return vis('ov-panel-claims') || 'oversight opener did nothing';
});
t('#claims is an accepted deep link', function () {
    return /'claims'\]\.includes\(hash\)/.test(String(initWorkspace)) || 'claims missing from the hash list';
});
t('Ctrl+K has the tab', function () {
    var p = JUMP_PLACES.find(function (x) { return x.id === 'ws-claims'; });
    return (p && p.hash === 'claims' && p.page === 'workspace.html') || 'no ws-claims jump entry';
});
t('a manager lent the DM version: each button opens its own view', function () {
    as('Manager', 'OVL');
    openClaimsView('ov');
    if (!vis('claims-ws-ov') || vis('claims-ws-store')) return 'DM button opened the store view';
    if (!document.getElementById('ws-tab-claimsdm').classList.contains('active') || document.getElementById('ws-tab-claims').classList.contains('active')) return 'wrong button lit (ov)';
    openClaimsView('store');
    if (!vis('claims-ws-store') || vis('claims-ws-ov')) return 'store button opened the DM view';
    return (document.getElementById('ws-tab-claims').classList.contains('active') && !document.getElementById('ws-tab-claimsdm').classList.contains('active')) || 'wrong button lit (store)';
});
t('an alert after a button click still picks the view by role', function () {
    as('Manager', 'OVL');
    openClaimsView('ov');
    openClaimsTool('view');
    return vis('claims-ws-store') || 'alert reused the last button view';
});

// Desktop only: run with -WindowSize 1440,1000. At the harness's default phone
// width data-mobile="hide" hides every Workspace tab, so a visibility assertion
// there passes for the wrong reason (it did, once, for Aging Inventory).
[['District Manager', false, true], ['CEO', false, true], ['Manager', true, false],
 ['Owner (Manager)', true, false], ['Assistant Manager', false, false]].forEach(function (r) {
    t('desktop: ' + r[0] + ' sees ' + (r[1] ? 'store ' : '') + (r[2] ? 'DM ' : '') + (!r[1] && !r[2] ? 'no ' : '') + 'button', function () {
        if (_isMobileLayout()) return 'run with -WindowSize 1440,1000';
        as(r[0], r[1] ? 'OVL' : 'ALL');
        try { applyRoleBasedUI(); } catch (e) { /* later steps may need the network */ }
        var s = document.getElementById('ws-tab-claims').style.display !== 'none';
        var d = document.getElementById('ws-tab-claimsdm').style.display !== 'none';
        return (s === r[1] && d === r[2]) || ('store=' + s + ' dm=' + d);
    });
});
t('desktop: the Variance tab is visible too (sanity: the sweep really ran at desktop)', function () {
    if (_isMobileLayout()) return 'run with -WindowSize 1440,1000';
    as('District Manager'); try { applyRoleBasedUI(); } catch (e) {}
    return document.getElementById('ws-tab-vreplies').style.display !== 'none' || 'vreplies hidden — sweep did not run as desktop';
});
