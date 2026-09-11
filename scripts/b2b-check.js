// B2B module checks. Run with the Chrome runner (no Node needed):
//
//   powershell -File scripts/browser-check.ps1 b2b-check.js
//
// The runner loads speeks.js and provides t(name, fn): return true to pass, or
// a string saying what went wrong. It also parse-checks the whole file first.
//
// These cover the fixes made against the B2B feedback backlog. Each assertion
// names the backlog item it guards so a future change that regresses one says
// which reported complaint has come back.

// Every save path in this module is fire-and-forget through _b2bSend, and its
// .catch() reports through _b2bSay -- which falls back to alert() when the
// footer element is missing, as it always is here. A blocking dialog never
// returns in headless Chrome, so a real _b2bSend hanging around is not a failed
// assertion, it is a run that produces no output at all.
//
// Stub it ONCE, for the whole file. Stubbing per-test and restoring in a
// `finally` does not work: the send happens in a promise callback, which runs
// after the finally has already put the real function back.
// Captured BEFORE the stub replaces it, so a check can still assert about what
// the real _b2bSend does. Without this, `_b2bSend.toString()` reads the stub
// below and any assertion about the real request body silently describes the
// harness instead of the app.
var B2B_REAL_SEND = _b2bSend;

// SOURCE WITH THE COMMENTS TAKEN OUT. Use this, not fn.toString(), whenever a
// check searches source for a word rather than for syntax.
//
// Three checks in this file have now failed against working code because the
// thing they searched for was sitting in the comment that explained it: an
// 'accept=' grep matched "No accept= filter", a 'Not mine' grep matched the note
// saying the button had been removed, and a /secret/i grep matched "a missing
// secret". speeks.js is heavily commented on purpose -- the comments carry the
// reasoning -- so a bare substring search over a function's text is searching
// prose as much as code.
//
// Deliberately crude: strips /* */ and // runs, and does not try to spare a
// comment marker inside a string literal. A check that needs that precision
// should be asserting about behaviour instead.
function _srcOf(fn) {
    return String(fn)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

var B2B_SENT = [];
_b2bSend = function (payload) {
    B2B_SENT.push(payload);
    return Promise.resolve({
        listed_qty: payload && payload.listed_qty,
        recycled_qty: payload && payload.recycled_qty,
    });
};
function b2bSentActions() { return B2B_SENT.map(function (p) { return p && p.action; }); }

// A qty-2 purchase line carrying every note field, one unit already listed
// under a barcode that covers it, plus a recycle line.
function b2bFixtureItems() {
    return [{
        id: 'i1', sku: 'B2B-0001-01', line_no: 1, brand: 'Dell', model: 'Latitude 5420',
        quantity: 2, value: 300, offer: 120, cost: 120, condition: 'Good',
        disposition: 'purchase', listed_qty: 1, recycled_qty: 0, wiped_qty: 0,
        cpu: 'i5-1135G7', ram: '16GB', storage: '512GB NVMe',
        serials: 'SN-AAA\nSN-BBB',
        client_notes: 'Client wants the drives back',
        staff_notes: 'Hinge is loose on one',
        listing_info: 'Screen: 14in | Battery: 89% | Pricing: https://www.ebay.com/sch/i.html?_nkw=latitude+5420&LH_Sold=1',
        listings: [{ id: 'l1', shopify_barcode: '12345678', units: 1, listed_by: 'Ethan' }],
    }, {
        id: 'i2', sku: 'B2B-0001-02', line_no: 2, brand: 'HP', model: 'EliteBook 840',
        quantity: 1, value: 0, offer: 0, cost: 0, disposition: 'recycle',
        listed_qty: 0, recycled_qty: 0, wiped_qty: 0, listings: [],
    }];
}

var B2B_FIXTURE_DEAL = {
    id: 'd1', ref: 'B2B-0001', stage: 'listing_location', pricing_store: 'CORP',
    listing_store: null, total_units: 3, total_cost: 240, accepted_at: '2026-09-01',
    pickup_date: '2026-08-07', client: { company: 'Ascentist' },
};

_b2bItemMode = 'deal';
_b2bModalDeal = B2B_FIXTURE_DEAL;
_b2bModalItems = b2bFixtureItems();

// --- 3.4 pricing notes must reach the listing screen ----------------------
// Ethan, 2026-08-21: "Can't see notes left during pricing when listing." The
// data was always loaded here; _b2bListRows just never rendered it.
var listing = _b2bListRows();
t('3.4 _b2bListRows renders',           function () { return listing.length > 200 || 'suspiciously short: ' + listing.length; });
t('3.4 listing shows listing_info',     function () { return listing.indexOf('Screen: 14in') > -1 || 'missing'; });
t('3.4 listing shows client_notes',     function () { return listing.indexOf('drives back') > -1 || 'missing'; });
t('3.4 listing shows staff_notes',      function () { return listing.indexOf('Hinge is loose') > -1 || 'missing'; });
t('3.4 research URL is clickable',      function () { return /<a href="https:\/\/www\.ebay\.com[^"]*" target="_blank"/.test(listing) || 'not linkified'; });

// listing_info and client_notes are typed by staff and by the bench tool, so
// the escape-then-linkify order in _b2bNoteHtml is load-bearing.
t('3.4 _b2bNoteHtml escapes before linkifying', function () {
    var h = _b2bNoteHtml('<img src=x onerror=alert(1)> and https://ok.example/a?b=1&c=2');
    if (h.indexOf('&lt;img') !== 0) return 'markup not escaped: ' + h;
    if (h.indexOf('<a href="https://ok.example/a?b=1&amp;c=2"') === -1) return 'link not built: ' + h;
    return true;
});

// --- 1.5 value info on the assign-listing-store screen --------------------
// Paul, 2026-09-04 (Ascentist): after approval he could not see the detail to
// get value information until he assigned a store, so he assigned one to see it
// and the check followed the assignment.
var tbl = _b2bItemTableHtml(_b2bModalItems);
t('1.5 _b2bItemTableHtml renders a table', function () { return tbl.indexOf('<table') > -1 || 'no table'; });
t('1.5 table carries the unit cost',       function () { return tbl.indexOf('$120.00') > -1 || 'expected unit $120.00'; });
t('1.5 table carries the line cost',       function () { return tbl.indexOf('$240.00') > -1 || 'expected line $240.00'; });
t('1.5 table handles an empty deal',       function () { return _b2bItemTableHtml([]).indexOf('No line items yet') > -1 || 'no empty state'; });
t('1.5 listloc fetches its line items',    function () {
    // The bug was 'listloc' missing from the fetch lists in b2bOpenDeal, which
    // left _b2bModalItems empty on that screen and so hid every figure.
    var src = b2bOpenDeal.toString();
    var lists = src.match(/\[[^\]]*'listloc'[^\]]*\]/g) || [];
    return lists.length >= 2 || "expected 'listloc' in both the proofs and item fetch lists, found " + lists.length;
});

// --- 3.3 mass-print SKUs --------------------------------------------------
// Haydn, 2026-09-02: "is there a way to mass print skus rn?" The bulk branch in
// b2bPrintLabels already worked; nothing called it without an itemId.
t('3.3 print-all button renders',       function () { return _b2bPrintAllBtn(B2B_FIXTURE_DEAL).indexOf('Print All SKUs') > -1 || 'missing'; });
t('3.3 button counts untagged units',   function () {
    // The count is a pill inside the button now, not "(3)" in the label, and
    // the button keeps its normal secondary treatment -- tinting the whole
    // control amber made it a fourth button style in one footer.
    var r = _b2bPrintAllBtn(B2B_FIXTURE_DEAL);
    if (r.indexOf('b2b-label-todo') > -1) return 'still tinting the whole button amber';
    return /class="b2b-btn-count">3</.test(r)
        || 'expected a count pill of 3 for an unlabelled qty-2 + qty-1 deal, got: ' + r;
});
t('3.3 button hides with no lines',     function () {
    var save = _b2bModalItems; _b2bModalItems = [];
    var r = _b2bPrintAllBtn(B2B_FIXTURE_DEAL); _b2bModalItems = save;
    return r === '' || 'expected nothing, got: ' + r;
});
t('3.3 button goes quiet once tagged',  function () {
    var save = _b2bModalItems;
    _b2bModalItems = [{ id: 'x', sku: 'S1', quantity: 2, label_printed_qty: 2, listings: [] }];
    var r = _b2bPrintAllBtn(B2B_FIXTURE_DEAL); _b2bModalItems = save;
    // No count pill and no amber when there is nothing outstanding.
    return (r.indexOf('>Print All SKUs</button>') > -1 && r.indexOf('b2b-btn-count') === -1)
        || 'got: ' + r;
});

// --- 2.3 a repeated barcode is not an error -------------------------------
// Ethan, 2026-08-21: "I can't put the same barcode twice even though one
// barcode was a quantity of 2 listing." The server and _b2bListUnit both bump
// the existing listing; a client-side check rejected it before either ran.
t('2.3 the rejection is gone from b2bScan', function () {
    return b2bScan.toString().indexOf('already recorded on this line') === -1 || 'still rejects a repeat scan';
});
t('2.3 a repeat scan bumps the listing units', function () {
    var it = {
        id: 'z', sku: 'S', quantity: 2, listed_qty: 1, recycled_qty: 0,
        listings: [{ id: 'l', shopify_barcode: '12345678', units: 1 }],
    };
    var save = _b2bModalItems; _b2bModalItems = [it];
    try { _b2bListUnit(it, '12345678', 1); } catch (e) {}
    _b2bModalItems = save;
    if (it.listings.length !== 1) return 'expected one listing, got ' + it.listings.length;
    if (Number(it.listings[0].units) !== 2) return 'expected units=2, got ' + it.listings[0].units;
    return true;
});

// --- 2.2 print label must not blank the pickup form -----------------------
// Haydn, 2026-08-19: "when pressing print label during the sign pickup process,
// it deleted signing client name and all of the item pickup field."
t('2.2 pickup draft capture is shared, not open-coded', function () {
    if (typeof _b2bCapturePickupDraft !== 'function') return 'helper missing';
    var callers = ['b2bSignHere', 'b2bSkipSign', 'b2bRetakeSign', 'b2bPrintHoldingLabel'];
    var missing = callers.filter(function (fn) {
        return window[fn].toString().indexOf('_b2bCapturePickupDraft') === -1;
    });
    return missing.length === 0 || 'not capturing: ' + missing.join(',');
});
t('2.2 the draft keeps the pickup date', function () {
    // The date was the one required field the draft dropped, so a signing
    // round-trip emptied it and it got re-entered from memory.
    return _b2bCapturePickupDraft.toString().indexOf('b2bPuDate') > -1 || 'date not captured';
});
t('2.2 the pickup screen restores the date', function () {
    return _b2bStagePickup.toString().indexOf('puDate') > -1 || 'date not restored on re-render';
});
t('2.2 capture is a no-op off the pickup screen', function () {
    _b2bPickupDraft = null;
    _b2bCapturePickupDraft('nope');           // no #b2bPuDesc in this harness
    return _b2bPickupDraft === null || 'captured a draft with no form present';
});
t('2.2 holding label reads the form, not just the row', function () {
    var src = b2bPrintHoldingLabel.toString();
    if (src.indexOf('_b2bPickupDraft') === -1) return 'never looks at the live draft';
    if (/\['Released By', deal\.signed_by/.test(src)) return 'still reads only deal.signed_by';
    return true;
});
t('2.2 holding label falls back to the row when off-screen', function () {
    // Called from the queue rather than the pickup screen there is no form, so
    // the persisted values must still print.
    var deal = {
        id: 'hl1', ref: 'B2B-0009', stage: 'pickup', pricing_store: 'LEE',
        signed_by: 'Dana Reyes', pickup_desc: '12 laptops, 2 pallets',
        pickup_date: '2026-08-07', client: { company: 'Loch Lloyd' },
    };
    var captured = null;
    var openSheet = _b2bOpenSheet, tag = _b2bTagSheet, byId = _b2bDealById;
    _b2bOpenSheet = function () {};
    _b2bTagSheet = function (cfg) { captured = cfg; return ''; };
    _b2bDealById = function () { return deal; };
    try { _b2bPickupDraft = null; b2bPrintHoldingLabel('hl1'); }
    finally { _b2bOpenSheet = openSheet; _b2bTagSheet = tag; _b2bDealById = byId; }
    if (!captured) return 'tag sheet never built';
    if (captured.contents !== '12 laptops, 2 pallets') return 'contents: ' + captured.contents;
    var released = (captured.meta || []).filter(function (r) { return r[0] === 'Released By'; })[0];
    return (released && released[1] === 'Dana Reyes') || 'released-by: ' + JSON.stringify(released);
});

// --- 2.1 the serials popup must not lose entries --------------------------
// Haydn via Ethan, 2026-09-02: "Modal for serial numbers on pricing is not
// saving correctly sometimes." Three independent loss paths, one guard each.
t('2.1 sync skips a row whose serials popup is open', function () {
    var src = _b2bSyncOpenDeal.toString();
    if (src.indexOf('_b2bSerialPopId') === -1) return 'no popup guard in the merge';
    // It has to come before the blind-overwrite list, or the guard is decorative.
    var guard = src.indexOf('_b2bSerialPopId');
    var blind = src.indexOf("'serials', 'staff_notes'");
    return (blind === -1 || guard < blind) || 'guard sits after the blind overwrite';
});
t('2.1 the textarea saves on change, not only on close', function () {
    return _b2bSerialPopPaint.toString().indexOf('onchange="b2bItemSave(') > -1 || 'no onchange save';
});
t('2.1 Escape is handled by the popup itself', function () {
    return b2bSerialsOpen.toString().indexOf("'keydown'") > -1 || 'no keydown handler';
});
t('2.1 closeAllModals saves the popup before teardown', function () {
    var src = closeAllModals.toString();
    if (src.indexOf('b2bSerialsClose') === -1) return 'popup never closed on Escape/overlay';
    // Must run before the deal modal's own cleanup, or the save has nothing left.
    return src.indexOf('b2bSerialsClose') < src.indexOf('b2bItemSheet') || 'runs after the sheet teardown';
});
t('2.1 repaint keeps the popup in step', function () {
    return _b2bRepaintItems.toString().indexOf('_b2bSerialPopPaint') > -1 || 'popup not repainted';
});
t('2.1 repaint will not clobber a live cursor', function () {
    return _b2bRepaintItems.toString().indexOf('b2bSerialPopInput') > -1 || 'no activeElement guard';
});
t('2.1 close is idempotent', function () {
    // Escape then overlay-dismiss both fire; the second must not re-save a line
    // that is no longer being edited.
    _b2bSerialPopId = 'ghost';
    b2bSerialsClose();                        // no popup element in this harness
    return _b2bSerialPopId === null || 'left a dangling popup id';
});
t('2.1 submit no longer chases the retired serial selector', function () {
    var src = b2bSubmitPricing.toString();
    // Match the selector being USED, not the word appearing in a comment
    // explaining why it was removed.
    if (/querySelector\([^)]*b2b-rp-serialrow/.test(src)) return 'still queries .b2b-rp-serialrow';
    return src.indexOf('b2bSerialsOpen') > -1 || 'does not open the serials popup either';
});

// --- 2.4 a recycled unit is written off as a loss -------------------------
// Ethan, 2026-08-21: bought 5, recycled 1, split the cost across 4 by hand and
// asked whether the system accounts for it. It did not — recycle_units only
// bumped a counter. Decision: write it off, do not reallocate.
function b2bRecycleFixture(recycled) {
    return [{
        id: 'r1', sku: 'B2B-9-01', quantity: 5, value: 300, offer: 100, cost: 100,
        disposition: 'purchase', listed_qty: 0, recycled_qty: recycled,
        wiped_qty: 0, shipping_cost: 0, listings: [],
    }];
}
var recDeal = { id: 'rd', stage: 'listing', accepted_at: '2026-09-01' };

t('2.4 nothing recycled leaves the figures alone', function () {
    var o = _b2bDealStatRaw(b2bRecycleFixture(0), recDeal);
    if (o.est_value !== 1500) return 'est_value ' + o.est_value + ', expected 1500';
    if (o.cost_purchased !== 500) return 'cost ' + o.cost_purchased + ', expected 500';
    if (o.recycled_cost !== 0) return 'recycled_cost ' + o.recycled_cost + ', expected 0';
    return true;
});
t('2.4 one of five recycled is booked as a loss', function () {
    var o = _b2bDealStatRaw(b2bRecycleFixture(1), recDeal);
    // Resale value drops to the four we can actually sell...
    if (o.est_value !== 1200) return 'est_value ' + o.est_value + ', expected 1200 (4 x 300)';
    // ...but we still paid the client for all five.
    if (o.cost_purchased !== 500) return 'cost ' + o.cost_purchased + ', expected 500 (5 x 100)';
    if (o.recycled_cost !== 100) return 'recycled_cost ' + o.recycled_cost + ', expected 100';
    if (o.recycled_units !== 1) return 'recycled_units ' + o.recycled_units;
    return true;
});
t('2.4 margin absorbs the write-off', function () {
    var a = _b2bDealStatRaw(b2bRecycleFixture(0), recDeal);
    var b = _b2bDealStatRaw(b2bRecycleFixture(1), recDeal);
    var mA = a.est_value - a.cost_purchased - a.total_shipping;
    var mB = b.est_value - b.cost_purchased - b.total_shipping;
    // The whole 300 of lost resale value, not a reallocation that nets to zero.
    return (mA - mB === 300) || 'margin moved by ' + (mA - mB) + ', expected 300';
});
t('2.4 the write-off is shown, not buried', function () {
    var html = _b2bDealStatsInner(b2bRecycleFixture(1), recDeal);
    return html.indexOf('Recycled-Out Cost') > -1 || 'no tile';
});
t('2.4 the tile stays hidden when nothing is recycled', function () {
    return _b2bDealStatsInner(b2bRecycleFixture(0), recDeal).indexOf('Recycled-Out Cost') === -1 || 'tile shown at zero';
});

// --- 3.6 recycle stepper --------------------------------------------------
//
// The stepper itself moved off the row and into the per-row actions menu on the
// trial branch, so these two now open the menu and assert about that. What is
// being protected has not changed: the recycle actions must be reachable from
// the row, and putting one back must be refused when nothing has been recycled.
//
// Opened through b2bRowActions rather than by reading a string, because the menu
// is built at click time from _b2bLocalItem -- so this exercises the same path a
// person does.
function _b2bOpenRowMenu(itemId) {
    var btn = document.createElement('button');
    btn.className = 'b2b-rowacts';
    document.body.appendChild(btn);
    try {
        b2bRowActions({ preventDefault: function () {}, stopPropagation: function () {},
                        currentTarget: btn }, itemId);
        var el = document.getElementById('b2bRowMenu');
        return el ? el.innerHTML : '';
    } finally {
        btn.remove();
        b2bRowMenuClose();
    }
}

t('3.6 the recycle actions are reachable from the listing row', function () {
    var save = _b2bModalItems;
    _b2bModalItems = b2bRecycleFixture(1);
    try {
        var row = _b2bListRows();
        if (row.indexOf('b2bRowActions(') === -1) return 'no way into the actions from the row';
        var menu = _b2bOpenRowMenu('r1');
        if (menu.indexOf('b2bRecycleUnit(') === -1) return 'no recycle-one action';
        if (menu.indexOf('b2bUnRecycleUnit(') === -1) return 'no put-one-back action';
        return menu.indexOf('b2bRecycleUnits(') > -1 || 'no recycle-several action';
    } finally { _b2bModalItems = save; }
});
t('3.6 putting one back is disabled with nothing recycled', function () {
    var save = _b2bModalItems;
    _b2bModalItems = b2bRecycleFixture(0);
    try {
        var menu = _b2bOpenRowMenu('r1');
        // The row is kept and disabled rather than dropped: a menu whose
        // contents move around between lines is harder to use than one where
        // the same thing is always in the same place.
        var at = menu.indexOf('Put one back');
        if (at === -1) return 'the action vanished instead of disabling';
        // Read the button THIS label belongs to, positionally. A regex over the
        // whole menu matched the first .b2b-rowmenu-item instead -- an optional
        // (disabled)? group that never participated, so it reported a live
        // button while the markup said disabled="". The label is the anchor.
        var open = menu.lastIndexOf('<button', at);
        var tagEnd = menu.indexOf('>', open);
        return menu.slice(open, tagEnd).indexOf('disabled') > -1 || 'live at zero recycled';
    } finally { _b2bModalItems = save; }
});
t('3.6 un-recycle refuses to go below zero', function () {
    var it = b2bRecycleFixture(0)[0];
    var save = _b2bModalItems; _b2bModalItems = [it];
    try { b2bUnRecycleUnit('r1'); } catch (e) {}
    _b2bModalItems = save;
    return Number(it.recycled_qty) === 0 || 'went to ' + it.recycled_qty;
});
t('3.6 recycle and un-recycle share one apply path', function () {
    if (typeof _b2bRecycleApply !== 'function') return 'no shared helper';
    var src = _b2bRecycleApply.toString();
    if (src.indexOf("'recycle_units'") === -1) return 'never sends recycle_units';
    if (src.indexOf("'un_recycle'") === -1) return 'never sends un_recycle';
    return true;
});

// --- 3.5 reordering the pricing sheet -------------------------------------
// Haydn, 2026-09-02 ("grabby hands"): the grab conflicted with drag-to-select
// and was hard to aim. Only a dedicated grip drags now, the drop is directional,
// and the row makes way.
t('3.5 only the grip is draggable', function () {
    var save = _b2bModalItems;
    _b2bModalItems = b2bFixtureItems();
    var html = _b2bItemSheet();
    _b2bModalItems = save;
    if (html.indexOf('b2b-grip') === -1) return 'no grip rendered';
    // The SKU cell must no longer carry draggable/dragstart itself.
    var cell = html.match(/<span class="b2b-pcell b2b-pc-sku"[^>]*>/);
    if (!cell) return 'sku cell markup changed shape';
    if (/draggable|ondragstart/.test(cell[0])) return 'sku cell is still draggable: ' + cell[0];
    // Exactly one draggable element per row: the grip.
    var grip = html.match(/<span class="b2b-grip" draggable="true"/g) || [];
    var anyDraggable = html.match(/draggable="true"/g) || [];
    return (grip.length > 0 && grip.length === anyDraggable.length)
        || grip.length + ' grips vs ' + anyDraggable.length + ' draggables';
});
t('3.5 the grip does not start a cell selection', function () {
    return _b2bSelInit.toString().indexOf('b2b-grip') > -1 || 'cell selection still fires on the grip';
});
t('3.5 the whole row is a drop target', function () {
    var save = _b2bModalItems;
    _b2bModalItems = b2bFixtureItems();
    var html = _b2bItemSheet();
    _b2bModalItems = save;
    var line = html.match(/<div class="b2b-pline[^"]*" id="b2bPline-[^"]*"[^>]*>/);
    return (line && /ondragover/.test(line[0])) || 'dragover not on the row: ' + (line && line[0]);
});
t('3.5 drop side is decided by the pointer', function () {
    var src = b2bDragOver.toString();
    if (src.indexOf('getBoundingClientRect') === -1) return 'no geometry check';
    return src.indexOf('clientY') > -1 || 'not using the pointer position';
});
t('3.5 dropping below lands after the target', function () {
    // Guard the index arithmetic, which is the part that silently lands a line
    // one place off. Rebuild the module-level state the handler reads.
    function order(fromId, ontoId, below) {
        _b2bModalItems = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
        _b2bDragId = fromId; _b2bDropId = ontoId; _b2bDropBelow = below;
        // _b2bSend is stubbed once for the whole file (see the top). These two
        // only need silencing because there is no grid here to repaint.
        var paintQ = _b2bPaintQuoteDoc, repaint = _b2bRepaintItems;
        _b2bPaintQuoteDoc = function () {};
        _b2bRepaintItems = function () {};
        try { b2bDrop({ preventDefault: function () {} }, ontoId); }
        finally { _b2bPaintQuoteDoc = paintQ; _b2bRepaintItems = repaint; }
        return _b2bModalItems.map(function (i) { return i.id; }).join('');
    }
    var save = _b2bModalItems;
    try {
        // 'a' onto the underside of 'c' -> a sits after c.
        var r1 = order('a', 'c', true);
        if (r1 !== 'bcad') return 'a below c gave ' + r1 + ', expected bcad';
        // 'd' onto the top of 'b' -> d sits before b.
        var r2 = order('d', 'b', false);
        if (r2 !== 'adbc') return 'd above b gave ' + r2 + ', expected adbc';
        // A no-op drop must not reorder anything.
        var r3 = order('b', 'b', false);
        if (r3 !== 'abcd') return 'self-drop gave ' + r3;
    } finally { _b2bModalItems = save; _b2bDragId = null; _b2bDropId = null; _b2bDropBelow = false; }
    return true;
});

// --- 2.5 nothing typed on the pricing sheet gets thrown away --------------
// Paul, 2026-08-22, asked for an explicit Save. Autosave stays (the live-sync
// merge assumes the server is current), but a focused cell whose `change` never
// fired was genuinely being discarded on Escape / overlay dismiss.
t('2.5 a local edit is tracked as unsaved', function () {
    var save = _b2bModalItems;
    _b2bModalItems = b2bFixtureItems();
    _b2bPendingEdits.clear();
    b2bItemInput('i1', 'model', 'Latitude 5430');
    var n = _b2bPendingCount();
    _b2bModalItems = save; _b2bPendingEdits.clear();
    return n === 1 || 'expected 1 pending, got ' + n;
});
t('2.5 saving clears the pending mark', function () {
    var save = _b2bModalItems;
    _b2bModalItems = b2bFixtureItems();
    _b2bPendingEdits.clear();
    b2bItemInput('i1', 'model', 'Latitude 5430');
    b2bItemSave('i1');
    var n = _b2bPendingCount();
    _b2bModalItems = save; _b2bPendingEdits.clear();
    return n === 0 || 'still ' + n + ' pending after save';
});
t('2.5 flush takes on every outstanding line', function () {
    // Asserted on the pending set, not on B2B_SENT: _b2bEnqueue runs the send in
    // a promise callback, so nothing has actually gone out by the time a
    // synchronous assertion looks. Clearing the mark IS the contract here --
    // b2bItemSave only does it once it has genuinely queued the line.
    var save = _b2bModalItems;
    _b2bModalItems = b2bFixtureItems();
    _b2bPendingEdits.clear();
    b2bItemInput('i1', 'model', 'A');
    b2bItemInput('i2', 'model', 'B');
    if (_b2bPendingCount() !== 2) {
        var bad = _b2bPendingCount();
        _b2bModalItems = save; _b2bPendingEdits.clear();
        return 'expected 2 pending before the flush, got ' + bad;
    }
    _b2bFlushEdits();
    var n = _b2bPendingCount();
    _b2bModalItems = save; _b2bPendingEdits.clear();
    return n === 0 || 'left ' + n + ' pending after the flush';
});
t('2.5 flush drops ids whose line is gone', function () {
    var save = _b2bModalItems;
    _b2bModalItems = [];
    _b2bPendingEdits.clear();
    _b2bPendingEdits.add('vanished');
    B2B_SENT.length = 0;
    _b2bFlushEdits();
    var n = _b2bPendingCount();
    var sent = B2B_SENT.length;
    _b2bModalItems = save; _b2bPendingEdits.clear();
    if (sent !== 0) return 'posted a save for a line that no longer exists';
    return n === 0 || 'left ' + n + ' pending';
});
t('2.5 closeAllModals flushes before teardown', function () {
    var src = closeAllModals.toString();
    if (src.indexOf('_b2bFlushEdits') === -1) return 'no flush on dismiss';
    return src.indexOf('_b2bFlushEdits') < src.indexOf('b2bItemSheet') || 'flushes after the sheet is removed';
});
t('2.5 the footer says whether it is saved', function () {
    var save = _b2bModalItems;
    _b2bModalItems = b2bFixtureItems();
    _b2bPendingEdits.clear();
    // No element in this harness: the painter must simply not throw.
    _b2bPaintSaveState();
    b2bItemInput('i1', 'model', 'X');
    _b2bPaintSaveState();
    var n = _b2bPendingCount();
    _b2bModalItems = save; _b2bPendingEdits.clear();
    return n === 1 || 'tracking broke while painting';
});

// --- 1.6 store managers can see the client directory ----------------------
// Ethan, 2026-09-07: "Store managers are not able to see the clients. Please
// just let them see the clients. side effect of this is they cant select an
// existing client for in store B2B."
//
// These run as a store manager, so they swap the session and put it back.
(function () {
    var role = sessionStorage.getItem('speeksUserRole');
    var store = sessionStorage.getItem('speeksUserStore');
    function asManager(fn) {
        sessionStorage.setItem('speeksUserRole', 'manager');
        sessionStorage.setItem('speeksUserStore', 'LEE');
        try { return fn(); }
        finally {
            sessionStorage.setItem('speeksUserRole', role);
            sessionStorage.setItem('speeksUserStore', store);
        }
    }

    t('1.6 a manager may open the client directory', function () {
        return asManager(function () {
            if (_b2bCanClients()) return 'a manager should NOT get the full CRM';
            return _b2bCanClientDirectory() || 'directory still closed to a manager';
        });
    });
    t('1.6 corp still gets the full CRM', function () {
        // The harness session is MOCD.
        return (_b2bCanClients() && _b2bCanClientDirectory()) || 'corp lost access';
    });
    t('1.6 a store with no store attached is excluded', function () {
        sessionStorage.setItem('speeksUserRole', 'manager');
        sessionStorage.setItem('speeksUserStore', '');
        var can = _b2bCanClientDirectory();
        sessionStorage.setItem('speeksUserRole', role);
        sessionStorage.setItem('speeksUserStore', store);
        return can === false || 'a manager with nowhere to put goods got the directory';
    });
    t('1.6 the store view is a directory, not the CRM', function () {
        var saved = _b2bClients;
        // Exactly what ?clients=1&scope=store returns -- CLIENT_PICK_COLS.
        _b2bClients = [{ id: 'c1', company: 'Ascentist', acronym: 'ASC', deal_count: 3, open_count: 1 }];
        var html = asManager(function () { return _b2bRenderClients(); });
        _b2bClients = saved;
        if (html.indexOf('Ascentist') === -1) return 'client not listed';
        if (html.indexOf('ASC') === -1) return 'acronym not listed';
        // None of the CRM must appear.
        if (/b2bEditClient|b2bDeleteClient|b2bSaveClient/.test(html)) return 'CRM controls leaked into the store view';
        if (html.indexOf('b2bCfCompany') > -1) return 'add/edit form leaked into the store view';
        if (html.indexOf('b2bToggleClient') > -1) return 'expandable outreach drawer leaked';
        if (/<th>Email<\/th>|<th>Phone<\/th>/.test(html)) return 'contact columns leaked';
        return true;
    });
    t('1.6 the store view survives an empty list', function () {
        var saved = _b2bClients;
        _b2bClients = [];
        var html = asManager(function () { return _b2bRenderClients(); });
        _b2bClients = saved;
        return html.indexOf('No clients on record yet') > -1 || 'no empty state';
    });
    t('1.6 corp view still renders its CRM', function () {
        var saved = _b2bClients;
        _b2bClients = [{ id: 'c1', company: 'Ascentist', acronym: 'ASC', contact: 'Dana',
                         contact_email: 'd@a.com', contact_phone: '(816) 555-0142',
                         deal_count: 3, open_count: 1 }];
        var html = _b2bRenderClients();
        _b2bClients = saved;
        if (html.indexOf('b2bCfCompany') === -1) return 'corp lost the add/edit form';
        return html.indexOf('d@a.com') > -1 || 'corp lost the contact details';
    });
    t('1.6 the client fetch asks for the store-scoped list', function () {
        var src = _b2bClientsFetch.toString();
        return src.indexOf('scope=store') > -1 || 'never requests the stripped list';
    });
})();

// --- 3.1 / 1.2 / 1.3 / 1.4 / 3.8 -- the deal-level additions ---------------
var noteDeal = {
    id: 'nd', ref: 'ASC-001', stage: 'review', pricing_store: 'CORP',
    accepted_at: null, pickup_date: '2026-08-19', quote_sent_at: null,
    total_units: 3, client: { company: 'Ascentist', acronym: 'ASC' },
    quote_note: 'Collection can be arranged the week of the 15th.',
    internal_note: 'They asked about the two dead laptops.',
};

t('3.1 the notes panel shows both fields, labelled', function () {
    var html = _b2bNotesPanel(noteDeal);
    if (html.indexOf('b2bQuoteNote') === -1) return 'no client-facing field';
    if (html.indexOf('b2bInternalNote') === -1) return 'no internal field';
    if (html.indexOf('the client sees this') === -1) return 'client field not labelled';
    if (html.indexOf('never leaves the building') === -1) return 'internal field not labelled';
    return true;
});
t('3.1 the panel only appears while the quote is open', function () {
    var closed = ['pickup', 'pricing_location', 'listing', 'completed', 'declined'];
    var leaked = closed.filter(function (s) {
        return _b2bNotesPanel(Object.assign({}, noteDeal, { stage: s })) !== '';
    });
    return leaked.length === 0 || 'panel shown at: ' + leaked.join(',');
});
t('3.1 the client note prints on the quote, the internal one does not', function () {
    var notes = _b2bQuoteFootNotes(b2bFixtureItems(), noteDeal);
    var joined = notes.join(' || ');
    if (joined.indexOf('week of the 15th') === -1) return 'quote_note missing from the foot notes';
    if (joined.indexOf('two dead laptops') > -1) return 'INTERNAL NOTE LEAKED ONTO THE QUOTE';
    // Last, under the standard notes, which is where it was asked for.
    return notes[notes.length - 1].indexOf('week of the 15th') > -1
        || 'quote_note is not the last note';
});
t('3.1 a deal with no note adds nothing', function () {
    var n = _b2bQuoteFootNotes(b2bFixtureItems(), { }).length;
    var m = _b2bQuoteFootNotes(b2bFixtureItems(), noteDeal).length;
    return m === n + 1 || 'expected exactly one extra note, got ' + (m - n);
});
t('3.1 notes are tracked by the save indicator', function () {
    var save = _b2bModalDeal;
    _b2bModalDeal = Object.assign({}, noteDeal);
    _b2bPendingEdits.clear();
    b2bNoteInput('quote_note', 'changed');
    var n = _b2bPendingCount();
    _b2bModalDeal = save; _b2bPendingEdits.clear();
    return n === 1 || 'expected 1 pending, got ' + n;
});

t('1.4 corp gets a pencil on the collection date', function () {
    var role = sessionStorage.getItem('speeksUserRole');
    sessionStorage.setItem('speeksUserRole', 'mocd');
    var corp = _b2bSummary(noteDeal);
    sessionStorage.setItem('speeksUserRole', 'manager');
    sessionStorage.setItem('speeksUserStore', 'LEE');
    var store = _b2bSummary(noteDeal);
    sessionStorage.setItem('speeksUserRole', role);
    sessionStorage.setItem('speeksUserStore', 'CORP');
    if (corp.indexOf('b2bEditPickupDate') === -1) return 'corp has no way to correct it';
    return store.indexOf('b2bEditPickupDate') === -1 || 'a store can rewrite the collection date';
});
t('1.4 a declined deal cannot have its date rewritten', function () {
    return _b2bSummary(Object.assign({}, noteDeal, { stage: 'declined' }))
        .indexOf('b2bEditPickupDate') === -1 || 'editable on a dead deal';
});
t('1.2 the summary shows a sent quote once there is one', function () {
    if (_b2bSummary(noteDeal).indexOf('Quote sent') > -1) return 'shown before it was sent';
    return _b2bSummary(Object.assign({}, noteDeal, { quote_sent_at: '2026-09-03T14:30:00Z' }))
        .indexOf('Quote sent') > -1 || 'not shown after sending';
});

t('3.8 the chip tells awaiting pricing from actively pricing', function () {
    var waiting = _b2bStageChip('pricing', { });
    var started = _b2bStageChip('pricing', { pricing_started_at: '2026-09-07T00:00:00Z' });
    if (waiting.indexOf('Awaiting Pricing') === -1) return 'untouched deal: ' + waiting;
    if (started.indexOf('Awaiting Pricing') > -1) return 'started deal still says awaiting';
    return started.indexOf('Pricing') > -1 || 'started deal: ' + started;
});
t('3.8 opening the pricing sheet stamps it once', function () {
    var src = b2bOpenDeal.toString();
    if (src.indexOf("'start_pricing'") === -1) return 'never fires start_pricing';
    return src.indexOf('pricing_started_at') > -1 || 'fires it even when already stamped';
});


// --- polish pass: bugs found reviewing the above ---------------------------

// Both flush paths clear the pending key, so "cleared" cannot tell a save from
// a silent drop. _b2bEnqueue registers its key in _b2bInFlight synchronously,
// which can -- and unlike B2B_SENT it is readable before the promise callback
// that actually posts runs.
t('polish: an unsaved note is queued, not silently dropped', function () {
    // The first version routed on whether _b2bLocalItem() found the key, which
    // DELETED every notes key without saving -- a deal id is not an item id.
    var saveDeal = _b2bModalDeal, saveItems = _b2bModalItems;
    _b2bModalDeal = { id: 'nd2', quote_note: 'typed', internal_note: '' };
    _b2bModalItems = [];
    _b2bPendingEdits.clear();
    _b2bDirty = false;
    _b2bInFlight.delete(_B2B_NOTES_KEY + 'nd2');
    _b2bPendingEdits.add(_B2B_NOTES_KEY + 'nd2');
    _b2bFlushEdits();
    var queued = _b2bInFlight.has(_B2B_NOTES_KEY + 'nd2');
    var dirty = _b2bDirty;
    var left = _b2bPendingCount();
    _b2bModalDeal = saveDeal; _b2bModalItems = saveItems; _b2bPendingEdits.clear();
    if (!queued) return 'the note was never queued for saving';
    if (!dirty) return 'the board was not marked dirty, so no refresh would follow';
    return left === 0 || 'left ' + left + ' pending';
});
t('polish: a note whose deal has closed is dropped, not posted stale', function () {
    var saveDeal = _b2bModalDeal;
    _b2bModalDeal = { id: 'somethingelse' };
    _b2bPendingEdits.clear();
    _b2bInFlight.delete(_B2B_NOTES_KEY + 'gone');
    _b2bPendingEdits.add(_B2B_NOTES_KEY + 'gone');
    _b2bFlushEdits();
    var queued = _b2bInFlight.has(_B2B_NOTES_KEY + 'gone');
    var left = _b2bPendingCount();
    _b2bModalDeal = saveDeal; _b2bPendingEdits.clear();
    if (queued) return 'queued a note for a deal that is not open';
    return left === 0 || 'left ' + left + ' pending';
});
t('polish: the note payload carries both fields', function () {
    // Asserted on the source rather than on a posted body, since the post
    // happens in a promise callback the harness cannot wait for.
    var src = b2bSaveNotes.toString();
    if (src.indexOf("action: 'set_notes'") === -1) return 'wrong action';
    if (src.indexOf('quote_note') === -1) return 'quote_note not sent';
    return src.indexOf('internal_note') > -1 || 'internal_note not sent';
});
t('polish: the flush blurs the notes panel too', function () {
    // Its textarea is on the modal, not inside .b2b-items, so it has to be
    // named in the selector or `change` never fires on the way out.
    return _b2bFlushEdits.toString().indexOf('b2b-notespanel') > -1
        || 'notes panel not in the blur selector';
});
t('polish: the readout names notes as notes, not lines', function () {
    var el = document.createElement('span');
    el.id = 'b2bSaveState';
    document.body.appendChild(el);
    try {
        _b2bPendingEdits.clear();
        _b2bPendingEdits.add(_B2B_NOTES_KEY + 'x');
        _b2bPaintSaveState();
        if (el.textContent.indexOf('line') > -1) return 'called a note a line: ' + el.textContent;
        if (el.textContent.indexOf('Note') === -1) return 'does not mention a note: ' + el.textContent;
        _b2bPendingEdits.add('itemid');
        _b2bPaintSaveState();
        if (el.textContent.indexOf('1 line') === -1) return 'mixed case wrong: ' + el.textContent;
        _b2bPendingEdits.clear();
        _b2bPaintSaveState();
        return el.textContent === 'All changes saved' || 'clean state: ' + el.textContent;
    } finally { el.remove(); _b2bPendingEdits.clear(); }
});
t('polish: the pricer can reach the notes panel', function () {
    // Haydn asked for these and Haydn prices. Putting them only on the approval
    // screen would leave the person who wanted them unable to reach them.
    var screens = [_b2bStagePricing, _b2bStageReview, _b2bStageQuote];
    var missing = screens.filter(function (f) {
        return f.toString().indexOf('_b2bNotesPanel') === -1;
    });
    return missing.length === 0 || missing.length + ' stage screen(s) have no notes panel';
});
t('polish: no pencil on the pickup screen or an undated deal', function () {
    var role = sessionStorage.getItem('speeksUserRole');
    sessionStorage.setItem('speeksUserRole', 'mocd');
    try {
        var atPickup = _b2bSummary({ id: 'p', ref: 'P-1', stage: 'pickup',
            pickup_date: '2026-08-07', client: {} });
        var undated = _b2bSummary({ id: 'p', ref: 'P-1', stage: 'pricing',
            pickup_date: null, client: {} });
        var normal = _b2bSummary({ id: 'p', ref: 'P-1', stage: 'pricing',
            pickup_date: '2026-08-07', client: {} });
        if (atPickup.indexOf('b2bEditPickupDate') > -1) return 'pencil on the sign-off screen';
        if (undated.indexOf('b2bEditPickupDate') > -1) return 'pencil beside "Not yet"';
        return normal.indexOf('b2bEditPickupDate') > -1 || 'pencil missing where it belongs';
    } finally { sessionStorage.setItem('speeksUserRole', role); }
});
t('polish: one name for the send-by-hand action', function () {
    var src = _b2bStageReview.toString() + _b2bStageQuote.toString();
    if (src.indexOf('I Sent It Myself') > -1) return 'two labels for one action';
    return (src.match(/Sent By Hand/g) || []).length >= 2 || 'not offered on both screens';
});

// --- v3.8.1: approvals open to all corp, and Copy is a complete send --------
// Nick, 2026-09-08: "The B2B Approvals are limited to just paul... I do not
// like the current work flow of it forcing you to open your email."

t('3.8.1 approving follows corp access, delegation included', function () {
    // It was role-only, which meant a lent corp hat could see a deal and open
    // it but not approve it -- so approvals queued behind named individuals.
    var src = _b2bCanAccept.toString();
    if (src.indexOf('B2B_ACCEPT_ROLES') > -1) return 'still gated on the narrow role list';
    return src.indexOf('_b2bIsCorp') > -1 || 'not gated on corp access: ' + src;
});
t('3.8.1 a delegated corp user may approve', function () {
    var role = sessionStorage.getItem('speeksUserRole');
    var realOverride = window._featureOverrideFor;
    sessionStorage.setItem('speeksUserRole', 'manager');
    try {
        window._featureOverrideFor = function () { return false; };
        if (_b2bCanAccept()) return 'a plain manager can approve';
        window._featureOverrideFor = function (cap) { return cap === 'cap-b2b-corp'; };
        return _b2bCanAccept() || 'a manager lent the corp hat still cannot approve';
    } finally {
        window._featureOverrideFor = realOverride;
        sessionStorage.setItem('speeksUserRole', role);
    }
});
t('3.8.1 the delegation flag reaches the server', function () {
    // The server gate cannot honour a lent hat it is never told about, and
    // _b2bSend is the one place every call passes through. Asserted against the
    // pre-stub capture: the stub at the top of this file is what every other
    // check needs, and reading it here would test the harness, not the app.
    return B2B_REAL_SEND.toString().indexOf('corp_delegated') > -1
        || 'corp_delegated is not sent with requests';
});

t('3.8.1 copying an unsent quote records the send', function () {
    var src = b2bCopyQuote.toString();
    if (src.indexOf("'send_quote'") === -1) return 'copy never records a send';
    if (src.indexOf('_b2bAwaitingApproval') === -1) return 'does not check the deal is unsent';
    return src.indexOf('_b2bCanAccept') > -1 || 'does not check the person may approve';
});
t('3.8.1 copying an already-sent quote does not bump the send count', function () {
    // quote_send_count is the only honest record of how many times a quote
    // actually went to the client; re-reading it must not inflate that.
    var saveDeal = _b2bModalDeal;
    _b2bModalDeal = Object.assign({}, B2B_FIXTURE_DEAL, { stage: 'quote' });
    var unsent = _b2bAwaitingApproval(_b2bModalDeal);
    _b2bModalDeal = saveDeal;
    return unsent === false
        || 'a deal at `quote` still reads as awaiting approval, so copy would re-send it';
});
t('3.8.1 the approval evidence rule is untouched', function () {
    // Widening WHO may approve must not widen WHETHER proof is required.
    var src = _b2bApprovalGate.toString();
    if (src.indexOf('_b2bApprovalOnRecord') === -1) return 'no longer checks the record';
    return b2bAcceptQuote.toString().indexOf('_b2bApprovalGate') > -1
        || 'accept no longer runs the approval gate';
});
t('3.8.1 Copy reads as a real route, not a fallback', function () {
    var src = _b2bStageReview.toString() + _b2bStageQuote.toString();
    return src.indexOf('Copy Quote') > -1 || 'the button is still just "Copy"';
});

// --- v3.8.2: the last two feedback items ------------------------------------

// Ethan, 2026-09-02: "dismiss this or snooze this... removed from my feed unless
// something new pops up, but I like the snooze option... I plan on looking at it
// another day." There was one control, day-scoped, so everything returned at
// midnight whether you wanted it to or not.
//
// The dismiss half ("Not mine") was REMOVED on 2026-09-10 -- Nick: "please also
// remove the Not mine feature on the your feed completely. That is not how i
// intended that to be". These checks now pin it staying gone, and pin the
// snooze half that survives.
t('3.8.9 Not mine is gone from the feed', function () {
    if (typeof samNotMineItem !== 'undefined') return 'the handler still exists';
    var src = _samRenderFeedNow.toString();
    if (src.indexOf('samNotMineItem') > -1) return 'the card still wires the action';
    // MARKUP, not the words. A bare 'Not mine' also matches the comment that
    // explains why the control was removed -- which is exactly how this check
    // first failed, and the same trap as the 'accept=' grep in 3.8.5.
    if (/>\s*Not mine\s*</.test(src)) return 'the button is still rendered';
    if (src.indexOf('sam-notmine-btn') > -1) return 'the button class is still emitted';
    return src.indexOf('notMineBtn(') === -1 || 'the button builder is still called';
});
t('3.8.9 Snooze is still on the card', function () {
    if (typeof samSnoozeItem !== 'function') return 'no snooze action';
    return _samRenderFeedNow.toString().indexOf('samSnoozeItem') > -1
        || 'the card does not offer Snooze';
});
t('3.8.9 anything hidden by Not mine comes back', function () {
    // Removing a feature has to remove what it DID, or people are left with
    // cards they cannot see and no control that put them there. A record with
    // no expiry is what Not mine wrote; it must no longer hide anything.
    try {
        _samSetHidden({ __probe__: { sig: 'S', until: 0 } });
        return _samIsHidden('__probe__', 'S') === false
            || 'a card hidden by the removed control is still buried';
    } finally { _samSetHidden({}); }
});
t('3.8.9 a snooze with no duration is a snooze, not a permanent hide', function () {
    // hours=0 used to mean "dismiss". With that gone, a falsy duration must
    // fall back to the overnight snooze rather than writing a record with no
    // expiry and quietly reintroducing the permanent kind.
    var src = _samHideRem.toString();
    if (/until:\s*hours\s*\?/.test(src)) return 'still writing until:0 for a falsy duration';
    return /Number\(hours\)\s*\|\|\s*\d/.test(src) || 'no fallback duration';
});
t('3.8.2 the hide store is not day-scoped', function () {
    // This was the original bug: _samDismKey() puts the date in the key, so a
    // snooze could never outlive the day.
    if (_samHideKey().match(/\d{1,2}\/\d{1,2}\/\d{4}/)) return 'still day-scoped: ' + _samHideKey();
    return _samDismKey() !== _samHideKey() || 'reusing the old day-scoped key';
});
t('3.8.2 a snooze expires and a live one holds', function () {
    var key = '__probe__';
    try {
        _samSetHidden({ __probe__: { sig: 'S', until: Date.now() - 1000 } });
        if (_samIsHidden(key, 'S')) return 'an expired snooze is still hidden';
        _samSetHidden({ __probe__: { sig: 'S', until: Date.now() + 60000 } });
        return _samIsHidden(key, 'S') || 'a live snooze is showing';
    } finally { _samSetHidden({}); }
});
t('3.8.2 new information breaks through a snooze', function () {
    // "unless something new pops up" — the sig is the identity, so changed
    // wording or counts must resurface the card.
    try {
        _samSetHidden({ __probe__: { sig: 'OLD', until: Date.now() + 60000 } });
        return !_samIsHidden('__probe__', 'NEW') || 'a snoozed card stayed buried after it changed';
    } finally { _samSetHidden({}); }
});
t('3.8.2 mark-all-read snoozes rather than hiding for good', function () {
    // Clearing a full feed is "caught up", not a decision about any one card.
    var src = samMarkAllRead.toString();
    if (src.indexOf('_samSetHidden') === -1) return 'not using the new store';
    return /until\s*[:=]/.test(src) || 'not setting an expiry, so it hides permanently';
});

// Nick, 2026-09-03 (flagged IMPORTANT): ".msg files drag and drop from email
// STRAIGHT to the website" — proof of acceptance, replacing a Google Drive folder.
t('3.8.2 a dropped .msg is recognised however the browser types it', function () {
    // Outlook drops often carry an empty or octet-stream type, so the extension
    // has to be the signal.
    if (_b2bMailMime({ name: 'Re Quote.msg', type: '' }) !== 'application/vnd.ms-outlook') {
        return 'an untyped .msg is not recognised';
    }
    if (_b2bMailMime({ name: 'x.MSG', type: 'application/octet-stream' }) !== 'application/vnd.ms-outlook') {
        return 'case or octet-stream defeats it';
    }
    if (_b2bMailMime({ name: 'saved.eml', type: '' }) !== 'message/rfc822') return '.eml not recognised';
    return true;
});
t('3.8.2 non-email files are refused', function () {
    var bad = ['shot.png', 'po.pdf', 'notes.txt', 'sheet.xlsx'];
    var slipped = bad.filter(function (n) { return _b2bIsMailFile({ name: n, type: '' }); });
    return slipped.length === 0 || 'accepted: ' + slipped.join(', ');
});
t('3.8.2 the drop zone is on the proof panel', function () {
    var html = _b2bProofPanel({ id: 'd1', approval_waived_by: null });
    if (html.indexOf('b2bProofDrop') === -1) return 'no drop target';
    return html.indexOf('Upload the client') > -1 || 'no instruction on the target';
});
t('3.8.2 the waiver is retired, with a way forward instead', function () {
    // Nick chose to close the no-proof path knowing it blocks phone approvals.
    var panel = _b2bProofPanel({ id: 'd1', approval_waived_by: null });
    if (panel.indexOf('record why') > -1) return 'the waive button is still offered';
    var src = b2bWaiveApproval.toString();
    if (src.indexOf('waive_approval') > -1) return 'still posts the retired action';
    return src.indexOf('confirming what they') > -1 || 'does not say what to do instead';
});
t('3.8.2 a waived deal still reads out on the record', function () {
    // Deals waived before this shipped are real history and must not vanish.
    var html = _b2bProofPanel({ id: 'd1', approval_waived_by: 'Paul Kushnir',
                                approval_waived_reason: 'Agreed on the phone' });
    return html.indexOf('Paul Kushnir') > -1 && html.indexOf('Agreed on the phone') > -1
        || 'an existing waiver no longer shows';
});
t('3.8.2 historical proof kinds still render their own label', function () {
    // The four kinds stay as labels so old rows read correctly.
    return _b2bProofKind('screenshot').label === 'Screenshot'
        && _b2bProofKind('note').label === 'Written note'
        || 'an old row would render with the wrong label';
});
t('3.8.2 email headers are parsed out of a dropped message', function () {
    // Async, so this asserts the parser exists and handles the .eml shape it
    // will actually see; the CFB path is best-effort by design.
    var src = _b2bMailHeaders.toString();
    if (src.indexOf('utf-16le') === -1) return 'no wide-char pass, so .msg headers would be missed';
    return src.indexOf('Subject') > -1 || 'does not look for a subject';
});

// --- v3.8.3: employees can actually list ------------------------------------
// Reported as a Feature Access bug: granting the B2B tab to an employee gave
// them everything except the listing screen. _b2bActionFor had no `listing`
// branch for them, so the deal never entered Needs Your Action, opening it
// showed the read-only item table instead of the scan bar, and the reminder
// bubble never mentioned it. Nothing on the server ever refused them.
function _asRole(role, store, fn) {
    var r = sessionStorage.getItem('speeksUserRole');
    var s = sessionStorage.getItem('speeksUserStore');
    sessionStorage.setItem('speeksUserRole', role);
    sessionStorage.setItem('speeksUserStore', store);
    try { return fn(); }
    finally {
        sessionStorage.setItem('speeksUserRole', r);
        sessionStorage.setItem('speeksUserStore', s);
    }
}
var EMP_LISTING = { id: 'el', ref: 'EMP-001', stage: 'listing', pricing_store: 'LEE',
                    listing_store: 'LEE', total_units: 2, listed_units: 0,
                    client: { company: 'Empco' }, stage_changed_at: '2026-09-08T00:00:00Z' };

t('3.8.3 an employee owns the listing on their own store', function () {
    return _asRole('employee', 'LEE', function () {
        var a = _b2bActionFor(EMP_LISTING);
        if (!a) return 'no action at all — the deal would fall out of their queue';
        return a.kind === 'listing' || 'wrong action: ' + a.kind;
    });
});
t('3.8.3 opening it goes to the listing screen, not the read-only sheet', function () {
    // This is the "weird sheet": _b2bClickKind fell through to 'view', which
    // renders a table of figures with no scan bar.
    return _asRole('employee', 'LEE', function () {
        var k = _b2bClickKind(EMP_LISTING);
        return k === 'listing' || 'routed to "' + k + '" instead of the listing screen';
    });
});
t('3.8.3 a trainee gets the same', function () {
    return _asRole('training', 'LEE', function () {
        var a = _b2bActionFor(EMP_LISTING);
        return (a && a.kind === 'listing') || 'trainees still cannot list';
    });
});
t('3.8.3 pricing still works for them', function () {
    return _asRole('employee', 'LEE', function () {
        var a = _b2bActionFor({ id: 'p', stage: 'pricing', pricing_store: 'LEE' });
        return (a && a.kind === 'pricing') || 'pricing regressed';
    });
});
t('3.8.3 but not another store’s deal', function () {
    return _asRole('employee', 'OVL', function () {
        if (_b2bActionFor(EMP_LISTING)) return 'an OVL employee can list a LEE deal';
        return !_b2bActionFor({ id: 'p', stage: 'pricing', pricing_store: 'LEE' })
            || 'an OVL employee can price a LEE deal';
    });
});
t('3.8.3 escalations stay closed to them', function () {
    return _asRole('employee', 'LEE', function () {
        var shut = ['review', 'quote', 'listing_location', 'pricing_location'];
        var open = shut.filter(function (st) {
            return !!_b2bActionFor({ id: 'x', stage: st, pricing_store: 'LEE', listing_store: 'LEE' });
        });
        if (open.length) return 'employee got an action at: ' + open.join(', ');
        if (_b2bCanAccept()) return 'employee can accept a quote';
        return !_b2bIsCorp() || 'employee reads as corp';
    });
});
t('3.8.3 no Move Store button for them', function () {
    return _asRole('employee', 'LEE', function () {
        return _b2bMoveBtn(EMP_LISTING) === '' || 'an employee can move a deal between stores';
    });
});
t('3.8.3 they can finish a fully-listed deal, but not accept one', function () {
    return _asRole('employee', 'LEE', function () {
        var done = Object.assign({}, EMP_LISTING, { listed_units: 2, total_units: 2 });
        var q = _b2bQuickAction(done);
        if (!q) return 'no Complete Deal on a finished listing';
        if (q.label.indexOf('Complete') === -1) return 'unexpected action: ' + q.label;
        // Mark Accepted must stay shut — it is gated on _b2bCanAccept.
        var acc = _b2bQuickAction({ id: 'q', stage: 'quote', total_units: 1 });
        return acc === null || 'employee offered: ' + acc.label;
    });
});
t('3.8.3 the deal lands in the action queue, opening the listing screen', function () {
    return _asRole('employee', 'LEE', function () {
        var deal = Object.assign({}, EMP_LISTING, { recycled_units: 0 });
        // _b2bRenderQueue(scoped, queue) — the caller pre-filters the owned set,
        // which is exactly what was empty for employees before this fix.
        var queue = [deal].filter(_b2bActionFor);
        if (!queue.length) return 'the deal never reaches the queue';
        var html = _b2bRenderQueue([deal], queue);
        if (html.indexOf('Also In Flight') > -1) return 'it fell through to Also In Flight';
        return html.indexOf("b2bOpenDeal('listing'") > -1
            || 'the card does not open the listing screen';
    });
});

// --- v3.8.4: the Outlook drag actually works --------------------------------
// Dragging from the Outlook message list gave "you're dragging from the wrong
// spot" when the user was doing it right. Outlook hands the message over as a
// VIRTUAL file (FileGroupDescriptorW + FileContents), so the bytes are never on
// disk: dataTransfer.files is empty and getAsFile() returns null. Chromium
// exposes it through webkitGetAsEntry(), which the first version never called.

// Fakes of the three shapes a real drop arrives in.
function _dtDirect(name) {
    var f = new File(['x'], name, { type: '' });
    return { files: [f], items: [{ kind: 'file', getAsFile: function () { return f; } }] };
}
function _dtVirtual(name) {
    var f = new File(['From: a@b.c\r\nSubject: Re Quote\r\n'], name, { type: '' });
    return {
        files: [],
        items: [{
            kind: 'file',
            getAsFile: function () { return null; },          // as Outlook behaves
            webkitGetAsEntry: function () {
                return { isFile: true, file: function (ok) { ok(f); } };
            },
        }],
    };
}
function _dtNothing() { return { files: [], items: [{ kind: 'string' }] }; }

// These three return PROMISES — the runner awaits them. Written synchronously
// at first, which reported three failures that were not real: the whole check
// file runs in one script block, so a .then() microtask has not run by the time
// the next line executes.
t('3.8.4 a virtual Outlook file is picked up', function () {
    // The regression: files[] empty and getAsFile() null must still find it.
    return _b2bDropFilePromise(_dtVirtual('Re Quote.msg')).then(function (got) {
        if (!got.file) return 'the virtual file was not read';
        if (!got.virtual) return 'not flagged as the virtual path';
        return got.file.name === 'Re Quote.msg' || 'wrong file: ' + got.file.name;
    });
});
t('3.8.4 an ordinary dragged file still works', function () {
    return _b2bDropFilePromise(_dtDirect('saved.eml')).then(function (got) {
        if (!got.file) return 'a real file drop broke';
        return got.virtual === false || 'a real file was flagged virtual';
    });
});
t('3.8.4 a drop with no file at all resolves to nothing', function () {
    return _b2bDropFilePromise(_dtNothing()).then(function (got) {
        return got.file === null || 'expected no file';
    });
});
t('3.8.4 items are read synchronously, before any await', function () {
    // A DataTransfer is neutered once the handler yields, so reading items after
    // an await returns an empty list and looks exactly like an empty drop.
    var src = b2bProofDrop.toString();
    var collect = src.indexOf('_b2bDropFilePromise');
    var firstAwait = src.indexOf('await');
    if (collect === -1) return 'not using the collector';
    return collect < firstAwait || 'the DataTransfer is read after an await';
});
t('3.8.5 a message named off an odd subject is accepted outright', function () {
    // Was: rejected unless the virtual fixup renamed it. Now accepted directly —
    // the allowlist was inverted, because a saved message arrives named all
    // sorts of ways and refusing a real email for its NAME is the worse failure.
    var odd = new File(['x'], 'Re: pricing v2.1', { type: '' });
    if (!_b2bIsMailFile(odd)) return 'still refused for how it was named';
    var noExt = new File(['x'], 'Quote confirmation', { type: '' });
    if (!_b2bIsMailFile(noExt)) return 'a name with no extension at all is refused';
    // Windows hides known extensions, so this is a routine shape.
    return _b2bMailMime(noExt) === 'message/rfc822'
        || 'unknown files should be treated as a saved email, got ' + _b2bMailMime(noExt);
});
t('3.8.5 the virtual fixup still normalises the name', function () {
    var odd = new File(['x'], 'Re: pricing v2.1', { type: '' });
    var fixed = _b2bAsMailFile(odd, true);
    return _b2bMailMime(fixed) === 'application/vnd.ms-outlook'
        || 'virtual file not typed as Outlook: ' + _b2bMailMime(fixed);
});
t('3.8.5 an .eml keeps its own type, whatever the browser said', function () {
    // The user's guess was that it might be a .eml. Every plausible shape of
    // one has to land on message/rfc822.
    var shapes = [
        new File(['x'], 'Re Quote.eml', { type: '' }),
        new File(['x'], 'Re Quote.EML', { type: 'application/octet-stream' }),
        new File(['x'], 'Re Quote.eml', { type: 'message/rfc822' }),
    ];
    var bad = shapes.filter(function (f) { return _b2bMailMime(f) !== 'message/rfc822'; });
    if (bad.length) return bad.length + ' .eml shape(s) mistyped';
    return shapes.every(_b2bIsMailFile) || 'an .eml was refused';
});
t('3.8.5 a failed drop reports what actually arrived', function () {
    // "Nothing arrived" hid whether the mail app offered no file, offered one it
    // would not release, or offered something that was not a file. Without that
    // distinction the bug was unfixable from a report.
    var diag = _b2bDropDiag({
        types: ['Files', 'text/plain'],
        items: [{ kind: 'file', type: '' }, { kind: 'string', type: 'text/plain' }],
        files: [],
    });
    if (diag.indexOf('Files') === -1) return 'does not report the offered formats';
    if (diag.indexOf('file') === -1) return 'does not report the item kinds';
    if (diag.indexOf('files: none') === -1) return 'does not report an empty file list';
    // And it must be read synchronously, like the file collection.
    var src = b2bProofDrop.toString();
    return src.indexOf('_b2bDropDiag') < src.indexOf('await')
        || 'the diagnostic is built after an await, by which point the DataTransfer is empty';
});
t('3.8.5 the file picker no longer filters real emails out', function () {
    // accept= only hides files in the dialog, and a saved message is named more
    // ways than a filter can list — filtering just makes a real email
    // un-pickable, the same mistake the drop check was making.
    var src = _b2bPaintProofModal.toString();
    if (src.indexOf('id="b2bPfFile"') === -1) return 'the picker moved — update this check';
    // accept=" with the quote: a bare 'accept=' also matches the comment
    // explaining why there isn't one, which is how this check first failed.
    return src.indexOf('accept="') === -1 || 'still filtering the picker';
});
t('3.8.5 the picked file goes through the same permissive check', function () {
    // The dialog and the drop must agree, or one route accepts what the other
    // refuses.
    var src = b2bProofFilePicked.toString();
    return src.indexOf('_b2bIsMailFile') > -1 || 'the picker uses its own rule';
});
t('3.8.4 the fixup does NOT rescue a non-mail file dragged from Explorer', function () {
    // virtual=false must be left alone, or dropping a PNG would be renamed into
    // an email.
    var png = new File(['x'], 'shot.png', { type: 'image/png' });
    return _b2bAsMailFile(png, false) === png || 'a real file was rewritten';
});
t('3.8.4 the error no longer blames the user for dragging correctly', function () {
    var src = b2bProofDrop.toString();
    if (src.indexOf('not from a preview pane') > -1) return 'still says they dragged from the wrong spot';
    // And it distinguishes "no file offered" from "offered but withheld".
    return src.indexOf('would not release the file') > -1
        || 'no message for a mail app that offers a file it will not release';
});

// The header parse has now been broken twice by the same thing: a raw NUL byte
// typed into the strip regex. It made the whole file read as binary to ripgrep
// (so content searches silently found nothing), and "fixing" the byte to a
// space quietly turned the strip into a space-stripper, which mangles every
// subject. Both directions are pinned here.
t('3.8.5 a UTF-16 .msg header still decodes to an address', function () {
    // How a UTF-16LE .msg reads once decoded as latin1: a NUL after every char.
    var wide = 'From: p\u0000a\u0000u\u0000l\u0000@\u0000x\u0000.\u0000c\u0000o\u0000m\u0000\r\n';
    var f = new File([wide], 'saved.msg', { type: '' });
    return _b2bMailHeaders(f).then(function (m) {
        return m.from === 'paul@x.com' || 'from parsed as: ' + JSON.stringify(m.from);
    });
});
t('3.8.5 the subject keeps its spaces', function () {
    var f = new File(['Subject: Re: Quote for the pallet\r\n'], 'saved.eml', { type: '' });
    return _b2bMailHeaders(f).then(function (m) {
        return m.subject === 'Re: Quote for the pallet'
            || 'subject came back as: ' + JSON.stringify(m.subject);
    });
});
t('3.8.5 no raw control byte is left in the source', function () {
    // Cheap guard on the real failure mode: one NUL anywhere makes every
    // content search over speeks.js return nothing, with no error to say so.
    var src = _b2bMailHeaders.toString();
    return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(src)
        || 'a raw control byte is back in _b2bMailHeaders';
});


// --- v3.8.6: classic Outlook, and the accept flow --------------------------
//
// Nick, 2026-09-09: "The CEO uses the classic version of outlook. I need you to
// make it work by dragging the message over."
//
// Chrome has supported this natively since 76 -- it streams FileContents out of
// Outlook and writes a temp file -- so on classic Outlook the bytes ARE there.
// The reason 3.8.5 could still come up empty was in our own retrieval: it
// filtered on item.kind, and the virtual-file item does not reliably report
// "file". These checks pin the retrieval being exhaustive rather than fussy.

// A virtual item reporting kind "string", which is how this has been seen to
// arrive -- and exactly what the old `if (kind !== 'file') continue` skipped.
function _dtVirtualAsString(name) {
    var f = new File(['From: a@b.c\r\nSubject: Re Quote\r\n'], name, { type: '' });
    return {
        files: [],
        items: [{
            kind: 'string',
            getAsFile: function () { return null; },
            webkitGetAsEntry: function () { return { isFile: true, file: function (ok) { ok(f); } }; },
        }],
    };
}
t('3.8.6 a virtual file is found even when the item says kind "string"', function () {
    return _b2bDropFilePromise(_dtVirtualAsString('Re Quote.msg')).then(function (got) {
        return (got.file && got.file.size > 0) || 'skipped the item because of its kind';
    });
});
t('3.8.6 no kind filter is left in the retrieval', function () {
    var src = _b2bDropFilePromise.toString();
    return (src.indexOf("kind !== 'file'") === -1 && src.indexOf('kind != "file"') === -1)
        || 'still filtering items on kind';
});
t('3.8.6 a dud first item does not hide a good second one', function () {
    // 3.8.5 returned on the first item that offered anything, so an empty entry
    // on items[0] ended the search before items[1] was ever asked.
    var f = new File(['From: a@b.c\r\n'], 'msg.msg', { type: '' });
    var dt = {
        files: [],
        items: [
            { kind: 'file', getAsFile: function () { return null; },
              webkitGetAsEntry: function () {
                  return { isFile: true, file: function (ok, no) { no(new Error('nope')); } };
              } },
            { kind: 'file', getAsFile: function () { return null; },
              webkitGetAsEntry: function () {
                  return { isFile: true, file: function (ok) { ok(f); } };
              } },
        ],
    };
    return _b2bDropFilePromise(dt).then(function (got) {
        return (got.file && got.file.name === 'msg.msg') || 'gave up after the first item';
    });
});
t('3.8.6 getAsFileSystemHandle is tried as well', function () {
    // The standard replacement for webkitGetAsEntry, wired to a different code
    // path inside the browser, so it can succeed where the older one is empty.
    var f = new File(['From: a@b.c\r\n'], 'h.msg', { type: '' });
    var dt = {
        files: [],
        items: [{
            kind: 'file',
            getAsFile: function () { return null; },
            getAsFileSystemHandle: function () {
                return Promise.resolve({
                    kind: 'file',
                    getFile: function () { return Promise.resolve(f); },
                });
            },
        }],
    };
    return _b2bDropFilePromise(dt).then(function (got) {
        return (got.file && got.file.name === 'h.msg') || 'the handle route is not tried';
    });
});
t('3.8.6 a message offered inside a folder is followed', function () {
    var f = new File(['From: a@b.c\r\n'], 'in-folder.msg', { type: '' });
    var dt = {
        files: [],
        items: [{
            kind: 'file',
            getAsFile: function () { return null; },
            webkitGetAsEntry: function () {
                return {
                    isDirectory: true,
                    createReader: function () {
                        return { readEntries: function (ok) {
                            ok([{ isFile: true, file: function (cb) { cb(f); } }]);
                        } };
                    },
                };
            },
        }],
    };
    return _b2bDropFilePromise(dt).then(function (got) {
        return (got.file && got.file.name === 'in-folder.msg') || 'a directory entry is ignored';
    });
});
t('3.8.6 the winning route is reported', function () {
    return _b2bDropFilePromise(_dtDirect('a.eml')).then(function (got) {
        return !!got.route || 'no route recorded, so a field failure says nothing useful';
    });
});

// The text fallback, guarded hard: a fabricated record is worse than no record.
// Outlook will happily put nothing but the subject line on a drag, and
// "Re: your quote" is not evidence that anybody accepted anything.
t('3.8.6 a proof built from text is labelled as text only', function () {
    var src = _b2bAttachMailFile.toString();
    return src.indexOf('message text only') > -1
        || 'a rebuilt proof would read on the record as if it were the original message';
});

// Firefox has never supported the format Outlook offers, so "try again" is the
// wrong advice there and wastes somebody an afternoon.
t('3.8.6 the advice names Firefox as a dead end', function () {
    var src = _b2bDropAdvice.toString();
    return src.indexOf('Firefox') > -1 || 'no browser-specific advice';
});

// Nick, 2026-09-09: "The mark accepted quick button should pull up an attach
// file popup if there is still an acceptance email needed. Also please remove
// the ability to click choose file on the quote itself... That whole modal just
// doesnt need to be there anymore"
t('3.8.6 Mark Accepted with no proof opens the attach popup', function () {
    var src = _b2bApprovalGate.toString();
    if (src.indexOf('b2bOpenAcceptProof') === -1) return 'still only alerts, so it is a dead end';
    return src.indexOf('return false') > -1 || 'does not stop the acceptance';
});
t('3.8.6 both accept buttons hand the deal id to the gate', function () {
    // Without an id the popup has nothing to attach to and falls back to the
    // old alert, which is the behaviour being replaced.
    // Matched as a plain substring, not a regex: the deal-screen call passes
    // `_b2bDealById(id) || _b2bModalDeal` as the first argument, so a `[^)]*`
    // pattern for the arguments stops dead at that inner paren. It reported a
    // failure that was not real.
    var quick = b2bQuickAccept.toString();
    var full  = b2bAcceptQuote.toString();
    if (quick.indexOf(", id, 'deal')") === -1) return 'the quick button passes no id';
    return full.indexOf(", id, 'deal')") > -1 || 'the deal screen passes no id';
});
t('3.8.6 the quote screen no longer offers Choose a file', function () {
    var html = _b2bProofPanel({ id: 'd1', approval_waived_by: null });
    if (html.indexOf('b2bOpenProofAdd') > -1) return 'the old opener is still wired up';
    return html.indexOf('Choose a file') === -1 || 'the button is still on the panel';
});
t('3.8.6 the legacy proof dialog is gone', function () {
    // The kind picker, the From / Dated / Label inputs and the paste-the-body
    // textarea were all asking for what a dropped message already carries.
    if (typeof b2bPickProofKind !== 'undefined') return 'the kind picker still exists';
    if (typeof b2bSaveProof !== 'undefined') return 'the old save path still exists';
    _b2bProofOwner = { id: 'd1', kind: 'deal' };
    var src = _b2bPaintProofModal.toString();
    if (src.indexOf('b2bPfBody') > -1) return 'still offers a paste-the-body textarea';
    if (src.indexOf('b2bPfLabel') > -1 || src.indexOf('b2bPfFrom') > -1) return 'still asks label/from';
    return src.indexOf('b2bProofDrop') > -1 || 'the popup has no drop zone';
});
t('3.8.6 the popup and the panel do not share an element id', function () {
    // Two drop zones can be on screen at once; duplicate ids put the hover
    // state and the busy spinner on whichever the browser found first.
    var panel = _b2bProofPanel({ id: 'd1', approval_waived_by: null });
    var pop = _b2bPaintProofModal.toString();
    if (panel.indexOf('b2bProofDrop-d1') === -1) return 'the panel zone is not keyed on the deal';
    return pop.indexOf('b2bProofDrop-') > -1 && pop.indexOf('B2B_PROOF_POP') > -1
        || 'the popup zone is not keyed separately from the panel';
});

// ONE ATTACH RECORDER FOR EVERY CHECK BELOW, INSTALLED ONCE AND NEVER RESTORED.
//
// The per-test stub-and-restore that was here reported three failures that were
// not real. Every check that exercises pasting is ASYNC, and the runner starts
// them all before any of them finish -- so test B captured test A's stub as
// "the real one", and whichever settled first put its captured value back while
// the others were still in flight. Their attach then went to the real function
// and their `calls` array stayed empty: "nothing was attached", for code that
// was working.
//
// Same lesson as the promise-aware t() and the shared _b2bSend stub: in this
// file, global state gets set up ONCE at the top, and each test isolates itself
// by using its own owner id instead of by putting things back.
var _B2B_ATTACHED = [];
_b2bAttachMailFile = function (file, id, kind, source, zone) {
    _B2B_ATTACHED.push({ file: file, id: id, kind: kind, source: source, zone: zone });
    return Promise.resolve();
};
function _b2bAttachedFor(id) {
    return _B2B_ATTACHED.filter(function (a) { return a.id === id; });
}

// --- v3.8.7: the new Outlook, and two bugs I shipped -----------------------
//
// Nick, 2026-09-09, with a screenshot: the drop failed on the new Outlook with
// "offered the message but would not release the file". Two separate faults,
// both mine, both in 3.8.6.

// FAULT 1, and the one that caused the reported failure. The new Outlook puts a
// SHORT text/plain on the drag -- often just the subject -- alongside a full
// text/html body. `plain || html` tested the short one, found a dozen
// characters, called the drag too thin to be a message, and discarded the whole
// body that was sitting in the other slot.

// FAULT 2: the header pattern was built from a string with SINGLE backslashes,
// and a single backslash in a quoted string is just the bare letter. So the
// pattern read "^s*From s*:[ t]*(.+)$" and matched nothing, ever -- every
// rebuilt message came out titled "Message dragged from mail app", with no
// sender, even when the headers were right there in the text.

// The report has to be readable. It was inside an alert() for one release, and
// Chrome caps a native dialog's height and scrolls the overflow -- so the
// diagnostic sat below the fold behind a scrollbar nobody drags. The screenshot
// Nick sent had the useful half cut off.
t('3.8.7 the drop report is rendered in the page, not in an alert', function () {
    var src = b2bProofDrop.toString();
    if (src.indexOf('_b2bDropFail') === -1) return 'still alerting the diagnostic';
    if (/return alert\([^)]*diag/.test(src)) return 'the diagnostic still goes through alert()';
    return _b2bDropFail.toString().indexOf('b2bDropFail-') > -1
        || 'no in-page container is targeted';
});
t('3.8.7 both drop zones have somewhere to render the report', function () {
    var panel = _b2bProofPanel({ id: 'd1', approval_waived_by: null });
    if (panel.indexOf('b2bDropFail-d1') === -1) return 'the panel has no report container';
    _b2bProofOwner = { id: 'd1', kind: 'deal' };
    return _b2bPaintProofModal.toString().indexOf('b2bDropFail-') > -1
        || 'the popup has no report container';
});
t('3.8.7 the report is copyable', function () {
    return typeof b2bCopyDropDiag === 'function' || 'no way to copy the report back';
});

// Paste, because copying a message works where dragging one does not. The new
// Outlook and Outlook in a tab are web apps in a shell: they have no OS-level
// file to hand over, so no drop-side work can make a drag produce one. Ctrl+C
// puts the message on the clipboard in every version.

// --- v3.8.8: one button, and a report you can actually read ----------------
//
// Nick, 2026-09-10: "make it so that way theres just one button that that takes
// it from your clipboard. Also make it so theres a view report if it doesnt
// work for this cause the copy wasnt really working"

// A test container, because _b2bDropFail renders into the page and falls back to
// alert() when there is nowhere to put it.
function _b2bFailHost(zone) {
    var id = 'b2bDropFail-' + zone;
    var el = document.getElementById(id);
    if (!el) {
        el = document.createElement('div');
        el.id = id;
        document.body.appendChild(el);
    }
    el.innerHTML = '';
    return el;
}


// The report. View first, copy second -- the copy button was the only way in
// and it did not work.
t('3.8.8 the failure offers a View report button', function () {
    _b2bFailHost('z1');
    _b2bDropFail('z1', 'nope', 'formats: none');
    var el = document.getElementById('b2bDropFail-z1');
    if (el.innerHTML.indexOf('b2bViewDropReport') === -1) return 'no View report button';
    return el.querySelector('.b2b-dropreport-t') !== null || 'no report field to read it in';
});
t('3.8.8 viewing the report fills it and selects it', function () {
    _b2bFailHost('z2');
    _b2bDropFail('z2', 'headline here', 'formats: Files\nitems: none');
    var el = document.getElementById('b2bDropFail-z2');
    var btn = el.querySelector('[onclick*="b2bViewDropReport"]');
    if (!btn) return 'no view button';
    b2bViewDropReport(btn);
    var wrap = el.querySelector('.b2b-dropreport');
    var ta = el.querySelector('.b2b-dropreport-t');
    if (wrap.hidden) return 'the report is still hidden after clicking View';
    if (!ta.value || ta.value.indexOf('headline here') === -1) return 'the report field is empty';
    if (ta.value.indexOf('formats: Files') === -1) return 'the diagnostic is not in the field';
    // Pre-selected so Ctrl+C works with no permission and no API.
    return (ta.selectionEnd - ta.selectionStart) === ta.value.length
        || 'the text is not selected, so Ctrl+C copies nothing';
});
t('3.8.8 the report field is readonly but selectable', function () {
    _b2bFailHost('z3');
    _b2bDropFail('z3', 'x', 'y');
    var ta = document.getElementById('b2bDropFail-z3').querySelector('.b2b-dropreport-t');
    if (!ta.hasAttribute('readonly')) return 'the report can be typed over';
    return ta.tagName === 'TEXTAREA' || 'not a textarea, so it cannot be selected natively';
});
t('3.8.8 the report carries the browser and the secure-context flag', function () {
    // Both decide whether the clipboard button can work at all, so they belong
    // in the report rather than being asked for afterwards.
    _b2bFailHost('z4');
    _b2bDropFail('z4', 'x', 'y');
    var ta = document.getElementById('b2bDropFail-z4').querySelector('.b2b-dropreport-t');
    b2bViewDropReport(document.getElementById('b2bDropFail-z4').querySelector('[onclick*="View"]'));
    if (ta.value.indexOf('browser:') === -1) return 'no browser line';
    return ta.value.indexOf('secure context') > -1 || 'no secure-context line';
});
t('3.8.8 a failed copy no longer claims it worked', function () {
    // THE BUG: execCommand returns FALSE on failure rather than throwing, and
    // only a throw was caught -- so a copy that put nothing on the clipboard
    // still flipped the button to "Copied". That is why the copy "wasnt really
    // working" with nothing to show it.
    var src = b2bCopyDropDiag.toString();
    return /execCommand\(['"]copy['"]\)\s*===\s*true/.test(src)
        || 'the return value of execCommand is still ignored';
});


// MEASURED, not guessed. Nick ran the button on the new Outlook and the report
// came back with exactly one clipboard type and nothing else:
//     clipboard types: web application/owa-item-drag-data
//     text/plain: none    text/html: none
// It is a reference to the message on the server, not the message. There is
// nothing to rescue, so the job is to SAY so and give the routes that work --
// telling somebody their clipboard has no email on it reads as though they did
// it wrong, and they did not.

// The payload turned out to carry the subject. Nick's report, 2026-09-10:
//   {"itemType":"multimaillistconversationrows", ...
//    "subjects":["Adding Approval Request - Please"],
//    "latestItemIds":["AAkALgAAAAAAHYQDEapmEc2byACqAC/EWg0A..."]}
// Naming the email back proves the app understood exactly what was dragged,
// which is the difference between "that didn't work" -- which invites a retry
// of the same failing gesture -- and "that didn't work, and here is what does".
t('3.8.9 subject extraction survives a payload it does not recognise', function () {
    // Somebody else's private format; it can change shape without notice, and a
    // parse failure must degrade to a less specific message, not an exception.
    if (_b2bOwaSubjects('not json at all').length) return 'invented a subject from junk';
    if (_b2bOwaSubjects('{"nope":1}').length) return 'invented a subject from an unknown shape';
    var one = _b2bOwaSubjects('{"subjects":["A","B"]}');
    return (one.length === 2 && one[0] === 'A') || 'did not read the subjects it does understand';
});
t('3.8.9 several messages at once are counted, not listed', function () {
    var three = _b2bOwaAdvice(['First one', 'Second', 'Third']);
    if (three.indexOf('First one') === -1) return 'does not name the first';
    return three.indexOf('2 others') > -1 || 'does not say how many others: ' + three.slice(0, 90);
});
t('3.8.8 the OWA detector needs the reference AND no usable content', function () {
    if (!_b2bOwaRefOnly(['web application/owa-item-drag-data'])) return 'missed a bare OWA reference';
    // Classic Outlook via OWA-in-a-tab can offer both; if there is real text to
    // rebuild from, this is not the dead end and must not claim to be.
    if (_b2bOwaRefOnly(['web application/owa-item-drag-data', 'text/html'])) {
        return 'called it a dead end when there was HTML to rebuild from';
    }
    return !_b2bOwaRefOnly(['text/plain', 'text/html']) || 'fired on an ordinary text copy';
});
t('3.8.8 a drag out of the new Outlook says the same thing as a copy', function () {
    // The drag carries the same server reference, so nobody should have to try
    // the button to find out why the drag did nothing.
    var src = b2bProofDrop.toString();
    return src.indexOf('_b2bOwaRefOnly') > -1
        || 'the drop path still reports the generic failure for a new-Outlook drag';
});
t('3.8.8 two failed zones keep their own reports', function () {
    // The report used to live in one module-level variable, so the second
    // failure overwrote the first and clicking View on the older panel showed
    // somebody else's diagnostic.
    _b2bFailHost('zA');
    _b2bFailHost('zB');
    _b2bDropFail('zA', 'first headline', 'formats: AAA');
    _b2bDropFail('zB', 'second headline', 'formats: BBB');
    var a = document.getElementById('b2bDropFail-zA');
    b2bViewDropReport(a.querySelector('[onclick*="b2bViewDropReport"]'));
    var v = a.querySelector('.b2b-dropreport-t').value;
    if (v.indexOf('BBB') > -1) return 'zone A is showing zone B’s report';
    return v.indexOf('AAA') > -1 || 'zone A lost its own report';
});

// --- v3.9.0: read the Drive folder instead of being the drop target --------
//
// Nick, 2026-09-10: "They currently just drag and drop it into google drive.
// Can I implement a single google drive folder into the website so that it just
// drags and drops it into there"
//
// A Drive-backed drop ZONE would have changed nothing: the limit is what Outlook
// hands the browser, not where the bytes go, so it would have received the same
// owa-item-drag-data pointer and the same nothing. His Drive drag works because
// Drive-for-desktop is a real Windows folder and Explorer supports the
// virtual-file format -- it works precisely because it is not a browser.
//
// So the direction is inverted: read the folder he already drops into.
// The comment-stripping helper itself, because three checks have now been
// broken by searching prose instead of code.
t('3.9.0 _srcOf strips comments before a source search', function () {
    function sample() { /* secret */ var a = 1; // secret
        return a; }
    var s = _srcOf(sample);
    if (/secret/.test(s)) return 'comments survived, so a search still matches prose';
    return s.indexOf('var a = 1') > -1 || 'the code was stripped along with the comments';
});

// --- v3.9.1: upload is the route, and everything else came out ------------
//
// Nick, 2026-09-10: "im bailing out of this new google drive idea. The issue is
// that I dont like one shared folder of all the receipts its just not right. Go
// back to just the file upload of that msg file and I will teach everyone how to
// download the email and upload it to speeksnet"
//
// Right call, and worth recording why after four releases spent avoiding it.
// Outlook can only hand a message to a BROWSER as a virtual file: classic
// desktop Outlook plus Chrome or Edge manages it, the new Outlook cannot, and
// Firefox never could. Downloading the message first turns it into an ordinary
// file, and an ordinary file upload works everywhere, forever, with nothing to
// go wrong. Every clever route around that is now gone.

t('3.9.1 the Drive folder is gone, all of it', function () {
    var names = ['_b2bDrivePanel', '_b2bDriveListHtml', '_b2bDriveWhen', '_b2bDriveRepaint',
                 'b2bDriveRefresh', 'b2bDriveAttach'];
    var left = names.filter(function (n) { return typeof window[n] !== 'undefined'; });
    if (left.length) return 'still defined: ' + left.join(', ');
    var panel = _b2bProofPanel({ id: 'd1', approval_waived_by: null });
    return panel.indexOf('Drive') === -1 || 'the panel still mentions Drive';
});
t('3.9.1 the clipboard and paste routes are gone', function () {
    // Two more ways to hand over evidence, each with its own failure modes.
    // One route, taught once, beats four that mostly work.
    if (typeof b2bPasteFromClipboard !== 'undefined') return 'the clipboard button still exists';
    if (typeof b2bProofPaste !== 'undefined') return 'the paste handler still exists';
    var panel = _b2bProofPanel({ id: 'd1', approval_waived_by: null });
    return panel.indexOf('onpaste') === -1 || 'the zone still listens for a paste';
});
t('3.9.1 the text reconstruction is gone', function () {
    // It filed a rebuilt .eml as "message text only" when the real file could
    // not be had. That is a second KIND of evidence on the record, and one
    // kind plus a clear instruction is a better log than two kinds.
    if (typeof _b2bEmlFromDragText !== 'undefined') return 'the rebuilder still exists';
    if (typeof _b2bDragTextIsMessage !== 'undefined') return 'the gate still exists';
    var src = _srcOf(_b2bAttachMailFile);
    return src.indexOf('message text only') === -1
        || 'the attach path can still label a proof as text-only';
});

t('3.9.1 upload is the instruction on both surfaces', function () {
    var panel = _b2bProofPanel({ id: 'd1', approval_waived_by: null });
    if (panel.indexOf('Upload the client') === -1) return 'the panel does not lead with upload';
    if (panel.indexOf('Download or Save As') === -1) return 'the panel does not say how to get the file';
    _b2bProofOwner = { id: 'd1', kind: 'deal' };
    var pop = _b2bPaintProofModal.toString();
    return pop.indexOf('Upload the client') > -1 || 'the accept popup does not lead with upload';
});
t('3.9.1 the panel has a real file input, wired to its own deal', function () {
    // The picker came OFF this panel in 3.8.6 and is back by request. It has to
    // carry the deal id: the panel can render for a deal that is not the one the
    // accept popup last set, and reading the popup's global here would file the
    // email against the wrong deal.
    var panel = _b2bProofPanel({ id: 'd7', approval_waived_by: null });
    if (panel.indexOf('type="file"') === -1) return 'no file input on the panel';
    var m = panel.match(/b2bProofFilePicked\(([^)]*)\)/);
    if (!m) return 'the input is not wired up';
    return m[1].indexOf("'d7'") > -1 || 'the picker does not name its deal: ' + m[1];
});
t('3.9.1 the popup picker still works with no arguments', function () {
    // It passes none and relies on the owner it just set, so the panel's extra
    // arguments must be optional rather than required.
    var src = _srcOf(b2bProofFilePicked);
    if (src.indexOf('_b2bProofOwner') === -1) return 'the popup route lost its fallback';
    return /ownerId \|\||\|\| \(_b2bProofOwner/.test(src) || 'the arguments are not optional';
});
t('3.9.1 the same file can be picked twice', function () {
    // A file input fires no change event when re-picking the same file, so
    // after a failed upload the obvious next move -- try that file again --
    // would do nothing at all.
    var src = _srcOf(b2bProofFilePicked);
    return /input\.value = ''/.test(src) || 'the input is never cleared';
});
t('3.9.1 the picker and the drop agree on what an email is', function () {
    var src = _srcOf(b2bProofFilePicked);
    if (src.indexOf('_b2bIsMailFile') === -1) return 'the picker uses its own rule';
    return src.indexOf('_b2bAttachMailFile') > -1 || 'the picker inserts by its own route';
});
t('3.9.1 dragging still works where the mail app allows it', function () {
    // Kept because the drop zone IS the file input's drop target -- no extra UI,
    // and on classic Outlook it is still one gesture instead of three.
    var panel = _b2bProofPanel({ id: 'd1', approval_waived_by: null });
    return panel.indexOf('ondrop="b2bProofDrop') > -1 || 'the drop target was removed too';
});
t('3.9.1 a new-Outlook drag is still named rather than blamed', function () {
    // The pointer detection stays: it costs no UI and it is the difference
    // between "that didn't work" and knowing why.
    var src = _srcOf(b2bProofDrop);
    if (src.indexOf('_b2bOwaRefOnly') === -1) return 'the pointer is no longer recognised';
    var advice = _b2bOwaAdvice(['Adding Approval Request - Please']);
    if (advice.indexOf('Adding Approval Request') === -1) return 'the subject is not named back';
    return advice.indexOf('Download') > -1 || 'does not name the route that works';
});
t('3.9.1 the drag still reads the pointer synchronously', function () {
    // A DataTransfer is emptied the moment the handler yields.
    return _srcOf(_b2bDragText).indexOf('B2B_OWA_REF_RX') > -1
        || 'the drag no longer reads the OWA format';
});

// Nick, 2026-09-10: "The listing UI for B2B currently says the total cost and
// the total price per line item quantity. this sohuld just be the cost and price
// of a single one of those quantities since this is the way they price out the
// item and put the cost for it. They just tick up the quantity on Paymores POS
// Autolister so it adjusts the quantity as well but the listing is made for a
// single item"
t('3.9.1 the listing grid shows value and cost PER UNIT', function () {
    // A line of five identical laptops is priced ONCE, as one laptop, and the
    // autolister takes the quantity from there. Showing 5 x $350 = $1,750 in the
    // Value column invites somebody to type 1750 into a listing for one of them.
    //
    // Split at the Line total cell rather than searching the whole row: the
    // trial branch ADDED a deliberate quantity-inclusive figure in that last
    // column, and a blanket "$1,750 must not appear" then failed on correct
    // markup. The rule was never "that number is forbidden" -- it is "the
    // per-unit columns must not be the ones showing it".
    var keep = _b2bModalItems;
    try {
        _b2bModalItems = [{
            id: 'u1', line_no: 1, sku: 'SP-1', make: 'Dell', model: 'X1',
            item_type: 'laptop', quantity: 5, value: 350, cost: 200,
            disposition: 'purchase', cpu: 'i5', ram: '16GB', storage: '512GB',
        }];
        var html = _b2bListRows();
        var cut = html.indexOf('b2b-lc-tot');
        if (cut === -1) return 'no line-total cell to measure against';
        var perUnit = html.slice(0, cut);
        if (perUnit.indexOf('$1,750') > -1) return 'value is still multiplied by the quantity';
        if (perUnit.indexOf('$1,000') > -1) return 'cost is still multiplied by the quantity';
        if (perUnit.indexOf('$350') === -1) return 'the per-unit value is not shown';
        return perUnit.indexOf('$200') > -1 || 'the per-unit cost is not shown';
    } finally { _b2bModalItems = keep; }
});
t('3.9.1 the columns say they are per unit', function () {
    var keep = _b2bModalItems;
    try {
        _b2bModalItems = [{ id: 'u1', line_no: 1, quantity: 2, value: 10, cost: 5,
                            disposition: 'purchase', item_type: 'other' }];
        var html = _b2bListRows();
        return /Value ea/.test(html) && /Cost ea/.test(html)
            || 'the headers still read as line totals';
    } finally { _b2bModalItems = keep; }
});
t('3.9.1 the recycled-out figure stays a total', function () {
    // It answers a different question -- what did we pay for units that got
    // scrapped -- and at the per-unit cost it would be indistinguishable from
    // the cost column next to it.
    var keep = _b2bModalItems;
    try {
        _b2bModalItems = [{ id: 'u1', line_no: 1, quantity: 5, value: 350, cost: 200,
                            recycled_qty: 3, disposition: 'purchase', item_type: 'other' }];
        var html = _b2bListRows();
        return html.indexOf('$600') > -1 || 'three recycled units at $200 should read as $600';
    } finally { _b2bModalItems = keep; }
});
t('3.9.1 the deal totals above are still totals', function () {
    // Only the per-line columns changed. The stats block is meant to total.
    var src = _srcOf(_b2bDealStatRaw);
    return /\*\s*qty|qty\s*\*|quantity/.test(src)
        || 'the deal stats stopped multiplying by quantity, which they must still do';
});

// The .msg MIME has to be in FOUR places that agree: _b2bMailMime here, the
// edge function's PROOF_MIMES, the b2b-proofs bucket's allowed_mime_types, and
// 0050's kind CHECK. The bucket was the one nobody updated, and storage refused
// every .msg for two days with "mime type application/vnd.ms-outlook is not
// supported" -- after the browser and the server had both approved it. This
// cannot catch the bucket from in here, but it can catch the client drifting
// from the constant the server was told about.
t('3.9.1 the .msg MIME the server expects is the one the client sends', function () {
    if (B2B_MSG_MIME !== 'application/vnd.ms-outlook') {
        return 'the constant changed: ' + B2B_MSG_MIME + ' — the bucket and PROOF_MIMES '
            + 'both have to change with it (see migration 0080)';
    }
    if (_b2bMailMime({ name: 'x.msg', type: '' }) !== 'application/vnd.ms-outlook') {
        return 'a .msg is not typed as Outlook';
    }
    return _b2bMailMime({ name: 'x.eml', type: '' }) === 'message/rfc822'
        || 'an .eml is not typed as rfc822';
});

// Nick, 2026-09-10: "It saves it as just a file . What would I open it with to
// make sure that it is working". Without a Content-Disposition the browser names
// a download after the URL path -- so the message arrived as "b2b-deals" with no
// extension, which Windows cannot open with anything.
t('3.9.2 the download row says which format it is', function () {
    var html = _b2bProofPanel({ id: 'd1', approval_waived_by: null });
    if (html.indexOf('Download') === -1) return 'the row does not offer a download';
    return html.indexOf('Outlook') > -1 || 'nothing on the row says what opens it';
});
t('3.9.2 the extension comes from the MIME, not the subject line', function () {
    // A subject routinely ends in something that looks like an extension.
    if (_b2bProofExt({ mime: 'application/vnd.ms-outlook' }) !== 'msg') return 'a .msg is not labelled msg';
    if (_b2bProofExt({ mime: 'message/rfc822' }) !== 'eml') return 'an .eml is not labelled eml';
    if (_b2bProofExt({ mime: 'APPLICATION/VND.MS-OUTLOOK' }) !== 'msg') return 'case defeats it';
    // Historical rows from the screenshot/document era: say nothing rather than
    // guess, and the label just reads "Download".
    if (_b2bProofExt({ mime: 'image/png' }) !== '') return 'guessed at a legacy row';
    return _b2bProofExt({}) === '' || 'guessed with no mime at all';
});

// --- v3.8.5: feedback button on the B2B header -----------------------------
//
// Nick, 2026-09-10: "a button at the top next to the header thats pretty
// prominent that allows users to submit feedback, no category just a subject
// line and free form text that sends the feedback directly to my email".
t('3.8.5 the feedback dialog asks for a subject and free text, and nothing else', function () {
    // No category on purpose: the lightbulb form makes people classify what
    // they are reporting first, and that decision stops some of them writing
    // anything at all. A subject line does the same job for free.
    var src = _srcOf(b2bFeedbackSend);
    if (src.indexOf('b2bFbSubject') === -1) return 'no subject field';
    if (src.indexOf('b2bFbBody') === -1) return 'no message field';
    return src.indexOf('category') === -1 || 'it is asking for a category';
});
t('3.8.5 an empty submission is refused before it is sent', function () {
    var src = _srcOf(b2bFeedbackSend);
    if (src.indexOf('subject line') === -1) return 'an empty subject is not caught';
    return /if \(!body\)/.test(src) || 'an empty message is not caught';
});
t('3.8.5 it goes through the function that owns the mail path', function () {
    // b2b-outreach, not b2b-deals: sendEmail there falls back from the Gmail
    // relay to Resend and holds the keys for both.
    var src = _srcOf(b2bFeedbackSend);
    if (src.indexOf('B2B_OUTREACH_URL') === -1) return 'not posting to b2b-outreach';
    return src.indexOf('send_feedback') > -1 || 'wrong action name';
});
t('3.8.5 it carries who sent it and what they were looking at', function () {
    // The one bit of context that costs the sender nothing and saves a round
    // trip asking "where were you when this happened".
    var src = _srcOf(b2bFeedbackSend);
    if (src.indexOf('_b2bUser()') === -1) return 'the sender is not named';
    if (src.indexOf('_b2bRole()') === -1) return 'the role is not sent';
    return src.indexOf('_b2bView') > -1 || 'the view is not sent';
});
t('3.8.5 what was typed survives a failed send', function () {
    // Throwing away somebody's words because the network blinked is the fastest
    // way to make sure they never bother again.
    var src = _srcOf(b2bFeedbackSend);
    var cleared = src.indexOf("s.value = ''");
    var thrown = src.indexOf('throw new Error');
    if (cleared === -1) return 'the fields are never cleared, even on success';
    return thrown < cleared || 'the fields are cleared before the send is known to have worked';
});
t('3.8.5 the failure stays in the dialog rather than an alert', function () {
    var src = _srcOf(b2bFeedbackSend);
    return src.indexOf("didn't send") > -1 && src.indexOf('b2bFbMsg') > -1
        || 'the error is not shown next to what they wrote';
});

// --- TRIAL BRANCH: actions menu + line total -------------------------------
//
// Labelled "trial" rather than with a version, because this branch is a thing
// to look at and decide on -- not something that shipped.
//
// Feedback, 2026-09-10: the B2B header was "kind of cluttered and hard to
// follow". A CEO saw six view tabs and five buttons on one line.

t('trial: the line total is quantity-inclusive and checkable', function () {
    // Nick: "a total value per line item (accounting for quantity) after value
    // each and cost each so people can know if its worth their time to list all
    // of them together". Value ea x FULL quantity on purpose, so it is
    // arithmetic anybody can verify against the two columns beside it.
    var keep = _b2bModalItems;
    try {
        _b2bModalItems = [{ id: 'u1', line_no: 1, quantity: 5, value: 350, cost: 200,
                            disposition: 'purchase', item_type: 'other' }];
        var html = _b2bListRows();
        if (html.indexOf('Line total') === -1) return 'no Line total column';
        var cut = html.indexOf('b2b-lc-tot');
        if (cut === -1) return 'no line-total cell';
        return html.slice(cut).indexOf('$1,750') > -1 || 'the total is not 5 x $350';
    } finally { _b2bModalItems = keep; }
});
t('trial: a recycle line shows no line total to add up', function () {
    var keep = _b2bModalItems;
    try {
        _b2bModalItems = [{ id: 'u1', line_no: 1, quantity: 4, value: 90, cost: 40,
                            disposition: 'recycle', item_type: 'other' }];
        var html = _b2bListRows();
        var cut = html.indexOf('b2b-lc-tot');
        if (cut === -1) return 'no line-total cell';
        return html.slice(cut, cut + 220).indexOf('$360') === -1
            || 'a scrap line is being valued as if it will be listed';
    } finally { _b2bModalItems = keep; }
});
t('trial: the grid header and the row have the same column count', function () {
    // The header, the row and --b2b-pcols all have to agree, or every cell
    // slides one place left. Counted rather than trusted, because adding a
    // column and forgetting one of the three is the obvious way to break it.
    var keep = _b2bModalItems;
    try {
        _b2bModalItems = [{ id: 'u1', line_no: 1, quantity: 1, value: 10, cost: 5,
                            disposition: 'purchase', item_type: 'other' }];
        var html = _b2bListRows();
        var hs = html.indexOf('b2b-phead');
        if (hs === -1) return 'no header row';
        var head = html.slice(hs, html.indexOf('</div>', hs));
        var heads = (head.match(/<span/g) || []).length;
        var rs = html.indexOf('b2b-lline');
        if (rs === -1) return 'no item row';
        var cells = (html.slice(rs).match(/class="b2b-pcell/g) || []).length;
        return heads === cells || heads + ' headers but ' + cells + ' cells';
    } finally { _b2bModalItems = keep; }
});


// --- TRIAL: the per-row actions menu on the listing sheet -----------------
//
// Nick, 2026-09-10, pointing at the row's action cell: "this was meant for the
// per item listing actions". Four controls per row -- a listed stepper, a
// recycle stepper, "Recycle..." and a barcode button -- on a fifty-line sheet.

function _b2bRowFixture(over) {
    var base = { id: 'r1', line_no: 1, sku: 'SP-9', make: 'Dell', model: 'X1',
                 item_type: 'other', quantity: 4, value: 100, cost: 50,
                 disposition: 'purchase' };
    Object.keys(over || {}).forEach(function (k) { base[k] = over[k]; });
    return base;
}

t('trial: the listed stepper stays on the row', function () {
    // That green + is pressed once per unit all day. Burying it behind a click
    // would be a straight tax on the main job.
    var keep = _b2bModalItems;
    try {
        _b2bModalItems = [_b2bRowFixture()];
        var html = _b2bListRows();
        if (html.indexOf('b2bAskShopify') === -1) return 'the list action left the row';
        return html.indexOf('b2bUnlistUnit') > -1 || 'the undo-one action left the row';
    } finally { _b2bModalItems = keep; }
});
t('trial: the occasional actions left the row for the menu', function () {
    var keep = _b2bModalItems;
    try {
        _b2bModalItems = [_b2bRowFixture()];
        var html = _b2bListRows();
        if (html.indexOf('b2bRecycleUnits(') > -1) return 'Recycle... is still on the row';
        if (html.indexOf('b2b-recstep') > -1) return 'the recycle stepper is still on the row';
        if (html.indexOf('b2b-linelabel') > -1) return 'the barcode button is still on the row';
        return html.indexOf('b2bRowActions(') > -1 || 'no trigger to reach them by';
    } finally { _b2bModalItems = keep; }
});
t('trial: the trigger wears the label state it swallowed', function () {
    // The barcode button was colour-coded -- amber while any unit still needs a
    // label, green once printed -- and no print is ever forced, so that colour
    // was the entire reminder. Collapsing it must not lose it.
    var todo = _b2bRowActsBtn(_b2bRowFixture({ label_printed_qty: 0 }), false);
    if (todo.indexOf('b2b-rowacts-todo') === -1) return 'an unprinted line does not flag';
    var done = _b2bRowActsBtn(_b2bRowFixture({ label_printed_qty: 4 }), false);
    if (done.indexOf('b2b-rowacts-done') === -1) return 'a fully printed line does not read as done';
    return done.indexOf('b2b-rowacts-todo') === -1 || 'a printed line still says there is work';
});
t('trial: a recycled count is still visible without opening anything', function () {
    // "N rec" was information, not just a control.
    var none = _b2bRowActsBtn(_b2bRowFixture({ recycled_qty: 0 }), false);
    if (none.indexOf('b2b-rec-chip') > -1) return 'a zero count is being shown as a chip';
    var some = _b2bRowActsBtn(_b2bRowFixture({ recycled_qty: 2 }), false);
    if (some.indexOf('b2b-rec-chip') === -1) return 'a real recycled count is hidden in the menu';
    return some.indexOf('2 rec') > -1 || 'the chip does not say how many';
});
t('trial: no SKU means no label row, not a broken one', function () {
    var btn = _b2bRowActsBtn(_b2bRowFixture({ sku: '' }), false);
    // No label state to wear when there is nothing to print.
    return btn.indexOf('b2b-rowacts-todo') === -1 || 'a line with no SKU claims labels are outstanding';
});
t('trial: one shared menu, not one per row', function () {
    // Fifty rows would otherwise mean fifty hidden menus in the DOM.
    var keep = _b2bModalItems;
    try {
        _b2bModalItems = [_b2bRowFixture({ id: 'a' }), _b2bRowFixture({ id: 'b', line_no: 2 })];
        var html = _b2bListRows();
        return (html.match(/class="b2b-rowmenu"/g) || []).length === 0
            || 'the menu markup is being rendered per row';
    } finally { _b2bModalItems = keep; }
});
t('trial: the menu is fixed-positioned and escapes the scrolling sheet', function () {
    // The sheet scrolls horizontally inside .b2b-ss and has a sticky header,
    // either of which would clip an absolutely-positioned menu.
    var src = _srcOf(b2bRowActions) + _srcOf(_b2bRowMenuEl);
    if (src.indexOf('document.body.appendChild') === -1) return 'the menu is not on the body';
    if (src.indexOf('getBoundingClientRect') === -1) return 'not positioned off the trigger';
    return /innerHeight|innerWidth/.test(src) || 'not clamped to the viewport';
});
t('trial: a scroll closes it, because a fixed menu cannot follow the row', function () {
    var src = _srcOf(b2bRowMenuClose);
    if (src.indexOf('_b2bRowMenuFor') === -1) return 'close does not clear the open row';
    // The listener is bound at load; assert the close path exists and works.
    _b2bRowMenuFor = 'r1';
    b2bRowMenuClose();
    return _b2bRowMenuFor === null || 'close left the menu marked open';
});

// --- v3.9.0: splitting a deal across listing locations --------------------
//
// Nick, 2026-09-10: "I need the ability to split a deal thats been priced out
// between multiple listing locations... This way each store can only see the
// part of the B2b DEAL that was actually brought to their store."

function _b2bSplitFixture() {
    return [
        { id: 'i1', line_no: 1, sku: 'A-1', quantity: 2, value: 100, cost: 40,
          disposition: 'purchase', item_type: 'other', listing_store: 'OVL' },
        { id: 'i2', line_no: 2, sku: 'A-2', quantity: 3, value: 200, cost: 90,
          disposition: 'purchase', item_type: 'other', listing_store: 'MPL' },
    ];
}
function _b2bSplitDeal(over) {
    var d = {
        id: 'd-split', ref: 'SPL-001', stage: 'listing',
        listing_store: null, listing_stores: ['MPL', 'OVL'],
        total_units: 5, listed_units: 1, recycled_units: 0,
        listing_parts: [
            { store: 'MPL', total_units: 3, listed_units: 0, recycled_units: 0,
              outstanding_units: 3, completed_at: null, completed_by: null },
            { store: 'OVL', total_units: 2, listed_units: 1, recycled_units: 1,
              outstanding_units: 0, completed_at: '2026-09-10T12:00:00Z', completed_by: 'Ethan' },
        ],
    };
    Object.keys(over || {}).forEach(function (k) { d[k] = over[k]; });
    return d;
}

// A split deal has listing_store NULL and names its stores only in the roll-up,
// so checking the single column alone would hide it from every store on it.
t('3.9.0 a split deal is in scope for each store that has lines on it', function () {
    return _asRole('manager', 'MPL', function () {
        var d = _b2bSplitDeal();
        if (!_b2bListsHere(d, ['MPL'])) return 'MPL cannot see a deal it has lines on';
        if (!_b2bListsHere(d, ['OVL'])) return 'OVL cannot see a deal it has lines on';
        return !_b2bListsHere(d, ['BAL']) || 'BAL can see a deal it has no lines on';
    });
});
t('3.9.0 an unsplit deal still works off the single column', function () {
    var d = _b2bSplitDeal({ listing_store: 'WSP', listing_stores: ['WSP'] });
    if (!_b2bListsHere(d, ['WSP'])) return 'the single-store path broke';
    return !_b2bListsHere(d, ['OVL']) || 'a store with nothing on it is in scope';
});
t('3.9.0 the listing screen opens for a store on a split deal', function () {
    return _asRole('manager', 'MPL', function () {
        var act = _b2bActionFor(_b2bSplitDeal());
        // B2B_ACTIONS entries carry cta/why/kind -- not key or label.
        return (act && act.kind === 'listing') || 'no listing action for a store on the split';
    });
});

// The privacy requirement is enforced by the SERVER, but the client has to ask
// for its own slice -- and both fetch sites have to ask, or a store sees the
// whole deal on a background refresh and its own share on open.
t('3.9.0 a store asks the server for only its own lines', function () {
    return _asRole('manager', 'MPL', function () {
        var qs = _b2bScopeQs();
        return qs === '&store=MPL' || 'a store is not scoping its item fetch: ' + JSON.stringify(qs);
    });
});
t('3.9.0 corp asks for the whole deal', function () {
    return _asRole('ceo', 'CORP', function () {
        return _b2bScopeQs() === '' || 'corp is scoping itself out of its own deals';
    });
});
t('3.9.0 both item fetches are scoped, not just one', function () {
    // Intermittent leaks are the worst kind: one path scoped and the other not
    // means a store sees the whole deal only after a poll.
    var src = _srcOf(_b2bSyncOpenDeal) + _srcOf(b2bOpenDeal);
    var fetches = (src.match(/deal_id=\$\{encodeURIComponent/g) || []).length;
    var scoped = (src.match(/_b2bScopeQs\(\)/g) || []).length;
    if (!fetches) return 'no item fetch found — this check needs updating';
    return fetches === scoped || `${fetches} item fetches but only ${scoped} scoped`;
});

// The split picker.
t('3.9.0 splitting is an explicit choice, not a hidden mode', function () {
    var src = _srcOf(_b2bStageListingLocation);
    if (src.indexOf('b2bSplitToggle') === -1) return 'no way to choose';
    return src.indexOf('All to one store') > -1 || 'the one-store option is not offered';
});
t('3.9.0 every line has to be placed before a split can be sent', function () {
    var keep = _b2bModalItems;
    try {
        _b2bModalItems = _b2bSplitFixture();
        _b2bSplitMode = true;
        _b2bSplitPlan = { i1: 'OVL' };          // i2 left unplaced
        if (_b2bSplitUnplaced().length !== 1) return 'unplaced lines are not counted';
        var html = _b2bSplitPickerHtml();
        if (html.indexOf('still to place') === -1) return 'nothing says a line is unplaced';
        _b2bSplitPlan = { i1: 'OVL', i2: 'MPL' };
        if (_b2bSplitUnplaced().length !== 0) return 'a placed line still reads as unplaced';
        return _b2bSplitStores().join(',') === 'MPL,OVL' || 'the store set is wrong: ' + _b2bSplitStores();
    } finally { _b2bModalItems = keep; _b2bSplitMode = false; _b2bSplitPlan = {}; }
});
t('3.9.0 the picker tallies each store as the plan is built', function () {
    var keep = _b2bModalItems;
    try {
        _b2bModalItems = _b2bSplitFixture();
        _b2bSplitMode = true;
        _b2bSplitPlan = { i1: 'OVL', i2: 'MPL' };
        var html = _b2bSplitPickerHtml();
        // OVL: 1 line, 2 units, $200. MPL: 1 line, 3 units, $600.
        if (html.indexOf('2 units') === -1) return 'no unit tally per store';
        return html.indexOf('$600') > -1 || 'no value tally per store';
    } finally { _b2bModalItems = keep; _b2bSplitMode = false; _b2bSplitPlan = {}; }
});
t('3.9.0 the brush places everything left in one go', function () {
    var keep = _b2bModalItems;
    try {
        _b2bModalItems = _b2bSplitFixture();
        _b2bSplitPlan = {};
        b2bSplitRest('BAL');
        return Object.keys(_b2bSplitPlan).length === 2 || 'everything-left did not place every line';
    } finally { _b2bModalItems = keep; _b2bSplitPlan = {}; }
});

// Corp's per-store breakdown, and a store seeing only its own numbers.
t('3.9.0 corp gets a bar per store under the deal bar', function () {
    return _asRole('ceo', 'CORP', function () {
        var keep = _b2bModalDeal;
        try {
            _b2bModalDeal = _b2bSplitDeal();
            var html = _b2bListProgress();
            if (html.indexOf('b2b-prog-parts') === -1) return 'no per-store breakdown';
            if (html.indexOf('split across 2 stores') === -1) return 'the main bar does not say it is split';
            if (html.indexOf('MPL') === -1 || html.indexOf('OVL') === -1) return 'a store is missing a bar';
            if (html.indexOf('finished by Ethan') === -1) return 'a finished part does not say who finished it';
            return html.indexOf('Waiting on MPL') > -1 || 'does not say who it is waiting on';
        } finally { _b2bModalDeal = keep; }
    });
});
t('3.9.0 a store sees its own part, not the deal', function () {
    return _asRole('manager', 'MPL', function () {
        var keepD = _b2bModalDeal, keepI = _b2bModalItems;
        try {
            _b2bModalDeal = _b2bSplitDeal();
            _b2bModalItems = [_b2bSplitFixture()[1]];      // only MPL's line came back
            var html = _b2bListProgress();
            if (html.indexOf('b2b-prog-parts') > -1) return 'a store is shown the other store breakdown';
            if (html.indexOf('Your part') === -1) return 'it does not read as their own part';
            // MPL's part is 3 units, 0 done. The DEAL is 5 units, 1 done.
            if (html.indexOf('of 3 units') === -1) return 'showing the deal total instead of their own';
            return html.indexOf('of 5 units') === -1 || 'the deal total leaked into a store view';
        } finally { _b2bModalDeal = keepD; _b2bModalItems = keepI; }
    });
});

// Moving lines: corp only, and never a line already live on Shopify.
t('3.9.0 only corp is offered Move Lines', function () {
    var d = _b2bSplitDeal();
    var asStore = _asRole('manager', 'MPL', function () { return _b2bMoveLinesBtn(d); });
    if (asStore) return 'a store manager is offered Move Lines';
    var asCorp = _asRole('ceo', 'CORP', function () { return _b2bMoveLinesBtn(d); });
    return asCorp.indexOf('b2bOpenMoveLines') > -1 || 'corp is not offered Move Lines';
});
t('3.9.0 Move Lines is only offered while the deal is being listed', function () {
    return _asRole('ceo', 'CORP', function () {
        var done = _b2bMoveLinesBtn(_b2bSplitDeal({ stage: 'completed' }));
        return done === '' || 'offered on a completed deal';
    });
});
t('3.9.0 a line with units already listed cannot be moved', function () {
    // The Shopify listing belongs to the store that made it, so moving the line
    // would put their listings under another store's name. The server refuses
    // too; this is so the row says why before anybody tries.
    return _asRole('ceo', 'CORP', function () {
        var keepD = _b2bModalDeal, keepI = _b2bModalItems;
        try {
            _b2bModalDeal = _b2bSplitDeal();
            _b2bModalItems = [
                { id: 'i1', line_no: 1, sku: 'A-1', quantity: 2, listed_qty: 1, listing_store: 'OVL' },
                { id: 'i2', line_no: 2, sku: 'A-2', quantity: 3, listed_qty: 0, listing_store: 'MPL' },
            ];
            var host = document.createElement('div');
            host.innerHTML = '<div id="b2bMoveLinesBody"></div><div id="b2bMoveLinesFooter"></div>';
            document.body.appendChild(host);
            try {
                _b2bMoveSel = {}; _b2bMoveTo = null;
                _b2bPaintMoveLines();
                var html = document.getElementById('b2bMoveLinesBody').innerHTML;
                var rows = html.split('b2b-moverow');
                if (html.indexOf('locked') === -1) return 'a listed line is not locked';
                if (html.indexOf('already listed') === -1) return 'it does not say why';
                // The locked row must not be clickable.
                return rows[1].indexOf('onclick="b2bMoveToggle') === -1
                    || 'the locked row is still clickable';
            } finally { host.remove(); }
        } finally { _b2bModalDeal = keepD; _b2bModalItems = keepI; _b2bMoveSel = {}; }
    });
});
t('3.9.0 a move names the store it came from and goes through the audit path', function () {
    var src = _srcOf(b2bMoveLines);
    if (src.indexOf('transfer_items') === -1) return 'not calling the server action';
    return src.indexOf('to_store') > -1 || 'no destination sent';
});

// Completion: per store, and labelled as such.
t('3.9.0 a store completing a split deal completes its own part', function () {
    return _asRole('manager', 'MPL', function () {
        var src = _srcOf(b2bCompleteDeal);
        return src.indexOf('caller_store') > -1
            || 'the server is not told whose part is finished';
    });
});
t('3.9.0 the button says whose part it finishes', function () {
    var src = _srcOf(_b2bStageListing);
    // Rendered inside the listing stage; assert on the string the renderer holds.
        return src.indexOf('My Part Is Done') > -1
        || 'the split label is missing';
});

// Nick, 2026-09-10: "Remove the open in email button. Instead just have the copy
// quote button and the mark accepted button."
t('3.9.0 the mail-draft route is gone entirely, not just hidden', function () {
    // Removed rather than left unreachable: the mailto never carried the quote
    // (the draft opened blank and you pasted into it), so it was always Copy
    // Quote plus a dialog -- and Copy Quote records the send on its own.
    if (typeof b2bSendQuote !== 'undefined') return 'b2bSendQuote still exists';
    if (typeof b2bOpenDraft !== 'undefined') return 'b2bOpenDraft still exists';
    return typeof _b2bShowSendStep === 'undefined' || 'the send-step dialog still exists';
});
t('3.9.0 the quote screens keep Copy Quote and Mark Accepted', function () {
    // Source rather than rendered DOM: _b2bStageQuote paints into the deal modal
    // shell, which only exists in operations.html -- so in this suite the
    // innerHTML would read back empty and the check would pass for the wrong
    // reason. The strings live in the renderer either way.
    var src = _srcOf(_b2bStageQuote);
    if (/Open In Email/.test(src)) return 'Open In Email is still rendered';
    if (/b2bSendQuote/.test(src)) return 'the mail-draft handler is still wired up';
    if (src.indexOf('b2bCopyQuote') === -1) return 'Copy Quote is not on the quote screens';
    return src.indexOf('b2bAcceptQuote') > -1 || 'Mark Accepted is not on the quote screens';
});
t('3.9.0 nothing left points the user at a button that is gone', function () {
    // The clipboard-blocked message used to say "use Open In Email instead",
    // which would now be advice to press something that does not exist.
    var src = _srcOf(b2bCopyQuote);
    if (/Open In Email/.test(src)) return 'the copy fallback still names the removed button';
    return /Copy Quote again|by hand/.test(src) || 'the fallback offers no way through';
});
// Nick, 2026-09-10: "You can actually remove the whole overview tab and the
// 'mark paid' feature. Niether of which are used nor necessary." And, of the
// quote: "The quote will never be sent by hand. You can remove that as well."
//
// Replaces the checks that guarded those features. A removal needs pinning as
// much as an addition does -- these all had real behaviour worth protecting
// while they existed, and nothing stops them being reintroduced by halves.
t('3.9.0 the Overview tab is gone, tab and renderer alike', function () {
    if (typeof _b2bRenderOverview !== 'undefined') return 'the renderer still exists';
    if (typeof _b2bCanOverview !== 'undefined') return 'the role gate still exists';
    var src = _srcOf(b2bRender) + _srcOf(b2bSetView);
    return src.indexOf("'overview'") === -1 || 'the view router still knows about it';
});
t('3.9.0 mark-paid is gone, and nothing still reads a payment', function () {
    if (typeof b2bMarkPaid !== 'undefined') return 'the handler still exists';
    if (typeof B2B_PAY_TRACKED_FROM !== 'undefined') return 'the tracking cutoff is still here';
    // The deal summary used to print a Paid row.
    return _srcOf(_b2bSummary).indexOf('paid_at') === -1 || 'the summary still prints a payment';
});
t('3.9.0 sent-by-hand is gone from every quote screen', function () {
    if (typeof b2bMarkQuoteSent !== 'undefined') return 'the handler still exists';
    var src = _srcOf(_b2bStageReview) + _srcOf(_b2bStageQuote);
    return src.indexOf('b2bMarkQuoteSent') === -1 || 'a screen still offers it';
});
t('3.9.0 the dead address field went with the mail route', function () {
    // b2bQuoteTo was only ever READ by the removed mailto. Left behind it would
    // ask for a client's email address and then do nothing with it, which is
    // worse than not asking.
    var src = _srcOf(_b2bStageReview) + _srcOf(_b2bStageQuote);
    return src.indexOf('b2bQuoteTo') === -1 || 'the send bar still asks for an address';
});

// Two bugs Nick hit on the first real split, both silent -- nothing threw, the
// screens just said the wrong thing.
t('3.9.0 a split deal never reads as being at CORP', function () {
    // listing_store is NULL on a split (one column cannot hold two stores), so
    // `listing_store || pricing_store` fell through to the pricing store -- and
    // a deal split at the listing step is one CORP priced. Every board row then
    // claimed the goods were at head office.
    var d = { listing_store: null, listing_stores: ['MPL', 'OVL'], pricing_store: 'CORP' };
    var tag = _b2bDealStoreTag(d);
    if (/CORP/.test(tag)) return 'a split deal still shows CORP';
    if (tag.indexOf('MPL') === -1 || tag.indexOf('OVL') === -1) return 'not both stores: ' + tag;
    // And the unsplit paths still work.
    if (/OVL/.test(_b2bDealStoreTag({ listing_store: 'OVL', listing_stores: ['OVL'], pricing_store: 'CORP' })) === false) {
        return 'a single-store deal lost its store';
    }
    return /CORP/.test(_b2bDealStoreTag({ listing_store: null, listing_stores: [], pricing_store: 'CORP' }))
        || 'a deal with no listing store yet should still show where it is priced';
});
t('3.9.0 no board row falls back to the pricing store any more', function () {
    var src = _srcOf(_b2bRenderQueue) + _srcOf(_b2bRenderPipeline)
            + _srcOf(_b2bRenderFinished) + _srcOf(_b2bRenderClients);
    return src.indexOf('listing_store || d.pricing_store') === -1
        || 'a list still writes the fallback inline';
});
t('3.9.0 corp can open the listing screen and see both halves', function () {
    // Corp has no store, so _b2bListsHere is false for every deal and a CEO fell
    // through to null -- _b2bClickKind then returned 'view' and opened the
    // read-only sheet instead of the listing screen.
    return _asRole('ceo', 'CORP', function () {
        var d = { stage: 'listing', listing_store: null, listing_stores: ['MPL', 'OVL'] };
        var act = _b2bActionFor(d);
        if (!act || act.kind !== 'listing') return 'corp gets no listing screen on a split deal';
        // And corp's fetch stays unscoped, which is what makes "both halves" true.
        return _b2bScopeQs() === '' || 'corp is scoping itself to one store';
    });
});
t('3.9.0 a store still sees only its own half', function () {
    return _asRole('manager', 'MPL', function () {
        var d = { stage: 'listing', listing_store: null, listing_stores: ['MPL', 'OVL'] };
        if (!_b2bActionFor(d)) return 'MPL cannot list its own half';
        if (_b2bScopeQs() !== '&store=MPL') return 'a store is not scoping its fetch';
        // A store with nothing on the deal gets nothing.
        return _asRole('manager', 'BAL', function () {
            return !_b2bActionFor(d) || 'BAL can list a deal it has no lines on';
        });
    });
});
t('3.9.0 the where-line says split instead of "not chosen yet"', function () {
    var html = _b2bWhereLine({ pricing_store: 'CORP', listing_store: null,
                               listing_stores: ['MPL', 'OVL'] });
    if (html.indexOf('chosen once the client accepts') > -1) {
        return 'a deal already split still says its listing store is to come';
    }
    return html.indexOf('split across') > -1 || 'the where-line does not mention the split';
});

// Nick, 2026-09-10, on the pipeline at a glance: "from a stores PoV: it looks
// like any other B2B deal, just with only the items that were assigned... From
// CORP POV: its broken into several progress bars labled by each store that it
// got split into, and when one of them completes their section it just is
// replaced with 'complete' instead of the progress bar on that segment."
function _b2bCardDeal(over) {
    var d = {
        id: 'c1', ref: 'SPL-002', stage: 'listing',
        listing_store: null, listing_stores: ['LEE', 'OVL'],
        total_units: 10, listed_units: 3, recycled_units: 0,
        listing_parts: [
            { store: 'LEE', total_units: 4, listed_units: 1, recycled_units: 0, completed_at: null },
            { store: 'OVL', total_units: 6, listed_units: 6, recycled_units: 0,
              completed_at: '2026-09-10T10:00:00Z', completed_by: 'Ethan' },
        ],
    };
    Object.keys(over || {}).forEach(function (k) { d[k] = over[k]; });
    return d;
}
t('3.9.0 corp gets a labelled bar per store on the pipeline card', function () {
    return _asRole('ceo', 'CORP', function () {
        var html = _b2bCardBar(_b2bCardDeal(), 'listing');
        if (html.indexOf('b2b-card-parts') === -1) return 'no per-store rows';
        if (html.indexOf('LEE') === -1 || html.indexOf('OVL') === -1) return 'a store is not labelled';
        // LEE is 1 of 4 and unfinished, so it keeps a bar and a count.
        return html.indexOf('1/4') > -1 || 'the unfinished store shows no progress';
    });
});
t('3.9.0 a finished store is replaced by Complete, not a full bar', function () {
    // A 100% bar and a finished one look identical at a glance, and the
    // difference is exactly what corp is scanning for.
    return _asRole('ceo', 'CORP', function () {
        var html = _b2bCardBar(_b2bCardDeal(), 'listing');
        var ovl = html.slice(html.indexOf('OVL'));
        if (ovl.indexOf('b2b-card-part-done') === -1) return 'the finished store still shows a bar';
        return ovl.indexOf('6/6') === -1 || 'the finished store still shows a count';
    });
});
t('3.9.0 a store sees one bar, and it is its own', function () {
    return _asRole('manager', 'LEE', function () {
        var html = _b2bCardBar(_b2bCardDeal(), 'listing');
        if (html.indexOf('b2b-card-parts') > -1) return 'a store is shown the other store rows';
        if (html.indexOf('OVL') > -1) return 'another store leaked onto the card';
        // LEE is 1 of 4 = 25%, NOT the deal's 3 of 10 = 30%.
        if (html.indexOf('width:25%') === -1) return 'showing the deal total, not their part: ' + html;
        return true;
    });
});
t('3.9.0 a store that has finished sees Complete', function () {
    return _asRole('manager', 'OVL', function () {
        return _b2bCardBar(_b2bCardDeal(), 'listing').indexOf('Complete') > -1
            || 'a finished store still sees a progress bar';
    });
});
t('3.9.0 an unsplit deal keeps the plain bar it always had', function () {
    return _asRole('ceo', 'CORP', function () {
        var d = _b2bCardDeal({ listing_store: 'OVL', listing_stores: ['OVL'],
            listing_parts: [{ store: 'OVL', total_units: 10, listed_units: 3,
                              recycled_units: 0, completed_at: null }] });
        var html = _b2bCardBar(d, 'listing');
        if (html.indexOf('b2b-card-parts') > -1) return 'one store should not get a breakdown';
        return html.indexOf('b2b-pace-bar') > -1 || 'the plain bar is gone';
    });
});
t('3.9.0 no bar outside the listing column', function () {
    return _b2bCardBar(_b2bCardDeal({ stage: 'pricing' }), 'pricing') === ''
        || 'a progress bar is drawn on a stage that has no listing progress';
});
// Restore the fixture for anything appended after this point.
_b2bModalDeal = B2B_FIXTURE_DEAL;
_b2bModalItems = b2bFixtureItems();
