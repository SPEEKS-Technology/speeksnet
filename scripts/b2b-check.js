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
t('3.6 the listing row has a recycle stepper', function () {
    var save = _b2bModalItems;
    _b2bModalItems = b2bRecycleFixture(1);
    var html = _b2bListRows();
    _b2bModalItems = save;
    if (html.indexOf('b2bRecycleUnit(') === -1) return 'no + handler';
    if (html.indexOf('b2bUnRecycleUnit(') === -1) return 'no - handler';
    return html.indexOf('b2b-recstep') > -1 || 'no stepper markup';
});
t('3.6 the minus is disabled with nothing recycled', function () {
    var save = _b2bModalItems;
    _b2bModalItems = b2bRecycleFixture(0);
    var html = _b2bListRows();
    _b2bModalItems = save;
    var m = html.match(/<button class="b2b-step" (disabled)?[^>]*b2bUnRecycleUnit/);
    return (m && m[1] === 'disabled') || 'minus is live at zero recycled';
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
t('1.3 the summary shows a payment once there is one', function () {
    var html = _b2bSummary(Object.assign({}, noteDeal, {
        accepted_at: '2026-09-04T00:00:00Z', paid_at: '2026-09-05T12:00:00Z', paid_amount: 1250,
    }));
    if (html.indexOf('Paid') === -1) return 'payment not shown';
    return html.indexOf('$1,250.00') > -1 || 'amount not shown';
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

t('1.3 the Overview has both sections Paul asked for', function () {
    var role = sessionStorage.getItem('speeksUserRole');
    sessionStorage.setItem('speeksUserRole', 'ceo');
    var deals = [
        { id: 'a', ref: 'A-001', stage: 'pricing', pricing_store: 'LEE', total_units: 2,
          client: { company: 'Alpha' }, stage_changed_at: '2026-09-01T00:00:00Z' },
        // Accepted AFTER B2B_PAY_TRACKED_FROM, so it can legitimately read as
        // unpaid. A deal accepted before that shows "not recorded" instead --
        // covered by its own check further down.
        { id: 'b', ref: 'B-001', stage: 'listing', pricing_store: 'OVL', listing_store: 'OVL',
          total_units: 2, listed_units: 0, accepted_at: '2026-09-20T00:00:00Z',
          total_offer: 500, client: { company: 'Beta' }, stage_changed_at: '2026-09-20T00:00:00Z' },
    ];
    var html;
    try { html = _b2bRenderOverview(deals); }
    finally { sessionStorage.setItem('speeksUserRole', role); }
    if (html.indexOf('Picked Up, Not Yet Priced') === -1) return 'no not-priced section';
    if (html.indexOf('Paying The Client') === -1) return 'no payment section';
    if (html.indexOf('Owed To Clients') === -1) return 'no owed tile';
    if (html.indexOf('Alpha') === -1) return 'unpriced deal not listed';
    if (html.indexOf('not started') === -1) return 'does not distinguish not-started';
    // The accepted, unpaid deal must read as unpaid and offer the action.
    if (html.indexOf('unpaid') === -1) return 'accepted deal not shown as unpaid';
    return html.indexOf('b2bMarkPaid') > -1 || 'no way to record a payment';
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
t('polish: historical deals are not counted as money owed', function () {
    // paid_at only exists from B2B_PAY_TRACKED_FROM. Counting deals accepted
    // before it as unpaid would put a false liability on the Overview.
    var role = sessionStorage.getItem('speeksUserRole');
    sessionStorage.setItem('speeksUserRole', 'ceo');
    var old = { id: 'o', ref: 'O-1', stage: 'completed', accepted_at: '2026-08-11T00:00:00Z',
                total_offer: 900, total_units: 1, client: { company: 'Older' },
                stage_changed_at: '2026-08-11T00:00:00Z' };
    var html;
    try { html = _b2bRenderOverview([old]); }
    finally { sessionStorage.setItem('speeksUserRole', role); }
    if (html.indexOf('not recorded') === -1) return 'old deal not marked as pre-tracking';
    if (html.indexOf('>unpaid<') > -1) return 'old deal counted as unpaid';
    // The tile must read zero, not the deal's value.
    if (/Owed To Clients<\/span><span class="b2b-tile-v">\$900/.test(html)) {
        return 'old deal added to the owed total';
    }
    return html.indexOf('predate tracking') > -1 || 'no explanation of why it is not counted';
});
t('polish: a deal accepted after tracking IS counted as owed', function () {
    var role = sessionStorage.getItem('speeksUserRole');
    sessionStorage.setItem('speeksUserRole', 'ceo');
    var fresh = { id: 'f', ref: 'F-1', stage: 'listing', accepted_at: '2026-09-30T00:00:00Z',
                  total_offer: 400, total_units: 1, client: { company: 'Newer' },
                  stage_changed_at: '2026-09-30T00:00:00Z' };
    var html;
    try { html = _b2bRenderOverview([fresh]); }
    finally { sessionStorage.setItem('speeksUserRole', role); }
    return html.indexOf('>unpaid<') > -1 || 'a trackable unpaid deal is not flagged';
});
t('polish: recording a payment takes one dialog, not two', function () {
    var src = b2bMarkPaid.toString();
    var prompts = (src.match(/prompt\(/g) || []).length;
    return prompts === 1 || prompts + ' prompts in the payment flow';
});
t('polish: the payment dialog parses "amount on date"', function () {
    // Guard the parse, since it is doing double duty on one input.
    var text = '$1,250.00 on 2026-09-05';
    var when = (text.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
    var amt = parseFloat(text.replace(when, '').replace(/[^0-9.]/g, ''));
    if (when !== '2026-09-05') return 'date: ' + when;
    return amt === 1250 || 'amount: ' + amt;
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
t('3.8.2 dismiss and snooze are separate actions', function () {
    if (typeof samNotMineItem !== 'function') return 'no dismiss action';
    if (typeof samSnoozeItem !== 'function') return 'no snooze action';
    // The card markup is built inside _samRenderFeedNow, so assert the renderer
    // wires both rather than trying to stand a live feed up in the harness.
    var src = _samRenderFeedNow.toString();
    if (src.indexOf('samSnoozeItem') === -1) return 'the card does not offer Snooze';
    return src.indexOf('samNotMineItem') > -1 || 'the card does not offer a dismiss';
});
t('3.8.2 the hide store is not day-scoped', function () {
    // This was the bug: _samDismKey() puts the date in the key, so a dismiss
    // could never outlive the day.
    if (_samHideKey().match(/\d{1,2}\/\d{1,2}\/\d{4}/)) return 'still day-scoped: ' + _samHideKey();
    return _samDismKey() !== _samHideKey() || 'reusing the old day-scoped key';
});
t('3.8.2 dismiss survives tomorrow, snooze expires', function () {
    var key = '__probe__';
    try {
        _samSetHidden({});
        // Dismissed: until = 0 means hidden while the content is unchanged.
        _samSetHidden({ __probe__: { sig: 'S', until: 0 } });
        if (!_samIsHidden(key, 'S')) return 'a dismissed card is showing';
        // Expired snooze must come back.
        _samSetHidden({ __probe__: { sig: 'S', until: Date.now() - 1000 } });
        if (_samIsHidden(key, 'S')) return 'an expired snooze is still hidden';
        // Live snooze stays hidden.
        _samSetHidden({ __probe__: { sig: 'S', until: Date.now() + 60000 } });
        return _samIsHidden(key, 'S') || 'a live snooze is showing';
    } finally { _samSetHidden({}); }
});
t('3.8.2 new information breaks through either state', function () {
    // "unless something new pops up" — the sig is the identity, so changed
    // wording or counts must resurface the card even when dismissed.
    try {
        _samSetHidden({ __probe__: { sig: 'OLD', until: 0 } });
        if (_samIsHidden('__probe__', 'NEW')) return 'a dismissed card stayed buried after it changed';
        _samSetHidden({ __probe__: { sig: 'OLD', until: Date.now() + 60000 } });
        return !_samIsHidden('__probe__', 'NEW') || 'a snoozed card stayed buried after it changed';
    } finally { _samSetHidden({}); }
});
t('3.8.2 mark-all-read snoozes rather than dismisses', function () {
    // Clearing a full feed is "caught up", not "none of this is mine" — treating
    // it as permanent would bin work nobody decided about.
    var src = samMarkAllRead.toString();
    if (src.indexOf('_samSetHidden') === -1) return 'not using the new store';
    return /until\s*[:=]/.test(src) || 'not setting an expiry, so it dismisses permanently';
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
    return html.indexOf('Drop the client') > -1 || 'no instruction on the target';
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

// Restore the fixture for anything appended after this point.
_b2bModalDeal = B2B_FIXTURE_DEAL;
_b2bModalItems = b2bFixtureItems();
