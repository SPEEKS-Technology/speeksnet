// SEPT 17 ROUND 2 — two fixes that are not about a breakpoint, so they live here
// rather than in tablet-band-check.js.
//
//   powershell -File scripts/browser-check.ps1 copy-flash-dropdown-check.js -Html index.html
//
// 1. Every copy button flashes the same green (Ethan: "green like the box order
//    tool ... for all three site versions"). Six functions used to answer that
//    question three different ways.
// 2. The Expense Report's Category face painted over the Description input. It is
//    the SAME bug the B2B pricing sheet had -- a measured inline min-width with
//    nothing in CSS able to outrank it -- and the same fix, which had simply only
//    ever been pointed at .b2b-pcell.

// ---------------------------------------------------------------------------
// THE COPIED FLASH
// ---------------------------------------------------------------------------

// Every function that copies something and then says so.
var CF_COPIERS = ['copyQMToClipboard', 'copyBoxOrder', 'copyRecycleReport',
                  'expCopyReport', 'lhToolCopy', 'b2bCopyDropDiag'];

t('all six copy buttons go through the one flash', function () {
    if (typeof _copyFlash !== 'function') return '_copyFlash() is gone';
    var missing = CF_COPIERS.filter(function (n) {
        return typeof window[n] !== 'function' || !/_copyFlash\(/.test(String(window[n]));
    });
    return !missing.length ||
        missing.join(', ') + ' do not call _copyFlash -- they will confirm a copy ' +
        'in a different colour from the button two tools over';
});

t('no copy button still sets the flash colours by hand', function () {
    // Inline styles were how the three green ones did it, and inline loses to
    // !important -- which is the whole reason this had to stop for "mobile and
    // tablet", where the compact build is full of !important.
    var bad = CF_COPIERS.filter(function (n) {
        if (typeof window[n] !== 'function') return false;
        return /style\.(background|color|borderColor)\s*=/.test(String(window[n]));
    });
    return !bad.length || bad.join(', ') + ' still write the colours inline';
});

t('the flash class carries the Box Order green, with enough weight', function () {
    var found = null;
    for (var s = 0; s < document.styleSheets.length; s++) {
        var rules;
        try { rules = document.styleSheets[s].cssRules; } catch (e) { continue; }
        for (var i = 0; i < rules.length; i++) {
            var r = rules[i];
            if (!r.selectorText || r.selectorText.indexOf('.is-copied') < 0) continue;
            found = r;
        }
    }
    if (!found) return 'no .is-copied rule in the stylesheet';
    var bg = found.style.getPropertyValue('background');
    if (bg.indexOf('#d1fae5') < 0 && bg.indexOf('209, 250, 229') < 0) {
        return 'background is "' + bg + '", not Box Order\'s #d1fae5';
    }
    // .qm-copy-btn is (0,1,0) and #quickMsgDropdown .qm-copy-btn is (1,1,0), and
    // the :hover of whichever one is live at the instant of the click -- the
    // pointer has not moved off the button it just pressed.
    if (found.style.getPropertyPriority('background') !== 'important') {
        return 'the flash background is not !important -- #quickMsgDropdown .qm-copy-btn wins';
    }
    return /:hover/.test(found.selectorText) ||
        'the flash does not cover :hover, so the button it was just clicked on keeps its hover paint';
});

t('the flash actually lands on a button, and comes back off', function () {
    var b = document.createElement('button');
    b.textContent = 'Copy';
    document.body.appendChild(b);
    try {
        _copyFlash(b);
        if (!b.classList.contains('is-copied')) return 'the class was not applied';
        if (b.textContent !== 'Copied!') return 'the label is "' + b.textContent + '"';
        var bg = getComputedStyle(b).backgroundColor;
        return bg === 'rgb(209, 250, 229)' ||
            'the computed background is ' + bg + ', not the flash green';
    } finally { b.remove(); }
});

t('clicking copy twice does not leave the button saying Copied forever', function () {
    // Every one of the six captured the CURRENT label as "the original" on the way
    // in, so a second click during the flash captured "Copied!" and restored that
    // permanently. Clicking twice is what you do when you are not sure it took.
    var b = document.createElement('button');
    b.textContent = 'Copy';
    document.body.appendChild(b);
    try {
        _copyFlash(b);
        _copyFlash(b);              // the impatient second click
        return b._cfWas === 'Copy' ||
            'the button would be restored to "' + b._cfWas + '" instead of "Copy"';
    } finally { b.remove(); }
});

// ---------------------------------------------------------------------------
// THE DROPDOWN THAT PAINTED OVER ITS NEIGHBOUR
// ---------------------------------------------------------------------------

function _cfExpenseRow(width) {
    var wrap = document.createElement('div');
    wrap.id = 'expensesModal';
    wrap.style.cssText = 'position:absolute;left:0;top:0;width:' + width + 'px;';
    wrap.innerHTML = _expExpenseAddHtml();
    document.body.appendChild(wrap);
    // The harness has no server, so the category list is empty and the face shows
    // only the placeholder -- which fits, and hides the bug completely. Real
    // categories are what make it visible, so put real-length ones in.
    var sel = wrap.querySelector('#exp-e-cat');
    ['Shipping & Packaging Supplies', 'Meals and Entertainment', 'Office'].forEach(function (tx) {
        var o = document.createElement('option');
        o.value = tx; o.textContent = tx;
        sel.appendChild(o);
    });
    sel.value = 'Shipping & Packaging Supplies';
    _ddScan(wrap);
    return wrap;
}

t('the Category face stays inside its own field', function () {
    var out = [];
    [880, 760, 620].forEach(function (w) {
        var wrap = _cfExpenseRow(w);
        try {
            var lab = wrap.querySelector('#exp-e-cat').closest('label');
            var btn = wrap.querySelector('.dd-btn');
            var desc = wrap.querySelector('label.wide');
            var b = btn.getBoundingClientRect();
            var l = lab.getBoundingClientRect();
            var d = desc.getBoundingClientRect();
            if (b.right > l.right + 0.5) {
                out.push(w + 'px: face is ' + Math.round(b.width) + 'px in a ' +
                         Math.round(l.width) + 'px field');
            }
            if (b.right > d.left + 0.5) {
                out.push(w + 'px: face covers ' + Math.round(b.right - d.left) +
                         'px of the Description input');
            }
        } finally { wrap.remove(); }
    });
    return !out.length || out.join('; ');
});

t('the squeezed value ellipsises and keeps its tooltip', function () {
    // Clamping the face is only half an answer -- the value still has to be
    // readable somehow, which is what the title on .dd-cur is for.
    var wrap = _cfExpenseRow(880);
    try {
        var cur = wrap.querySelector('.dd-cur');
        if (cur.scrollWidth <= cur.clientWidth) {
            return 'the text is not being ellipsised, so the face is still full width';
        }
        return cur.title === 'Shipping & Packaging Supplies' ||
            'the full value is not on the tooltip (title="' + cur.title + '")';
    } finally { wrap.remove(); }
});

t('the clamp is opt-in, and the cyclic case is still opted out', function () {
    // .hub-select-wrap is CONTENT-sized. A percentage min-width there is the
    // cyclic case browsers resolve as indefinite, which can collapse the control
    // instead of clamping it -- the feed filter is why the blanket parent clamp
    // was removed in the first place. It must keep its plain px floor.
    var wrap = document.createElement('div');
    wrap.innerHTML = '<div class="hub-select-wrap"><select><option>All updates</option>' +
                     '<option>Announcements</option></select></div>';
    document.body.appendChild(wrap);
    try {
        _ddScan(wrap);
        var dh = wrap.querySelector('.dd-host');
        if (!dh) return 'the select was never enhanced';
        var mw = dh.style.minWidth;
        if (String(mw).indexOf('min(') >= 0) {
            return 'the feed filter got the percentage clamp ("' + mw + '") -- that is ' +
                   'the cyclic case the clamp was deliberately kept away from';
        }
        return /^\d+px$/.test(mw) || 'expected a plain px floor, got "' + mw + '"';
    } finally { wrap.remove(); }
});

t('the B2B pricing sheet keeps the clamp it already had', function () {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;left:0;top:0;width:87px;';
    wrap.innerHTML = '<div class="b2b-pcell"><select><option>Computer</option></select></div>';
    document.body.appendChild(wrap);
    try {
        _ddScan(wrap);
        var dh = wrap.querySelector('.dd-host');
        if (!dh) return 'the select was never enhanced';
        return String(dh.style.minWidth).indexOf('min(') === 0 ||
            'the sheet cell lost its clamp (min-width "' + dh.style.minWidth + '") -- ' +
            'that is the "Apple" reading "pple" bug coming back';
    } finally { wrap.remove(); }
});
