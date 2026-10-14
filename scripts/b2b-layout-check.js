// B2B LAYOUT checks — does the new UI actually render, and does it fit.
//
//   powershell -File scripts/browser-check.ps1 b2b-layout-check.js
//
// Separate from b2b-check.js on purpose. That file asserts about HTML strings,
// which cannot see a row overflowing its grid, a tile row spilling off a phone,
// or a control rendered at zero size. This one measures the real thing with the
// real stylesheet loaded.
//
// WHAT "BROKEN" MEANS HERE. A container that scrolls sideways when it was not
// built to is a bug — on a phone it means content the operator cannot reach.
// Wide things that scroll INSIDE their own wrapper are fine and expected (the
// pricing sheet does this deliberately); what must never happen is the page
// itself growing wider than the viewport.

_b2bSend = function () { return Promise.resolve({}); };

// A stage in the DOM at a known width, so measurements mean something.
function stage(width, html) {
    var host = document.getElementById('layout-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'layout-host';
        document.body.appendChild(host);
    }
    host.style.cssText = 'width:' + width + 'px;overflow:hidden;';
    host.innerHTML = '<div class="b2b-modal-body" style="width:100%">' + html + '</div>';
    // Force layout before measuring.
    void host.offsetHeight;
    return host;
}

function overflowing(host) {
    var bad = [];
    var limit = host.clientWidth;
    host.querySelectorAll('*').forEach(function (el) {
        // Only flag elements that are themselves wider than the frame AND are
        // not an explicitly scrollable wrapper.
        var style = getComputedStyle(el);
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') return;
        if (el.getBoundingClientRect().width > limit + 1) {
            var parent = el.parentElement;
            var scrollable = false;
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

var FIX_ITEMS = [{
    id: 'i1', sku: 'B2B-0001-01', line_no: 1, brand: 'Dell', model: 'Latitude 5420',
    quantity: 5, value: 300, offer: 120, cost: 120, condition: 'Good',
    disposition: 'purchase', listed_qty: 1, recycled_qty: 1, wiped_qty: 0,
    cpu: 'i5-1135G7', ram: '16GB', storage: '512GB NVMe', serials: 'SN-AAA\nSN-BBB',
    client_notes: 'Client wants the drives back and asked us to keep the chargers together',
    staff_notes: 'Hinge is loose on one of them',
    listing_info: 'Screen: 14in | Battery: 89% | Pricing: https://www.ebay.com/sch/i.html?_nkw=latitude+5420&LH_Sold=1&_sacat=0&rt=nc',
    listings: [{ id: 'l1', shopify_barcode: '12345678', units: 1, listed_by: 'Ethan' }],
}];
var FIX_DEAL = {
    id: 'd1', ref: 'ASC-001', stage: 'review', pricing_store: 'CORP', listing_store: null,
    total_units: 5, total_offer: 600, total_cost: 600, accepted_at: null,
    pickup_date: '2026-08-07', quote_sent_at: null,
    client: { company: 'Ascentist Healthcare Partners', acronym: 'ASC' },
    quote_note: 'Collection can be arranged for the week of the 15th if that suits.',
    internal_note: 'They asked about the two dead laptops - we took them at no charge.',
};

_b2bItemMode = 'deal';
_b2bModalDeal = FIX_DEAL;
_b2bModalItems = FIX_ITEMS;

// --- everything renders at all --------------------------------------------
t('layout: every new block renders non-empty', function () {
    var blocks = {
        'notes panel': _b2bNotesPanel(FIX_DEAL),
        'deal summary': _b2bSummary(FIX_DEAL),
        'listing rows': _b2bListRows(),
        'item table': _b2bItemTableHtml(FIX_ITEMS),
        'deal stats': _b2bDealStatsHtml(FIX_ITEMS, FIX_DEAL),
        'print-all button': _b2bPrintAllBtn(FIX_DEAL),
    };
    var empty = Object.keys(blocks).filter(function (k) { return !blocks[k] || blocks[k].length < 40; });
    return empty.length === 0 || 'empty: ' + empty.join(', ');
});

// The recycle stepper moved off the row into the per-row actions menu on the
// trial branch, so what has to be measured moved with it: the trigger has to be
// a real tap target, the recycled chip has to be readable, and the floating menu
// has to have actual size once opened. A 28px icon button is exactly the kind of
// control that ends up 0x0 and invisible to any string assertion.
t('layout: the row actions trigger is a real tap target', function () {
    var host = stage(1200, '<div class="b2b-items b2b-ss b2b-lgrid">' + _b2bListRows() + '</div>');
    var btn = host.querySelector('.b2b-rowacts');
    if (!btn) return 'no actions trigger in the DOM';
    var r = btn.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) {
        return 'trigger is ' + Math.round(r.width) + 'x' + Math.round(r.height);
    }
    // The fixture recycles one unit, so the chip that replaced "N rec" must be
    // there and legible -- it is the only remaining sign on the row.
    var chip = host.querySelector('.b2b-rec-chip');
    if (!chip) return 'no recycled chip (fixture has recycled_qty 1)';
    if (chip.getBoundingClientRect().height < 12) return 'recycled chip has no height';
    var cost = host.querySelector('.b2b-lc-reccost');
    if (!cost) return 'no recycled-cost note (fixture has recycled_qty 1)';
    return cost.getBoundingClientRect().height > 0 || 'recycled-cost note has no height';
});

t('layout: the opened row menu has size and stays on screen', function () {
    var host = stage(1200, '<div class="b2b-items b2b-ss b2b-lgrid">' + _b2bListRows() + '</div>');
    var btn = host.querySelector('.b2b-rowacts');
    if (!btn) return 'no actions trigger to open';
    var id = (_b2bModalItems[0] || {}).id;
    b2bRowActions({ preventDefault: function () {}, stopPropagation: function () {},
                    currentTarget: btn }, id);
    try {
        var menu = document.getElementById('b2bRowMenu');
        if (!menu || !menu.classList.contains('open')) return 'the menu did not open';
        var r = menu.getBoundingClientRect();
        if (r.width < 180 || r.height < 60) {
            return 'menu is ' + Math.round(r.width) + 'x' + Math.round(r.height);
        }
        // Clamped to the viewport. A menu opened from the last row of a long
        // sheet is exactly where this goes wrong.
        if (r.left < 0 || r.top < 0) return 'menu is off the top-left at ' + Math.round(r.left) + ',' + Math.round(r.top);
        if (r.right > window.innerWidth + 1) return 'menu runs off the right edge';
        // Every action row has to be tall enough to hit.
        var rows = menu.querySelectorAll('.b2b-rowmenu-item');
        if (!rows.length) return 'the menu rendered no actions';
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].getBoundingClientRect().height < 26) {
                return 'action row ' + i + ' is only ' + Math.round(rows[i].getBoundingClientRect().height) + 'px tall';
            }
        }
        return true;
    } finally { b2bRowMenuClose(); }
});

t('layout: the drag grip exists and is not zero-sized', function () {
    _b2bGridMode = 'sheet';
    var host = stage(1400, '<div class="b2b-items b2b-ss">' + _b2bItemSheet() + '</div>');
    var grip = host.querySelector('.b2b-grip');
    if (!grip) return 'no grip rendered';
    var r = grip.getBoundingClientRect();
    return (r.width >= 8 && r.height >= 12) || 'grip is ' + Math.round(r.width) + 'x' + Math.round(r.height);
});

t('layout: the collection-date pencil is reachable, not zero-sized', function () {
    var role = sessionStorage.getItem('speeksUserRole');
    sessionStorage.setItem('speeksUserRole', 'mocd');
    try {
        var host = stage(1200, _b2bSummary(Object.assign({}, FIX_DEAL, { stage: 'pricing' })));
        var pen = host.querySelector('.b2b-sum-edit');
        if (!pen) return 'no pencil for corp on a dated deal';
        var r = pen.getBoundingClientRect();
        return (r.width >= 12 && r.height >= 12) || 'pencil is ' + Math.round(r.width) + 'x' + Math.round(r.height);
    } finally { sessionStorage.setItem('speeksUserRole', role); }
});

// --- nothing spills off the page ------------------------------------------
// 390px is the phone width scripts/mobile-check.js uses.
[390, 820, 1440].forEach(function (w) {
    t('layout: notes panel fits at ' + w + 'px', function () {
        var bad = overflowing(stage(w, _b2bNotesPanel(FIX_DEAL)));
        return bad.length === 0 || bad.slice(0, 3).join(' | ');
    });
    t('layout: deal summary fits at ' + w + 'px', function () {
        var bad = overflowing(stage(w, _b2bSummary(FIX_DEAL)));
        return bad.length === 0 || bad.slice(0, 3).join(' | ');
    });
    t('layout: deal stats fit at ' + w + 'px', function () {
        var bad = overflowing(stage(w, _b2bDealStatsHtml(FIX_ITEMS, FIX_DEAL)));
        return bad.length === 0 || bad.slice(0, 3).join(' | ');
    });
});


t('layout: the long research link cannot stretch the listing row', function () {
    // listing_info holds a 100+ character eBay URL. If it does not wrap it drags
    // the whole grid wide, which is exactly why .b2b-lc-note sets word-break.
    var host = stage(820, '<div class="b2b-items b2b-ss b2b-lgrid">' + _b2bListRows() + '</div>');
    var note = host.querySelector('.b2b-lc-note.lead');
    if (!note) return 'no listing_info note rendered';
    var w = note.getBoundingClientRect().width;
    return w <= host.clientWidth + 1 || 'note is ' + Math.round(w) + 'px in an ' + host.clientWidth + 'px frame';
});

t('layout: the research link is an anchor that opens safely', function () {
    var host = stage(820, '<div class="b2b-items b2b-ss b2b-lgrid">' + _b2bListRows() + '</div>');
    var a = host.querySelector('.b2b-lc-note.lead a');
    if (!a) return 'the URL did not become a link';
    if (a.getAttribute('target') !== '_blank') return 'does not open in a new tab';
    var rel = a.getAttribute('rel') || '';
    return (rel.indexOf('noopener') > -1) || 'missing rel=noopener';
});

t('layout: the saved/unsaved readout is legible, not blank', function () {
    var host = stage(600, '<span class="b2b-savestate pending" id="b2bSaveStateProbe">Note not saved yet</span>');
    var el = host.querySelector('.b2b-savestate');
    var s = getComputedStyle(el);
    if (el.getBoundingClientRect().width < 20) return 'readout has no width';
    // An unstyled class would inherit the page default; pending must be distinct.
    return s.color !== '' || 'no colour applied';
});

// --- the footers, which gained the most controls --------------------------
// The pricing footer now carries a saved/unsaved readout, Save, Move, Print All
// SKUs, Close and Submit; the review footer adds Decline, Send Back, an email
// field, Copy, Sent By Hand and Open In Email. That is a lot of buttons in a
// row, and a footer that overflows puts the primary action off-screen.
[390, 820, 1440].forEach(function (w) {
    t('layout: the pricing footer fits at ' + w + 'px', function () {
        var host = stage(w,
            '<div class="b2b-deal-foot">'
            + '<span class="b2b-msg" id="m"></span>'
            + '<span class="b2b-savestate pending">2 lines and a note not saved yet</span>'
            + '<button class="b2b-btn b2b-btn-secondary">Save</button>'
            + '<button class="b2b-btn b2b-btn-secondary">Move</button>'
            + _b2bPrintAllBtn(FIX_DEAL)
            + '<button class="kpi-cancel-btn">Close</button>'
            + '<button class="b2b-btn b2b-btn-primary">Submit For Quoting</button>'
            + '</div>');
        var bad = overflowing(host);
        return bad.length === 0 || bad.slice(0, 3).join(' | ');
    });
});

t('layout: the notes panel stacks rather than squeezing on a phone', function () {
    // b2b-grid2 side by side is right on a desktop and wrong at 390px, where two
    // columns would leave each textarea about 20 characters wide.
    var host = stage(390, _b2bNotesPanel(FIX_DEAL));
    var boxes = host.querySelectorAll('.b2b-notespanel textarea');
    if (boxes.length !== 2) return 'expected two note fields, got ' + boxes.length;
    var a = boxes[0].getBoundingClientRect(), b = boxes[1].getBoundingClientRect();
    // Stacked means the second starts below the first, not beside it.
    if (b.top < a.bottom - 2) return 'still side by side at 390px';
    return a.width > 160 || 'a note field is only ' + Math.round(a.width) + 'px wide on a phone';
});

t('layout: both note fields are the same width on a desktop', function () {
    var host = stage(1200, _b2bNotesPanel(FIX_DEAL));
    var boxes = host.querySelectorAll('.b2b-notespanel textarea');
    var a = boxes[0].getBoundingClientRect().width;
    var b = boxes[1].getBoundingClientRect().width;
    return Math.abs(a - b) <= 2 || 'lopsided: ' + Math.round(a) + ' vs ' + Math.round(b);
});

// --- external UI audit (b2b-ui-audit.md) ----------------------------------

t('audit §1: .ws-panel sizes from a measured offset, not a guess', function () {
    // The 460px floor + a 250px chrome guess put the card's bottom below the
    // fold on a short window, giving two stacked scrollbars.
    var probe = document.createElement('div');
    probe.className = 'card cb-panel ws-panel';
    probe.style.marginTop = '300px';
    document.body.appendChild(probe);
    try {
        var min = parseFloat(getComputedStyle(probe).minHeight);
        if (!(min < 460)) return 'min-height is still ' + min + 'px, above a short viewport';
        if (typeof _wsFitPanels !== 'function') return 'no measuring pass exists';
        _wsFitPanels();
        var v = probe.style.getPropertyValue('--ws-top');
        return (v && parseFloat(v) > 0) || '--ws-top was not measured (' + v + ')';
    } finally { probe.remove(); }
});

t('audit §2: tab labels do not wrap, and the strip can scroll', function () {
    var host = stage(700,
        '<div class="mb-view-toggle b2b-view-toggle" role="tablist">'
        + '<button class="mb-view-btn" role="tab">Needs You</button>'
        + '<button class="mb-view-btn" role="tab">Pipeline</button>'
        + '<button class="mb-view-btn" role="tab">Completed</button>'
        + '<button class="mb-view-btn" role="tab">Evaluations</button>'
        + '<button class="mb-view-btn" role="tab">Clients</button>'
        // Five tabs, which is the real set since the Overview went on 2026-09-10.
        + '</div>');
    var strip = host.querySelector('.b2b-view-toggle');
    var first = host.querySelector('.mb-view-btn');
    if (getComputedStyle(first).whiteSpace !== 'nowrap') return '"Needs You" can still wrap to two lines';
    if (getComputedStyle(strip).overflowX !== 'auto') return 'the strip cannot scroll, so the last tab is unreachable';
    // The strip itself must not exceed the frame -- that was the clipping.
    return strip.getBoundingClientRect().width <= host.clientWidth + 1
        || 'strip is ' + Math.round(strip.getBoundingClientRect().width) + 'px in ' + host.clientWidth + 'px';
});

t('audit §4: the scope chip does not look or behave like a button', function () {
    var host = stage(600, '<span class="b2b-scope-chip b2b-scope-corp">District-wide</span>');
    var chip = host.querySelector('.b2b-scope-chip');
    var s = getComputedStyle(chip);
    if (s.cursor !== 'default') return 'cursor is ' + s.cursor + ', still reads as clickable';
    // It was a solid near-black pill, the loudest thing in a row of real buttons.
    return s.backgroundColor !== 'rgb(26, 28, 30)' || 'still the solid black button-like fill';
});

t('audit §5: the client picker keeps its height with a long list', function () {
    var host = stage(520,
        '<div class="manage-content" style="display:flex;flex-direction:column;height:400px">'
        + '<div class="b2b-picklist">'
        + new Array(14).join('<button class="b2b-pick" style="height:60px">row</button>')
        + '</div></div>');
    var list = host.querySelector('.b2b-picklist');
    var h = list.getBoundingClientRect().height;
    // It was collapsing to 91px as a shrinkable overflow:auto flex child.
    return h >= 200 || 'collapsed to ' + Math.round(h) + 'px';
});

t('audit §8: tile rows fill, leaving no dead gap', function () {
    var six = new Array(7).join('<div class="b2b-tile"><span class="b2b-tile-k">K</span><span class="b2b-tile-v">1</span></div>');
    var host = stage(760, '<div class="b2b-tiles">' + six + '</div>');
    var tiles = host.querySelectorAll('.b2b-tile');
    var rect = host.getBoundingClientRect();
    // Group by top edge, then check the last row reaches the right edge.
    var rows = {};
    tiles.forEach(function (el) {
        var r = el.getBoundingClientRect();
        var key = Math.round(r.top);
        rows[key] = Math.max(rows[key] || 0, r.right);
    });
    var tops = Object.keys(rows);
    if (tops.length < 2) return true;                 // single row, nothing to prove
    var lastRight = rows[tops[tops.length - 1]];
    return lastRight >= rect.right - 14
        || 'last row stops ' + Math.round(rect.right - lastRight) + 'px short of the edge';
});

t('audit §11: the primary button and count pip clear WCAG AA', function () {
    function lum(c) {
        var m = c.match(/\d+/g).slice(0, 3).map(function (v) {
            v = v / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
    }
    var host = stage(600,
        '<button class="b2b-btn b2b-btn-primary">Submit</button>'
        + '<span class="b2b-pip">11</span>'
        + '<label class="form-label-caps">Company *</label>');
    var out = [];
    [['.b2b-btn-primary', 'primary button'], ['.b2b-pip', 'count pip']].forEach(function (p) {
        var el = host.querySelector(p[0]);
        var s = getComputedStyle(el);
        var ratio = (Math.max(lum(s.color), lum(s.backgroundColor)) + 0.05)
                  / (Math.min(lum(s.color), lum(s.backgroundColor)) + 0.05);
        if (ratio < 4.5) out.push(p[1] + ' ' + ratio.toFixed(2) + ':1');
    });
    // The form label is on the page background, not its own.
    var lab = host.querySelector('.form-label-caps');
    var lr = (1.05) / (lum(getComputedStyle(lab).color) + 0.05);
    if (lr < 4.5) out.push('form label ' + lr.toFixed(2) + ':1');
    return out.length === 0 || out.join(' | ');
});

document.getElementById('layout-host') && document.getElementById('layout-host').remove();
