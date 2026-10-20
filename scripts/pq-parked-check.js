// PICTURE QUALITY IS PARKED (v3.9.3, 2026-10-20).
//
//   powershell -File scripts/browser-check.ps1 pq-parked-check.js
//
// It went live by accident with an earlier merge while still being built, and
// Ethan wanted it "as if it was never added to the live site" — for everyone,
// the DM included. The only picture item left on Listing Health is No Photos,
// drawn the way it was before the grader: its own "Live With No Photos" section,
// a tab called No Photos, a plain red row on the All Stores card.
//
// Delete this file when ec-view-picture-quality goes back into FEATURE_CATALOG.

function pkAs(role) { sessionStorage.setItem('speeksUserRole', role); }
function pkSetup() {
    _ecStore = 'OVL';
    _pqData = null;
    _pqCounts = null;
    _lhScope = { mayPhotos: true, mayCats: true };
    _lhPhotos = { store: 'OVL', queue: [] };
    _lhPhotoErr = null;
}

t('the catalog entry is commented out, so nobody holds the switch', function () {
    if (FEATURE_CATALOG.some(function (f) { return f.key === 'ec-view-picture-quality'; })) return 'still in FEATURE_CATALOG';
    var roles = ['role-district-manager', 'role-ceo', 'role-manager', 'role-assistant-manager'];
    var on = roles.filter(function (r) { return _featureEffectiveVisible('ec-view-picture-quality', r, 'Someone'); });
    return !on.length || 'visible to ' + on.join(', ');
});

t('Listing Health says the grader half is off', function () {
    pkAs('District Manager'); pkSetup();
    return _lhMay('pictures') === false || '_lhMay(pictures) is ' + _lhMay('pictures');
});

t('the DM gets the pre-grader No Photos section, with no Confirm Shots', function () {
    pkAs('District Manager'); pkSetup();
    var h = _pqHtml();
    if (h.indexOf('Live With No Photos') < 0) return 'not the No Photos section';
    if (/Confirm Shots|More For Training/.test(h)) return 'Confirm Shots still drawn';
    if (/Retake|Fix These Photos|Reorder|Picture Quality/.test(h)) return 'grader text still drawn';
    return true;
});

t('a manager gets the same No Photos section', function () {
    pkAs('Manager'); pkSetup();
    var h = _pqHtml();
    return (h.indexOf('Live With No Photos') >= 0 && h.indexOf('Picture Quality') < 0) || 'manager view wrong';
});

t('the Listing Health tab is called No Photos', function () {
    pkAs('District Manager'); pkSetup();
    var h = _lhHtml();
    if (h.indexOf('Picture Quality') >= 0) return 'a tab still says Picture Quality';
    return h.indexOf('No Photos') >= 0 || 'no No Photos tab';
});

t('the All Stores card shows No Photos as a plain row, not a Picture Quality drawer', function () {
    pkAs('District Manager'); pkSetup();
    _rcCounts = { photos: { OVL: 2 }, other: { OVL: 0 }, misfiled: { OVL: 0 }, unmatched: { OVL: 0 } };
    var h = _ecHealthCats('OVL');
    if (h.indexOf('Picture Quality') >= 0) return 'card still has a Picture Quality drawer';
    return h.indexOf('No Photos') >= 0 || 'No Photos row missing';
});
