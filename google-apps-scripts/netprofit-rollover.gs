// ============================================================================
// netprofit-rollover.gs — one NET PROFIT tab per month.
//
//   npRollPreview()      what the roll would do. Writes NOTHING.
//   npRollApply()        copy NPR_SOURCE_YM's tab to NPR_TARGET_YM and blank it.
//   npRollBlankPreview() what blanking NPR_BLANK_YM's tab in place would clear.
//   npRollBlankApply()   blank it, for real.
//   npRollStatus()       list the NET PROFIT tabs the workbook has.
//
// From 2026-09 the workbook keeps a tab per month — "Net Profit Sep 26",
// "Net Profit Oct 26" — the same convention the Sales Summary uses. September
// is the first month on the record: July's data was not kept and August is
// deliberately never getting a tab (user, 2026-08-28).
//
// ⚠️ IT COPIES, IT NEVER REBUILDS. Same rule as month-rollover.gs. The tab
// carries formulas in 12 of its 17 columns per block, six blocks of them, plus
// conditional formatting and a TTL block that is entirely derived. Rebuilding
// that from code would be a second, drifting definition of Net Profit. copyTo()
// takes the whole thing exactly as it is and the roll only ever CLEARS.
//
// ⚠️ WHAT IS CLEARED IS ONLY WHAT IS WRITTEN. Five columns per store block —
// Sales, Cost, eBay Fee, Shipping, Credit Card Fee — and the handful of summary
// cells the two writers fill. Every other cell is a formula and is left alone.
// The TTL block is never touched at all: it is derived from the five stores and
// clearing it would replace working formulas with blanks.
//
// ⚠️ AND THE NOTES GO TOO. copyTo() carries notes verbatim, which is how the
// Sales Summary ended up needing mrfClearCarriedNotes() — September inheriting
// "MC mirror-back fix (Aug 26)" on its own 26th, explaining an incident that
// had not happened. Every cell this file clears has its note cleared with it.
//
// Prefixed NPR_/_npr: one Apps Script project is one global scope. Shares
// _npTabName, _npColLetter and NP_BASES with netprofit-sheet.gs, and
// _npxFindRow with netprofit-summary.gs — one geometry, defined once.
// ============================================================================

var NPR_SOURCE_YM = '2026-09';   // the month whose tab is copied
var NPR_TARGET_YM = '2026-10';   // the month it becomes

var NPR_BLANK_YM  = '2026-09';   // for npRollBlank*: the tab to empty in place

function npRollPreview()      { _nprRoll(true); }
function npRollApply()        { _nprRoll(false); }
function npRollBlankPreview() { _nprBlank(NPR_BLANK_YM, true); }
function npRollBlankApply()   { _nprBlank(NPR_BLANK_YM, false); }

// ---------------------------------------------------------------------------

function npRollStatus() {
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);
  var names = ss.getSheets().map(function (s) { return s.getName(); });
  Logger.log('NET PROFIT tabs present:');
  var found = 0;
  for (var i = 0; i < names.length; i++) {
    if (names[i].toLowerCase().indexOf(NP_TAB_PREFIX.toLowerCase()) !== 0
        && names[i] !== NP_TAB_LEGACY) continue;
    Logger.log('  %s', names[i]);
    found++;
  }
  if (!found) Logger.log('  (none)');
  Logger.log('\nConfigured: roll %s ("%s")  ->  %s ("%s")',
    NPR_SOURCE_YM, _npTabName(NPR_SOURCE_YM), NPR_TARGET_YM, _npTabName(NPR_TARGET_YM));
  Logger.log('Blank in place: %s ("%s")', NPR_BLANK_YM, _npTabName(NPR_BLANK_YM));
  Logger.log('\nAll tabs: %s', names.join(' | '));
}

// ---------------------------------------------------------------------------
// the roll
// ---------------------------------------------------------------------------

function _nprRoll(preview) {
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);
  var srcName = _npTabName(NPR_SOURCE_YM);
  var dstName = _npTabName(NPR_TARGET_YM);

  var src = ss.getSheetByName(srcName);
  if (!src) {
    Logger.log('!! no source tab "%s". Run npRollStatus to see what is there.', srcName);
    return;
  }
  // ⚠️ REFUSE RATHER THAN OVERWRITE. A second roll of the same month would
  // otherwise copy the live month over a tab that already holds real figures —
  // and on the 1st, that tab is the one the bonus was just paid from.
  if (ss.getSheetByName(dstName)) {
    Logger.log('!! "%s" already exists. Refusing to overwrite a month that is '
      + 'already on the record. Delete it by hand first if that is really what '
      + 'you want.', dstName);
    return;
  }

  Logger.log('%s — roll "%s" -> "%s"',
    preview ? 'PREVIEW (nothing will be written)' : 'APPLY', srcName, dstName);

  if (preview) {
    Logger.log('  would copy the whole tab (formulas, formats, conditional rules) '
      + 'and then clear it:');
    _nprPlanClear(src, NPR_TARGET_YM, true);
    Logger.log('\nPREVIEW — nothing was written. Run npRollApply to apply.');
    return;
  }

  var dst = src.copyTo(ss).setName(dstName);
  ss.setActiveSheet(dst);
  ss.moveActiveSheet(src.getIndex() + 1);
  Logger.log('  copied to "%s" at position %s', dstName, dst.getIndex());
  _nprPlanClear(dst, NPR_TARGET_YM, false);
  Logger.log('\nRolled. The new tab is EMPTY — the 2pm refresh fills it, and '
    + 'npSummaryApply sets Days this month, the month header and the YoY base.');
}

// Blank one tab in place, without copying anything.
function _nprBlank(ym, preview) {
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);
  var name = _npTabName(ym);
  var sh = ss.getSheetByName(name);
  if (!sh) {
    Logger.log('!! no tab "%s". Run npRollStatus to see what is there.', name);
    return;
  }
  Logger.log('%s — blank "%s" in place (%s)',
    preview ? 'PREVIEW (nothing will be written)' : 'APPLY', name, ym);
  _nprPlanClear(sh, ym, preview);
  if (preview) Logger.log('\nPREVIEW — nothing was written. Run npRollBlankApply to apply.');
  else Logger.log('\nBlanked. Run npSummaryApply next to set the header, Days this '
    + 'month and the YoY base for %s.', ym);
}

// ---------------------------------------------------------------------------
// the clear — the only part that touches cells
// ---------------------------------------------------------------------------

function _nprPlanClear(sh, ym, preview) {
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();

  // Located, never counted — an inserted row must not shift what gets wiped.
  var rowTtl0      = _npxFindRow(values, NP_BASES.OVL, 'TTL');
  var rowLastMonth = _npxFindRow(values, NP_BASES.OVL + NPX_OFF_LABEL, 'Last month');
  var rowDaysThru  = _npxFindRow(values, NP_BASES.OVL + NPX_OFF_LABEL, 'Days Thru month');
  var rowYoY       = _npxFindRow(values, NP_BASES.OVL + NPX_OFF_YOY_LBL, 'YoY');
  if (rowTtl0 < 0 || rowLastMonth < 0 || rowDaysThru < 0) {
    Logger.log('  !! could not locate the grid by label (TTL=%s, Last month=%s, '
      + 'Days Thru=%s). NOTHING CLEARED — re-run npProbeSummary; the layout moved.',
      rowTtl0 + 1, rowLastMonth + 1, rowDaysThru + 1);
    return;
  }

  var firstDayRow1 = NP_HEADER_ROWS + 1;      // 1-based
  var lastDayRow1  = rowTtl0;                 // 0-based TTL index == 1-based last day row
  var nDays = lastDayRow1 - firstDayRow1 + 1;

  var DATA_OFFSETS = [
    [NP_OFF_SALES,   'Sales'],
    [NP_OFF_COST,    'Cost'],
    [NP_OFF_EBAYFEE, 'eBay Fee'],
    [NP_OFF_SHIP,    'Shipping'],
    [NP_OFF_CCFEE,   'CC Fee']
  ];

  Logger.log('  day rows %s-%s (%s), TTL row %s', firstDayRow1, lastDayRow1, nDays, rowTtl0 + 1);

  // --- 1. the five written columns, five store blocks. TTL is derived and is
  // deliberately absent from NP_ORDER, so it is never reached here.
  var cells = 0;
  for (var i = 0; i < NP_ORDER.length; i++) {
    var store = NP_ORDER[i], base = NP_BASES[store];
    var cols = [];
    for (var d = 0; d < DATA_OFFSETS.length; d++) {
      var c0 = base + DATA_OFFSETS[d][0];
      cols.push(_npColLetter(c0) + firstDayRow1 + ':' + _npColLetter(c0) + lastDayRow1);
      if (!preview) {
        var rng = sh.getRange(firstDayRow1, c0 + 1, nDays, 1);
        rng.clearContent();
        rng.clearNote();
      }
      cells += nDays;
    }
    Logger.log('    %s: %s', store, cols.join('  '));
  }

  // --- 2. the summary cells the two writers fill. Everything else in the strip
  // is a formula or a label and stays.
  var summary = [];
  var blocks = [];
  for (var b = 0; b < NP_ORDER.length; b++) blocks.push(NP_BASES[NP_ORDER[b]]);
  blocks.push(NP_TTL_BASE);

  for (var k = 0; k < blocks.length; k++) {
    var bb = blocks[k];
    // last month's Revenue / GP / Net Profit — they describe the PREVIOUS
    // month, so on a new tab they are last month's last month. Wrong by one,
    // which is the kind of wrong that reads as right.
    summary.push([bb + NPX_OFF_VAL_L, rowLastMonth]);
    summary.push([bb + NPX_OFF_VAL_R, rowLastMonth]);
    summary.push([bb + NPX_OFF_VAL_R, rowLastMonth + 1]);
    // the YoY base, where a YoY block exists at all
    if (rowYoY >= 0) summary.push([bb + NPX_OFF_VAL_R, rowYoY + 1]);
    // ⚠️ THE GOAL GOES TOO. A goal is set for one month. Carrying August's
    // into September would colour the whole month green or red against a
    // target nobody set, and the cell gives no sign it is stale.
    summary.push([bb + NPX_OFF_GOAL_VAL, 1]);
  }

  var kept = [], cleared = [];
  for (var s = 0; s < summary.length; s++) {
    var col0 = summary[s][0], row0 = summary[s][1];
    var a1 = _npColLetter(col0) + (row0 + 1);
    // Only clear a VALUE. Several of these are formulas on the TTL block
    // (=C38+U38+... and the YoY sums) and those are the roll-up, not data.
    var cell = sh.getRange(row0 + 1, col0 + 1);
    if (String(cell.getFormula()).trim() !== '') { kept.push(a1); continue; }
    cleared.push(a1);
    if (!preview) { cell.clearContent(); cell.clearNote(); }
  }
  Logger.log('    summary values cleared: %s', cleared.join(' ') || '(none)');
  if (kept.length) Logger.log('    summary formulas KEPT (roll-ups, not data): %s', kept.join(' '));

  // --- 3. Days Thru back to 0. It is a chain — only OVL holds a real value —
  // and the summary writer re-derives it from the first day that carries Sales.
  // Left at last month's 30 or 31, a one-day-old September would divide by a
  // full month and report a tracking figure a thirtieth of the truth.
  var thruCell = sh.getRange(rowDaysThru + 1, NP_BASES.OVL + NPX_OFF_VAL_L + 1);
  if (String(thruCell.getFormula()).trim() === '') {
    Logger.log('    Days Thru %s%s -> 0',
      _npColLetter(NP_BASES.OVL + NPX_OFF_VAL_L), rowDaysThru + 1);
    if (!preview) thruCell.setValue(0);
  }

  Logger.log('  %s day cells + %s summary cells%s',
    cells, cleared.length, preview ? ' would be cleared' : ' cleared');
}
