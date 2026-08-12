// ============================================================
// SPEEKS — Buying & Selling HISTORY endpoint
//
// Serves per-day buying and selling for ANY month the Sales Summary workbook
// still has a tab for, so the site is no longer limited to the month in
// progress. Read-only: it never writes to the sheet.
//
// WHY THIS EXISTS
// The hub's own doGet returns the CURRENT month only, and app_cache/buy_sell_hub
// carries only that month's daily arrays. The hourly capture into
// public.daily_buysell therefore has a window that closes before the data lands:
// a month's last day is only ever in range while it is "today", and it is not
// keyed until the following morning — by which time the cache has rolled over.
// Result: every month end is stored as zeros, and nothing before 2026-07 exists
// at all. The workbook has had all of it the whole time, one tab per month.
//
// ⚠️ DEPLOY AS A **STANDALONE** APPS SCRIPT PROJECT, not into the spreadsheet's
// bound project and not into the sales-email-import project. Every .gs in one
// project shares a single global scope, and the bound project still holds the
// dead sales-sync.gs which declares STORE_BASES/STORE_ORDER/numVal/pctVal with
// the same names as this file. If that one won the load order this would read a
// different geometry and still report success. Every global here is prefixed
// `BH_`/`_bh` for the same reason.
//
// SETUP (one-time)
//   1. script.google.com → New project → paste this file → save
//   2. Run `bhDiagnose` once from the Run dropdown and authorize when prompted
//      (it needs Spreadsheets read access). Read the log: it prints every tab it
//      found and the first data row it parsed from each, so the geometry below
//      is CONFIRMED against the real workbook before anything imports it.
//   3. Deploy → New deployment → Web app
//        Execute as: Me      Who has access: Anyone
//      Copy the /exec URL into the `BUYSELL_HISTORY_URL` secret used by the
//      buysell-history-sync edge function.
//   4. ⚠️ After ANY later edit: Deploy → Manage deployments → pencil →
//      Version: "New version" → Deploy. Saving does NOT change what /exec
//      serves, and "New deployment" mints a second URL instead of updating this
//      one. Same trap as the edge functions.
//
// ENDPOINTS (all GET)
//   ?action=months            list every month a tab exists for
//   ?action=month&month=YYYY-MM   one month
//   ?action=all               every month (used by the one-off backfill)
//   ?action=diag              geometry dump, as text, for eyeballing
// ============================================================

var BH_SHEET_ID = '1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8';

// ---- geometry ---------------------------------------------------------------
// Sales tabs ("Sales Aug 26"). Confirmed twice over: by listSalesDailyStructure
// when sales-sync.gs was written, and independently against the live sheet on
// 2026-08-04 when the email importer was built. Both agree.
//   11 columns per store, bases below; daily rows start at index 4.
//   base+0 day  base+1 Sales  base+2 MTD  base+3 Rev tracking  base+4 Cost
//   base+5 GP   base+6 MTD GP base+7 GP tracking  base+8 Margin  base+9 MOM
// ⚠️ THESE ARE THE PRESENT-DAY POSITIONS AND ARE NOT SAFE TO ASSUME. They are
// kept only as documentation of the current layout and as the width unit; the
// real bases are READ OFF THE HEADER ROW for every tab, by _bhBases below.
//
// Why: MPL and BAL opened during April 2026. In the Jan–Mar tabs only three
// stores existed, so the TTL block sits at base 33 — exactly where MPL's block
// sits from April on. Importing on fixed positions wrote the whole district's
// totals in as MPL. Confirmed to the cent on two months: Feb OVL+LEE+WSP
// 101,200.50 + 66,885.15 + 94,488.99 = 262,574.64, which is what base 33 held;
// March 106,609.65 + 86,168.11 + 106,947.06 = 299,724.82, likewise. The Buy tabs
// shift the same way (March paid 72,991 + 30,603 + 51,365 = 154,959 at base 15).
var BH_SALES_BASES_TODAY = { OVL: 0, LEE: 11, WSP: 22, MPL: 33, BAL: 44 };
var BH_SALES_WIDTH = 11;
var BH_SALES_FIRST_ROW = 4;

// Buy tabs ("Buy Aug 26"). 5 columns per store, base = index * 5.
//   base+0 day  base+1 Buy (CASH PAID)  base+2 Sell (RESALE VALUE)  base+3 GM
//   base+4 carries a weekly subtotal on some rows — not read.
//
// ⚠️ The two money columns read backwards from the rest of this system, and
// swapping them is a silent 2x error. The sheet's "Sell" column is the resale
// value of goods BOUGHT (this is what the hub calls wkBuy); the sheet's "Buy"
// column is the cash that left the till. Verified against OVL August 2026:
// day 1 = 2,972 paid / 5,893 resale / 49.57% GM, month 24,052 / 50,550.
// Present-day positions only — same caveat as the Sales bases above.
var BH_BUY_BASES_TODAY = { OVL: 0, LEE: 5, WSP: 10, MPL: 15, BAL: 20 };
var BH_BUY_WIDTH = 5;
var BH_BUY_FIRST_ROW = 1;
// How many rows from the top can name a block's owner. A generous superset of
// the real header rows: day rows hold numbers, so scanning a few extra costs
// nothing and covers a tab whose title sits a row lower than the others.
var BH_HEADER_ROWS = 4;

var BH_STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];

var BH_MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

// ---- helpers ----------------------------------------------------------------
function _bhNum(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// Percentages arrive either as a fraction (0.4957, a raw cell) or as 49.57 (a
// formatted one). Normalised to a FRACTION here, which is what daily_buysell
// stores and what the popout multiplies back up.
function _bhPct(v) {
  var n = _bhNum(v);
  if (n === null) return null;
  return n > 1 ? n / 100 : n;
}

// "Sales Aug 26" / "Buy August 26" -> "2026-08". Null for anything else, which
// is how a stray tab gets ignored rather than half-parsed.
function _bhTabMonth(name) {
  var m = /^(?:Sales|Buy)\s+([A-Za-z]+)\.?\s*'?(\d{2}|\d{4})\s*$/i.exec(String(name || '').trim());
  if (!m) return null;
  var mo = BH_MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  var yr = m[2].length === 2 ? 2000 + parseInt(m[2], 10) : parseInt(m[2], 10);
  return yr + '-' + (mo < 10 ? '0' + mo : '' + mo);
}

// Which column block belongs to which store, for THIS tab, read from its own
// header rows rather than assumed. A store that has no header cell is simply
// absent from the result — which is the correct answer for a month before that
// store opened, and is what stops the TTL block from being imported as MPL.
//
// Matched on a word boundary, not a substring: "Lee" and "Bal" occur inside
// ordinary words, and a header that happened to read "Balance" must not claim
// BAL's block. Codes are checked against text like "OVL Buying" or
// "August 2026  OVL", both of which are how the two tab families title a block.
function _bhBases(data, width) {
  var bases = {};
  var rows = Math.min(BH_HEADER_ROWS, data.length);
  for (var r = 0; r < rows; r++) {
    var row = data[r] || [];
    for (var c = 0; c < row.length; c++) {
      var txt = String(row[c] === null || row[c] === undefined ? '' : row[c]).toUpperCase();
      if (!txt) continue;
      for (var i = 0; i < BH_STORES.length; i++) {
        var code = BH_STORES[i];
        if (bases[code] !== undefined) continue;
        if (new RegExp('(^|[^A-Z])' + code + '([^A-Z]|$)').test(txt)) {
          // Anchor to the start of the block the naming cell falls in, so it
          // does not matter whether the code sits at base+0, +1 or +2.
          bases[code] = Math.floor(c / width) * width;
        }
      }
    }
  }
  return bases;
}

function _bhJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Index every Sales/Buy tab by month, once, so a whole-workbook read opens the
// spreadsheet a single time.
function _bhIndex(ss) {
  var idx = {};
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    var ym = _bhTabMonth(name);
    if (!ym) return;
    if (!idx[ym]) idx[ym] = { sales: null, buy: null };
    if (/^Sales\s/i.test(name)) idx[ym].sales = sh;
    else if (/^Buy\s/i.test(name)) idx[ym].buy = sh;
  });
  return idx;
}

// ---- readers ----------------------------------------------------------------
// Both readers locate a day by the day number in the block's OWN first column
// rather than by row offset. An inserted or deleted sheet row would otherwise
// shift every value silently and corrupt a whole month — the same guard the
// sales email importer uses, for the same reason.
//
// And the day column is read STRICTLY IN SEQUENCE: a block's next accepted day
// must be exactly one more than its last. Below the daily table both tabs carry
// footer rows — TTL, Tracking, "Buying Days in Month 26", "Days thru Month 8" —
// whose values land in columns that belong to another store's block. 26 and 8
// are perfectly good day numbers, and a plain 1..31 test would import a footer
// cell as a day's takings. Running the sequence out is also what stops the scan
// at the end of the month without having to know where the table ends.
function _bhReadSales(sheet, out, warn) {
  var data = sheet.getDataRange().getValues();
  if (data.length <= BH_SALES_FIRST_ROW) { warn.push(sheet.getName() + ': no data rows'); return; }
  var bases = _bhBases(data, BH_SALES_WIDTH);
  var found = Object.keys(bases);
  if (!found.length) { warn.push(sheet.getName() + ': no store found in the header rows — SKIPPED'); return; }
  if (found.length < BH_STORES.length) {
    warn.push(sheet.getName() + ': only ' + found.sort().join('/') + ' (others had not opened)');
  }
  var next = {};
  found.forEach(function (c) { next[c] = 1; });
  for (var r = BH_SALES_FIRST_ROW; r < data.length; r++) {
    var row = data[r];
    for (var i = 0; i < found.length; i++) {
      var code = found[i], base = bases[code];
      var day = parseInt(row[base], 10);
      if (isNaN(day) || day !== next[code]) continue;
      next[code]++;
      var sales = _bhNum(row[base + 1]);
      var cost = _bhNum(row[base + 4]);
      var gp = _bhNum(row[base + 5]);
      if (sales === null && gp === null) continue;
      if (!out[code]) out[code] = {};
      if (!out[code][day]) out[code][day] = { d: day };
      out[code][day].sales = sales;
      out[code][day].cost = cost;
      out[code][day].gp = gp;
      // Straight off the sheet rather than recomputed: this is the column the
      // managers already read, and a near-miss reimplementation of it would be
      // worse than not showing it.
      out[code][day].mom = _bhNum(row[base + 9]);
    }
  }
}

function _bhReadBuy(sheet, out, warn) {
  var data = sheet.getDataRange().getValues();
  if (data.length <= BH_BUY_FIRST_ROW) { warn.push(sheet.getName() + ': no data rows'); return; }
  var bases = _bhBases(data, BH_BUY_WIDTH);
  var found = Object.keys(bases);
  if (!found.length) { warn.push(sheet.getName() + ': no store found in the header rows — SKIPPED'); return; }
  if (found.length < BH_STORES.length) {
    warn.push(sheet.getName() + ': only ' + found.sort().join('/') + ' (others had not opened)');
  }
  var next = {};
  found.forEach(function (c) { next[c] = 1; });
  for (var r = BH_BUY_FIRST_ROW; r < data.length; r++) {
    var row = data[r];
    for (var i = 0; i < found.length; i++) {
      var code = found[i], base = bases[code];
      var day = parseInt(row[base], 10);
      if (isNaN(day) || day !== next[code]) continue;
      next[code]++;
      var paid = _bhNum(row[base + 1]);     // sheet "Buy"  = cash out
      var resale = _bhNum(row[base + 2]);   // sheet "Sell" = resale value
      var gm = _bhPct(row[base + 3]);
      if (paid === null && resale === null) continue;
      if (!out[code]) out[code] = {};
      if (!out[code][day]) out[code][day] = { d: day };
      out[code][day].paid = paid;
      out[code][day].resale = resale;
      // GM is a formula over the two cells beside it and reads #DIV/0! on a day
      // with no buying, which arrives as a non-number. Derived from the pair
      // when that happens so a closed day does not poison the month.
      out[code][day].gm = (gm === null && resale) ? (resale - paid) / resale : gm;
    }
  }
}

function _bhMonth(idx, ym, warn) {
  var pair = idx[ym];
  if (!pair) return null;
  var out = {};
  if (pair.sales) _bhReadSales(pair.sales, out, warn); else warn.push(ym + ': no Sales tab');
  if (pair.buy) _bhReadBuy(pair.buy, out, warn); else warn.push(ym + ': no Buy tab');
  // Objects keyed by day become arrays sorted by day — one shape for the caller,
  // and a missing day is simply absent rather than a hole in an index.
  var res = {};
  BH_STORES.forEach(function (code) {
    var byDay = out[code];
    // Absent, not empty: a store that had not opened yet should not appear in
    // the payload at all, so nothing downstream can mistake "no block for this
    // store in this month" for "this store traded nothing".
    if (!byDay) return;
    var days = Object.keys(byDay).map(function (k) { return byDay[k]; });
    days.sort(function (a, b) { return a.d - b.d; });
    res[code] = days;
  });
  return res;
}

// The block layout actually detected for a month, for the diagnostic. Reported
// beside the totals so a shifted tab is visible as a shifted tab rather than as
// numbers that merely look wrong.
function _bhBasesFor(pair) {
  var out = { sales: {}, buy: {} };
  if (pair.sales) out.sales = _bhBases(pair.sales.getDataRange().getValues(), BH_SALES_WIDTH);
  if (pair.buy) out.buy = _bhBases(pair.buy.getDataRange().getValues(), BH_BUY_WIDTH);
  return out;
}

// ---- web app ----------------------------------------------------------------
function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = String(p.action || 'months');
  try {
    var ss = SpreadsheetApp.openById(BH_SHEET_ID);
    var idx = _bhIndex(ss);
    var months = Object.keys(idx).sort().reverse();
    var warn = [];

    if (action === 'months') return _bhJson({ ok: true, months: months });

    if (action === 'month') {
      var ym = String(p.month || '');
      if (!/^\d{4}-\d{2}$/.test(ym)) return _bhJson({ ok: false, error: 'bad month' });
      var one = _bhMonth(idx, ym, warn);
      if (!one) return _bhJson({ ok: false, error: 'no tabs for ' + ym, months: months });
      var d1 = {}; d1[ym] = one;
      return _bhJson({ ok: true, months: months, data: d1, warnings: warn });
    }

    if (action === 'all') {
      var all = {};
      months.forEach(function (ym) { all[ym] = _bhMonth(idx, ym, warn); });
      return _bhJson({ ok: true, months: months, data: all, warnings: warn });
    }

    if (action === 'diag') return ContentService.createTextOutput(_bhDiagText());

    return _bhJson({ ok: false, error: 'unknown action' });
  } catch (err) {
    return _bhJson({ ok: false, error: String(err) });
  }
}

// ---- diagnostic -------------------------------------------------------------
// Run this from the editor BEFORE trusting anything above. It prints what was
// actually found so the geometry is confirmed rather than assumed — the same
// habit that caught the stale constants last time.
function bhDiagnose() { Logger.log(_bhDiagText()); }

function _bhDiagText() {
  var ss = SpreadsheetApp.openById(BH_SHEET_ID);
  var idx = _bhIndex(ss);
  var months = Object.keys(idx).sort().reverse();
  var lines = [];
  lines.push('Workbook: ' + ss.getName());
  lines.push('Tabs in workbook: ' + ss.getSheets().length);
  lines.push('Months recognised: ' + months.length + '  ' + months.join(', '));

  var unmatched = [];
  ss.getSheets().forEach(function (sh) {
    var n = sh.getName();
    if (/^(Sales|Buy)\s/i.test(n) && !_bhTabMonth(n)) unmatched.push(n);
  });
  if (unmatched.length) lines.push('⚠️ Sales/Buy tabs whose NAME did not parse: ' + unmatched.join(', '));

  months.forEach(function (ym) {
    var warn = [];
    var m = _bhMonth(idx, ym, warn);
    lines.push('');
    lines.push('=== ' + ym + '  (sales tab: ' + (idx[ym].sales ? idx[ym].sales.getName() : 'MISSING')
      + ', buy tab: ' + (idx[ym].buy ? idx[ym].buy.getName() : 'MISSING') + ')');
    var b = _bhBasesFor(idx[ym]);
    lines.push('  blocks  sales: ' + JSON.stringify(b.sales) + '  buy: ' + JSON.stringify(b.buy));
    BH_STORES.forEach(function (code) {
      var days = (m && m[code]) || [];
      var withSales = 0, withBuy = 0, tSales = 0, tGp = 0, tPaid = 0, tResale = 0;
      days.forEach(function (x) {
        if (x.sales !== null && x.sales !== undefined) { withSales++; tSales += x.sales; tGp += (x.gp || 0); }
        if (x.resale !== null && x.resale !== undefined) { withBuy++; tPaid += (x.paid || 0); tResale += x.resale; }
      });
      lines.push('  ' + code + '  days=' + days.length + ' sell=' + withSales + ' buy=' + withBuy
        + ' | sales ' + tSales.toFixed(2) + ' gp ' + tGp.toFixed(2)
        + ' | paid ' + tPaid.toFixed(2) + ' resale ' + tResale.toFixed(2));
      // One sample row, newest month only. Printing it for all eight overflowed
      // the Apps Script log last time and truncated the older months, which are
      // the ones most likely to be laid out differently.
      if (ym === months[0]) lines.push('      first row: ' + (days[0] ? JSON.stringify(days[0]) : '(none)'));
    });
    // Cross-check that catches a shifted block even when the bases look right:
    // a store whose month total equals the sum of the others is the TTL column
    // wearing a store's name. This is exactly how Jan–Mar hid before the header
    // scan went in, and it costs nothing to keep asserting.
    var tot = {};
    BH_STORES.forEach(function (c) {
      var ds = (m && m[c]) || [];
      tot[c] = ds.reduce(function (a, x) { return a + (x.sales || 0); }, 0);
    });
    BH_STORES.forEach(function (c) {
      if (!tot[c]) return;
      var others = 0;
      BH_STORES.forEach(function (o) { if (o !== c) others += tot[o]; });
      if (others > 0 && Math.abs(tot[c] - others) < 0.02) {
        lines.push('  ⚠️ ' + c + ' equals the sum of the other stores — this block is the TTL column');
      }
    });
    if (warn.length) lines.push('  warnings: ' + warn.join('; '));
  });
  return lines.join('\n');
}
