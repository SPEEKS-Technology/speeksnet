// ============================================================================
// newmc-dupe-fix.gs — the AUG 25 tail of the new-Marketplace-Connect duplicate
// cleanup, for OVL, LEE, WSP and MPL.
//
// ⚠️ READ newmc-store-fix.gs FIRST. It already locked Aug 15–24 for every store,
// derived day by day with hand-verified notes on individual orders. This file
// exists ONLY because it could not cover Aug 25: it was written during that day,
// and its own header warns that a part-day figure is not a small error on a
// final one ("MPL read 957.59 midday and finished at 9756.42"). This is the
// after-midnight re-derivation it asks for, and nothing more.
//
// Aug 25 is the only day still holding raw importer values in the whole range —
// every other affected cell is already a bare-number lock. OVL Aug 25 currently
// reads -$22,690.58 and WSP -$6,774.55, because the reversal for the phantoms
// lands on the refund day. Nobody keyed anything wrong.
//
// mpc-dupe-fix.gs is the older sibling, for the FIRST duplicate incident
// (BAL/MPL Aug 16–20).
//
// HOW THE FIGURES WERE DERIVED (edge function `dupe-restate`, re-runnable):
//   corrected(day) = FROM sales SHOW net_sales, cost_of_goods_sold GROUP BY day
//                  − the same query GROUP BY order_name, restricted to the
//                    orders named in dup_order_cleanup for the new-MC batches
// Subtracted by SHOPIFY'S own day attribution, never by ebay_orders.sold_at.
// Grouping by order name removes the phantom sale AND its reversal wherever
// Shopify booked them, so no assumption about refund dating is needed.
//
// PROOF IT IS RIGHT: for all four stores the AUGUST MONTH TOTAL is identical
// before and after (OVL 139,165.02 / LEE 92,222.64 / WSP 110,168.99 /
// MPL 110,386.96, sales and cost both). The phantom sales and their reversals
// cancel exactly, so only the day-by-day split moves — MTD, % to goal, GP,
// margin and the rollover's carry-forward are all untouched.
//
// ⚠️ ONE QUERY PER DAY was essential. `GROUP BY day, order_name` across a whole
// month silently TRUNCATES on the busiest store: OVL's first pass dropped rows,
// and because the dropped ones included the large negative refund rows it
// produced a plausible-looking $27,026.13 "correction" that was pure artefact.
// dupe-restate now reconciles per-order sums back to per-day totals and refuses
// to report unless they match. Never trust a restatement that has not done that.
//
// ⚠️ MPL AND BAL AUG 16–20 ARE DELIBERATELY ABSENT. Those cells are already
// pinned by mpc-dupe-fix.gs. Their pins are bare-number formulas, so the
// overwrite guard alone would happily replace them — and the figure this run
// computes for those days is WRONG for the sheet, because it removes only the
// new-MC duplicates and not the earlier mc-backfill ones (MPL Aug 20 comes out
// at -3,368.80 against a correct, already-locked 3,102.89). NMF_PROTECTED
// refuses them by name as a second line of defence.
//
// THE LOCK IS THE WORKBOOK'S OWN CONVENTION: each figure is written as a
// bare-number formula (`=4404.11`). The daily importer refuses to overwrite a
// formula cell and logs `deliberate: true`; month-rollover.gs's
// _mrIsBareNumberFormula counts it as a typed value, so the rollover still
// clears it and September starts clean.
//
// TO RUN: paste into the Apps Script project, then Run → nmfFixPreview (writes
// nothing, logs every cell) and, once it reads right, Run → nmfFixApply.
// No deployment is involved — this is not part of the web app.
//
// Prefixed NMF_/_nmf throughout: one Apps Script project is one global scope,
// and a collision with sales-email-import.gs, month-rollover.gs or
// mpc-dupe-fix.gs would silently read a different geometry.
// ============================================================================

var NMF_SHEET_ID = '1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8';  // Sales Summary 2026
var NMF_TAB      = 'Sales Aug 26';

// Same geometry as the importer, restated here so this file stands alone.
var NMF_BASES       = { OVL: 0, LEE: 11, WSP: 22, MPL: 33, BAL: 44 };
var NMF_COL_SALES   = 1;   // base + 1
var NMF_COL_COST    = 4;   // base + 4
var NMF_HEADER_ROWS = 4;   // day rows start here; the row is still LOCATED by day number

var NMF_NOTE = 'New-MC dupe fix (Aug 24-25) — real figure. Locked from the daily sync.';
// The previous incident's note. A cell carrying it belongs to mpc-dupe-fix.gs
// and must never be touched by this script.
var MPC_NOTE_TEXT = 'MPC dupe error fix — real figure. Locked from the daily sync.';

// Days already corrected and pinned by mpc-dupe-fix.gs. Belt and braces.
var NMF_PROTECTED = { 'MPL': [16, 17, 18, 19, 20], 'BAL': [16, 17, 18, 19, 20] };

// AUG 25 ONLY. Every earlier day (OVL 15-24, LEE 16-24, WSP 16-24, MPL 22-24,
// BAL 21-24) is ALREADY LOCKED by newmc-store-fix.gs, which derived them
// day-by-day with hand-verified notes on individual orders. This file must not
// touch them — 43 of its cells matched that fix exactly, and the handful that
// did not are that script's deliberate decisions, not errors of its own.
//
// Aug 25 is missing there because that file was written DURING Aug 25, and its
// own header says a part-day figure is not a small error on a final one:
// "MPL read 957.59 midday and finished at 9756.42." These four rows are the
// after-midnight re-derivation it asks for. They are also the only cells in the
// whole range still unlocked — which is how you can tell nothing else is owed.
//
// BAL needs no Aug 25 row: no duplicate touched that day.
var NMF_FIX = [
  { store: 'OVL', day: 25, sales: 7820.64, cost: 4260.01 },   // sheet reads -22690.58 / -8771.85
  { store: 'LEE', day: 25, sales: 3994.58, cost: 1232.73 },   // sheet reads   3454.59 /   942.73
  { store: 'WSP', day: 25, sales: 5432.02, cost: 2765.00 },   // sheet reads  -6774.55 / -3130.57
  { store: 'MPL', day: 25, sales: 1318.27, cost:  543.00 },   // sheet reads    928.28 /   383.00

  // ⚠️ TWO AUG 24 ROWS THAT DELIBERATELY SUPERSEDE newmc-store-fix.gs PINS.
  // Not phantoms — GENUINE CUSTOMER REFUNDS that the lock froze out:
  //   OVL #KS01-13387  web order Jul 30, $244.99, refunded Aug 24 21:23
  //                    with the customer note "just didnt like it"
  //   WSP #MO02-6530   web order Aug 13,  $64.99, refunded Aug 24 19:26
  // A refund books to the REFUND day, so both belong on Aug 24. Each landed
  // after that store's pin was set, and a pinned cell is one the importer can
  // never correct — so the sheet has been overstating Aug 24 ever since.
  //
  // This is the cost of the lock, and it is worth stating plainly: pinning a day
  // protects it from phantoms AND from every genuine restatement that follows.
  // Any later return against Aug 15-24 will need the same manual treatment.
  //
  // Cost is unchanged on both (Shopify had already booked the cost side), so
  // those two cells will report "already correct" rather than being rewritten.
  { store: 'OVL', day: 24, sales: 9519.30, cost: 5349.05 },   // pin says 9764.29
  { store: 'WSP', day: 24, sales: 4834.91, cost: 2724.69 },   // pin says 4899.90

  // ⚠️ MPL AUG 21 — NOT an Aug 25 row, and not part of the original cleanup.
  // Two brand-new phantoms landed on it at 01:33 and 02:45 THIS MORNING
  // (#MO03-3088 = 439.99/180, a copy of our #MO03-2978; #MO03-3089 = 799.99/400,
  // a copy of our #MO03-2982). Shopify books them to their Aug 21 sale date, so
  // the day inflated from 4018.86 to 5258.84 overnight. MPL Aug 21 is the ONE
  // affected day with no pin on it — newmc-store-fix.gs covers MPL 22-24 only —
  // so it is the only place this new arrival can still reach the sheet.
  { store: 'MPL', day: 21, sales: 4018.86, cost: 1647.00 }    // sheet reads   5258.84 /  2227.00
];

function nmfFixPreview() { _nmfRun(true); }
function nmfFixApply()   { _nmfRun(false); }

// Locate the row by matching the day number in the block's OWN date column —
// never by arithmetic from a start row. Somebody inserting a row above the grid
// would otherwise shift every write and corrupt a month silently.
function _nmfFindDayRow(values, base, day) {
  for (var r = NMF_HEADER_ROWS; r < values.length; r++) {
    var first = String(values[r][0]).trim().toUpperCase();
    if (first === 'TTL' || first.indexOf('TRACKING') === 0) break;   // past the day rows
    if (parseInt(values[r][base], 10) === day) return r;
  }
  return -1;
}

// Is this formula one of ours (or an existing bare-number lock)? Anything else
// is somebody's real calculation and must not be touched.
function _nmfIsBareNumber(f) {
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

function _nmfIsProtected(store, day) {
  var list = NMF_PROTECTED[store];
  if (!list) return false;
  for (var i = 0; i < list.length; i++) if (list[i] === day) return true;
  return false;
}

function _nmfRun(dryRun) {
  var ss = SpreadsheetApp.openById(NMF_SHEET_ID);
  var sh = ss.getSheetByName(NMF_TAB);
  if (!sh) { Logger.log('NO TAB NAMED "' + NMF_TAB + '" — nothing done.'); return; }

  var fixes = NMF_FIX.slice();

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();
  var notes    = sh.getRange(1, 1, lastRow, lastCol).getNotes();

  var wrote = 0, already = 0, refused = 0;
  Logger.log((dryRun ? '=== PREVIEW (nothing written) ===' : '=== APPLYING ===') + '  tab: ' + NMF_TAB);
  Logger.log('cell     store day  field  holds now            ->  becomes');

  fixes.forEach(function (f) {
    var base = NMF_BASES[f.store];
    if (base == null) { Logger.log('unknown store ' + f.store); refused++; return; }
    if (_nmfIsProtected(f.store, f.day)) {
      Logger.log('REFUSED ' + f.store + ' day ' + f.day + ' — pinned by mpc-dupe-fix.gs');
      refused++; return;
    }
    var r = _nmfFindDayRow(values, base, f.day);
    if (r < 0) { Logger.log('no row for ' + f.store + ' day ' + f.day); refused++; return; }

    [{ col: base + NMF_COL_SALES, label: 'sales', want: f.sales },
     { col: base + NMF_COL_COST,  label: 'cost',  want: f.cost }].forEach(function (c) {
      var rng  = sh.getRange(r + 1, c.col + 1);
      var a1   = rng.getA1Notation();
      var curF = (formulas[r] || [])[c.col] || '';
      var curV = (values[r] || [])[c.col];
      var curN = (notes[r] || [])[c.col] || '';
      var want = '=' + c.want.toFixed(2);

      // A real formula (a reference or a function) is somebody's calculation.
      if (curF && !_nmfIsBareNumber(curF)) {
        Logger.log(_nmfPad(a1, 8) + _nmfPad(f.store, 6) + _nmfPad(f.day, 5) + _nmfPad(c.label, 7)
          + 'REFUSED — real formula ' + curF);
        refused++; return;
      }
      // A bare number carrying the FIRST incident's note is that fix's locked
      // figure. It looks writable and is not.
      if (curN === MPC_NOTE_TEXT) {
        Logger.log(_nmfPad(a1, 8) + _nmfPad(f.store, 6) + _nmfPad(f.day, 5) + _nmfPad(c.label, 7)
          + 'REFUSED — locked by the earlier MPC fix');
        refused++; return;
      }
      if (curF === want) { already++; return; }   // idempotent

      Logger.log(_nmfPad(a1, 8) + _nmfPad(f.store, 6) + _nmfPad(f.day, 5) + _nmfPad(c.label, 7)
        + _nmfPad(curF ? curF + ' (locked)' : String(curV), 20) + ' ->  ' + want);
      if (!dryRun) {
        rng.setFormula(want);
        rng.setNote(NMF_NOTE);
      }
      wrote++;
    });
  });

  Logger.log('---');
  Logger.log((dryRun ? 'WOULD write ' : 'wrote ') + wrote + ' cell(s); '
    + already + ' already correct; ' + refused + ' refused.');
  if (dryRun) Logger.log('Nothing was changed. Run nmfFixApply to write it.');
  else Logger.log('Done. The daily import will now skip these cells and say so '
    + '(deliberate: true, "cell holds a formula").');
}

// The rollover copies notes forward, so next month's tab inherits these on its
// own 15th–25th where they mean nothing. Clears only notes that exactly match
// NMF_NOTE, and skips the August tab, so it cannot touch the fix itself or
// anybody else's note.
function nmfClearCarriedNotes() {
  var ss = SpreadsheetApp.openById(NMF_SHEET_ID);
  var sheets = ss.getSheets(), cleared = 0;
  for (var s = 0; s < sheets.length; s++) {
    var name = sheets[s].getName();
    if (name === NMF_TAB || name.indexOf('Sales ') !== 0) continue;
    var rng = sheets[s].getRange(1, 1, sheets[s].getLastRow(), sheets[s].getLastColumn());
    var notes = rng.getNotes(), touched = false;
    for (var r = 0; r < notes.length; r++) {
      for (var c = 0; c < notes[r].length; c++) {
        if (notes[r][c] === NMF_NOTE) { notes[r][c] = ''; cleared++; touched = true; }
      }
    }
    if (touched) { rng.setNotes(notes); Logger.log('cleared carried notes on ' + name); }
  }
  Logger.log('cleared ' + cleared + ' carried note(s).');
}

function _nmfPad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}
