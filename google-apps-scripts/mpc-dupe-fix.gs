// ============================================================================
// SPEEKS — MPC DUPE ERROR FIX (one-off, Sales Aug 26)
//
// WHAT HAPPENED. On 2026-08-20 at ~1:10pm Central, Marketplace Connect
// back-filled every eBay sale from Aug 16–20 that SPEEKS Connect had already
// imported: 77 duplicate Shopify orders (BAL 42, MPL 35), each back-dated to the
// original sale date. They were all reversed on the evening of Aug 20, and a
// refund is credited to the REFUND day, not the sale day. So Shopify's own
// numbers now read:
//
//   Aug 16–19  overstated by the duplicates
//   Aug 20     understated by the whole reversal (BAL −$7,152.73, MPL −$3,368.80)
//
// The daily Shopify report is a MONTH-TO-DATE restatement, and the importer
// re-verifies a rolling window on every run — so the correct figures that were
// in the sheet were silently replaced with the inflated ones the next morning.
// Nobody did anything wrong; the sheet is faithfully reporting what Shopify now
// says. This restores what the days ACTUALLY were.
//
// WHERE THE NUMBERS COME FROM. Not arithmetic on the sheet — Shopify itself.
// For each day: `FROM sales SHOW net_sales, cost_of_goods_sold GROUP BY
// order_name`, then subtract the orders named in `dup_order_cleanup`, the audit
// trail written BEFORE anything was touched. Proof the method is right: for BAL
// it reproduces the pre-contamination Shopify email of 2026-08-20 06:00 to the
// cent on all four days, sales AND cost — 8 out of 8.
//
// ⚠️ THE MONTH TOTAL DOES NOT MOVE, which is the whole reason this is safe.
// Aug 16–20, sales:
//   BAL  shown 6765.50 + 8692.59 + 5692.73 + 3758.77 − 7152.73 = 17,756.86
//        real  3810.71 + 5302.70 + 3552.78 + 2628.84 + 2461.83 = 17,756.86
//   MPL  shown 3980.59 + 4882.76 + 7664.73 + 5279.68 − 3368.80 = 18,438.96
//        real  2964.72 + 4424.80 + 4609.82 + 3336.73 + 3102.89 = 18,438.96
// And cost, which is what keeps GP and margin still:
//   BAL  shown 2704.00 + 3577.02 + 2278.83 + 1436.16 − 2744.75 =  7,251.26
//        real  1535.00 + 2175.02 + 1326.83 + 1135.16 + 1079.25 =  7,251.26
//   MPL  shown 1434.61 + 2183.10 + 3443.00 + 2363.39 − 1441.01 =  7,983.09
//        real  1118.42 + 2089.10 + 2043.00 + 1454.82 + 1277.75 =  7,983.09
// Eight totals, all identical to the cent. The phantom sales and their reversal
// cancel exactly, so only the day-by-day SPLIT was ever wrong: MTD, % to goal,
// GP, margin and the rollover's carry-forward are all untouched by this.
//
// Aug 21 was checked and has zero duplicate involvement, so the affected range
// is exactly Aug 16–20 and nothing after it.
//
// HOW THE CELLS ARE LOCKED — using the workbook's OWN existing convention, not a
// new one. Each figure is written as a bare-number formula (`=3810.71`):
//   · the importer refuses to overwrite any cell holding a formula, and logs the
//     skip as `deliberate: true` — see the SAFETY block in sales-email-import.gs.
//     Its comment already describes this exact case: "somebody deliberately
//     protecting a hand-keyed figure Shopify will never report".
//   · month-rollover.gs treats a bare-number formula as a TYPED value
//     (_mrIsBareNumberFormula) and clears it, so September starts clean.
// This trick is already in use in this workbook — WSP Aug 15's cost cell holds
// `=2846.25`. Nothing new is being invented, and nothing needs deploying.
//
// HOW TO RUN. This is a Run-from-the-editor script, so there is NO deployment
// step (unlike the web app, where saving changes nothing until you publish a new
// version):
//   1. script.google.com → New project → paste this file → save.
//   2. Run `mpcFixPreview` and authorise. It writes NOTHING. Read the log: it
//      prints every cell, what it holds now, and what it would become.
//   3. Happy → run `mpcFixApply`. Idempotent; running it twice changes nothing.
//   4. Next month only: the rollover copies notes forward, so the September tab
//      will carry these notes on its own 16th–20th where they mean nothing.
//      Run `mpcClearCarriedNotes` once after the 1st to strip them.
//
// Prefixed MPC_/_mpc throughout: one Apps Script project is one global scope,
// and a name collision with sales-email-import.gs or month-rollover.gs would
// silently read a different geometry.
// ============================================================================

var MPC_SHEET_ID = '1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8';  // Sales Summary 2026
var MPC_TAB      = 'Sales Aug 26';

// Same geometry as the importer, restated here rather than imported: this file
// must be safe to paste into a project on its own.
var MPC_BASES      = { OVL: 0, LEE: 11, WSP: 22, MPL: 33, BAL: 44 };
var MPC_COL_SALES  = 1;   // base + 1
var MPC_COL_COST   = 4;   // base + 4
var MPC_HEADER_ROWS = 4;  // day rows start here; the row is still LOCATED by day number

var MPC_NOTE = 'MPC dupe error fix — real figure. Locked from the daily sync.';

// The corrected days. Sales = Shopify net sales, Cost = COGS, both with the
// duplicate orders removed.
var MPC_FIX = [
  { store: 'BAL', day: 16, sales: 3810.71, cost: 1535.00 },
  { store: 'BAL', day: 17, sales: 5302.70, cost: 2175.02 },
  { store: 'BAL', day: 18, sales: 3552.78, cost: 1326.83 },
  { store: 'BAL', day: 19, sales: 2628.84, cost: 1135.16 },
  { store: 'BAL', day: 20, sales: 2461.83, cost: 1079.25 },
  { store: 'MPL', day: 16, sales: 2964.72, cost: 1118.42 },
  { store: 'MPL', day: 17, sales: 4424.80, cost: 2089.10 },
  { store: 'MPL', day: 18, sales: 4609.82, cost: 2043.00 },
  { store: 'MPL', day: 19, sales: 3336.73, cost: 1454.82 },
  { store: 'MPL', day: 20, sales: 3102.89, cost: 1277.75 }
];

function mpcFixPreview() { _mpcRun(true); }
function mpcFixApply()   { _mpcRun(false); }

// Locate the row by matching the day number in the block's OWN date column —
// never by arithmetic from a start row. Somebody inserting a row above the grid
// would otherwise shift every write and corrupt a month silently. Lifted from
// _findDayRow in sales-email-import.gs so the two cannot disagree.
function _mpcFindDayRow(values, base, day) {
  for (var r = MPC_HEADER_ROWS; r < values.length; r++) {
    var first = String(values[r][0]).trim().toUpperCase();
    if (first === 'TTL' || first.indexOf('TRACKING') === 0) break;   // past the day rows
    if (parseInt(values[r][base], 10) === day) return r;
  }
  return -1;
}

// Is this formula one of ours (or an existing bare-number lock)? Anything else
// is somebody's real calculation and must not be touched.
function _mpcIsBareNumber(f) {
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

function _mpcRun(dryRun) {
  var ss = SpreadsheetApp.openById(MPC_SHEET_ID);
  var sh = ss.getSheetByName(MPC_TAB);
  if (!sh) { Logger.log('NO TAB NAMED "' + MPC_TAB + '" — nothing done.'); return; }

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();

  var wrote = 0, already = 0, refused = 0;
  Logger.log((dryRun ? '=== PREVIEW (nothing written) ===' : '=== APPLYING ===') + '  tab: ' + MPC_TAB);
  Logger.log('cell     store day  field  holds now            ->  becomes');

  MPC_FIX.forEach(function (f) {
    var base = MPC_BASES[f.store];
    if (base == null) { Logger.log('unknown store ' + f.store); refused++; return; }
    var r = _mpcFindDayRow(values, base, f.day);
    if (r < 0) { Logger.log('no row for ' + f.store + ' day ' + f.day); refused++; return; }

    [{ col: base + MPC_COL_SALES, label: 'sales', want: f.sales },
     { col: base + MPC_COL_COST,  label: 'cost',  want: f.cost }].forEach(function (c) {
      var rng  = sh.getRange(r + 1, c.col + 1);
      var a1   = rng.getA1Notation();
      var curF = (formulas[r] || [])[c.col] || '';
      var curV = (values[r] || [])[c.col];
      var want = '=' + c.want.toFixed(2);

      // A real formula (a reference or a function) is somebody's calculation.
      // Refuse, loudly, rather than replacing it with a literal.
      if (curF && !_mpcIsBareNumber(curF)) {
        Logger.log(_mpcPad(a1, 8) + _mpcPad(f.store, 6) + _mpcPad(f.day, 5) + _mpcPad(c.label, 7)
          + 'REFUSED — real formula ' + curF);
        refused++;
        return;
      }
      if (curF === want) {
        already++;
        return;   // idempotent: already locked to the right number
      }

      Logger.log(_mpcPad(a1, 8) + _mpcPad(f.store, 6) + _mpcPad(f.day, 5) + _mpcPad(c.label, 7)
        + _mpcPad(curF ? curF + ' (locked)' : String(curV), 20) + ' ->  ' + want);
      if (!dryRun) {
        rng.setFormula(want);
        rng.setNote(MPC_NOTE);
      }
      wrote++;
    });
  });

  Logger.log('---');
  Logger.log((dryRun ? 'WOULD write ' : 'wrote ') + wrote + ' cell(s); '
    + already + ' already correct; ' + refused + ' refused.');
  if (dryRun) Logger.log('Nothing was changed. Run mpcFixApply to write it.');
  else Logger.log('Done. The daily import will now skip these cells and say so '
    + '(deliberate: true, "cell holds a formula").');
}

function _mpcPad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

// The rollover copies notes forward, so next month's tab inherits these on its
// own 16th–20th where they mean nothing. Clears only notes that exactly match
// ours, and only on Sales tabs OTHER than the August one — so it can never
// touch the fix itself or anybody else's note.
function mpcClearCarriedNotes() {
  var ss = SpreadsheetApp.openById(MPC_SHEET_ID);
  var cleared = 0;
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.indexOf('Sales ') !== 0 || name === MPC_TAB) return;
    var rng = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn());
    var notes = rng.getNotes();
    var touched = false;
    for (var r = 0; r < notes.length; r++) {
      for (var c = 0; c < notes[r].length; c++) {
        if (notes[r][c] === MPC_NOTE) { notes[r][c] = ''; cleared++; touched = true; }
      }
    }
    if (touched) { rng.setNotes(notes); Logger.log('cleared carried notes on ' + name); }
  });
  Logger.log('cleared ' + cleared + ' carried note(s).');
}
