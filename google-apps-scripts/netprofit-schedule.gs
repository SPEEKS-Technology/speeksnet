// ============================================================================
// netprofit-schedule.gs — run the NET PROFIT tab on a schedule.
//
// TWO pg_cron JOBS and THREE TRIGGERS, on three functions, from the CFO's rules
// (2026-08-27, split into a morning and an afternoon pass 2026-09-02, moved off
// Apps Script triggers onto pg_cron 2026-09-11, watchdog added 2026-09-15 —
// see NPS_OK_KEY):
//
//   npsDailyRefresh   8:05am AND 2:05pm Central, every day — started by pg_cron,
//                     which calls the web app (action=netprofit), which creates
//                     a ONE-OFF trigger that runs this a second later. No
//                     recurring trigger owns it any more.
//                     ⚠️ :05, NOT :00 (migration 0088). The sales/buying import
//                     owns :00 of this same project, and one project is one
//                     script lock: at 8:00 on 2026-09-12 this pass took the lock
//                     between the import's sales and buying halves and the
//                     buying half was refused.
//                     .atHour(8) only promises "somewhere in the 8 o'clock
//                     hour" and Google had settled on :46, three quarters of an
//                     hour behind the Sales Summary.
//                     ⚠️ THE ONE-OFF HOP IS NOT CEREMONY. Running this straight
//                     from the web app was tried and died at 6m04s. Every Apps
//                     Script execution gets 360 seconds, web app or trigger, so
//                     the hop does not buy a bigger budget — it buys a FRESH
//                     one, and it lets the caller be answered in a second
//                     instead of held open for the length of the run.
//                     The pass fits comfortably again since the collectors
//                     moved to fetchAll (see _npFetchAllStores) — ~110s rather
//                     than the ~360s that was timing out on 2026-09-11 — but
//                     the hop stays: pg_cron gives up waiting after 30s, and a
//                     job whose caller has already hung up should not be
//                     holding the only copy of the run.
//                     Which pass it is comes off the CLOCK inside the function,
//                     so the caller needs to pass nothing and cannot get it
//                     wrong.
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
// ⚠️ NPS_DAILY_HOUR IS THE SHIPPING CUTOFF, NOT A SCHEDULE, and has not been
// one since the passes moved to pg_cron. npsDailyRefresh compares the Central
// hour against it to decide whether to write shipping, so changing it changes
// what the morning pass writes. The TIMES now live in the cron jobs
// (netprofit-8am / netprofit-2pm, migration 0087) and both places have to agree:
// move a cron job across 14:00 Central and that pass silently changes meaning.
var NPS_MORNING_HOUR = 8;  // 8am — everything except shipping. Cron owns the time.
var NPS_DAILY_HOUR = 14;   // 2pm — and the hour at or after which shipping is written
var NPS_CLOSE_HOUR = 19;   // 7pm
var NPS_LAST_CLOSED_KEY = 'NPS_LAST_CLOSED_MONTH';

// ⚠️ THE WATCHDOG — FOR THE FAILURES THAT CANNOT SEND THEIR OWN EMAIL.
// npsDailyRefresh mails when it throws. It cannot mail when it never starts
// (pg_cron did not fire, the web app refused the call, the one-off trigger was
// not created) or when Google kills it at the six-minute limit, because a
// killed execution runs no catch block. All of those look like silence, and
// silence reads as "the sheet is fine".
//
// So every pass that FINISHES stamps today's date under its own key, and a
// recurring Apps Script trigger — deliberately not pg_cron, so one broken
// scheduler cannot hide the other — checks the stamp an hour later. Apps Script
// fires "somewhere in the hour", so 9 means 9:00-10:00 for an 8:05 pass that
// takes two or three minutes, and 15 means 3:00-4:00 for the 2:05 one.
//
// ⚠️ IT RESTARTS THE PASS, ONCE, AND THEN CHECKS AGAIN (2026-09-16). That
// morning the 8:05 cron call to the web app hung past pg_cron's 30 seconds, no
// one-off trigger was made, and the watchdog could only email — somebody still
// had to start the refresh by hand an hour and a half late. Now a missed pass is
// restarted on the spot (the same one-off hop the cron path uses), a follow-up
// check runs NPS_FOLLOWUP_MIN later, and only if THAT finds it still unfinished
// does the "did not complete" email go out. A restart is never tried twice in a
// day for the same pass: a pass that fails when started by hand is a real fault,
// and restarting it on a loop would only hide that.
//
// ⚠️ .nearMinute(30), NOT THE TOP OF THE HOUR. The 9:00 sales import retry runs
// in this project and shares its one script lock; a restart landing on it would
// be refused, or refuse the import. nearMinute gives ±15, so 9:15-9:45.
var NPS_OK_KEY = { morning: 'NPS_LAST_OK_MORNING', afternoon: 'NPS_LAST_OK_2PM' };
var NPS_RESTART_KEY = { morning: 'NPS_RESTARTED_MORNING', afternoon: 'NPS_RESTARTED_2PM' };
var NPS_FOLLOWUP_UID_KEY = 'NPS_WATCH_FOLLOWUP_UID';
var NPS_WATCH_HOURS = [9, 15];
var NPS_WATCH_MINUTE = 30;
var NPS_FOLLOWUP_MIN = 20;

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

// `e` is the trigger event, and it is here for ONE reason: the cron path runs
// this through a one-off trigger created by the web app (action=netprofit), and
// a one-off trigger is not cleaned up by Apps Script. The project is capped at
// 20 triggers; two a day would wall it off inside a fortnight.
//
// ⚠️ DELETED FIRST, BEFORE ANY OF THE WORK. A run that throws or is killed for
// exceeding its six minutes still leaves nothing behind. Deleting at the end
// would orphan a trigger on precisely the failure most likely to happen.
//
// Called by hand from the editor, or by the old-style recurring trigger, `e` is
// absent and nothing is deleted — which is right, because a recurring trigger
// must survive its own run.
function npsDailyRefresh(e) {
  if (e && e.triggerUid) _npsDeleteOneShot(e.triggerUid);
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
    // Straight after the write, before anything else can throw: what the write
    // found wrong goes out even if the summary pass below fails.
    _npaSendHealth(NP_HEALTH, ym, pass.split(' ')[0].toLowerCase() + ' daily refresh');
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

    // The watchdog's evidence that this pass finished. LAST, so a pass that dies
    // anywhere above — including at the six-minute wall — never stamps it.
    PropertiesService.getScriptProperties()
      .setProperty(morning ? NPS_OK_KEY.morning : NPS_OK_KEY.afternoon, today);

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
    // Close night is the worst night to write an #N/A quietly: it is the figure
    // the bonus is paid on, and nothing rewrites it afterwards.
    _npaSendHealth(NP_HEALTH, target, 'month close');
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
// The watchdog. See NPS_OK_KEY for why it exists and why it is not on pg_cron.
// ---------------------------------------------------------------------------
// PURE, for tests/np-health-check.js: given the Central hour and the two stamps,
// which pass (if any) should have finished and has not.
function _npsOverdue(today, hour, stamps) {
  if (hour < NPS_WATCH_HOURS[0]) return null;               // nothing is due yet
  var pm = hour >= NPS_WATCH_HOURS[1];
  var key = pm ? 'afternoon' : 'morning';
  if (stamps[key] === today) return null;
  return { pass: pm ? 'The 2pm Net Profit refresh' : 'The 8am Net Profit refresh',
           key: key, dueAt: pm ? '2:05pm' : '8:05am', last: stamps[key] || null };
}

// PURE, for tests/np-health-check.js: what the watchdog does about it.
// 'restart' the first time a pass is found unfinished today, 'give-up' (email
// only) if it has already been restarted today and still has not finished.
function _npsWatchAction(today, hour, stamps, restarted) {
  var late = _npsOverdue(today, hour, stamps);
  if (!late) return null;
  return { late: late, action: restarted[late.key] === today ? 'give-up' : 'restart' };
}

function npsWatchdog(e) {
  var props = PropertiesService.getScriptProperties();
  // The follow-up check is a one-off trigger; delete it so they do not pile up.
  // Only THAT one — the two recurring watchdog triggers carry a triggerUid too.
  if (e && e.triggerUid && String(e.triggerUid) === props.getProperty(NPS_FOLLOWUP_UID_KEY)) {
    _npsDeleteOneShot(e.triggerUid);
    props.deleteProperty(NPS_FOLLOWUP_UID_KEY);
  }
  var today = _npsToday();
  var hour = Number(Utilities.formatDate(new Date(), NPS_TZ, 'H'));
  var got = _npsWatchAction(today, hour, {
    morning: props.getProperty(NPS_OK_KEY.morning),
    afternoon: props.getProperty(NPS_OK_KEY.afternoon)
  }, {
    morning: props.getProperty(NPS_RESTART_KEY.morning),
    afternoon: props.getProperty(NPS_RESTART_KEY.afternoon)
  });
  if (!got) { Logger.log('Watchdog %s %s:00 — the pass that was due has finished.', today, hour); return; }
  var late = got.late;
  var now = Utilities.formatDate(new Date(), NPS_TZ, 'h:mma');
  var cronJob = 'netprofit-' + (late.key === 'morning' ? '8am' : '2pm');
  Logger.log('Watchdog: %s has not finished today (last finished %s) — %s.',
    late.pass, late.last || 'never', got.action);

  if (got.action === 'restart') {
    // Marked BEFORE the triggers are made, so a throw below cannot turn into a
    // second restart on the follow-up.
    props.setProperty(NPS_RESTART_KEY[late.key], today);
    try {
      ScriptApp.newTrigger('npsDailyRefresh').timeBased().after(1000).create();
      var follow = ScriptApp.newTrigger('npsWatchdog').timeBased()
        .after(NPS_FOLLOWUP_MIN * 60 * 1000).create();
      props.setProperty(NPS_FOLLOWUP_UID_KEY, follow.getUniqueId());
    } catch (err) {
      _npaSendFailure(late.pass,
        'Due at ' + late.dueAt + ' Central and not finished by ' + now + '. The watchdog '
          + 'tried to restart it and could not create the trigger: ' + err,
        'Claude — run npsDailyRefresh from the editor now (it rewrites the whole month to '
          + 'date), then check cron.job_run_details for ' + cronJob + ' and the trigger count '
          + '(npsStatus; the project is capped at 20).');
      return;
    }
    _npaSendRestarted(late.pass,
      'Due at ' + late.dueAt + ' Central and not finished by ' + now + ' (last finished '
        + (late.last || 'never') + '). The watchdog has started it again; it rewrites the '
        + 'whole month to date and takes two or three minutes. It checks again in '
        + NPS_FOLLOWUP_MIN + ' minutes and emails only if the restart did not finish either.',
      'Nobody, if no second email follows. If this arrives often, Claude — check '
        + 'cron.job_run_details and net._http_response for ' + cronJob + ': the cron call '
        + 'itself is failing.');
    return;
  }

  _npaSendFailure(late.pass,
    'Due at ' + late.dueAt + ' Central and not finished by ' + now + '. The last one that '
      + 'finished was on ' + (late.last || '(never recorded)') + '. The watchdog already '
      + 'restarted it once today and the restart did not finish either — so this is not a '
      + 'missed cron call, the run itself is failing or being killed at the six-minute limit. '
      + 'If a separate "did not complete" email arrived for this pass, that is the cause.',
    'Claude — read the Apps Script executions list for npsDailyRefresh today, and '
      + 'cron.job_run_details for ' + cronJob + '. Once fixed, run npsDailyRefresh from the '
      + 'editor: it rewrites the whole month to date.');
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
  // ⚠️ THE TWO DAILY REFRESHES ARE NO LONGER TRIGGERS (2026-09-11). They are
  // pg_cron jobs calling the web app with action=netprofit, because .atHour(8)
  // means "somewhere in the 8 o'clock hour" and Google had settled on :46 —
  // three quarters of an hour after the Sales Summary, which is on pg_cron and
  // lands at 8:00:00. Two mornings running, the drift was two seconds, so it
  // was stable; it just was not eight o'clock.
  //
  // The month close STAYS a trigger. It has no deadline to hit — the comment
  // below is the whole reason — so it gains nothing from the move and each
  // thing moved is a thing that can break.
  //
  // Re-running this function is how you get back: put the two
  // ScriptApp.newTrigger('npsDailyRefresh') lines back and deactivate the cron
  // jobs. Do not leave both armed — that is four passes a day, two of them
  // writing shipping at 8am.
  ScriptApp.newTrigger('npsMonthClose').timeBased()
    .atHour(NPS_CLOSE_HOUR).everyDays(1).inTimezone(NPS_TZ).create();
  Logger.log('Installed: npsMonthClose at %s:00 %s.', NPS_CLOSE_HOUR, NPS_TZ);
  // The watchdog is a trigger ON PURPOSE, not a cron job: it is what notices
  // when the cron side has stopped.
  NPS_WATCH_HOURS.forEach(function (h) {
    ScriptApp.newTrigger('npsWatchdog').timeBased()
      .atHour(h).nearMinute(NPS_WATCH_MINUTE).everyDays(1).inTimezone(NPS_TZ).create();
  });
  Logger.log('Installed: npsWatchdog near %s Central (±15 min; restarts a missed pass once).',
    NPS_WATCH_HOURS.map(function (h) { return h + ':' + NPS_WATCH_MINUTE; }).join(' and '));
  Logger.log('Daily refreshes are pg_cron jobs (netprofit-8am / netprofit-2pm), '
    + 'not triggers — see migration 0087.');
  Logger.log('⚠️ Apps Script fires within the hour, never before it — so the close '
    + 'runs between 7pm and 8pm Central, which is the safe direction.');
  npsStatus();
}

// Delete the one-off trigger whose firing we are currently inside. Never throws:
// a refresh that ran is worth more than a tidy trigger list, and the next run
// creates its own anyway. The worst case is one orphan, which npsInstallTriggers
// sweeps.
function _npsDeleteOneShot(uid) {
  try {
    var all = ScriptApp.getProjectTriggers();
    for (var i = 0; i < all.length; i++) {
      if (all[i].getUniqueId() === String(uid)) {
        ScriptApp.deleteTrigger(all[i]);
        return;
      }
    }
  } catch (err) {
    Logger.log('!! could not delete the one-off trigger %s: %s', uid, err);
  }
}

function npsRemoveTriggers() {
  var all = ScriptApp.getProjectTriggers(), n = 0;
  for (var i = 0; i < all.length; i++) {
    var f = all[i].getHandlerFunction();
    if (f === 'npsDailyRefresh' || f === 'npsMonthClose' || f === 'npsWatchdog') {
      ScriptApp.deleteTrigger(all[i]); n++;
    }
  }
  if (n) Logger.log('Removed %s Net Profit trigger(s).', n);
}

function npsStatus() {
  var today = _npsToday();
  var armed = [];
  var all = ScriptApp.getProjectTriggers();
  for (var i = 0; i < all.length; i++) {
    var f = all[i].getHandlerFunction();
    if (f === 'npsDailyRefresh' || f === 'npsMonthClose' || f === 'npsWatchdog') armed.push(f);
  }
  Logger.log('Today (Central): %s', today);
  var watch = armed.filter(function (f) { return f === 'npsWatchdog'; }).length;
  var pp = PropertiesService.getScriptProperties();
  Logger.log('Watchdog triggers armed: %s — expected %s. %s  Last finished: morning %s, 2pm %s.',
    watch, NPS_WATCH_HOURS.length,
    // One over is a follow-up check waiting to fire after a restart; it deletes itself.
    watch >= NPS_WATCH_HOURS.length ? 'OK' : '!! run npsInstallTriggers',
    pp.getProperty(NPS_OK_KEY.morning) || '(none yet)',
    pp.getProperty(NPS_OK_KEY.afternoon) || '(none yet)');
  Logger.log('Triggers armed: %s', armed.length ? armed.join(', ') : 'NONE — run npsInstallTriggers');
  // ⚠️ ZERO npsDailyRefresh TRIGGERS IS NOW CORRECT. This used to expect two,
  // and said so loudly, because Apps Script does not report a trigger's hour
  // and the count was the only evidence the morning pass was armed. Since
  // 2026-09-11 the two passes are pg_cron jobs hitting the web app, so a
  // RECURRING trigger found here is a LEFTOVER: it would run the refresh a
  // second time at Google's chosen minute, and an 8:46 pass writing on top of
  // an 8:00 one is invisible unless you are watching the clock.
  //
  // A count of 1 seen in the seconds after a cron call is the one-off trigger
  // waiting to fire, not a leftover. It deletes itself at the top of the run,
  // so if the count is still 1 a minute later, it is real.
  var refreshes = 0;
  for (var j = 0; j < armed.length; j++) if (armed[j] === 'npsDailyRefresh') refreshes++;
  Logger.log('Daily refresh TRIGGERS armed: %s — expected 0, the passes are pg_cron. %s',
    refreshes,
    refreshes === 0 ? 'OK'
                    : '!! leftover trigger(s) — run npsInstallTriggers to clear them');
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
