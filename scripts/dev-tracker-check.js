// DEVELOPMENT TRACKER — behaviour checks (docs/plans/dev-tracker-HANDOFF.md).
//
//   powershell -File scripts/browser-check.ps1 dev-tracker-check.js
//
// Phase 1 is the data model (migration 0187) and the dev-tickets edge function;
// the only browser-side piece so far is Feature Access. These pin down D2 —
// dev access is a per-person grant, not a role — because a role default here
// would quietly hand the tracker (and later, Publish) to every DM, CEO or
// manager the day a new one is hired. The dev-tickets function holds the same
// defaults (DEFAULTS there): if one of these fails after a deliberate change,
// change the function too.
//
// Phase 3 adds the page and the header button; its checks go in this file
// (behaviour), dev-tracker-layout-check.js and a -Html one, as Projects does.

_featureOv = { role: {}, user: {} };

var EVERY_ROLE = ['ceo', 'district-manager', 'mocd', 'owner-manager', 'manager', 'assistant-manager', 'employee', 'store'];
function sees(key, role, name) { return _featureEffectiveVisible(key, 'role-' + role, name || 'Someone'); }
function entry(key) { return FEATURE_CATALOG.filter(function (f) { return f.key === key; })[0]; }

t('catalog: dev-tracker is listed, next to the settings cog it will sit beside', function () {
    var e = entry('dev-tracker');
    if (!e) return 'no dev-tracker entry in FEATURE_CATALOG';
    return (e.tab === 'hotbar' && e.group === 'Top Bar') || 'filed under ' + e.tab + ' / ' + e.group;
});
t('catalog: dev-release-publish is listed', function () {
    return !!entry('dev-release-publish') || 'no dev-release-publish entry in FEATURE_CATALOG';
});
t('access: no role gets the tracker by default — not even the DM', function () {
    var who = EVERY_ROLE.filter(function (r) { return sees('dev-tracker', r); });
    return !who.length || 'on by default for: ' + who.join(', ');
});
t('access: no role can publish a release by default', function () {
    var who = EVERY_ROLE.filter(function (r) { return sees('dev-release-publish', r); });
    return !who.length || 'on by default for: ' + who.join(', ');
});
t('access: a per-person grant switches the tracker on for that person only', function () {
    // feature-access writes the subject lower-cased; 0187 seeds Nick and Ethan this way.
    _featureOv = { role: {}, user: { 'dev-tracker': { 'nick hettinger': true, 'ethan kushnir': true } } };
    try {
        if (!sees('dev-tracker', 'manager', 'Nick Hettinger')) return 'Nick (a manager) not granted';
        if (!sees('dev-tracker', 'district-manager', 'Ethan Kushnir')) return 'Ethan (the DM) not granted';
        if (sees('dev-tracker', 'district-manager', 'Ethan Frye')) return 'another Ethan was granted by first name';
        if (sees('dev-tracker', 'manager', 'Someone Else')) return 'leaked to another manager';
        return true;
    } finally { _featureOv = { role: {}, user: {} }; }
});
t('access: the tracker grant does not carry publish with it', function () {
    _featureOv = { role: {}, user: { 'dev-tracker': { 'nick hettinger': true } } };
    try {
        return !sees('dev-release-publish', 'manager', 'Nick Hettinger') || 'holding dev-tracker also granted publish';
    } finally { _featureOv = { role: {}, user: {} }; }
});
t('access: a per-person "off" beats a role grant', function () {
    _featureOv = { role: { 'dev-tracker': { 'district-manager': true } }, user: { 'dev-tracker': { 'ethan kushnir': false } } };
    try {
        if (!sees('dev-tracker', 'district-manager', 'Someone')) return 'role grant ignored';
        return !sees('dev-tracker', 'district-manager', 'Ethan Kushnir') || 'user override did not win over the role';
    } finally { _featureOv = { role: {}, user: {} }; }
});
