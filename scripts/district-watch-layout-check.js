// DISTRICT WATCH LAYOUT checks — does the tab actually fit, and does it scroll
// where it is supposed to.
//
//   powershell -File scripts/browser-check.ps1 district-watch-layout-check.js
//
// Separate from district-watch-check.js on purpose: that file asserts about an
// HTML string and cannot see a sparkline rendered at zero size, a sentence
// spilling out of its cell, or a table clipped by the card's own radius.
//
// WHY THIS SUITE EXISTS AT ALL. CLAUDE.md records the bug that made the layout
// harness worth having: the Overview cards set `overflow: hidden` to get their
// corner radius, which clipped a five-column table on a phone so the right-hand
// columns were unreachable with NO scrollbar to say so. This tab is a
// four-column table with a 760px min-width living inside exactly that kind of
// card, so it is the same shape of risk.
//
// WHAT "BROKEN" MEANS HERE. Wide things that scroll inside their own wrapper
// are fine — .lv-tbl-scroll exists for that. What must never happen is content
// wider than its frame with nothing scrollable between it and the viewport.

var WIDTHS = [390, 820, 1440];

var PAYLOAD = {
    day: '2026-09-19',
    config: { conv_target: 85, margin_target: 54.5 },
    flags: [
        { store: 'OVL', metric: 'margin', state: 'critical', value: 50.2, target: 54.5,
          sample_n: 91557, shortfall: 3936, streak: 12,
          reason: '50.2% against a 54.5% target — $3,936 of gross profit behind on $91,557 of buying. Margin rose 1.4 pts while conversion fell 3.2 — check they aren’t walking deals. Flagged 12 days running.' },
        { store: 'OVL', metric: 'conversion', state: 'ok', value: 83.3, target: 85,
          sample_n: 204, sample_k: 170, shortfall: 3, streak: 1,
          reason: '83.3% over 12 days, but no day is further below target than its volume explains.' },
        { store: 'WSP', metric: 'conversion', state: 'warn', value: 80.0, target: 85,
          sample_n: 130, sample_k: 104, shortfall: 7, streak: 6,
          reason: '80.0% over 12 days — 7 customers short of target; under target 2 of the last 3 days. Flagged 6 days running.' },
        { store: 'WSP', metric: 'margin', state: 'ok', value: 53.7, target: 54.5,
          sample_n: 36740, shortfall: 283, streak: 1,
          reason: '53.7% against 54.5%, but only $283 of gross profit behind over 12 days.' },
        { store: 'BAL', metric: 'conversion', state: 'ok', value: 85.7, target: 85,
          sample_n: 105, sample_k: 90, shortfall: 0, streak: 1, reason: 'On target — 85.7% over 12 days.' },
        { store: 'BAL', metric: 'margin', state: 'ok', value: 55.1, target: 54.5,
          sample_n: 32206, shortfall: -189, streak: 1, reason: 'On target — 55.1% on $32,206 of buying.' },
        // Listing, added in 0099 — the fifth column. Real content in it, not a
        // dash, or this suite measures a narrower table than the one that ships.
        { store: 'OVL', metric: 'listing', state: 'critical', value: 51.2, target: 100,
          sample_n: 492, sample_k: 252, shortfall: 240, streak: 4,
          reason: '252 listed against 492 the store was staffed for this week — 240 devices short (51.2% of goal), with only 2 days left and room for about 30 of catch-up in them. Flagged 4 days running.' },
        { store: 'WSP', metric: 'listing', state: 'warn', value: 78.4, target: 100,
          sample_n: 310, sample_k: 243, shortfall: 67, streak: 2,
          reason: '243 listed against 310 the store was staffed for this week — 67 devices short (78.4% of goal), 3 days left to make it up.' },
        { store: 'BAL', metric: 'listing', state: 'ok', value: 123.2, target: 100,
          sample_n: 289, sample_k: 356, shortfall: -67, streak: 1,
          reason: 'Cleared the staffed goal — 356 listed against 289 set (123.2%).' }
    ],
    series: (function () {
        var out = [];
        ['OVL', 'WSP', 'BAL'].forEach(function (s) {
            for (var i = 0; i < 12; i++) {
                out.push({ store: s, date: '2026-09-' + String(i + 7).padStart(2, '0'),
                           cust_conv_den: 18, cust_conv_num: 14 + (i % 4),
                           est_value: 5000, total_spent: 2400, devices_lost: 1, no_deal_customers: 1 });
            }
        });
        return out;
    })(),
    // Real MTD rows, so the cells measured here carry both figures — an empty
    // month renders a dash and would measure a narrower cell than ships.
    mtd: [
        { store: 'OVL', cust_conv_num: 390, cust_conv_den: 500, est_value: 126302, total_spent: 62014 },
        { store: 'WSP', cust_conv_num: 255, cust_conv_den: 300, est_value: 51262, total_spent: 23760 },
        { store: 'BAL', cust_conv_num: 171, cust_conv_den: 200, est_value: 47055, total_spent: 20845 }
    ]
};

// Stage the panel inside the chrome it really lives in — .cc-panel in .cc-body
// in the card — so the card's own overflow and padding are part of the measure.
// Measuring the table on a bare div would prove nothing about the bug this
// suite exists to catch.
function stage(width) {
    var host = document.getElementById('layout-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'layout-host';
        document.body.appendChild(host);
    }
    host.style.cssText = 'width:' + width + 'px;overflow:hidden;';
    _dcWatch = PAYLOAD;
    host.innerHTML =
        '<div class="card ew-airy cc-widget cc-expanded" id="dcWidgetTest">' +
          '<div class="cc-body">' +
            '<div class="cc-panel cc-active" id="dc-panel-watch-test">' +
              '<div id="dc-watch-body-test">' + _dcWatchHtml() + '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
    void host.offsetHeight;
    return host;
}

// Anything wider than the frame with no scrollable ancestor between it and the
// frame. Copied in spirit from b2b-layout-check.js so the two suites agree on
// what counts as broken.
function overflowing(host) {
    var bad = [];
    var limit = host.clientWidth;
    host.querySelectorAll('*').forEach(function (el) {
        var style = getComputedStyle(el);
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') return;
        if (el.getBoundingClientRect().width > limit + 1) {
            var parent = el.parentElement, scrollable = false;
            while (parent && parent !== host) {
                var ps = getComputedStyle(parent);
                if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') { scrollable = true; break; }
                parent = parent.parentElement;
            }
            if (!scrollable) {
                bad.push((el.className || el.tagName) + ' @' +
                    Math.round(el.getBoundingClientRect().width) + 'px');
            }
        }
    });
    return bad;
}

// The painted extent of a flex container's children. A flex container is as
// wide as its cell no matter where its children sit, so every question about
// where something actually APPEARS has to be asked of the children.
function inkBox(box) {
    var kids = Array.prototype.slice.call(box.children);
    if (!kids.length) return null;
    var left = Infinity, right = -Infinity;
    kids.forEach(function (k) {
        var r = k.getBoundingClientRect();
        if (r.width < 1) return;
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
    });
    return left === Infinity ? null : { left: left, right: right, width: right - left };
}

WIDTHS.forEach(function (w) {
    t('nothing overflows its frame at ' + w + 'px', function () {
        var host = stage(w);
        var bad = overflowing(host);
        return bad.length === 0 || 'overflowing: ' + bad.join(' | ');
    });
});

t('the wide table scrolls inside its own wrapper, not the page', function () {
    var host = stage(390);
    var wrap = host.querySelector('.lv-tbl-scroll');
    if (!wrap) return 'no .lv-tbl-scroll wrapper — the table has nothing to scroll inside';
    var ox = getComputedStyle(wrap).overflowX;
    if (ox !== 'auto' && ox !== 'scroll') return '.lv-tbl-scroll overflow-x is ' + ox;
    // The bug this guards: a wrapper that scrolls but is itself clipped by an
    // ancestor's overflow:hidden is no better than no wrapper at all.
    var table = wrap.querySelector('table');
    if (!table) return 'no table inside the wrapper';
    return table.getBoundingClientRect().width >= wrap.clientWidth
        || 'the table is narrower than its scroller — nothing to prove here, check the fixture';
});

t('every sparkline renders at a real size', function () {
    var host = stage(1440);
    var sparks = host.querySelectorAll('.dcw-spark');
    if (!sparks.length) return 'no sparklines rendered at all';
    var zero = [];
    sparks.forEach(function (s, i) {
        var r = s.getBoundingClientRect();
        if (r.width < 20 || r.height < 10) zero.push('#' + i + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    });
    return zero.length === 0 || 'collapsed sparklines: ' + zero.join(', ');
});

t('the label-and-figure cell may wrap rather than spill into Status', function () {
    // The store column is 15% — ~138px at the table's 920px minimum, less
    // than a label plus a figure. nowrap there would push the figure across
    // the column line and under the Status tag.
    var host = stage(820);
    var cells = host.querySelectorAll('.dcw-lc');
    if (!cells.length) return 'no label cells rendered';
    var bad = [];
    cells.forEach(function (c) {
        if (getComputedStyle(c).whiteSpace === 'nowrap') bad.push(c.textContent.slice(0, 30));
    });
    return bad.length === 0 || 'set nowrap: ' + bad.join(' | ');
});

t('the phrase and its day count fit their cell at tablet width', function () {
    var host = stage(820);
    var bad = [];
    host.querySelectorAll('td.dcw-wc').forEach(function (td) {
        var r = document.createRange();
        r.selectNodeContents(td);
        var t = r.getBoundingClientRect(), c = td.getBoundingClientRect();
        if (t.left < c.left - 1 || t.right > c.right + 1) bad.push(td.textContent.trim());
    });
    return bad.length === 0 || 'spills out of its cell: ' + bad.join(' | ');
});

t('the caption line does not collide with itself at phone width', function () {
    var host = stage(390);
    var cap = host.querySelector('.dcw-cap');
    if (!cap) return 'no caption rendered';
    var l = host.querySelector('.dcw-cap-l'), r = host.querySelector('.dcw-cap-r');
    if (!l || !r) return 'caption halves missing';
    var lr = l.getBoundingClientRect(), rr = r.getBoundingClientRect();
    // At 390 they are expected to wrap onto two lines rather than overlap.
    var sameLine = Math.abs(lr.top - rr.top) < 2;
    return (!sameLine || lr.right <= rr.left + 1)
        || 'the two halves of the caption overlap on one line';
});

t('the metric figure and its shortfall are both visible, not clipped', function () {
    var host = stage(820);
    var bad = [];
    host.querySelectorAll('.dcw-val, .dcw-sub').forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) bad.push(el.className + ' "' + el.textContent.trim() + '"');
    });
    return bad.length === 0 || 'collapsed to zero: ' + bad.join(', ');
});

t('every row\u2019s figure block starts at the same x in each metric column', function () {
    // Ethan, 2026-09-21: "align everything better in the 3 right columns".
    // Each block is fixed-width, so centring it puts every row's block at one
    // x — but only while nothing inside it varies in width. This is the test
    // that notices if something does: an inline arrow, a longer label, a
    // figure that wraps.
    var host = stage(1440);
    var rows = host.querySelectorAll('tbody.dc-grp > tr.dc-clickable');
    if (rows.length < 2) return 'need two store rows to compare';
    var bad = [];
    [2, 3, 4].forEach(function (col) {
        var xs = [];
        rows.forEach(function (r) {
            var b = r.children[col] && r.children[col].querySelector('.dcw-pair');
            if (b) xs.push(b.getBoundingClientRect().left);
        });
        if (xs.length < 2) return;
        var spread = Math.max.apply(null, xs) - Math.min.apply(null, xs);
        if (spread > 1) bad.push('column ' + col + ' blocks start ' + Math.round(spread) + 'px apart');
    });
    return bad.length === 0 || bad.join('; ');
});

t('the top and bottom figures in a block share a right edge', function () {
    // So the % signs stack, arrow or no arrow.
    var host = stage(1440);
    var bad = [];
    host.querySelectorAll('.dcw-pair').forEach(function (b) {
        var top = b.children[0].getBoundingClientRect(), bot = b.children[3].getBoundingClientRect();
        if (Math.abs(top.right - bot.right) > 1) {
            bad.push(b.children[0].textContent + ' / ' + b.children[3].textContent);
        }
    });
    return bad.length === 0 || 'ragged: ' + bad.join(', ');
});

t('each metric sits centred under the header that names it', function () {
    // Ethan, 2026-09-21: the figures were hugging the left edge of their columns
    // while the headers sat centred, which read as though the numbers belonged
    // to the column on their left. .lv-tbl centres every th and td, but
    // .dcw-metric is a flex row and text-align cannot reach a flex child — so
    // this is only true while justify-content:center is on it. A string
    // assertion cannot see any of that.
    var host = stage(1440);
    var row = host.querySelector('tbody.dc-grp > tr.dc-clickable');
    if (!row) return 'no store row rendered';
    var ths = host.querySelectorAll('thead th');
    var bad = [];
    [2, 3, 4].forEach(function (i) {
        var cell = row.children[i];
        var box = cell && cell.querySelector('.dcw-metric');
        if (!box) return;                       // an em-dash cell, nothing to centre
        // MEASURE THE CHILDREN, NOT THE FLEX BOX. .dcw-metric is a block-level
        // flex container, so it fills the cell whatever justify-content says —
        // comparing its centre to the cell's would pass with the figures
        // hard against the left edge, which is the bug this test exists for.
        var ink = inkBox(box);
        if (!ink) return;
        var c = cell.getBoundingClientRect();
        var off = Math.abs((c.left + c.width / 2) - (ink.left + ink.width / 2));
        if (off > 6) bad.push('col ' + i + ' figure is ' + Math.round(off) + 'px off its cell centre');
        var h = ths[i].getBoundingClientRect();
        var hoff = Math.abs((h.left + h.width / 2) - (ink.left + ink.width / 2));
        if (hoff > 8) bad.push('col ' + i + ' figure is ' + Math.round(hoff) + 'px off its HEADER centre');
    });
    return bad.length === 0 || bad.join('; ');
});

t('the why phrases start at one x, inside the Status column', function () {
    // Ethan, 2026-09-21: first "center the wordings with the ... tags", then,
    // having seen it, "left align the text to the column". Every phrase must
    // start at the same x, and that x must be inside the Status column — not
    // hanging off the Store column to its left. Measured on the text itself
    // (a Range), not on the span or cell, which fill their tracks whatever
    // the alignment says.
    var host = stage(1440);
    var th = host.querySelectorAll('thead th')[1].getBoundingClientRect();
    var lefts = [];
    host.querySelectorAll('.dcw-why').forEach(function (w) {
        if (!w.textContent) return;   // a clear metric is blank, by request
        var r = document.createRange();
        r.selectNodeContents(w);
        lefts.push(r.getBoundingClientRect().left);
    });
    if (!lefts.length) return 'no phrases rendered';
    var lo = Math.min.apply(null, lefts), hi = Math.max.apply(null, lefts);
    if (hi - lo > 1) return 'the phrases start at different x: ' + Math.round(lo) + '..' + Math.round(hi);
    return (lo >= th.left && lo <= th.left + 20)
        || 'phrases start at ' + Math.round(lo) + ', Status column starts at ' + Math.round(th.left);
});

t('each flagged line says how many days, in words', function () {
    var host = stage(1440);
    var ages = host.querySelectorAll('.dcw-age');
    if (!ages.length) return 'no day counts rendered on a board with flagged metrics';
    var bad = [];
    ages.forEach(function (a) {
        if (!/(\d+\+? days in a row|yesterday)$/.test(a.textContent.trim())) bad.push(a.textContent.trim());
    });
    return bad.length === 0 || 'not written as days: ' + bad.join(', ');
});

t('no phrase wraps onto a second line', function () {
    var host = stage(1440);
    var bad = [];
    host.querySelectorAll('td.dcw-wc').forEach(function (td) {
        var r = document.createRange();
        r.selectNodeContents(td);
        if (r.getClientRects().length > 1 && r.getBoundingClientRect().height > 22) {
            bad.push(td.textContent.trim());
        }
    });
    return bad.length === 0 || 'wrapped: ' + bad.join(' | ');
});

t('every why phrase starts with a capital', function () {
    var host = stage(1440);
    var bad = [];
    host.querySelectorAll('.dcw-why').forEach(function (w) {
        var t = (w.firstChild && w.firstChild.textContent || '').trim();
        if (t && t[0] !== t[0].toUpperCase()) bad.push(t);
    });
    return bad.length === 0 || 'lower-case: ' + bad.join(', ');
});

t('the reason sentences stop before the metric columns', function () {
    // The other half of the same complaint: the sentence row is a colspan
    // across all five columns, so without a cap a long sentence runs the whole
    // table width and finishes underneath the figures it is explaining.
    var host = stage(1440);
    var notes = host.querySelectorAll('.dcw-note .dcw-lc, .dcw-note .dcw-wc');
    if (!notes.length) return 'no glance lines rendered';
    var right = 0;
    notes.forEach(function (n) {
        var r = document.createRange();
        r.selectNodeContents(n);
        right = Math.max(right, r.getBoundingClientRect().right);
    });
    var box = host.querySelector('.dcw-metric');
    if (!box) return 'no metric cell to measure against';
    var ink = inkBox(box);
    if (!ink) return 'the first metric cell has no visible content';
    return right <= ink.left + 1
        || 'a sentence runs ' + Math.round(right - ink.left) + 'px past the first figure';
});

t('the panel stays short enough not to stretch every other district tab', function () {
    // Every dc panel shares one grid cell and is toggled by opacity, so the
    // card reserves the height of the TALLEST tab — a long Matrix panel makes
    // Live tall too.
    //
    // MEASURED ON FIVE STORES, not the three in the fixture above, because the
    // board always renders a sentence for every store and every metric whether
    // it is flagged or not: fifteen sentences, every single morning. A
    // three-store fixture measures 60% of the real panel and let a 620px
    // tripwire sit here looking satisfied while the live board ran at 737px.
    //
    // The sentence lengths are the real ones: 2026-09-21's board averaged 81
    // characters and its longest was 187, so that is what this pads to. The
    // number to beat was measured the same day — 870px with .dcw-notes capped
    // at 32%. If this fires, move the sentences behind the row click; do not
    // widen the prose back over the figures.
    var LONG = '50.2% over 12 days \u2014 $2,562 of gross profit behind on $91,557 of buying; '
        + 'under 53.0% on 2 of the last 3 buying days. Flagged 13 days running.';
    var keep = PAYLOAD.flags;
    PAYLOAD.flags = [];
    ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'].forEach(function (st) {
        ['conversion', 'margin', 'listing'].forEach(function (m) {
            PAYLOAD.flags.push({ store: st, metric: m, state: 'warn', value: 50.2, target: 53,
                sample_n: 91557, sample_k: 170, shortfall: 2562, streak: 13, reason: LONG });
        });
    });
    var h;
    try {
        var host = stage(1440);
        var panel = host.querySelector('.cc-panel');
        if (!panel) return 'panel not rendered';
        h = panel.getBoundingClientRect().height;
    } finally {
        PAYLOAD.flags = keep;
    }
    return h <= 1000 || 'the Matrix panel is ' + Math.round(h) + 'px tall on a full board; '
        + 'it stretches every other tab';
});
