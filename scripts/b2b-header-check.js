// B2B HEADER — checks that need the REAL markup.
//
//   powershell -File scripts/browser-check.ps1 b2b-header-check.js -Html operations.html
//
// Separate from b2b-check.js on purpose. These assert about the DOM as
// operations.html actually declares it -- ids, role classes, data-feature,
// which element sits inside which -- and that needs the page inlined, which is
// what -Html does. Keeping them here means the main suite stays runnable with
// no page at all and cannot start failing for want of a flag.
//
// The alternative was building the markup inside the check, which proves only
// that the copy agrees with itself -- and the whole point of these is that the
// role gate and Feature Access are driven by attributes on the real elements.

// Local copy of b2b-check.js's helper. Duplicated rather than shared because
// the runner loads exactly one check file, and five lines in two places beats a
// module system this project deliberately does not have.
//
// Why it exists at all: three checks in the main suite have failed against
// working code because the word they searched for was in the comment explaining
// it. speeks.js is heavily commented on purpose, so a bare substring search
// over a function's text searches prose as much as code.
function _srcOf(fn) {
    return String(fn)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

t('trial: the secondary buttons moved into the menu, unchanged', function () {
    // MOVED, not rebuilt. The ids, role classes, data-feature and handlers are
    // what the role gate and Feature Access drive; rebuilding them is how a
    // permission check quietly goes missing.
    var menu = document.getElementById('b2bActionsMenu');
    if (!menu) return 'no actions menu in the page';
    var ids = ['b2bDelReqBtn', 'crmGearBtn', 'b2bCaptureDlBtn', 'b2bFeedbackBtn'];
    var missing = ids.filter(function (id) { return !menu.querySelector('#' + id); });
    if (missing.length) return 'not in the menu: ' + missing.join(', ');
    if (!menu.querySelector('#crmGearBtn').classList.contains('role-ceo')) {
        return 'the gear lost its role gate';
    }
    if (menu.querySelector('#b2bCaptureDlBtn').getAttribute('data-feature') !== 'b2b-capture-download') {
        return 'Capture lost its feature key';
    }
    return menu.querySelector('#b2bDelReqBtn').classList.contains('dynamic-module-flex')
        || 'Delete Requests is no longer swept by the role gate';
});
t('trial: navigation and the primary action stay in the header', function () {
    // The tabs are navigation, not actions, and + New Deal is the one thing
    // people come to this header to do. Burying either trades clutter for an
    // extra click on the common case.
    var menu = document.getElementById('b2bActionsMenu');
    if (menu && menu.querySelector('#b2bNewBtn')) return 'New Deal got buried in the menu';
    if (menu && menu.querySelector('.b2b-view-toggle')) return 'the view tabs got buried';
    return !!document.getElementById('b2bNewBtn') || 'the New Deal button vanished';
});
t('trial: an empty menu hides its own trigger', function () {
    // An "Actions" button that opens an empty box is worse than no button.
    var wrap = document.getElementById('b2bActionsWrap');
    var menu = document.getElementById('b2bActionsMenu');
    if (!wrap || !menu) return 'no actions menu in the page';
    var items = Array.prototype.slice.call(menu.children)
        .filter(function (el) { return el.tagName === 'BUTTON'; });
    if (!items.length) return 'the menu has no items at all';
    var before = items.map(function (el) { return el.style.display; });
    try {
        items.forEach(function (el) { el.style.display = 'none'; });
        _b2bActionsSync();
        if (wrap.style.display !== 'none') return 'the trigger survives with nothing inside it';
        items[0].style.display = 'flex';
        _b2bActionsSync();
        return wrap.style.display !== 'none' || 'the trigger stays hidden with an item available';
    } finally {
        items.forEach(function (el, i) { el.style.display = before[i]; });
        _b2bActionsSync();
    }
});
t('trial: a pending badge lights a dot on the trigger', function () {
    // Delete Requests and CRM Settings carry counts that are the whole reason
    // those buttons need noticing. Collapsing them must not bury that.
    var menu = document.getElementById('b2bActionsMenu');
    var dot = document.getElementById('b2bActionsDot');
    var btn = menu && menu.querySelector('#b2bDelReqBtn');
    var badge = btn && btn.querySelector('.crm-badge');
    if (!dot || !badge) return 'no dot or no badge to roll up';
    var wasBtn = btn.style.display, wasBadge = badge.style.display, wasText = badge.textContent;
    try {
        btn.style.display = 'flex';
        badge.style.display = 'inline-flex';
        badge.textContent = '3';
        _b2bActionsSync();
        if (dot.style.display === 'none') return 'a pending count does not reach the trigger';
        badge.textContent = '0';
        _b2bActionsSync();
        return dot.style.display === 'none' || 'the dot stays lit with nothing pending';
    } finally {
        btn.style.display = wasBtn;
        badge.style.display = wasBadge;
        badge.textContent = wasText;
        _b2bActionsSync();
    }
});
t('trial: the menu closes on an outside click and on Escape', function () {
    var src = _srcOf(b2bActionsToggle) + _srcOf(_b2bActionsClose);
    if (src.indexOf('aria-expanded') === -1) return 'the trigger never reports its state';
    var wrap = document.getElementById('b2bActionsWrap');
    if (!wrap) return 'no actions menu in the page';
    wrap.classList.add('open');
    document.body.click();
    if (wrap.classList.contains('open')) return 'an outside click does not close it';
    wrap.classList.add('open');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return !wrap.classList.contains('open') || 'Escape does not close it';
});
