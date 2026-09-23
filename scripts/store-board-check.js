// ===========================================================================
// THE STORE ACCOUNT
//
//   powershell -File scripts/browser-check.ps1 store-board-check.js \
//              -Html index.html      -WindowSize 1280,900
//   powershell -File scripts/browser-check.ps1 store-board-check.js \
//              -Html operations.html -WindowSize 1280,900
//
// BOTH PAGES, EVERY TIME. That is the whole point of the shape this landed in:
// the store account is no longer a page, it is a role that can stand on any page
// in the site, and what keeps a sales floor from reading payroll off the wall is
// STORE_BOARD_FEATURES rather than a redirect. A suite that only ever asks one
// page would not be testing that claim.
//
// Ethan, 2026-09-20: "What's currently on the store accounts should just be a
// version of Quick Portal and have the tab there and then we just add operations
// tab with just picture guide. I think we over engineered this from the start."
// He was right. The first cut gave the role a page of its own (tv.html), a
// redirect off every other URL, a hole punched in that redirect for the picture
// station, and a bespoke nav link back. All four are gone; the allow-list they
// were built around is what made them unnecessary.
//
// WHY THIS FILE IS MOSTLY ABOUT WHAT IS *NOT* THERE. Every default on this site
// is opt-out: no role classes means everyone (_passesRoleClasses), def: 'all'
// means everyone (_featureEffectiveVisible). Neither has ever had to mean
// anything for a role that could not load a page. Now that one can, those two
// defaults would hand a sales-floor screen the Margin Guide, Customer Call Backs
// and SPEEKS Connect -- not by anyone's decision, but by the absence of one.
//
// -WindowSize IS REQUIRED, which is not obvious: the runner's default is Chrome's
// 800x600, about 758px of usable viewport, and the compact band starts at 900. A
// default run measures a PHONE -- where the Picture Guide tab is cut by
// data-mobile="hide" and the Operations nav link goes with it -- and reports the
// board as having been given nothing, for a reason that has nothing to do with
// the board. The width guard says so rather than letting the run lie.
// ===========================================================================

if (typeof _b2bSend === 'function') { _b2bSend = function () { return Promise.resolve({}); }; }

// .main-content AS THE PAGE SHIPPED IT, captured before any test has swept it.
// The SPA hop test needs this and cannot fake it: the router replaces the DOM
// with markup fetched from the server, which carries no active classes and no
// inline displays, and re-serializing the LIVE DOM instead (main.innerHTML =
// main.innerHTML) copies both across. Written that way the test passed against
// the bug it was written for -- the restored tab kept the `active` the sweep had
// just put on it, so the card looked reopened when nothing had reopened it.
var SB_PRISTINE = (function () {
    var m = document.querySelector('.main-content');
    return m ? m.innerHTML : null;
})();

// Named rather than derived, so adding a tab to Operations does not quietly add
// it to the store account and then quietly pass this file.
var SB_FORBIDDEN_TABS = ['marginguide', 'callbacks', 'b2b', 'ebay'];

function _sbNeedsDesktop() {
    var w = window.innerWidth;
    if (w > 900) return null;
    return 'this run is ' + w + 'px, inside the compact band -- the Picture Guide ' +
           'tab and the Operations nav link are cut there for every role, so ' +
           'nothing below would be measuring the board. Use -WindowSize 1280,900.';
}

// Which page the runner inlined. Several assertions only have a subject on one
// of them, and a test that silently passes on the wrong page is worse than one
// that is not run.
function _sbPage() {
    if (document.getElementById('ops-tab-pictureguide')) return 'operations';
    if (document.getElementById('ccWidget')) return 'index';
    return 'other';
}

function _sbAsRole(role, fn) {
    var keys = ['speeksUserRole', 'speeksUserName', 'speeksUserStore'];
    var prev = keys.map(function (k) { return sessionStorage.getItem(k); });
    sessionStorage.setItem('speeksUserRole', role);
    sessionStorage.setItem('speeksUserName', role === 'Store' ? 'Westport Team' : 'Check Harness');
    sessionStorage.setItem('speeksUserStore', 'WSP');
    document.body.classList.add('is-authenticated');
    try { return fn(); }
    finally {
        keys.forEach(function (k, i) {
            if (prev[i] == null) sessionStorage.removeItem(k);
            else sessionStorage.setItem(k, prev[i]);
        });
    }
}

// The role sweep is the thing under test almost everywhere below, so it runs for
// real rather than being simulated.
function _sbSweep(role, fn) {
    var g = _sbNeedsDesktop(); if (g) return g;
    return _sbAsRole(role, function () {
        try { applyRoleBasedUI(); } catch (e) { return 'applyRoleBasedUI threw: ' + e.message; }
        return fn();
    });
}

function _sbShown(el) { return !!el && getComputedStyle(el).display !== 'none'; }

// "Is this actually on screen inside that card?" — which is NOT what _sbShown
// answers. getComputedStyle reports an element's OWN display even while an
// ancestor is display:none, so a button inside a hidden bar still reads "block".
// Geometry would answer it, except that .main-content sits behind the auth gate
// in a harness and every rect there is 0x0 — a test written that way passes on
// an unlaid-out page and proves nothing. So: walk the ancestors, and stop at the
// card, which keeps the question about this card rather than about the gate.
function _sbHiddenWithin(el, root) {
    if (!el || !root) return false;
    for (var n = el; n && n !== root.parentElement; n = n.parentElement) {
        if (getComputedStyle(n).display === 'none') return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// There is no board page any more
// ---------------------------------------------------------------------------

t('nothing redirects the store account any more', function () {
    // The redirect is not "removed" until the things that drove it are gone.
    // A leftover _tvGate that nothing calls is worse than one that is called:
    // it reads as live, and the next person restores the call.
    var gone = ['_tvGate', '_tvOnBoardPage', '_tvOnSidePage', 'TV_PAGE'].filter(function (n) {
        try { return typeof eval(n) !== 'undefined'; } catch (e) { return false; }
    });
    return !gone.length ||
        'the redirect apparatus is still here: ' + gone.join(', ') +
        ' -- a store account is meant to use the ordinary pages now';
});

t('...and the role test it left behind still works', function () {
    if (typeof _tvIsBoardRole !== 'function') return '_tvIsBoardRole is gone';
    return _sbAsRole('Store', function () {
        if (!_tvIsBoardRole()) return 'a Store session is not recognised as a board';
        return _sbAsRole('Manager', function () {
            return _tvIsBoardRole() === false || 'a manager is being treated as a board';
        });
    });
});

// ---------------------------------------------------------------------------
// The allow-list, at each of the writers that must agree
// ---------------------------------------------------------------------------

t('the allow-list is two screens and nothing else', function () {
    if (typeof STORE_BOARD_FEATURES === 'undefined') return 'STORE_BOARD_FEATURES is gone';
    var got = Array.from(STORE_BOARD_FEATURES).sort().join(',');
    var want = ['cc-live', 'widget-command-center', 'widget-ops-pictureguide',
                'widget-scorecard-alerts'].sort().join(',');
    // Not a style point: every extra key here is a surface on a screen the sales
    // floor can see, so it changes by a decision and not by a drift.
    return got === want ||
        'the allow-list is now [' + got + '] -- if that was deliberate, this ' +
        'line is where it gets recorded';
});

t('the off-page resolution inverts for the board', function () {
    // _featureEffectiveVisible is what the nav links, _SECTION_TABS and Ctrl+K
    // ask. It is also the one that reads def: 'all', so it is where the opt-out
    // default would leak hardest.
    var leaked = [];
    FEATURE_CATALOG.forEach(function (f) {
        var vis = _featureEffectiveVisible(f.key, 'role-store', 'Westport Team');
        var want = STORE_BOARD_FEATURES.has(f.key);
        if (vis !== want) {
            leaked.push(f.key + ' (def: ' + JSON.stringify(f.def) + ') resolves ' +
                        vis + ' for a board, expected ' + want);
        }
    });
    if (leaked.length > 6) return leaked.length + ' features leak to the board, e.g. ' +
                                  leaked.slice(0, 6).join('; ');
    return !leaked.length || leaked.join('; ');
});

t('...and a real role is untouched by it', function () {
    // The inversion is one role wide. If it ever reaches another it does so
    // silently -- everything simply disappears.
    var bad = [];
    [['role-manager', 'widget-ops-marginguide'],
     ['role-employee', 'widget-ops-pictureguide'],
     ['role-district-manager', 'widget-ops-callbacks'],
     ['role-assistant-manager', 'widget-ops-marginguide']].forEach(function (p) {
        if (!_featureEffectiveVisible(p[1], p[0], 'Check Harness')) {
            bad.push(p[0] + ' lost ' + p[1]);
        }
    });
    return !bad.length || bad.join('; ');
});

// ---------------------------------------------------------------------------
// QuickPortal: the board card, and nothing else on a busy page
// ---------------------------------------------------------------------------

t('[index] the board card is the Live Dashboard, on the ordinary page', function () {
    if (_sbPage() !== 'index') return true;   // asserted on the page that has one
    return _sbSweep('Store', function () {
        var bad = [];
        [['ccWidget', 'the Command Center card'],
         ['cc-strip-live', 'the live tiles'],
         ['cc-panel-live', 'the live detail panel'],
         ['cc-tab-live', 'the Live Dashboard tab']].forEach(function (p) {
            var el = document.getElementById(p[0]);
            if (!el) bad.push(p[1] + ' (#' + p[0] + ') is not on this page');
            else if (!_sbShown(el)) bad.push(p[1] + ' is hidden from the store account');
        });
        return !bad.length || bad.join('; ');
    });
});

t('[index] ...and the card carries only that one tab', function () {
    if (_sbPage() !== 'index') return true;
    return _sbSweep('Store', function () {
        var on = ['ebay', 'scorecard', 'kpis'].filter(function (k) {
            return _sbShown(document.getElementById('cc-tab-' + k));
        });
        return !on.length || 'the board card also shows: ' + on.join(', ');
    });
});

t('[index] ...and it opens itself, with no lone tab above it', function () {
    // A wall has nobody to click it. The Command Center lands on its summary
    // line for a person — "anything more specific is one click away" — which on
    // a screen nobody touches means the board never appears at all. The old
    // shop-floor page opened straight onto the live card and this has to keep
    // doing that, or the TV shows seven cells and stops.
    if (_sbPage() !== 'index') return true;
    return _sbSweep('Store', function () {
        var tab = document.getElementById('cc-tab-live');
        var panel = document.getElementById('cc-panel-live');
        if (!tab || !panel) return 'the Live tab or panel is gone';
        var bad = [];
        if (!tab.classList.contains('active')) {
            bad.push('the board card is still collapsed to its summary — a TV ' +
                     'would sit on seven cells all day');
        }
        if (!panel.classList.contains('cc-active')) bad.push('the live panel is not the open one');
        // ...and the one tab does not draw itself as a control with nothing to
        // control. Same rule the Operations strip got.
        var seg = document.querySelector('#ccWidget .cc-seg');
        if (seg && getComputedStyle(seg).display !== 'none') {
            bad.push('a one-segment tab row is drawn above a panel of the same name');
        }
        // THE SUMMARY BUTTON IS A ONE-WAY DOOR HERE, which is what makes this a
        // correctness test and not a tidiness one. With the lone segment hidden,
        // "▴ Summary" collapses the board to a summary that .cc-expanded hides
        // anyway and leaves no control to reopen it: a card with nothing in it
        // until somebody reloads the TV.
        var card = document.getElementById('ccWidget');
        var collapse = document.getElementById('cc-collapse');
        if (collapse && !_sbHiddenWithin(collapse, card)) {
            bad.push('the Summary control is reachable, and on a board it cannot be undone');
        }
        var bar = card && card.querySelector('.cc-tabbar');
        if (bar && !_sbHiddenWithin(bar, card)) {
            bad.push('the tab bar is still drawn, holding nothing this role can use');
        }
        return !bad.length || bad.join('; ');
    });
});

t('[index] ...and it survives a trip to Operations and back', function () {
    // THE SPA ROUTER REPLACES .main-content's innerHTML and calls
    // applyRoleBasedUI. The card that comes back is a NEW one: collapsed, no tab
    // active. What used to decide whether to open it was a module-level flag,
    // which the swap cannot reach — so it still said "already opened", the card
    // stayed shut, and a store account has no tab bar and no Summary control to
    // get it back. Ethan, 2026-09-20: "When switching from quick portal to
    // operations and back, the main part of live dashboard goes away."
    //
    // Simulated by doing what the router does -- drop SERVER markup into
    // .main-content, then re-apply -- rather than by calling the router, which
    // would need a fetch the harness blocks. SB_PRISTINE, not a re-serialisation
    // of the live DOM; see the note on it for why that distinction is the test.
    if (_sbPage() !== 'index') return true;
    if (!SB_PRISTINE) return 'no pristine .main-content snapshot was taken';
    return _sbSweep('Store', function () {
        var main = document.querySelector('.main-content');
        if (!main) return 'no .main-content to swap';
        var before = document.getElementById('cc-tab-live');
        if (!before || !before.classList.contains('active')) {
            return 'the card was not open before the hop, so this proves nothing';
        }
        main.innerHTML = SB_PRISTINE;      // the swap, as the router does it
        var fresh = document.getElementById('cc-tab-live');
        if (!fresh) return 'the snapshot has no Live tab in it';
        if (fresh.classList.contains('active')) {
            return 'the snapshot is not pristine -- it already carries an open ' +
                   'tab, so this test cannot tell a reopen from a leftover';
        }
        try { applyRoleBasedUI(); } catch (e) { return 'the re-apply threw: ' + e.message; }
        var tab = document.getElementById('cc-tab-live');
        var card = document.getElementById('ccWidget');
        if (!tab) return 'the Live tab did not come back at all';
        if (!tab.classList.contains('active')) {
            return 'the board came back collapsed, with no tab bar and no Summary ' +
                   'control to reopen it -- a TV would sit on a summary line until ' +
                   'somebody reloaded it';
        }
        return (card && card.classList.contains('cc-expanded')) ||
            'the tab reads active but the card is not expanded';
    });
});

t('[index] ...and the card says which store it is', function () {
    // fetchScorecardData stamps the title and eyebrow from the store it fetched
    // for, and a board never calls it -- it has no Scorecard tab. So the card
    // wore the markup's placeholders: an em dash, and the literal word "Store",
    // on a screen whose whole job is to say which store it belongs to.
    if (_sbPage() !== 'index') return true;
    return _sbSweep('Store', function () {
        var name = document.getElementById('cc-store-name');
        var eyebrow = document.getElementById('cc-store-eyebrow');
        if (!name || !eyebrow) return 'the card header lost its store slots';
        var bad = [];
        if (name.textContent.trim() !== 'WSP') {
            bad.push('the title reads "' + name.textContent.trim() + ' Command Center"');
        }
        if (eyebrow.textContent.trim() !== 'WSP') {
            bad.push('the eyebrow reads "' + eyebrow.textContent.trim() + '"');
        }
        return !bad.length || bad.join('; ');
    });
});

t('...and a district card is not pinned to one store', function () {
    // The baseline is skipped for 'ALL' on purpose: a card that names no single
    // store is a district card, and its own fetch names it.
    if (_sbPage() !== 'index') return true;
    var keys = ['speeksUserRole', 'speeksUserStore', 'speeksUserName'];
    var prev = keys.map(function (k) { return sessionStorage.getItem(k); });
    try {
        sessionStorage.setItem('speeksUserRole', 'District Manager');
        sessionStorage.setItem('speeksUserStore', 'ALL');
        sessionStorage.setItem('speeksUserName', 'Check Harness');
        var name = document.getElementById('cc-store-name');
        if (name) name.textContent = 'PLACEHOLDER';
        try { applyRoleBasedUI(); } catch (e) {}
        return (name && name.textContent === 'PLACEHOLDER') ||
            'the store baseline overwrote a district card with "' +
            (name && name.textContent) + '"';
    } finally {
        keys.forEach(function (k, i) {
            if (prev[i] == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, prev[i]);
        });
    }
});

t('[index] ...and a manager keeps the choice the board does not need', function () {
    // The lone-tab rule is general, so it has to stop applying the moment there
    // is more than one — and a lone tab that is still SHUT must stay, because it
    // is the only way into the panel behind it.
    if (_sbPage() !== 'index') return true;
    return _sbSweep('Manager', function () {
        try { _reconcileCommandWidgets(); } catch (e) { return '_reconcileCommandWidgets threw: ' + e.message; }
        var seg = document.querySelector('#ccWidget .cc-seg');
        if (!seg) return 'no Command Center segment on this page';
        if (getComputedStyle(seg).display === 'none') {
            return 'a manager with several Command Center tabs has no tab row to switch with';
        }
        // ...and the bar that carries the Summary control. Collapsing is only a
        // trap when there is no tab row to come back through; a manager has one,
        // so the bar and the button stay exactly as they were.
        var card = document.getElementById('ccWidget');
        var bar = card && card.querySelector('.cc-tabbar');
        return !_sbHiddenWithin(bar, card) ||
            'the board rule took the Command Center tab bar away from a manager too';
    });
});

t('[index] ...and every other dashboard card is gone', function () {
    // The QuickPortal is the busiest page in the site. This is the assertion
    // that the allow-list -- not a redirect -- is what keeps it off a wall.
    if (_sbPage() !== 'index') return true;
    return _sbSweep('Store', function () {
        var on = [];
        Array.prototype.forEach.call(
            document.querySelectorAll('[data-feature]'), function (el) {
                var k = el.getAttribute('data-feature');
                if (!STORE_BOARD_FEATURES.has(k) && _sbShown(el)) on.push(k);
            });
        var uniq = Object.keys(on.reduce(function (a, k) { a[k] = 1; return a; }, {}));
        return !uniq.length ||
            uniq.length + ' feature surface(s) on a sales-floor screen: ' +
            uniq.slice(0, 10).join(', ');
    });
});

t('[index] ...and nothing unkeyed is left standing either', function () {
    // THE HALF THE ALLOW-LIST CANNOT SEE. It only reaches surfaces that carry a
    // data-feature, and the QuickPortal has blocks that carry none -- they never
    // needed one, because every role that could reach the page was meant to see
    // them. "The Company / Performance" is the one that mattered: five stores'
    // conversion figures side by side, a league table, on a screen a customer is
    // standing in front of. It was found by walking the page rather than by
    // reading it, which is why this test walks the page too.
    //
    // Modals, overlays and side panels are skipped: they are in the DOM at all
    // times and opened by JS, so "visible" here means nothing about them.
    if (_sbPage() !== 'index') return true;
    return _sbSweep('Store', function () {
        var root = document.querySelector('.main-content');
        if (!root) return 'no .main-content -- this page did not load its markup';
        var on = [];
        Array.prototype.forEach.call(root.children, function (el) {
            if (getComputedStyle(el).display === 'none') return;
            if (el.matches('.modal-menu, .overlay, [class*="side-panel"], [id$="Overlay"], [id$="Modal"]')) return;
            // The one block that SHOULD be here is the row holding the board card.
            if (el.querySelector && el.querySelector('#ccWidget')) return;
            var n = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
                    (typeof el.className === 'string' && el.className
                        ? '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '');
            on.push(n);
        });
        return !on.length ||
            'on a sales-floor screen with no switch behind it: ' + on.join(', ') +
            ' -- either gate it or add it to the board block in styles.css';
    });
});

// ---------------------------------------------------------------------------
// Operations: the picture station
// ---------------------------------------------------------------------------

t('[ops] the store account gets the Picture Guide tab', function () {
    if (_sbPage() !== 'operations') return true;
    return _sbSweep('Store', function () {
        var tab = document.getElementById('ops-tab-pictureguide');
        if (!tab) return 'no Picture Guide tab on this page';
        return _sbShown(tab) ||
            'the one tab the iPad is here for is hidden (computed display: ' +
            getComputedStyle(tab).display + ')';
    });
});

t('[ops] ...and not one of the other four', function () {
    // THE TAB STRIP IS WHY THE PLAIN-ELEMENT PASS HAD TO CHANGE TOO. These are
    // bare [data-feature] buttons with no role classes, so
    // _applyFeatureOverridesToPlainEls' "no classes means everyone" would have
    // put all five on the bench iPad while the module sweep hid nothing at all.
    if (_sbPage() !== 'operations') return true;
    return _sbSweep('Store', function () {
        var on = SB_FORBIDDEN_TABS.filter(function (k) {
            return _sbShown(document.getElementById('ops-tab-' + k));
        });
        return !on.length || 'a sales-floor screen can open: ' + on.join(', ');
    });
});

t('[ops] ...and a one-tab strip does not pretend to be a tab strip', function () {
    // Ethan saw this on the iPad: a green underlined "Picture Guide" above a
    // panel whose heading also said Picture Guide, with nothing to switch to.
    // Not a board rule -- any role narrowed to one tab had the same thing.
    if (_sbPage() !== 'operations') return true;
    return _sbSweep('Store', function () {
        try { initOperations(); } catch (e) { return 'initOperations threw: ' + e.message; }
        var strip = document.querySelector('.ws-subtabs');
        if (!strip) return 'no .ws-subtabs on this page';
        if (_sbShown(strip)) return 'the tab strip is still drawn above a single tab';
        // ...and it comes back for somebody who has somewhere to go.
        return _sbAsRole('District Manager', function () {
            try { applyRoleBasedUI(); initOperations(); } catch (e) {}
            return _sbShown(strip) ||
                'the strip stayed hidden for a DM, who has five tabs to switch between';
        });
    });
});

t('[ops] the page opens on the tab it came for', function () {
    // initOperations picks the first VISIBLE tab when its default is cut. For a
    // board that default (SPEEKS Connect) is always cut, so this is the whole
    // difference between the guide and an empty pane.
    if (_sbPage() !== 'operations') return true;
    return _sbSweep('Store', function () {
        try { initOperations(); } catch (e) { return 'initOperations threw: ' + e.message; }
        var tab = document.getElementById('ops-tab-pictureguide');
        return (tab && tab.classList.contains('active')) ||
            'Operations opened on some other tab, leaving the iPad on an empty pane';
    });
});

t('[ops] the store account cannot edit the guide', function () {
    // A shared shop-floor PIN is the case that matters most for this.
    if (_sbPage() !== 'operations') return true;
    return _sbSweep('Store', function () {
        if (typeof pgCanEdit !== 'function') return 'pgCanEdit is gone';
        return pgCanEdit() === false || 'a shared sales-floor PIN can rewrite the Picture Guide';
    });
});

t('[ops] the tab survives the cut the iPad arrives under', function () {
    // The bench screen IS a tablet, so the one tab this exists for meets the
    // mobile curation on the way in. data-mobile="hide" alone would cut it there
    // and the board would land on an empty pane, with the allow-list, the tab
    // strip and the nav all reporting correct.
    if (_sbPage() !== 'operations') return true;
    var tab = document.getElementById('ops-tab-pictureguide');
    if (!tab) return 'no Picture Guide tab on this page';
    if (tab.getAttribute('data-mobile') !== 'hide') return true;   // no cut to survive
    return tab.getAttribute('data-tablet') === 'show' ||
        'the Picture Guide tab is cut from compact with no tablet exception, so ' +
        'the picture-station iPad is the one device that cannot see it';
});

// ---------------------------------------------------------------------------
// The chrome, on whichever page this run is standing
// ---------------------------------------------------------------------------

t('two nav tabs, and they are the ordinary two', function () {
    return _sbSweep('Store', function () {
        var links = document.querySelectorAll('.nav-bar a.nav-link');
        if (links.length < 4) return 'only ' + links.length + ' nav links -- markup did not load';
        var bad = [];
        Array.prototype.forEach.call(links, function (a) {
            var href = a.getAttribute('href') || '';
            var ok = /(^|\/)(index|operations)\.html$/i.test(href);
            if (_sbShown(a) !== ok) {
                bad.push(href + ' is ' + (_sbShown(a) ? 'visible' : 'hidden') + ' for a board');
            }
        });
        // Nothing renamed and nothing invented: a smaller copy of the site, not
        // a different one. The first cut turned QuickPortal into a "Board" link
        // pointing at a page of its own, which is exactly what was over-built.
        var qp = document.querySelector('.nav-bar a.nav-link[href="index.html"] span');
        if (qp && !/quick ?portal/i.test(qp.textContent)) {
            bad.push('the QuickPortal link has been relabelled "' + qp.textContent.trim() + '"');
        }
        if (document.querySelector('.nav-bar a.nav-link.board-link')) {
            bad.push('the bespoke Board link is back');
        }
        return !bad.length || bad.join('; ');
    });
});

t('...and no tool, panel or tools button at all', function () {
    return _sbSweep('Store', function () {
        var bad = [];
        var items = document.querySelectorAll('.tools-item[data-feature]');
        if (!items.length) return 'no tools-items found -- this page did not load its markup';
        Array.prototype.forEach.call(items, function (el) {
            if (_sbShown(el)) bad.push(el.getAttribute('data-feature'));
        });
        // Send Store Comment is the one tool with no cut of any kind on it now,
        // so it is the one most likely to land here by accident.
        if (bad.length) return 'the board can reach ' + bad.length + ' tool(s): ' + bad.join(', ');
        ['toolsNavBtn', 'toolsSidePanel'].forEach(function (id) {
            var el = document.getElementById(id);
            if (_sbShown(el)) bad.push('#' + id + ' is still on screen');
        });
        return !bad.length || bad.join('; ');
    });
});

t('...and the action buttons are gone with the rest', function () {
    // These carry no data-feature -- there was no role that shouldn't see them
    // until now -- so they are the half the allow-list cannot reach.
    return _sbSweep('Store', function () {
        var on = [];
        ['.nav-right .action-btn', '.msm-store-switch'].forEach(function (sel) {
            Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
                if (_sbShown(el)) on.push(el.id || String(el.className).split(' ')[0]);
            });
        });
        return !on.length || 'still on a sales-floor screen: ' + on.join(', ');
    });
});

t('a manager sees the page it has always seen', function () {
    // The chrome is one body class rather than a pile of inline styles precisely
    // so it can be taken back. This is that claim, tested in the order that
    // would catch it: the board sweeps above have already run in this document.
    return _sbSweep('Manager', function () {
        var bad = [];
        if (document.body.classList.contains('is-store-board')) {
            bad.push('the page is still dressed as a board');
        }
        ['docs.html', 'stats.html', 'index.html'].forEach(function (h) {
            var a = document.querySelector('.nav-bar a.nav-link[href="' + h + '"]');
            if (a && !_sbShown(a)) bad.push('the ' + h + ' link never came back');
        });
        var idea = document.querySelector('.nav-right .idea-btn');
        if (idea && !_sbShown(idea)) bad.push('the action buttons never came back');
        if (_sbPage() === 'operations') {
            ['marginguide', 'callbacks', 'pictureguide'].forEach(function (k) {
                if (!_sbShown(document.getElementById('ops-tab-' + k))) bad.push('lost the ' + k + ' tab');
            });
        }
        if (_sbPage() === 'index') {
            var cc = document.getElementById('cc-tab-scorecard');
            if (cc && !_sbShown(cc)) bad.push('the Command Center lost its Scorecard tab');
        }
        return !bad.length || bad.join('; ');
    });
});
