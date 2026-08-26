// ============================================================================
// netprofit-sheet.gs — fills the NET PROFIT tab from Shopify (and, later, eBay).
//
//   npProbe()          read-only; dumps the tab's geometry. Run it again after
//                      ANY edit to the tab's layout, before trusting the writer.
//   npWritePreview()   fetches the data and logs every cell. Writes NOTHING.
//   npWriteApply()     the same run, for real.
//
// GEOMETRY (measured by npProbe on 2026-08-26, not assumed):
//   Six blocks on an EVEN stride of 18, keyed off the DAY-NUMBER column:
//     OVL 0(A)  LEE 18(S)  WSP 36(AK)  MPL 54(BC)  BAL 72(BU)  TTL 90(CM)
//   Columns, relative to that day column — identical in all six blocks:
//     +0 day       +1 Sales*      +2 Total       +3 Rev Tracking   +4 Cost*
//     +5 GP        +6 GP Total    +7 GP Tracking +8 Gross Margin
//     +9 eBay Fee* +10 Shipping Cost*           +11 Credit Card Fee*
//     +12 NP       +13 NP Total   +14 NP Tracking +15 Net Margin   +16 MOM
//   (* = the five this script writes. EVERY other column is a formula and is
//   never touched. +1 and +4 match the Sales tabs' base+1 / base+4 exactly.)
//   Day rows 5-35 = days 1-31; row 36 = TTL; header rows = 4.
//
// ⚠️ TTL IS NEVER WRITTEN. It is the company roll-up and must stay derived from
// the five store blocks, or it will disagree with them the first time one store
// is restated. npWritePreview dumps its formulas so we can see it is wired.
//
// ⚠️ WHY BLOCKED COLUMNS ARE WRITTEN AS =NA() AND NOT LEFT BLANK.
// The tab's own NP formula is  =B5-E5-J5-K5-L5-(B5*0.07)  — it SUBTRACTS the
// eBay Fee and Shipping cells. A blank cell is arithmetic zero, so leaving them
// empty does not leave Net Profit missing; it makes Net Profit CONFIDENTLY TOO
// HIGH. On OVL's July that is roughly a $16k overstatement on a ~$61k figure,
// in the one column this whole project exists to set bonuses on.
// =NA() propagates to exactly the cells that genuinely cannot be known yet — NP,
// NP Total, NP Tracking, Net Margin — and leaves Sales, Cost, GP, GP Total,
// GP Tracking and Gross Margin fully valid and checkable. Set NP_BLOCKED_AS_NA
// to false to write true blanks instead, but read the paragraph above first.
//
// Prefixed NP_/_np: one Apps Script project is one global scope.
// ============================================================================

var NP_SHEET_ID = '1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8';  // Sales Summary 2026
var NP_TAB      = 'NET PROFIT TEMPLATE';

var NP_ENDPOINT = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/netprofit-collect';
var NP_SECRET   = 'sp33ks-sync-k3y-2026-x9mq';

// The month being written. The template's row-2 headers already read Jul 01 2026.
var NP_FROM = '2026-07-01';
var NP_TO   = '2026-07-31';

var NP_BASES    = { OVL: 0, LEE: 18, WSP: 36, MPL: 54, BAL: 72 };
var NP_TTL_BASE = 90;                 // read-only: dumped, never written
var NP_ORDER    = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];

var NP_OFF_SALES   = 1;
var NP_OFF_COST    = 4;
var NP_OFF_EBAYFEE = 9;
var NP_OFF_SHIP    = 10;
var NP_OFF_CCFEE   = 11;

var NP_HEADER_ROWS = 4;               // day rows start below this; still LOCATED by day number
var NP_BLOCKED_AS_NA = true;          // see the header warning before changing

function npProbe()        { _npProbe(); }
function npWritePreview() { _npWrite(true); }
function npWriteApply()   { _npWrite(false); }

function _npColLetter(i0) {
  var n = i0 + 1, s = '';
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - r) / 26); }
  return s;
}

function _npFetchStore(store) {
  var url = NP_ENDPOINT + '?secret=' + encodeURIComponent(NP_SECRET)
          + '&store=' + encodeURIComponent(store)
          + '&from=' + encodeURIComponent(NP_FROM) + '&to=' + encodeURIComponent(NP_TO);
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error(store + ': collector returned HTTP ' + res.getResponseCode()
      + ' — ' + res.getContentText().slice(0, 300));
  }
  var body = JSON.parse(res.getContentText());
  // A collector that quietly returns a SHORT month reads as a quiet business
  // week, not as a failed fetch. Refuse rather than write a hole into the sheet.
  if (!body.days || !body.days.length) throw new Error(store + ': collector returned no days');
  if (body.warnings && body.warnings.length) {
    Logger.log('  !! %s collector warnings: %s', store, body.warnings.join('; '));
  }
  return body;
}

// Match the day number in the block's OWN day column — never arithmetic from a
// start row. Somebody inserting a row above the grid would otherwise shift every
// write and silently corrupt a month. (Same rule as newmc-dupe-fix.gs.)
function _npFindDayRow(values, base, day) {
  for (var r = NP_HEADER_ROWS; r < values.length; r++) {
    var first = String(values[r][0]).trim().toUpperCase();
    if (first === 'TTL') break;
    if (parseInt(values[r][base], 10) === day) return r;
  }
  return -1;
}

// Is this formula one WE put there because the column was blocked? Only an
// exact =NA() counts. Anything richer — =NA()+1, =IF(...,NA(),...) — is
// somebody else's work and stays protected.
function _npIsOurPlaceholder(f) {
  return /^=\s*NA\s*\(\s*\)$/i.test(String(f).trim());
}

function _npWrite(preview) {
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);
  var sh = ss.getSheetByName(NP_TAB);
  if (!sh) { Logger.log('!! no tab named "%s"', NP_TAB); return; }

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();

  Logger.log('%s — %s to %s, tab "%s"',
    preview ? 'PREVIEW (nothing will be written)' : 'APPLY', NP_FROM, NP_TO, NP_TAB);

  // --- is TTL wired? --------------------------------------------------------
  // Dumped here rather than in a second probe run, because whether the company
  // roll-up is derived or hand-keyed decides whether this script is finished.
  Logger.log('\n=== TTL BLOCK (never written; showing row 5) ===');
  var ttlParts = [];
  for (var tc = NP_TTL_BASE; tc < Math.min(NP_TTL_BASE + 17, lastCol); tc++) {
    var tf = String(formulas[NP_HEADER_ROWS][tc]).trim();
    var tv = String(values[NP_HEADER_ROWS][tc]).trim();
    ttlParts.push(_npColLetter(tc) + '[+' + (tc - NP_TTL_BASE) + ']=' + (tf ? tf : (tv === '' ? '(empty)' : tv)));
  }
  Logger.log(ttlParts.join(' | '));

  var totals = { sales: 0, cost: 0, cc: 0, ship: 0, ebay: 0, naEbay: 0, naShip: 0 };
  var refusals = [];

  for (var si = 0; si < NP_ORDER.length; si++) {
    var store = NP_ORDER[si];
    var base  = NP_BASES[store];
    var data;
    try { data = _npFetchStore(store); }
    catch (e) {
      Logger.log('\n%s: SKIPPED — %s', store, e.message);
      refusals.push(store + ': ' + e.message);
      continue;
    }

    Logger.log('\n=== %s (day col %s) — %s days ===', store, _npColLetter(base), data.days.length);

    var rows = [], missing = [], placeholders = 0;
    for (var d = 0; d < data.days.length; d++) {
      var rec = data.days[d];
      var dayNum = parseInt(String(rec.day).slice(8, 10), 10);
      var r = _npFindDayRow(values, base, dayNum);
      if (r < 0) { missing.push(dayNum); continue; }

      // A formula in a data cell is a deliberate lock (the workbook's
      // bare-number convention) or somebody's manual edit. Either way it is not
      // ours to overwrite — refuse and name it, the way the dupe-fix scripts do.
      //
      // ⚠️ EXCEPT OUR OWN =NA(). A column that was blocked when this last ran
      // was filled with =NA() ON PURPOSE (see the header), so on the next run
      // the guard would find a formula in every one of those cells and refuse
      // the very write that unblocking made possible. That is exactly what
      // happened to eBay Fee once sell.finances was granted: 155 of 155 day
      // cells refused. A placeholder we wrote is ours to replace.
      var locked = [];
      [[NP_OFF_SALES, 'Sales'], [NP_OFF_COST, 'Cost'], [NP_OFF_EBAYFEE, 'eBay Fee'],
       [NP_OFF_SHIP, 'Shipping'], [NP_OFF_CCFEE, 'CC Fee']].forEach(function (p) {
        var f = String(formulas[r][base + p[0]]).trim();
        if (f === '') return;
        if (_npIsOurPlaceholder(f)) { placeholders++; return; }
        // Naming the formula matters: "formula already in eBay Fee" repeated
        // 155 times said nothing about WHICH formula, and that is the whole
        // question when deciding whether it is safe to overwrite.
        locked.push(p[1] + ' (' + f + ')');
      });
      if (locked.length) {
        refusals.push(store + ' day ' + dayNum + ': formula already in ' + locked.join(', '));
        continue;
      }
      rows.push({ r: r, day: dayNum, rec: rec });
    }
    if (missing.length) Logger.log('  !! no row found for day(s): %s', missing.join(', '));
    if (placeholders) {
      Logger.log('  %s =NA() placeholder cell(s) from an earlier run will be replaced with real values',
        placeholders);
    }
    if (!rows.length) { Logger.log('  nothing writable'); continue; }

    // Contiguity is checked, not assumed: the fast block write is only correct
    // if the located rows really are consecutive and in day order.
    var contiguous = true;
    for (var k = 1; k < rows.length; k++) {
      if (rows[k].r !== rows[k - 1].r + 1) { contiguous = false; break; }
    }

    var salesCol = [], costCol = [], feeCols = [];
    var sSum = 0, cSum = 0, ccSum = 0, shSum = 0, eSum = 0, naEbay = 0, naShip = 0;
    for (var j = 0; j < rows.length; j++) {
      var x = rows[j].rec;
      var ebayFee = (x.ebay_fee === null || x.ebay_fee === undefined)
        ? (NP_BLOCKED_AS_NA ? '=NA()' : '') : x.ebay_fee;
      var ship = (x.shipping_cost === null || x.shipping_cost === undefined)
        ? (NP_BLOCKED_AS_NA ? '=NA()' : '') : x.shipping_cost;
      salesCol.push([x.net_sales]);
      costCol.push([x.cost]);
      feeCols.push([ebayFee, ship, x.cc_fee]);
      sSum += x.net_sales; cSum += x.cost; ccSum += x.cc_fee;
      // Counted, not assumed: which columns are real changes as grants land, and
      // the summary at the bottom must report what was ACTUALLY written.
      if (typeof ebayFee === 'number') { eSum += ebayFee; } else { naEbay++; }
      if (typeof ship === 'number') { shSum += ship; } else { naShip++; }
      if (j < 3 || j === rows.length - 1) {
        Logger.log('  row %s day %s: Sales %s | Cost %s | eBayFee %s | Ship %s | CC %s',
          rows[j].r + 1, rows[j].day, x.net_sales, x.cost, ebayFee, ship, x.cc_fee);
      } else if (j === 3) {
        Logger.log('  ... (%s more days)', rows.length - 4);
      }
    }
    Logger.log('  month: Sales %s | Cost %s | eBay Fee %s | Ship %s | CC %s | rows %s-%s%s',
      Math.round(sSum * 100) / 100, Math.round(cSum * 100) / 100,
      naEbay ? naEbay + ' days #N/A' : Math.round(eSum * 100) / 100,
      naShip ? naShip + ' days #N/A' : Math.round(shSum * 100) / 100,
      Math.round(ccSum * 100) / 100,
      rows[0].r + 1, rows[rows.length - 1].r + 1, contiguous ? '' : '  (NON-CONTIGUOUS — per-cell write)');
    totals.sales += sSum; totals.cost += cSum; totals.cc += ccSum; totals.ship += shSum;
    totals.ebay += eSum;
    totals.naEbay += naEbay; totals.naShip += naShip;

    if (preview) continue;

    if (contiguous) {
      var top = rows[0].r + 1;                                  // getRange is 1-indexed
      sh.getRange(top, base + NP_OFF_SALES + 1, rows.length, 1).setValues(salesCol);
      sh.getRange(top, base + NP_OFF_COST  + 1, rows.length, 1).setValues(costCol);
      // +9, +10, +11 are adjacent, so the three fee columns go in one call.
      sh.getRange(top, base + NP_OFF_EBAYFEE + 1, rows.length, 3).setValues(feeCols);
    } else {
      for (var w = 0; w < rows.length; w++) {
        var rr = rows[w].r + 1;
        sh.getRange(rr, base + NP_OFF_SALES + 1).setValue(salesCol[w][0]);
        sh.getRange(rr, base + NP_OFF_COST  + 1).setValue(costCol[w][0]);
        sh.getRange(rr, base + NP_OFF_EBAYFEE + 1, 1, 3).setValues([feeCols[w]]);
      }
    }
    Logger.log('  written.');
  }

  Logger.log('\n=== ALL FIVE STORES ===');
  Logger.log('Sales %s | Cost %s | eBay Fee %s | Shipping %s | CC fee %s',
    Math.round(totals.sales * 100) / 100, Math.round(totals.cost * 100) / 100,
    Math.round(totals.ebay * 100) / 100,
    Math.round(totals.ship * 100) / 100, Math.round(totals.cc * 100) / 100);
  // The three costs Gross Profit cannot see, against the sales they came out of.
  var hidden = totals.ebay + totals.ship + totals.cc;
  var gp = totals.sales - totals.cost;
  Logger.log('Costs GP does not see: %s (eBay fee + shipping + CC fee) = %s%% of Gross Profit (%s)',
    Math.round(hidden * 100) / 100,
    gp ? Math.round(hidden / gp * 1000) / 10 : 'n/a',
    Math.round(gp * 100) / 100);
  // Reports what was written, per column, rather than a fixed sentence — the set
  // of blocked columns shrinks as grants land and a stale line here would lie.
  [['eBay Fee', totals.naEbay], ['Shipping Cost', totals.naShip]].forEach(function (p) {
    if (!p[1]) { Logger.log('%s: real values on every day.', p[0]); return; }
    Logger.log('%s: %s day-cells %s', p[0], p[1], NP_BLOCKED_AS_NA
      ? 'written as =NA() — NP, NP Total, NP Tracking and Net Margin show #N/A until that grant lands'
      : 'left BLANK — ⚠️ NP computes as if this were zero and reads TOO HIGH');
  });
  if (refusals.length) {
    Logger.log('\n=== REFUSED (%s) ===', refusals.length);
    refusals.forEach(function (m) { Logger.log('  %s', m); });
  } else {
    Logger.log('refused: none');
  }
  if (preview) Logger.log('\nPREVIEW ONLY — nothing was written. Run npWriteApply to commit.');
}

function _npProbe() {
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);
  var names = ss.getSheets().map(function (s) { return '"' + s.getName() + '"'; });
  Logger.log('TABS (%s): %s', names.length, names.join(', '));
  var sh = ss.getSheetByName(NP_TAB);
  if (!sh) { Logger.log('!! no tab named "%s"', NP_TAB); return; }
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  Logger.log('TAB "%s": %s rows x %s cols (last col = %s)', NP_TAB, lastRow, lastCol, _npColLetter(lastCol - 1));
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();

  Logger.log('\n=== HEADER ROWS 1-8 (non-empty) ===');
  for (var r = 0; r < Math.min(8, lastRow); r++) {
    var parts = [];
    for (var c = 0; c < lastCol; c++) {
      var v = String(values[r][c]).trim();
      if (v !== '') parts.push(_npColLetter(c) + '[' + c + ']=' + v);
    }
    Logger.log('row %s: %s', r + 1, parts.length ? parts.join(' | ') : '(empty)');
  }

  // Assert the constants against the live tab rather than re-deriving them:
  // if somebody inserts a column, this is the line that says so.
  Logger.log('\n=== BLOCKS (constants checked against the tab) ===');
  NP_ORDER.forEach(function (code) {
    var base = NP_BASES[code];
    Logger.log('%s base %s(%s): +1="%s" +4="%s" +9="%s" +10="%s" +11="%s"',
      code, base, _npColLetter(base),
      values[NP_HEADER_ROWS - 1][base + NP_OFF_SALES],
      values[NP_HEADER_ROWS - 1][base + NP_OFF_COST],
      values[NP_HEADER_ROWS - 1][base + NP_OFF_EBAYFEE],
      values[NP_HEADER_ROWS - 1][base + NP_OFF_SHIP],
      values[NP_HEADER_ROWS - 1][base + NP_OFF_CCFEE]);
  });

  Logger.log('\n=== FORMULAS, OVL ROW 5 ===');
  for (var c2 = 0; c2 < 17; c2++) {
    var f = String(formulas[4][c2]).trim();
    if (f) Logger.log('  %s[+%s] %s = %s', _npColLetter(c2), c2, values[NP_HEADER_ROWS - 1][c2], f);
  }

  Logger.log('\n=== ROW LABELS IN COLUMN A ===');
  for (var r4 = 0; r4 < lastRow; r4++) {
    var a = String(values[r4][0]).trim();
    if (a !== '') Logger.log('row %s: "%s"', r4 + 1, a);
  }
}

// ============================================================================
// npFixTotals — extend the TTL roll-up from three stores to five.
//
// The TTL block was built when the company had OVL, LEE and WSP, and its five
// data columns still sum only those three:
//     CN5 = IF(isblank(B5),"", T5+B5+AL5)      Sales
//     CQ5 = IF(ISBLANK(B5),"", W5+E5+AO5)      Cost
//     CV5 = J5+AB5+AT5                         eBay Fee
//     CW5 = K5+AC5+AU5                         Shipping
//     CX5 = L5+AD5+AV5                         Credit Card Fee
// MPL and BAL now have complete blocks, so TTL understates the company by two
// whole stores — on July, $185,498.25 of sales.
//
// Only those five columns are rewritten, and only on the day rows. Every other
// TTL column (Total, Rev Tracking, GP, GP Total, GP Tracking, Margin, NP, NP
// Total, NP Tracking, Net Margin, MOM) already derives from these five and is
// left exactly as written — including the 7% line in CY.
//
// The store references are GENERATED from NP_BASES and the column offsets, not
// typed. Hand-typing "BD" for MPL's sales column is precisely the error this
// whole file is arranged to avoid, and it would be invisible in the result: a
// wrong-but-adjacent column still returns a plausible number.
// ============================================================================

function npFixTotalsPreview() { _npFixTotals(true); }
function npFixTotalsApply()   { _npFixTotals(false); }

// Structure copied from the cells above so the fix reads like the template,
// not like a replacement of it. Sales and Cost keep the ISBLANK(B{r}) guard
// that blanks the TTL row until OVL has posted; the three fee columns are bare
// sums, exactly as they already were.
var NP_TTL_COLS = [
  { off: NP_OFF_SALES,   name: 'Sales',           guard: true  },
  { off: NP_OFF_COST,    name: 'Cost',            guard: true  },
  { off: NP_OFF_EBAYFEE, name: 'eBay Fee',        guard: false },
  { off: NP_OFF_SHIP,    name: 'Shipping Cost',   guard: false },
  { off: NP_OFF_CCFEE,   name: 'Credit Card Fee', guard: false }
];

function _npFixTotals(preview) {
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);
  var sh = ss.getSheetByName(NP_TAB);
  if (!sh) { Logger.log('!! no tab named "%s"', NP_TAB); return; }

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();

  Logger.log('%s — TTL roll-up, tab "%s"',
    preview ? 'PREVIEW (nothing will be written)' : 'APPLY', NP_TAB);

  // Day rows located the same way the writer locates them: by the TTL block's
  // own day number, stopping at its TTL label.
  var dayRows = [];
  for (var r = NP_HEADER_ROWS; r < lastRow; r++) {
    if (String(values[r][0]).trim().toUpperCase() === 'TTL') break;
    var n = parseInt(values[r][NP_TTL_BASE], 10);
    if (n >= 1 && n <= 31) dayRows.push({ r: r, day: n });
  }
  if (!dayRows.length) { Logger.log('!! no day rows found in the TTL block'); return; }
  Logger.log('day rows %s-%s (%s days)', dayRows[0].r + 1, dayRows[dayRows.length - 1].r + 1, dayRows.length);

  var ovlSalesCol = _npColLetter(NP_BASES.OVL + NP_OFF_SALES);   // the guard's reference cell

  for (var ci = 0; ci < NP_TTL_COLS.length; ci++) {
    var spec = NP_TTL_COLS[ci];
    var tcol = NP_TTL_BASE + spec.off;
    var out = [];

    for (var d = 0; d < dayRows.length; d++) {
      var rowNo = dayRows[d].r + 1;                              // 1-indexed, for the formula text
      var terms = NP_ORDER.map(function (code) {
        return _npColLetter(NP_BASES[code] + spec.off) + rowNo;
      }).join('+');
      var f = spec.guard
        ? '=IF(ISBLANK(' + ovlSalesCol + rowNo + '),"",' + terms + ')'
        : '=' + terms;
      out.push([f]);
    }

    Logger.log('\n%s -> %s', _npColLetter(tcol) + ' (' + spec.name + ')', out[0][0]);
    Logger.log('  was: %s', String(formulas[dayRows[0].r][tcol]).trim() || '(empty)');

    if (!preview) {
      sh.getRange(dayRows[0].r + 1, tcol + 1, out.length, 1).setFormulas(out);
      Logger.log('  written to %s rows.', out.length);
    }
  }

  Logger.log('\nTTL now sums: %s', NP_ORDER.join(' + '));
  if (preview) Logger.log('PREVIEW ONLY — nothing was written. Run npFixTotalsApply to commit.');
}
