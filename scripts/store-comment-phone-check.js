// ===========================================================================
// SEND STORE COMMENT ON A PHONE
//
//   powershell -File scripts/browser-check.ps1 store-comment-phone-check.js \
//              -Html operations.html -WindowSize 390,844
//
// 390x844 is an iPhone 14/15 in portrait — the narrowest screen the site
// supports, and the width every other tool on the Tools panel was cut from.
//
// ITS OWN FILE BECAUSE IT HAS ITS OWN WIDTH. Ethan, 2026-09-20: "add daily store
// comments and send store comment tools for applicable roles. you can also add
// the send store comment to mobile." Everything restored in this round has been
// a tablet exception, asserted by operations-tablet-check at six tablet windows;
// this one alone goes all the way down, and a 744px run says nothing about 390.
// Folding it into that file would have meant one suite with two width contracts
// and a screenful of guard messages on every run.
//
// It is also the only tool here that is NOT an exception. data-tablet="show"
// means "cut from the phone, kept on a tablet", so a surface that belongs
// everywhere has the CUT removed instead of an exception added — the attribute
// would otherwise read as if the phone were still excluded.
//
// No replay: at 390px the compact band is genuinely live, and there is no tablet
// tier involved. This is the one suite in the set that measures a real cascade
// from top to bottom.
// ===========================================================================

if (typeof _b2bSend === 'function') { _b2bSend = function () { return Promise.resolve({}); }; }

function _scNorm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function _scNeedsPhone() {
    var w = window.innerWidth;
    if (w <= 640) return null;
    return 'this run is ' + w + 'px, which is not a phone — the bottom-sheet ' +
           'rules this file measures live below 640px. Use -WindowSize 390,844.';
}

function _scAsRole(role, fn) {
    var keys = ['speeksUserRole', 'speeksUserName', 'speeksUserStore'];
    var prev = keys.map(function (k) { return sessionStorage.getItem(k); });
    sessionStorage.setItem('speeksUserRole', role);
    sessionStorage.setItem('speeksUserName', 'Check Harness');
    sessionStorage.setItem('speeksUserStore', 'ALL');
    document.body.classList.add('is-authenticated');
    try { return fn(); }
    finally {
        keys.forEach(function (k, i) {
            if (prev[i] == null) sessionStorage.removeItem(k);
            else sessionStorage.setItem(k, prev[i]);
        });
    }
}

t('the tool carries no cut at all', function () {
    var el = document.querySelector('.tools-item[data-feature="tool-store-comment"]');
    if (!el) return 'no Send Store Comment item on this page';
    var bad = [];
    if (el.hasAttribute('data-mobile')) {
        bad.push('it still carries data-mobile="' + el.getAttribute('data-mobile') + '"');
    }
    if (el.hasAttribute('data-tablet')) {
        bad.push('it carries data-tablet, which excepts a cut that is no longer ' +
                 'there — it reads as if the phone were excluded');
    }
    if (!el.classList.contains('dynamic-module-flex')) {
        bad.push('it is no longer swept by applyRoleBasedUI, so its role gate is gone');
    }
    return !bad.length || bad.join('; ');
});

t('a phone can see it, for the roles that hold it', function () {
    var g = _scNeedsPhone(); if (g) return g;
    var el = document.querySelector('.tools-item[data-feature="tool-store-comment"]');
    if (!el) return 'no Send Store Comment item';
    var bad = [];
    // Read the roles off the element rather than restating them, so the two
    // cannot disagree; then check one that is NOT on the list.
    var roles = Array.prototype.filter.call(el.classList, function (c) {
        return c.indexOf('role-') === 0;
    });
    if (roles.length < 3) return 'the item has almost no role classes: ' + roles;
    roles.concat(['role-employee']).forEach(function (rc) {
        var expected = roles.indexOf(rc) >= 0;
        _scAsRole(rc.replace('role-', '').replace(/-/g, ' '), function () {
            try { applyRoleBasedUI(); } catch (e) {}
            var got = el.style.display !== 'none';
            if (got !== expected) {
                bad.push(rc + ': ' + (got ? 'sees' : 'cannot see') +
                         ' the tool on a phone, expected the opposite');
            }
        });
    });
    return !bad.length || bad.join('; ');
});

t('...and the Tools panel opens to reach it', function () {
    // _syncToolsPanelChrome hides the panel AND its nav button when nothing
    // inside is visible. Every other tools-item is still cut at this width, so
    // this one is now the only thing keeping the panel on a phone at all — and
    // if it stops being enough, the tool is unreachable however visible it is.
    var g = _scNeedsPhone(); if (g) return g;
    return _scAsRole('manager', function () {
        try { applyRoleBasedUI(); } catch (e) {}
        var panel = document.getElementById('toolsSidePanel');
        var btn = document.getElementById('toolsNavBtn');
        if (!panel) return 'no #toolsSidePanel on this page';
        if (panel.style.display === 'none') {
            return 'the Tools panel is hidden on a phone, so nothing in it can be opened';
        }
        if (btn && btn.style.display === 'none') {
            return 'the Tools nav button is hidden, so the panel cannot be opened';
        }
        // ...and the item is inside a group that survived the same sweep.
        var el = document.querySelector('.tools-item[data-feature="tool-store-comment"]');
        var grp = el && el.closest('.tools-group');
        return !grp || getComputedStyle(grp).display !== 'none' ||
            'the tool is visible but its .tools-group is hidden, so it is off screen';
    });
});

t('the modal fits a 390px phone', function () {
    // .modal-menu declares 1050px and the compact layer turns it into a bottom
    // sheet. Measured rather than assumed: this modal has never been opened at
    // this width, because the tool that opens it was cut from it.
    var g = _scNeedsPhone(); if (g) return g;
    return _scAsRole('district manager', function () {
        try { toggleSendCommentModal(); } catch (e) { return 'the opener threw: ' + e.message; }
        var modal = document.getElementById('sendCommentModal');
        try {
            if (!modal) return 'no #sendCommentModal on this page';
            // offsetWidth, not a rect: tool modals animate in from a transform,
            // and a scaled rect reads short (the scorecard's 0.95 cost an hour).
            if (modal.offsetWidth < 50) {
                return 'the modal measured ' + modal.offsetWidth + 'px — it did not ' +
                       'open, so nothing here was measured';
            }
            if (modal.offsetWidth > window.innerWidth + 1) {
                return 'the modal is ' + modal.offsetWidth + 'px on a ' +
                       window.innerWidth + 'px screen';
            }
            var over = [];
            ['.tool-head', '.manage-content', '.manage-footer']
                .forEach(function (sel) {
                    var el = modal.querySelector(sel);
                    if (el && el.scrollWidth > el.clientWidth + 1) {
                        over.push(sel + ' by ' + (el.scrollWidth - el.clientWidth) + 'px');
                    }
                });
            return !over.length || 'inside the modal: ' + over.join(', ');
        } finally { try { closeAllModals(); } catch (e) {} }
    });
});

t('...and both of its fields are usable at that width', function () {
    // A store picker and a message box. The picker is a <select> that _ddEnhance
    // replaces with a face, and the face has just been changed to stretch to its
    // host — so this is also the phone half of that change.
    var g = _scNeedsPhone(); if (g) return g;
    return _scAsRole('district manager', function () {
        try { toggleSendCommentModal(); } catch (e) {}
        var modal = document.getElementById('sendCommentModal');
        try {
            var sel = document.getElementById('commentStoreSelect');
            var area = document.getElementById('commentMessageInput');
            if (!sel || !area) return 'the store picker or the message box is gone';
            if (typeof _ddEnhance === 'function') { try { _ddEnhance(sel); } catch (e) {} }
            var host = sel.closest('.dd-host');
            var face = host && host.querySelector('.dd-btn');
            if (!face) return 'the store select was never wrapped by _ddEnhance';
            if (face.offsetHeight < 30) {
                return 'the store picker is ' + face.offsetHeight + 'px tall — under ' +
                       'the house 34px, so something is squashing it on a phone';
            }
            // The face fills its host rather than sitting inside it with the
            // margin .form-input-lg gives every field (see .dd-host-lg).
            if (Math.abs(face.offsetHeight - host.offsetHeight) > 1) {
                return 'the face is ' + face.offsetHeight + 'px inside a ' +
                       host.offsetHeight + 'px host';
            }
            var w = modal.querySelector('.manage-content').clientWidth;
            return area.offsetWidth <= w + 1 ||
                'the message box is ' + area.offsetWidth + 'px in a ' + w +
                'px body — it is pushing the sheet sideways';
        } finally { try { closeAllModals(); } catch (e) {} }
    });
});
