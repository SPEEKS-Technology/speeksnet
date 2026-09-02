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
var NP_TAB_PREFIX = 'Net Profit';              // tabs are "Net Profit Sep 26"
var NP_TAB_LEGACY = 'NET PROFIT TEMPLATE';     // the single tab everything used before
var NP_TAB        = NP_TAB_LEGACY;            // overwritten per run by _npTab()

var NP_ENDPOINT = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/netprofit-collect';
var NP_SECRET   = 'sp33ks-sync-k3y-2026-x9mq';

// The month being written, and therefore WHICH TAB — _npTab() resolves the tab
// name from this, not from the clock.
//
// ⚠️ ONLY MANUAL RUNS READ THESE. npsDailyRefresh and npsMonthClose both set
// NP_FROM/NP_TO themselves at runtime, so whatever is committed here has no
// effect on the 2pm and 7pm jobs. It matters when someone runs npWriteApply or
// npSummaryApply by hand — and a stale month here points those at a tab that
// may not exist, or worse, at one that does.
var NP_FROM = '2026-09-01';
var NP_TO   = '2026-09-30';

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

// ⚠️ SET BY npsDailyRefresh, NOT BY HAND. True on the 8am pass only: the
// shipping column is left exactly as it is, and every other column is written.
//
// The reasoning is the stores' own, and it is why this is safe rather than a
// deliberate understatement of cost: PayMore buys almost no labels before 9am,
// so at 8am yesterday's shipping is genuinely near zero. A blank cell reads as
// zero to the tab's NP formula, and near-zero is what the truth is at that hour.
// Writing a partial figure instead would not be more accurate, only more
// confident. The 2pm pass fills the real number once the labels are bought.
//
// ⚠️ IT SKIPS, IT DOES NOT CLEAR. Every earlier day in the month already holds
// final shipping from a previous 2pm pass, and skipping leaves all of it alone.
// Only the newest day — the one nobody has shipped yet — sits empty until 2pm.
var NP_SKIP_SHIP = false;

// ⚠️ THE TAB HOLDS COMPLETED DAYS ONLY. TODAY IS NOT A COMPLETED DAY.
//
// npsDailyRefresh sets NP_TO to TODAY, so both passes used to write a partial
// current day — whatever had rung up by 8am, then again by 2pm. Ethan asked for
// the opposite and he is right, for a reason bigger than tidiness: Days Thru is
// DERIVED from the last day carrying Sales, so a part-day in the grid counts as
// a whole one in every divisor on the tab. Two full days plus an hour of the
// third projected the month over THREE days. Every tracking column, the % of NP
// Goal and the YoY "Current" figure all read low, all day, every day, and
// nothing about the number said so.
//
// The clamp is here rather than in the schedule so it holds for a hand run too,
// and so the first of the month needs no special case: on Oct 1 every row is
// >= today, nothing is written, and the close has already dealt with September.
//
// ⚠️ A DAY THAT HAS NOT HAPPENED YET HOLDS NOTHING, AND ZERO IS NOT NOTHING.
//
// npWriteApply reads NP_FROM/NP_TO from this file, and those are the whole
// month — so a manual run on the 2nd asked the collector for all 30 days, got
// legitimate zeros for the 29 that have not happened, and wrote them. Zeros are
// not blanks to a spreadsheet: Gross Margin became 0/0, the Rev Tracking column
// projected a month off a divisor that now counted 30 days instead of 1, and the
// tab filled with #DIV/0! and a descending ladder of numbers that all looked
// like real figures. (The 2pm job never showed this because it sets NP_TO to
// today; only a hand-run did.)
//
// So the writer clamps to today in the stores' timezone, whatever it was asked
// for, and clears any future day it finds already filled — which is what repairs
// the damage from the run that caused this note. A locked cell is still never
// touched.
var NP_TZ = 'America/Chicago';
var NP_OFF_NPTRACK_MAX = 14;   // NP Tracking, the rightmost column this file writes
var NP_CLEAR_FUTURE = true;   // clear any row dated today or later that holds data

function npProbe()        { _npProbe(); }
function npTtlRowProbe()  { _npTtlRowProbe(); }
function npFixTrackingPreview() { _npFixTracking(true); }
function npFixTrackingApply()   { _npFixTracking(false); }
function npWritePreview() { _npWrite(true); }
// ⚠️ A HAND RUN ALWAYS WRITES SHIPPING. NP_SKIP_SHIP is a global and one Apps
// Script project is one global scope that survives between executions, so an
// 8am pass leaves it TRUE — and a manual npWriteApply later in the day would
// then silently skip the one column somebody is most likely running it to fill.
function npWriteApply()   { NP_SKIP_SHIP = false; _npWrite(false); }

// ---------------------------------------------------------------------------
// WHICH TAB. From 2026-09 the workbook keeps ONE TAB PER MONTH — "Net Profit
// Sep 26", "Net Profit Oct 26" — the same convention the Sales Summary uses.
//
// ⚠️ THE TAB IS CHOSEN BY THE MONTH BEING WRITTEN, NOT BY TODAY. npsMonthClose
// sets NP_FROM back to the month it is closing, and on the evening of Oct 1
// that means it must write into "Net Profit Sep 26" while the calendar says
// October. Resolving from the clock instead of from NP_FROM would put a closed
// month's final figures into the new month's empty grid.
var NP_MON_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function _npTabName(ym) {
  return NP_TAB_PREFIX + ' ' + NP_MON_ABBR[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(2, 4);
}

function _npTab(ss, ym) {
  ym = ym || String(NP_FROM).slice(0, 7);
  var want = _npTabName(ym);
  var sh = ss.getSheetByName(want);
  if (sh) { NP_TAB = want; return sh; }

  // The single pre-rollover tab. Falling back to it is right while there is
  // only one month in the workbook, but it must be LOUD: silently writing
  // September's figures into a tab called something else is how a month ends
  // up in the wrong place with nothing to show it happened.
  var legacy = ss.getSheetByName(NP_TAB_LEGACY);
  if (legacy) {
    Logger.log('!! no tab "%s" — falling back to "%s". Rename it or run npRollApply.',
      want, NP_TAB_LEGACY);
    NP_TAB = NP_TAB_LEGACY;
    return legacy;
  }
  Logger.log('!! no tab "%s" and no "%s". Nothing written. Tabs present: %s',
    want, NP_TAB_LEGACY,
    ss.getSheets().map(function (s) { return s.getName(); }).join(' | '));
  return null;
}

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
  var sh = _npTab(ss);
  if (!sh) return;

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
  // Compared as YYYY-MM-DD strings, which sort the same way the dates do, and in
  // the STORES' timezone — the script's clock is not necessarily Central and on
  // a late-evening run that is a whole day of difference.
  var todayYmd = Utilities.formatDate(new Date(), NP_TZ, 'yyyy-MM-dd');
  var gridYm = String(NP_FROM).slice(0, 7);

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

    var rows = [], missing = [], future = [], placeholders = 0;
    for (var d = 0; d < data.days.length; d++) {
      var rec = data.days[d];
      var dayNum = parseInt(String(rec.day).slice(8, 10), 10);
      // >= not > : today is in progress, and half a day in the grid is counted
      // as a whole one by Days Thru.
      if (String(rec.day) >= todayYmd) { future.push(dayNum); continue; }
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
      // ⚠️ A LOCK IS PER COLUMN, NOT PER DAY. It used to skip the whole row:
      // one pinned cell and that day's eBay Fee, Shipping and CC Fee froze at
      // whatever they happened to hold, silently, for the rest of the month.
      // Sep 1 at OVL is exactly that case — Sales and Cost are restated by hand
      // because Shopify will not stop reporting a deleted duplicate, and the
      // other three columns still have to keep updating underneath the pin.
      var locked = {}, lockedNames = [];
      [[NP_OFF_SALES, 'Sales'], [NP_OFF_COST, 'Cost'], [NP_OFF_EBAYFEE, 'eBay Fee'],
       [NP_OFF_SHIP, 'Shipping'], [NP_OFF_CCFEE, 'CC Fee']].forEach(function (p) {
        var f = String(formulas[r][base + p[0]]).trim();
        if (f === '') return;
        if (_npIsOurPlaceholder(f)) { placeholders++; return; }
        locked[p[0]] = true;
        // A column we are not writing this pass cannot be "refused" by anything
        // sitting in it, and saying so every morning would train people to skim
        // past the refusals list.
        if (p[0] === NP_OFF_SHIP && NP_SKIP_SHIP) return;
        // Naming the formula matters: "formula already in eBay Fee" repeated
        // 155 times said nothing about WHICH formula, and that is the whole
        // question when deciding whether it is safe to overwrite.
        lockedNames.push(p[1] + ' (' + f + ')');
      });
      if (lockedNames.length) {
        refusals.push(store + ' day ' + dayNum + ': left alone — ' + lockedNames.join(', '));
      }
      rows.push({ r: r, day: dayNum, rec: rec, locked: locked });
    }
    if (missing.length) Logger.log('  !! no row found for day(s): %s', missing.join(', '));
    if (future.length) {
      Logger.log('  %s day(s) not written — not complete yet (%s onward; today is %s, '
        + 'and today is never written)', future.length, future[0], todayYmd);
    }
    // Runs whether or not there is anything to write, because the damage it
    // repairs is exactly a run that wrote days it should not have.
    var wiped = NP_CLEAR_FUTURE
      ? _npClearIncomplete(sh, values, formulas, base, gridYm, todayYmd, preview) : 0;
    if (wiped) {
      Logger.log('  %s incomplete-day cell(s) %s — a day that is not finished must be '
        + 'BLANK, not part-written: a partial day counts as a whole one in Days Thru '
        + 'and pulls every projection on the tab down with it.',
        wiped, preview ? 'WOULD BE cleared' : 'cleared');
    }
    if (placeholders) {
      Logger.log('  %s =NA() placeholder cell(s) from an earlier run will be replaced with real values',
        placeholders);
    }
    if (!rows.length) { Logger.log('  nothing writable'); continue; }

    var salesCol = [], costCol = [], feeCols = [];
    var sSum = 0, cSum = 0, ccSum = 0, shSum = 0, eSum = 0, naEbay = 0, naShip = 0;
    for (var j = 0; j < rows.length; j++) {
      var x = rows[j].rec;
      var ebayFee = (x.ebay_fee === null || x.ebay_fee === undefined)
        ? (NP_BLOCKED_AS_NA ? '=NA()' : '') : x.ebay_fee;
      var ship = (x.shipping_cost === null || x.shipping_cost === undefined)
        ? (NP_BLOCKED_AS_NA ? '=NA()' : '') : x.shipping_cost;
      salesCol.push(x.net_sales);
      costCol.push(x.cost);
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
    Logger.log('  month: Sales %s | Cost %s | eBay Fee %s | Ship %s | CC %s | rows %s-%s',
      Math.round(sSum * 100) / 100, Math.round(cSum * 100) / 100,
      naEbay ? naEbay + ' days #N/A' : Math.round(eSum * 100) / 100,
      NP_SKIP_SHIP ? 'not written this pass'
        : (naShip ? naShip + ' days #N/A' : Math.round(shSum * 100) / 100),
      Math.round(ccSum * 100) / 100,
      rows[0].r + 1, rows[rows.length - 1].r + 1);
    totals.sales += sSum; totals.cost += cSum; totals.cc += ccSum; totals.ship += shSum;
    totals.ebay += eSum;
    totals.naEbay += naEbay; totals.naShip += naShip;

    if (preview) continue;

    // One call per column instead of one per store for the three fee columns.
    // They are adjacent and used to go in a single 3-wide write, which was
    // faster and could not express "all of these except that one cell" — and
    // both of the things this file now has to do, a pinned cell and a skipped
    // column, are exactly that. _npWriteRuns is still block writes; it just
    // breaks the block wherever a cell must not be touched.
    var kept = 0;
    kept += rows.length - _npWriteRuns(sh, rows, base + NP_OFF_SALES + 1, salesCol, NP_OFF_SALES);
    kept += rows.length - _npWriteRuns(sh, rows, base + NP_OFF_COST + 1, costCol, NP_OFF_COST);
    kept += rows.length - _npWriteRuns(sh, rows, base + NP_OFF_EBAYFEE + 1,
      feeCols.map(function (f) { return f[0]; }), NP_OFF_EBAYFEE);
    if (!NP_SKIP_SHIP) {
      kept += rows.length - _npWriteRuns(sh, rows, base + NP_OFF_SHIP + 1,
        feeCols.map(function (f) { return f[1]; }), NP_OFF_SHIP);
    }
    kept += rows.length - _npWriteRuns(sh, rows, base + NP_OFF_CCFEE + 1,
      feeCols.map(function (f) { return f[2]; }), NP_OFF_CCFEE);
    Logger.log('  written.%s%s',
      kept ? '  ' + kept + ' locked cell(s) left as they were.' : '',
      NP_SKIP_SHIP ? '  Shipping not written — morning pass.' : '');
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

// Clear the five written columns on any day row dated TODAY OR LATER.
//
// Today is included on purpose: it is not a completed day, and this is what
// removes the part-day an earlier version of this file wrote before the clamp
// existed. It also handles the ordinary case of a month rolling over.
//
// ⚠️ ONLY PLAIN VALUES, NEVER A FORMULA. A formula is the workbook's lock idiom
// or somebody's work, and neither becomes ours to delete just because the date
// has not passed. Our own =NA() placeholder IS cleared, because it means
// "blocked, not known" and an unfinished day is neither.
function _npClearIncomplete(sh, values, formulas, base, gridYm, todayYmd, preview) {
  var offs = [NP_OFF_SALES, NP_OFF_COST, NP_OFF_EBAYFEE, NP_OFF_SHIP, NP_OFF_CCFEE];
  var n = 0;
  for (var r = NP_HEADER_ROWS; r < values.length; r++) {
    if (String(values[r][0]).trim().toUpperCase() === 'TTL') break;
    var dn = parseInt(values[r][base], 10);
    if (!dn) continue;
    // The row's real date, built from the month the GRID holds — not from today,
    // which in the small hours of the 1st is a different month entirely.
    // < not <= : today's own row is cleared, because today is not finished.
    if (gridYm + '-' + ('0' + dn).slice(-2) < todayYmd) continue;
    for (var i = 0; i < offs.length; i++) {
      var c = base + offs[i];
      var f = String(formulas[r][c]).trim();
      if (f !== '' && !_npIsOurPlaceholder(f)) continue;
      var v = values[r][c];
      if (f === '' && (v === '' || v === null || v === undefined)) continue;
      if (!preview) sh.getRange(r + 1, c + 1).clearContent();
      n++;
    }
  }
  return n;
}

// Write one column down a set of located rows, skipping any cell that is locked
// and any gap in the rows themselves.
//
// ⚠️ IT NEVER WRITES A LOCKED CELL, NOT EVEN BACK TO ITSELF. Putting a cell's
// own formula back would look like a no-op and read as one, and it is not: it
// re-enters the formula, and surviving being re-entered by this script is the
// entire reason a lock exists. So the block is CUT at a locked row and resumed
// after it. A month with one pin costs one extra setValues call.
//
// Returns how many cells it actually wrote, so the caller can say what it left.
function _npWriteRuns(sh, rows, col1, vals, off) {
  var i = 0, wrote = 0;
  while (i < rows.length) {
    if (rows[i].locked[off]) { i++; continue; }
    var j = i;
    // A run ends at a locked cell OR at a break in the row numbers — the rows
    // are located by day number, so a missing day leaves a genuine gap and
    // writing through it would put every later day one row too high.
    while (j + 1 < rows.length && !rows[j + 1].locked[off]
           && rows[j + 1].r === rows[j].r + 1) j++;
    var chunk = [];
    for (var k = i; k <= j; k++) chunk.push([vals[k]]);
    sh.getRange(rows[i].r + 1, col1, chunk.length, 1).setValues(chunk);
    wrote += chunk.length;
    i = j + 1;
  }
  return wrote;
}

// ============================================================================
// npFixTracking — the three projection columns, in all six blocks, plus the TTL
// row they never had.
//
// Measured by npTtlRowProbe on 2026-09-02, not assumed. What it found:
//
// 1. ⚠️ NOTHING DELETED THE TTL ROW'S TRACKING CELLS. They were never there.
//    The empty cells on row 36 are EXACTLY the cumulative columns (Total, GP
//    Total, NP Total), the three tracking columns and MOM — the same seven, in
//    all six blocks. Damage does not pick seven columns out of seventeen and
//    then repeat the choice six times. The tab was built with the projection
//    living on the DAY rows, and every consumer reads the last non-empty cell
//    of the day range: the YoY "Current" figure and the % of NP Goal both do.
//    Row 36 is added here because a month-total row that cannot show the month's
//    projection is a gap for a reader, not because something took it away.
//
// 2. ⚠️ THE COMPANY'S NP TRACKING IS WRONG ON EVERY DAY BUT THE FIRST, and this
//    is the real fault. DA carries, on all 31 rows:
//        =IF(ISBLANK(CN#),"",(CY#/1)*CO$42)
//    Two errors in one cell. It divides by the LITERAL 1 where every other block
//    divides by the day number, and it reads CY — THAT DAY's net profit — where
//    every other block reads the CUMULATIVE column. On day 2 it reports one
//    day's NP times 30 instead of two days' average times 30. The company
//    % of NP Goal is that cell over the goal, which is why it reads nothing
//    like the five stores above it. _npAuditFormulas has described this fault
//    in a comment since August; nothing fixed it.
//
// 3. Row 5 is right by accident everywhere. "(C5/1)*C42" and "(C5/A5)*C$42"
//    agree when A5 is 1, and "(F5/...)" agrees with "(G5/...)" when day 1's GP
//    and cumulative GP are the same number. Both diverge the moment the formula
//    is filled down, which is how the tab drifts. The relative "C42" is the same
//    trap: it walks to C43 — Days Thru — on the row below.
//
// 4. The TTL block guards on ISBLANK(B#) — OVL's sales — in Rev and GP Tracking,
//    and on ISBLANK(CN#), its own, in NP Tracking. It cannot be both. A day
//    where OVL sold nothing and another store did would blank the whole
//    company's projection. Every block now guards on ITS OWN sales column.
//
// The shape is taken from what 29-30 rows of every column already agree on:
//     day row:  =IF(ISBLANK({sales}r),"",({cumulative}r/{day}r)*{total}$D)
//     TTL row:  =IF(ISBLANK({sales}T),"",({month}T/{total}$U)*{total}$D)
// where D is "Days this month" and U is "Days Thru month", both LOCATED by
// label. The TTL row divides by Days Thru because its own day cell reads "TTL".
//
// Every reference is GENERATED from NP_BASES and the offsets. Typing "BJ" for
// MPL's GP Tracking is the error this file is arranged to prevent, and a
// wrong-but-adjacent column still returns a plausible number.
// ============================================================================

// The three projections. "cum" is the numerator on a DAY row — always the
// cumulative column — and "month" the numerator on the TTL row, where there is
// no cumulative and the row itself is the month.
var NP_TRACKING = [
  { off: 3,  name: 'Rev Tracking', cum: 2,  month: 1  },
  { off: 7,  name: 'GP Tracking',  cum: 6,  month: 5  },
  { off: 14, name: 'NP Tracking',  cum: 13, month: 12 }
];

// The formula for ONE tracking cell. Pulled out of the loop so it can be tested
// without a spreadsheet: this is the part that decides a projection, and a
// wrong-but-adjacent column letter still returns a number that looks fine.
//
// ⚠️ THE GUARD IS  x=""  AND NOT  ISBLANK(x).  THEY ARE NOT THE SAME TEST, and
// the difference is a whole company's percentage.
//
// ISBLANK is false for a cell holding a FORMULA that returns "" — the cell is
// not empty, it contains a formula. Every store's Sales column is a written
// value, so ISBLANK worked there; the TTL block's Sales is
// =IF(ISBLANK(B5),"",T5+B5+AL5), a formula, so the guard never fired and the
// company's tracking column computed on all 31 rows instead of just the days
// that have happened.
//
// It failed the way these always do — plausibly. Every consumer reads the LAST
// NON-EMPTY cell of the day range, so "never blank" means it read row 35, day
// 31's fully decayed projection: 6,135.15 x 30 / 31 = 5,937.24, over a
// 284,400 goal, printed as 2.1% where the truth was 64.7%. Measured 2026-09-02.
//
//   x=""      true for an empty cell AND for a formula returning ""
//   ISBLANK   true only for a genuinely empty cell
//
// A real zero is unaffected: 0="" is FALSE in Sheets, so a day that genuinely
// sold nothing still projects.
//
// daysThruRow1 = 0 means a DAY row, which divides by its own day number. Any
// other value means the TTL row, which has no day number — its day cell reads
// "TTL" — and so divides by Days Thru instead, on the row's own month figure.
//
// ⚠️ THE TTL ROW TAKES IFERROR, NOT A GUARD. Its Sales cell is a SUM, which
// returns 0 rather than "" for an empty month, so no ="" test can blank it —
// and on the 1st, before anything is written, Days Thru is 0 and the division
// is what fails. IFERROR blanks exactly that case and nothing else. The day
// rows cannot use IFERROR instead: dividing by a day number never errors, so a
// future day would show 0 rather than blank, and 0 is a value the consumers
// would happily read as the month's projection.
function _npTrackFormula(base, spec, row1, daysThisRow1, daysThruRow1) {
  var salesL = _npColLetter(base + NP_OFF_SALES);
  var totalL = _npColLetter(base + 2);
  if (daysThruRow1) {
    return '=IFERROR((' + _npColLetter(base + spec.month) + row1 + '/'
         + totalL + '$' + daysThruRow1 + ')*' + totalL + '$' + daysThisRow1 + ',"")';
  }
  return '=IF(' + salesL + row1 + '="","",(' + _npColLetter(base + spec.cum) + row1
       + '/' + _npColLetter(base) + row1 + ')*' + totalL + '$' + daysThisRow1 + ')';
}

function _npFixTracking(preview) {
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);
  var sh = _npTab(ss);
  if (!sh) return;

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();

  // Everything located by content. A constant row number here is how a script
  // survives one layout change and silently corrupts the next.
  var firstDay = -1, ttl = -1;
  for (var r = NP_HEADER_ROWS; r < lastRow; r++) {
    var cell = String(values[r][NP_BASES.OVL]).trim();
    if (firstDay < 0 && parseInt(cell, 10) === 1) firstDay = r;
    if (cell.toUpperCase() === 'TTL') { ttl = r; break; }
  }
  var daysThis = -1, daysThru = -1;
  for (var lr = 0; lr < lastRow; lr++) {
    var lbl = String(values[lr][NP_BASES.OVL + 1] || '').trim().toLowerCase();
    if (lbl === 'days this month') daysThis = lr;
    if (lbl === 'days thru month') daysThru = lr;
  }
  // ⚠️ REFUSE RATHER THAN GUESS. Every one of these is a divisor or a
  // multiplier in a projection; a wrong row here is not a broken formula, it is
  // a plausible wrong number in the column the bonus is read from.
  var missing = [];
  if (firstDay < 0) missing.push('day 1 row');
  if (ttl < 0) missing.push('TTL row');
  if (daysThis < 0) missing.push('"Days this month" row');
  if (daysThru < 0) missing.push('"Days Thru month" row');
  if (missing.length) { Logger.log('!! could not locate: %s — nothing done.', missing.join(', ')); return; }

  Logger.log('%s — tab "%s": day rows %s-%s, TTL row %s, Days this month row %s, Days Thru row %s',
    preview ? 'PREVIEW (nothing will be written)' : 'APPLYING',
    NP_TAB, firstDay + 1, ttl, ttl + 1, daysThis + 1, daysThru + 1);

  var blocks = NP_ORDER.map(function (c) { return [c, NP_BASES[c]]; });
  blocks.push(['TTL block', NP_TTL_BASE]);

  var wrote = 0, same = 0, ttlAdded = 0;
  for (var b = 0; b < blocks.length; b++) {
    var code = blocks[b][0], base = blocks[b][1];
    if (base + NP_OFF_NPTRACK_MAX >= lastCol) {
      Logger.log('  %s: block runs past the last column — skipped', code);
      continue;
    }
    for (var t = 0; t < NP_TRACKING.length; t++) {
      var spec = NP_TRACKING[t];
      var col = base + spec.off;
      var changed = [], added = false;

      for (var rr = firstDay; rr < ttl; rr++) {
        var n = rr + 1;
        var want = _npTrackFormula(base, spec, n, daysThis + 1, 0);
        var cur = String(formulas[rr][col] || '').trim();
        if (cur === want) { same++; continue; }
        if (!preview) sh.getRange(n, col + 1).setFormula(want);
        changed.push(n);
        wrote++;
      }

      // The TTL row: no day number to divide by, so Days Thru, and the row's own
      // month figure instead of a cumulative that does not exist there.
      var tn = ttl + 1;
      var ttlWant = _npTrackFormula(base, spec, tn, daysThis + 1, daysThru + 1);
      var ttlCur = String(formulas[ttl][col] || '').trim();
      if (ttlCur === ttlWant) { same++; }
      else {
        if (!preview) sh.getRange(tn, col + 1).setFormula(ttlWant);
        added = true; ttlAdded++; wrote++;
      }

      Logger.log('  %s %s (%s): %s day row(s) %s%s', code, spec.name, _npColLetter(col),
        changed.length,
        changed.length ? (preview ? 'would change' : 'rewritten') + ' — ' + changed.slice(0, 6).join(',')
          + (changed.length > 6 ? '...' : '') : 'already correct',
        added ? ';  TTL row ' + _npColLetter(col) + tn + ' '
              + (preview ? 'WOULD GET' : 'set to') + '  ' + ttlWant : '');
    }
  }

  Logger.log('\n%s %s cell(s) (%s of them the TTL row), %s already correct.',
    preview ? 'WOULD WRITE' : 'WROTE', wrote, ttlAdded, same);
  if (preview) Logger.log('Nothing was written. Run npFixTrackingApply() to write it.');
}

// ============================================================================
// npTtlRowProbe — dump the TTL ROW, and the two day rows above it, formula by
// formula, for all six blocks. READ-ONLY.
//
// ⚠️ THE TTL ROW IS NOT THE TTL BLOCK, and confusing the two is easy: the BLOCK
// is the company column group at CM, the ROW is the month total at the bottom of
// every block's day grid. npProbe describes the block. Nothing described the row
// until Rev Tracking and GP Tracking went missing from it (Ethan, 2026-09-02)
// and there was no way to see what had been there.
//
// It prints the last two DAY rows beside it on purpose. A tracking formula is
// only meaningful next to the ones it was filled down from, and the difference
// between "(Total/day number) * days in month" and "(Total/days thru) * days in
// month" is invisible on a single row and worth thousands on a projection.
// ============================================================================
function _npTtlRowProbe() {
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);
  var sh = _npTab(ss);
  if (!sh) return;

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();

  // Located, not counted: the TTL row is wherever 'TTL' sits in OVL's day column.
  var ttl = -1;
  for (var r = NP_HEADER_ROWS; r < lastRow; r++) {
    if (String(values[r][NP_BASES.OVL]).trim().toUpperCase() === 'TTL') { ttl = r; break; }
  }
  if (ttl < 0) { Logger.log('!! no TTL row found in column %s', _npColLetter(NP_BASES.OVL)); return; }
  Logger.log('tab "%s" — TTL row is %s; day rows end at %s', NP_TAB, ttl + 1, ttl);

  var names = ['day', 'Sales', 'Total', 'Rev Tracking', 'Cost', 'GP', 'GP Total',
               'GP Tracking', 'Gross Margin', 'eBay Fee', 'Shipping', 'CC Fee',
               'NP', 'NP Total', 'NP Tracking', 'Net Margin', 'MOM'];
  var blocks = NP_ORDER.map(function (c) { return [c, NP_BASES[c]]; });
  blocks.push(['TTL block', NP_TTL_BASE]);

  var rowsToShow = [ttl - 2, ttl - 1, ttl];
  for (var b = 0; b < blocks.length; b++) {
    var code = blocks[b][0], base = blocks[b][1];
    Logger.log('\n=== %s (day col %s) ===', code, _npColLetter(base));
    for (var i = 0; i < names.length; i++) {
      var c = base + i;
      if (c >= lastCol) break;
      var parts = [];
      for (var k = 0; k < rowsToShow.length; k++) {
        var rr = rowsToShow[k];
        if (rr < 0) continue;
        var f = String((formulas[rr] || [])[c] || '').trim();
        var v = (values[rr] || [])[c];
        parts.push((rr + 1) + ': ' + (f ? f : (v === '' || v === null || v === undefined ? '(EMPTY)' : v)));
      }
      Logger.log('  +%s %-13s %s | %s', i, names[i], _npColLetter(c), parts.join('   '));
    }
  }

  // ---- the three TRACKING columns, every day row, as shapes ----------------
  // ⚠️ THIS IS THE PART THAT DECIDES WHETHER A REPAIR IS POSSIBLE. If the day
  // rows still carry their formula, the TTL row can be rebuilt from the shape
  // that is demonstrably in use rather than from a guess. If they are gone too,
  // there is nothing on the tab to copy and the answer has to come from Ethan.
  //
  // Each formula is normalised by replacing its own row number with '#', so a
  // whole column of correctly filled-down cells collapses to ONE line. Anything
  // that does not collapse is a cell that disagrees with its neighbours — which
  // is exactly how the two TTL-block faults in _npAuditFormulas were found.
  var trackOffs = [[3, 'Rev Tracking'], [7, 'GP Tracking'], [14, 'NP Tracking']];
  var firstDay = -1;
  for (var fr = NP_HEADER_ROWS; fr < ttl; fr++) {
    if (parseInt(values[fr][NP_BASES.OVL], 10) === 1) { firstDay = fr; break; }
  }
  Logger.log('\n=== TRACKING COLUMNS, day rows %s-%s, formulas normalised ===',
    firstDay + 1, ttl);
  for (var tb = 0; tb < blocks.length; tb++) {
    var tcode = blocks[tb][0], tbase = blocks[tb][1];
    for (var to = 0; to < trackOffs.length; to++) {
      var tc = tbase + trackOffs[to][0];
      if (tc >= lastCol) continue;
      var shapes = {}, empties = [];
      for (var dr = firstDay; dr < ttl; dr++) {
        var df = String((formulas[dr] || [])[tc] || '').trim();
        if (!df) { empties.push(dr + 1); continue; }
        // Row numbers become '#', so a filled-down column reduces to one shape.
        var norm = df.split(String(dr + 1)).join('#');
        (shapes[norm] = shapes[norm] || []).push(dr + 1);
      }
      var keys = Object.keys(shapes);
      Logger.log('  %s %s (%s): %s shape(s)%s', tcode, trackOffs[to][1], _npColLetter(tc),
        keys.length, empties.length ? ', ' + empties.length + ' row(s) EMPTY' : '');
      for (var ki = 0; ki < keys.length; ki++) {
        var rws = shapes[keys[ki]];
        Logger.log('      %s   [rows %s%s]', keys[ki], rws.slice(0, 3).join(','),
          rws.length > 3 ? '..' + rws[rws.length - 1] + ', ' + rws.length + ' rows' : '');
      }
      if (empties.length) {
        Logger.log('      EMPTY: rows %s%s', empties.slice(0, 6).join(','),
          empties.length > 6 ? ' ... (' + empties.length + ' rows)' : '');
      }
    }
  }

  // ---- the goal strip, because "% of NP Goal shows 0%" lives here -----------
  // The percentage is  last non-empty NP Tracking on the day rows / NP Goal.
  // Both halves are printed, so the 0% can be attributed rather than guessed at:
  // an empty goal and an empty numerator produce a BLANK, and a zero numerator
  // over a real goal produces 0%. They are different faults.
  Logger.log('\n=== GOAL STRIP (rows 1-2) ===');
  for (var gb2 = 0; gb2 < blocks.length; gb2++) {
    var gbase = blocks[gb2][1];
    var line = [];
    [[3, 'label'], [4, 'value']].forEach(function (p) {
      for (var gr = 0; gr < 2; gr++) {
        var gc = gbase + p[0];
        if (gc >= lastCol) return;
        var gf = String((formulas[gr] || [])[gc] || '').trim();
        var gv = (values[gr] || [])[gc];
        line.push(_npColLetter(gc) + (gr + 1) + '=' + (gf ? gf
          : (gv === '' || gv === null || gv === undefined ? '(EMPTY)' : gv)));
      }
    });
    Logger.log('  %s: %s', blocks[gb2][0], line.join('  |  '));
  }

  // ---- the two divisors every projection depends on -------------------------
  Logger.log('\n=== DAYS ROWS ===');
  for (var lr = 0; lr < values.length; lr++) {
    var lbl = String(values[lr][NP_BASES.OVL + 1] || '').trim().toLowerCase();
    if (lbl.indexOf('days') !== 0) continue;
    var dline = [];
    for (var db = 0; db < blocks.length; db++) {
      var dc = blocks[db][1] + 2;
      if (dc >= lastCol) continue;
      var dfm = String((formulas[lr] || [])[dc] || '').trim();
      dline.push(blocks[db][0] + ' ' + _npColLetter(dc) + (lr + 1) + '='
        + (dfm ? dfm : (values[lr][dc] === '' ? '(EMPTY)' : values[lr][dc])));
    }
    Logger.log('  row %s "%s": %s', lr + 1, values[lr][NP_BASES.OVL + 1], dline.join('  |  '));
  }

  // The one line worth reading first: what is actually missing on the TTL row.
  Logger.log('\n=== EMPTY ON THE TTL ROW (row %s) ===', ttl + 1);
  var anyGap = false;
  for (var b2 = 0; b2 < blocks.length; b2++) {
    var gaps = [];
    for (var i2 = 1; i2 < names.length; i2++) {
      var c2 = blocks[b2][1] + i2;
      if (c2 >= lastCol) break;
      var f2 = String((formulas[ttl] || [])[c2] || '').trim();
      var v2 = (values[ttl] || [])[c2];
      if (!f2 && (v2 === '' || v2 === null || v2 === undefined)) {
        gaps.push(names[i2] + ' (' + _npColLetter(c2) + ')');
      }
    }
    if (gaps.length) { anyGap = true; Logger.log('  %s: %s', blocks[b2][0], gaps.join(', ')); }
  }
  if (!anyGap) Logger.log('  none — every TTL-row cell carries a formula or a value.');
  Logger.log('\nRead-only. Nothing was written.');
}

function _npProbe() {
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);
  var names = ss.getSheets().map(function (s) { return '"' + s.getName() + '"'; });
  Logger.log('TABS (%s): %s', names.length, names.join(', '));
  var sh = _npTab(ss);
  if (!sh) return;
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

  _npAuditFormulas(formulas, values);
}

// ============================================================================
// _npAuditFormulas — find the day rows whose formula does not match the rest of
// its own column.
//
// WHY: reading row 5 tells you almost nothing. Day 1 is where a broken formula
// is RIGHT BY ACCIDENT — `(CY5/1)*CO$40` and `(CY5/CM5)*CO$40` are the same
// number when CM5 is 1, and a relative `CO40` still points at row 40 when it is
// written on row 5. Both only diverge once the formula is filled down, and by
// then nobody is reading row 5.
//
// The two that prompted this, both in the TTL block:
//   CT (GP Tracking)  = ...(CR5/CM5)*CO40    -- CO40 is RELATIVE where every
//                       sibling uses CO$40, so a fill-down walks it to CO41,
//                       CO42 ... into blank cells.
//   DA (NP Tracking)  = ...(CY5/1)*CO$40     -- divides by the LITERAL 1 where
//                       siblings divide by CM5, the day number. On day 20 of a
//                       31-day month that reports 31x MTD instead of 1.55x —
//                       and NP Tracking is the projected-month figure the bonus
//                       conversation will actually look at.
// Neither is written by this file; the TTL block is never touched except by
// npFixTotals, and then only its five data columns.
//
// Normalises each formula by replacing its own row number with '#', so every
// day row in a column should reduce to an IDENTICAL string. Anything that does
// not is reported with its row. Read-only.
// ============================================================================
function _npAuditFormulas(formulas, values) {
  // Derive the day rows from the sheet, never from a constant: the whole point
  // of this audit is to catch a tab that has drifted from what the code assumes.
  // Column A (OVL's day column) holds 1..31; stop at the first row that is not
  // the next day number, which is TTL.
  var first = NP_HEADER_ROWS + 1, last = first - 1;
  for (var rr = first; rr <= values.length; rr++) {
    if (Number(String(values[rr - 1][0]).trim()) !== (rr - first + 1)) break;
    last = rr;
  }
  if (last < first) { Logger.log('\n=== FORMULA CONSISTENCY: no day rows found, skipped ==='); return; }
  Logger.log('\n=== FORMULA CONSISTENCY, day rows %s-%s ===', first, last);

  var problems = 0;
  var lastCol = formulas[0].length;
  for (var c = 0; c < lastCol; c++) {
    var shapes = {};   // normalised formula -> [rows]
    for (var r = first; r <= last; r++) {
      var f = String((formulas[r - 1] || [])[c] || '').trim();
      if (!f) continue;
      // Replace this row's own number wherever it appears as a row reference.
      // A2, $A$2 and 2 in `CO$40` are all handled: only digits that follow a
      // column letter are touched, and only when they equal this row.
      var norm = f.replace(/(\$?[A-Z]{1,3}\$?)(\d+)/g, function (m, col, num) {
        return col + (Number(num) === r ? '#' : num);
      });
      (shapes[norm] = shapes[norm] || []).push(r);
    }
    var keys = Object.keys(shapes);
    if (keys.length <= 1) continue;
    // The majority shape is the column's intent; anything else is the odd one out.
    keys.sort(function (a, b) { return shapes[b].length - shapes[a].length; });
    problems++;
    Logger.log('  !! %s (%s): %s different shapes',
      _npColLetter(c), String(values[NP_HEADER_ROWS - 1][c] || '').trim() || '(no header)', keys.length);
    for (var k = 0; k < keys.length; k++) {
      var rows = shapes[keys[k]];
      Logger.log('       %s row%s %s%s',
        (k === 0 ? 'MAJORITY' : 'ODD     '),
        rows.length === 1 ? '' : 's',
        rows.length > 6 ? rows.slice(0, 6).join(',') + ',... (' + rows.length + ')' : rows.join(','),
        '  ' + keys[k]);
    }
  }
  Logger.log(problems ? '  %s column(s) are not internally consistent.'
                      : '  every column is internally consistent.', problems);

  // ⚠️ THE SHAPE AUDIT ABOVE IS INFORMATIONAL, NOT A VERDICT — and it cost a
  // false alarm to learn that. Every Tracking column in this tab hard-types its
  // divisor per row (`/1` on day 1, `/2` on day 2 ...), so no two rows share a
  // shape and all 18 of them report as "inconsistent". Reading row 5's `/1` as a
  // literal-1 bug, I called NP Tracking 20x wrong. It is not: rows 6+ carry `/2`,
  // `/3`, `/4`, and the VALUES are right on every row checked.
  //
  // A formula states intent. Only the value states the result. So the checks that
  // follow compare what the tab COMPUTES against what the column MEANS, and those
  // are the verdict.
  //
  // (The hard-typed divisors are still a real fragility — nothing makes them
  // follow if a row is inserted or the month is rolled over — but that is a
  // maintenance note, not an error, and it is not what this should shout about.)
  _npAuditValues(values, formulas, first, last);
}

// ============================================================================
// _npAuditValues — check the tab's arithmetic against its own column headings.
// Read-only. This is what actually found the Net Margin inversion.
// ============================================================================
function _npAuditValues(values, formulas, first, last) {
  var daysInMonth = last - first + 1;
  var num = function (v) { var n = Number(v); return isFinite(n) ? n : null; };
  var near = function (a, b, tol) { return a !== null && b !== null && Math.abs(a - b) < (tol || 0.02); };

  Logger.log('\n=== VALUE CHECKS (what the tab computes vs what the heading means) ===');
  var fails = 0;

  NP_ORDER.concat(['TTL']).forEach(function (code) {
    var base = (code === 'TTL') ? NP_TTL_BASE : NP_BASES[code];
    if (base === undefined) return;
    var bad = [];
    for (var r = first; r <= last; r++) {
      var row = values[r - 1], day = r - first + 1;
      var sales = num(row[base + NP_OFF_SALES]);
      if (!sales) continue;                      // a day with no sales proves nothing
      var np    = num(row[base + 12]);
      var npTot = num(row[base + 13]);
      var npTrk = num(row[base + 14]);
      var netMg = num(row[base + 15]);
      var cost  = num(row[base + NP_OFF_COST]);
      var gp    = num(row[base + 5]);

      // 1. NP = sales - cost - eBay - shipping - cc - 7% of sales
      var wantNp = sales - cost - num(row[base + NP_OFF_EBAYFEE])
                 - num(row[base + NP_OFF_SHIP]) - num(row[base + NP_OFF_CCFEE]) - sales * 0.07;
      if (!near(wantNp, np)) bad.push('day ' + day + ' NP is ' + np + ', arithmetic says ' + wantNp.toFixed(2));

      // 2. Tracking projects the month from the RUNNING TOTAL and the day number.
      if (npTot !== null && npTrk !== null && !near((npTot / day) * daysInMonth, npTrk, 0.05)) {
        bad.push('day ' + day + ' NP Tracking is ' + npTrk + ', (MTD/day)*' + daysInMonth
                 + ' says ' + ((npTot / day) * daysInMonth).toFixed(2));
      }

      // 3. ⚠️ THE ONE THAT WAS WRONG IN THE SHIPPED TAB. Net Margin is NP/Sales.
      //    Gross Margin is written 1-(Cost/Sales), which is correct because Cost
      //    IS a cost — 1 minus it leaves the margin. Net Margin copied that shape
      //    as 1-(NP/Sales), but NP is the RESULT, not a cost, so the same formula
      //    reports the inverse: 67.52% where the real net margin is 32.48%.
      if (netMg !== null && !near(np / sales, netMg, 0.0005)) {
        bad.push('day ' + day + ' Net Margin reads ' + (netMg * 100).toFixed(2)
                 + '% but NP/Sales is ' + ((np / sales) * 100).toFixed(2) + '%'
                 + (Math.abs((1 - np / sales) - netMg) < 0.0005 ? '  <- INVERTED, it is showing 1 - margin' : ''));
      }
      // 4. Gross Margin, as the control: if this also fails, the block is misaligned.
      var grossMg = num(row[base + 8]);
      if (grossMg !== null && gp !== null && !near(gp / sales, grossMg, 0.0005)) {
        bad.push('day ' + day + ' Gross Margin reads ' + (grossMg * 100).toFixed(2)
                 + '% but GP/Sales is ' + ((gp / sales) * 100).toFixed(2) + '%');
      }
    }
    if (bad.length) {
      fails++;
      Logger.log('  !! %s — %s problem(s); first few:', code, bad.length);
      for (var i = 0; i < Math.min(3, bad.length); i++) Logger.log('       %s', bad[i]);
    } else {
      Logger.log('   ok %s — NP, Tracking, Gross Margin and Net Margin all agree with the data.', code);
    }
  });
  Logger.log(fails ? '  %s block(s) have a column that does not compute what its heading says.'
                   : '  every block computes what its headings say.', fails);
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

// ============================================================================
// npFixNetMargin — Net Margin is showing 1 minus itself, in all six blocks.
//
//   Gross Margin  =1-(E5/B5)     RIGHT. Cost IS a cost, so 1 minus cost-over-
//                                sales leaves the margin.
//   Net Margin    =1-(M5/B5)     WRONG. NP is the RESULT, not a cost. The same
//                                shape reports the inverse: OVL day 1 reads
//                                67.52% where the real net margin is 32.48%.
//
// Verified on rows 5-8 at OVL and row 5 at all five stores plus TTL: in every
// case the printed figure equals 1 - (NP/Sales) exactly. Gross Margin is correct
// everywhere, which is what rules out a misaligned block and leaves the formula
// itself as the fault.
//
// Rewrites the Net Margin cell on every day row of every block, including TTL —
// this is a display column, not one of the five TTL data columns npFixTotals
// guards, and leaving TTL inverted while the stores read true would be worse
// than either. Preview first.
// ============================================================================
function npFixNetMarginPreview() { _npFixNetMargin(true); }
function npFixNetMarginApply()   { _npFixNetMargin(false); }

function _npFixNetMargin(dryRun) {
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);
  var sh = _npTab(ss);
  if (!sh) return;
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();

  // Day rows from the sheet itself, never from a constant.
  var first = NP_HEADER_ROWS + 1, last = first - 1;
  for (var rr = first; rr <= lastRow; rr++) {
    if (Number(String(values[rr - 1][0]).trim()) !== (rr - first + 1)) break;
    last = rr;
  }
  if (last < first) { Logger.log('!! no day rows found'); return; }

  Logger.log(dryRun ? '=== PREVIEW — nothing will be written ===' : '=== APPLYING ===');
  var wrote = 0, already = 0;
  NP_ORDER.concat(['TTL']).forEach(function (code) {
    var base = (code === 'TTL') ? NP_TTL_BASE : NP_BASES[code];
    if (base === undefined) return;
    var salesCol = base + NP_OFF_SALES, npCol = base + 12, mgCol = base + 15;
    var sL = _npColLetter(salesCol), nL = _npColLetter(npCol), mL = _npColLetter(mgCol);
    var changed = 0;
    for (var r = first; r <= last; r++) {
      // IFERROR so a day with no sales reads blank rather than #DIV/0!, which is
      // what the Gross Margin column does today on empty days.
      var want = '=IFERROR(' + nL + r + '/' + sL + r + ',"")';
      var cur = String(sh.getRange(r, mgCol + 1).getFormula()).trim();
      if (cur === want) { already++; continue; }
      if (!dryRun) sh.getRange(r, mgCol + 1).setFormula(want);
      wrote++; changed++;
    }
    Logger.log('  %s  Net Margin %s  rows %s-%s  %s cell(s) %s',
      code, mL, first, last, changed, dryRun ? 'would change' : 'written');
  });
  Logger.log('%s %s cell(s), %s already correct.',
    dryRun ? 'PREVIEW:' : 'DONE:', wrote, already);
  if (dryRun) Logger.log('Run npFixNetMarginApply() to write.');
}

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
  var sh = _npTab(ss);
  if (!sh) return;

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

// ============================================================================
// npProbeSummary — dump the SUMMARY BLOCK under the day grid.
//
// READ-ONLY. Writes nothing.
//
// The day grid (rows 5-36) was measured on 2026-08-26 and is documented at the
// top of this file. Everything BELOW it — "Days this month", "Days Thru month",
// "Net GP MTD", the tracking and MoM cells, the "Last month" strip and the YoY
// block — never has been. The screenshot shows those cells carrying #DIV/0!
// because "Days Thru month" reads 0, and the fix has to write into them.
//
// ⚠️ MEASURE, DO NOT ASSUME. This file's own rule. A formula written against a
// guessed address lands in whatever is actually there, and on this tab that is
// a Net Profit figure a bonus is paid from. Run this, paste me the log, and the
// additions get built against real addresses.
// ============================================================================
function npProbeSummary() {
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);
  var sh = _npTab(ss);
  if (!sh) return;

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();

  // Find the TTL row so the dump starts just below the grid rather than at a
  // hard-coded 36 — the same "locate it, never count to it" rule the writer uses.
  var ttlRow = -1;
  for (var r = NP_HEADER_ROWS; r < lastRow; r++) {
    if (String(values[r][0]).trim().toUpperCase() === 'TTL') { ttlRow = r; break; }
  }
  Logger.log('TAB "%s": %s rows x %s cols. TTL row = %s (1-based). Dumping %s..%s.',
    NP_TAB, lastRow, lastCol, ttlRow + 1, ttlRow + 2, lastRow);

  var blocks = [];
  for (var s in NP_BASES) blocks.push([s, NP_BASES[s]]);
  blocks.push(['TTL', NP_TTL_BASE]);
  blocks.sort(function (a, b) { return a[1] - b[1]; });

  for (var b = 0; b < blocks.length; b++) {
    var name = blocks[b][0], base = blocks[b][1];
    var end = (b + 1 < blocks.length) ? blocks[b + 1][1] : lastCol;
    Logger.log('\n===== %s  (columns %s..%s) =====',
      name, _npColLetter(base), _npColLetter(end - 1));
    for (var rr = ttlRow + 1; rr < lastRow; rr++) {
      var parts = [];
      for (var c = base; c < end; c++) {
        var f = String(formulas[rr][c]).trim();
        var v = String(values[rr][c]).trim();
        if (f === '' && v === '') continue;
        parts.push(_npColLetter(c) + (rr + 1) + '=' + (f !== '' ? f : JSON.stringify(v)));
      }
      if (parts.length) Logger.log('  row %s: %s', rr + 1, parts.join('  |  '));
    }
  }

  // Anything living to the RIGHT of the last block would be missed above.
  Logger.log('\n===== beyond the last block (columns %s..%s) =====',
    _npColLetter(NP_TTL_BASE + 18), _npColLetter(lastCol - 1));
  for (var r2 = ttlRow + 1; r2 < lastRow; r2++) {
    var extra = [];
    for (var c2 = NP_TTL_BASE + 18; c2 < lastCol; c2++) {
      var f2 = String(formulas[r2][c2]).trim(), v2 = String(values[r2][c2]).trim();
      if (f2 === '' && v2 === '') continue;
      extra.push(_npColLetter(c2) + (r2 + 1) + '=' + (f2 !== '' ? f2 : JSON.stringify(v2)));
    }
    if (extra.length) Logger.log('  row %s: %s', r2 + 1, extra.join('  |  '));
  }
  Logger.log('\nRead-only: nothing was written.');
}

// ============================================================================
// npProbeGrid — the half of the tab npProbeSummary could not see.
//
// READ-ONLY. Writes nothing.
//
// npProbeSummary dumped everything BELOW the TTL row and answered where the
// last-month and YoY values live. Three things are still unmeasured and all
// three are needed before anything is written:
//
//   1. THE COLUMN MEANINGS. The summary block reads M36, D5:D35 and B5:B35 but
//      never says what those columns ARE. The last-month writer has to produce
//      Revenue, GP and Net Profit in the same terms the grid uses, and "the
//      same terms" is a formula, not a guess.
//   2. THE "% OF GOAL" CELL. It is not below the TTL row — the summary probe
//      would have found it. It is somewhere in rows 1-4 or off to the side,
//      and colouring a cell requires knowing which cell.
//   3. EXISTING CONDITIONAL FORMAT RULES. Adding a rule to a range that already
//      has one does not replace it; both apply, and the older one usually wins.
//      A green cell that refuses to turn red is this, every time.
// ============================================================================
function npProbeGrid() {
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);
  var sh = _npTab(ss);
  if (!sh) return;

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();

  // --- 1. the OVL block in full: headers, the first day rows, the TTL row ---
  // One block is enough: the other five are the same shape 18 columns along,
  // which npProbeSummary already confirmed.
  Logger.log('===== OVL block (columns A..R) — headers, first days, TTL =====');
  var rows = [1, 2, 3, 4, 5, 6, 7, 36];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] - 1;
    if (r < 0 || r >= lastRow) continue;
    var parts = [];
    for (var c = 0; c < 18; c++) {
      var f = String(formulas[r][c]).trim(), v = String(values[r][c]).trim();
      if (f === '' && v === '') continue;
      parts.push(_npColLetter(c) + (r + 1) + '=' + (f !== '' ? f : JSON.stringify(v)));
    }
    Logger.log('  row %s: %s', r + 1, parts.length ? parts.join('  |  ') : '(empty)');
  }

  // --- 2. anything anywhere that names a goal ---
  Logger.log('\n===== every cell whose text mentions goal / target / %% of =====');
  var hits = 0;
  for (var rr = 0; rr < lastRow; rr++) {
    for (var cc = 0; cc < lastCol; cc++) {
      var t = String(values[rr][cc]);
      if (!/goal|target|% ?of/i.test(t)) continue;
      var ff = String(formulas[rr][cc]).trim();
      Logger.log('  %s%s = %s', _npColLetter(cc), rr + 1,
        ff !== '' ? ff : JSON.stringify(t.trim()));
      hits++;
    }
  }
  if (!hits) Logger.log('  (none — the goal cell is not labelled on this tab)');

  // --- 3. conditional formatting already on the sheet ---
  var rules = sh.getConditionalFormatRules();
  Logger.log('\n===== %s existing conditional format rule(s) =====', rules.length);
  for (var k = 0; k < rules.length; k++) {
    var rs = rules[k].getRanges().map(function (x) { return x.getA1Notation(); });
    Logger.log('  [%s] ranges: %s', k, rs.join(', '));
  }

  Logger.log('\nRead-only: nothing was written.');
}
