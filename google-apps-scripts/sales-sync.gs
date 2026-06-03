// ============================================================
// SPEEKS Sales → Supabase Sync
// Paste into Apps Script for the Sales Summary spreadsheet.
//
// SETUP (one-time):
//   1. Extensions → Apps Script → paste this file
//   2. Triggers → Add Trigger: onEditInstallable, On edit
//   3. Authorize, then run pushToSupabase() once manually
// ============================================================

var SUPABASE_SYNC_URL = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/sync-sales';
var SYNC_SECRET = 'sp33ks-sync-k3y-2026-x9mq';

// Sales tab block layout (confirmed via listSalesDailyStructure):
//   Each store occupies 11 columns. Block base columns:
//     OVL=0, LEE=11, WSP=22, MPL=33, BAL=44
//   Within each block (in daily data rows, 0-indexed from block base):
//     base+0 : day number (also in col 0 for all stores)
//     base+1 : daily sell revenue  → sell_revenue
//     base+2 : cumulative MTD revenue (not synced; hub computes this)
//     base+3 : revenue tracking projection
//     base+4 : daily COGS  (also holds GP goal $ in header row 1)
//     base+5 : daily sell GP  → sell_gp
//     base+6 : cumulative MTD GP
//     base+7 : GP tracking projection
//     base+8 : sell margin %
//     base+9 : MOM %
//     base+10: (empty)
//   Header rows (0-indexed):
//     Row 0: pct-of-goal achieved per store
//     Row 1: date, store name, "GP Goal", goal $ at base+4
//     Row 2: empty
//     Row 3: column labels (Sales, Total, Rev Tracking, Cost, GP, ...)
//     Rows 4+: daily data
var STORE_ORDER = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
var STORE_BASES = [0, 11, 22, 33, 44];
var DAILY_DATA_START_ROW = 4;

function onEditInstallable(e) {
  pushToSupabase();
}

function pushToSupabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var weekly       = parseWeeklySummary(ss);
  var dailyBuying  = parseDailyBuying(ss);
  var monthlyGoals = parseSalesGoals(ss);
  var dailySales   = parseDailySales(ss);

  var payload = JSON.stringify({
    secret:        SYNC_SECRET,
    weekly:        weekly,
    daily_buying:  dailyBuying,
    monthly_goals: monthlyGoals,
    daily_sales:   dailySales
  });

  var response = UrlFetchApp.fetch(SUPABASE_SYNC_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: payload,
    muteHttpExceptions: true
  });

  var result = JSON.parse(response.getContentText());
  Logger.log('Sync — weekly: '        + (result.weekly        || 0) +
             ', daily_buying: '       + (result.daily_buying  || 0) +
             ', monthly_goals: '      + (result.monthly_goals || 0) +
             ', daily_sales: '        + (result.daily_sales   || 0));
  if (result.error) Logger.log('ERROR: ' + result.error);
}

// ------------------------------------------------------------
// Parse "Summary" tab — weekly store-level sales data
// ------------------------------------------------------------
function parseWeeklySummary(ss) {
  var sheet = ss.getSheetByName('Summary');
  if (!sheet) { Logger.log('Sheet "Summary" not found.'); return []; }

  var data = sheet.getDataRange().getValues();
  var STORES = { OVL: true, LEE: true, WSP: true, MPL: true, BAL: true, Company: true };
  var MONTH_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
  var DATE_RANGE_RE = /(\d{1,2}-\d{1,2})/;
  var results = [];
  var currentWeekLabel = null;
  var monthCounter = {};

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var colA = String(row[0]).trim();

    if (MONTH_RE.test(colA) && !STORES[colA]) {
      var month = colA.match(/^[A-Za-z]+/)[0];
      var dateRange = null;
      for (var c = 0; c < row.length; c++) {
        var m = String(row[c]).match(DATE_RANGE_RE);
        if (m) { dateRange = m[1]; break; }
      }
      if (dateRange) {
        currentWeekLabel = month + ' ' + dateRange;
      } else {
        monthCounter[month] = (monthCounter[month] || 0) + 1;
        currentWeekLabel = month + ' wk' + monthCounter[month];
      }
      continue;
    }

    if (!currentWeekLabel || !STORES[colA]) continue;

    results.push({
      store:                colA,
      week_label:           currentWeekLabel,
      revenue:              numVal(row[1]),
      cogs:                 numVal(row[2]),
      gross_profit:         numVal(row[3]),
      margin_pct:           pctVal(row[4]),
      return_pct_weekly:    pctVal(row[6]),
      return_pct_mtd:       pctVal(row[7]),
      ebay_pct_weekly:      pctVal(row[9]),
      ebay_pct_mtd:         pctVal(row[10]),
      paymore_rank:         intVal(row[12]),
      buying_value:         numVal(row[14]),
      margin_weekly_pct:    pctVal(row[15]),
      margin_mtd_pct:       pctVal(row[16]),
      cust_conv_weekly_pct: pctVal(row[17]),
      cust_conv_mtd_pct:    pctVal(row[18]),
      dev_conv_weekly_pct:  pctVal(row[19]),
      dev_conv_mtd_pct:     pctVal(row[20]),
      traffic:              intVal(row[21]),
      inventory_line_items: intVal(row[23]),
      qty_items:            intVal(row[24]),
      inventory_value:      numVal(row[25]),
      b2b:                  numVal(row[26])
    });
  }

  Logger.log('Weekly rows: ' + results.length);
  return results;
}

// ------------------------------------------------------------
// Parse "Buy [Month]" tabs — daily buying per store
//
// Buy tab columns per store (5 cols, base = storeIndex * 5):
//   base+0: day number
//   base+1: net cost basis       → buy_amount
//   base+2: buying spend         → sell_amount (= wkBuy in hub)
//   base+3: buy margin %         → gross_margin_pct
//   base+4: (empty/unused)       → buy_margin_pct
// ------------------------------------------------------------
function parseDailyBuying(ss) {
  var results = [];
  var BUY_STORE_ORDER = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL', 'TTL'];

  ss.getSheets().forEach(function(sheet) {
    var name = sheet.getName();
    if (!/^Buy /i.test(name)) return;

    var monthYear = name.replace(/^Buy\s+/i, '').trim().replace(/\b(\d{2})$/, '20$1');
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return;

    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      for (var si = 0; si < BUY_STORE_ORDER.length; si++) {
        var base   = si * 5;
        var dayNum = parseInt(row[base]);
        var buyAmt = numVal(row[base + 1]);
        if (isNaN(dayNum) || !buyAmt || buyAmt === 0) continue;
        results.push({
          store:            BUY_STORE_ORDER[si],
          month_year:       monthYear,
          day_number:       dayNum,
          buy_amount:       buyAmt,
          sell_amount:      numVal(row[base + 2]),
          gross_margin_pct: pctVal(row[base + 3]),
          buy_margin_pct:   pctVal(row[base + 4])
        });
      }
    }
  });

  Logger.log('Daily buying rows: ' + results.length);
  return results;
}

// ------------------------------------------------------------
// Parse "Sales [Month]" tabs — daily sell revenue + GP per store
//
// Block layout: STORE_BASES = [0, 11, 22, 33, 44]
// Within each block: base+1 = daily revenue, base+5 = daily GP
// Daily rows start at DAILY_DATA_START_ROW = 4
// ------------------------------------------------------------
function parseDailySales(ss) {
  var results = [];

  ss.getSheets().forEach(function(sheet) {
    var name = sheet.getName();
    if (!/^Sales /i.test(name)) return;

    var monthYear = name.replace(/^Sales\s+/i, '').trim().replace(/\b(\d{2})$/, '20$1');
    var data = sheet.getDataRange().getValues();
    if (data.length <= DAILY_DATA_START_ROW) return;

    for (var r = DAILY_DATA_START_ROW; r < data.length; r++) {
      var row = data[r];
      var dayNum = parseInt(row[0]);
      if (isNaN(dayNum) || dayNum < 1 || dayNum > 31) continue;

      for (var si = 0; si < STORE_ORDER.length; si++) {
        var base = STORE_BASES[si];
        var rev  = numVal(row[base + 1]);
        var gp   = numVal(row[base + 5]);
        if (rev === null && gp === null) continue;
        results.push({
          store:        STORE_ORDER[si],
          month_year:   monthYear,
          day_number:   dayNum,
          sell_revenue: rev,
          sell_gp:      gp
        });
      }
    }
  });

  Logger.log('Daily sales rows: ' + results.length);
  return results;
}

// ------------------------------------------------------------
// Parse "Sales [Month]" tabs — monthly GP goals per store
//
// Goal $ for each store is in header row 1 at base+4:
//   OVL: row1[4], LEE: row1[15], WSP: row1[26], MPL: row1[37], BAL: row1[48]
// ------------------------------------------------------------
function parseSalesGoals(ss) {
  var results = [];

  ss.getSheets().forEach(function(sheet) {
    var name = sheet.getName();
    if (!/^Sales /i.test(name)) return;

    var monthYear = name.replace(/^Sales\s+/i, '').trim().replace(/\b(\d{2})$/, '20$1');
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return;

    var goalRow = data[1];
    STORE_ORDER.forEach(function(store, si) {
      var goal = numVal(goalRow[STORE_BASES[si] + 4]);
      if (!goal || goal < 1000) return;
      results.push({
        store:        store,
        month_year:   monthYear,
        revenue_goal: goal,
        pct_achieved: null
      });
    });
  });

  Logger.log('Monthly goals: ' + results.length);
  return results;
}

// ------------------------------------------------------------
// DIAGNOSTIC: Log header + first data rows for all Sales tabs
// ------------------------------------------------------------
function listSalesDailyStructure() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.getSheets().forEach(function(sheet) {
    var name = sheet.getName();
    if (!/^Sales /i.test(name)) return;
    var data = sheet.getDataRange().getValues();
    Logger.log('=== ' + name + ' ===');
    for (var r = 0; r < Math.min(2, data.length); r++) {
      Logger.log('Header row ' + r + ': ' + data[r].slice(0, 15).map(function(v, i) {
        return 'col' + i + '=' + JSON.stringify(v);
      }).join(', '));
    }
    for (var r = 2; r < Math.min(7, data.length); r++) {
      Logger.log('Data row ' + r + ': ' + data[r].slice(0, 15).map(function(v, i) {
        return 'col' + i + '=' + JSON.stringify(v);
      }).join(', '));
    }
  });
}

// ------------------------------------------------------------
// DIAGNOSTIC: List all sheet names
// ------------------------------------------------------------
function listSheetNames() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.getSheets().forEach(function(s) { Logger.log(s.getName()); });
}

// ------------------------------------------------------------
// Value helpers
// ------------------------------------------------------------
function numVal(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function pctVal(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = parseFloat(v);
  if (isNaN(n)) return null;
  return n <= 1 ? Math.round(n * 10000) / 100 : Math.round(n * 100) / 100;
}

function intVal(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = parseInt(v);
  return isNaN(n) ? null : n;
}
