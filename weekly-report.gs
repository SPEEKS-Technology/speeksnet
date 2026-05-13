// =============================================================================
// SPEEKS WEEKLY REPORT — Google Apps Script
// =============================================================================
// SETUP (one-time):
//   1. Go to script.google.com and create a new project.
//   2. Paste the entire contents of this file into the editor.
//   3. Run createWeeklyTrigger() once (click the function name → Run).
//   4. Authorize when Google prompts you.
//   5. The report will now email automatically every Monday at 8 AM.
//
// To test the full last-week report: run sendWeeklyReport() manually.
// To test with May 11–12 only:       run sendTestReport() manually.
// =============================================================================

var REPORT_EMAIL = 'ethan.kushnir@speekstechnology.com';
var STORES       = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];

// Update these to match your actual store locations
var STORE_NAMES = {
  OVL: 'Overland Park',
  LEE: "Lee's Summit",
  WSP: 'Westport',
  MPL: 'Maplewood',
  BAL: 'Ballwin'
};

var STORE_COLORS = {
  OVL: '#7c3aed',
  LEE: '#2563eb',
  WSP: '#16a34a',
  MPL: '#ea580c',
  BAL: '#dc2626'
};

// Same endpoints Speeksnet uses
var HUB_URL          = 'https://script.google.com/macros/s/AKfycbw3Ms5nc2bhbrjVW-da3xbZ3vKhyBx2TpeR-eSd1L05ZhV-h2Yh0yLmIV_E7TWDmwM69A/exec';
var GOALS_API_URL    = 'https://script.google.com/macros/s/AKfycbw_eV-2Nxizf85J8atBJ6Muyq0aOAjZAsSLwlx9abPjNKJub_RlzrMBKkQuTbcRTbF2/exec';
var SCORECARD_URL    = 'https://script.google.com/macros/s/AKfycbwvelWpXnlXCJZQGagZX5llMCN1k6CjronBpIcenNVDTjUdPISjF0mYhHYy2ry0Vdg0_Q/exec';
var WEEKLY_KPI_URL   = 'https://script.google.com/macros/s/AKfycbyVBos-uJuhaqfLMBqoz9byNkvUG06igl4RX2_cs8hH15rbp7K4uFFEN-wpQgS2ChAU/exec';

// =============================================================================
// TRIGGER SETUP — run this function once
// =============================================================================
function createWeeklyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'sendWeeklyReport') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendWeeklyReport')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .create();
  Logger.log('Trigger created: sendWeeklyReport every Monday at 8 AM.');
}

// =============================================================================
// ENTRY POINTS
// =============================================================================
function sendWeeklyReport() {
  var week = getLastWeekRange();
  runReport(week);
}

// TEST: sends report covering only May 11–12, 2026
function sendTestReport() {
  var week = {
    start:    new Date(2026, 4, 11), // May 11 (months 0-indexed)
    end:      new Date(2026, 4, 12), // May 12
    startStr: '2026-05-11',
    endStr:   '2026-05-12'
  };
  runReport(week);
}

function runReport(week) {
  var weekLabel = fmtDate(week.start, 'short') + ' - ' + fmtDate(week.end, 'short-year');
  Logger.log('Building report for: ' + weekLabel);

  var hubData      = fetchJSON(HUB_URL);
  var scorecardRes = fetchJSON(SCORECARD_URL);

  var goalsData = {};
  STORES.forEach(function(store) {
    var d = fetchJSON(GOALS_API_URL + '?store=' + store);
    goalsData[store] = Array.isArray(d) ? d : [];
    Logger.log(store + ' goals records: ' + goalsData[store].length);
    goalsData[store].slice(0, 3).forEach(function(r) {
      Logger.log('  sample date: "' + r.date + '"');
    });
  });

  // Fetch weekly KPI per store and find the "store total" row
  var weeklyKpi = {};
  STORES.forEach(function(store) {
    var d = fetchJSON(WEEKLY_KPI_URL + '?store=' + store + '&time=4-Week');
    if (!Array.isArray(d)) { weeklyKpi[store] = null; return; }
    var idx = -1;
    for (var i = d.length - 1; i >= 0; i--) {
      var lbl = String(d[i][0] || '').trim().toLowerCase();
      if (lbl === 'store' || lbl === 'store total') { idx = i; break; }
    }
    var row = idx !== -1 ? d[idx] : null;
    weeklyKpi[store] = row;
    // Log ALL non-empty values with their index so we can identify sell columns
    if (row) {
      var cols = [];
      for (var j = 0; j < row.length; j++) {
        if (row[j] !== null && row[j] !== undefined && row[j] !== '') {
          cols.push('[' + j + ']=' + row[j]);
        }
      }
      Logger.log(store + ' weekly total row: ' + cols.join(', '));
    } else {
      Logger.log(store + ' weekly total row: NOT FOUND');
    }
  });

  var result = buildEmail(weekLabel, week, hubData, scorecardRes, goalsData, weeklyKpi);

  GmailApp.sendEmail(
    REPORT_EMAIL,
    'Speeks Weekly Report - ' + weekLabel,
    'Your email client does not support HTML email. Please view in Gmail or Outlook.',
    { htmlBody: result.html, name: 'Speeks Reports' }
  );

  Logger.log('Report sent to ' + REPORT_EMAIL);
}

// =============================================================================
// DATE HELPERS
// =============================================================================
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function toYMD(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// Robust date parser that handles multiple formats WITHOUT timezone shift.
// new Date("2026-05-11") is parsed as UTC midnight and shifts to the prior
// day in US timezones — this function avoids that entirely.
function parseGoalDate(str) {
  if (!str) return null;
  var s = String(str).trim();

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    var p = s.substring(0, 10).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  // M/D/YYYY or MM/DD/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) {
    var p = s.split('/');
    return new Date(+p[2], +p[0] - 1, +p[1]);
  }
  // M/D/YY
  if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(s)) {
    var p = s.split('/');
    return new Date(2000 + +p[2], +p[0] - 1, +p[1]);
  }
  // Fallback (may have timezone issues, but better than nothing)
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function getLastWeekRange() {
  var now = new Date();
  var day = now.getDay(); // 0=Sun 1=Mon
  var daysToSunday = day === 0 ? 7 : day;

  // Construct via year/month/day to stay in local time, no UTC shift
  var endD = now.getDate() - daysToSunday;
  var end   = new Date(now.getFullYear(), now.getMonth(), endD);
  var start = new Date(now.getFullYear(), now.getMonth(), endD - 6);

  return { start: start, end: end, startStr: toYMD(start), endStr: toYMD(end) };
}

function fmtDate(date, style) {
  var opts = { month: 'short', day: 'numeric' };
  if (style === 'short-year') opts.year = 'numeric';
  return date.toLocaleDateString('en-US', opts);
}

// =============================================================================
// DATA HELPERS
// =============================================================================
function fetchJSON(url) {
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    return JSON.parse(res.getContentText());
  } catch(e) {
    Logger.log('fetchJSON error [' + url + ']: ' + e.message);
    return null;
  }
}

function parseNum(val) {
  if (val === null || val === undefined || val === '') return 0;
  var n = parseFloat(String(val).replace(/[$,%\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function normalizePct(val) {
  var n = parseNum(val);
  // Values like 0.78 → 78%, values already like 78 stay as-is
  if (n > 0 && n <= 1.5) n = n * 100;
  return n;
}

function getStoreScore(scorecardRes, store) {
  if (!scorecardRes || !scorecardRes.success || !Array.isArray(scorecardRes.data)) return null;
  return scorecardRes.data.find(function(item) {
    return String(item.store || '').toUpperCase() === store;
  }) || null;
}

// Filters goals records to only those within the week range using string comparison
// so timezone issues can't cause off-by-one date errors.
function getWeeklyGoals(goalsArr, week) {
  var totalGoal = 0, totalResult = 0;
  var employeeMap = {};

  goalsArr.forEach(function(r) {
    var d = parseGoalDate(r.date);
    if (!d) return;
    var dStr = toYMD(d);
    if (dStr < week.startStr || dStr > week.endStr) return;

    var g   = parseInt(r.goal)   || 0;
    var res = parseInt(r.result) || 0;
    totalGoal   += g;
    totalResult += res;

    var emp = String(r.employee || 'Unknown').trim();
    if (!employeeMap[emp]) employeeMap[emp] = { goal: 0, result: 0 };
    employeeMap[emp].goal   += g;
    employeeMap[emp].result += res;
  });

  return { totalGoal: totalGoal, totalResult: totalResult, employees: employeeMap };
}

// =============================================================================
// EMAIL BUILDER
// =============================================================================
function buildEmail(weekLabel, week, hubData, scorecardRes, goalsData, weeklyKpi) {
  var storeSections = '';

  STORES.forEach(function(store) {
    var s     = store.toLowerCase();
    var color = STORE_COLORS[store];

    // ── MTD data from Hub ──────────────────────────────────────────────────
    var buyVal    = hubData ? parseNum(hubData[s + 'BuyVal'])    : 0;
    var buyMargin = hubData ? normalizePct(hubData[s + 'BuyMargin']) : 0;
    var rev        = hubData ? parseNum(hubData[s + 'Rev'])   : 0;
    var gp         = hubData ? parseNum(hubData[s + 'GP'])    : 0;
    var sellMargin = hubData ? normalizePct(hubData[s + 'SellMargin']) : 0;
    if (sellMargin === 0 && rev > 0) sellMargin = (gp / rev) * 100;
    var pct     = hubData ? normalizePct(hubData[s + 'Pct']) : 0;
    pct = Math.round(pct);
    var goal    = hubData ? parseNum(hubData[s + 'Goal'])    : 0;
    var trackGP = hubData ? parseNum(hubData[s + 'TrackGP']) : 0;

    // ── Weekly data from Weekly KPI ────────────────────────────────────────
    // Confirmed: [2]=buyVal, [5]=buyMargin.
    // Sell indices are logged — update WEEKLY_SELL_IDX / WEEKLY_SELL_MARGIN_IDX
    // once you verify from the Apps Script execution log which index is correct.
    var WEEKLY_SELL_IDX        = -1; // TODO: set once confirmed from logs
    var WEEKLY_SELL_MARGIN_IDX = -1; // TODO: set once confirmed from logs

    var wRow        = weeklyKpi[store];
    var wBuyVal     = wRow ? parseNum(wRow[2]) : 0;
    var wBuyMargin  = wRow ? normalizePct(wRow[5]) : 0;
    var wSellVal    = (wRow && WEEKLY_SELL_IDX >= 0)        ? parseNum(wRow[WEEKLY_SELL_IDX])        : null;
    var wSellMargin = (wRow && WEEKLY_SELL_MARGIN_IDX >= 0) ? normalizePct(wRow[WEEKLY_SELL_MARGIN_IDX]) : null;

    // Scorecard
    var storeScore = getStoreScore(scorecardRes, store);
    var rawScore   = storeScore ? parseFloat(storeScore.score) : null;
    var scoreDisp  = rawScore !== null ? (rawScore * 2).toFixed(1) : 'N/A';
    var scoreColor = rawScore === null ? '#94a3b8'
                   : rawScore * 2 > 8  ? '#059669'
                   : rawScore * 2 >= 6 ? '#d97706' : '#dc2626';

    // Listing goals (filtered to this exact week)
    var goals      = getWeeklyGoals(goalsData[store] || [], week);
    var goalPct    = goals.totalGoal > 0 ? Math.round((goals.totalResult / goals.totalGoal) * 100) : 0;
    var goalsColor = goalPct >= 100 ? '#059669' : goalPct >= 80 ? '#d97706' : '#dc2626';

    // Colors
    var pctColor        = pct >= 100 ? '#059669' : pct >= 80 ? '#d97706' : '#dc2626';
    var buyMarginColor  = buyMargin >= 51 ? '#059669' : '#dc2626';
    var sellMarginColor = sellMargin >= 40 ? '#059669' : sellMargin >= 30 ? '#d97706' : '#dc2626';

    // Scorecard bucket breakdown rows
    var bucketHtml = '';
    if (storeScore && Array.isArray(storeScore.buckets)) {
      storeScore.buckets.forEach(function(bucket) {
        if (!Array.isArray(bucket.categories) || bucket.categories.length === 0) return;
        var bAvg      = (parseFloat(bucket.avg || 0) * 2).toFixed(1);
        var bAvgColor = parseFloat(bAvg) >= 8 ? '#059669' : parseFloat(bAvg) >= 6 ? '#d97706' : '#dc2626';
        bucketHtml += td2(
          '<span style="font-size:11px;font-weight:800;color:#1e293b;">' + escHtml(bucket.label) + '</span>',
          '<span style="font-size:11px;font-weight:900;color:' + bAvgColor + ';">' + bAvg + '/10</span>',
          'background:#f8fafc;'
        );
        bucket.categories.forEach(function(cat) {
          var cs    = (parseFloat(cat.score || 0) * 2).toFixed(1);
          var csCol = parseFloat(cs) >= 8 ? '#059669' : parseFloat(cs) >= 6 ? '#d97706' : '#dc2626';
          bucketHtml += td2(
            '<span style="font-size:10px;color:#475569;padding-left:12px;">' + escHtml(cat.name) + '</span>',
            '<span style="font-size:10px;font-weight:900;color:' + csCol + ';">' + cs + '/10</span>',
            ''
          );
        });
      });
    } else {
      bucketHtml = '<tr><td colspan="2" style="padding:10px 14px;font-size:11px;color:#94a3b8;text-align:center;">No scorecard submitted this week.</td></tr>';
    }

    // Per-employee listing rows
    var empRows  = '';
    var empNames = Object.keys(goals.employees).sort();
    if (empNames.length > 0) {
      empNames.forEach(function(emp) {
        var e    = goals.employees[emp];
        var ePct = e.goal > 0 ? Math.round((e.result / e.goal) * 100) : 0;
        var eCol = ePct >= 100 ? '#059669' : ePct >= 80 ? '#d97706' : '#dc2626';
        empRows += td2(
          '<span style="font-size:10px;color:#1e293b;font-weight:700;">' + escHtml(emp) + '</span>',
          '<span style="font-size:10px;font-weight:900;color:' + eCol + ';">' + e.result + '/' + e.goal + ' (' + ePct + '%)</span>',
          ''
        );
      });
    } else {
      empRows = '<tr><td colspan="2" style="padding:10px 14px;font-size:11px;color:#94a3b8;text-align:center;">No listing data recorded for this period.</td></tr>';
    }

    storeSections += [
      '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">',

      // Store header bar — solid color bg, white text (works in all email clients)
      '<tr><td style="background-color:' + color + ';padding:14px 18px;">',
      '<table width="100%" cellpadding="0" cellspacing="0"><tr>',
      '<td>',
      '<div style="color:#ffffff;font-size:20px;font-weight:900;letter-spacing:1px;">' + store + '</div>',
      '<div style="color:rgba(255,255,255,0.75);font-size:12px;">' + escHtml(STORE_NAMES[store] || '') + '</div>',
      '</td>',
      '<td align="right">',
      '<div style="color:rgba(255,255,255,0.75);font-size:10px;font-weight:700;text-transform:uppercase;">Score</div>',
      '<div style="color:#ffffff;font-size:24px;font-weight:900;line-height:1.1;">' + scoreDisp + '/10</div>',
      '</td>',
      '</tr></table></td></tr>',

      // ── This Week row ──────────────────────────────────────────────────────
      '<tr><td style="padding:0;border-bottom:1px solid #e2e8f0;">',
      '<table width="100%" cellpadding="0" cellspacing="0">',
      '<tr><td colspan="4" style="padding:5px 14px 3px;background-color:#1e293b;">',
      '<span style="font-size:9px;font-weight:800;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:1px;">This Week</span>',
      '</td></tr>',
      '<tr>',
      metricCell('Bought',
        wBuyVal > 0 ? '$' + Math.round(wBuyVal).toLocaleString() : '—',
        wBuyVal > 0 ? 'Margin: ' + wBuyMargin.toFixed(1) + '%' : 'No data',
        wBuyMargin >= 51 ? '#059669' : '#dc2626', true),
      metricCell('Sold',
        wSellVal !== null ? '$' + Math.round(wSellVal).toLocaleString() : 'Check logs',
        wSellVal !== null ? 'Margin: ' + (wSellMargin || 0).toFixed(1) + '%' : 'Index TBD',
        '#94a3b8', true),
      metricCell('Listings (Week)', goals.totalResult + '/' + goals.totalGoal,
        goalPct + '% of goal', goalsColor, true),
      metricCell('% to Goal (MTD)', pct + '%',
        'Goal: $' + Math.round(goal).toLocaleString(), pctColor, false),
      '</tr></table></td></tr>',

      // ── MTD row ────────────────────────────────────────────────────────────
      '<tr><td style="padding:0;border-bottom:1px solid #e2e8f0;">',
      '<table width="100%" cellpadding="0" cellspacing="0">',
      '<tr><td colspan="4" style="padding:5px 14px 3px;background-color:#f8fafc;">',
      '<span style="font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">Month to Date</span>',
      '</td></tr>',
      '<tr>',
      metricCell('Buy Value',    '$' + Math.round(buyVal).toLocaleString(), 'Margin: ' + buyMargin.toFixed(1) + '%',      buyMarginColor,  true),
      metricCell('Sell Revenue', '$' + Math.round(rev).toLocaleString(),    'GP Margin: ' + sellMargin.toFixed(1) + '%', sellMarginColor, true),
      metricCell('Tracked GP',   '$' + Math.round(trackGP).toLocaleString(), 'of $' + Math.round(goal).toLocaleString() + ' goal', '#475569', true),
      metricCell('Gross Profit', '$' + Math.round(gp).toLocaleString(),     sellMargin.toFixed(1) + '% margin', sellMarginColor, false),
      '</tr></table></td></tr>',


      sectionHeader('Scorecard Breakdown'),
      '<tr><td style="background-color:#ffffff;"><table width="100%" cellpadding="0" cellspacing="0">' + bucketHtml + '</table></td></tr>',

      sectionHeader('Listing Goals — ' + week.startStr + ' to ' + week.endStr),
      '<tr><td style="background-color:#ffffff;"><table width="100%" cellpadding="0" cellspacing="0">' + empRows + '</table></td></tr>',

      '</table>'
    ].join('');
  });

  // At-a-glance summary rows
  var summaryRows = '';
  STORES.forEach(function(store) {
    var s     = store.toLowerCase();
    var color = STORE_COLORS[store];

    var pct      = hubData ? Math.round(normalizePct(hubData[s + 'Pct'])) : 0;
    var pctColor = pct >= 100 ? '#059669' : pct >= 80 ? '#d97706' : '#dc2626';

    var storeScore = getStoreScore(scorecardRes, store);
    var rawScore   = storeScore ? parseFloat(storeScore.score) : null;
    var scoreDisp  = rawScore !== null ? (rawScore * 2).toFixed(1) : 'N/A';
    var scoreColor = rawScore === null ? '#94a3b8'
                   : rawScore * 2 > 8  ? '#059669'
                   : rawScore * 2 >= 6 ? '#d97706' : '#dc2626';

    var goals   = getWeeklyGoals(goalsData[store] || [], week);
    var goalPct = goals.totalGoal > 0 ? Math.round((goals.totalResult / goals.totalGoal) * 100) : 0;
    var goalCol = goalPct >= 100 ? '#059669' : goalPct >= 80 ? '#d97706' : '#dc2626';

    var wRow      = weeklyKpi[store];
    var wBuyVal   = wRow ? parseNum(wRow[2]) : 0;
    var wBuyDisp  = wBuyVal > 0 ? '$' + Math.round(wBuyVal).toLocaleString() : '—';

    summaryRows += [
      '<tr>',
      '<td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;">',
      '<span style="display:inline-block;background-color:' + color + ';color:#ffffff;font-size:11px;font-weight:900;padding:2px 8px;border-radius:4px;">' + store + '</span>',
      '</td>',
      '<td align="center" style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:900;color:' + scoreColor + ';">' + scoreDisp + '/10</td>',
      '<td align="center" style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:900;color:' + pctColor + ';">' + pct + '%</td>',
      '<td align="center" style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:900;color:#1e293b;">' + wBuyDisp + '</td>',
      '<td align="center" style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:900;color:' + goalCol + ';">' + goals.totalResult + '/' + goals.totalGoal + '</td>',
      '</tr>'
    ].join('');
  });

  var sentAt = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long',
    day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  });

  var html = [
    '<!DOCTYPE html><html><head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1.0">',
    '</head>',
    '<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">',
    '<div style="max-width:640px;margin:0 auto;padding:24px 12px;">',

    // Header — white bg, dark text (renders correctly in all clients including Outlook)
    '<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;border:1px solid #e2e8f0;border-top:5px solid #1e293b;margin-bottom:24px;">',
    '<tr><td style="padding:28px 24px;text-align:center;">',
    '<div style="color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px;">Speeks Technology</div>',
    '<div style="color:#1e293b;font-size:26px;font-weight:900;margin-bottom:6px;">Weekly Performance Report</div>',
    '<div style="color:#475569;font-size:14px;font-weight:600;">' + weekLabel + '</div>',
    '</td></tr></table>',

    // At a Glance
    '<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:28px;overflow:hidden;">',
    '<tr><td style="padding:12px 14px;background-color:#f8fafc;border-bottom:1px solid #e2e8f0;">',
    '<span style="font-size:12px;font-weight:800;color:#1e293b;text-transform:uppercase;letter-spacing:0.5px;">At a Glance</span>',
    '</td></tr>',
    '<tr><td style="padding:0;">',
    '<table width="100%" cellpadding="0" cellspacing="0">',
    '<tr style="background-color:#f8fafc;">',
    '<th style="padding:8px 12px;text-align:left;font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;border-bottom:1px solid #e2e8f0;">Store</th>',
    '<th style="padding:8px 12px;text-align:center;font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;border-bottom:1px solid #e2e8f0;">Score</th>',
    '<th style="padding:8px 12px;text-align:center;font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;border-bottom:1px solid #e2e8f0;">% to Goal</th>',
    '<th style="padding:8px 12px;text-align:center;font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;border-bottom:1px solid #e2e8f0;">Wk Buy</th>',
    '<th style="padding:8px 12px;text-align:center;font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;border-bottom:1px solid #e2e8f0;">Listings</th>',
    '</tr>',
    summaryRows,
    '</table></td></tr></table>',

    // Store breakdown cards
    '<div style="font-size:11px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;">Store Breakdowns</div>',
    storeSections,

    // Footer
    '<div style="text-align:center;padding:16px 0;color:#94a3b8;font-size:10px;">',
    'Generated automatically by Speeks &middot; ' + sentAt,
    '<br><span style="font-size:9px;color:#cbd5e1;">Buy/Sell/Goal figures are month-to-date. Listing goals filtered to the report week.</span>',
    '</div>',

    '</div></body></html>'
  ].join('');

  return { html: html };
}

// =============================================================================
// HTML HELPERS
// =============================================================================
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function metricCell(label, value, sub, subColor, borderRight) {
  var border = borderRight ? 'border-right:1px solid #e2e8f0;' : '';
  return [
    '<td style="' + border + 'padding:12px 8px;text-align:center;width:25%;background-color:#f8fafc;">',
    '<div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;">' + escHtml(label) + '</div>',
    '<div style="font-size:15px;font-weight:900;color:#1e293b;">' + escHtml(value) + '</div>',
    '<div style="font-size:10px;font-weight:700;color:' + subColor + ';margin-top:2px;">' + escHtml(sub) + '</div>',
    '</td>'
  ].join('');
}

function sectionHeader(title) {
  return [
    '<tr><td style="padding:8px 14px;background-color:#f8fafc;',
    'border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;',
    'font-size:9px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">',
    escHtml(title),
    '</td></tr>'
  ].join('');
}

function td2(left, right, extraStyle) {
  return [
    '<tr style="' + extraStyle + '">',
    '<td style="padding:5px 14px;border-bottom:1px solid #f8fafc;background-color:#ffffff;">' + left + '</td>',
    '<td style="padding:5px 14px;border-bottom:1px solid #f8fafc;text-align:right;background-color:#ffffff;">' + right + '</td>',
    '</tr>'
  ].join('');
}
