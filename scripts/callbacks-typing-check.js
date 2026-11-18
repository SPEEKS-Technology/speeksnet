// CALL BACKS — a redraw must not eat what somebody is typing, and the feed card
// stops counting a call back once it is Contacted.
//
//   powershell -File scripts/browser-check.ps1 callbacks-typing-check.js
//
// 2026-11-06: Ethan was typing a new call back and the fields emptied "as if it
// got submitted, but it never was". cbRender rebuilds the pane with innerHTML,
// and the realtime repaint (any store's add sets it off), the 5s re-fetch after
// an add and every row action all called it without checking for focus. The fix
// snapshots every field in cbRender itself; these checks drive a redraw with text
// in the fields and assert it is still there.

sessionStorage.setItem('speeksUserName', 'Test Manager');
sessionStorage.setItem('speeksUserRole', 'manager');
sessionStorage.setItem('speeksUserStore', 'BAL');
window.cbPost = function () { return Promise.resolve({}); };   // no live write

function _cbtSetup() {
    var old = document.getElementById('cbBody');
    if (old) old.remove();
    var body = document.createElement('div');
    body.id = 'cbBody';
    document.body.appendChild(body);
    _cbVocab = [{ handle: 'video-game-systems', title: 'Video Game Systems',
                  types: [{ id: 31, name: 'Nintendo Switch 2' }, { id: 32, name: 'PS5' }] }];
    _cbCache = [{ id: 'a1', store: 'BAL', customer_name: 'Ann', phone: '3145550000', item: 'PS5',
                  status: 'open', date_of_call: _cbDaysAgo(1), notes: [], matches: [],
                  category_handle: 'video-game-systems', category_title: 'Video Game Systems' }];
    _cbView = 'mine';
    _cbEditingId = null; _cbExpandedId = null; _cbAddFor = null; _cbLastAdded = null;
    cbRender();
    return body;
}

t('typed quick-add fields survive a background redraw', function () {
    _cbtSetup();
    var name = document.getElementById('cbAddName');
    if (!name) return 'quick-add form did not render';
    name.value = 'Benjamin';
    document.getElementById('cbAddPhone').value = '3145551234';
    document.getElementById('cbAddItem').value = 'Zelda Edition Switch 2';
    document.getElementById('cbAddNoteTxt').value = 'call after 5';
    document.getElementById('cbAddAnyModel').checked = true;
    document.getElementById('cbAddItem').focus();
    cbRender();   // what the realtime repaint / 5s re-fetch does
    var bad = [];
    if (document.getElementById('cbAddName').value !== 'Benjamin') bad.push('name');
    if (document.getElementById('cbAddPhone').value !== '3145551234') bad.push('phone');
    if (document.getElementById('cbAddItem').value !== 'Zelda Edition Switch 2') bad.push('item');
    if (document.getElementById('cbAddNoteTxt').value !== 'call after 5') bad.push('note');
    if (!document.getElementById('cbAddAnyModel').checked) bad.push('any model');
    if (document.activeElement !== document.getElementById('cbAddItem')) bad.push('focus');
    return bad.length ? 'lost: ' + bad.join(', ') : true;
});

t('category AND type survive a redraw (type options rebuilt first)', function () {
    _cbtSetup();
    var cat = document.getElementById('cbAddCategory');
    cat.value = 'video-game-systems';
    cbCategoryChanged('cbAddCategory', 'cbAddType');
    document.getElementById('cbAddType').value = '31';
    cbRender();
    if (document.getElementById('cbAddCategory').value !== 'video-game-systems') return 'category lost';
    if (document.getElementById('cbAddType').value !== '31') return 'type lost: "' + document.getElementById('cbAddType').value + '"';
    return true;
});

t('a successful Add still empties the form', function () {
    _cbtSetup();
    document.getElementById('cbAddName').value = 'Benjamin';
    document.getElementById('cbAddPhone').value = '3145551234';
    document.getElementById('cbAddItem').value = 'Zelda Edition Switch 2';
    document.getElementById('cbAddCategory').value = 'video-game-systems';
    cbQuickAdd();
    var left = ['cbAddName', 'cbAddPhone', 'cbAddItem'].filter(function (id) {
        return document.getElementById(id).value !== '';
    });
    return left.length ? 'still filled after Add: ' + left.join(', ') : true;
});

t('Cancel (Add Another Item off) still empties the form', function () {
    _cbtSetup();
    _cbLastAdded = { name: 'Ann', phone: '3145550000', store: 'BAL' };
    cbAddAnotherItem();
    if (document.getElementById('cbAddName').value !== 'Ann') return 'Add Another Item did not pre-fill';
    cbAddForClear();
    return document.getElementById('cbAddName').value === '' ? true : 'name kept after Cancel';
});

t('opening Edit on another row does not carry the first row\'s fields over', function () {
    _cbtSetup();
    _cbCache.push({ id: 'b2', store: 'BAL', customer_name: 'Bob', phone: '3145559999', item: 'Xbox',
                    status: 'open', date_of_call: _cbDaysAgo(2), notes: [], matches: [],
                    category_handle: 'video-game-systems', category_title: 'Video Game Systems' });
    cbEditEntry('a1');
    var n = document.getElementById('cbEditName');
    if (!n) return 'edit row did not render';
    n.value = 'Ann CHANGED';
    cbEditEntry('b2');
    var n2 = document.getElementById('cbEditName');
    return n2 && n2.value !== 'Ann CHANGED' ? true : 'Bob\'s edit row shows Ann\'s typed name';
});

t('feed card skips Contacted call backs (BAL, Nov 6)', function () {
    var rows = [
        { id: 'c1', store: 'LEE', item: 'unifi access point', status: 'contacted', matches: [{ state: 'suggested', store_code: 'BAL' }] },
        { id: 'c2', store: 'WSP', item: 'Just Dance', status: 'contacted', matches: [{ state: 'suggested', store_code: 'BAL' }] },
        { id: 'c3', store: 'BAL', item: 'Zelda Edition Nintendo Switch 2 Console', status: 'open', matches: [{ state: 'suggested', store_code: 'BAL' }] },
    ];
    var anchor = document.getElementById('claimAlertBubble');
    if (!anchor) { anchor = document.createElement('div'); anchor.id = 'claimAlertBubble'; document.body.appendChild(anchor); }
    window.cbFetch = function () { return Promise.resolve(rows); };
    return checkCallbackMatchReminders().then(function () {
        var t = document.getElementById('cbMatchAlertBubbleText');
        if (!t) return 'bubble text missing';
        var s = t.dataset.summary || '';
        if (!/^1 call back you can answer/.test(s)) return 'summary: ' + s;
        return true;
    });
});
