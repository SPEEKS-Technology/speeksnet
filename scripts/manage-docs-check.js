// MANAGE POLICIES — category picker and "+ Add Policy" placement.
//
//   powershell -File scripts/browser-check.ps1 manage-docs-check.js -Html index.html
//
// Needs the real page for #manageDocsList / #manageDocsSearch.

globalDocsData = [
    { category: 'Store Operations, Pinned', icon: '📄', title: 'Shift coverage', desc: 'd', link: '' },
    { category: 'HR', icon: '📄', title: 'Time off', desc: 'd', link: '' },
];
function _open() { populateManageModal(); return document.getElementById('manageDocsList'); }

t('categories are de-duplicated and Pinned is not one', function () {
    _open();
    const c = _manageDocCategories();
    return JSON.stringify(c) === '["HR","Store Operations"]' || 'got ' + JSON.stringify(c);
});

t('an existing row selects its category and keeps it in .m-category', function () {
    const row = _open().querySelector('.manage-row');
    const sel = row.querySelector('.m-cat-sel'), inp = row.querySelector('.m-category');
    if (sel.value !== 'Store Operations') return 'select = ' + sel.value;
    if (inp.value !== 'Store Operations') return 'input = ' + inp.value;
    return row.querySelector('.m-pinned').checked || 'pin lost';
});

t('+ Add Policy puts the new card first, with the search cleared', function () {
    const list = _open();
    document.getElementById('manageDocsSearch').value = 'zzz';
    filterManageDocs();
    addNewPolicy();
    const first = list.querySelector('.manage-row');
    if (first.querySelector('.m-title').value !== '') return 'first row is not the new one';
    if (document.getElementById('manageDocsSearch').value) return 'search not cleared';
    return first.style.display !== 'none' || 'new row hidden';
});

t('picking a category writes it; "+ New" lets you type one that saves', function () {
    const list = _open();
    const row = addNewPolicy() || list.querySelector('.manage-row');
    const sel = row.querySelector('.m-cat-sel'), inp = row.querySelector('.m-category');
    sel.value = 'HR'; _manageCatPick(sel);
    if (inp.value !== 'HR') return 'pick did not write: ' + inp.value;
    sel.value = '__new'; _manageCatPick(sel);
    if (inp.style.display === 'none') return 'new-category box not shown';
    inp.value = 'Safety';
    return _manageDocCategories().includes('Safety') || 'typed category not offered to the next card';
});

t('an existing policy has no "Choose a category" option; a new one does', function () {
    const list = _open();
    const old = list.querySelector('.manage-row .m-cat-sel');
    if ([...old.options].some(o => o.value === '')) return 'placeholder on an existing policy';
    addNewPolicy();
    const fresh = list.querySelector('.manage-row .m-cat-sel');
    return fresh.value === '' || 'new policy does not start on the placeholder';
});

t('a category nothing uses any more drops out', function () {
    const list = _open();
    [...list.querySelectorAll('.manage-row')].find(r => r.querySelector('.m-category').value === 'HR').remove();
    return !_manageDocCategories().includes('HR') || 'HR still offered';
});

t('reopening starts at the top of the list', function () {
    const list = _open();
    for (let i = 0; i < 20; i++) addManageRow();
    list.style.height = '200px'; list.style.overflowY = 'auto';
    list.scrollTop = 99999;
    if (list.scrollTop === 0) return 'list did not scroll, test proves nothing';
    populateManageModal();
    return list.scrollTop === 0 || 'scrollTop = ' + list.scrollTop;
});
