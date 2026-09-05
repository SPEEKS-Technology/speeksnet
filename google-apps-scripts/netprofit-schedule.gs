// ============================================================================
// netprofit-schedule.gs — run the NET PROFIT tab on a schedule.
//
// THREE TRIGGERS on two functions, from the CFO's rules (2026-08-27, split into
// a morning and an afternoon pass 2026-09-02):
//
//   npsDailyRefresh   8:00am AND 2:00pm Central, every day
//                     Rewrites the WHOLE current month to date, not just
//                     yesterday. A day is not final the next morning: 81% of
//                     shipping labels post +1 day and 13% post +2-3 days, so
//                     the month keeps moving behind you. This is the same
//                     month-to-date sweep the Sales Summary already does.
//                     The 8am pass writes every column EXCEPT shipping, so
//                     there is a rough Net Profit to read first thing; the 2pm
//                     pass adds shipping once the day's labels are bought.
//
//   npsMonthClose     7:00pm Central, every day — but it ACTS on one day a
//                     month and logs "not today" on the rest.
//                     The month closes at 7pm on the 1st, giving the stores
//                     that day to ship what sold on the last day of the month.
//                     Never on a day the stores are shut: they buy ZERO labels
//                     on a Sunday (0 of 2,403 in July) and close for
//                     Thanksgiving, Christmas and New Year's Day. Otherwise it
//                     slips to the first eligible business day.
//
// ⚠️ AFTER THE CLOSE, NOTHING RE-OPENS THE MONTH. The daily refresh only ever
// touches the CURRENT month, so a closed month is never rewritten — that is
// what makes the figure safe to pay a bonus on. Anything that arrives late
// books to the day it was charged, in the new month, which the collector does
// on its own side (shippingBookingDay).
//
// ⚠️ THE CLOSE CALENDAR LIVES IN TWO PLACES and they must never drift: here,
// because the trigger has to know whether to run before it calls anything, and
// in netprofit-collect, because the collector has to know where to book a late
// charge. Every close run asks the collector what date IT thinks the month
// closes on and REFUSES to write if the two disagree. A silent disagreement
// would put a charge in one month and the close in another.
//
// TO INSTALL: paste into the Apps Script project alongside netprofit-sheet.gs,
// then Run -> npsInstallTriggers once. Run -> npsStatus to see what is armed
// and when the next close is. npsRemoveTriggers takes them all off again.
//
// Prefixed NPS_/_nps: one Apps Script project is one global scope.
// ============================================================================

var NPS_TZ = 'America/Chicago';
// ⚠️ TWO REFRESHES A DAY, AND THE DIFFERENCE IS SHIPPING.
//
// Everything on this sheet except shipping cost is known as soon as the day's
// orders settle. Shipping is not: PayMore buys the previous day's labels through
// the morning, so a figure read at 8am is partial and only settles by early
// afternoon. Running once at 2pm made every other column wait for the one that
// could not be hurried, and the whole month read a day stale until mid-afternoon
// — which is no use to somebody looking at it over coffee.
//
// So the same refresh runs twice. The morning pass fills Sales, Cost, eBay Fee
// and Credit Card Fee for the whole month to date and takes whatever shipping
// exists so far; the 2pm pass rewrites the lot once the labels are done.
//
// ⚠️ THE MORNING PASS DOES NOT WRITE SHIPPING AT ALL. It sets NP_SKIP_SHIP and
// the writer leaves that one column exactly as it found it.
//
// The first version of this wrote whatever shipping existed at 8am, on the
// argument that the tab's NP formula SUBTRACTS the shipping cell and a blank
// cell is arithmetic zero — so skipping it would overstate Net Profit by the
// whole day's shipping. That argument is sound in general and wrong here, and
// the stores are why: PayMore buys essentially no labels before 9am. At 8am
// yesterday's shipping is genuinely near zero, so the blank cell is not a hole
// where a cost should be — it is the correct figure for that hour. Writing a
// partial number instead would not be more accurate, only more confident, and
// it would put a figure in front of somebody that looks final and is not.
//
// ⚠️ SKIPPED, NOT CLEARED — and this is what makes it safe. Every earlier day in
// the month already holds final shipping from a previous 2pm pass, and skipping
// the column leaves all of it alone. Only the newest day sits empty, and only
// until 2pm. Read NP_SKIP_SHIP in netprofit-sheet.gs before changing this.
//
// ⚠️ THE MORNING NUMBER IS ROUGH BY DESIGN AND ONLY FOR THE MOST RECENT DAY.
// Every earlier day already has final shipping, so only yesterday's row moves
// at 2pm — and it moves DOWN, because shipping only ever gets added.
var NPS_MORNING_HOUR = 8;  // 8am — everything except shipping
var NPS_DAILY_HOUR = 14;   // 2pm — Apps Script fires within the hour, never before
var NPS_CLOSE_HOUR = 19;   // 7pm
var NPS_LAST_CLOSED_KEY = 'NPS_LAST_CLOSED_MONTH';

// ---------------------------------------------------------------------------
// The close calendar. Mirrors monthCloseDay() in netprofit-collect/index.ts.
// ---------------------------------------------------------------------------

// Of the three closures only New Year's Day can ever land on a close: the 1st
// and 2nd of a month are the only candidates, and neither Thanksgiving (4th
// Thursday of November) nor Christmas can fall there. December therefore
// always closes on Jan 2 at the earliest.
function _npsIsStoreHoliday(y, m0, day) {
  if (m0 === 0 && day === 1) return "New Year's Day";
  if (m0 === 11 && day === 25) return 'Christmas';
  if (m0 === 10) {
    var first = new Date(Date.UTC(y, 10, 1)).getUTCDay();
    if (day === 1 + ((4 - first + 7) % 7) + 21) return 'Thanksgiving';
  }
  return null;
}

// ym is the month being closed, "2026-07". Returns { date: 'YYYY-MM-DD', why: [] }.
function _npsMonthCloseDay(ym) {
  var y = Number(ym.slice(0, 4));
  var m0 = Number(ym.slice(5, 7)) - 1;
  var ny = m0 === 11 ? y + 1 : y;
  var nm0 = (m0 + 1) % 12;
  var why = [];
  for (var day = 1; day < 15; day++) {
    var dow = new Date(Date.UTC(ny, nm0, day)).getUTCDay();
    if (dow === 0) { why.push(_npsIso(ny, nm0, day) + ' is a Sunday — no shipping'); continue; }
    var hol = _npsIsStoreHoliday(ny, nm0, day);
    if (hol) { why.push(_npsIso(ny, nm0, day) + ' is ' + hol); continue; }
    return { date: _npsIso(ny, nm0, day), why: why };
  }
  throw new Error('no eligible close day found for ' + ym);
}

function _npsIso(y, m0, day) {
  return y + '-' + ('0' + (m0 + 1)).slice(-2) + '-' + ('0' + day).slice(-2);
}

// Today, in the STORES' calendar. The script's own timezone is not necessarily
// Central and a 7pm run must not land on tomorrow's date.
function _npsToday() {
  return Utilities.formatDate(new Date(), NPS_TZ, 'yyyy-MM-dd');
}

function _npsPrevMonth(ymd) {
  var y = Number(ymd.slice(0, 4)), m0 = Number(ymd.slice(5, 7)) - 1;
  var py = m0 === 0 ? y - 1 : y, pm0 = (m0 + 11) % 12;
  return py + '-' + ('0' + (pm0 + 1)).slice(-2);
}

function _npsLastDayOf(ym) {
  var y = Number(ym.slice(0, 4)), m0 = Number(ym.slice(5, 7)) - 1;
  return _npsIso(y, m0, new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate());
}

// ---------------------------------------------------------------------------
// The two scheduled entry points
// ---------------------------------------------------------------------------

function npsDailyRefresh() {
  var npsT0 = new Date().getTime();
  var today = _npsToday();
  var ym = today.slice(0, 7);
  NP_FROM = ym + '-01';
  NP_TO = today;
  // Which pass this is, so a log or a failure email says whether the shipping
  // in it was final. The hour is read from the clock rather than passed in,
  // because a time-based trigger cannot pass an argument.
  var hour = Number(Utilities.formatDate(new Date(), NPS_TZ, 'H'));
  var morning = hour < NPS_DAILY_HOUR;
  var pass = morning ? 'MORNING (shipping not written yet)' : '2PM (shipping final)';
  // ⚠️ A GLOBAL, AND IT MUST BE SET ON EVERY RUN — not just the morning one.
  // One Apps Script project is one global scope and it survives between
  // executions of the same script instance. Setting it only in the morning
  // branch would leave it true, and the 2pm pass would then skip shipping too:
  // the column would never be written again, by anything, and Net Profit would
  // read high for the rest of the month with nothing to show why.
  NP_SKIP_SHIP = morning;
  Logger.log('=== DAILY REFRESH %s [%s] — month to date %s .. %s ===',
    today, pass, NP_FROM, NP_TO);

  // ⚠️ EVERY FAILURE PATH IN THIS FILE LOGS A LINE AND RETURNS, AND NOBODY
  // READS APPS SCRIPT LOGS. Wrapped so a throw reaches a person instead of a
  // log nobody opens — an unattended job that fails politely is
  // indistinguishable from one that never ran.
  try {
    // A new month has no tab until something makes one. Left manual, the first
    // run of every month would find nothing, log "no tab" and write
    // nothing — and keep doing that, quietly, until somebody noticed the month
    // was empty. Rolling here happens when it is needed and cannot fire early.
    if (!_npsEnsureTab(ym)) {
      _npaSendFailure('The ' + pass.split(' ')[0].toLowerCase() + ' Net Profit refresh',
        'No tab "' + _npTabName(ym) + '", and no previous month to roll forward from.',
        'You — run npRollStatus to see what tabs exist, then npRollApply, or create '
          + 'the month by hand. Nothing is being recorded for ' + ym + ' until it exists.');
      return;
    }

    // Snapshot BEFORE the write, so the alert can tell a figure that MOVED from
    // one being filled for the first time. Filling a day is not a change.
    var before = _npaSnapshot(ym);

    _npWrite(false);
    // The summary strip second, always: Days Thru is DERIVED from the last day
    // carrying Sales, so running it before the grid is written would measure
    // yesterday's sheet and leave every Tracking figure a day behind.
    //
    // ⚠️ HAND IT WHAT IS ACTUALLY LEFT OF THE SIX MINUTES. _npWrite has already
    // spent some, and its share grows with every day added to the month, so a
    // fixed budget that is generous on the 2nd is fatal on the 30th. Whatever
    // remains after this is for the summary's batch write and its colour rules,
    // which are fast but not free — hence 5 minutes rather than 6.
    NPX_BUDGET_MS = Math.max(30000, 300000 - (new Date().getTime() - npsT0));
    _npxSync(false);
    _npaReport(before, ym, pass.split(' ')[0].toLowerCase() + ' daily refresh');

    // The SALES tab's YoY block — the one thing in this workbook that no job
    // owned, and which therefore compared September 2026 against August 2025 for
    // three days. See sales-yoy.gs; the figures come from the same NPX_YOY_2025
    // this run has already used for the Net Profit tab, so the two tabs cannot
    // disagree about a store's year-over-year again.
    //
    // ⚠️ ITS OWN try/catch, AND AFTER THE REPORT. Net Profit is what this job
    // exists for and it is finished by here; a Sales tab whose labels moved must
    // not take the day's net profit down with it. It writes only cells that
    // differ, so on every day but the 1st this is a read and nothing else.
    try {
      _syoySync(false, ym);
    } catch (yoyErr) {
      Logger.log('!! the Sales tab YoY pass failed: %s', yoyErr);
      _npaSendFailure('The Sales tab year-over-year figures',
        String(yoyErr && yoyErr.stack ? yoyErr.stack : yoyErr),
        'Claude — the Net Profit tab is fine and its YoY is right; it is the SALES tab that '
          + 'is now comparing itself against whatever month the rollover copied. Run '
          + 'salesYoyPreview() to see what it found, and salesYoyAudit() to check the other '
          + 'months while you are there.');
    }

    Logger.log('Daily refresh done. The current month stays open; it closes at 7pm on %s.',
      _npsMonthCloseDay(ym).date);
  } catch (e) {
    _npaSendFailure('The ' + pass.split(' ')[0].toLowerCase() + ' Net Profit refresh', String(e && e.stack ? e.stack : e),
      'Claude — send this email on. The next run rewrites the whole month to '
        + 'date, so one missed run usually repairs itself; two in a row does not.');
    throw e;   // still fail loudly in the execution log
  }
}

function npsMonthClose() {
  var today = _npsToday();
  var target = _npsPrevMonth(today);          // the month we would be closing
  var close = _npsMonthCloseDay(target);

  if (today !== close.date) {
    Logger.log('Not the close day. %s closes on %s%s. Nothing written.',
      target, close.date, close.why.length ? ' (' + close.why.join('; ') + ')' : '');
    return;
  }

  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(NPS_LAST_CLOSED_KEY) === target) {
    Logger.log('%s is already closed. Refusing to rewrite a closed month — that is '
      + 'the figure the bonus was paid on. Nothing written.', target);
    return;
  }

  // ⚠️ The collector has its own copy of this calendar. If the two ever
  // disagree, a late charge lands in a month whose close was decided on a
  // different date, and no total ties. Refuse rather than guess.
  // ⚠️ NO TAB, NO CLOSE. From 2026-09 each month has its own tab, and a month
  // with none was never on the record — August is exactly that: the tab held
  // July all along and August is deliberately being skipped (user, 2026-08-28).
  // Without this the close would fall back to whatever tab it could find and
  // write a full month of August figures over the live month.
  var closeTab = SpreadsheetApp.openById(NP_SHEET_ID)
    .getSheetByName(_npTabName(target));
  if (!closeTab) {
    Logger.log('No tab "%s" — %s was never kept, so there is nothing to close. '
      + 'Marking it closed so this stops asking.', _npTabName(target), target);
    props.setProperty(NPS_LAST_CLOSED_KEY, target);
    return;
  }

  var theirs = _npsAskCollectorCloseDay(target);
  if (theirs && theirs !== close.date) {
    var drift = 'CLOSE CALENDAR DRIFT: this script says ' + target + ' closes '
      + close.date + ', the collector says ' + theirs + '.';
    // The one failure here that must never pass quietly. A disagreement about
    // the close date puts a late charge in one month and the close in another,
    // and no total ties afterwards.
    _npaSendFailure('The 7pm month close', drift,
      'Claude — nothing was written and ' + target + ' is still OPEN. '
        + 'monthCloseDay() in netprofit-collect and _npsMonthCloseDay() here have '
        + 'drifted apart and must be reconciled before the month can close.');
    throw new Error(drift + ' Fix monthCloseDay() in netprofit-collect before '
      + 'closing anything.');
  }

  try {
    NP_FROM = target + '-01';
    NP_TO = _npsLastDayOf(target);
    Logger.log('=== MONTH CLOSE %s — writing %s in full (%s .. %s) ===',
      today, target, NP_FROM, NP_TO);
    if (close.why.length) Logger.log('  close slipped: %s', close.why.join('; '));
    _npWrite(false);
    // On a close the grid holds the month being closed, so Days Thru lands on
    // its final day and Tracking stops projecting — the closed month reads as
    // fact, not as a forecast. That is the figure the bonus is paid on.
    _npxSync(false);

    props.setProperty(NPS_LAST_CLOSED_KEY, target);
    Logger.log('%s is CLOSED. Nothing will rewrite it — the daily refresh only '
      + 'touches the current month, and late charges book to the day they are '
      + 'charged, in the new month.', target);

    // Read AFTER the property is set, so the email only ever goes out for a
    // month that really did close. Silence on close night is the wrong default:
    // this is the moment the figure stops moving.
    _npaSendClose(target, _npaSnapshot(target));
  } catch (e) {
    _npaSendFailure('The 7pm month close', String(e && e.stack ? e.stack : e),
      'Claude — send this email on. ' + target + ' may be PARTLY written and is '
        + 'not marked closed, so the next eligible run will try again. Do not pay '
        + 'a bonus on this month until it has closed cleanly.');
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Make sure the month being written has a tab, rolling the previous one
// forward if it does not.
//
// ⚠️ THE ROLL COPIES THE PREVIOUS MONTH AND CLEARS THE COPY. The source is
// never modified, which is what makes it safe to run at 2pm on the 1st — five
// hours BEFORE that same month closes at 7pm. September's tab is copied to
// make October's, September's own figures are untouched, and the 7pm close
// then writes September's final month into the tab it always had.
//
// ⚠️ IT CANNOT RUN TWICE. _nprRoll refuses outright when the target tab already
// exists, so a second 2pm run — or a manual npRollApply on the same day — finds
// the tab present and does nothing.
//
// If a tab is ever deleted mid-month this recreates it empty and the daily
// refresh refills it, because the refresh always rewrites the WHOLE month to
// date rather than just today.
// ---------------------------------------------------------------------------
function _npsEnsureTab(ym) {
  var ss = SpreadsheetApp.openById(NP_SHEET_ID);
  if (ss.getSheetByName(_npTabName(ym))) return true;

  var prev = _npsPrevMonth(ym + '-01');
  if (!ss.getSheetByName(_npTabName(prev))) {
    Logger.log('!! no tab "%s", and no "%s" to roll forward from either. '
      + 'Nothing will be written this run — create the month by hand '
      + '(npRollStatus lists what is there).', _npTabName(ym), _npTabName(prev));
    return false;
  }

  Logger.log('No tab for %s yet — rolling %s forward.', ym, prev);
  var saveSrc = NPR_SOURCE_YM, saveDst = NPR_TARGET_YM;
  NPR_SOURCE_YM = prev;
  NPR_TARGET_YM = ym;
  try { _nprRoll(false); }
  finally { NPR_SOURCE_YM = saveSrc; NPR_TARGET_YM = saveDst; }
  return !!ss.getSheetByName(_npTabName(ym));
}

// Ask the collector what date IT thinks the month closes on. One cheap call,
// one store, a one-day window — we want the calendar, not the figures.
function _npsAskCollectorCloseDay(ym) {
  try {
    var url = NP_ENDPOINT + '?secret=' + encodeURIComponent(NP_SECRET)
            + '&store=OVL&from=' + ym + '-01&to=' + ym + '-01';
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    var b = JSON.parse(res.getContentText());
    var s = b && b.shippingAttribution && b.shippingAttribution.month_closes;
    return s ? String(s).slice(0, 10) : null;
  } catch (e) {
    Logger.log('  (could not reach the collector to cross-check the close date: %s)', e);
    return null;   // a network blip must not block a close; the drift guard is
                   // a check on OUR calendar, not a dependency of it
  }
}

// ---------------------------------------------------------------------------
// Trigger management
// ---------------------------------------------------------------------------

function npsInstallTriggers() {
  npsRemoveTriggers();
  // Two triggers on ONE function. The morning and afternoon passes do exactly
  // the same work — the only thing that differs is how much of yesterday's
  // shipping exists by then — so making them two functions would be two things
  // to keep in step for no gain.
  ScriptApp.newTrigger('npsDailyRefresh').timeBased()
    .atHour(NPS_MORNING_HOUR).everyDays(1).inTimezone(NPS_TZ).create();
  ScriptApp.newTrigger('npsDailyRefresh').timeBased()
    .atHour(NPS_DAILY_HOUR).everyDays(1).inTimezone(NPS_TZ).create();
  ScriptApp.newTrigger('npsMonthClose').timeBased()
    .atHour(NPS_CLOSE_HOUR).everyDays(1).inTimezone(NPS_TZ).create();
  Logger.log('Installed: npsDailyRefresh at %s:00 AND %s:00 %s, npsMonthClose at %s:00 %s.',
    NPS_MORNING_HOUR, NPS_DAILY_HOUR, NPS_TZ, NPS_CLOSE_HOUR, NPS_TZ);
  Logger.log('⚠️ Apps Script fires within the hour, never before it — so the close '
    + 'runs between 7pm and 8pm Central, which is the safe direction.');
  npsStatus();
}

function npsRemoveTriggers() {
  var all = ScriptApp.getProjectTriggers(), n = 0;
  for (var i = 0; i < all.length; i++) {
    var f = all[i].getHandlerFunction();
    if (f === 'npsDailyRefresh' || f === 'npsMonthClose') { ScriptApp.deleteTrigger(all[i]); n++; }
  }
  if (n) Logger.log('Removed %s Net Profit trigger(s).', n);
}

function npsStatus() {
  var today = _npsToday();
  var armed = [];
  var all = ScriptApp.getProjectTriggers();
  for (var i = 0; i < all.length; i++) {
    var f = all[i].getHandlerFunction();
    if (f === 'npsDailyRefresh' || f === 'npsMonthClose') armed.push(f);
  }
  Logger.log('Today (Central): %s', today);
  Logger.log('Triggers armed: %s', armed.length ? armed.join(', ') : 'NONE — run npsInstallTriggers');
  // ⚠️ TWO npsDailyRefresh ENTRIES IS CORRECT, and a status line that did not
  // say so would read as a duplicate somebody should go and delete. Apps Script
  // does not report a trigger's hour, so the count is the only evidence the
  // morning pass is armed at all.
  var refreshes = 0;
  for (var j = 0; j < armed.length; j++) if (armed[j] === 'npsDailyRefresh') refreshes++;
  Logger.log('Daily refreshes armed: %s — expected 2 (%s:00 and %s:00 %s). %s',
    refreshes, NPS_MORNING_HOUR, NPS_DAILY_HOUR, NPS_TZ,
    refreshes === 2 ? 'OK'
      : refreshes < 2 ? '!! re-run npsInstallTriggers — the morning pass is missing'
                      : '!! more than two — run npsInstallTriggers to reset them');
  Logger.log('Last closed month: %s',
    PropertiesService.getScriptProperties().getProperty(NPS_LAST_CLOSED_KEY) || '(none yet)');
  Logger.log('--- next twelve closes ---');
  var ym = _npsPrevMonth(today);
  for (var k = 0; k < 13; k++) {
    var c = _npsMonthCloseDay(ym);
    Logger.log('  %s closes %s%s', ym, c.date,
      c.why.length ? '   <- ' + c.why.join('; ') : '');
    var y = Number(ym.slice(0, 4)), m0 = Number(ym.slice(5, 7)) - 1;
    var ny = m0 === 11 ? y + 1 : y, nm0 = (m0 + 1) % 12;
    ym = ny + '-' + ('0' + (nm0 + 1)).slice(-2);
  }
}

// Re-open a month deliberately, when something genuinely has to be restated.
// Not part of the schedule and never called by a trigger — a closed month
// changing on its own is the thing this whole file exists to prevent.
function npsReopenMonth() {
  var props = PropertiesService.getScriptProperties();
  var was = props.getProperty(NPS_LAST_CLOSED_KEY);
  props.deleteProperty(NPS_LAST_CLOSED_KEY);
  Logger.log('Cleared the closed-month lock (was %s). The next npsMonthClose on a '
    + 'close day will rewrite that month. Set NP_FROM/NP_TO and run npWriteApply '
    + 'directly if you need it restated right now.', was || '(none)');
}
