// ============================================================================
// mirror-fix.gs — AUG 26. The day the eBay refunds came BACK into Shopify.
//
// ⚠️ READ THE OTHER THREE FIRST. mpc-dupe-fix.gs (BAL/MPL Aug 16-20),
// newmc-store-fix.gs (Aug 15-24, every store) and newmc-dupe-fix.gs (Aug 25 +
// MPL 21 + two Aug 24 supersedes) between them already lock Aug 15-25. This
// file adds ONE day and deliberately writes nothing else.
//
// WHAT HAPPENED ON AUG 26, and it is a different mechanism from the other two
// incidents. We refunded 396 phantom Shopify orders on Aug 20/24/25. PayMore's
// reconciler replayed those refunds onto the REAL eBay orders. The new
// Marketplace Connect then pulled those eBay refunds BACK into Shopify — 237
// refunds, $43,992.52, landing on the REAL orders, almost all sold days
// earlier. Four of five stores went negative on the day. Nobody keyed anything
// wrong and no store did anything wrong.
//
// A third thing also lands on Aug 26: buyers accepting an invoice to repay the
// money they were wrongly refunded. That is recovery of a loss, not selling,
// so it comes out of the day's SALES and belongs on the loss sheet instead.
//
// HOW THE FIGURES WERE DERIVED (edge function `sales-true-daily`, re-runnable):
//   true(day) = dupe-restate's corrected figure          (phantoms erased)
//             + refunds on a PROVEN duplicate pair       (added back)
//             − draft orders that are repayment invoices (taken out)
//
// ⚠️ THREE THINGS ARE DELIBERATELY LEFT IN THE STORES' FIGURES:
//   * Genuine customer returns. A store that took a real return really did
//     lose that sale.
//   * Refunds on the three OVL orders the store CAUGHT before shipping (the
//     MacBook, the Ray-Bans, the turntable). eBay refunded the buyer and we
//     kept the goods, so the sale genuinely reversed. Adding those back would
//     credit OVL for an item on its own shelf and then credit it again when it
//     resold — the MacBook resold as #KS01-14308 and the turntable as
//     #KS01-14305, both on Aug 25.
//   * Draft orders dated BEFORE Aug 26. The stores confirm no repayment
//     invoices went out before then, so LEE #MO01-8920 ($499.99, Aug 20),
//     WSP #MO02-6682 ($599.99, Aug 20) and BAL #MO04-2847 ($124.99, Aug 24)
//     are ordinary invoiced sales. From Aug 26 EVERY draft is a repayment and
//     is voided, including LEE #MO01-9161 ($1,549.99) which matches no refund
//     amount — the stores know what they invoiced and that outranks the
//     amount test, which is now reported only.
//     ⚠️ That rule has a shelf life: when repayment invoicing finishes,
//     ordinary draft sales resume and this would strip them. Every voided
//     draft is listed individually so the day that starts happening is visible.
//   Each of those was a live bug at some point in the derivation. Removing any
//   of them understates a store for a day it traded normally.
//
// PROOF: OVL Aug 25 independently recomputes to 7,820.64 / 4,260.01, matching
// newmc-dupe-fix.gs to the cent, and MPL/BAL Aug 16-20 reproduce
// mpc-dupe-fix.gs on 10 of 10 cells. dupe-restate reports month sales_delta = 0
// at all five stores. Corrected margin for Aug 15-26 is 55.10%, in line with
// these stores' normal range; before correction four of them had negative days.
//
// ⚠️ WHY ONLY AUG 26 IS WRITTEN. The preview reports Aug 15-26 so nothing is
// hidden, but four earlier cells are KNOWN to differ and the EXISTING PIN IS
// THE RIGHT ONE: LEE Aug 19/24 by ±88.99 (#MO01-9103) and BAL Aug 22/24 by
// ±699.99 (#MO04-2844). Both are duplicates that were refunded OUTSIDE
// dup_order_cleanup, so they carry a positive and a negative leg; the pin
// strips both and a ledger-based recomputation strips neither. Net zero across
// the month — a day-split difference only. Do not "correct" them.
//
// THE LOCK IS THE WORKBOOK'S OWN CONVENTION: each figure is written as a
// bare-number formula (`=2950.26`). The daily importer refuses to overwrite a
// formula cell; month-rollover.gs's _mrIsBareNumberFormula counts it as typed,
// so the rollover still CLEARS it and September starts empty.
//
// ⚠️ NOTES ARE THE PART THE ROLLOVER DOES NOT CLEAR. It builds each new tab
// with copyTo(), which carries notes verbatim, so September would inherit
// these on its own 26th. Run mrfClearCarriedNotes() after any rollover — it
// strips all four fixes' note texts from every tab EXCEPT the August one.
//
// TO RUN: paste into the Apps Script project, then Run → mrfFixPreview (writes
// nothing, logs every cell) and, once it reads right, Run → mrfFixApply.
// No deployment is involved — this is not part of the web app.
//
// Prefixed MRF_/_mrf throughout: one Apps Script project is one global scope,
// and a collision with the other fixes or the importer would silently read a
// different geometry.
// ============================================================================

var MRF_SHEET_ID = '1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8';  // Sales Summary 2026
var MRF_TAB      = 'Sales Aug 26';

// Same geometry as the importer, restated here so this file stands alone.
var MRF_BASES       = { OVL: 0, LEE: 11, WSP: 22, MPL: 33, BAL: 44 };
var MRF_COL_SALES   = 1;   // base + 1
var MRF_COL_COST    = 4;   // base + 4
var MRF_HEADER_ROWS = 4;   // day rows start here; the row is still LOCATED by day number

var MRF_NOTE = 'MC mirror-back fix (Aug 26) — real figure. Locked from the daily sync.';

// Every earlier fix's note. A cell carrying one of these belongs to that
// script and must never be rewritten here.
var MRF_OTHER_NOTES = [
  'MPC dupe error fix — real figure. Locked from the daily sync.',
  'New-MC dupe fix (Aug 24-25) — real figure. Locked from the daily sync.',
  // ⚠️ newmc-store-fix.gs's note was MISSING from this list until 2026-08-27.
  // It owns Aug 15-24 at every store — the largest block of pins in the month —
  // so its absence meant those cells were protected only by luck (nothing in
  // MRF_FIX happened to point at one). BAL Aug 24 now does. See MRF_FORCE.
  'New-MC adoption dupe fix — real figure. Locked from the daily sync.'
];

// Aug 26, and one Aug 24 cell. Sales / cost, from sales-true-daily 2026-08-27.
var MRF_FIX = [
  { store: 'OVL', day: 26, sales: 2950.26, cost: 1143.54 },  // sheet reads -10211.82 / -4578.25
  { store: 'LEE', day: 26, sales: 4163.22, cost: 1956.68 },  // sheet reads -10352.96 / -4149.99
  { store: 'WSP', day: 26, sales: 3373.80, cost: 1525.00 },  // sheet reads   1508.86 /   605.00
  { store: 'MPL', day: 26, sales: 1516.92, cost:  734.00 },  // sheet reads  -3722.89 / -1501.30
  { store: 'BAL', day: 26, sales: 1301.25, cost:  570.32 },  // sheet reads  -2158.59 /  -974.68

  // -------------------------------------------------------------------------
  // BAL AUG 24 — +124.99 / +52.00, and the ONLY pre-Aug-26 cell this file moves.
  // -------------------------------------------------------------------------
  // eBay 13-15066-46687 has TWO Shopify orders and BOTH were refunded: our own
  // #MO04-2821 (SPEEKS Connect, cancelled 17:08) and the new-MC phantom
  // #MO04-2836 (cancelled 17:17, nine minutes later, in the same cleanup pass).
  // The phantom is already out of the pin. The pin ALSO leaves our copy's refund
  // in, as one of the "three genuine returns" newmc-store-fix.gs recorded on
  // this day. It is not a return.
  //
  // PROOF: dupe-order-trace reports CONTRADICTION on this eBay order. Both
  // Shopify copies read UNFULFILLED with no tracking, but eBay holds a real USPS
  // number, 92346902673388000088429465, shipped 2026-08-24T14:43Z — two and a
  // half hours BEFORE either cancellation. The parcel went out. The buyer has
  // the goods and the money.
  //
  // So the sale is real and stays in the day; the $124.99 is loss, and belongs
  // on the loss sheet, not netted out of what BAL sold. A cancelled Shopify
  // order is not evidence a parcel never shipped — only an eBay tracking NUMBER
  // settles that.
  { store: 'BAL', day: 24, sales: 3502.71, cost: 1136.00 }   // pin says 3377.72 / 1084.00
];

// Cells in MRF_FIX that an earlier fix's note owns, and that we overwrite
// anyway. Nothing may be added here without the evidence written out above it —
// the note guard exists precisely to stop casual restatement of a locked day.
var MRF_FORCE = { 'BAL:24': true };

// Reported by the preview but NEVER written — the existing pin is correct.
// See the header: un-cleaned duplicates that carry both a positive and a
// negative leg, so a ledger-based recomputation cannot strip them.
var MRF_KNOWN_DIFFERENT = [
  { store: 'LEE', day: 19, why: '#MO01-9103 +88.99  — pin is right (cost agrees to the cent)' },
  { store: 'LEE', day: 24, why: '#MO01-9103 -88.99  — pin is right (cost agrees to the cent)' },
  { store: 'BAL', day: 22, why: '#MO04-2844 +699.99 / +300.00 — pin is right' },
  { store: 'BAL', day: 24, why: '#MO04-2844 -699.99 / -300.00 — pin is right. The OTHER half of this day, +124.99 / +52.00, IS written — see MRF_FIX' },
  { store: 'WSP', day: 15, why: 'cost +900.00 is hand-entered for a directly-listed eBay item Shopify carries no COGS for — pin is right, and WSP Aug 15 must never be recomputed' },
  { store: 'LEE', day: 25, why: 'sales -0.47 — too small to justify moving a locked cell; pin stands' }
];

function mrfFixPreview() { _mrfRun(true); }
function mrfFixApply()   { _mrfRun(false); }

// Locate the row by matching the day number in the block's OWN date column —
// never by arithmetic from a start row. Somebody inserting a row above the grid
// would otherwise shift every write and corrupt a month silently.
function _mrfFindDayRow(values, base, day) {
  for (var r = MRF_HEADER_ROWS; r < values.length; r++) {
    var first = String(values[r][0]).trim().toUpperCase();
    if (first === 'TTL' || first.indexOf('TRACKING') === 0) break;   // past the day rows
    if (parseInt(values[r][base], 10) === day) return r;
  }
  return -1;
}

function _mrfIsBareNumber(f) {
  if (!f) return false;
  var body = String(f).replace(/^=/, '').trim();
  if (!body) return false;
  if (/[A-Za-z]/.test(body)) return false;
  var ALLOWED = '0123456789 .,+-*/()';
  for (var i = 0; i < body.length; i++) {
    if (ALLOWED.indexOf(body.charAt(i)) < 0) return false;
  }
  return true;
}

function _mrfRun(dryRun) {
  var ss = SpreadsheetApp.openById(MRF_SHEET_ID);
  var sh = ss.getSheetByName(MRF_TAB);
  if (!sh) { Logger.log('NO TAB NAMED "' + MRF_TAB + '" — nothing done.'); return; }

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();
  var notes    = sh.getRange(1, 1, lastRow, lastCol).getNotes();

  var wrote = 0, skipped = 0, already = 0;
  Logger.log(dryRun ? '=== PREVIEW — nothing will be written ===' : '=== APPLYING ===');

  for (var i = 0; i < MRF_FIX.length; i++) {
    var f = MRF_FIX[i];
    var base = MRF_BASES[f.store];
    if (base === undefined) { Logger.log('  ' + f.store + ': unknown store, skipped'); skipped++; continue; }

    var r = _mrfFindDayRow(values, base, f.day);
    if (r < 0) { Logger.log('  ' + f.store + ' day ' + f.day + ': ROW NOT FOUND, skipped'); skipped++; continue; }

    var pairs = [
      { col: base + MRF_COL_SALES, want: f.sales, what: 'sales' },
      { col: base + MRF_COL_COST,  want: f.cost,  what: 'cost'  }
    ];
    for (var p = 0; p < pairs.length; p++) {
      var c = pairs[p].col, want = pairs[p].want;
      var cur = values[r][c], curF = formulas[r][c], note = String(notes[r][c] || '');

      // Another fix owns this cell. Never touch it.
      var owned = false;
      for (var n = 0; n < MRF_OTHER_NOTES.length; n++) {
        if (note.indexOf(MRF_OTHER_NOTES[n]) === 0) owned = true;
      }
      if (owned && MRF_FORCE[f.store + ':' + f.day]) {
        Logger.log('  ' + f.store + ' ' + f.day + ' ' + pairs[p].what
                   + ': owned by an earlier fix, OVERRIDDEN ON PURPOSE (MRF_FORCE)');
        owned = false;
      }
      if (owned) {
        Logger.log('  ' + f.store + ' ' + f.day + ' ' + pairs[p].what + ': OWNED BY AN EARLIER FIX, skipped');
        skipped++; continue;
      }
      // A real formula (not a bare number) is somebody's calculation.
      if (curF && !_mrfIsBareNumber(curF)) {
        Logger.log('  ' + f.store + ' ' + f.day + ' ' + pairs[p].what + ': REAL FORMULA ' + curF + ', skipped');
        skipped++; continue;
      }
      if (Math.abs(Number(cur) - want) < 0.005) {
        Logger.log('  ' + f.store + ' ' + f.day + ' ' + pairs[p].what + ': already ' + want);
        already++; continue;
      }
      Logger.log('  ' + f.store + ' ' + f.day + ' ' + pairs[p].what + ': ' + cur + '  ->  ' + want
                 + (curF ? '   (was locked ' + curF + ')' : ''));
      if (!dryRun) {
        var cell = sh.getRange(r + 1, c + 1);
        cell.setFormula('=' + want);   // bare-number formula: the workbook's own lock
        cell.setNote(MRF_NOTE);
      }
      wrote++;
    }
  }

  Logger.log('--- known-different cells, REPORTED ONLY, never written ---');
  for (var k = 0; k < MRF_KNOWN_DIFFERENT.length; k++) {
    var d = MRF_KNOWN_DIFFERENT[k];
    Logger.log('  ' + d.store + ' Aug ' + d.day + ': ' + d.why);
  }
  Logger.log((dryRun ? 'PREVIEW: ' : 'DONE: ') + wrote + ' cell(s) ' + (dryRun ? 'would change' : 'written')
             + ', ' + already + ' already correct, ' + skipped + ' skipped.');
  if (dryRun) Logger.log('Run mrfFixApply() to write.');
}

// ---------------------------------------------------------------------------
// The rollover carries NOTES forward (copyTo copies them), even though it
// correctly clears the bare-number VALUES. Run this after any rollover so
// September does not inherit August's corrections as annotations on days that
// have not happened yet. Skips the August tab, so it can never touch the fixes.
// ---------------------------------------------------------------------------
function mrfClearCarriedNotes() {
  var ss = SpreadsheetApp.openById(MRF_SHEET_ID);
  var all = [MRF_NOTE].concat(MRF_OTHER_NOTES);
  var sheets = ss.getSheets(), cleared = 0;
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    if (sh.getName() === MRF_TAB) continue;              // never the month we fixed
    if (sh.getName().indexOf('Sales ') !== 0) continue;  // only month tabs
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (!lastRow || !lastCol) continue;
    var rng = sh.getRange(1, 1, lastRow, lastCol);
    var notes = rng.getNotes(), touched = false;
    for (var r = 0; r < notes.length; r++) {
      for (var c = 0; c < notes[r].length; c++) {
        var nt = String(notes[r][c] || '');
        if (!nt) continue;
        for (var a = 0; a < all.length; a++) {
          if (nt.indexOf(all[a]) === 0) { notes[r][c] = ''; touched = true; cleared++; break; }
        }
      }
    }
    if (touched) { rng.setNotes(notes); Logger.log('cleared notes on "' + sh.getName() + '"'); }
  }
  Logger.log('mrfClearCarriedNotes: ' + cleared + ' note(s) cleared.');
}
