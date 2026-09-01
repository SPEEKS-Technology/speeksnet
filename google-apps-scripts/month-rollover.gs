// ============================================================
// SPEEKS — MONTH ROLLOVER for the Sales Summary workbook
//
// Does by script what has been done by hand every month: duplicate the Sales
// and Buy tabs, clear last month's keyed figures, resize the day grid to the new
// month, move the weekly rows onto the new month's Sundays, and write the GP
// goals that were entered on SPEEKS.
//
// ⚠️ IT COPIES, IT DOES NOT REBUILD. Every tab is made with copyTo(), so every
// formula, format, conditional format, merge, column width, validation and note
// survives untouched. Nothing here authors a formula of its own. The only cells
// it clears are the ones holding a TYPED VALUE inside the day grid — a cell with
// a formula is left exactly as it is. That is what keeps "the exact formatting
// and formulas" true by construction rather than by care.
//
// WHY IT MATTERS THAT THIS RUNS. The site reads the CURRENT month's tabs every
// ten minutes (Apps Script doGet -> sync-buysell -> app_cache.buy_sell_hub). If
// the tabs for a new month do not exist, that cache goes empty and the `hub`
// function falls back to store_daily_* tables frozen at May 2026 — months-old
// numbers, with no error anywhere. The 9am history sync also reads LAST month's
// tab to pick up its final day, which the hourly capture structurally cannot
// get. So this is not housekeeping; it is what keeps the dashboards true.
//
// ⚠️ DEPLOY AS A **STANDALONE** APPS SCRIPT PROJECT — not the spreadsheet's
// bound project (which still holds the dead sales-sync.gs) and not the
// buysell-history project. One project is one global scope, and a name collision
// there would silently read a different geometry. Every global here is prefixed
// MR_/_mr for the same reason.
//
// SETUP (one-time)
//   1. script.google.com → New project → paste this file → save.
//   2. Run `mrDiagnose` and authorise. READ THE LOG. It prints the geometry it
//      found, how many typed cells it would clear, which cells it believes are
//      the weekly rows, and every footer it would write — all against the real
//      workbook, so nothing below is assumed.
//   3. Run `mrPreviewNextMonth`. It builds "Sales Sep 26 (PREVIEW)" and
//      "Buy Sep 26 (PREVIEW)" to be eyeballed beside the real ones. Happy →
//      `mrCommitPreview` renames them into place. Not happy → delete the two
//      PREVIEW tabs; nothing else was touched.
//   4. Run `mrInstallTrigger` once. It fires at 4am on the 1st, ahead of the 7am
//      sales import and the 9am history sync.
//   5. Deploy → New deployment → Web app (Execute as: Me, Access: Anyone) and
//      put the /exec URL in the MONTH_ROLLOVER_URL secret of the gp-goals edge
//      function, so goals entered on SPEEKS reach the sheet at once.
//      ⚠️ After ANY later edit: Deploy → Manage deployments → pencil →
//      Version: New version → Deploy. Saving does not change what /exec serves.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH
//   • B2B — stays manual on the sheet (Ethan's call, 2026-08-12).
//   • Anything outside the day grid and the labelled footer cells in MR_FOOTER.
//   • The source month, which is opened read-only in every path here.
// ============================================================

var MR_SHEET_ID = '1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8';
var MR_GOALS_URL = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/gp-goals';

// Shared with the edge functions. Only the web endpoints check it; the rollover
// itself runs on a time trigger and is not reachable from outside.
var MR_SECRET = 'sp33ks-sync-k3y-2026-x9mq';

var MR_STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
var MR_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
var MR_MON_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var MR_MON_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                   'August', 'September', 'October', 'November', 'December'];

// Block widths and the first row a day can appear on. Same numbers as
// buysell-history.gs and used the same way: as the WIDTH UNIT only. Each store's
// real column is read off that tab's own header rows, because MPL and BAL opened
// in April 2026 and in earlier tabs the TTL block sits exactly where MPL's does
// now — fixed positions once imported a whole district's totals as one store.
var MR_SALES_WIDTH = 11;
var MR_SALES_FIRST_ROW = 4;   // 0-based
var MR_BUY_WIDTH = 5;
var MR_BUY_FIRST_ROW = 1;     // 0-based
var MR_HEADER_ROWS = 4;

// Footer cells worth updating, by the LABEL beside them. Matched as a whole
// cell, case-insensitively; only the first cell to the right that is NOT a
// formula gets written.
var MR_FOOTER = {
  goal:      ['gp goal', 'goal'],
  days:      ['days this month', 'days in month'],
  thru:      ['days thru month', 'days through month'],
  buyDays:   ['buying days in month', 'buying days'],
  lastMonth: ['last month']
};
var MR_TOTAL_LABELS = ['ttl', 'total'];

// ⚠️ THE BUY TAB DOES NOT PUT ITS COUNTERS BESIDE THEIR LABEL. The label is
// merged across B:D and printed ONCE, while the five values sit at base+4 in
// each store's block — E39, J39, O39, T39, Y39. Writing "the first free cell to
// the right of the label" therefore aims at C39, which is inside the merge, and
// setValue on part of a merged range writes to the merge's TOP-LEFT: it replaces
// the label with a number. sales-email-import.gs learned this first; the same
// offset is spelled out there as BUY_DAYS_THRU_COL.
var MR_BUY_VALUE_COL = 4;

// ---- small helpers ----------------------------------------------------------
function _mrPad(n) { return n < 10 ? '0' + n : '' + n; }

function _mrTabMonth(name) {
  var m = /^(?:Sales|Buy)\s+([A-Za-z]+)\.?\s*'?(\d{2}|\d{4})\s*$/i.exec(String(name || '').trim());
  if (!m) return null;
  var mo = MR_MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  var yr = m[2].length === 2 ? 2000 + parseInt(m[2], 10) : parseInt(m[2], 10);
  return yr + '-' + _mrPad(mo);
}

// The new tab is named in the SOURCE's own dialect — "Sales Sep 26" if that is
// how this workbook writes them. A rollover that quietly changed the convention
// would break every reader that matches on it, this script included.
function _mrNameLike(sourceName, ym) {
  var m = /^(Sales|Buy)\s+([A-Za-z]+)(\.?)\s*('?)(\d{2}|\d{4})\s*$/i.exec(String(sourceName || '').trim());
  if (!m) return null;
  var parts = ym.split('-');
  var yr = parseInt(parts[0], 10), mo = parseInt(parts[1], 10);
  var isFull = MR_MON_FULL.join('|').toLowerCase().indexOf(m[2].toLowerCase()) >= 0 && m[2].length > 3;
  var monName = isFull ? MR_MON_FULL[mo - 1] : MR_MON_ABBR[mo - 1];
  var yrTxt = m[5].length === 2 ? _mrPad(yr % 100) : String(yr);
  return m[1] + ' ' + monName + m[3] + ' ' + m[4] + yrTxt;
}

function _mrPrevMonth(ym) {
  var p = ym.split('-'), y = parseInt(p[0], 10), m = parseInt(p[1], 10) - 1;
  if (m < 1) { m = 12; y--; }
  return y + '-' + _mrPad(m);
}
function _mrNextMonth(ym) {
  var p = ym.split('-'), y = parseInt(p[0], 10), m = parseInt(p[1], 10) + 1;
  if (m > 12) { m = 1; y++; }
  return y + '-' + _mrPad(m);
}
function _mrDaysIn(ym) {
  var p = ym.split('-');
  return new Date(parseInt(p[0], 10), parseInt(p[1], 10), 0).getDate();
}
// Which day numbers of a month are Sundays. Built from the parts, never
// Date.parse of 'YYYY-MM' — that reads as UTC and lands a day early.
function _mrSundays(ym) {
  var p = ym.split('-'), y = parseInt(p[0], 10), m = parseInt(p[1], 10);
  var out = [], n = _mrDaysIn(ym);
  for (var d = 1; d <= n; d++) if (new Date(y, m - 1, d).getDay() === 0) out.push(d);
  return out;
}
function _mrCentralMonth() {
  return Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM');
}
function _mrSs() { return SpreadsheetApp.openById(MR_SHEET_ID); }

function _mrIndex(ss) {
  var idx = {};
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    var ym = _mrTabMonth(name);
    if (!ym) return;
    if (!idx[ym]) idx[ym] = { sales: null, buy: null };
    if (/^Sales\s/i.test(name)) idx[ym].sales = sh;
    else idx[ym].buy = sh;
  });
  return idx;
}
function _mrLatestMonth(idx) {
  var keys = Object.keys(idx).sort();
  return keys.length ? keys[keys.length - 1] : null;
}

// Which column block belongs to which store, for THIS tab, read from its own
// header rows. A store with no header cell is absent — the right answer for a
// month before it opened, and what stops the TTL block being taken for MPL.
function _mrBases(values, width) {
  var bases = {};
  var rows = Math.min(MR_HEADER_ROWS, values.length);
  for (var r = 0; r < rows; r++) {
    var row = values[r] || [];
    for (var c = 0; c < row.length; c++) {
      var txt = String(row[c] === null || row[c] === undefined ? '' : row[c]).toUpperCase();
      if (!txt) continue;
      for (var i = 0; i < MR_STORES.length; i++) {
        var code = MR_STORES[i];
        if (bases[code] !== undefined) continue;
        if (new RegExp('(^|[^A-Z])' + code + '([^A-Z]|$)').test(txt)) {
          bases[code] = Math.floor(c / width) * width;
        }
      }
    }
  }
  return bases;
}

// Which store's block a column falls in — or NOTHING, if it falls past the last
// one. ⚠️ The bound matters: the workbook carries a TTL block after BAL with its
// own "GP Goal" cell, and an unbounded version handed that cell to BAL. The
// first live diagnostic found exactly that (six goal cells for five stores).
function _mrBlockOf(bases, col, width) {
  var best = null;
  Object.keys(bases).forEach(function (c) {
    if (bases[c] <= col && col < bases[c] + width && (best === null || bases[c] > bases[best])) best = c;
  });
  return best;
}

// Where one store's block ends: at the next store's block, or one block-width
// along, whichever comes first.
//
// ⚠️ THE WIDTH BOUND IS LOAD-BEARING. Without it the LAST store ran to the end
// of the sheet and swallowed the company/TTL columns that sit past it — and
// those columns are inside the range the clearing walks. Verified against the
// real August Buy tab: the unbounded version came out 51x30 where the human tab
// is 51x37, having wiped seven columns of the company block. Third time this
// workbook has punished an unbounded block lookup; see _mrBlockOf.
function _mrBlockEnd(bases, base, lastCol, width) {
  var end = width ? Math.min(base + width, lastCol) : lastCol;
  Object.keys(bases).forEach(function (c) { if (bases[c] > base) end = Math.min(end, bases[c]); });
  return end;
}

// The day rows of one block, as 0-based row indexes keyed by day number.
//
// Walked STRICTLY IN SEQUENCE — the next accepted day must be exactly one more
// than the last. Below the daily table both tab families carry footer rows
// ("Buying Days in Month 26", "Days thru Month 8") whose numbers land in columns
// belonging to another store's block, and 26 and 8 are perfectly good day
// numbers. The sequence rule is also what finds the END of the table without
// having to be told where it is.
function _mrDayRows(values, base, firstRow) {
  var rows = {}, next = 1;
  for (var r = firstRow; r < values.length; r++) {
    var v = (values[r] || [])[base];
    var n = (v === '' || v === null || v === undefined) ? NaN : parseInt(v, 10);
    if (n === next) { rows[n] = r; next++; }
  }
  return rows;
}

// ---- the Buy tab's week-ending column --------------------------------------
// One column per block (E, J, O, T, Y) carries a week's buying, and WHERE it
// sits depends on the calendar — so this is the one thing the rollover cannot
// copy and must author. Everything else here still copies.
//
// The shape, read off the real August tab:
//
//   E5   ='Buy Jul 26'!E34+C4      first Sunday: last month's tail, then the
//                                  days before it in this month
//   E12  =SUM(C6:C11)              days 3-8, i.e. since the previous Sunday
//   E34  =SUM(C30:C34)             the last day of the month closes the tail
//                                  week, and INCLUDES itself
//
// A Sunday excludes its own row because nothing is bought on a Sunday; the last
// day of the month does not, because something is. That is the whole rule:
//
//   week-end row s, previous week-end p  ->  SUM( p+1 .. (s is a Sunday ? s-1 : s) )
//
// A single-cell span is written as a bare reference rather than SUM(C4:C4),
// which is what a person writes and what makes the diff come out clean.
// 0-based column index -> its letter. A1() below builds on this.
function _mrColLetter(c) {
  var s = '', n = c + 1;
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m) / 26); }
  return s;
}

function _mrWeekEnds(sundays, dayCount) {
  var ends = sundays.filter(function (d) { return d <= dayCount; });
  // The month's last day closes the final part-week — unless it IS the Sunday
  // that already closed it.
  if (ends.indexOf(dayCount) < 0) ends.push(dayCount);
  return ends.sort(function (a, b) { return a - b; });
}

function _mrWeekFormula(opts) {
  // All rows here are 1-BASED sheet rows.
  var col = opts.valueCol;                     // the column being summed, e.g. "C"
  var from = opts.prevEndRow + 1;
  var to = opts.isSunday ? opts.row - 1 : opts.row;
  var span = (to < from) ? '' : (from === to ? (col + from) : ('SUM(' + col + from + ':' + col + to + ')'));
  var carry = opts.carry || '';
  if (!span && !carry) return '';
  if (!carry) return '=' + span;
  return '=' + carry + (span ? '+' + span : '');
}

// Column offsets carrying a formula on EVERY Sunday of the source month and on
// none of its other days — the weekly rows. Found by comparison rather than by
// knowing which column it is, so a moved column costs nothing.
// ⚠️ THE EARLIER RULE WAS TOO STRICT AND REPORTED "none found" ON A TAB THAT
// HAS THEM. It demanded a formula on every Sunday and on no other day; this
// column also closes the month's final part-week, so the last day carries one
// too and the column was rejected. Now: a formula on every WEEK-END day and on
// no other day.
//
// The summed column is read off the tab's own formula rather than assumed, so a
// moved column still costs nothing.
// ⚠️ SCANS EVERY COLUMN, not each store block. The Buy tab carries a SIXTH
// week column at AD for the company total, outside all five store blocks, and a
// per-block scan left it sitting on last month's Sundays while the five stores
// moved. The signature — a formula on every week end and on no other day — is
// specific enough to find it without being told where it is.
function _mrWeekCols(srcFormulas, bases, dayRows, weekEnds, width, lastCol) {
  var out = [];
  for (var col = 0; col < lastCol; col++) {
    var endSeen = 0, endF = 0, otherF = 0, sample = '', firstSample = '';
    for (var d in dayRows) {
      var day = parseInt(d, 10);
      var f = (srcFormulas[dayRows[d]] || [])[col];
      if (weekEnds.indexOf(day) >= 0) {
        endSeen++;
        if (f) {
          endF++;
          if (day === weekEnds[0]) firstSample = f;
          else if (!sample) sample = f;
        }
      } else if (f) otherF++;
    }
    if (!endSeen || endF !== endSeen || otherF) continue;
    // "=SUM(C6:C11)" -> C. Failing that, the first week's "…+C4" tail.
    var m = /SUM\(\$?([A-Z]{1,3})\$?\d+/i.exec(sample || firstSample)
         || /\+\s*\$?([A-Z]{1,3})\$?\d+\s*$/i.exec(firstSample || sample);
    if (!m) continue;
    var owner = _mrBlockOf(bases, col, width);
    out.push({ store: owner || 'TTL', col: col, valueCol: m[1].toUpperCase() });
  }
  return out;
}

// ---- "Last month" is a formula chain, not a figure -------------------------
// Every tab reads last month's totals straight off the tab before it:
//
//   Sales Aug 26 !C38  =  'Sales Jul 26'!B36
//   Buy   Aug 26 !E5   =  'Buy Jul 26'!E34 + C4
//
// copyTo preserves a cross-sheet reference VERBATIM, so a September tab copied
// from August still points at July — which is exactly what the first preview
// showed. The chain was never broken; it simply never got advanced.
//
// So the fix is not to write a number into those cells (an earlier version did,
// and put a stray 51510.87 into a blank spacer column). It is to walk the chain
// on one link: every reference to the SOURCE'S predecessor becomes a reference
// to the source itself.
//
// The row moves with it. A reference below the day grid is anchored to the
// bottom of that grid, so when the two months differ in length the row must
// shift by the difference — measured off the real tabs rather than assumed from
// the calendar, because a hand-built tab was not always resized.
function _mrRetarget(f, prevName, srcName, cutRow, delta) {
  var needle = "'" + prevName + "'!";
  if (!f || f.indexOf(needle) < 0) return f;
  function bump(r) {
    var n = parseInt(r, 10);
    return (delta && n > cutRow) ? String(n + delta) : r;
  }
  var out = '', i = 0;
  while (true) {
    var k = f.indexOf(needle, i);
    if (k < 0) { out += f.slice(i); break; }
    out += f.slice(i, k) + "'" + srcName + "'!";
    var j = k + needle.length;
    // The reference itself: a cell, or a range. Anything else is left alone.
    var m = /^(\$?[A-Z]{1,3}\$?)(\d+)(?::(\$?[A-Z]{1,3}\$?)(\d+))?/.exec(f.slice(j));
    if (!m) { i = j; continue; }
    out += m[1] + bump(m[2]) + (m[3] ? ':' + m[3] + bump(m[4]) : '');
    i = j + m[0].length;
  }
  return out;
}

// The 1-based row of the last day in a tab's grid — the anchor everything below
// it is measured from.
function _mrLastDayRow(sheet, width, firstRow) {
  if (!sheet) return 0;
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (!lastRow || !lastCol) return 0;
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var bases = _mrBases(values, width);
  var codes = Object.keys(bases);
  if (!codes.length) return 0;
  var rows = _mrDayRows(values, bases[codes[0]], firstRow);
  var last = 0;
  for (var d in rows) if (rows[d] + 1 > last) last = rows[d] + 1;
  return last;
}

// ---- the tab builder --------------------------------------------------------
// One family (Sales or Buy), one month. Returns a report rather than logging, so
// the same code serves the diagnostic, the preview and the real run.
function _mrBuildTab(ss, src, targetYm, opts) {
  opts = opts || {};
  var width = opts.family === 'buy' ? MR_BUY_WIDTH : MR_SALES_WIDTH;
  var firstRow = opts.family === 'buy' ? MR_BUY_FIRST_ROW : MR_SALES_FIRST_ROW;
  var srcYm = _mrTabMonth(src.getName());
  var rep = { family: opts.family, source: src.getName(), sourceMonth: srcYm, target: null,
              stores: [], rowsInserted: 0, rowsDeleted: 0, cleared: 0, weekly: [], footer: [], warn: [] };

  var srcLastRow = src.getLastRow(), srcLastCol = src.getLastColumn();
  var srcValues = src.getRange(1, 1, srcLastRow, srcLastCol).getValues();
  var srcFormulas = src.getRange(1, 1, srcLastRow, srcLastCol).getFormulas();
  var bases = _mrBases(srcValues, width);
  var codes = Object.keys(bases).sort();
  if (!codes.length) { rep.warn.push('no store blocks in the header rows — SKIPPED'); return rep; }
  rep.stores = codes;

  var srcDays = _mrDayRows(srcValues, bases[codes[0]], firstRow);
  var srcCount = Object.keys(srcDays).length;
  var wantCount = _mrDaysIn(targetYm);
  if (!srcCount) { rep.warn.push('no day rows found — SKIPPED'); return rep; }
  if (srcCount !== _mrDaysIn(srcYm)) {
    rep.warn.push('source has ' + srcCount + ' day rows but ' + srcYm + ' has ' + _mrDaysIn(srcYm) + ' days');
  }

  var srcSun = _mrSundays(srcYm), tgtSun = _mrSundays(targetYm);
  var srcEnds = _mrWeekEnds(srcSun, srcCount);
  var tgtEnds = _mrWeekEnds(tgtSun, wantCount);
  rep.weekly = _mrWeekCols(srcFormulas, bases, srcDays, srcEnds, width, srcLastCol);

  // The link of the "last month" chain this tab has to advance: references to
  // the source's predecessor become references to the source.
  var prevName = _mrNameLike(src.getName(), _mrPrevMonth(srcYm));
  var prevSheet = prevName ? ss.getSheetByName(prevName) : null;
  var srcLastDay = srcDays[srcCount] + 1;
  var prevLastDay = _mrLastDayRow(prevSheet, width, firstRow);
  var shift = prevLastDay ? srcLastDay - prevLastDay : 0;
  rep.retarget = { from: prevName || '(none)', to: src.getName(), shift: shift,
                   anchor: prevLastDay, cells: 0 };

  var name = _mrNameLike(src.getName(), targetYm);
  if (!name) { rep.warn.push('could not build a tab name from "' + src.getName() + '"'); return rep; }
  if (opts.suffix) name += opts.suffix;
  rep.target = name;
  if (opts.dryRun) {
    // Everything the real run would do, computed against the SOURCE tab (which
    // is what the copy starts life as) and reported rather than written.
    rep.cleared = _mrCountTyped(srcValues, srcFormulas, bases, srcDays, firstRow, srcLastCol, width);
    rep.rowsInserted = Math.max(0, wantCount - srcCount);
    rep.rowsDeleted = Math.max(0, srcCount - wantCount);
    for (var dr = 0; dr < srcLastRow; dr++) {
      for (var dc = 0; dc < srcLastCol; dc++) {
        if (prevName && String((srcFormulas[dr] || [])[dc] || '').indexOf("'" + prevName + "'!") >= 0) rep.retarget.cells++;
      }
    }
    rep.footer = _mrFooterPlan(srcValues, srcFormulas, bases, width, srcLastRow, srcLastCol,
                               wantCount, targetYm, opts.goals || {}, opts.family)
      .map(function (p) {
        return p.skip ? (p.what + ': SKIPPED — ' + p.skip)
                      : (p.what + '=' + p.value + ' @r' + (p.row + 1) + 'c' + (p.col + 1)
                         + (p.note ? ' (' + p.note + ')' : ''));
      });
    rep.plan = { dayRows: srcCount + ' -> ' + wantCount, sundays: tgtSun.join(',') };
    return rep;
  }
  if (ss.getSheetByName(name)) { rep.warn.push('"' + name + '" already exists — SKIPPED'); return rep; }

  // ---- copy: formats, formulas, widths, validation and all ----
  var tab = src.copyTo(ss);
  tab.setName(name);
  ss.setActiveSheet(tab);
  ss.moveActiveSheet(src.getIndex());   // newest sits where the month it follows sits

  // ---- resize the day grid ----
  // Rows are added BEFORE the last day row and removed from inside the run,
  // never off the end: a range that finishes on the last day row does not grow
  // when a row is appended after it, and the TTL formulas all finish there.
  var diff = wantCount - srcCount;
  if (diff > 0) {
    var anchor = srcDays[srcCount - 1] + 1;              // 1-based row of the second-to-last day
    tab.insertRowsAfter(anchor, diff);
    var tmpl = srcDays[srcCount - 2] + 1;                 // a real day row, with its formulas
    tab.getRange(tmpl, 1, 1, srcLastCol).copyTo(tab.getRange(anchor + 1, 1, diff, srcLastCol));
    rep.rowsInserted = diff;
  } else if (diff < 0) {
    tab.deleteRows(srcDays[srcCount + diff] + 1, -diff);
    rep.rowsDeleted = -diff;
  }

  // ---- renumber the days and clear what was typed in ----
  var lastRow = tab.getLastRow(), lastCol = tab.getLastColumn();
  var values = tab.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = tab.getRange(1, 1, lastRow, lastCol).getFormulas();
  var tgtBases = _mrBases(values, width);
  var weeklyCols = {};
  rep.weekly.forEach(function (w) { weeklyCols[w.col] = true; });

  Object.keys(tgtBases).forEach(function (code) {
    var base = tgtBases[code];
    var rows = _mrDayRows(values, base, firstRow);
    var start = rows[1];
    if (start === undefined) { rep.warn.push(code + ': no day 1 — block left alone'); return; }
    var have = Object.keys(rows).length;
    if (have !== wantCount) rep.warn.push(code + ': ' + have + ' day rows after resize, expected ' + wantCount);
    var end = _mrBlockEnd(tgtBases, base, lastCol, width);
    var w = end - base;

    // ONE read/write for the whole block instead of a call per cell — 31 days by
    // ten columns by five stores is 1,550 round trips, which is minutes.
    var grid = [];
    for (var d = 1; d <= wantCount; d++) {
      var r = start + (d - 1);
      var row = [d];                                    // the day number, renumbered
      for (var col = base + 1; col < end; col++) {
        var f = (formulas[r] || [])[col];
        if (weeklyCols[col]) { row.push(''); continue; } // re-placed on the new Sundays below
        // A formula is written back verbatim, to the cell it already occupies,
        // so its references are unchanged. A typed value is cleared: that is
        // last month's figure and this month has not happened yet.
        // A bare-number formula ("=1100") counts as typed, not as a formula — see
        // _mrIsBareNumberFormula. It is an import-protection trick, and it belongs
        // to the month it was keyed in.
        row.push(f && !_mrIsBareNumberFormula(f) ? f : '');
      }
      grid.push(row);
      for (var c2 = base + 1; c2 < end; c2++) {
        var f2 = (formulas[r] || [])[c2];
        if (!f2 || _mrIsBareNumberFormula(f2)) {
          var v = (values[r] || [])[c2];
          if (v !== '' && v !== null && v !== undefined) rep.cleared++;
        }
      }
    }
    tab.getRange(start + 1, base + 1, wantCount, w).setValues(grid);
  });

  // ---- the week-ending column, onto the new month's weeks ----
  // Authored, not copied: where a week ends is a fact about the calendar, and
  // no amount of copying moves a formula onto a different Sunday. The FORM is
  // still taken from the source tab — which column it sums, and that the first
  // week carries the previous month's tail — so nothing here is invented.
  if (rep.weekly.length) {
    var afterValues = tab.getRange(1, 1, tab.getLastRow(), lastCol).getValues();
    var weekLog = [];
    // The day grid is one set of rows shared by every block, including the
    // company one that has no date column of its own — so the rows are read
    // once, from the first store block, and used for all of them.
    var anchorBase = tgtBases[rep.stores[0]];
    var weekRows = anchorBase === undefined ? {} : _mrDayRows(afterValues, anchorBase, firstRow);
    rep.weekly.forEach(function (wk) {
      var rows = weekRows;
      if (rows[1] === undefined) return;
      // rows[1] is day 1 zero-based, so the same number is the 1-based row
      // ABOVE it — exactly the "previous week-end" the first week measures from.
      var prevEnd = rows[1];

      // ⚠️ CLEAR THE WHOLE COLUMN FIRST. The day-grid pass only walks the store
      // blocks, so a week column outside them — AD, the company total — kept
      // last month's formulas and then gained this month's beside them: the
      // live verify showed AD5 AND AD8 both filled, one per calendar. The
      // column is wholly owned by this pass, so it starts empty.
      var wipe = [];
      for (var w0 = 0; w0 < wantCount; w0++) wipe.push(['']);
      tab.getRange(rows[1] + 1, wk.col + 1, wantCount, 1).setValues(wipe);
      tgtEnds.forEach(function (d, i) {
        var r = rows[d];
        if (r === undefined) return;
        var f = _mrWeekFormula({
          row: r + 1,
          prevEndRow: prevEnd,
          valueCol: wk.valueCol,
          isSunday: tgtSun.indexOf(d) >= 0,
          // Only the first week reaches back — it is picking up the days that
          // fell before this month's first week-end.
          // The carry points at the SOURCE month's own week column on its last
          // day — the tail week this month is picking up.
          carry: (i === 0 && srcLastDay)
            ? ("'" + src.getName() + "'!" + _mrColLetter(wk.col) + srcLastDay) : '',
        });
        if (f) tab.getRange(r + 1, wk.col + 1).setFormula(f);
        if (wk.store === rep.stores[0]) weekLog.push('d' + d + (f ? '' : ' (empty)'));
        prevEnd = r + 1;
      });
    });
    rep.weekLog = weekLog;
  }

  // ---- advance the "last month" chain by one link ----
  // Done over the WHOLE tab rather than the footer band: on the Buy tab the
  // reference lives in the day grid, on the first Sunday of the month.
  if (prevName && prevName !== src.getName()) {
    var rLastRow = tab.getLastRow(), rLastCol = tab.getLastColumn();
    var rf = tab.getRange(1, 1, rLastRow, rLastCol).getFormulas();
    for (var rr = 0; rr < rLastRow; rr++) {
      for (var rc = 0; rc < rLastCol; rc++) {
        var was = (rf[rr] || [])[rc];
        if (!was) continue;
        var now = _mrRetarget(was, prevName, src.getName(), prevLastDay, shift);
        if (now === was) continue;
        tab.getRange(rr + 1, rc + 1).setFormula(now);
        rep.retarget.cells++;
      }
    }
  }

  // ---- footers ----
  var fLastRow = tab.getLastRow(), fLastCol = tab.getLastColumn();
  rep.footer = _mrApplyFooters(tab, _mrFooterPlan(
    tab.getRange(1, 1, fLastRow, fLastCol).getValues(),
    tab.getRange(1, 1, fLastRow, fLastCol).getFormulas(),
    tgtBases, width, fLastRow, fLastCol, wantCount, targetYm, opts.goals || {}, opts.family));

  // ---- what the copy carried that is not a figure ----
  // Last, because both passes read the tab back and the footer writes above are
  // part of what they should see. Added 2026-09-01: the roll had been leaving
  // the month name and last month's B2B deals on every new tab since it was
  // written, and both were being fixed by hand or not at all.
  rep.carried = _mrCarryOverPass(tab, targetYm, false);
  return rep;
}

// Month-dependent footer cells, found by their label. Returns a PLAN rather
// than writing, so the diagnostic can print exactly what the real run would do
// — the first live diagnose reported "nothing matched" only because the dry run
// never got this far, which is a diagnostic that lies by omission.
//
// Only a cell that is not a formula is ever a target.
function _mrFooterPlan(values, formulas, bases, width, lastRow, lastCol, wantCount, targetYm, goals, family) {
  var plan = [];
  var sundays = _mrSundays(targetYm).length;
  var seen = {};

  function target(r, c) {
    for (var k = c + 1; k < Math.min(c + 4, lastCol); k++) {
      if ((formulas[r] || [])[k]) continue;
      return k;
    }
    return -1;
  }
  function add(r, c, value, what, note) {
    var k = target(r, c);
    if (k < 0) { plan.push({ row: r, col: c, skip: 'every cell beside it is a formula', what: what }); return; }
    plan.push({ row: r, col: k, value: value, what: what, note: note || '' });
  }
  // The Sales tab repeats "Days this month" once per block but fills only the
  // FIRST — the other four read off it. Writing all six put a number in five
  // cells a person deliberately leaves empty.
  function once(r, c, value, what) {
    if (seen[what]) { plan.push({ row: r, col: c, skip: 'only the first block carries this value', what: what }); return; }
    seen[what] = true;
    add(r, c, value, what);
  }
  // The Buy tab's counters, by block geometry rather than by what sits next to
  // the label. See MR_BUY_VALUE_COL — the cell beside the label is inside a
  // merge, and writing there destroys the label.
  function perBlock(r, value, what, note) {
    if (seen[what]) return;
    seen[what] = true;
    Object.keys(bases).sort(function (a, b) { return bases[a] - bases[b]; }).forEach(function (code) {
      var k = bases[code] + MR_BUY_VALUE_COL;
      if (k >= lastCol) return;
      if ((formulas[r] || [])[k]) { plan.push({ row: r, col: k, skip: code + ': holds a formula', what: what }); return; }
      plan.push({ row: r, col: k, value: value, what: code + ' ' + what, note: note || '' });
    });
  }

  for (var r = 0; r < lastRow; r++) {
    for (var c = 0; c < lastCol; c++) {
      var raw = (values[r] || [])[c];
      if (raw === '' || raw === null || raw === undefined) continue;
      var txt = String(raw).trim().toLowerCase();
      if (!txt || txt.length > 30) continue;
      var code = _mrBlockOf(bases, c, width);

      if (MR_FOOTER.days.indexOf(txt) >= 0) {
        once(r, c, wantCount, 'days');
      } else if (MR_FOOTER.thru.indexOf(txt) >= 0) {
        if (family === 'buy') perBlock(r, 0, 'thru');
        else once(r, c, 0, 'thru');
      } else if (MR_FOOTER.buyDays.indexOf(txt) >= 0) {
        // Days minus Sundays. A STARTING VALUE only — holidays are a judgement
        // this cannot make, so it is flagged for eyeballing.
        perBlock(r, wantCount - sundays, 'buyDays', 'check holidays');
      } else if (MR_FOOTER.goal.indexOf(txt) >= 0) {
        if (!code) { plan.push({ row: r, col: c, skip: 'not inside a store block (company total?)', what: 'goal' }); }
        else if (goals[code] === undefined || goals[code] === null) {
          plan.push({ row: r, col: c, skip: 'no ' + code + ' goal set on SPEEKS', what: 'goal' });
        } else {
          add(r, c, goals[code], code + ' goal');
        }
      } else if (MR_FOOTER.lastMonth.indexOf(txt) >= 0) {
        // Deliberately NOT written. These cells are a live formula reading the
        // previous tab; _mrRetarget advances the reference instead. Writing a
        // figure here put a number into the blank column beside the formula,
        // because the first non-formula cell to the right was a spacer.
        plan.push({ row: r, col: c, skip: 'formula chain — advanced by the retarget pass', what: 'lastMonth' });
      }
    }
  }
  return plan;
}

function _mrApplyFooters(tab, plan) {
  var done = [];
  plan.forEach(function (p) {
    if (p.skip) { done.push(p.what + ': SKIPPED — ' + p.skip); return; }
    var rng = tab.getRange(p.row + 1, p.col + 1);
    // A last line of defence, not the fix. setValue on part of a merged range
    // silently writes to the merge's top-left — which on the Buy tab is the
    // label itself. Anything aimed inside a merge is a targeting mistake, so it
    // is refused and reported rather than quietly redirected.
    if (rng.isPartOfMerge()) {
      done.push(p.what + ': REFUSED — ' + rng.getA1Notation() + ' is inside a merged range');
      return;
    }
    rng.setValue(p.value);
    done.push(p.what + '=' + p.value + (p.note ? ' (' + p.note + ')' : ''));
  });
  return done;
}

// How many typed-in cells the day grid is carrying — what a real run would
// clear. Counted for the dry run so the diagnostic can say so out loud.
// A formula with no cell reference and no function call — "=1100" — is not a
// formula in any meaningful sense. It is a typed figure someone disguised so the
// daily Shopify import would not overwrite it (the importer skips any cell whose
// getFormula() is non-empty, which is the documented way to protect a hand-keyed
// cost). That disguise must NOT survive into next month: carried over verbatim it
// would pre-fill, say, September 15th with August's 1,100 cost.
//
// Anything containing a letter is a real formula (=A1, =SUM(...), =Sheet2!B3) and
// is carried over untouched, exactly as before.
function _mrIsBareNumberFormula(f) {
  if (!f) return false;
  var body = String(f).replace(/^=/, '');
  if (!body.trim()) return false;
  if (/[A-Za-z]/.test(body)) return false;        // a reference or a function
  // Every remaining character must be a digit or simple arithmetic. Written as
  // a whitelist walk rather than a character class on purpose: this file is
  // pasted between editors, and a mangled backslash in a regex fails silently.
  var ALLOWED = '0123456789 .,+-*/()';
  for (var i = 0; i < body.length; i++) {
    if (ALLOWED.indexOf(body.charAt(i)) < 0) return false;
  }
  return true;
}

function _mrCountTyped(values, formulas, bases, dayRows, firstRow, lastCol, width) {
  var n = 0;
  Object.keys(bases).forEach(function (code) {
    var base = bases[code];
    var end = _mrBlockEnd(bases, base, lastCol, width);
    for (var d in dayRows) {
      var r = dayRows[d];
      for (var col = base + 1; col < end; col++) {
        var f = (formulas[r] || [])[col];
        // Same rule the clearing loop uses. If these two disagree, the dry run
        // under-reports and somebody approves a rollover on a wrong number.
        if (f && !_mrIsBareNumberFormula(f)) continue;
        var v = (values[r] || [])[col];
        if (v !== '' && v !== null && v !== undefined) n++;
      }
    }
  });
  return n;
}

// ---- goals ------------------------------------------------------------------
// Write a month's GP goals into that month's Sales tab. Called by the gp-goals
// edge function the moment they are entered on SPEEKS, and again by the rollover
// so a month rolled before the goals were set still gets them.
function _mrWriteGoals(ss, ym, goals) {
  var idx = _mrIndex(ss);
  var entry = idx[ym];
  if (!entry || !entry.sales) return { ok: false, error: 'no Sales tab for ' + ym };
  var tab = entry.sales;
  var lastRow = tab.getLastRow(), lastCol = tab.getLastColumn();
  var values = tab.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = tab.getRange(1, 1, lastRow, lastCol).getFormulas();
  var bases = _mrBases(values, MR_SALES_WIDTH);
  var wrote = [], found = [];

  for (var r = 0; r < lastRow; r++) {
    for (var c = 0; c < lastCol; c++) {
      var raw = (values[r] || [])[c];
      if (raw === '' || raw === null || raw === undefined) continue;
      if (MR_FOOTER.goal.indexOf(String(raw).trim().toLowerCase()) < 0) continue;
      // ⚠️ Bounded: the workbook has a sixth "GP Goal" after BAL, for the
      // company. It belongs to no store, and an unbounded lookup made it BAL's.
      var code = _mrBlockOf(bases, c, MR_SALES_WIDTH);
      found.push((code || 'none') + '@r' + (r + 1) + 'c' + (c + 1));
      if (!code || goals[code] === undefined || goals[code] === null) continue;
      for (var k = c + 1; k < Math.min(c + 4, lastCol); k++) {
        if ((formulas[r] || [])[k]) continue;
        tab.getRange(r + 1, k + 1).setValue(goals[code]);
        wrote.push(code + '=' + goals[code]);
        break;
      }
    }
  }
  return { ok: true, tab: tab.getName(), found: found, wrote: wrote };
}

// Write a month's buying-days count into that month's Buy tab — one cell per
// store block at base+4, never beside the label. SPEEKS derives the number from
// the closed dates it holds; the sheet only needs the total.
function _mrWriteBuyDays(ss, ym, buyDays) {
  var n = Number(buyDays);
  if (!isFinite(n) || n <= 0) return { ok: false, error: 'no buyDays given' };
  var entry = _mrIndex(ss)[ym];
  if (!entry || !entry.buy) return { ok: false, error: 'no Buy tab for ' + ym };
  var tab = entry.buy;
  var lastRow = tab.getLastRow(), lastCol = tab.getLastColumn();
  var values = tab.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = tab.getRange(1, 1, lastRow, lastCol).getFormulas();
  var bases = _mrBases(values, MR_BUY_WIDTH);
  var wrote = [];

  for (var r = 0; r < lastRow; r++) {
    for (var c = 0; c < lastCol; c++) {
      var raw = (values[r] || [])[c];
      if (raw === '' || raw === null || raw === undefined) continue;
      if (MR_FOOTER.buyDays.indexOf(String(raw).trim().toLowerCase()) < 0) continue;
      Object.keys(bases).sort(function (a, b) { return bases[a] - bases[b]; }).forEach(function (code) {
        var k = bases[code] + MR_BUY_VALUE_COL;
        if (k >= lastCol || (formulas[r] || [])[k]) return;
        var rng = tab.getRange(r + 1, k + 1);
        if (rng.isPartOfMerge()) return;
        rng.setValue(n);
        wrote.push(code + '@' + rng.getA1Notation());
      });
      return { ok: true, tab: tab.getName(), buyDays: n, wrote: wrote };
    }
  }
  return { ok: false, error: 'no "Buying Days in Month" label on ' + tab.getName() };
}

// Every month's GP goals, read off every Sales tab in the workbook and printed
// as JSON. The site's Daily Breakdown already shows a goal for ANY month it has
// one for — the only thing missing for past months is the rows, and the rows
// have been sitting in the workbook all along. Reads only; writes nothing.
function mrHarvestGoals() {
  var ss = _mrSs();
  var idx = _mrIndex(ss);
  var out = {};
  Object.keys(idx).sort().forEach(function (ym) {
    var tab = idx[ym].sales;
    if (!tab) return;
    var lastRow = tab.getLastRow(), lastCol = tab.getLastColumn();
    var values = tab.getRange(1, 1, lastRow, lastCol).getValues();
    var formulas = tab.getRange(1, 1, lastRow, lastCol).getFormulas();
    var bases = _mrBases(values, MR_SALES_WIDTH);
    var got = {};
    for (var r = 0; r < lastRow; r++) {
      for (var c = 0; c < lastCol; c++) {
        var raw = (values[r] || [])[c];
        if (raw === '' || raw === null || raw === undefined) continue;
        if (MR_FOOTER.goal.indexOf(String(raw).trim().toLowerCase()) < 0) continue;
        var code = _mrBlockOf(bases, c, MR_SALES_WIDTH);
        if (!code) continue;                     // the company cell is not a store's
        for (var k = c + 1; k < Math.min(c + 4, lastCol); k++) {
          if ((formulas[r] || [])[k]) continue;
          var n = parseFloat(String((values[r] || [])[k] || '').replace(/[$,]/g, ''));
          if (!isNaN(n) && n > 0) got[code] = n;
          break;
        }
      }
    }
    if (Object.keys(got).length) out[ym] = got;
  });
  Logger.log(JSON.stringify(out));
}

// The goals for a month, from SPEEKS. The sheet is downstream of the site here,
// so an empty answer means "not decided yet" and the goal cells are left alone
// rather than zeroed.
function _mrFetchGoals(ym) {
  try {
    var res = UrlFetchApp.fetch(MR_GOALS_URL + '?month=' + encodeURIComponent(ym), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return {};
    var j = JSON.parse(res.getContentText());
    return (j && j.goals) || {};
  } catch (e) {
    return {};
  }
}

// ---- the jobs ---------------------------------------------------------------
function _mrRoll(targetYm, opts) {
  opts = opts || {};
  var ss = _mrSs();
  var idx = _mrIndex(ss);
  var srcYm = _mrPrevMonth(targetYm);
  var src = idx[srcYm];
  var warnSource = '';
  if (!src || (!src.sales && !src.buy)) {
    // A gap in the workbook must not stop the rollover — but say so loudly,
    // because the structure being copied is then older than it should be.
    var latest = _mrLatestMonth(idx);
    if (!latest) return { error: 'no Sales/Buy tabs at all' };
    src = idx[latest];
    warnSource = 'no tabs for ' + srcYm + ' — copied ' + latest + ' instead';
  }
  var goals = opts.goals || _mrFetchGoals(targetYm);
  var reports = [];
  if (src.sales) reports.push(_mrBuildTab(ss, src.sales, targetYm, { family: 'sales', goals: goals, suffix: opts.suffix, dryRun: opts.dryRun }));
  if (src.buy)   reports.push(_mrBuildTab(ss, src.buy,   targetYm, { family: 'buy',   goals: goals, suffix: opts.suffix, dryRun: opts.dryRun }));
  return { month: targetYm, goals: goals, warnSource: warnSource, reports: reports };
}

function _mrReport(r) {
  if (r.error) { Logger.log('ERROR: ' + r.error); return r; }
  Logger.log('month: ' + r.month);
  if (r.warnSource) Logger.log('⚠ ' + r.warnSource);
  Logger.log('goals from SPEEKS: ' + JSON.stringify(r.goals));
  (r.reports || []).forEach(function (rep) {
    Logger.log('---- ' + rep.family + ' ----');
    Logger.log('  source : ' + rep.source + '  (' + rep.sourceMonth + ')');
    Logger.log('  target : ' + (rep.target || '(none)'));
    Logger.log('  stores : ' + rep.stores.join('/'));
    if (rep.plan) Logger.log('  plan   : day rows ' + rep.plan.dayRows + ' | sundays ' + rep.plan.sundays
                             + ' | last month ' + rep.plan.lastMonth);
    if (rep.carried) {
      Logger.log('  month  : ' + (rep.carried.monthNames.length
        ? rep.carried.monthNames.join('  ') : 'no typed month cell on this tab'));
      Logger.log('  b2b    : ' + (rep.carried.b2bCleared.length
        ? rep.carried.b2bCleared.length + ' typed cells cleared' : 'nothing typed'));
      Logger.log('  fills  : ' + (rep.carried.fillsCleared.length
        ? rep.carried.fillsCleared.length + ' goal fills cleared' : 'already clear'));
    }
    Logger.log('  rows   : +' + rep.rowsInserted + ' / -' + rep.rowsDeleted);
    Logger.log('  cleared: ' + rep.cleared + ' typed cells');
    if (rep.retarget) Logger.log('  lastmo : ' + rep.retarget.cells + ' refs  '
      + rep.retarget.from + ' -> ' + rep.retarget.to
      + '   rows below r' + rep.retarget.anchor + ' shift ' + (rep.retarget.shift > 0 ? '+' : '') + rep.retarget.shift);
    Logger.log('  weekly : ' + (rep.weekly.length
      ? rep.weekly.map(function (w) { return w.store + '@' + _mrColLetter(w.col) + ' sums ' + w.valueCol; }).join(', ')
        + (rep.weekLog ? '   week ends ' + rep.weekLog.join(',') : '')
      : 'none found'));
    Logger.log('  footer : ' + (rep.footer.length ? rep.footer.join(' | ') : 'nothing matched'));
    rep.warn.forEach(function (w) { Logger.log('  ⚠ ' + w); });
  });
  return r;
}

// What it WOULD do, touching nothing.
function mrDiagnose() {
  var ss = _mrSs();
  var idx = _mrIndex(ss);
  var months = Object.keys(idx).sort();
  Logger.log('workbook: ' + ss.getName());
  Logger.log('months with tabs: ' + months.join(', '));
  var latest = _mrLatestMonth(idx);
  Logger.log('latest: ' + latest + '   next would be: ' + _mrNextMonth(latest));
  _mrReport(_mrRoll(_mrNextMonth(latest), { dryRun: true }));
  Logger.log('--- goal cells on the CURRENT month (nothing written) ---');
  Logger.log(JSON.stringify(_mrWriteGoals(ss, _mrCentralMonth(), {})));
}

// Everything below the day grid, cell by cell, on the current month's tabs and on
// any PREVIEW tabs beside them. Written because the first preview came out with
// July's figures where August's belonged, and the footer band is the one part of
// this workbook the rollover WRITES rather than copies — so it is the one part
// worth reading verbatim rather than inferring. Touches nothing.
function mrFooterAudit() {
  var ss = _mrSs();
  var cur = _mrCentralMonth();
  ss.getSheets().forEach(function (tab) {
    var name = tab.getName();
    var isPreview = name.indexOf('(PREVIEW)') >= 0;
    var ym = _mrTabMonth(name.replace(' (PREVIEW)', ''));
    if (!ym) return;
    if (!isPreview && ym !== cur) return;
    var buy = /^Buy\s/i.test(name);
    var width = buy ? MR_BUY_WIDTH : MR_SALES_WIDTH;
    var firstRow = buy ? MR_BUY_FIRST_ROW : MR_SALES_FIRST_ROW;

    var lastRow = tab.getLastRow(), lastCol = tab.getLastColumn();
    var values = tab.getRange(1, 1, lastRow, lastCol).getValues();
    var formulas = tab.getRange(1, 1, lastRow, lastCol).getFormulas();
    var bases = _mrBases(values, width);
    var codes = Object.keys(bases).sort(function (a, b) { return bases[a] - bases[b]; });
    if (!codes.length) return;

    var base = bases[codes[0]];
    var end = _mrBlockEnd(bases, base, lastCol, width);
    var days = _mrDayRows(values, base, firstRow);
    var lastDayRow = -1;
    for (var d in days) if (days[d] > lastDayRow) lastDayRow = days[d];

    // One cell, as the audit prints it: a formula is shown as a formula, because
    // a formula is why a cell would still be pointing at the wrong month.
    function cell(r, c) {
      var f = (formulas[r] || [])[c];
      if (f) return 'c' + (c + 1) + '=F' + String(f).slice(0, 60);
      var v = (values[r] || [])[c];
      if (v === '' || v === null || v === undefined) return '';
      return 'c' + (c + 1) + '=' + String(v).slice(0, 40);
    }
    function band(r) {
      var out = [];
      for (var c = base; c < Math.min(end + 1, lastCol); c++) {
        var s = cell(r, c);
        if (s) out.push(s);
      }
      return out.join('  ');
    }

    Logger.log('======== ' + name + '  (' + ym + (isPreview ? ', PREVIEW' : '') + ') ========');
    Logger.log('  blocks: ' + codes.map(function (c) { return c + '@c' + (bases[c] + 1); }).join(' '));
    Logger.log('  -- headers, ' + codes[0] + ' block --');
    for (var h = 0; h < MR_HEADER_ROWS; h++) Logger.log('   r' + (h + 1) + ': ' + band(h));
    if (days[1] !== undefined) Logger.log('   day1 r' + (days[1] + 1) + ': ' + band(days[1]));
    Logger.log('  -- below the day grid, ' + codes[0] + ' block --');
    for (var r = lastDayRow + 1; r < lastRow; r++) {
      var line = band(r);
      if (line) Logger.log('   r' + (r + 1) + ': ' + line);
    }
    // The same label across EVERY block, so a misalignment between blocks shows.
    Logger.log('  -- every "last month" cell on the tab --');
    for (var r2 = 0; r2 < lastRow; r2++) {
      for (var c2 = 0; c2 < lastCol; c2++) {
        var txt = String((values[r2] || [])[c2] || '').trim().toLowerCase();
        if (MR_FOOTER.lastMonth.indexOf(txt) < 0) continue;
        var owner = _mrBlockOf(bases, c2, width);
        var right = [];
        for (var k = c2 + 1; k < Math.min(c2 + 6, lastCol); k++) {
          var s2 = cell(r2, k);
          right.push(s2 || 'c' + (k + 1) + '=(blank)');
        }
        Logger.log('   r' + (r2 + 1) + 'c' + (c2 + 1) + ' [' + (owner || 'no block') + ']  ' + right.join('  '));
      }
    }
  });
}


// ============================================================================
// WHAT THE ROLL LEAVES BEHIND
//
// Five things the roll copies from last month and does not correct, all found
// on the September tabs on 2026-09-01 (Ethan):
//
//   1. the month NAME in the header, still reading the source month
//   2. the GP goals, still last month's, because the roll runs at 4am and the
//      new goals are entered later that morning
//   3. the B2B rows on the Buy tab, still carrying last month's named deals
//   4. the goal-percentage cells, still green or red from a month that ended
//      at 100%+, when every store is now at 0%
//   5. "Last month" revenue / GP / Net GP, read before the previous month's
//      final day had been entered
//
// ⚠️ THIS AUDIT IS READ-ONLY AND EXISTS BECAUSE THE FIX MUST NOT GUESS. Every
// one of the five is a cell position nobody has written down, and mrFooterAudit
// covers only the first store block and prints no colours. Run this, read the
// log, and the repair can then be aimed rather than swept. Touches nothing.
function mrPostRollAudit(ym) {
  var ss = _mrSs();
  ym = ym || _mrCentralMonth();
  var idx = _mrIndex(ss);
  var entry = idx[ym];
  if (!entry) { Logger.log('no tabs for %s', ym); return; }

  var mi = Number(ym.slice(5, 7)) - 1;
  var thisFull = MR_MON_FULL[mi], thisAbbr = MR_MON_ABBR[mi];
  var prevYm = _mrPrevMonth(ym);
  var pi = Number(prevYm.slice(5, 7)) - 1;
  var prevFull = MR_MON_FULL[pi], prevAbbr = MR_MON_ABBR[pi];
  Logger.log('=== POST-ROLL AUDIT %s (previous month %s) ===', ym, prevYm);
  Logger.log('looking for stale "%s"/"%s", expecting "%s"/"%s"',
    prevFull, prevAbbr, thisFull, thisAbbr);

  ['sales', 'buy'].forEach(function (family) {
    var tab = entry[family];
    if (!tab) { Logger.log('-- no %s tab', family); return; }
    var width = family === 'buy' ? MR_BUY_WIDTH : MR_SALES_WIDTH;
    var lastRow = tab.getLastRow(), lastCol = tab.getLastColumn();
    var rng = tab.getRange(1, 1, lastRow, lastCol);
    var values = rng.getValues(), formulas = rng.getFormulas();
    var colours = rng.getBackgrounds();
    var bases = _mrBases(values, width);

    Logger.log('');
    Logger.log('======== %s (%s) %sx%s ========', tab.getName(), family, lastRow, lastCol);

    // ---- 1. any cell naming a month -------------------------------------
    // Reported whether it is stale or already right, because a header that is
    // ALREADY correct means the roll handles it and the fix must leave it be.
    Logger.log('  -- cells naming a month --');
    var monthCells = 0;
    for (var r = 0; r < lastRow; r++) {
      for (var c = 0; c < lastCol; c++) {
        var v = (values[r] || [])[c];
        if (v === '' || v === null || v === undefined) continue;
        // A date-valued month header stringifies to 56 characters and used to be
        // dropped by the length guard below — so this audit reported "nothing to
        // change" for the Sales tab while B2 plainly read August on screen.
        if (v instanceof Date) {
          Logger.log('   %s  %s  (DATE) %s %s', _mrA1(r, c),
            (v.getMonth() === mi && v.getFullYear() === Number(ym.slice(0, 4))) ? 'OK' : 'STALE',
            MR_MON_ABBR[v.getMonth()], v.getFullYear());
          monthCells++;
          continue;
        }
        var txt = String(v);
        if (txt.length > 40) continue;
        var hit = null;
        for (var m = 0; m < 12; m++) {
          var re = new RegExp('\\b(' + MR_MON_FULL[m] + '|' + MR_MON_ABBR[m] + ')\\b', 'i');
          if (re.test(txt)) { hit = MR_MON_ABBR[m]; break; }
        }
        if (!hit) continue;
        var f = (formulas[r] || [])[c];
        var state = hit === thisAbbr ? 'OK' : (hit === prevAbbr ? 'STALE' : 'other(' + hit + ')');
        Logger.log('   %s  %s  "%s"%s', _mrA1(r, c), state, txt,
          f ? '  [FORMULA ' + String(f).slice(0, 50) + ']' : '');
        monthCells++;
      }
    }
    if (!monthCells) Logger.log('   (none)');

    // ---- 2 + 4. goal cells, their values AND their fill ------------------
    // The fill is the point: a green left over from a finished month tells every
    // manager they are ahead on the 1st.
    Logger.log('  -- goal labels, the cell written, and the fill on that row --');
    for (var r2 = 0; r2 < lastRow; r2++) {
      for (var c2 = 0; c2 < lastCol; c2++) {
        var t2 = String((values[r2] || [])[c2] || '').trim().toLowerCase();
        if (MR_FOOTER.goal.indexOf(t2) < 0 && t2.indexOf('% of gp') < 0
            && t2.indexOf('% of goal') < 0) continue;
        var owner = _mrBlockOf(bases, c2, width) || 'no block';
        var right = [];
        for (var k = c2 + 1; k < Math.min(c2 + 4, lastCol); k++) {
          var fk = (formulas[r2] || [])[k];
          var vk = (values[r2] || [])[k];
          right.push(_mrA1(r2, k) + '=' + (fk ? 'F' + String(fk).slice(0, 40)
            : (vk === '' || vk === null ? '(blank)' : String(vk).slice(0, 24)))
            + ' fill=' + colours[r2][k]);
        }
        Logger.log('   %s [%s] "%s"  ->  %s', _mrA1(r2, c2), owner, t2, right.join('   '));
      }
    }

    // ---- 3. the B2B block, which the roll deliberately never touched -----
    // Ethan 2026-08-12 said leave B2B manual, and it was. The named deals now
    // carry into the new month, so the decision needs revisiting - but only the
    // TYPED cells may ever be cleared; the GM column is a formula and the
    // #DIV/0! on the empty rows is what a cleared row is SUPPOSED to look like.
    Logger.log('  -- B2B region (typed vs formula) --');
    var found2b = false;
    for (var r3 = 0; r3 < lastRow; r3++) {
      for (var c3 = 0; c3 < lastCol; c3++) {
        var t3 = String((values[r3] || [])[c3] || '').trim().toLowerCase();
        if (t3 !== 'b2b') continue;
        found2b = true;
        Logger.log('   anchor %s', _mrA1(r3, c3));
        for (var rr = r3; rr < Math.min(r3 + 14, lastRow); rr++) {
          var line = [];
          for (var cc = c3; cc < Math.min(c3 + 6, lastCol); cc++) {
            var ff = (formulas[rr] || [])[cc];
            var vv = (values[rr] || [])[cc];
            if (ff) line.push(_mrA1(rr, cc) + '=F' + String(ff).slice(0, 26));
            else if (vv !== '' && vv !== null && vv !== undefined)
              line.push(_mrA1(rr, cc) + '=TYPED[' + String(vv).slice(0, 20) + ']');
          }
          if (line.length) Logger.log('     %s', line.join('  '));
        }
      }
    }
    if (!found2b) Logger.log('   (no cell reads exactly "b2b")');

    // ---- 5. "Last month" — formula or frozen number? --------------------
    // This decides the whole safeguard. A live formula reading the previous tab
    // self-heals the moment that tab is completed; a pasted number never does.
    Logger.log('  -- "last month" cells --');
    var foundLm = false;
    for (var r4 = 0; r4 < lastRow; r4++) {
      for (var c4 = 0; c4 < lastCol; c4++) {
        var t4 = String((values[r4] || [])[c4] || '').trim().toLowerCase();
        if (MR_FOOTER.lastMonth.indexOf(t4) < 0) continue;
        foundLm = true;
        var out = [];
        for (var k4 = c4 + 1; k4 < Math.min(c4 + 8, lastCol); k4++) {
          var f4 = (formulas[r4] || [])[k4];
          var v4 = (values[r4] || [])[k4];
          out.push(_mrA1(r4, k4) + '=' + (f4 ? 'FORMULA ' + String(f4).slice(0, 55)
            : (v4 === '' || v4 === null ? '(blank)' : 'VALUE ' + String(v4).slice(0, 22))));
        }
        Logger.log('   %s [%s]  %s', _mrA1(r4, c4),
          _mrBlockOf(bases, c4, width) || 'no block', out.join('   '));
      }
    }
    if (!foundLm) Logger.log('   (none)');
  });
  Logger.log('');
  Logger.log('=== end of audit — nothing was written ===');
}

// The GP goals for a month, re-read from SPEEKS and written to that month's
// Sales tab. Exists because the roll and the goals race each other: the roll
// fires at 4am on the 1st and the goals are keyed later that morning, so the
// roll finds none, skips the cells, and last month's numbers stay. gp-goals
// pushes on save for exactly this reason, and when that push does not land
// there is currently no way to ask for it again without re-keying all five.
//
// Safe to run repeatedly: it writes the same five numbers, and a goal cell that
// holds a formula is skipped by _mrWriteGoals rather than overwritten.
function mrFixGoals(ym) {
  var ss = _mrSs();
  ym = ym || _mrCentralMonth();
  var goals = _mrFetchGoals(ym);
  if (!Object.keys(goals).length) {
    Logger.log('SPEEKS has no goals for %s — nothing written. Enter them on the '
      + 'site first; an empty answer means "not decided yet", never zero.', ym);
    return;
  }
  Logger.log('SPEEKS goals for %s: %s', ym, JSON.stringify(goals));
  Logger.log(JSON.stringify(_mrWriteGoals(ss, ym, goals)));
}

// ============================================================================
// THE TWO THINGS THE COPY CARRIES THAT ARE NOT FIGURES
//
// Both found on the September tabs, 2026-09-01, by mrPostRollAudit.
// ============================================================================

// ---- 1. the month printed on the tab ---------------------------------------
// ⚠️ ONE TYPED CELL, AND FIVE FORMULAS THAT FOLLOW IT. On Buy Sep 26 the audit
// found C1 = "August 2026" typed, and H1/M1/AB1 = "=C1" with R1 = "=H1" and
// W1 = "=M1". So exactly one cell needs writing and the other five correct
// themselves; writing all six would replace working references with literals.
// The Sales tab has no month cell at all — the tab NAME carries it there.
//
// ⚠️ WHOLE-CELL MATCH, DELIBERATELY. A looser search for a month name inside
// the text hits "Inc/Dec" on the Sales tab, five times — the audit's own first
// version reported exactly that. A header cell is the month and nothing else,
// so requiring the whole cell to be "<Month> [year]" is both sufficient and the
// only form that cannot false-positive.
function _mrMonthNamePlan(values, formulas, targetYm, lastRow, lastCol) {
  var mi = Number(targetYm.slice(5, 7)) - 1;
  var yr = targetYm.slice(0, 4);
  var plan = [];
  for (var r = 0; r < lastRow; r++) {
    for (var c = 0; c < lastCol; c++) {
      if ((formulas[r] || [])[c]) continue;            // follows another cell
      var raw = (values[r] || [])[c];
      if (raw === '' || raw === null || raw === undefined) continue;

      // ⚠️ THE SALES TAB'S MONTH IS A DATE, NOT TEXT, AND THAT IS WHY BOTH THIS
      // PASS AND THE AUDIT WALKED PAST IT. B2 is a real Date formatted mmmm yyyy,
      // so it READS "August 2026" and stringifies to
      //   "Sat Aug 01 2026 00:00:00 GMT-0500 (Central Daylight Time)"
      // — 56 characters, past the length guard below, and matching no month
      // regex either. The audit reported "nothing to change" on a tab that was
      // plainly wrong on screen, which is the worst kind of clean result.
      //
      // The tell was in the screenshot before it was in the data: the cell is
      // RIGHT-aligned, and Sheets right-aligns dates and numbers while text goes
      // left. A month header that is a date must be written back as a date, or
      // the mmmm yyyy format has nothing to format.
      if (raw instanceof Date) {
        if (raw.getFullYear() === Number(yr) && raw.getMonth() === mi) continue;
        // Keep the day where it was, clamped: new Date(2026, 8, 31) silently
        // becomes October 1st, which would move the header a whole month.
        var dim = new Date(Number(yr), mi + 1, 0).getDate();
        var d = Math.min(raw.getDate() || 1, dim);
        plan.push({
          row: r, col: c, isDate: true,
          from: MR_MON_ABBR[raw.getMonth()] + ' ' + raw.getFullYear(),
          to: MR_MON_ABBR[mi] + ' ' + yr,
          dateValue: new Date(Number(yr), mi, d,
                              raw.getHours(), raw.getMinutes(), raw.getSeconds()),
        });
        continue;
      }

      var txt = String(raw).trim();
      if (txt.length > 20) continue;
      for (var m = 0; m < 12; m++) {
        var re = new RegExp('^(' + MR_MON_FULL[m] + '|' + MR_MON_ABBR[m] + ')\\.?[ ,]*(\\d{2,4})?$', 'i');
        var hit = txt.match(re);
        if (!hit) continue;
        // Rebuild in the shape it was found: full name stays full, an
        // abbreviation stays abbreviated, and a cell with no year gains none.
        var wasFull = new RegExp('^' + MR_MON_FULL[m], 'i').test(txt);
        var want = (wasFull ? MR_MON_FULL[mi] : MR_MON_ABBR[mi])
                 + (hit[2] ? ' ' + (hit[2].length === 2 ? yr.slice(2) : yr) : '');
        if (want !== txt) plan.push({ row: r, col: c, from: txt, to: want });
        break;
      }
    }
  }
  return plan;
}

// ---- 2. the B2B deals ------------------------------------------------------
// Ethan 2026-08-12 said leave B2B manual and it was left manual — but "manual"
// meant nobody should INVENT the figures, not that last month's should carry.
// September opened holding Hovey, Trading Co, Sertoma, Wiese, Maxus, USD417,
// TVH and Cosentinos with August's money against them (Ethan, 2026-09-01).
//
// ⚠️ ONLY TYPED CELLS, AND ONLY BETWEEN THE HEADER AND THE TOTAL. The block is
// five columns — name, Buy, Sell, GM — repeated six times across the Buy tab at
// A41/F41/K41/P41/U41/Z41. Three things must survive:
//   • row 41 itself, which is the "B2B / Buy / Sell / GM" header
//   • the GM column, a formula (=1-(B42/C42)) whose #DIV/0! on an empty row is
//     what a correctly-cleared row is SUPPOSED to look like
//   • the TTL and Combo rows, and the whole SIXTH block at Z41, which is the
//     district roll-up and is formulas end to end (=B42+G42+L42+Q42+V42)
// Clearing only cells that hold no formula satisfies the last two for free; the
// walk below stops at the total row so the first is never in range.
function _mrB2bPlan(values, formulas, lastRow, lastCol) {
  var plan = [];
  for (var r = 0; r < lastRow; r++) {
    for (var c = 0; c < lastCol; c++) {
      if (String((values[r] || [])[c] || '').trim().toLowerCase() !== 'b2b') continue;
      // Down from the header to whatever ends the block. Bounded at 12 rows so a
      // missing total label cannot run the clear into the rest of the sheet.
      for (var rr = r + 1; rr < Math.min(r + 13, lastRow); rr++) {
        var label = String((values[rr] || [])[c] || '').trim().toLowerCase();
        if (MR_TOTAL_LABELS.indexOf(label) >= 0 || label === 'combo') break;
        for (var cc = c; cc < Math.min(c + MR_BUY_WIDTH, lastCol); cc++) {
          if ((formulas[rr] || [])[cc]) continue;       // GM column, and the Z roll-up
          var v = (values[rr] || [])[cc];
          if (v === '' || v === null || v === undefined) continue;
          plan.push({ row: rr, col: cc, was: String(v).slice(0, 24) });
        }
      }
    }
  }
  return plan;
}

// ---- 3. the goal fills ------------------------------------------------------
// ⚠️ THE ROLL IS THE RIGHT PLACE FOR THIS, NOT THE IMPORTER. The importer paints
// green at 100% and red below, and it now leaves a block alone until that block
// has a day with sales on it — but on the 1st the roll has ALREADY copied last
// month's fill, and the importer's next run is the following morning, by which
// time the month HAS sales and the honest paint is red. So the white would never
// actually be seen.
//
// The roll knows something the importer cannot: this tab is brand new and has
// never had a figure in it. That is the one moment "no colour" is certainly
// right, so that is where it is done.
//
// Bounded to labels containing "gp goal" on purpose: the Buy tab has a bare
// "goal" at AE2 whose neighbours are the 40/35/40 buying-day targets, and those
// are nobody's business here.
function _mrGoalFillPlan(values, lastRow, lastCol) {
  var plan = [];
  for (var r = 0; r < lastRow; r++) {
    for (var c = 0; c + 1 < lastCol; c++) {
      var t = String((values[r] || [])[c] || '').trim().toLowerCase();
      if (t.indexOf('gp goal') < 0) continue;
      plan.push({ row: r, col: c + 1 });     // the figure sits one to the right
    }
  }
  return plan;
}

// Both passes against one tab. Returns what it did, or would do.
function _mrCarryOverPass(tab, targetYm, dryRun) {
  var lastRow = tab.getLastRow(), lastCol = tab.getLastColumn();
  var rng = tab.getRange(1, 1, lastRow, lastCol);
  var values = rng.getValues(), formulas = rng.getFormulas();

  var names = _mrMonthNamePlan(values, formulas, targetYm, lastRow, lastCol);
  var b2b = _mrB2bPlan(values, formulas, lastRow, lastCol);
  var fills = _mrGoalFillPlan(values, lastRow, lastCol);
  var out = { monthNames: [], b2bCleared: [], fillsCleared: [] };

  names.forEach(function (p) {
    out.monthNames.push(_mrA1(p.row, p.col) + ' ' + (p.isDate ? '(date) ' : '')
      + '"' + p.from + '" -> "' + p.to + '"');
    // A date cell gets a Date. Writing the string "September 2026" over it would
    // read correctly and quietly break every formula that does date arithmetic
    // on it, plus the mmmm yyyy format it is displayed through.
    if (!dryRun) tab.getRange(p.row + 1, p.col + 1)
      .setValue(p.isDate ? p.dateValue : p.to);
  });
  b2b.forEach(function (p) {
    out.b2bCleared.push(_mrA1(p.row, p.col) + '[' + p.was + ']');
    if (!dryRun) tab.getRange(p.row + 1, p.col + 1).clearContent();
  });
  fills.forEach(function (p) {
    var cell = tab.getRange(p.row + 1, p.col + 1);
    var had = String(cell.getBackground()).toLowerCase();
    if (had === '#ffffff' || had === 'white') return;      // already clear
    out.fillsCleared.push(_mrA1(p.row, p.col) + '[' + had + ']');
    if (!dryRun) cell.setBackground(null);
  });
  return out;
}

// Run the two passes over a month that has ALREADY been rolled. September needed
// this because the roll that made it predates both passes; after that, the roll
// does it and this is only ever a repair tool.
//
// Dry run by default. mrPostRollRepair('2026-09', true) writes.
function mrPostRollRepair(ym, apply) {
  var ss = _mrSs();
  ym = ym || _mrCentralMonth();
  var entry = _mrIndex(ss)[ym];
  if (!entry) { Logger.log('no tabs for %s', ym); return; }
  Logger.log('=== %s %s ===', apply ? 'REPAIRING' : 'PREVIEW (nothing written)', ym);
  ['sales', 'buy'].forEach(function (family) {
    var tab = entry[family];
    if (!tab) return;
    var r = _mrCarryOverPass(tab, ym, !apply);
    Logger.log('-- %s', tab.getName());
    Logger.log('   month name : %s', r.monthNames.length ? r.monthNames.join('  ') : 'nothing to change');
    Logger.log('   B2B cleared: %s', r.b2bCleared.length ? r.b2bCleared.length + ' cells  ' + r.b2bCleared.join(' ') : 'nothing typed');
    Logger.log('   goal fills : %s', r.fillsCleared.length ? r.fillsCleared.length + ' cleared  ' + r.fillsCleared.join(' ') : 'already clear');
  });
  if (!apply) Logger.log('Nothing was written. Run mrRepairApply to write it.');
}

// ⚠️ THE RUN DROPDOWN CANNOT PASS AN ARGUMENT. It lists bare function names, so
// mrPostRollRepair picked from the menu always arrives with apply undefined and
// always dry-runs — which is safe, and completely undiscoverable as the reason
// nothing happened. These two are the pair you actually run, named the way
// mirror-fix.gs names its own (mrfFixPreview / mrfFixApply).
function mrRepairPreview() { mrPostRollRepair(_mrCentralMonth(), false); }
function mrRepairApply()   { mrPostRollRepair(_mrCentralMonth(), true); }

// Next month's tabs with a (PREVIEW) suffix, to be checked beside the real ones.
// Nothing reads a PREVIEW tab — the name does not match what the site's parsers
// look for, which is exactly why the suffix is safe.
function mrPreviewNextMonth() {
  var idx = _mrIndex(_mrSs());
  _mrReport(_mrRoll(_mrNextMonth(_mrLatestMonth(idx)), { suffix: ' (PREVIEW)' }));
}

// ---- verification against a month we already know the answer to ---------------
// The honest test of a rollover is not "does the tab look right" but "does it
// come out the same as the one a person built". So: rebuild a month whose real
// tab ALREADY EXISTS, and diff the two.
//
// Formulas are compared cell by cell across the whole tab — that is the literal
// form of "keep the exact formatting and formulas", and it is checkable rather
// than eyeballable. The day grid's VALUES are expected to differ (ours is empty,
// theirs has a month of trading in it) and are counted, not flagged. The footer
// cells are compared one by one, because those are the only cells this script
// decides for itself.
//
// Pick the month for what it exercises:
//   mrVerifyPastMonth('2026-07')   Jun 30 -> Jul 31   the row INSERT path
//   mrVerifyPastMonth('2026-06')   May 31 -> Jun 30   the row DELETE path
//   mrVerifyPastMonth('2026-08')   Jul 31 -> Aug 31   the GOAL write, against
//                                                     goals already on SPEEKS
function _mrA1(r, c) { return _mrColLetter(c) + (r + 1); }

// Every footer cell this script would ever write, located by label on the tab
// given. Returned as targets so the same cell can be read off two tabs and
// compared.
function _mrFooterCells(values, formulas, lastRow, lastCol, bases, family) {
  var out = [];
  for (var r = 0; r < lastRow; r++) {
    for (var c = 0; c < lastCol; c++) {
      var raw = (values[r] || [])[c];
      if (raw === '' || raw === null || raw === undefined) continue;
      var txt = String(raw).trim().toLowerCase();
      if (!txt || txt.length > 30) continue;
      var what = null;
      Object.keys(MR_FOOTER).forEach(function (k) { if (MR_FOOTER[k].indexOf(txt) >= 0) what = k; });
      if (!what) continue;
      // The Buy counters live at base+4, not beside the label — so the diff has
      // to look where the value actually is, or it compares two blank cells and
      // reports a tick. That is how the merged-label bug got past a green run.
      if (family === 'buy' && (what === 'buyDays' || what === 'thru')) {
        Object.keys(bases || {}).sort(function (a, b) { return bases[a] - bases[b]; }).forEach(function (code) {
          var k = bases[code] + MR_BUY_VALUE_COL;
          if (k < lastCol) out.push({ what: code + ' ' + what, row: r, col: k, label: _mrA1(r, c) });
        });
        continue;
      }
      for (var k2 = c + 1; k2 < Math.min(c + 4, lastCol); k2++) {
        if ((formulas[r] || [])[k2]) continue;
        out.push({ what: what, row: r, col: k2, label: _mrA1(r, c) });
        break;
      }
    }
  }
  return out;
}

function _mrDiffTabs(mine, real) {
  var mR = mine.getLastRow(), mC = mine.getLastColumn();
  var rR = real.getLastRow(), rC = real.getLastColumn();
  Logger.log('  size   : ours ' + mR + 'x' + mC + '   real ' + rR + 'x' + rC
             + (mR === rR && mC === rC ? '   ✓' : '   ⚠ MISMATCH'));

  var R = Math.min(mR, rR), C = Math.min(mC, rC);
  var af = mine.getRange(1, 1, R, C).getFormulas();
  var bf = real.getRange(1, 1, R, C).getFormulas();
  var same = 0, diff = [];
  for (var r = 0; r < R; r++) {
    for (var c = 0; c < C; c++) {
      var a = (af[r] || [])[c] || '', b = (bf[r] || [])[c] || '';
      if (a === b) { if (a) same++; continue; }
      if (diff.length < 20) diff.push(_mrA1(r, c) + '  ours[' + a.slice(0, 45) + ']  real[' + b.slice(0, 45) + ']');
      else if (diff.length === 20) diff.push('...');
      if (diff.length > 20) { r = R; break; }
    }
  }
  Logger.log('  formula: ' + same + ' identical'
             + (diff.length ? ', ' + diff.length + '+ DIFFERENT' : ', 0 different   ✓'));
  diff.forEach(function (d) { Logger.log('     ⚠ ' + d); });

  var av = mine.getRange(1, 1, R, C).getValues();
  var bv = real.getRange(1, 1, R, C).getValues();
  var family = /^Buy\s/i.test(real.getName()) ? 'buy' : 'sales';
  var cells = _mrFooterCells(bv, bf, R, C, _mrBases(bv, family === 'buy' ? MR_BUY_WIDTH : MR_SALES_WIDTH), family);
  Logger.log('  footers:');
  cells.forEach(function (f) {
    var ours = (av[f.row] || [])[f.col], theirs = (bv[f.row] || [])[f.col];
    var ok = String(ours) === String(theirs);
    Logger.log('     ' + (ok ? '✓' : '⚠') + ' ' + f.what + ' @' + f.label
               + ' -> ' + _mrA1(f.row, f.col)
               + '   ours=' + JSON.stringify(ours) + '  real=' + JSON.stringify(theirs));
  });
  if (!cells.length) Logger.log('     (no footer labels found on the real tab)');
}

function mrVerifyPastMonth(ym) {
  ym = ym || _mrCentralMonth();
  var ss = _mrSs();
  var idx = _mrIndex(ss);
  if (!idx[ym] || (!idx[ym].sales && !idx[ym].buy)) {
    Logger.log('no real tabs for ' + ym + ' — nothing to compare against. Months: '
               + Object.keys(idx).sort().join(', '));
    return;
  }
  Logger.log('######## VERIFY ' + ym + ' — rebuilding a month that already exists ########');
  var r = _mrRoll(ym, { suffix: ' (VERIFY)' });
  _mrReport(r);
  (r.reports || []).forEach(function (rep) {
    if (!rep.target) return;
    var mine = ss.getSheetByName(rep.target);
    var real = ss.getSheetByName(rep.target.replace(' (VERIFY)', ''));
    if (!mine || !real) { Logger.log('---- ' + rep.family + ': could not pair the tabs'); return; }
    Logger.log('---- ' + rep.family + ': ' + mine.getName() + '  vs  ' + real.getName() + ' ----');
    _mrDiffTabs(mine, real);
  });
  Logger.log('run mrDeleteScratchTabs() when you are done reading these.');
}

// The Run dropdown cannot pass an argument, so each month worth checking gets
// its own entry. Pick one from the toolbar and press Run.
function mrVerifyAug() { mrVerifyPastMonth('2026-08'); }   // Jul 31 -> Aug 31, the goal write
function mrVerifyJul() { mrVerifyPastMonth('2026-07'); }   // Jun 30 -> Jul 31, the row INSERT
function mrVerifyJun() { mrVerifyPastMonth('2026-06'); }   // May 31 -> Jun 30, the row DELETE

// Removes every (VERIFY) and (PREVIEW) tab. Named tabs only — it cannot touch a
// real month, because a real month's name does not carry a suffix.
function mrDeleteScratchTabs() {
  var ss = _mrSs();
  var gone = [];
  ss.getSheets().forEach(function (sh) {
    var n = sh.getName();
    if (n.indexOf(' (VERIFY)') < 0 && n.indexOf(' (PREVIEW)') < 0) return;
    ss.deleteSheet(sh);
    gone.push(n);
  });
  Logger.log(gone.length ? 'deleted: ' + gone.join(', ') : 'nothing to delete');
}

function mrCommitPreview() {
  var ss = _mrSs();
  var done = [];
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.indexOf(' (PREVIEW)') < 0) return;
    var real = name.replace(' (PREVIEW)', '');
    if (ss.getSheetByName(real)) { Logger.log('⚠ "' + real + '" already exists — left as PREVIEW'); return; }
    sh.setName(real);
    done.push(real);
  });
  Logger.log(done.length ? 'committed: ' + done.join(', ') : 'no PREVIEW tabs found');
}

// The real thing. Rolls into the month it is RUN IN, which is what a trigger on
// the 1st wants — not "the month after the newest tab", so a re-run can never
// walk the workbook into the future.
function mrRollThisMonth() {
  var ym = _mrCentralMonth();
  var idx = _mrIndex(_mrSs());
  if (idx[ym] && idx[ym].sales && idx[ym].buy) {
    Logger.log('already rolled: tabs for ' + ym + ' exist. Nothing to do.');
    return;
  }
  _mrReport(_mrRoll(ym, {}));
}

function mrInstallTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'mrRollThisMonth') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('mrRollThisMonth').timeBased().onMonthDay(1).atHour(4).create();
  Logger.log('trigger installed: mrRollThisMonth, 1st of the month, 4am');
}

// ---- web endpoints ----------------------------------------------------------
function _mrJson(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'diag') {
    var ss = _mrSs();
    var idx = _mrIndex(ss);
    var latest = _mrLatestMonth(idx);
    return _mrJson({ months: Object.keys(idx).sort(), latest: latest, next: _mrNextMonth(latest),
                     plan: _mrRoll(_mrNextMonth(latest), { dryRun: true }) });
  }
  return _mrJson({ ok: true, service: 'month-rollover' });
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }
  if (body.secret !== MR_SECRET) return _mrJson({ error: 'unauthorized' });

  if (body.action === 'goals') {
    var ym = String(body.month || '');
    if (!/^\d{4}-\d{2}$/.test(ym)) return _mrJson({ error: 'bad month' });
    var ss = _mrSs();
    var out = { goals: _mrWriteGoals(ss, ym, body.goals || {}) };
    // Only when SPEEKS actually had the closed-days panel open. A save that did
    // not touch them sends null, and the sheet's count is left alone.
    if (body.buyDays !== null && body.buyDays !== undefined) {
      out.buyDays = _mrWriteBuyDays(ss, ym, body.buyDays);
    }
    return _mrJson(out);
  }
  if (body.action === 'roll') {
    var m = String(body.month || _mrCentralMonth());
    if (!/^\d{4}-\d{2}$/.test(m)) return _mrJson({ error: 'bad month' });
    return _mrJson(_mrRoll(m, {}));
  }
  return _mrJson({ error: 'unknown action' });
}
