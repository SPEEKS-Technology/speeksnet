// ============================================================================
// THE HUB — Code.gs of the Apps Script project bound to "SPEEKSNET 2.0 Sales
// Summary". doGet() is the endpoint sync-buysell pulls every 10 minutes, and
// getDashboardData() is the whole payload behind the Live Dashboard, the
// leaderboard, the district board and the weekly report.
//
// ⚠️ THIS FILE IS NOT DEPLOYED FROM THE REPO. It lives in the Apps Script
// editor; this copy exists so the source can be read and reviewed, and so the
// next fix does not start by asking somebody to paste their production hub into
// a chat window. After editing here it still has to be pasted into Code.gs and
// deployed via Deploy -> Manage deployments -> New version (never "New
// deployment": that mints a new /exec URL and sync-buysell has the old one).
//
// ============================================================================
// ⚠️⚠️ THE ROW NUMBERS BELOW ARE COMPUTED, NEVER TYPED. READ THIS BEFORE EDITING.
// ============================================================================
// Every figure this file returns used to come from a hard-coded row — the sales
// totals at row 36, the buying totals at 35, the day grids at 5:35 and 4:34.
// Those are the right rows in a 31-DAY MONTH and only in a 31-day month.
//
// month-rollover.gs sizes each new month's day grid to the calendar
// (`wantCount = _mrDaysIn(targetYm)`) and inserts or DELETES rows to fit. So on
// 1 September 2026 — 30 days after a 31-day August — every row below the grid
// moved up one, and this file spent the day reading:
//
//   * sales totals from row 36, which was now blank  -> ovlRev, ovlGP,
//     ovlTrackRev, ovlTrackGP and ovlSellMargin all came back empty, and the
//     Live Dashboard's "Company Tracking To Goal" tile read 0%
//   * buying totals from C35, which was now the PROJECTION row -> every store's
//     BuyVal was its month-end projection: BAL reported $43,082 bought on the
//     1st against a real $1,657, exactly 26x, 26 being the buying days in the
//     month
//   * ovlBuyProj from C36, now blank -> 0
//   * the day arrays from 31-row ranges, sweeping the TOTAL row in as "day 31",
//     so every store's last day carried the whole month's takings
//
// Nothing threw. Every number was the right SHAPE from the wrong cell, which is
// the failure no try/catch catches and no alert notices.
//
// So the rows are derived from the length of the month, once, at the top. The
// derived values reproduce the old constants exactly when the month has 31 days
// — that equivalence is the test in tests/hub-rows-check.js, and it is what
// makes this change safe to paste.
// ============================================================================

function doGet() {
  var data = getDashboardData();
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// The rows that move with the month. `date` is passed in rather than read here
// so the caller and this helper can never disagree about which month it is.
//
// Day 1 sits on row 5 of a Sales tab and row 4 of a Buy tab; the totals row is
// immediately under the last day, and on a Buy tab the projection is under that.
// In a 31-day month this returns exactly the constants that used to be typed
// in — sales totals 36, buy totals 35, buy projection 36.
function _hubRows(date) {
  // Day 0 of next month is the last day of this one: 28, 29, 30 or 31.
  var days = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  var salesLast = 5 + days - 1;
  var buyLast   = 4 + days - 1;
  return {
    days: days,
    salesFirst: 5,
    salesLast: salesLast,        // last day row on a Sales tab
    salesTotal: salesLast + 1,   // 36 in a 31-day month
    buyFirst: 4,
    buyLast: buyLast,            // last day row on a Buy tab
    buyTotal: buyLast + 1,       // 35 in a 31-day month
    buyProj: buyLast + 2         // 36 in a 31-day month
  };
}

// A day array is always 31 long whatever the month, because every consumer
// indexes it by day-1 and several assume a fixed width. The tail of a short
// month is padded with the same value a blank row already produced, so a 30-day
// month is indistinguishable from a 31-day month whose last day is empty.
function _hubPad(arr, fill) {
  while (arr.length < 31) arr.push(fill);
  return arr;
}

function getDashboardData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var date = new Date();
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var monthStr = months[date.getMonth()];
  var yearStr = date.getFullYear().toString().slice(-2);

  var salesSheetName = "Sales " + monthStr + " " + yearStr;
  var buyingSheetName = "Buy " + monthStr + " " + yearStr;

  var salesSheet = ss.getSheetByName(salesSheetName);
  var buyingSheet = ss.getSheetByName(buyingSheetName);

  var R = _hubRows(date);
  var ST = R.salesTotal;   // sales totals row
  var BT = R.buyTotal;     // buying totals row
  var BP = R.buyProj;      // buying projection row

  var data = {};

  // 1. Fetch SALES Data (Your Rings)
  // Row 1 and row 2 are header cells — a percentage and a goal — and do not
  // move with the month. Only the totals row does.
  if (salesSheet) {
    data.ovlRev = salesSheet.getRange("B" + ST).getValue();
    data.ovlGoal = salesSheet.getRange("E2").getValue();
    data.ovlGP = salesSheet.getRange("F" + ST).getValue();
    data.ovlPct = (salesSheet.getRange("E1").getValue() || 0) * 100;
    data.ovlTrackRev = salesSheet.getRange("D" + ST).getValue();
    data.ovlTrackGP = salesSheet.getRange("H" + ST).getValue();
    data.ovlSellMargin = salesSheet.getRange("I" + ST).getValue();

    data.leeRev = salesSheet.getRange("M" + ST).getValue();
    data.leeGoal = salesSheet.getRange("P2").getValue();
    data.leeGP = salesSheet.getRange("Q" + ST).getValue();
    data.leePct = (salesSheet.getRange("P1").getValue() || 0) * 100;
    data.leeTrackRev = salesSheet.getRange("O" + ST).getValue();
    data.leeTrackGP = salesSheet.getRange("S" + ST).getValue();
    data.leeSellMargin = salesSheet.getRange("T" + ST).getValue();

    data.wspRev = salesSheet.getRange("X" + ST).getValue();
    data.wspGoal = salesSheet.getRange("AA2").getValue();
    data.wspGP = salesSheet.getRange("AB" + ST).getValue();
    data.wspPct = (salesSheet.getRange("AA1").getValue() || 0) * 100;
    data.wspTrackRev = salesSheet.getRange("Z" + ST).getValue();
    data.wspTrackGP = salesSheet.getRange("AD" + ST).getValue();
    data.wspSellMargin = salesSheet.getRange("AE" + ST).getValue();

    data.mplRev = salesSheet.getRange("AI" + ST).getValue();
    data.mplGoal = salesSheet.getRange("AL2").getValue();
    data.mplGP = salesSheet.getRange("AM" + ST).getValue();
    data.mplPct = (salesSheet.getRange("AL1").getValue() || 0) * 100;
    data.mplTrackRev = salesSheet.getRange("AK" + ST).getValue();
    data.mplTrackGP = salesSheet.getRange("AO" + ST).getValue();
    data.mplSellMargin = salesSheet.getRange("AP" + ST).getValue();

    data.balRev = salesSheet.getRange("AT" + ST).getValue();
    data.balGoal = salesSheet.getRange("AW2").getValue();
    data.balGP = salesSheet.getRange("AX" + ST).getValue();
    data.balPct = (salesSheet.getRange("AW1").getValue() || 0) * 100;
    data.balTrackRev = salesSheet.getRange("AV" + ST).getValue();
    data.balTrackGP = salesSheet.getRange("AZ" + ST).getValue();
    data.balSellMargin = salesSheet.getRange("BA" + ST).getValue();
  }

  // 2. Fetch BUYING Data
  // ⚠️ BuyVal and BuyProj are ONE ROW APART and both move. Reading BuyVal from
  // the old fixed row in a short month served the projection as the month's
  // takings — a number 26x too big that still looked entirely plausible.
  if (buyingSheet) {
    data.ovlBuyVal = buyingSheet.getRange("C" + BT).getValue();
    data.ovlBuyMargin = buyingSheet.getRange("D" + BT).getValue();
    data.ovlBuyProj = buyingSheet.getRange("C" + BP).getValue();

    data.leeBuyVal = buyingSheet.getRange("H" + BT).getValue();
    data.leeBuyMargin = buyingSheet.getRange("I" + BT).getValue();
    data.leeBuyProj = buyingSheet.getRange("H" + BP).getValue();

    data.wspBuyVal = buyingSheet.getRange("M" + BT).getValue();
    data.wspBuyMargin = buyingSheet.getRange("N" + BT).getValue();
    data.wspBuyProj = buyingSheet.getRange("M" + BP).getValue();

    data.mplBuyVal = buyingSheet.getRange("R" + BT).getValue();
    data.mplBuyMargin = buyingSheet.getRange("S" + BT).getValue();
    data.mplBuyProj = buyingSheet.getRange("R" + BP).getValue();

    data.balBuyVal = buyingSheet.getRange("W" + BT).getValue();
    data.balBuyMargin = buyingSheet.getRange("X" + BT).getValue();
    data.balBuyProj = buyingSheet.getRange("W" + BP).getValue();
  }

  // 3. FETCH THE NEW LEADERBOARD DATA
  if (salesSheet) {
    function cleanMoney(val) {
      if (val === "" || val === "-" || val == null) return null;
      var str = String(val);
      if (str.indexOf('#') > -1) return null;
      var isNeg = str.indexOf('(') > -1 || str.indexOf('-') > -1;
      var num = parseFloat(str.replace(/[^0-9.]/g, ''));
      return isNaN(num) ? null : (isNeg ? -num : num);
    }

    // ⚠️ THE DAY GRID STOPS AT THE LAST DAY OF THE MONTH. Reading a fixed 31
    // rows in a 30-day month pulled the TOTALS row in as day 31 — and because
    // the loop below carries the last seen value forward, one bad row at the
    // end made every store's whole series read as the month total.
    var SD = R.salesFirst, SL = R.salesLast;
    var rng = function (col) { return salesSheet.getRange(col + SD + ':' + col + SL).getValues(); };

    var rawRev = { 'OVL': rng('C'), 'LEE': rng('N'), 'WSP': rng('Y'), 'MPL': rng('AJ'), 'BAL': rng('AU') };
    var rawGP = { 'OVL': rng('G'), 'LEE': rng('R'), 'WSP': rng('AC'), 'MPL': rng('AN'), 'BAL': rng('AY') };
    var rawSales = { 'OVL': rng('B'), 'LEE': rng('M'), 'WSP': rng('X'), 'MPL': rng('AI'), 'BAL': rng('AT') };

    var lbData = { revenue: {}, gp: {}, activeStores: [] };
    var globalLastDay = 0;
    var stores = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];

    stores.forEach(function (store) {
      var lastDayForStore = -1;
      var hasData = false;
      for (var i = 0; i < R.days; i++) {
        var saleVal = cleanMoney(rawSales[store][i][0]);
        if (saleVal !== null) { hasData = true; lastDayForStore = i; }
      }
      if (hasData) {
        lbData.activeStores.push(store);
        if (lastDayForStore > globalLastDay) globalLastDay = lastDayForStore;
      }
    });

    lbData.activeStores.forEach(function (store) {
      var cleanRevArray = [];
      var cleanGPArray = [];
      var lastRev = 0;
      var lastGP = 0;

      for (var i = 0; i < R.days; i++) {
        if (i <= globalLastDay) {
          var revCell = cleanMoney(rawRev[store][i][0]);
          if (revCell !== null) lastRev = revCell;
          cleanRevArray.push(lastRev);

          var gpCell = cleanMoney(rawGP[store][i][0]);
          if (gpCell !== null) lastGP = gpCell;
          cleanGPArray.push(lastGP);
        } else {
          cleanRevArray.push(null);
          cleanGPArray.push(null);
        }
      }
      // A short month's missing days read the same as days not reached yet.
      lbData.revenue[store] = _hubPad(cleanRevArray, null);
      lbData.gp[store] = _hubPad(cleanGPArray, null);
    });

    // Attach Leaderboard data to the main payload!
    data.leaderboard = lbData;
  }

  // Daily arrays so the weekly report can sum any date range
  // Sell: sales sheet, col B/M/X/AI/AT, day 1 = row 5
  // Buy value: buying sheet, col C/H/M/R/W, day 1 = row 4
  var wkSellCols = { OVL: 'B', LEE: 'M', WSP: 'X', MPL: 'AI', BAL: 'AT' };
  var wkBuyCols = { OVL: 'C', LEE: 'H', WSP: 'M', MPL: 'R', BAL: 'W' };
  var _num = function (r) { var n = parseFloat(String(r[0] || 0).replace(/[$,\s]/g, '')); return isNaN(n) ? 0 : n; };
  data.wkSell = {};
  data.wkBuy = {};
  var _allStores = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
  if (salesSheet) {
    _allStores.forEach(function (st) {
      var col = wkSellCols[st];
      data.wkSell[st] = _hubPad(
        salesSheet.getRange(col + R.salesFirst + ':' + col + R.salesLast).getValues().map(_num), 0);
    });
  }
  if (buyingSheet) {
    _allStores.forEach(function (st) {
      var col = wkBuyCols[st];
      data.wkBuy[st] = _hubPad(
        buyingSheet.getRange(col + R.buyFirst + ':' + col + R.buyLast).getValues().map(_num), 0);
    });
  }

  // Daily GP arrays from sales sheet (for weekly sell margin)
  var wkGPCols = { OVL: 'F', LEE: 'Q', WSP: 'AB', MPL: 'AM', BAL: 'AX' };
  data.wkGP = {};
  if (salesSheet) {
    _allStores.forEach(function (st) {
      var col = wkGPCols[st];
      data.wkGP[st] = _hubPad(
        salesSheet.getRange(col + R.salesFirst + ':' + col + R.salesLast).getValues().map(_num), 0);
    });
  }

  // Daily buy margin % arrays from buying sheet (for weekly buy margin)
  var wkBuyMarginCols = { OVL: 'D', LEE: 'I', WSP: 'N', MPL: 'S', BAL: 'X' };
  data.wkBuyMarginPct = {};
  if (buyingSheet) {
    _allStores.forEach(function (st) {
      var col = wkBuyMarginCols[st];
      data.wkBuyMarginPct[st] = _hubPad(
        buyingSheet.getRange(col + R.buyFirst + ':' + col + R.buyLast).getValues()
          .map(function (r) { var n = parseFloat(String(r[0] || 0)); return isNaN(n) ? 0 : n; }), 0);
    });
  }

  // Per-store last-updated timestamps based on Rev/GP changes
  var _p = PropertiesService.getScriptProperties();
  var _prev = JSON.parse(_p.getProperty('prevRevGP') || '{}');
  var _stamps = JSON.parse(_p.getProperty('storeStamps') || '{}');
  var _now = new Date();
  var _mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var _dy = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var _lbl = _dy[_now.getDay()] + ', ' + _mo[_now.getMonth()] + ' ' + _now.getDate();
  ['ovl', 'lee', 'wsp', 'mpl', 'bal'].forEach(function (s) {
    if (_prev[s + 'Rev'] !== undefined) {
      if (String(data[s + 'Rev']) !== String(_prev[s + 'Rev']) || String(data[s + 'GP']) !== String(_prev[s + 'GP'])) {
        _stamps[s] = _lbl;
      }
    }
    data[s + 'BuyDate'] = _stamps[s] || '';
    _prev[s + 'Rev'] = data[s + 'Rev'];
    _prev[s + 'GP'] = data[s + 'GP'];
  });
  _p.setProperty('prevRevGP', JSON.stringify(_prev));
  _p.setProperty('storeStamps', JSON.stringify(_stamps));

  return addGoogleReviews(data);
}
