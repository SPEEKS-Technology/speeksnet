// ===========================================================================
// STATS & AWARDS ON A TABLET — the awards view, and the name in the tab bar
//
//   powershell -File scripts/browser-check.ps1 stats-awards-check.js \
//              -Html stats.html -WindowSize 744,1133
//
// 744x1133 is an iPad mini in portrait: the narrowest tablet the tier admits and
// the only width where the tab-bar labels are in any doubt. -Html because both
// halves of this are about attributes on real elements in stats.html — an opt-in
// written into a harness fixture proves only that the fixture agrees with itself.
//
// Ethan, 2026-09-20: "add awards into the stats page on tablet and then change
// the stats page name back to Stats & Awards like desktop shows."
//
// THE NAME IS NOT ON THE STATS PAGE. The <h2> has read "Stats & Awards" on every
// build. The name being read was the bottom tab bar's, which the compact block
// swaps for the short form in data-m ("Stats") because five real labels do not
// fit across a 390px phone. So half this file is about nav.html markup that
// exists on all five pages, and it runs here because this is the page that
// prompted it.
//
// THE HARNESS CANNOT BE A TABLET. The tier needs pointer:coarse and headless
// Chrome reports fine, so tablet-tier rules are never live. They are read out of
// the CSSOM and replayed under html.tbprobe, which measures the SHIPPED
// declarations. The replay PREFIXES A CLASS, so it cannot see a source-order
// loss — and the nav-label rule is decided on source order alone. That is what
// the last test in this file is for; see command-center-check.js, where the same
// blind spot shipped a broken rule that measured perfect.
// ===========================================================================

if (typeof _b2bSend === 'function') { _b2bSend = function () { return Promise.resolve({}); }; }

var SA_TABLET_Q = '(min-width: 701px) and (min-height: 540px)'
                + ' and (max-width: 1366px) and (pointer: coarse)';

function _saNorm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function _saSheetRules() {
    // Flat, IN SOURCE ORDER, with the media condition carried along. Order is the
    // whole point of the last test, so this deliberately does not group.
    var out = [];
    Array.prototype.forEach.call(document.styleSheets, function (ss) {
        var rules; try { rules = ss.cssRules; } catch (e) { return; }
        Array.prototype.forEach.call(rules || [], function (r) {
            if (r.type === CSSRule.MEDIA_RULE) {
                var cond = _saNorm(r.conditionText);
                try {
                    for (var i = 0; i < r.cssRules.length; i++) {
                        out.push({ cond: cond, sel: _saNorm(r.cssRules[i].selectorText || ''),
                                   style: r.cssRules[i].style });
                    }
                } catch (e) {}
            } else if (r.type === CSSRule.STYLE_RULE) {
                out.push({ cond: '', sel: _saNorm(r.selectorText || ''), style: r.style });
            }
        });
    });
    return out;
}

function _saReplayTablet() {
    var css = '';
    _saSheetRules().forEach(function (r) {
        if (r.cond !== _saNorm(SA_TABLET_Q)) return;
        css += 'html.tbprobe ' + r.sel + ' { ' + r.style.cssText + ' }\n';
    });
    if (!css) return null;
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    document.documentElement.classList.add('tbprobe');
    return st;
}
function _saEndReplay(st) {
    if (st) st.remove();
    document.documentElement.classList.remove('tbprobe');
}

// The compact band IS live here (744px is under 900px), and everything the
// tablet tier layers onto assumes it. Run at a desktop width and the cuts are
// simply absent, so the restores have nothing to restore and each test invents
// its own story about why. Told once.
function _saNeedsCompact() {
    if (typeof _isMobileLayout === 'function' && _isMobileLayout()) return null;
    return 'this run is at ' + window.innerWidth + 'px, outside the compact band — ' +
           'the cuts these restores undo are not live here. Use -WindowSize 744,1133.';
}

// The nav is inside .top-nav, which body:not(.is-authenticated) hides wholesale,
// and a hidden ancestor makes every rect 0x0. Authenticate the body for the
// measuring tests only.
function _saAuthed(fn) {
    var had = document.body.classList.contains('is-authenticated');
    document.body.classList.add('is-authenticated');
    try { return fn(); }
    finally { if (!had) document.body.classList.remove('is-authenticated'); }
}

t('the awards surfaces carry both halves of the opt-in', function () {
    // data-tablet="show" alone does nothing — it is an exception to a cut, so the
    // cut has to be there for it to except. A surface with only data-tablet is
    // the failure mode where somebody "fixed" a phone problem by deleting
    // data-mobile and put the awards grid back on a 390px screen.
    var want = ['ssv-awards', 'stats-view-awards'];
    var bad = [];
    want.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) { bad.push(id + ' is missing from stats.html'); return; }
        if (el.getAttribute('data-mobile') !== 'hide') bad.push(id + ' lost data-mobile="hide"');
        if (el.getAttribute('data-tablet') !== 'show') bad.push(id + ' has no data-tablet="show"');
    });
    return !bad.length || bad.join('; ');
});

t('a phone still gets neither of them', function () {
    // The cut is the default and the tablet is the exception, so this is the test
    // that has to keep passing while the one below starts to. No replay: the
    // compact band is genuinely live at this width with a fine pointer, which is
    // the phone case exactly.
    var g = _saNeedsCompact(); if (g) return g;
    var bad = ['ssv-awards', 'stats-view-awards'].filter(function (id) {
        return getComputedStyle(document.getElementById(id)).display !== 'none';
    });
    return !bad.length ||
        'a phone can see ' + bad.join(' and ') + ' — the awards grid is three cards ' +
        'across and there is no room for it at 390px';
});

t('a tablet gets the Awards button back', function () {
    var g = _saNeedsCompact(); if (g) return g;
    var st = _saReplayTablet();
    try {
        if (!st) return 'no tablet-tier rules in the stylesheet at all';
        var d = getComputedStyle(document.getElementById('ssv-awards')).display;
        if (d === 'none') {
            return 'the Awards seg is still display:none on a tablet — the blanket ' +
                   'opt-in did not reach it';
        }
        // The strip carried two buttons on every compact screen and now carries
        // three. .stats-subnav is `width: max-content` over `grid-auto-columns:
        // 1fr` — equal tracks sized to the widest label, so a third button does
        // not just take a share, it adds one. max-width: 100% is what stops it
        // overflowing, and the segs are nowrap, so if that cap ever comes off
        // this is where it shows.
        var nav = document.querySelector('.stats-subnav');
        if (nav.scrollWidth > nav.clientWidth + 1) {
            return 'the sub-nav overflows by ' + (nav.scrollWidth - nav.clientWidth) +
                   'px at ' + window.innerWidth + 'px with three segs';
        }
        var clipped = Array.prototype.filter.call(nav.querySelectorAll('.stats-seg span'),
            function (s) { return s.scrollWidth > s.clientWidth + 1; })
            .map(function (s) { return _saNorm(s.textContent); });
        return !clipped.length ||
            'clipped seg labels: ' + clipped.join(', ');
    } finally { _saEndReplay(st); }
});

t('...and the Awards VIEW obeys the tab, not the opt-in', function () {
    // THE BUG THE RESTORE EXISTS FOR. The blanket opt-in is `display: flex
    // !important`, which for a .stats-view means "always on" — the awards pane
    // would sit open underneath whichever view is actually selected, !important
    // beating the plain `.stats-view { display: none }` that switches them. Both
    // states are asserted, because a restore that got only one of them right is
    // the interesting kind of wrong.
    var g = _saNeedsCompact(); if (g) return g;
    var view = document.getElementById('stats-view-awards');
    var st = _saReplayTablet();
    try {
        showStatsView('champions');
        var idle = getComputedStyle(view).display;
        if (idle !== 'none') {
            return 'the awards pane is ' + idle + ' while Champions is selected — it ' +
                   'is showing through underneath the active view';
        }
        showStatsView('awards');
        var on = getComputedStyle(view).display;
        if (on === 'none') return 'selecting Awards does not show the awards pane';
        // ...and the other two go away when it is chosen, which is the same rule
        // read from the other side.
        var stuck = ['champions', 'records'].filter(function (v) {
            return getComputedStyle(document.getElementById('stats-view-' + v)).display !== 'none';
        });
        return !stuck.length ||
            'stats-view-' + stuck.join(' and stats-view-') + ' stayed visible behind Awards';
    } finally { showStatsView('champions'); _saEndReplay(st); }
});

t('the awards cards fit the tablet once they can be seen', function () {
    // The view has been cut from every compact screen since the curation pass, so
    // its cards have NEVER been rendered inside the band — the two-column rule at
    // .awards-grid was written for a breakpoint nothing could reach. Restoring the
    // view is the first time it means anything, so it gets measured rather than
    // read. Rendered through renderAwards() rather than from a fixture: the cards
    // are built in JS and a fixture would only prove the copy agrees with itself.
    var g = _saNeedsCompact(); if (g) return g;
    return _saWithAwards(function (grid) {
        var cards = grid.querySelectorAll('.aw');
        if (cards.length !== 3) {
            return 'renderAwards() produced ' + cards.length + ' cards, not 3 — the ' +
                   'renderer changed and this test is measuring the wrong thing';
        }
        var over = [];
        [document.getElementById('stats-view-awards'), grid,
         grid.parentElement, document.querySelector('.awards-section-header')]
            .forEach(function (el) {
                if (el && el.scrollWidth > el.clientWidth + 1) {
                    over.push((el.id || el.className) + ' by ' +
                              (el.scrollWidth - el.clientWidth) + 'px');
                }
            });
        if (over.length) {
            return 'horizontal overflow at ' + window.innerWidth + 'px: ' + over.join(', ');
        }
        // The award names are two words over two lines by design; a card narrow
        // enough to clip one is the failure the 3->2 column rule exists to avoid.
        var clipped = Array.prototype.filter.call(cards, function (c) {
            var n = c.querySelector('.aw-name');
            return n && n.scrollWidth > n.clientWidth + 1;
        }).length;
        return !clipped ||
            clipped + ' of 3 award names are clipped by their card at ' +
            window.innerWidth + 'px';
    });
});

// --- the awards cards themselves -------------------------------------------
// Ethan, 2026-09-20, once they were on the tablet:
//   · "for the awards, can we stack them instead of having 2 per row?"
//   · "Also the i buttons look weird and don't show anything when clicked"

// Awards on screen, rendered by the real renderer, with the tablet tier replayed
// — and PROVED to have a size before any test is allowed to measure it.
//
// .main-content lives behind body:not(.is-authenticated), so without _saAuthed
// every rect here is 0x0 and every geometry assertion passes over nothing: three
// cards all at left 0, a scrollWidth of 0 that never exceeds a clientWidth of 0.
// Two of these tests went green that way before the guard existed, which is the
// only reason it is stated this loudly.
function _saWithAwards(fn) {
    var prev = awardsCache;
    awardsCache = [{ month: 'September 2026', winner1: 'OVL', winner2: 'MPL', winner3: 'BAL' }];
    var st = _saReplayTablet();
    try {
        return _saAuthed(function () {
            renderAwards();
            showStatsView('awards');
            var grid = document.getElementById('awards-cards-container');
            var r = grid.getBoundingClientRect();
            if (r.width < 50 || r.height < 50) {
                return 'the awards grid measures ' + Math.round(r.width) + 'x' +
                       Math.round(r.height) + ' — something above it is display:none ' +
                       'and nothing in this test means anything';
            }
            return fn(grid);
        });
    } finally {
        awardsCache = prev;
        showStatsView('champions');
        _saEndReplay(st);
    }
}

t('the awards stack one per row on a tablet', function () {
    // Three awards, always — AWARD_NAMES has had three entries since it was
    // written — so two per row is the one arrangement that cannot come out even.
    // Asserted on the cards' geometry and not just on grid-template-columns: a
    // single track that something inside still manages to sit beside would pass
    // the property check and fail the eye.
    var g = _saNeedsCompact(); if (g) return g;
    return _saWithAwards(function (grid) {
        var cards = Array.prototype.slice.call(grid.querySelectorAll('.aw'));
        if (cards.length !== 3) return 'expected 3 cards, got ' + cards.length;
        var lefts = cards.map(function (c) { return Math.round(c.getBoundingClientRect().left); });
        var tops  = cards.map(function (c) { return Math.round(c.getBoundingClientRect().top); });
        if (lefts[0] !== lefts[1] || lefts[1] !== lefts[2]) {
            return 'the cards start at ' + lefts.join(', ') + 'px — still more than ' +
                   'one per row';
        }
        return (tops[0] < tops[1] && tops[1] < tops[2]) ||
            'the cards are at ' + tops.join(', ') + 'px from the top — they share a ' +
            'row rather than stacking';
    });
});

t('the info dot is a circle, not an egg', function () {
    // .aw-i asks for 19x19 and the compact tap-target block's `button {
    // min-height: 44px }` gave it 19x44 — MIN-height over height, which no amount
    // of class specificity fixes because it is not a specificity question. A
    // border-radius: 50% on that box is an egg, which is what Ethan saw.
    // Measured square-ness rather than the literal numbers, so the size can be
    // tuned without rewriting the test.
    var g = _saNeedsCompact(); if (g) return g;
    return _saWithAwards(function (grid) {
        var btn = grid.querySelector('.award-info-btn');
        if (!btn) return 'no .award-info-btn on the cards at all';
        var r = btn.getBoundingClientRect();
        if (Math.abs(r.width - r.height) > 1) {
            return 'it is ' + Math.round(r.width) + 'x' + Math.round(r.height) +
                   ' — a min-height floor is stretching it again';
        }
        // It is a tap target now, not a hover target. 24px is the floor below
        // which the close controls' 28-30px trade stops being defensible.
        return r.height >= 24 ||
            'it is ' + Math.round(r.height) + 'px square, too small to tap now ' +
            'that tapping is the only way to read it';
    });
});

t('...and it does not crowd the award name', function () {
    var g = _saNeedsCompact(); if (g) return g;
    return _saWithAwards(function (grid) {
        var bad = [];
        Array.prototype.forEach.call(grid.querySelectorAll('.aw'), function (card) {
            var btn = card.querySelector('.award-info-btn');
            var name = card.querySelector('.aw-name');
            if (!btn || !name) return;
            var b = btn.getBoundingClientRect(), n = name.getBoundingClientRect();
            // .aw-name is a full-width block with right padding holding it clear,
            // so compare against where its TEXT can reach, not its box.
            var textRight = n.right - parseFloat(getComputedStyle(name).paddingRight);
            if (textRight > b.left + 0.5) {
                bad.push(_saNorm(name.textContent).slice(0, 28) + ' (overlaps by ' +
                         Math.round(textRight - b.left) + 'px)');
            }
        });
        return !bad.length ||
            'the dot sits on the title: ' + bad.join('; ') + ' — .aw-name\'s right ' +
            'padding has to track the dot\'s width';
    });
});

// A tap fires a synthetic mouseover first, and the tooltip system turns itself
// off wholesale on a coarse pointer — which is why the "i" did nothing on an
// iPad. The handler asks matchMedia at call time, so a coarse pointer can be
// faked here; the harness is pointer:fine and always will be.
function _saAsTouch(fn) {
    var real = window.matchMedia;
    window.matchMedia = function (q) {
        if (/hover:\s*none|pointer:\s*coarse/.test(q)) {
            return { matches: true, media: q, addListener: function () {},
                     removeListener: function () {}, addEventListener: function () {},
                     removeEventListener: function () {} };
        }
        return real.call(window, q);
    };
    try { return fn(); } finally { window.matchMedia = real; }
}

function _saTap(el) {
    // The real sequence, in order: the synthetic mouseover that takes the tooltip
    // down is the thing the tap path has to survive, so replaying the click alone
    // would test a situation that never happens.
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

t('tapping the info dot shows the award description', function () {
    var g = _saNeedsCompact(); if (g) return g;
    return _saWithAwards(function (grid) {
        return _saAsTouch(function () {
            var btn = grid.querySelector('.award-info-btn');
            _saTap(btn);
            if (!customTooltip.classList.contains('show')) {
                return 'nothing opened — the tap path is not reaching .award-info-btn';
            }
            var txt = _saNorm(customTooltip.textContent);
            if (txt.indexOf(btn.dataset.desc) < 0) {
                return 'the card says "' + txt + '", which does not contain the ' +
                       'description the button carries';
            }
            // Anchored, not trailing: there is no cursor for it to follow, and a
            // tooltip left at the last mouse position would open off in a corner.
            return customTooltip.classList.contains('anchored') ||
                'it opened un-anchored, so it is sitting wherever the mouse last was';
        });
    });
});

t('...and the next tap puts it away again', function () {
    // The missing mouseout, supplied by hand. Both dismissals are asserted —
    // tapping the same dot again, and tapping anything else — because a tooltip
    // that opens on touch and cannot be closed is worse than one that never
    // opened, and that is the exact failure the site-wide no-touch-tooltip rule
    // was written to prevent.
    var g = _saNeedsCompact(); if (g) return g;
    return _saWithAwards(function (grid) {
        return _saAsTouch(function () {
            var btns = grid.querySelectorAll('.award-info-btn');
            _saTap(btns[0]);
            if (!customTooltip.classList.contains('show')) return 'it did not open';
            _saTap(btns[0]);
            if (customTooltip.classList.contains('show')) {
                return 'a second tap on the same dot left it open';
            }
            _saTap(btns[1]);
            if (!customTooltip.classList.contains('show')) {
                return 'tapping a different dot did not open that one';
            }
            _saTap(grid.querySelector('.aw-store') || grid);
            return !customTooltip.classList.contains('show') ||
                'tapping the card body left the tooltip open';
        });
    });
});

t('a mouse is left entirely alone by the tap path', function () {
    // The hover branch already shows the same card, built by the same
    // _awardTipFill. Both running would mean a desktop click toggling OFF the
    // tooltip its own hover had just opened — the regression this test exists for.
    var g = _saNeedsCompact(); if (g) return g;
    return _saWithAwards(function (grid) {
        var btn = grid.querySelector('.award-info-btn');
        customTooltip.classList.remove('show', 'anchored');
        // No _saAsTouch: the harness really is pointer:fine, which is the case.
        btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        var afterHover = customTooltip.classList.contains('show');
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        var afterClick = customTooltip.classList.contains('show');
        if (!afterHover) return 'hovering the dot no longer shows anything on a mouse';
        return afterClick ||
            'the click handler closed a tooltip the hover had opened — it is running ' +
            'on a fine pointer, where it must not';
    });
});

t('the tab bar says what the desktop nav says', function () {
    // The name half of the request. The compact block hides the real <span> and
    // paints data-m in an ::after; the tablet tier puts the span back and takes
    // the ::after away. Both halves are asserted — leave the ::after in place and
    // the bar shows BOTH, which is not a state anybody would predict from the
    // rule that caused it.
    var g = _saNeedsCompact(); if (g) return g;
    return _saAuthed(function () {
        var link = document.querySelector('.top-nav .nav-bar .nav-link[href="stats.html"]');
        if (!link) return 'no Stats link in the nav bar';
        var span = link.querySelector('span');
        if (!span) return 'the Stats link has no <span> label to restore';
        if (_saNorm(span.textContent) !== 'Stats & Awards') {
            return 'the desktop label reads "' + _saNorm(span.textContent) +
                   '", so restoring it would not give Ethan the name he asked for';
        }
        var st = _saReplayTablet();
        try {
            if (getComputedStyle(span).display === 'none') {
                return 'the real label is still hidden on a tablet — the bar reads "' +
                       link.getAttribute('data-m') + '"';
            }
            var after = getComputedStyle(link, '::after').content;
            return (after === 'none' || after === 'normal') ||
                'the data-m short form is still painted as well (::after content is ' +
                after + '), so the link shows its name twice';
        } finally { _saEndReplay(st); }
    });
});

t('...and the five real labels fit across the narrowest tablet', function () {
    // Why the short forms existed. Every link is force-shown first: the role
    // sweep hides Operations and Workspace for most roles, and measuring the
    // three a store manager sees would pass while a DM's bar overflowed.
    var g = _saNeedsCompact(); if (g) return g;
    return _saAuthed(function () {
        var bar = document.querySelector('.top-nav .nav-bar');
        if (!bar) return 'no .nav-bar';
        var links = Array.prototype.slice.call(bar.querySelectorAll('.nav-link'));
        var undo = links.map(function (l) {
            var prev = l.getAttribute('style') || '';
            l.style.setProperty('display', 'flex', 'important');
            return function () { l.setAttribute('style', prev); };
        });
        var st = _saReplayTablet();
        try {
            if (links.length < 5) {
                return 'only ' + links.length + ' nav links on this page — the worst ' +
                       'case this test is meant to cover is a DM, who sees five';
            }
            if (bar.scrollWidth > bar.clientWidth + 1) {
                return 'the bar overflows by ' + (bar.scrollWidth - bar.clientWidth) +
                       'px at ' + window.innerWidth + 'px with all five labels';
            }
            var clipped = links.filter(function (l) {
                var s = l.querySelector('span');
                return s && s.scrollWidth > s.clientWidth + 1;
            }).map(function (l) { return _saNorm(l.querySelector('span').textContent); });
            return !clipped.length ||
                'clipped: ' + clipped.join(', ') + ' — the labels are nowrap, so a ' +
                'track too narrow for one cuts it off rather than wrapping it';
        } finally { st && _saEndReplay(st); undo.forEach(function (f) { f(); }); }
    });
});

t('the label rule sits after the compact rule that hides it', function () {
    // THE ONE THE REPLAY CANNOT SEE. `.top-nav.nav-compact .nav-bar .nav-link
    // span` is (0,4,1) in the compact block and (0,4,1) in the tablet block, so
    // nothing but source order decides it — and the replay prefixes html.tbprobe,
    // which inflates the tablet side to (0,5,1) and hands it the tie it might be
    // losing on a real device. Read out of the CSSOM in order instead. Written
    // because exactly this shipped once before, on .cc-seg .toggle-btn, and
    // measured perfect all the way to the iPad.
    var rules = _saSheetRules();
    var hideAt = -1, showAt = -1;
    rules.forEach(function (r, i) {
        if (r.sel.indexOf('.nav-bar .nav-link span') < 0) return;
        var d = r.style.getPropertyValue('display');
        if (d === 'none' && hideAt < 0) hideAt = i;
        if (d && d !== 'none') showAt = i;
    });
    if (hideAt < 0) return 'the compact block no longer hides .nav-bar .nav-link span';
    if (showAt < 0) return 'nothing brings .nav-bar .nav-link span back — the tablet bar ' +
                           'has no labels at all';
    return showAt > hideAt ||
        'the restore is at rule #' + showAt + ' and the cut at #' + hideAt + ' — the ' +
        'restore loses on source order and the tab bar still reads "Stats"';
});
