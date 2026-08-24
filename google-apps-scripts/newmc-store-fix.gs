// ============================================================================
// newmc-store-fix.gs — restore the real daily figures for each store as it moves
// onto PayMore new Marketplace Connect and its adoption duplicates that store
// Shopify orders. MPL and BAL are done; add each further store as it moves.
//
// THIS IS A DIFFERENT INCIDENT FROM mpc-dupe-fix.gs. That one covers Aug 16-20
// (the 2026-08-20 MC back-fill). This one covers Aug 22-23 (the 2026-08-24
// transition). Separate file, separate prefix, separate note text, so neither
// can clear or overwrite the other's work.
//
// ---------------------------------------------------------------------------
// WHY THESE DAYS ARE WRONG, AND WHY IT IS URGENT
// ---------------------------------------------------------------------------
// On 2026-08-24 the new system imported 22 eBay sales that SPEEKS Connect had
// already imported. The duplicate orders were CREATED on Aug 24 — but Shopify's
// sales dataset attributes their revenue to the ORIGINAL SALE DAY, so the money
// landed on Aug 20, 22 and 23. All 22 have since been refunded, and a refund is
// credited to the REFUND day, so the whole reversal sits on Aug 24.
//
// Net effect: Aug 22 and Aug 23 are OVERSTATED in Shopify and will stay that way.
//
//   day     Shopify shows      phantom in it      TRUE
//   Aug 20  -2324.86 / -1038.01   1043.94 / 403.00    (see note below)
//   Aug 21   4018.86 /  1647.00      0.00 /   0.00    clean, no phantom
//   Aug 22   9712.97 /  4242.99   3844.91 / 1706.90   5868.06 / 2536.09  <-- fix
//   Aug 23   5356.80 /  2263.80   1820.94 /  720.40   3535.86 / 1543.40  <-- fix
//   Aug 24  -6202.18 / -2644.30  -6709.79 /-2830.30    507.61 /  186.00  <-- tomorrow
//
// ⚠️ THE SHEET IS PROBABLY STILL CORRECT AS YOU READ THIS, AND THAT IS THE
// PROBLEM. The duplicates were created around 10am Central, AFTER the Aug 24
// 06:00 daily email was sent — so this morning's import carried the true Aug 22
// and Aug 23 figures. The Shopify daily report is a MONTH-TO-DATE RESTATEMENT and
// the importer re-verifies a rolling window every run, so TOMORROW's 06:00 email
// will restate Aug 22 and Aug 23 with the phantoms included and silently replace
// two good days. That is exactly how four good days were lost on Aug 21.
//
// So this is preventive: locking the true figures in before the next import is
// what stops them being overwritten. Run it TODAY.
//
// ---------------------------------------------------------------------------
// AUG 20 IS DELIBERATELY NOT IN THE LIST
// ---------------------------------------------------------------------------
// mpc-dupe-fix.gs already locked MPL Aug 20 at 3102.89 / 1277.75. That figure was
// derived on Aug 21, BEFORE these phantoms existed, so it is the true Aug 20 and
// needs no change — and because it is a bare-number formula the importer will not
// overwrite it. Shopify's own Aug 20 reads -3368.80 once the new phantoms come
// out, because last week's refund credits landed there; that is expected and is
// NOT what the sheet should say. Leave it alone.
//
// WHICH DAYS ARE HIT DIFFERS PER STORE. MPL Aug 21 has zero phantom
// involvement, so the importer figure is right there. BAL Aug 21 IS hit and is
// in the list. Derive the days for every store; never copy another store range.
//
// ---------------------------------------------------------------------------
// AUG 24 STILL HAS TO BE DONE — TOMORROW MORNING
// ---------------------------------------------------------------------------
// Aug 24 carries the ENTIRE reversal for each store, so until it is locked at its
// true value that store August month total is understated by it:
//   MPL 6709.79     BAL 3529.84
//
// Tomorrow: take each real final Aug 24 figure, uncomment the rows at the bottom
// of NMC_FIX, put the numbers in, re-run preview then apply. Month totals are
// then correct and so is the day-by-day split.
//
// ---------------------------------------------------------------------------
// HOW TO RUN — no deployment, this is a Run-from-the-editor script
// ---------------------------------------------------------------------------
//   1. Paste this file into the Sales Summary Apps Script project as its own file.
//   2. Run `nmcFixPreview` and authorise. It writes NOTHING. Read the log: every
//      cell, what it holds now, what it would become.
//   3. Happy → run `nmcFixApply`. Idempotent; running it twice changes nothing.
//   4. Next month only: the rollover copies notes forward, so September's tab
//      inherits these notes on its own 22nd/23rd where they mean nothing. Run
//      `nmcClearCarriedNotes` once after the 1st.
//
// Prefixed NMC_/_nmc throughout: one Apps Script project is one global scope, and
// a collision with mpc-dupe-fix.gs, sales-email-import.gs or month-rollover.gs
// would silently read a different geometry.
// ============================================================================

var NMC_SHEET_ID = '1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8';  // Sales Summary 2026
var NMC_TAB      = 'Sales Aug 26';

// Same geometry as the importer, restated here rather than imported: this file
// must be safe to paste into a project on its own.
var NMC_BASES       = { OVL: 0, LEE: 11, WSP: 22, MPL: 33, BAL: 44 };
var NMC_COL_SALES   = 1;   // base + 1
var NMC_COL_COST    = 4;   // base + 4
var NMC_HEADER_ROWS = 4;   // day rows start here; the row is still LOCATED by day

// Distinct from MPC_NOTE on purpose — nmcClearCarriedNotes matches this exact
// string, so it can never strip the Aug 16-20 fix's notes, and mpcClearCarried-
// Notes can never strip these.
var NMC_NOTE = 'New-MC adoption dupe fix — real figure. Locked from the daily sync.';

// Sales = Shopify net_sales, Cost = COGS, both with the 22 duplicate orders
// removed by SHOPIFY'S OWN day attribution — not by ebay_orders.sold_at, which
// disagrees for back-dated copies. Same method that reproduced the pre-
// contamination email to the cent, 8 of 8, on the Aug 16-20 fix.
// ---------------------------------------------------------------------------
// VERIFIED AGAINST THE SHEET, 2026-08-24 11:16 (nmcFixPreview)
// ---------------------------------------------------------------------------
// Aug 23 held 3535.86 / 1543.4 -- IDENTICAL to the reconstruction, to the cent,
// derived independently. That is the proof the method is right: same standard as
// the Aug 16-20 fix, which reproduced the pre-contamination email 8 of 8.
//
// Aug 22 held 5818.07 / 2526.09, which is 49.99 / 10.00 BELOW the figure here.
// Fully explained, and it is not a missed duplicate: #MO03-3042 is a REAL eBay
// sale (20-15049-68792) that SPEEKS Connect never imported -- one Shopify copy
// only, absent from ebay_orders -- which the new system imported at 15:06 and
// Shopify correctly booked to its Aug 22 sale date. The 06:00 email predated it
// by five hours, so the sheet was stale rather than wrong.
//
//   5818.07 + 49.99 = 5868.06      2526.09 + 10.00 = 2536.09
//
// Re-checked for new duplicates at the same time: none. All 15 partially-refunded
// phantoms were already staged; the new system had created no further copies.
var NMC_FIX = [
  { store: 'MPL', day: 22, sales: 5868.06, cost: 2536.09 },
  { store: 'MPL', day: 23, sales: 3535.86, cost: 1543.40 },

  // BAL, added 2026-08-24. 17 duplicate orders, all refunded (3584.83), all
  // reversed to net_sales 0 / cogs 0, and all 17 of ours left intact.
  //
  // WARNING: BAL IS HIT ON AUG 21 AS WELL, WHICH MPL WAS NOT. Do not assume the
  // two stores share a day range -- derive each one.
  //
  // BAL Aug 20 is deliberately absent: mpc-dupe-fix.gs locked it at
  // 2461.83 / 1079.25 before these phantoms existed, so it is already true and
  // the formula lock protects it. Shopify reads BAL Aug 20 as -7152.73 once the
  // new phantoms come out, because last week refund credits landed there. That
  // is expected and is NOT what the sheet should say.
  { store: 'BAL', day: 21, sales: 1204.38, cost:  551.01 },
  { store: 'BAL', day: 22, sales: 2818.92, cost: 1191.00 },
  { store: 'BAL', day: 23, sales: 2379.14, cost: 1108.01 }

  // TOMORROW (2026-08-25), once Aug 24 real final figures are known. Uncomment,
  // replace the numbers, re-run nmcFixPreview then nmcFixApply.
  // Until Aug 24 is locked, each store August month total is understated by the
  // reversal its Aug 24 is carrying: MPL 6709.79, BAL 3529.84.
  //
  // Measured 11:30 today and still moving: MPL 507.61 / 186.00.
  // BAL true Aug 24 is NEGATIVE (-1344.99 / -578.00) and that is REAL -- BAL has
  // genuine returns exceeding sales so far today, nothing to do with the
  // duplicates. Take the final figure whatever its sign.
  // , { store: 'MPL', day: 24, sales: 0.00, cost: 0.00 }
  // , { store: 'BAL', day: 24, sales: 0.00, cost: 0.00 }
];

function nmcFixPreview() { _nmcRun(true); }
function nmcFixApply()   { _nmcRun(false); }

// Locate the row by matching the day number in the block's OWN date column —
// never by arithmetic from a start row. Somebody inserting a row above the grid
// would otherwise shift every write and corrupt a month silently.
function _nmcFindDayRow(values, base, day) {
  for (var r = NMC_HEADER_ROWS; r < values.length; r++) {
    var first = String(values[r][0]).trim().toUpperCase();
    if (first === 'TTL' || first.indexOf('TRACKING') === 0) break;   // past the day rows
    if (parseInt(values[r][base], 10) === day) return r;
  }
  return -1;
}

// Is this formula one of ours (or an existing bare-number lock)? Anything else is
// somebody's real calculation and must not be touched.
function _nmcIsBareNumber(f) {
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

function _nmcRun(dryRun) {
  var ss = SpreadsheetApp.openById(NMC_SHEET_ID);
  var sh = ss.getSheetByName(NMC_TAB);
  if (!sh) { Logger.log('NO TAB NAMED "' + NMC_TAB + '" — nothing done.'); return; }

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();

  var wrote = 0, already = 0, refused = 0;
  Logger.log((dryRun ? '=== PREVIEW (nothing written) ===' : '=== APPLYING ===') + '  tab: ' + NMC_TAB);
  Logger.log('cell     store day  field  holds now            ->  becomes');

  NMC_FIX.forEach(function (f) {
    var base = NMC_BASES[f.store];
    if (base == null) { Logger.log('unknown store ' + f.store); refused++; return; }
    var r = _nmcFindDayRow(values, base, f.day);
    if (r < 0) { Logger.log('no row for ' + f.store + ' day ' + f.day); refused++; return; }

    [{ col: base + NMC_COL_SALES, label: 'sales', want: f.sales },
     { col: base + NMC_COL_COST,  label: 'cost',  want: f.cost }].forEach(function (c) {
      var rng  = sh.getRange(r + 1, c.col + 1);
      var a1   = rng.getA1Notation();
      var curF = (formulas[r] || [])[c.col] || '';
      var curV = (values[r] || [])[c.col];
      var want = '=' + c.want.toFixed(2);

      // A real formula (a reference or a function) is somebody's calculation.
      // Refuse, loudly, rather than replacing it with a literal.
      if (curF && !_nmcIsBareNumber(curF)) {
        Logger.log(_nmcPad(a1, 8) + _nmcPad(f.store, 6) + _nmcPad(f.day, 5) + _nmcPad(c.label, 7)
          + 'REFUSED — real formula ' + curF);
        refused++;
        return;
      }
      // ⚠️ COMPARE THE VALUE, NOT THE FORMULA STRING.
      // Sheets normalises a stored formula: "=1543.40" comes back as "=1543.4".
      // A string test therefore never matches, so the cell is rewritten on every
      // run, Sheets re-normalises it, and the script can never report clean --
      // which is exactly how a fix script stops being trusted. Seen live on
      // AL27 (MPL day 23 cost) after the first apply: correct value, reported as
      // still needing a write.
      //
      // Compares the cell VALUE, which Sheets has already computed, so it holds
      // for "=1543.4", "=1543.40" and a plain typed 1543.4 alike. Guarded on
      // blank, because Number("") is 0 and would read an empty cell as a match
      // for a wanted 0.
      var already_ok = (curV !== "" && curV !== null && curV !== undefined
                        && Math.abs(Number(curV) - c.want) < 0.005);
      if (already_ok && curF) {
        already++;
        return;   // right number AND locked as a formula: nothing to do
      }

      Logger.log(_nmcPad(a1, 8) + _nmcPad(f.store, 6) + _nmcPad(f.day, 5) + _nmcPad(c.label, 7)
        + _nmcPad(curF ? curF + ' (locked)' : String(curV), 20) + ' ->  ' + want);
      if (!dryRun) {
        rng.setFormula(want);
        rng.setNote(NMC_NOTE);
      }
      wrote++;
    });
  });

  Logger.log('---');
  Logger.log((dryRun ? 'WOULD write ' : 'wrote ') + wrote + ' cell(s); '
    + already + ' already correct; ' + refused + ' refused.');
  if (dryRun) {
    Logger.log('Nothing was changed. Run nmcFixApply to write it.');
  } else {
    Logger.log('Done. The daily import will now skip these cells and say so '
      + '(deliberate: true, "cell holds a formula").');
    Logger.log('STILL OUTSTANDING: MPL Aug 24 carries the whole -6709.79 reversal. '
      + 'Until it is locked at its real final figure the August month total is '
      + 'understated by that amount. See the note at the top of this file.');
  }
}

function _nmcPad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

// The rollover copies notes forward, so next month's tab inherits these on its
// own 22nd/23rd where they mean nothing. Clears only notes that exactly match
// OURS, and only on Sales tabs OTHER than the August one — so it can never touch
// this fix, and never touch the Aug 16-20 fix's notes either.
function nmcClearCarriedNotes() {
  var ss = SpreadsheetApp.openById(NMC_SHEET_ID);
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.indexOf('Sales ') !== 0 || name === NMC_TAB) return;
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return;
    var rng = sh.getRange(1, 1, lastRow, lastCol);
    var notes = rng.getNotes();
    var touched = false;
    for (var r = 0; r < notes.length; r++) {
      for (var c = 0; c < notes[r].length; c++) {
        if (notes[r][c] === NMC_NOTE) { notes[r][c] = ''; touched = true; }
      }
    }
    if (touched) { rng.setNotes(notes); Logger.log('cleared carried notes on ' + name); }
  });
}
