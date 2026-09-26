// ===========================================================================
// THE PICTURE GUIDE ON A TABLET — portrait and landscape
//
//   powershell -File scripts/browser-check.ps1 operations-tablet-check.js \
//              -Html operations.html -WindowSize 744,1133     (mini, portrait)
//   ...and again at 1133,744 (mini, landscape), 1024,1366 and 1366,1024.
//
// ALL FOUR, EVERY TIME. This is the first surface Ethan named an orientation for
// — "I'm more inclined to having the tablets landscape at the picture station to
// see more pictures at once, so I want it to look good in both portrait and
// landscape" (2026-09-20) — and the two orientations take different paths
// through the stylesheet, because .pg-shell drops to a single column at 1100px
// and every iPad is under that standing up and over it lying down. A run at one
// orientation proves nothing about the other.
//
// Customer Call Backs came here too and went straight back off the same day
// ("doesn't look good on tablet, so we can get rid of it for tablet version").
// The tab is guarded below rather than simply forgotten, along with the scroll
// host it needed, because a dead rule is how the next person concludes the tab
// must still be reachable.
//
// THE HARNESS CANNOT BE A TABLET (pointer:coarse; headless Chrome reports fine),
// and at a LANDSCAPE window it cannot even be compact — 1133px is over the
// band's 900px width test — so a landscape run measured against the live cascade
// is a desktop page with a few tablet rules sprinkled on it. Both layers are
// replayed here under html.tbprobe, compact band first and the tablet tier on
// top, which is the order the real cascade applies them in.
// ===========================================================================

if (typeof _b2bSend === 'function') { _b2bSend = function () { return Promise.resolve({}); }; }

var OT_TABLET_Q = '(min-width: 701px) and (min-height: 540px)'
                + ' and (max-width: 1366px) and (pointer: coarse)';
var OT_BAND_Q = '(max-width: 900px), (max-width: 1366px) and (pointer: coarse)';

function _otNorm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function _otMediaRules() {
    var out = [];
    Array.prototype.forEach.call(document.styleSheets, function (ss) {
        var rules; try { rules = ss.cssRules; } catch (e) { return; }
        Array.prototype.forEach.call(rules || [], function (r) {
            if (r.type === CSSRule.MEDIA_RULE) out.push(r);
        });
    });
    return out;
}

function _otReplay(conditions) {
    var css = '';
    conditions.forEach(function (want) {
        _otMediaRules().forEach(function (r) {
            if (_otNorm(r.conditionText) !== _otNorm(want)) return;
            for (var i = 0; i < r.cssRules.length; i++) {
                // A nested @media has no selectorText; skipping it beats emitting
                // "html.tbprobe undefined { }" and losing the rest of the block
                // to the exception that follows.
                if (!r.cssRules[i].selectorText) continue;
                css += 'html.tbprobe ' + r.cssRules[i].selectorText +
                       ' { ' + r.cssRules[i].style.cssText + ' }\n';
            }
        });
    });
    if (!css) return null;
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    document.documentElement.classList.add('tbprobe');
    return st;
}
// A tablet: the curation band, then the exceptions a tablet earns back.
function _otReplayTablet() { return _otReplay([OT_BAND_Q, OT_TABLET_Q]); }
// A phone: the band with NO exceptions on top. Used instead of the live cascade
// so the phone case can be asserted at a landscape window too.
function _otReplayPhone() { return _otReplay([OT_BAND_Q]); }

function _otEndReplay(st) {
    if (st) st.remove();
    document.documentElement.classList.remove('tbprobe');
}

// Every measurement here is a function of the window, so a run at the wrong one
// reports drift that does not exist. The test is the TIER's own box rather than
// "is the band live", because the band is replayed above and a landscape tablet
// is a legitimate window that the live band will never match in this harness.
function _otNeedsTabletBox() {
    var w = window.innerWidth, h = window.innerHeight;
    if (w >= 701 && w <= 1366 && h >= 540) return null;
    return 'this run is ' + w + 'x' + h + ', outside the tablet tier\'s box — no ' +
           'real device this shape would take these rules. Use -WindowSize ' +
           '744,1133 (portrait) or 1133,744 (landscape).';
}

// Which way up, decided by the thing that actually branches: .pg-shell is one
// track in portrait and two (rail + board) in landscape. Read off the computed
// style rather than from window.innerWidth, so this cannot drift from the 1100px
// rule it is describing.
function _otIsLandscape() {
    var shell = document.querySelector('.pg-shell');
    if (!shell) return null;
    return getComputedStyle(shell).gridTemplateColumns.trim().split(/\s+/).length > 1;
}

function _otCols(el) {
    return getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length;
}

function _otAsTablet(fn) {
    var rt = _isTabletLayout, rm = _isMobileLayout;
    _isTabletLayout = function () { return true; };
    _isMobileLayout = function () { return true; };
    try { return fn(); } finally { _isTabletLayout = rt; _isMobileLayout = rm; }
}

// Compact but NOT a tablet, which is the phone case exactly. Needed because the
// nav link is written by JS: replaying the phone's CSS says nothing about
// _applySectionNavVisibility, which asks the predicates directly — and at a
// landscape window the real _isMobileLayout is false, so the link showed and the
// test read it as the cut having failed.
function _otAsPhone(fn) {
    var rt = _isTabletLayout, rm = _isMobileLayout;
    _isTabletLayout = function () { return false; };
    _isMobileLayout = function () { return true; };
    try { return fn(); } finally { _isTabletLayout = rt; _isMobileLayout = rm; }
}

function _otAsDesktop(fn) {
    var rt = _isTabletLayout, rm = _isMobileLayout;
    _isTabletLayout = function () { return false; };
    _isMobileLayout = function () { return false; };
    try { return fn(); } finally { _isTabletLayout = rt; _isMobileLayout = rm; }
}

function _otAsRole(role, fn) {
    var keys = ['speeksUserRole', 'speeksUserName', 'speeksUserStore'];
    var prev = keys.map(function (k) { return sessionStorage.getItem(k); });
    sessionStorage.setItem('speeksUserRole', role);
    sessionStorage.setItem('speeksUserName', 'Check Harness');
    sessionStorage.setItem('speeksUserStore', 'MPL');
    document.body.classList.add('is-authenticated');
    try { return fn(); }
    finally {
        keys.forEach(function (k, i) {
            if (prev[i] == null) sessionStorage.removeItem(k);
            else sessionStorage.setItem(k, prev[i]);
        });
    }
}

// --- the route -------------------------------------------------------------

t('the Picture Guide and the Operations route are both opted in', function () {
    // A surface without a route is unreachable and a route without a surface is
    // an empty page, so the two are asserted together.
    var bad = [];
    var link = document.querySelector('.nav-bar a.nav-link[href="operations.html"]');
    if (!link) return 'no Operations nav link on this page';
    if (link.getAttribute('data-mobile') !== 'hide') bad.push('the nav link lost data-mobile="hide"');
    if (link.getAttribute('data-tablet') !== 'show') bad.push('the nav link has no data-tablet="show"');
    var tab = document.getElementById('ops-tab-pictureguide');
    if (!tab) return 'no #ops-tab-pictureguide in operations.html';
    if (tab.getAttribute('data-mobile') !== 'hide') bad.push('the tab lost data-mobile="hide"');
    if (tab.getAttribute('data-tablet') !== 'show') bad.push('the tab has no data-tablet="show"');
    return !bad.length || bad.join('; ');
});

t('the tablet section map agrees with the markup', function () {
    // _TABLET_SECTION_TABS and the data-tablet attributes are two halves of one
    // fact, edited in different files. A key with no opted-in tab promises a
    // section that is not there; an opted-in tab missing from the set hides the
    // link that reaches it.
    var declared = Array.prototype.slice.call(
        document.querySelectorAll('.ws-subtabs .ws-tab[data-tablet="show"][data-feature]'))
        .map(function (el) { return el.getAttribute('data-feature'); });
    var mapped = _SECTION_TABS['operations.html']
        .filter(function (k) { return _TABLET_SECTION_TABS.has(k); });
    var missing = declared.filter(function (k) { return mapped.indexOf(k) < 0; });
    var extra = mapped.filter(function (k) { return declared.indexOf(k) < 0; });
    if (missing.length) {
        return 'opted in in the markup but not in _TABLET_SECTION_TABS: ' +
               missing.join(', ') + ' — the tab is there and the nav link that ' +
               'reaches it may not be';
    }
    return !extra.length ||
        'in _TABLET_SECTION_TABS with no opted-in tab: ' + extra.join(', ') +
        ' — that key can light up an Operations link with an empty page behind it';
});

t('the third writer honours the opt-in', function () {
    // THE ONE THAT WOULD HAVE SHIPPED BROKEN. _applySectionNavVisibility runs
    // last and writes display with !important, so it beats both the CSS
    // exception and the applyRoleBasedUI sweep, and it had never heard of
    // data-tablet. Asserted by calling the real function, not by reading source.
    var link = document.querySelector('.nav-bar a.nav-link[href="operations.html"]');
    return _otAsRole('manager', function () {
        return _otAsTablet(function () {
            _applySectionNavVisibility('role-manager', 'Check Harness');
            return link.style.display === 'flex' ||
                'the link was set to "' + link.style.display + '" on a tablet — ' +
                '_applySectionNavVisibility is still cutting it';
        });
    });
});

t('the Picture Guide is the only Operations tab on a tablet', function () {
    // The request was one tab. SPEEKS Connect is a four-view upload console,
    // Margin Guide is a lookup nobody asked to move, B2B is the biggest tool on
    // the site, and Customer Call Backs came and went the same day.
    var g = _otNeedsTabletBox(); if (g) return g;
    var st = _otReplayTablet();
    try {
        var shown = [];
        Array.prototype.forEach.call(document.querySelectorAll('.ws-subtabs .ws-tab'),
            function (el) {
                if (getComputedStyle(el).display !== 'none') shown.push(el.id);
            });
        return (shown.length === 1 && shown[0] === 'ops-tab-pictureguide') ||
            'visible on a tablet: ' + (shown.join(', ') || '(none)') +
            ' — expected ops-tab-pictureguide alone';
    } finally { _otEndReplay(st); }
});

t('Customer Call Backs stays off, and takes its scroll host with it', function () {
    // Brought back on 2026-09-20 and taken off the same day: "doesn't look good
    // on tablet". Nine fixed columns on a 617px board is the reason, and a
    // tablet is not enough wider to change it — this is the guard against
    // restoring it by reflex.
    //
    // The second half matters as much. Bringing it back needed a horizontal
    // scroll host that the desktop rule had been silently beating; with the tab
    // gone that is a rule for a surface nobody can reach, which is exactly how
    // the next person concludes the tab must still be there.
    var g = _otNeedsTabletBox(); if (g) return g;
    var bad = [];
    var tab = document.getElementById('ops-tab-callbacks');
    if (!tab) return 'no #ops-tab-callbacks in operations.html at all';
    if (tab.getAttribute('data-tablet') === 'show') bad.push('the tab is opted in again');
    if (_TABLET_SECTION_TABS.has('widget-ops-callbacks')) {
        bad.push('widget-ops-callbacks is back in _TABLET_SECTION_TABS');
    }
    _otMediaRules().forEach(function (r) {
        var cond = _otNorm(r.conditionText);
        if (cond !== _otNorm(OT_BAND_Q) && cond !== _otNorm(OT_TABLET_Q)) return;
        try {
            for (var i = 0; i < r.cssRules.length; i++) {
                var sel = _otNorm(r.cssRules[i].selectorText || '');
                if (sel.indexOf('.ws-panel-calls') >= 0) bad.push('a compact rule still sets ' + sel);
            }
        } catch (e) {}
    });
    return !bad.length || bad.join('; ');
});

t('a phone still gets no Operations at all', function () {
    // The band with no exceptions on top — a phone, replayed rather than stood
    // on, so this holds at a landscape window too.
    var g = _otNeedsTabletBox(); if (g) return g;
    var st = _otReplayPhone();
    try {
        var bad = ['ops-tab-pictureguide', 'ops-tab-callbacks'].filter(function (id) {
            return getComputedStyle(document.getElementById(id)).display !== 'none';
        });
        var link = document.querySelector('.nav-bar a.nav-link[href="operations.html"]');
        // The link is written by _applySectionNavVisibility, not by CSS, so the
        // phone case is asked of the function rather than of the computed style.
        _otAsRole('manager', function () {
            _otAsPhone(function () {
                _applySectionNavVisibility('role-manager', 'Check Harness');
                if (link.style.display !== 'none') bad.push('the nav link');
            });
        });
        return !bad.length ||
            'a phone can see ' + bad.join(' and ') + ' — the 390px build was not ' +
            'asked for and nothing here has been measured at that width';
    } finally { _otEndReplay(st); }
});

t('the page lands on a tab that exists on a tablet', function () {
    // initOperations picks the first VISIBLE tab when the requested one is gone.
    // It used to test style.display, which a stylesheet cut never sets — so all
    // five tabs read as visible, it kept its default of SPEEKS Connect, and drew
    // an empty pane under a tab strip. The fix is why this reads computed style.
    var g = _otNeedsTabletBox(); if (g) return g;
    var st = _otReplayTablet();
    var hash = window.location.hash;
    try {
        return _otAsRole('manager', function () {
            return _otAsTablet(function () {
                try { history.replaceState(null, '', 'operations.html'); } catch (e) {}
                initOperations();
                var active = document.querySelector('.ws-subtabs .ws-tab.active');
                if (!active) return 'no tab ended up active at all';
                if (getComputedStyle(active).display === 'none') {
                    return 'it landed on ' + active.id + ', which is cut on a tablet — ' +
                           'the pane behind it is empty';
                }
                var pane = document.getElementById(
                    'ops-pane-' + active.id.replace('ops-tab-', ''));
                return (pane && pane.classList.contains('active')) ||
                    'the tab is ' + active.id + ' but its pane is not active';
            });
        });
    } finally {
        _otEndReplay(st);
        try { history.replaceState(null, '', 'operations.html' + hash); } catch (e) {}
    }
});

// --- the editor ------------------------------------------------------------

t('a DM gets the view-only Picture Guide on a tablet', function () {
    // pgCanEdit is the single gate: the Edit button is revealed by the .pg-can
    // class it sets, the rail's "New category" is drawn from it, and
    // pgOpenAdmin refuses without it.
    return _otAsRole('district manager', function () {
        var onTablet = _otAsTablet(function () { return pgCanEdit(); });
        if (onTablet !== false) {
            return 'pgCanEdit() is ' + onTablet + ' for a DM on a tablet — the ' +
                   'editor is still reachable';
        }
        // ...and the desktop is untouched, which is the half that makes this a
        // device rule rather than a revocation.
        var onDesktop = _otAsDesktop(function () { return pgCanEdit(); });
        return onDesktop === true ||
            'pgCanEdit() is ' + onDesktop + ' for a DM on a DESKTOP — the tablet ' +
            'rule has taken the editor away from everyone';
    });
});

t('...and no door into the editor is left open', function () {
    // The button is not the only way in, which is why the gate is in pgCanEdit
    // and not on the button. Three doors: the class that reveals the button,
    // the admin entry point, and the empty-state copy that invites you to use it.
    var g = _otNeedsTabletBox(); if (g) return g;
    var st = _otReplayTablet();
    var prevSheets = _pgSheets, prevOpen = _pgAdmin.open;
    try {
        return _otAsRole('district manager', function () {
            return _otAsTablet(function () {
                _pgSheets = [{ id: 1, slug: 'phones', name: 'Phones', shots: [
                    { id: 11, label: 'Front, screen on', cond: null, img: null }
                ] }];
                _pgState.catId = 1;
                _pgAdmin.open = true;   // as if a stale state survived a resize
                switchOperationsTab('pictureguide');
                pgRender();
                var panel = document.querySelector('.pg-panel');
                var bad = [];
                if (panel.classList.contains('pg-can')) bad.push('.pg-can is set');
                if (panel.classList.contains('pg-editing')) {
                    bad.push('.pg-editing is set — the admin is on screen');
                }
                var edit = document.getElementById('pg-manage-btn');
                if (edit && getComputedStyle(edit).display !== 'none') {
                    bad.push('the Edit button is visible');
                }
                pgOpenAdmin();
                if (document.querySelector('.pg-panel').classList.contains('pg-editing')) {
                    bad.push('pgOpenAdmin() opened the admin anyway');
                }
                return !bad.length || 'on a tablet, for a DM: ' + bad.join('; ');
            });
        });
    } finally {
        _pgSheets = prevSheets; _pgAdmin.open = prevOpen; _otEndReplay(st);
    }
});

// --- the board and the rail, measured --------------------------------------

// The rail as it really stands: fifteen groups with the sheet counts the tool
// actually holds. Both of the things this file measures about the rail are a
// function of those numbers — fifteen headings is what made the list long, and
// the seven sheets under Computer Parts are what made an open group deep — so a
// three-sheet fixture would have shown nothing wrong with either.
//
// ⚠️ THE GROUPING FIELD IS group_name (_pgSections reads it, and only it). The
// first version of this seed said `group`, which every sheet failed to match, so
// the rail drew fifteen ungrouped buttons and there was no dropdown to open. It
// still passed the column tests — fifteen buttons in a grid count the same as
// fifteen headings — which is exactly how a fixture that is wrong in a
// structural way goes unnoticed.
function _otSeedPg() {
    var prev = _pgSheets, prevCat = _pgState.catId, prevOpen = _pgAdmin.open;
    var groups = [['Accessories', 1], ['Cameras', 5], ['Computer Parts', 7],
                  ['Computers', 9], ['Gaming', 8], ['Headphones', 2],
                  ['Home Theater', 5], ['Item Types', 3], ['Media Players', 1],
                  ['Miscellaneous', 1], ['Monitors', 1], ['Smart Phones', 3],
                  ['Smart Tablets', 3], ['Smart Watches', 3], ['Wearables', 1]];
    var shots = function (i) {
        return [1, 2, 3, 4, 5, 6].map(function (n) {
            return { id: i * 100 + n, label: 'Shot number ' + n + ' of the unit',
                     cond: n === 6 ? 'Only if it applies' : null, img: null };
        });
    };
    var sheets = [], id = 0, openOn = null;
    groups.forEach(function (pair) {
        for (var k = 0; k < pair[1]; k++) {
            id++;
            // Real sheet names are long and near-identical at the START — the
            // difference lives at the end — which is the case the rail's
            // ellipsis has to survive.
            sheets.push({ id: id, slug: 'g' + id, group_name: pair[0],
                          name: pair[0] + ' — variant ' + (k + 1), shots: shots(id) });
            // Land the selection inside the deepest group, so the group that
            // opens by default is the one worth measuring.
            if (pair[0] === 'Computer Parts' && k === 0) openOn = id;
        }
    });
    _pgSheets = sheets;
    _pgState.catId = openOn;
    _pgAdmin.open = false;
    return function () {
        _pgSheets = prev; _pgState.catId = prevCat; _pgAdmin.open = prevOpen;
    };
}

function _otOnBoard(fn) {
    var st = _otReplayTablet();
    var undo = null;
    try {
        return _otAsRole('manager', function () {
            return _otAsTablet(function () {
                // Switch THEN seed THEN draw: switchOperationsTab calls pgLoad,
                // which fetches, which the runner blocks — so it would otherwise
                // leave a "Loading the photo sheets…" placeholder over the top.
                switchOperationsTab('pictureguide');
                undo = _otSeedPg();
                pgRender();
                var pane = document.getElementById('ops-pane-pictureguide');
                if (pane.getBoundingClientRect().width < 50) {
                    return 'the pane measures ' +
                           Math.round(pane.getBoundingClientRect().width) + 'px wide — ' +
                           'an ancestor is hidden and nothing here is being measured';
                }
                return fn(pane);
            });
        });
    } finally { if (undo) undo(); _otEndReplay(st); }
}

t('nothing on the board overflows sideways', function () {
    var g = _otNeedsTabletBox(); if (g) return g;
    return _otOnBoard(function (pane) {
        var over = [];
        ['.pg-shell', '.pg-rail', '.pg-catlist', '.pg-board', '.pg-head', '.pg-legend']
            .forEach(function (sel) {
                var el = pane.querySelector(sel);
                if (el && el.scrollWidth > el.clientWidth + 1) {
                    over.push(sel + ' by ' + (el.scrollWidth - el.clientWidth) + 'px');
                }
            });
        if (pane.scrollWidth > pane.clientWidth + 1) {
            over.push('the pane itself by ' + (pane.scrollWidth - pane.clientWidth) + 'px');
        }
        return !over.length ||
            'at ' + window.innerWidth + 'x' + window.innerHeight + ': ' + over.join(', ');
    });
});

t('the category rail uses the width it is given', function () {
    // "It feels super long and weird." Fifteen groups in one column, in a rail
    // that is the full width of the page in portrait — so each row was ~600px of
    // white space around an eight-character label, and the list ran 600px tall.
    // The fix is one auto-fill rule serving both shapes: the sidebar is too
    // narrow for a second 185px track and stays single, the portrait banner
    // takes three or four.
    var g = _otNeedsTabletBox(); if (g) return g;
    return _otOnBoard(function (pane) {
        var list = pane.querySelector('.pg-catlist');
        var cols = _otCols(list);
        var land = _otIsLandscape();
        if (land === null) return 'no .pg-shell to read the orientation from';
        if (land) {
            return cols === 1 ||
                'the landscape sidebar is ' + cols + ' columns wide — it is ~202px ' +
                'of content and a second track would crush both';
        }
        return cols >= 3 ||
            'the portrait rail drew ' + cols + ' column(s) across ' +
            Math.round(list.getBoundingClientRect().width) + 'px — the list is ' +
            'still a single long stack';
    });
});

t('...so the first photograph is on the first screen in portrait', function () {
    // The measurement behind the complaint, and the one that says the fix
    // worked: at 744x1133 the board used to start at y=1345 in a 1035px
    // viewport. Portrait only — in landscape the rail is beside the board and
    // this was never the problem.
    var g = _otNeedsTabletBox(); if (g) return g;
    return _otOnBoard(function (pane) {
        if (_otIsLandscape()) return true;
        var board = pane.querySelector('.pg-board');
        var top = board.getBoundingClientRect().top;
        return top < window.innerHeight ||
            'the board starts at y=' + Math.round(top) + ' in a ' +
            window.innerHeight + 'px viewport — that is a whole screen of rail ' +
            'before the first photograph';
    });
});

t('landscape shows more photographs than portrait, not just bigger ones', function () {
    // THE POINT OF TURNING THE IPAD SIDEWAYS, and it was not being delivered:
    // the board measures 633px in portrait and 718px in landscape, and at the
    // desktop's 196px minimum BOTH of those come out at three columns — same
    // count, bigger cards, far less height. Asserted as a floor per orientation
    // rather than as a comparison, because a single run only ever sees one of
    // them; run all four windows and the pair of floors is the comparison.
    var g = _otNeedsTabletBox(); if (g) return g;
    return _otOnBoard(function (pane) {
        var board = pane.querySelector('.pg-board');
        var cols = _otCols(board);
        var want = _otIsLandscape() ? 4 : 3;
        if (cols < want) {
            return (_otIsLandscape() ? 'landscape' : 'portrait') + ' at ' +
                   window.innerWidth + 'px draws ' + cols + ' columns across ' +
                   Math.round(board.getBoundingClientRect().width) + 'px of board, ' +
                   'expected at least ' + want;
        }
        // ...and not so many that the photograph stops being readable. The frame
        // is square, so the track width is the picture's width.
        var shot = pane.querySelector('.pg-shot');
        var w = shot.getBoundingClientRect().width;
        return w >= 150 ||
            'the cards are down to ' + Math.round(w) + 'px — past the point where ' +
            'a photograph of a phone screen tells anyone anything';
    });
});

t('an open group lays its sheets across the page', function () {
    // Ethan, 2026-09-20: "when you hit the dropdown, can the items within the
    // dropdown go in a row across the page instead of a column?" Once the list
    // went multi-column the sheets inside an open group were still stacking down
    // inside ONE ~200px track — Computer Parts opened seven rows deep in column
    // three with the other three columns blank beside it.
    var g = _otNeedsTabletBox(); if (g) return g;
    return _otOnBoard(function (pane) {
        var open = pane.querySelector('.pg-grp.open');
        if (!open) {
            return 'no group is open — the seeded sheets are not producing the ' +
                   'grouped rail this test is about';
        }
        var cats = open.querySelectorAll('.pg-grp-body .pg-cat');
        if (cats.length < 4) return 'the open group holds ' + cats.length + ' sheets; ' +
                                    'the seed should give it more than that';
        var list = pane.querySelector('.pg-catlist');
        if (!_otIsLandscape()) {
            // The TRAY spans every track, or "across the page" is only as wide
            // as the one column the group started in.
            var tray = open.querySelector('.pg-grp-body').getBoundingClientRect();
            var full = list.clientWidth;
            if (tray.width < full - 2) {
                return 'the tray is ' + Math.round(tray.width) + 'px inside a ' +
                       Math.round(full) + 'px list — it is still one cell, not a shelf';
            }
            var a = cats[0].getBoundingClientRect(), b = cats[1].getBoundingClientRect();
            return Math.abs(a.top - b.top) <= 1 ||
                'the first two sheets are at y=' + Math.round(a.top) + ' and y=' +
                Math.round(b.top) + ' — still a column';
        }
        // Landscape: the sidebar is ~200px, so one track is correct and the same
        // auto-fill rule is what produces it. Asserted so a future minmax tweak
        // cannot quietly crush this into two unreadable columns.
        return _otCols(open.querySelector('.pg-grp-body')) === 1 ||
            'the landscape sidebar split the open group into ' +
            _otCols(open.querySelector('.pg-grp-body')) + ' columns';
    });
});

t('...without dragging its heading out of the A-Z run', function () {
    // The correction: "I don't think the category title (ex. Computer Parts) need
    // to move down with the dropdown." Spanning the whole <section> was the blunt
    // reading — it took the heading with it and gave that title a line of its own,
    // out of the row it shared with Accessories and Cameras. The heading has to
    // keep its cell while only the tray claims a full row.
    var g = _otNeedsTabletBox(); if (g) return g;
    return _otOnBoard(function (pane) {
        if (_otIsLandscape()) return true;          // one column; nothing to share a row with
        var list = pane.querySelector('.pg-catlist');
        var open = pane.querySelector('.pg-grp.open');
        var head = open.querySelector('.pg-grp-top');
        var hr = head.getBoundingClientRect();
        if (hr.width > list.clientWidth - 2) {
            return 'the open heading is ' + Math.round(hr.width) + 'px of a ' +
                   Math.round(list.clientWidth) + 'px list — it took the whole row ' +
                   'with it again';
        }
        // ...and it is genuinely still beside its neighbours, not merely narrow.
        var tops = Array.prototype.slice.call(list.querySelectorAll('.pg-grp-top'));
        var sharing = tops.filter(function (el) {
            return el !== head &&
                   Math.abs(el.getBoundingClientRect().top - hr.top) <= 1;
        });
        if (!sharing.length) {
            return 'no other category heading sits on the open one\'s row — it is ' +
                   'still on a line of its own';
        }
        // The tray goes BELOW that row, which is what "beneath it" means.
        var tray = open.querySelector('.pg-grp-body').getBoundingClientRect();
        return tray.top >= hr.bottom - 1 ||
            'the tray starts at y=' + Math.round(tray.top) + ', above the heading ' +
            'bottom at ' + Math.round(hr.bottom);
    });
});

t('...and reads as belonging to the heading above it', function () {
    // "just make it differentiated that it is within that dropdown." A row four
    // sheets wide cannot say that with an indent, so the sheets sit in a tinted,
    // bordered tray. Asserted against the rail it sits in rather than against a
    // hex value, so the palette can move without this needing an edit.
    var g = _otNeedsTabletBox(); if (g) return g;
    return _otOnBoard(function (pane) {
        var body = pane.querySelector('.pg-grp.open > .pg-grp-body');
        if (!body) return 'no open group body';
        var cs = getComputedStyle(body);
        var railBg = getComputedStyle(pane.querySelector('.pg-rail')).backgroundColor;
        if (cs.backgroundColor === railBg || cs.backgroundColor === 'rgba(0, 0, 0, 0)') {
            return 'the tray is the same colour as the rail (' + cs.backgroundColor +
                   ') — nothing marks the sheets as being inside the group';
        }
        return parseFloat(cs.borderTopWidth) > 0 ||
            'the tray has no border, so on a tinted rail it would disappear';
    });
});

t('the chosen sheet wears the house green, not the old charcoal', function () {
    // Ethan, 2026-09-20: "the dropdown has the old black highlight look instead
    // of the new green look in other dropdowns." .pg-cat.on was a solid
    // var(--pg-ink) slab with white text — the pre-redesign highlight, and the
    // last place on the site still wearing it.
    //
    // NOT a tablet rule, which is why this test does not take the box guard: the
    // picker looks the same on a desktop and the complaint is about matching
    // every other dropdown, everywhere. Compared against a real .dd-opt.on
    // rendered beside it rather than against hex values, so the two move together
    // or this fails — the same shape the Live Dashboard picker's check uses.
    var host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:0;top:0;width:420px;';
    // Inside a .pg-panel, because that is where the --pg-* tokens are declared
    // (with .pg-ask — see the note above them). A .pg-cat mounted on <body> has
    // no --pg-accent-tint to resolve, so its background computes to transparent
    // and this test reports the old charcoal as missing rather than the new green
    // as present. The tokens are scoped; the fixture has to be too.
    host.innerHTML =
        '<div class="pg-panel"><div class="pg-catlist"><button class="pg-cat on">' +
        '<span class="pg-cat-name">Motherboards</span></button></div></div>' +
        '<div class="dd-list dd-open"><button class="dd-opt on">Chosen</button></div>';
    document.body.appendChild(host);
    try {
        var mine = getComputedStyle(host.querySelector('.pg-cat.on'));
        var theirs = getComputedStyle(host.querySelector('.dd-opt.on'));
        if (mine.backgroundColor !== theirs.backgroundColor) {
            return 'the chosen sheet is ' + mine.backgroundColor + ' where the house ' +
                   'dropdown uses ' + theirs.backgroundColor;
        }
        return mine.color === theirs.color ||
            'the chosen sheet\'s ink is ' + mine.color + ' against the house ' +
            theirs.color;
    } finally { host.remove(); }
});

// --- the SPEEKS Tools panel ------------------------------------------------
// Ethan, 2026-09-20: "add the preferred purchases tool back in for tablet", then
// "add the tools, Patch Notes and Submit Scores to tablet version". These are
// the first .tools-item entries to earn themselves back — everything restored
// before them was a tab or a widget — so the three of them are driven off one
// table rather than three copies of the same test.
//
// Preferred Purchases is TWO entries, not one: requesting (DM / manager / ASM)
// and approving (owner-manager) are the same tool from two sides, and bringing
// back only the side you happen to hold would hide it from the other role
// entirely. Role gating is untouched throughout — the tablet just stops removing
// these.
//
// `phone: true` marks the one that is not a tablet exception at all. Send Store
// Comment goes EVERYWHERE (Ethan: "you can also add the send store comment to
// mobile"), so the cut comes off rather than an exception going on —
// data-tablet="show" only ever means "cut from the phone, kept on a tablet", and
// a surface that is not cut has nothing to except.
var OT_TOOLS = [
    { key: 'tool-preferred-request',    role: 'manager',          open: 'togglePreferredPurchases', modal: 'preferredModal' },
    { key: 'tool-preferred-approve',    role: 'owner manager',    open: 'openPreferredOwner',       modal: 'preferredModal' },
    { key: 'tool-patch-notes',          role: 'district manager', open: 'togglePatchNotesManage',   modal: 'patchNotesManageModal' },
    { key: 'tool-submit-scores',        role: 'district manager', open: 'openScorecardModal',       modal: 'scorecardSubmitModal' },
    { key: 'tool-store-comment-drafts', role: 'district manager', open: 'openDailyBriefReview',     modal: 'dailyBriefModal' },
    { key: 'tool-store-comment',        role: 'district manager', open: 'toggleSendCommentModal',   modal: 'sendCommentModal', phone: true }
];

t('every restored tool carries both halves of the opt-in', function () {
    // ⚠️ THIS MARKUP IS DUPLICATED ACROSS FIVE PAGES (index, operations,
    // workspace, stats, docs) and one harness run only ever sees the one -Html
    // inlined. A tools panel is on every page, so an opt-in applied to four of
    // them is invisible from here.
    var bad = [];
    OT_TOOLS.forEach(function (tool) {
        var el = document.querySelector('.tools-item[data-feature="' + tool.key + '"]');
        if (!el) { bad.push(tool.key + ' is missing from this page'); return; }
        if (tool.phone) {
            // Not an exception — a surface with no cut on it at all. Carrying
            // data-mobile="hide" AND data-tablet="show" would reach the same
            // tablet but keep it off the phone, which is the thing being undone.
            if (el.hasAttribute('data-mobile')) {
                bad.push(tool.key + ' still carries data-mobile="' +
                         el.getAttribute('data-mobile') + '", so the phone never sees it');
            }
            if (el.hasAttribute('data-tablet')) {
                bad.push(tool.key + ' carries data-tablet, which excepts a cut that ' +
                         'is no longer there — it reads as if the phone were excluded');
            }
        } else {
            if (el.getAttribute('data-mobile') !== 'hide') bad.push(tool.key + ' lost data-mobile="hide"');
            if (el.getAttribute('data-tablet') !== 'show') bad.push(tool.key + ' has no data-tablet="show"');
        }
        if (!el.classList.contains('dynamic-module-flex')) {
            bad.push(tool.key + ' is no longer swept by applyRoleBasedUI, so the JS ' +
                     'half of the opt-in cannot reach it');
        }
        if (typeof window[tool.open] !== 'function') {
            bad.push(tool.key + ' opens ' + tool.open + '(), which is not a function');
        }
    });
    return !bad.length || bad.join('; ');
});

t('the role sweep hands them to a tablet and withholds them from a phone', function () {
    // The half CSS cannot do. applyRoleBasedUI writes display inline with
    // !important, so the stylesheet exception alone would lose — both writers
    // have to agree, and this asks the real sweep, per tool, on both devices.
    var g = _otNeedsTabletBox(); if (g) return g;
    var bad = [];
    OT_TOOLS.forEach(function (tool) {
        var el = document.querySelector('.tools-item[data-feature="' + tool.key + '"]');
        if (!el) { bad.push(tool.key + ' is missing'); return; }
        _otAsRole(tool.role, function () {
            var onTablet = _otAsTablet(function () {
                try { applyRoleBasedUI(); } catch (e) {}
                return el.style.display;
            });
            if (onTablet === 'none') {
                bad.push(tool.key + ' is still hidden on a tablet for a ' + tool.role);
            }
            var onPhone = _otAsPhone(function () {
                try { applyRoleBasedUI(); } catch (e) {}
                return el.style.display;
            });
            if (tool.phone) {
                if (onPhone === 'none') {
                    bad.push(tool.key + ' is hidden on a phone, and it is the one ' +
                             'that is supposed to be everywhere');
                }
            } else if (onPhone !== 'none') {
                bad.push(tool.key + ' reaches a phone too (display: ' + onPhone + ')');
            }
        });
    });
    return !bad.length || bad.join('; ');
});

t('...and every modal behind them fits the screen', function () {
    // The item is a door; the modal is the tool. Each opener fetches something
    // the runner blocks, so this measures the CHROME each modal is built from —
    // which is the part that can overflow — rather than a populated list.
    //
    // #scorecardSubmitModal is the one to watch: it declares 1200px, wider than
    // any tablet, and only the compact layer's bottom-sheet rules bring it down.
    var g = _otNeedsTabletBox(); if (g) return g;
    var st = _otReplayTablet();
    try {
        var bad = [];
        OT_TOOLS.forEach(function (tool) {
            _otAsRole(tool.role, function () {
                _otAsTablet(function () {
                    try { window[tool.open](); } catch (e) {}
                    var modal = document.getElementById(tool.modal);
                    try {
                        if (!modal) { bad.push('#' + tool.modal + ' is missing'); return; }
                        var r = modal.getBoundingClientRect();
                        if (r.width < 50) {
                            bad.push('#' + tool.modal + ' measured ' + Math.round(r.width) +
                                     'px — it did not open, so nothing was measured');
                            return;
                        }
                        if (r.width > window.innerWidth + 1) {
                            bad.push('#' + tool.modal + ' is ' + Math.round(r.width) +
                                     'px on a ' + window.innerWidth + 'px screen');
                        }
                        ['.tool-head', '.notif-tabs', '.manage-footer', '.manage-content']
                            .forEach(function (sel) {
                                var el = modal.querySelector(sel);
                                if (el && el.scrollWidth > el.clientWidth + 1) {
                                    bad.push('#' + tool.modal + ' ' + sel + ' by ' +
                                             (el.scrollWidth - el.clientWidth) + 'px');
                                }
                            });
                        // ...and the body is not empty, or the line above just
                        // compared nothing against nothing. The scorecard builds
                        // its store inputs from a static list, so it populates
                        // even with the network blocked; a tool that needs a
                        // fetch to draw anything would show up here as a warning
                        // rather than as a silent pass.
                        var body = modal.querySelector('.manage-content');
                        if (body && body.getBoundingClientRect().height < 40) {
                            bad.push('#' + tool.modal + ' body is ' +
                                     Math.round(body.getBoundingClientRect().height) +
                                     'px tall — nothing was measured inside it');
                        }
                    } finally { try { closeAllModals(); } catch (e) {} }
                });
            });
        });
        return !bad.length || 'at ' + window.innerWidth + 'px: ' + bad.join('; ');
    } finally { _otEndReplay(st); }
});

// --- dropdown faces standing in a row --------------------------------------
// Ethan, 2026-09-20, on Submit Scores: "can you make the dropdown bubbles the
// same size as the text boxes next to it ... I mean height".
//
// ⚠️ NO REPLAY IN EITHER OF THESE, and that is not an oversight. The compact
// band's `body .dd-btn { height: 34px }` is (0,1,1); the rule that beats it is
// (0,2,0). Replaying the band prefixes html.tbprobe, which lifts it to (0,2,1)
// and hands it a cascade fight it loses on a real device — the probe would be
// reporting its own thumb on the scale. At 744 the band is genuinely live, and
// at a landscape width it is genuinely absent; both are honest cascades, and the
// two controls have to match in both.

t('a dropdown face matches the field it shares a row with', function () {
    // ⚠️ offsetHeight, NOT getBoundingClientRect. #scorecardSubmitModal carries a
    // 0.95 transform, so every rect inside it reads 5% short — which is why the
    // face first appeared to be 32.3px against a declared 34.
    var date = document.getElementById('dm-score-date');
    var sel = document.getElementById('dm-store-select');
    if (!date || !sel) return 'the scorecard store/date row is not on this page';
    return _otAsRole('district manager', function () {
        try { openScorecardModal(); } catch (e) { return 'openScorecardModal threw: ' + e.message; }
        try {
            if (typeof _ddEnhance === 'function') { try { _ddEnhance(sel); } catch (e) {} }
            var host = sel.closest('.dd-host');
            if (!host) return 'the store select was never wrapped by _ddEnhance';
            if (!host.classList.contains('dd-host-lg')) {
                return 'the host has no .dd-host-lg — _ddEnhance is not marking a ' +
                       '.form-input-lg select, so the face cannot stretch to its row';
            }
            var face = host.querySelector('.dd-btn');
            if (date.offsetHeight < 20) {
                return 'the date field measures ' + date.offsetHeight + 'px — the ' +
                       'modal did not open and nothing was compared';
            }
            return Math.abs(face.offsetHeight - date.offsetHeight) <= 1 ||
                'the face is ' + face.offsetHeight + 'px beside a ' +
                date.offsetHeight + 'px date field at ' + window.innerWidth + 'px';
        } finally { try { closeAllModals(); } catch (e) {} }
    });
});

t('...without flattening every other dropdown on the site', function () {
    // THE REASON THE MARGIN MOVED RATHER THAN VANISHED. .form-input-lg carries
    // margin-top: 6px and the FACE was carrying it, which is what kept the face
    // 6px short of its host. There are 100 such selects on this site and only 5
    // override that margin, so 95 are using it to sit under a label — zeroing it
    // on the face would have tightened all 95 to fix one row in one tool. The
    // host owns it now, so a standalone picker is unmoved.
    var box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:0;top:0;width:320px;';
    box.innerHTML = '<label>Store</label>' +
        '<select class="form-input-lg" id="_otStandalone">' +
        '<option value="OVL">OVL</option><option value="LEE">LEE</option></select>';
    document.body.appendChild(box);
    try {
        var s2 = box.querySelector('#_otStandalone');
        if (typeof _ddEnhance !== 'function') return '_ddEnhance is gone';
        try { _ddEnhance(s2); } catch (e) { return '_ddEnhance threw: ' + e.message; }
        var h2 = s2.closest('.dd-host');
        if (!h2) return 'the standalone select was never wrapped';
        var mt = parseFloat(getComputedStyle(h2).marginTop);
        if (!(mt >= 5)) {
            return 'a standalone .form-input-lg dropdown has ' + mt + 'px above it — ' +
                   'the 6px that separates a field from its label has been lost';
        }
        // ...and the face still fills its host rather than sitting inside it.
        var f2 = h2.querySelector('.dd-btn');
        return Math.abs(f2.offsetHeight - h2.offsetHeight) <= 1 ||
            'the face is ' + f2.offsetHeight + 'px inside a ' + h2.offsetHeight +
            'px host — the margin is back on the face';
    } finally { box.remove(); }
});

t('the Have an Idea pill is a lozenge, not an egg', function () {
    // Sixth appearance of `button { min-height: 44px }` from the tap-target
    // block — .lv-mode, .modal-close-btn, the two dark X-es, the audit pills and
    // now this, measured at 107x44 for a 23px lozenge with a 999px radius.
    // Asserted as a RATIO against its own type so the padding can be tuned
    // without rewriting the number here.
    var g = _otNeedsTabletBox(); if (g) return g;
    return _otOnBoard(function (pane) {
        var pill = pane.querySelector('.pg-inline-link');
        if (!pill) return 'no .pg-inline-link in the rail footer';
        var r = pill.getBoundingClientRect();
        var cs = getComputedStyle(pill);
        var line = parseFloat(cs.lineHeight) +
                   parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
                   parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
        return Math.abs(r.height - line) <= 1 ||
            'it is ' + Math.round(r.width) + 'x' + r.height.toFixed(1) + ' where its ' +
            'own type and padding come to ' + line.toFixed(1) + 'px — a min-height ' +
            'floor is stretching it';
    });
});
