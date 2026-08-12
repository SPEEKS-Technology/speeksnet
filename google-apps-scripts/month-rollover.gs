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

// Where one store's block ends: at the next store's block, or the last column.
function _mrBlockEnd(bases, base, lastCol) {
  var end = lastCol;
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

// Column offsets carrying a formula on EVERY Sunday of the source month and on
// none of its other days — the weekly rows. Found by comparison rather than by
// knowing which column it is, so a moved column costs nothing.
function _mrWeeklyCells(srcFormulas, bases, dayRows, sundays, width, lastCol) {
  var out = [];
  Object.keys(bases).forEach(function (code) {
    var base = bases[code];
    var end = Math.min(base + width, lastCol);
    for (var col = base + 1; col < end; col++) {
      var sunSeen = 0, sunF = 0, weekSeen = 0, weekF = 0;
      for (var d in dayRows) {
        var r = dayRows[d];
        var f = (srcFormulas[r] || [])[col];
        if (sundays.indexOf(parseInt(d, 10)) >= 0) { sunSeen++; if (f) sunF++; }
        else { weekSeen++; if (f) weekF++; }
      }
      if (sunSeen && sunF === sunSeen && weekF === 0) out.push({ store: code, col: col, offset: col - base });
    }
  });
  return out;
}

// The month total the SOURCE tab finished on, per store: the first number to the
// right of its TTL/TOTAL label inside that store's block. Taken off the sheet
// rather than re-added here, so the new tab's "Last month" is the workbook's own
// figure and cannot disagree with it.
function _mrSourceTotals(srcValues, bases, firstRow, lastCol) {
  var out = {};
  Object.keys(bases).forEach(function (code) {
    var base = bases[code];
    var end = _mrBlockEnd(bases, base, lastCol);
    for (var r = firstRow; r < srcValues.length; r++) {
      var label = String((srcValues[r] || [])[base] || '').trim().toLowerCase();
      if (MR_TOTAL_LABELS.indexOf(label) < 0) continue;
      for (var c = base + 1; c < end; c++) {
        var n = parseFloat(String((srcValues[r] || [])[c] || '').toString().replace(/[$,]/g, ''));
        if (!isNaN(n)) { out[code] = n; break; }
      }
      if (out[code] !== undefined) break;
    }
  });
  return out;
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
  rep.weekly = _mrWeeklyCells(srcFormulas, bases, srcDays, srcSun, width, srcLastCol);
  var totals = _mrSourceTotals(srcValues, bases, firstRow, srcLastCol);

  var name = _mrNameLike(src.getName(), targetYm);
  if (!name) { rep.warn.push('could not build a tab name from "' + src.getName() + '"'); return rep; }
  if (opts.suffix) name += opts.suffix;
  rep.target = name;
  if (opts.dryRun) {
    rep.plan = { dayRows: srcCount + ' -> ' + wantCount, sundays: tgtSun.join(','),
                 lastMonth: JSON.stringify(totals) };
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
    var end = _mrBlockEnd(tgtBases, base, lastCol);
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
        row.push(f ? f : '');
      }
      grid.push(row);
      for (var c2 = base + 1; c2 < end; c2++) {
        if (!(formulas[r] || [])[c2]) {
          var v = (values[r] || [])[c2];
          if (v !== '' && v !== null && v !== undefined) rep.cleared++;
        }
      }
    }
    tab.getRange(start + 1, base + 1, wantCount, w).setValues(grid);
  });

  // ---- the weekly rows, onto the new month's Sundays ----
  // Copied from the source cell rather than written, so the relative references
  // shift with the row exactly as they would if a person had dragged it.
  if (rep.weekly.length && srcSun.length) {
    var afterValues = tab.getRange(1, 1, tab.getLastRow(), lastCol).getValues();
    rep.weekly.forEach(function (wk) {
      var base = tgtBases[wk.store];
      if (base === undefined) return;
      var rows = _mrDayRows(afterValues, base, firstRow);
      var start = rows[1];
      if (start === undefined) return;
      var srcRow = srcDays[srcSun[0]];
      if (srcRow === undefined) return;
      var from = src.getRange(srcRow + 1, wk.col + 1);
      tgtSun.forEach(function (d) {
        if (d > wantCount) return;
        from.copyTo(tab.getRange(start + d, wk.col + 1));
      });
    });
  }

  // ---- footers ----
  rep.footer = _mrFooters(tab, tgtBases, firstRow, wantCount, targetYm, opts.goals || {}, totals);
  return rep;
}

// Month-dependent footer cells, found by their label. Only a cell that is not a
// formula is ever written.
function _mrFooters(tab, bases, firstRow, wantCount, targetYm, goals, sourceTotals) {
  var out = [];
  var lastRow = tab.getLastRow(), lastCol = tab.getLastColumn();
  var values = tab.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = tab.getRange(1, 1, lastRow, lastCol).getFormulas();
  var codes = Object.keys(bases);
  var sundays = _mrSundays(targetYm).length;

  function blockOf(col) {
    var best = null;
    codes.forEach(function (c) { if (bases[c] <= col && (best === null || bases[c] > bases[best])) best = c; });
    return best;
  }
  function writeRight(r, c, val) {
    for (var k = c + 1; k < Math.min(c + 4, lastCol); k++) {
      if ((formulas[r] || [])[k]) continue;
      tab.getRange(r + 1, k + 1).setValue(val);
      return true;
    }
    return false;
  }

  for (var r = 0; r < lastRow; r++) {
    for (var c = 0; c < lastCol; c++) {
      var raw = (values[r] || [])[c];
      if (raw === '' || raw === null || raw === undefined) continue;
      var txt = String(raw).trim().toLowerCase();
      if (!txt || txt.length > 30) continue;
      var code = blockOf(c);

      if (MR_FOOTER.days.indexOf(txt) >= 0) {
        if (writeRight(r, c, wantCount)) out.push('days=' + wantCount);
      } else if (MR_FOOTER.thru.indexOf(txt) >= 0) {
        if (writeRight(r, c, 0)) out.push('thru=0');
      } else if (MR_FOOTER.buyDays.indexOf(txt) >= 0) {
        // Days minus Sundays. A STARTING VALUE only — holidays are a judgement
        // this cannot make, so it is logged for eyeballing.
        if (writeRight(r, c, wantCount - sundays)) out.push('buyDays=' + (wantCount - sundays) + ' (check holidays)');
      } else if (MR_FOOTER.goal.indexOf(txt) >= 0 && code) {
        if (goals[code] !== undefined && goals[code] !== null) {
          if (writeRight(r, c, goals[code])) out.push(code + ' goal=' + goals[code]);
        } else {
          out.push(code + ' goal NOT SET on SPEEKS — left as it was');
        }
      } else if (MR_FOOTER.lastMonth.indexOf(txt) >= 0 && code) {
        if (sourceTotals[code] !== undefined) {
          if (writeRight(r, c, sourceTotals[code])) out.push(code + ' lastMonth=' + sourceTotals[code]);
        }
      }
    }
  }
  return out;
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
  var codes = Object.keys(bases);
  var wrote = [], found = [];

  function blockOf(col) {
    var best = null;
    codes.forEach(function (c) { if (bases[c] <= col && (best === null || bases[c] > bases[best])) best = c; });
    return best;
  }

  for (var r = 0; r < lastRow; r++) {
    for (var c = 0; c < lastCol; c++) {
      var raw = (values[r] || [])[c];
      if (raw === '' || raw === null || raw === undefined) continue;
      if (MR_FOOTER.goal.indexOf(String(raw).trim().toLowerCase()) < 0) continue;
      var code = blockOf(c);
      found.push((code || '?') + '@' + (r + 1) + ',' + (c + 1));
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
    Logger.log('  rows   : +' + rep.rowsInserted + ' / -' + rep.rowsDeleted);
    Logger.log('  cleared: ' + rep.cleared + ' typed cells');
    Logger.log('  weekly : ' + (rep.weekly.length
      ? rep.weekly.map(function (w) { return w.store + '+' + w.offset; }).join(', ')
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

// Next month's tabs with a (PREVIEW) suffix, to be checked beside the real ones.
// Nothing reads a PREVIEW tab — the name does not match what the site's parsers
// look for, which is exactly why the suffix is safe.
function mrPreviewNextMonth() {
  var idx = _mrIndex(_mrSs());
  _mrReport(_mrRoll(_mrNextMonth(_mrLatestMonth(idx)), { suffix: ' (PREVIEW)' }));
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
    return _mrJson(_mrWriteGoals(_mrSs(), ym, body.goals || {}));
  }
  if (body.action === 'roll') {
    var m = String(body.month || _mrCentralMonth());
    if (!/^\d{4}-\d{2}$/.test(m)) return _mrJson({ error: 'bad month' });
    return _mrJson(_mrRoll(m, {}));
  }
  return _mrJson({ error: 'unknown action' });
}
