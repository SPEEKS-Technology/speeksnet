// ============================================================
// SPEEKS — Shopify daily sales email → Sales Summary sheet
//
// Reads the per-store Shopify daily summary emails out of Gmail and writes the
// two manual numbers (Sales + Cost) into the "Sales {Mon} {YY}" tab. Everything
// else on that tab (Total, Rev Tracking, GP, GP Total, GP Tracking, Margin, MOM)
// is a formula and is never touched.
//
// Downstream, nothing else needs to change: the existing sync-buysell edge
// function polls the sheet every 10 minutes into app_cache.buy_sell_hub, which
// feeds the hub function and the Buying & Selling widget. See [[buy-sell-sync]].
//
// WHY APPS SCRIPT AND NOT A SUPABASE FUNCTION:
//   this script runs as the Google account that RECEIVES the emails, so it gets
//   Gmail + Sheets access with no OAuth client, no refresh tokens and no Gmail
//   API setup — the same trick the weekly-report Gmail relay already uses.
//
// MAILBOX NOTE: the DM and CEO read these emails in OUTLOOK. Apps Script cannot
// see an Outlook mailbox — GmailApp only ever reads the Gmail account this script
// is deployed under. The 5 senders being Gmail addresses is irrelevant; Shopify's
// servers do the sending, so no copy exists in those accounts unless they are
// also recipients. Hence step 1: a Gmail address is added to the Shopify report
// recipient list purely so a Gmail copy exists for this script to read. Outlook
// delivery for the humans is unaffected.
//
// SETUP (one-time):
//   1. In each of the 5 Shopify stores, add ONE shared Gmail address to the daily
//      report's recipient list, alongside the existing Outlook recipients. Use the
//      same Gmail for all 5 stores — one mailbox means one deployment, and the
//      sender address still identifies the store.
//   2. Share the Sales Summary spreadsheet (SHEET_ID) with that Gmail as an
//      EDITOR. It is owned by a different account, so without this every write
//      fails with a permission error.
//   3. Signed in as that Gmail, create a standalone Apps Script project and paste
//      this file in.
//   4. Fill in STORE_SENDERS below with the 5 real sender addresses.
//   5. Run diagnoseShopifyEmails(), authorize when prompted, and read the log —
//      that confirms the senders match and shows the real Shopify wording for the
//      two figures. Then run diagnoseSheetCells() to confirm the write targets.
//   6. Deploy → New deployment → Web app, "Execute as me",
//      "Who has access: Anyone" (NOT "Anyone with a Google account" — that serves
//      a sign-in page and the caller gets HTML instead of JSON). Copy the /exec
//      URL into the sales-ingest function's SALES_IMPORT_URL env var.
//
// A rolling window is re-verified on EVERY run (not just yesterday), so when
// Shopify restates a past day the sheet is silently corrected. That replaces the
// manual Monday reconciliation.
// ============================================================

var SECRET      = 'sp33ks-sync-k3y-2026-x9mq';
var SHEET_ID    = '1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8';  // Sales Summary 2026
var TIMEZONE    = 'America/Chicago';
var LOOKBACK    = 9;   // Gmail search window in days. Each MTD email carries the whole
                       // month, so this only needs to be long enough to fall back on an
                       // older email if today's never arrived.
// How many days back to compare/correct in the sheet. Wide enough to cover a full
// month, because the emails are month-to-date: Shopify backdates a refund to the
// original sale date, so a return processed three weeks later changes a day a
// 7-day window had long since stopped looking at.
//
// A wide window is cheap and safe here: days the emails don't cover fall into
// `unverified` when the sheet already holds a figure (silent), and only a day that
// is BOTH uncovered and blank becomes an alertable `missing`.
var REVERIFY    = 32;

// Nothing before this date was ever sent to this mailbox, so a gap there is not a
// gap — it is simply out of scope. Set to the first day the Gmail address was on
// the Shopify recipient lists. Without it, the first week of running reports every
// pre-go-live day as missing. Safe to leave in place permanently.
var EXPECT_FROM = '2026-08-01';

// The sender address IS the store identity — no subject parsing needed.
// Addresses and store mapping both confirmed by the user 2026-08-04.
//
// This mapping is the highest-stakes constant in the file: swap two entries and
// one store's revenue lands in another's columns, the sheet still looks entirely
// plausible, and nothing downstream can detect it. mapSendersToStores() re-derives
// it from figures already keyed into the sheet — worth running after any edit here.
var STORE_SENDERS = {
  'ks01@paymore.com': 'OVL',   // Kansas — Overland Park
  'mo01@paymore.com': 'LEE',
  'mo02@paymore.com': 'WSP',
  'mo03@paymore.com': 'MPL',
  'mo04@paymore.com': 'BAL'
};

// "Sales {Mon} {YY}" tab geometry, confirmed against the live sheet 2026-08-04.
// Each store block is 11 columns wide; TTL sits at 55 and is all formulas.
var SALES_COL_BASES = { OVL: 0, LEE: 11, WSP: 22, MPL: 33, BAL: 44 };
var COL_SALES   = 1;   // base+1  "Sales"
var COL_COST    = 4;   // base+4  "Cost"
var HEADER_ROWS = 3;   // 0-indexed; day rows begin at or after this row
var MONTHS      = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// "Days Thru month" drives the sheet's tracking/projection formulas and has to
// advance as data lands. It is DERIVED, never incremented: the importer is
// idempotent everywhere else, and a counter that adds 1 per run would drift the
// first time a run repeated, a morning was missed, or someone pressed the button.
// Derived value = the latest day in the tab that actually has sales data.
//
// The value cell is found by its LABEL and taken as the cell immediately to the
// right (e.g. label B41 "Days Thru month" -> value C41), so row inserts can't
// break it and every store block's counter is found automatically.
// NOTE: deliberately does NOT match "Days this month" (total days in the month,
// e.g. 31) or the Buy tab's "Buying Days in Month" — neither contains "thru".
var UPDATE_DAYS_THRU = true;
var DAYS_THRU_LABEL  = /days?\s*thru\s*month/i;

// Archive each day's emails once their figures are safely in the sheet, so this
// Gmail inbox does not silently accumulate five reports a day forever.
//
// SAFE FOR THE 7-DAY REVERIFY: archiving only removes the INBOX label.
// GmailApp.search() covers all mail, so archived reports are still found and
// re-checked — only spam/trash are excluded. It also has no effect whatsoever on
// the copies the DM and CEO read in Outlook.
//
// A thread is left in the inbox if anything about it looked wrong (a parse
// failure, or a store/date that could not be written), because an email sitting
// in the inbox is the cheapest possible signal that a human should look at it.
var ARCHIVE_AFTER_IMPORT = true;

// Fill the goal-tracking cells green at or above 100% of GP goal, red below.
//
// "% of GP Goal" sits at base+4 on sheet row 1, with the GP Goal dollar figure
// directly beneath it on row 2; both take the same fill. Bases here include TTL
// (55), so the six columns are E, P, AA, AL, AW, BH.
//
// Only the FILL is touched, never a value or a formula — the percentage itself is
// a formula off the day rows, so it updates on its own once the figures land.
var COLOR_GOAL_CELLS = true;
var GOAL_CELL_BASES  = [0, 11, 22, 33, 44, 55];   // OVL LEE WSP MPL BAL TTL
var GOAL_PCT_ROW     = 1;        // 1-indexed sheet row holding the percentage
var GOAL_FILL_ROWS   = [1, 2];   // 1-indexed rows to paint
// Matched by eye to the green already on the sheet; adjust either to taste.
var GOAL_GREEN = '#00ff00';
var GOAL_RED   = '#ff5252';

// Email when a figure already in the sheet moves by this much or more, up or down.
// Restatements are applied silently by design, but a swing this size is worth
// knowing about — it usually means a refund or a late-posting order against a day
// that was already closed out.
//
// A day being filled for the FIRST time is not a change and never notifies, however
// large: that is just the daily import doing its job. Only a figure that already
// had a value and now has a different one counts.
//
// Sent straight from here rather than through the sales-ingest function, so it
// fires on any run — cron, the button, or runImportNow() from the editor. Dry runs
// never send. Note this recipient is a constant, NOT the email_recipients table
// that feeds the missing-days alert, so changing it means editing and republishing.
var NOTIFY_CHANGE_OVER = 150;
// Above this, the change is painted green (up) or red (down) in the email. Between
// the two thresholds it is reported but left grey and tagged "minor", so a $160
// tweak cannot look as urgent as a $900 one.
var NOTIFY_BIG_CHANGE  = 300;
var CHANGE_ALERT_TO    = 'ethan.kushnir@speekstechnology.com';

// Candidate labels for the two numbers, most-specific first. Shopify's wording
// varies by report type, so each number is matched against a list rather than
// one hardcoded string. diagnoseShopifyEmails() prints every "label: $number"
// pair it can see, which is how this list gets confirmed.
var SALES_LABELS = ['net sales', 'total sales', 'gross sales', 'sales'];
var COST_LABELS  = ['cost of goods sold', 'total cost', 'cogs', 'cost'];

// ------------------------------------------------------------
// BUYING import — PayMore "Day End Report"
// ------------------------------------------------------------
// Second feed into the same sheet. Deliberately simpler than the sales path:
// buying figures never restate (user-confirmed 2026-08-06), so there is no MTD
// list, no reverify window and no restatement handling — just yesterday.
//
// "Buy {Mon} {YY}" geometry, read off the live sheet 2026-08-06. Blocks are 5
// columns apart, NOT the 11 of the Sales tab.
//   0=Date  1=Buy  2=Sell  3=GM(formula)  4=week-total(formula)
var BUY_COL_BASES = { OVL: 0, LEE: 5, WSP: 10, MPL: 15, BAL: 20 };
var COL_BUY  = 1;   // base+1 "Buy"  = cash paid      <- email "Total Spent"
var COL_SELL = 2;   // base+2 "Sell" = resale value   <- email "Estimated Value"

// Field mapping confirmed by the user 2026-08-06. Longest/most specific wording
// first, same discipline as SALES_LABELS — a bare "value" would match half the
// report.
var SPENT_LABELS = ['total spent', 'total spend', 'amount spent'];
var ESTVAL_LABELS = ['estimated value', 'est. value', 'est value', 'estimated retail'];

// ---- Google reviews ---------------------------------------------------------
// The Day End Report now also carries the store's month-to-date Google review
// count, so the one figure that was going to be hand-keyed every morning arrives
// on the feed that is already running. It lands in its own block on the same Buy
// tab (columns AE-AK, laid out in google-apps-scripts/hub-google-reviews.gs) at
// the same day row as that morning's buy/sell, and the hub reads the block's TTL
// and Tracking rows exactly like it reads buying's.
//
// CUMULATIVE, not the day's own count. Each report states the month to date as it
// stood at that store's close, so writing one number per day builds the column
// correctly with no arithmetic here — and re-reading an old email is idempotent,
// which is what lets BUY_BACKFILL re-run harmlessly.
var REVIEW_COL_BASES = { OVL: 31, LEE: 32, WSP: 33, MPL: 34, BAL: 35 };  // AF..AJ

// ✅ CONFIRMED against the real reports 2026-08-08. The wording is
// "5-star reviews (Month to Date)", on its own line with the figure on the next
// one as `*5*` — the asterisks are what getPlainBody() makes of the bold cell.
// The line appeared with the Aug 7 reports; Aug 5 and earlier do not have it, so
// a backfill over those days finds nothing and correctly writes nothing.
//
// ⚠️ IT IS 5-STAR REVIEWS, NOT ALL REVIEWS. That is the only month-to-date figure
// the report carries, so it is what the sheet column and its target mean.
//
// ⚠️ THE DANGEROUS NEIGHBOUR IS "Total reviews", THREE LINES ABOVE IT. That is the
// DAY's count, rendered `*0▼ 100%*`, and it is the number a looser label list
// would pick up — a whole number, in the right part of the report, that would
// quietly overwrite the month with a day and then read as a collapse. So every
// candidate below requires the month-to-date parenthetical: that phrase, not the
// word "reviews", is what identifies the figure.
//
// Note there is no "Google" anywhere in the report — the earlier guess required
// it in every candidate, which is precisely why it matched nothing.
var REVIEW_LABELS = [
  '5-star reviews (month to date)', '5 star reviews (month to date)',
  '5-star reviews (mtd)', 'reviews (month to date)', 'reviews (mtd)'
];
// Where the segment after the label must stop. "PaytonAI Review insights" follows
// immediately, and the paragraph under it opens "1 Star Reviews - Summary" — so a
// month with no figure at all would otherwise read as 1.
var REVIEW_STOPS = ['paytonai', 'review insights', 'star reviews',
  'total reviews', 'total spent', 'estimated value'];

// ---- CASH ON HAND ----------------------------------------------------------
// The fourth thing this report carries: the closing count. Three figures per
// store, in their own cards near the bottom — "Safe Balance", "Cash Balance"
// (whose own sub-heading reads "Cash Drawer Cash count bills") and "Total Cash
// on Hand". They do NOT go to the sheet; they go to `store_cash` in Supabase by
// way of the run report, and the 7am cash email reads them from there.
//
// CONFIRMED against all 5 real bodies by diagnoseCashSection() on 2026-08-09.
// Every store's Cash Management block reads, in this order:
//
//     Buying Drawer Balance     <- NOT us
//     PayStation Balance        <- NOT us
//     Safe Balance
//     Cash Balance              <- the drawer, per its own "Cash Drawer Cash
//     Cash Drawer Cash count bills    count bills" sub-heading
//     Total Cash on Hand
//
// ⚠️ THE LABELS ARE DELIBERATELY EXACT, NOT FORGIVING. An earlier draft listed
// 'drawer balance' as a fallback for the drawer — which is a substring of
// "Buying Drawer Balance", a different pot of money sitting two lines above the
// one we want. It read correctly only because 'cash balance' happened to come
// first in the array, i.e. the right answer was being protected by nothing but
// list order. A loose synonym here does not degrade to "no figure", it degrades
// to "a confident wrong figure", which is the one outcome a cash report must
// never produce. If a label ever stops matching, the fix is to read a fresh
// diagnoseCashSection() dump and put the report's real wording here — never to
// widen these into the neighbours.
//
// The second dangerous neighbour is the DENOMINATION GRID beneath each figure:
// "$100 X 6", "$50 X 0", "$20 X 70" — real dollar amounts in the right part of
// the report. What protects us is that the value regex takes the FIRST $-figure
// after the label (the card's own total), plus the stop labels below so a card
// with no figure of its own cannot reach into the next card's.
//
// The trend deltas ("▲ 0%", "▼ 65.7%") that follow each figure carry no dollar
// sign, so the money matcher steps over them for free.
var CASH_DRAWER_LABELS = ['cash balance'];
var CASH_SAFE_LABELS   = ['safe balance'];
var CASH_TOTAL_LABELS  = ['total cash on hand'];
// Every card stops at every other card, at the grid heading that follows, and at
// the two balances above the block that are not ours.
var CASH_STOPS = ['safe balance', 'cash balance', 'total cash on hand',
  'cash drawer cash count', 'total bills', 'denomination',
  'buying drawer balance', 'paystation balance'];

// The report sends its own total, and we store what it sends. But if that total
// disagrees with drawer + safe by more than this, something has been read from
// the wrong card — reported as a warning, never silently corrected.
var CASH_TOTAL_TOLERANCE = 1;

// A review count that jumps by more than this in one day is not a review count —
// it is an all-time total, a rating scaled up, or the wrong number entirely.
// Reported, never written. Five stores averaging a handful of reviews a month
// makes anything past this impossible rather than merely surprising.
var REVIEW_MAX_JUMP = 25;

// Days back to consider, ending yesterday. The ask was "just the previous day";
// this is 3 purely as a self-healing gap-filler, because the Apps Script /exec
// endpoint has been throwing transient 404s (2 of the last 14 runs). Since the
// figures never restate, re-reading an older email is idempotent — it lands as
// `unchanged` — so a wider window costs nothing and covers a day when BOTH the
// 7am pass and the 8am retry fail.
var BUY_BACKFILL = 3;

// "Days thru Month" on the Buy tab (E40 and its twins J/O/T/Y — one per store
// block, at base+4). Advances daily like the Sales tab's counter, but it is NOT
// the same number and must not be computed the same way:
//
//   Sales "Days Thru month" = the last day-of-month reached. Sundays included.
//   Buy   "Days thru Month" = COUNT of non-Sunday days elapsed. Stores do not
//                             buy on Sundays, and the row is pre-zeroed for
//                             every Sunday in the month from the start.
//
// Verified against the live sheet: Aug'26 in-month 26 = 31−5 Sundays, Jul'26 27
// = 31−4, Jun'26 26 = 30−4; and thru=4 on Aug 6 because Aug 1,3,4,5 are the
// non-Sunday days with figures — the sales rule would have said 5. Both feed
// tracking denominators, so an off-by-one silently skews the projection.
var UPDATE_BUY_DAYS_THRU = true;
var BUY_DAYS_THRU_COL    = 4;   // base+4, the column right of the merged label

// PLANNED closures other than Sundays — holidays the stores shut for, as
// 'YYYY-MM-DD'. These are excluded from "Days thru Month" exactly like Sundays.
//
// The distinction this list encodes, and the reason it cannot be inferred:
//   PLANNED   (Sunday / holiday) -> nobody was meant to buy  -> does NOT count
//   UNPLANNED (storm, outage)    -> we lost a buying day     -> DOES count
// In the sheet both are a zero, so the data alone cannot tell them apart. A day
// not named here is treated as unplanned, which is the safe default: an
// unlisted holiday flatters nothing, it just makes the denominator one too big
// and shows up in the cross-check below.
//
// Keep in step with the "Buying Days in Month" total that is still entered by
// hand — _buyPlannedCheck() compares the two every run and reports a mismatch,
// so a forgotten holiday surfaces at the start of the month rather than after
// a month of skewed tracking.
var BUY_CLOSED_DATES = [
  // e.g. '2026-11-26',  // Thanksgiving
  //      '2026-12-25',  // Christmas
];

// SPEEKS is now where closures are entered — Month Setup keeps them in
// monthly_closed_days, and the DM adds them once when the month is set up. The
// array above is the fallback for a month SPEEKS cannot answer for.
//
// ⚠️ A FAILED LOOKUP MUST NOT LOOK LIKE "no holidays". Pretending the month is
// clear would write a "Days thru Month" that counts the holiday, and nothing
// downstream would ever say so. So a failure returns null and the caller skips
// the write for that run — which costs nothing, because the counter is
// recomputed from day 1 every morning rather than incremented, so the next
// successful run repairs it completely.
var GP_GOALS_URL = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/gp-goals';
var _buyClosedCache = {};

function _buyClosedDays(y, monthIdx) {
  var ym = y + '-' + ('0' + (monthIdx + 1)).slice(-2);
  if (_buyClosedCache[ym] !== undefined) return _buyClosedCache[ym];
  var days = null;
  try {
    var res = UrlFetchApp.fetch(GP_GOALS_URL + '?month=' + ym, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      var j = JSON.parse(res.getContentText());
      if (j && Object.prototype.toString.call(j.closed) === '[object Array]') {
        days = j.closed.map(function (c) { return Number(c.day); })
                       .filter(function (d) { return d >= 1 && d <= 31; });
      }
    }
  } catch (e) { /* falls through to the local list */ }
  if (days === null && BUY_CLOSED_DATES.length) {
    days = BUY_CLOSED_DATES
      .filter(function (iso) { return iso.indexOf(ym + '-') === 0; })
      .map(function (iso) { return parseInt(iso.slice(8), 10); });
  }
  _buyClosedCache[ym] = days;
  return days;
}

function _isPlannedClosure(y, monthIdx, day) {
  var d = new Date(y, monthIdx, day);
  if (d.getDay() === 0) return true;                       // Sunday
  var closed = _buyClosedDays(y, monthIdx);
  return closed !== null && closed.indexOf(day) !== -1;
}

// Non-Sunday, non-holiday days in the whole month — what the hand-entered
// "Buying Days in Month" should equal.
function _buyPlannedDaysInMonth(refDate) {
  var y = refDate.getFullYear(), m = refDate.getMonth();
  var dim = new Date(y, m + 1, 0).getDate();
  var n = 0;
  for (var d = 1; d <= dim; d++) if (!_isPlannedClosure(y, m, d)) n++;
  return n;
}

// ------------------------------------------------------------
// Web app entry points
// ------------------------------------------------------------
function doPost(e) { return _handle(e); }
function doGet(e)  { return _handle(e); }

function _handle(e) {
  var p = (e && e.parameter) || {};
  if (p.secret !== SECRET) return _json({ ok: false, error: 'unauthorized' });

  var action = p.action || 'ingest';
  var dryRun = p.dryRun === '1';

  // An UNKNOWN action used to fall through to the live import — so a typo, or an
  // action added here but not yet published (the /exec URL serves the deployed
  // version, not the editor's), silently ran a full sales+buying write instead of
  // whatever read-only thing was asked for. Refusing by name costs nothing and
  // makes a deploy-drift miss say so.
  if (['ingest', 'diagnose', 'diagnoseBuying', 'diagnoseReviews', 'buying',
       'diagnoseWeekly', 'diagnoseSummary', 'weekly', 'rehearseShift',
       'backfillConversions', 'verifyConversions'].indexOf(action) < 0) {
    return _json({ ok: false, error: 'unknown action "' + action + '"' });
  }

  try {
    if (action === 'diagnose') return _json(diagnoseShopifyEmails());
    if (action === 'diagnoseBuying') return _json(diagnoseBuyingEmails());
    // Read-only, and reachable over the web app rather than only from the Run
    // dropdown — checking whether a wording still parses should not need a
    // redeploy to find out, which is the loop that hid the first miss.
    if (action === 'diagnoseReviews') return _json(diagnoseBuyingReviews());
    // Weekly-summary groundwork, both read-only. See the recon section at the
    // bottom of this file.
    if (action === 'diagnoseWeekly')  return _json(diagnoseWeeklyEmails());
    if (action === 'diagnoseSummary') return _json(diagnoseSummaryTab());
    // The Summary tab is its own weekly job (Mondays), NOT folded into the daily
    // ingest the way buying is: it shifts four week blocks up, so a stray extra
    // run is the one thing it must never get.
    if (action === 'weekly') {
      return _json(ingestWeeklySummary({
        dryRun: dryRun, force: p.force === '1', inPlace: p.inPlace === '1',
        tab: p.tab || null, weekEnd: p.weekEnd || null
      }));
    }
    if (action === 'rehearseShift') return _json(rehearseWeeklyShift());
    if (action === 'backfillConversions') {
      return _json(backfillConversions({ dryRun: dryRun, days: p.days ? parseInt(p.days, 10) : 45 }));
    }
    if (action === 'verifyConversions') {
      return _json(verifyConversionWeek({ weekEnd: p.weekEnd || null }));
    }
    if (action === 'buying') return _json(ingestBuyingEmails({ dryRun: dryRun }));

    var sales = ingestSalesEmails({
      reverify: p.reverify ? parseInt(p.reverify, 10) : REVERIFY,
      dryRun:   dryRun
    });

    // One 7am run covers both feeds (user's call — the buying report lands at
    // 10pm the night before, so it is ready by then). `buying=0` opts out.
    //
    // Buying is folded in AFTER sales and can never fail the response: a broken
    // buying parse must not cost us the sales import, which is the load-bearing
    // one. Its outcome rides along under `buying` for the caller to inspect.
    if (p.buying !== '0') {
      try {
        sales.buying = ingestBuyingEmails({ dryRun: dryRun });
      } catch (berr) {
        sales.buying = { ok: false, error: String(berr && berr.message || berr) };
      }
    }
    return _json(sales);
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message || err) });
  }
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------------------------------------
// Main ingest
// ------------------------------------------------------------
// Returns a report the caller can log and alert on:
//   { ok, ranAt, written[], corrected[], unchanged, missing[], skipped[], errors[] }
// `missing` is what the alert fires on — a store/date the sheet still needs by
// hand. Everything else is informational.
function ingestSalesEmails(opts) {
  opts = opts || {};
  var reverify = opts.reverify || REVERIFY;

  // A concurrent run (cron + a manual click landing together) could double-write
  // or read a half-written row, so serialize. Bail rather than queue: whichever
  // run got here first is already doing the same work.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'another import is already running' };

  try {
    var report = {
      ok: true,
      ranAt: Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      dryRun: !!opts.dryRun,
      written: [], corrected: [], unchanged: 0,
      missing: [], unverified: [], skipped: [], errors: [],
      daysThru: [], goalColors: [], archived: 0,
      materialChanges: [], notified: false
    };

    // Thread bookkeeping for the archive step. Keyed by thread id because Gmail
    // threads the reports whose subject never changes (LEE and WSP both send
    // "Daily sales report for ..." every day), so one thread can hold many days.
    var thrObj = {}, thrBad = {}, thrKeys = {};

    // What we expect to have: every store, for each of the last `reverify` days
    // ending yesterday. Anything left unfilled at the end is a gap.
    var wanted = {};
    var today = _todayInTz();
    for (var d = 1; d <= reverify; d++) {
      var day = _addDays(today, -d);
      for (var addr in STORE_SENDERS) {
        wanted[STORE_SENDERS[addr] + '|' + _iso(day)] = { store: STORE_SENDERS[addr], date: day };
      }
    }

    // Collect one figure set per (store, date). Later emails win, so a
    // restatement sent today supersedes the original send.
    var found = {};
    var messages = _searchMessages();
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var store = _storeFor(msg);
      if (!store) continue;

      var tid = null;
      if (ARCHIVE_AFTER_IMPORT) {
        try { var th = msg.getThread(); tid = th.getId(); thrObj[tid] = th; } catch (_) { tid = null; }
      }

      var parsed;
      try {
        parsed = parseStoreEmail(msg);
      } catch (perr) {
        report.errors.push({ store: store, subject: msg.getSubject(), error: String(perr && perr.message || perr) });
        if (tid) thrBad[tid] = true;
        continue;
      }
      if (!parsed || !parsed.rows || !parsed.rows.length) {
        report.errors.push({ store: store, subject: msg.getSubject(), error: 'no sales/cost figures found' });
        if (tid) thrBad[tid] = true;
        continue;
      }
      // A weekly email yields 7 rows; a daily email yields 1. Same code path.
      for (var r = 0; r < parsed.rows.length; r++) {
        var row = parsed.rows[r];
        var key = store + '|' + _iso(row.date);
        if (tid) thrKeys[tid] = (thrKeys[tid] || []).concat(key);
        var prev = found[key];
        if (!prev || msg.getDate().getTime() >= prev.receivedAt) {
          found[key] = {
            store: store, date: row.date, sales: row.sales, cost: row.cost,
            receivedAt: msg.getDate().getTime(), subject: msg.getSubject()
          };
        }
      }
    }

    // Write. Cache each month's tab + values so a 7-day window spanning a month
    // boundary still only reads each tab once.
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var tabs = {};

    Object.keys(found).sort().forEach(function (key) {
      var f = found[key];
      if (!wanted[key]) return;              // outside the reverify window — ignore
      var tabName = _tabNameFor(f.date);
      if (!tabs[tabName]) {
        var sh = ss.getSheetByName(tabName);
        tabs[tabName] = sh ? { sheet: sh, values: sh.getDataRange().getValues() } : { sheet: null };
      }
      var t = tabs[tabName];
      if (!t.sheet) {
        report.skipped.push({ store: f.store, date: _iso(f.date), reason: 'no tab named "' + tabName + '"' });
        delete wanted[key];
        return;
      }

      var base = SALES_COL_BASES[f.store];
      if (base == null) { report.skipped.push({ store: f.store, date: _iso(f.date), reason: 'unknown store' }); return; }

      var rowIdx = _findDayRow(t.values, base, f.date.getDate());
      if (rowIdx < 0) {
        report.skipped.push({ store: f.store, date: _iso(f.date), reason: 'no row for day ' + f.date.getDate() + ' in ' + tabName });
        delete wanted[key];
        return;
      }

      var pair = [
        { col: base + COL_SALES, label: 'sales', value: f.sales },
        { col: base + COL_COST,  label: 'cost',  value: f.cost  }
      ];
      var changes = [];
      for (var pi = 0; pi < pair.length; pi++) {
        var cell = pair[pi];
        if (cell.value == null) continue;
        var cur = _num(t.values[rowIdx][cell.col]);

        // SAFETY: never clobber a formula. If someone has wired one of these two
        // cells to a calculation, writing a literal would silently break the
        // sheet in a way nobody would notice for weeks.
        var rng = t.sheet.getRange(rowIdx + 1, cell.col + 1);
        if (rng.getFormula()) {
          report.skipped.push({
            store: f.store, date: _iso(f.date), field: cell.label,
            reason: 'cell holds a formula (' + rng.getFormula() + ') — not overwriting'
          });
          continue;
        }

        if (cur != null && Math.abs(cur - cell.value) < 0.005) { report.unchanged++; continue; }
        changes.push({ field: cell.label, from: cur, to: cell.value });
        if (!opts.dryRun) {
          rng.setValue(cell.value);
          t.values[rowIdx][cell.col] = cell.value;
        }
      }

      if (changes.length) {
        var entry = { store: f.store, date: _iso(f.date), changes: changes };
        // A cell that already held a number and now holds a different one is a
        // restatement; an empty cell being filled is a normal first write. The
        // user asked for restatements to be applied silently, so the split
        // exists purely so the run log can answer "how often does this happen".
        var wasRestated = changes.some(function (c) { return c.from != null; });
        (wasRestated ? report.corrected : report.written).push(entry);
      }
      delete wanted[key];
    });

    // Whatever is still in `wanted` had no usable email. Two very different
    // situations, and only one is worth waking anybody up for:
    //   sheet cell already holds a number -> nobody can do anything  -> unverified
    //   sheet cell is empty               -> somebody must key it in  -> missing
    // Collapsing these would mean alerting on days that were hand-entered long
    // before this mailbox existed.
    Object.keys(wanted).forEach(function (k) {
      var w = wanted[k];
      if (EXPECT_FROM && _iso(w.date) < EXPECT_FROM) return;   // no email was ever sent here

      var tabName = _tabNameFor(w.date);
      if (!tabs[tabName]) {
        var sh2 = ss.getSheetByName(tabName);
        tabs[tabName] = sh2 ? { sheet: sh2, values: sh2.getDataRange().getValues() } : { sheet: null };
      }
      var t2 = tabs[tabName];
      var base2 = SALES_COL_BASES[w.store];
      var filled = false;
      if (t2.sheet && base2 != null) {
        var r2 = _findDayRow(t2.values, base2, w.date.getDate());
        if (r2 >= 0) {
          filled = _num(t2.values[r2][base2 + COL_SALES]) != null
                || _num(t2.values[r2][base2 + COL_COST]) != null;
        }
      }
      (filled ? report.unverified : report.missing).push({ store: w.store, date: _iso(w.date) });
    });

    var byDateThenStore = function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : a.store < b.store ? -1 : 1;
    };
    report.missing.sort(byDateThenStore);
    report.unverified.sort(byDateThenStore);

    // Archive the threads whose figures are now safely in the sheet. Anything that
    // failed to parse, or whose store/date could not be written, stays in the inbox
    // on purpose — an unread report is the cheapest "look at this" signal there is.
    if (ARCHIVE_AFTER_IMPORT && !opts.dryRun) {
      var problem = {};
      report.skipped.forEach(function (s) {
        if (s.store && s.date) problem[s.store + '|' + s.date] = true;
      });
      Object.keys(thrObj).forEach(function (tid) {
        if (thrBad[tid]) return;
        var keys = thrKeys[tid] || [];
        if (!keys.length) return;
        for (var k = 0; k < keys.length; k++) if (problem[keys[k]]) return;
        try {
          thrObj[tid].moveToArchive();
          report.archived++;
        } catch (aerr) {
          // Never fail the import over tidying up.
          report.errors.push({ error: 'archive failed: ' + String(aerr && aerr.message || aerr) });
        }
      });
    }

    // Advance each tab's "Days Thru month" counters to match the data now present.
    if (UPDATE_DAYS_THRU) {
      Object.keys(tabs).forEach(function (tabName) {
        var t = tabs[tabName];
        if (!t.sheet) return;
        _syncDaysThru(t, opts.dryRun).forEach(function (d) {
          d.tab = tabName;
          report.daysThru.push(d);
        });
      });
    }

    // Flag any figure that moved by NOTIFY_CHANGE_OVER or more and email it. Runs
    // over both buckets, but only counts changes where a value already existed —
    // `written` entries can carry a mix (sales filled for the first time while cost
    // was restated), so the test is per-change, not per-entry.
    if (NOTIFY_CHANGE_OVER > 0) {
      report.written.concat(report.corrected).forEach(function (e) {
        (e.changes || []).forEach(function (c) {
          if (c.from == null) return;                                  // first fill, not a change
          if (Math.abs(c.to - c.from) < NOTIFY_CHANGE_OVER) return;
          report.materialChanges.push({
            store: e.store, date: e.date, field: c.field,
            from: c.from, to: c.to,
            delta: Math.round((c.to - c.from) * 100) / 100
          });
        });
      });
      if (report.materialChanges.length && !opts.dryRun) {
        try {
          _sendChangeAlert(report.materialChanges);
          report.notified = true;
        } catch (nerr) {
          // Never fail an import over a notification.
          report.errors.push({ error: 'change alert failed: ' + String(nerr && nerr.message || nerr) });
        }
      }
    }

    // Recolour the goal-tracking cells. Runs last, after the figures and the
    // day counter are in, so the percentage it reads is the current one.
    if (COLOR_GOAL_CELLS) {
      Object.keys(tabs).forEach(function (tabName) {
        var t = tabs[tabName];
        if (!t.sheet) return;
        _syncGoalColors(t, opts.dryRun).forEach(function (c) {
          c.tab = tabName;
          report.goalColors.push(c);
        });
      });
    }

    return report;
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------
// Parsing
// ------------------------------------------------------------
// Returns { rows: [ { date, sales, cost } ] }.
//
// Deliberately one seam: everything above is format-agnostic, so confirming the
// real email shape only ever changes this function and the *_LABELS lists.
function parseStoreEmail(msg) {
  var body = _plainBody(msg);

  // Preferred: the month-to-date list, one dated row per day.
  //   "August 01, 2026 — Net sales: $968.92 COGS: $539.38"
  var rows = _parseDatedRows(body);
  if (rows.length) return { rows: rows };

  // Fallback: the original single-figure daily format, for any store whose Flow
  // template has not been switched to the MTD list yet. Both formats coexist
  // during the rollout and neither needs the other to be finished first.
  var date  = _periodDate(body, msg.getDate());
  var sales = _findLabeled(body, SALES_LABELS);
  var cost  = _findLabeled(body, COST_LABELS);
  if (sales == null && cost == null) return { rows: [] };
  return { rows: [{ date: date, sales: sales, cost: cost }] };
}

// Splits a body into one row per dated figure set.
//
// Segments on the DATES rather than on newlines: once some templates' HTML is
// flattened the whole list can arrive as a single line, and splitting by line
// would then find one date and silently drop every other day.
//
// Dates being present per row is what makes this safe. A day Flow omits is simply
// a day not reported — handled by the missing/unverified split — rather than
// shifting every following day's figures onto the wrong row, which is what
// positional parsing of an undated list would do, silently, for a whole month.
//
// CONSTRAINT: a header line must not carry figures. A "Reporting period: A to B"
// header is fine (its segment holds no numbers and is skipped), but putting a
// total on that line would attribute it to date B.
function _parseDatedRows(body) {
  var re = new RegExp(
    '(20\\d{2}-\\d{2}-\\d{2}'
    + '|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\s+\\d{1,2},?\\s*20\\d{2}'
    + '|\\d{1,2}\\/\\d{1,2}\\/20\\d{2})', 'gi');

  var marks = [], m;
  while ((m = re.exec(body)) !== null) marks.push({ idx: m.index, txt: m[0] });

  var out = [];
  for (var i = 0; i < marks.length; i++) {
    var seg = body.slice(marks[i].idx, (i + 1 < marks.length) ? marks[i + 1].idx : body.length);
    var d = _parseDateToken(marks[i].txt);
    if (!d) continue;
    var sales = _findLabeled(seg, SALES_LABELS);
    var cost  = _findLabeled(seg, COST_LABELS);
    if (sales == null && cost == null) continue;   // a header or footer date
    out.push({ date: d, sales: sales, cost: cost });
  }
  return out;
}

// Gmail's getPlainBody() already strips most HTML, but scheduled Shopify reports
// are table-heavy, so collapse whitespace to make label/value adjacency reliable.
function _plainBody(msg) {
  var body = '';
  try { body = msg.getPlainBody() || ''; } catch (e) {}
  if (!body) body = String(msg.getBody() || '').replace(/<[^>]+>/g, ' ');
  return body.replace(/ /g, ' ').replace(/[ \t]+/g, ' ');
}

// Finds the first "<label> ... <number>" on the same line, trying labels in
// order so "net sales" wins over the looser "sales".
function _findLabeled(body, labels) {
  var lines = body.split(/\r?\n/);
  for (var li = 0; li < labels.length; li++) {
    var re = new RegExp(labels[li].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^0-9\\-(]{0,20}(\\(?-?\\$?\\s*[0-9][0-9,]*(?:\\.[0-9]{1,2})?\\)?)', 'i');
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(re);
      if (m) { var v = _money(m[1]); if (v != null) return v; }
    }
  }
  return null;
}

// The money value belonging to `label`, refusing to read past the next field.
//
// `stopLabels` is the guard that matters. A pure distance window CANNOT work
// here: whitespace gets collapsed before matching, so a label with no value of
// its own sits one space away from the next field and quietly captures ITS
// number — wrong data that looks perfectly fine in the sheet, rather than a
// visible blank. Truncating at the next known label makes that impossible
// regardless of how the HTML flattened.
//
// Requires a literal "$". The Day End Report writes its money with one, and
// insisting on it keeps counters like "Transactions: 14" from being read as a
// dollar figure.
function _valueAfterLabel(text, label, stopLabels, win) {
  var esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var at = String(text).search(new RegExp(esc, 'i'));
  if (at < 0) return null;
  var seg = String(text).substr(at + label.length, win);
  (stopLabels || []).forEach(function (lab) {
    var e2 = lab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var i2 = seg.search(new RegExp(e2, 'i'));
    if (i2 >= 0) seg = seg.slice(0, i2);
  });
  var m = seg.match(/(\(?-?\$\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?\)?)/);
  return m ? _money(m[1]) : null;
}

// Same line first, then the whole body flattened.
//
// The Day End Report is an HTML table and getPlainBody() commonly drops each
// cell onto its own line, so "Total Spent" and "$2,972.00" can land on
// DIFFERENT lines where a same-line matcher finds nothing. The flattened pass
// recovers that layout; the stop-labels keep it honest.
function _findLabeledNear(body, labels, stopLabels, windowChars) {
  var lines = String(body || '').split(/\r?\n/);
  for (var li = 0; li < labels.length; li++) {
    for (var i = 0; i < lines.length; i++) {
      var v = _valueAfterLabel(lines[i], labels[li], stopLabels, 25);
      if (v != null) return v;
    }
  }
  var flat = String(body || '').replace(/\s+/g, ' ');
  for (var lj = 0; lj < labels.length; lj++) {
    var v2 = _valueAfterLabel(flat, labels[lj], stopLabels, windowChars || 60);
    if (v2 != null) return v2;
  }
  return null;
}

// Same two passes as _findLabeledNear, for a COUNT rather than a money figure.
//
// A separate function rather than a flag on that one, because the two want
// opposite things from the text: money must carry a "$" to be believed, and a
// review count must NOT — insisting on the dollar sign is precisely what keeps
// "Transactions: 14" out of the buy column, and allowing it here would let a
// revenue figure into the reviews column just as easily.
function _countAfterLabel(text, label, stopLabels, win) {
  var esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var at = String(text).search(new RegExp(esc, 'i'));
  if (at < 0) return null;
  var seg = String(text).substr(at + label.length, win);
  (stopLabels || []).forEach(function (lab) {
    var e2 = lab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var i2 = seg.search(new RegExp(e2, 'i'));
    if (i2 >= 0) seg = seg.slice(0, i2);
  });
  // The first number after the label, and it has to be a bare whole one. Three
  // things sit near a review figure in this report and none of them is the count:
  // a star rating (4.8), a money figure ($1,204.00), and the day-over-day deltas
  // the statistics block renders as "0▼ 100%". Any of them would land in the
  // sheet looking entirely plausible. Refusing outright is right rather than
  // skipping to the next number: the run reports a miss, which is visible, where
  // a wrong count is not.
  var m = seg.match(/(\$?)\s*(\d[\d,]*)(\.\d+)?\s*(%?)/);
  if (!m || m[1] || m[3] || m[4]) return null;
  var n = parseInt(m[2].replace(/,/g, ''), 10);
  return isNaN(n) ? null : n;
}

function _findCountNear(body, labels, stopLabels, windowChars) {
  var lines = String(body || '').split(/\r?\n/);
  for (var li = 0; li < labels.length; li++) {
    for (var i = 0; i < lines.length; i++) {
      var v = _countAfterLabel(lines[i], labels[li], stopLabels, 25);
      if (v != null) return v;
    }
  }
  var flat = String(body || '').replace(/\s+/g, ' ');
  for (var lj = 0; lj < labels.length; lj++) {
    var v2 = _countAfterLabel(flat, labels[lj], stopLabels, windowChars || 60);
    if (v2 != null) return v2;
  }
  return null;
}

// Is this plausibly a month-to-date review count for this day? Returns a reason
// to REFUSE, or null to write.
//
// The failure this exists for is the quiet one: a label that matches the store's
// ALL-TIME review total instead of the month's. It parses, it is a whole number,
// it never decreases — everything a sane count does — and it would put an 800
// into a column the hub divides by days elapsed, projecting a month-end figure
// several thousand short of nothing and several thousand past believable.
//
// Two checks, both against the column's own history rather than a fixed ceiling,
// because "normal" differs by store: a count may not go DOWN (month to date
// cannot), and it may not jump further in one day than any store plausibly earns.
// On an empty column neither can fire, which is the one case worth naming: the
// first write of a month has nothing to be checked against and goes in on trust.
function _reviewSanity(values, rcol, rowIdx, value) {
  if (value < 0) return 'negative review count (' + value + ')';
  var prev = null;
  for (var r = rowIdx - 1; r >= 0; r--) {
    // ⚠️ STOP AT THE TOP OF THE DAY BLOCK. Walking up from a day row, the first
    // row whose Date cell is not a day number is the header — and two rows above
    // that sits the GOAL, a plausible whole number in the very same column,
    // directly above the data. Without this the guard read the target as
    // "yesterday's month-to-date" and refused every store on the first real run:
    // "month-to-date reviews went DOWN (40 -> 5)". Column 0 is the tab's own Date
    // column, the same one _findDayRow already trusts to locate a day.
    var day = _num(values[r][0]);
    if (day == null || day < 1 || day > 31) break;
    var v = _num(values[r][rcol]);
    if (v != null) { prev = v; break; }
  }
  if (prev == null) return null;
  if (value < prev) {
    return 'month-to-date reviews went DOWN (' + prev + ' -> ' + value
      + '), so this is probably not a month-to-date figure';
  }
  if (value - prev > REVIEW_MAX_JUMP) {
    return 'reviews jumped ' + (value - prev) + ' in a day (' + prev + ' -> ' + value
      + '), past REVIEW_MAX_JUMP — likely an all-time total, not month to date';
  }
  return null;
}

// One Day End Report -> { store, date, buy, sell, reviews }.
//
// Store and date both come from the SUBJECT (see _buyParseSubject) — the body
// is only read for the two figures. Returns an object carrying `ok:false` and a
// reason rather than throwing, so one malformed email cannot abort the run.
function parseBuyingEmail(msg) {
  var sub = _buyParseSubject(msg.getSubject());
  if (!sub.ok) return { ok: false, reason: sub.why, store: sub.store, date: sub.date };

  // Each field stops at the other's label, so neither can borrow the other's
  // number when one of them is missing from the report.
  var body = _plainBody(msg);
  var buy  = _findLabeledNear(body, SPENT_LABELS, ESTVAL_LABELS);
  var sell = _findLabeledNear(body, ESTVAL_LABELS, SPENT_LABELS);
  if (buy == null && sell == null) {
    return { ok: false, reason: 'no "Total Spent" / "Estimated Value" figures found', store: sub.store, date: sub.date };
  }
  // Reviews are additive, never required. A report that predates the reviews line,
  // or a wording this file has not learned yet, must leave buying working exactly
  // as it did — the whole point of folding this in here rather than standing up a
  // third feed for one number.
  var reviews = _findCountNear(body, REVIEW_LABELS, REVIEW_STOPS);
  // Cash is additive in exactly the same way, and for the same reason: it must
  // never be able to cost the buying import. Every field is independently
  // optional and a total miss returns three nulls.
  var cash = _parseCash(body);
  // Conversion fractions, likewise optional. They do not go to the Buy tab at
  // all — they are banked on the Conversions tab so the weekly run can total a
  // month of them into Summary S and U.
  var conv = _convFromBody(body);
  return { ok: true, store: sub.store, date: sub.date, buy: buy, sell: sell,
    reviews: reviews, cash: cash, cust: conv.cust, dev: conv.dev };
}

// The three closing-cash figures. Returns an object of three nullable numbers
// plus `why` when the report's own total disagrees with drawer + safe.
//
// Each field passes the other two as stop labels, so a card that is present but
// empty cannot borrow the next card's number — the same guard the buy/sell pair
// needed, and for the same reason: getPlainBody() collapses the whitespace that
// would otherwise separate them.
function _parseCash(body) {
  var drawer = _findLabeledNear(body, CASH_DRAWER_LABELS, CASH_STOPS);
  var safe   = _findLabeledNear(body, CASH_SAFE_LABELS,   CASH_STOPS);
  var total  = _findLabeledNear(body, CASH_TOTAL_LABELS,  CASH_STOPS);

  var why = null;
  if (total != null && drawer != null && safe != null &&
      Math.abs(total - (drawer + safe)) > CASH_TOTAL_TOLERANCE) {
    // Not corrected — a total that does not add up is the signal that one of the
    // three was read off the wrong card, and quietly recomputing it would erase
    // the only evidence.
    why = 'total ' + total + ' != drawer ' + drawer + ' + safe ' + safe;
  }
  return { drawer: drawer, safe: safe, total: total, why: why };
}
function _cashEmpty(c) {
  return !c || (c.drawer == null && c.safe == null && c.total == null);
}

// Which day does this email actually report on?
//
// The 5 Shopify Flow templates are each worded differently and only ONE states
// its reporting period explicitly, so precedence matters. Observed 2026-08-04:
//   BAL  "Reporting period: August 3, 2026 (yesterday)"  <- explicit, best case
//   MPL  "Yesterday's Performance" + "Report generated on August 04, 2026"
//   OVL  "Yesterday's Performance"                        <- no date at all
//   LEE  "Sales summary for the previous day:"            <- no date at all
//   WSP  "Sales summary for the previous day:"            <- no date at all
//
// The trap is MPL: a naive date search finds the GENERATION date and books the
// figures a day late, forever. So an explicit reporting period wins first, then
// the yesterday/previous-day wording, and only then a bare date — with any line
// mentioning generation stripped out before looking.
function _periodDate(body, receivedAt) {
  var received = _dateInTz(receivedAt);

  // 1. An explicit period is authoritative and survives a late or re-sent email.
  var m = body.match(/report(?:ing)?\s*period[:\s]*([A-Za-z]{3,9}\s+\d{1,2},?\s*20\d{2}|20\d{2}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/20\d{2})/i);
  if (m) { var d = _parseDateToken(m[1]); if (d) return d; }

  // 2. "yesterday" / "previous day" is relative to when the report was sent.
  //    Covers 4 of the 5 templates. Note the curly apostrophe in "Yesterday's".
  if (/yesterday|previous day|prior day/i.test(body)) return _addDays(received, -1);

  // 3. A bare date, ignoring lines that are clearly about when it was generated.
  var cleaned = body.split(/\r?\n/).filter(function (l) {
    return !/generat|created|sent\s+on|as\s+of/i.test(l);
  }).join('\n');
  var bare = _parseDateToken(cleaned);
  if (bare) return bare;

  // 4. These are all previous-day reports, so this is the safe default.
  return _addDays(received, -1);
}

// Pulls the first date out of a string in any of the three formats seen.
function _parseDateToken(s) {
  if (!s) return null;
  var m = String(s).match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);

  // The ordinal suffix is not optional decoration — the PayMore Day End Report
  // writes "August 5th 2026" in its subject, and without `(?:st|nd|rd|th)?` the
  // day and the year stop being adjacent and this branch fails to match at all.
  // Strictly more permissive, so the Shopify formats are unaffected.
  m = String(s).match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(20\d{2})\b/i);
  if (m) {
    var mi = MONTHS.indexOf(m[1].charAt(0).toUpperCase() + m[1].substr(1, 2).toLowerCase());
    if (mi >= 0) return new Date(+m[3], mi, +m[2]);
  }

  m = String(s).match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
  return null;
}

function _money(s) {
  if (s == null) return null;
  s = String(s).trim();
  var neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[()$,\s-]/g, '');
  if (!s) return null;
  var n = parseFloat(s);
  if (isNaN(n)) return null;
  return neg ? -n : n;
}

// ------------------------------------------------------------
// Buying ingest
// ------------------------------------------------------------
// Same report shape and the same safety guards as ingestSalesEmails (day matched
// out of the block's own Date column, formulas never overwritten, LockService,
// Chicago day math) — but against the "Buy {Mon} {YY}" tab and its 5-wide blocks.
function ingestBuyingEmails(opts) {
  opts = opts || {};
  var back = opts.backfill || BUY_BACKFILL;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'another import is already running' };

  try {
    var report = {
      ok: true, kind: 'buying',
      ranAt: Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      dryRun: !!opts.dryRun,
      written: [], corrected: [], unchanged: 0,
      missing: [], unverified: [], skipped: [], errors: [], daysThru: [], archived: 0,
      // Closing cash per store per day. Carried OUT of this script rather than
      // written to the sheet — sales-ingest lands it in `store_cash`.
      cash: []
    };

    // Thread bookkeeping for the archive step, same shape as the sales pass.
    // Keyed by thread id because Gmail groups messages whose subject repeats.
    var thrObj = {}, thrBad = {}, thrKeys = {};

    // Every store, for each of the last `back` days ending yesterday. Today is
    // never wanted: the report is generated an hour after close, so today's does
    // not exist yet and a partial day must never reach the sheet.
    var wanted = {};
    var today = _todayInTz();
    for (var d = 1; d <= back; d++) {
      var day = _addDays(today, -d);
      for (var code in BUY_STORE_CODES) {
        wanted[BUY_STORE_CODES[code] + '|' + _iso(day)] = { store: BUY_STORE_CODES[code], date: day };
      }
    }

    // Later email wins, matching the sales path — if a store's report is ever
    // re-sent, the newer copy supersedes.
    var found = {};
    var messages = _searchBuyingMessages();
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];

      // Is this one of ours at all? The search matches on subject as well as
      // sender to catch forwards, which can also drag in unrelated mail — and
      // unrelated mail must never be touched, let alone archived.
      var mine = String(msg.getFrom() || '').toLowerCase().indexOf(BUY_SENDER) !== -1
        || DAY_END_SUBJECT.test(String(msg.getSubject() || ''));

      // pmdev.site does not only send the Day End Report. The WEEKLY report goes
      // out from the same address on Saturday evenings, and its subject carries a
      // store code and a date in exactly the same shape — so _buyParseSubject
      // accepts it, the body says "Total Spent" and "Estimated Value" just like
      // the daily one, and its WEEK totals land in Saturday's Buy/Sell cells.
      // Both reports fire an hour after close, minutes apart, and the later one
      // wins: a coin flip, not a rare edge case. The weekly pass owns these
      // emails, so leave them alone AND unarchived (no tid taken below).
      if (!DAY_END_SUBJECT.test(String(msg.getSubject() || ''))) {
        report.ignored = (report.ignored || 0) + 1;
        continue;
      }

      var tid = null;
      if (ARCHIVE_AFTER_IMPORT && mine) {
        try { var th = msg.getThread(); tid = th.getId(); thrObj[tid] = th; } catch (_) { tid = null; }
      }

      var parsed;
      try {
        parsed = parseBuyingEmail(msg);
      } catch (perr) {
        report.errors.push({ subject: msg.getSubject(), error: String(perr && perr.message || perr) });
        if (tid) thrBad[tid] = true;
        continue;
      }
      if (!parsed.ok) {
        // Only worth reporting if it looked like one of ours; unrelated mail
        // caught by the subject search is silently ignored.
        if (mine) {
          report.errors.push({ subject: msg.getSubject(), error: parsed.reason });
          if (tid) thrBad[tid] = true;
        }
        continue;
      }
      var key = parsed.store + '|' + _iso(parsed.date);
      if (tid) thrKeys[tid] = (thrKeys[tid] || []).concat(key);
      var prev = found[key];
      if (!prev || msg.getDate().getTime() >= prev.receivedAt) {
        found[key] = {
          store: parsed.store, date: parsed.date, buy: parsed.buy, sell: parsed.sell,
          reviews: parsed.reviews, cash: parsed.cash,
          cust: parsed.cust, dev: parsed.dev,
          receivedAt: msg.getDate().getTime(), subject: msg.getSubject()
        };
      }
    }

    var ss = SpreadsheetApp.openById(SHEET_ID);
    var tabs = {};

    Object.keys(found).sort().forEach(function (key) {
      var f = found[key];
      if (!wanted[key]) return;                 // outside the window — ignore

      // CASH IS COLLECTED BEFORE ANY SHEET WORK, deliberately. It does not go to
      // the sheet at all, so a missing tab, a formula in the way or a day row
      // that cannot be located must not cost the morning's cash figures — every
      // one of those returns early below.
      // Banked before any Buy-tab work, for the same reason as cash: a missing
      // tab or an unlocatable day row must not cost the morning's conversions,
      // which live on a different tab entirely and are the only record feeding
      // Summary S/U.
      _convWrite(ss, f.store, f.date, f.cust, f.dev, opts.dryRun, report);

      if (!_cashEmpty(f.cash)) {
        report.cash.push({
          store: f.store, date: _iso(f.date),
          drawer: f.cash.drawer, safe: f.cash.safe, total: f.cash.total
        });
        if (f.cash.why) {
          (report.warnings = report.warnings || []).push({
            store: f.store, date: _iso(f.date), field: 'cash', reason: f.cash.why
          });
        }
      }

      var tabName = _buyTabNameFor(f.date);
      if (!tabs[tabName]) {
        var sh = ss.getSheetByName(tabName);
        tabs[tabName] = sh ? { sheet: sh, values: sh.getDataRange().getValues() } : { sheet: null };
      }
      var t = tabs[tabName];
      if (!t.sheet) {
        report.skipped.push({ store: f.store, date: _iso(f.date), reason: 'no tab named "' + tabName + '"' });
        delete wanted[key];
        return;
      }

      var base = BUY_COL_BASES[f.store];
      if (base == null) { report.skipped.push({ store: f.store, date: _iso(f.date), reason: 'unknown store' }); return; }

      // Day located by matching the number in this block's own Date column. On
      // the Buy tab this also keeps the write out of the B2B section further
      // down, which reuses the same Buy/Sell/GM columns — _findDayRow stops at
      // the TTL row well above it.
      var rowIdx = _findDayRow(t.values, base, f.date.getDate());
      if (rowIdx < 0) {
        report.skipped.push({ store: f.store, date: _iso(f.date), reason: 'no row for day ' + f.date.getDate() + ' in ' + tabName });
        delete wanted[key];
        return;
      }

      var pair = [
        { col: base + COL_BUY,  label: 'buy',  value: f.buy  },
        { col: base + COL_SELL, label: 'sell', value: f.sell }
      ];

      // Google reviews ride the same row, in their own block further right. Two
      // gates before the value is allowed to join the write list, both of which
      // report rather than throw:
      //
      //   1. The block has to EXIST. getRange() throws on a column past the end
      //      of the sheet, and this runs inside the import — so on a tab that has
      //      not had the reviews columns added yet, an unguarded read would take
      //      down buy and sell too, for a number that is a bonus.
      //   2. The figure has to behave like a month-to-date count. See
      //      _reviewSanity; a wrong number here is invisible in a way a missing
      //      one is not.
      var rcol = REVIEW_COL_BASES[f.store];
      if (f.reviews != null && rcol != null) {
        if (t.sheet.getMaxColumns() <= rcol) {
          report.skipped.push({
            store: f.store, date: _iso(f.date), field: 'reviews',
            reason: 'the Google Reviews block (cols AE-AK) is not on "' + tabName + '" yet'
          });
        } else {
          var rWhy = _reviewSanity(t.values, rcol, rowIdx, f.reviews);
          if (rWhy) {
            (report.warnings = report.warnings || []).push({
              store: f.store, date: _iso(f.date), field: 'reviews',
              value: f.reviews, reason: rWhy
            });
          } else {
            pair.push({ col: rcol, label: 'reviews', value: f.reviews });
          }
        }
      }

      var changes = [];
      for (var pi = 0; pi < pair.length; pi++) {
        var cell = pair[pi];
        if (cell.value == null) continue;
        var cur = _num(t.values[rowIdx][cell.col]);

        // GM and the week-total column are formulas; Buy/Sell should not be. If
        // one ever is, refuse — writing a literal over it breaks the sheet in a
        // way nobody would notice for weeks.
        var rng = t.sheet.getRange(rowIdx + 1, cell.col + 1);
        if (rng.getFormula()) {
          report.skipped.push({
            store: f.store, date: _iso(f.date), field: cell.label,
            reason: 'cell holds a formula (' + rng.getFormula() + ') — not overwriting'
          });
          continue;
        }

        if (cur != null && Math.abs(cur - cell.value) < 0.005) { report.unchanged++; continue; }
        changes.push({ field: cell.label, from: cur, to: cell.value });
        if (!opts.dryRun) {
          rng.setValue(cell.value);
          t.values[rowIdx][cell.col] = cell.value;
        }
      }

      if (changes.length) {
        var entry = { store: f.store, date: _iso(f.date), changes: changes };
        // Buying does not restate, so a cell that already held a DIFFERENT
        // number is not a normal correction — it means someone hand-keyed a
        // value that disagrees with the report. Worth separating.
        var overwrote = changes.some(function (c) { return c.from != null; });
        if (overwrote) report.corrected.push(entry); else report.written.push(entry);
      }
      delete wanted[key];
    });

    // Advance each touched month's "Days thru Month" once the figures are in,
    // so the counter reflects what was just written rather than the prior state.
    if (UPDATE_BUY_DAYS_THRU) {
      Object.keys(tabs).forEach(function (tabName) {
        var t = tabs[tabName];
        if (!t.sheet) return;
        // Any date inside this tab's month serves as the weekday reference.
        var ref = null;
        Object.keys(found).forEach(function (k) {
          if (!ref && _buyTabNameFor(found[k].date) === tabName) ref = found[k].date;
        });
        if (!ref) return;
        _syncBuyDaysThru(t, ref, opts.dryRun).forEach(function (d) {
          d.tab = tabName;
          report.daysThru.push(d);
        });
        var chk = _buyPlannedCheck(t, ref);
        if (chk) { chk.tab = tabName; (report.warnings = report.warnings || []).push(chk); }
      });
    }

    // Whatever is still wanted had no email. The sheet decides whether that is
    // actionable: a blank cell means somebody must key it in; a filled one means
    // it was entered by hand and there is nothing to do.
    Object.keys(wanted).forEach(function (key) {
      var w = wanted[key];
      var tabName = _buyTabNameFor(w.date);
      var t = tabs[tabName];
      if (!t) {
        var sh = ss.getSheetByName(tabName);
        t = tabs[tabName] = sh ? { sheet: sh, values: sh.getDataRange().getValues() } : { sheet: null };
      }
      if (!t.sheet) { report.skipped.push({ store: w.store, date: _iso(w.date), reason: 'no tab named "' + tabName + '"' }); return; }
      var base = BUY_COL_BASES[w.store];
      var rowIdx = _findDayRow(t.values, base, w.date.getDate());
      var filled = rowIdx >= 0 && _num(t.values[rowIdx][base + COL_BUY]) != null;
      (filled ? report.unverified : report.missing).push({ store: w.store, date: _iso(w.date) });
    });

    // Archive the threads whose figures are safely in the sheet — same rules as
    // the sales pass. Archiving only removes the INBOX label, and GmailApp
    // searches all mail, so the 3-day window still re-reads these afterwards.
    // Anything that failed to parse, or whose store/date could not be written,
    // stays in the inbox on purpose: an unread report is the cheapest possible
    // "a human should look at this" signal.
    if (ARCHIVE_AFTER_IMPORT && !opts.dryRun) {
      var problem = {};
      report.skipped.forEach(function (s) {
        if (s.store && s.date) problem[s.store + '|' + s.date] = true;
      });
      Object.keys(thrObj).forEach(function (tid) {
        if (thrBad[tid]) return;
        var keys = thrKeys[tid] || [];
        if (!keys.length) return;                      // nothing parsed off it
        for (var k = 0; k < keys.length; k++) if (problem[keys[k]]) return;
        try {
          thrObj[tid].moveToArchive();
          report.archived++;
        } catch (aerr) {
          // Never fail the import over tidying up.
          report.errors.push({ error: 'archive failed: ' + String(aerr && aerr.message || aerr) });
        }
      });
    }

    return report;
  } finally {
    lock.releaseLock();
  }
}

// Sender OR subject. From 2026-08-07 these arrive straight from pmdev.site, but
// the first day's were forwarded from another mailbox, so `from:` alone would
// miss them. Keeping both also means a future re-forward cannot break the feed.
function _searchBuyingMessages() {
  var q = '(from:(' + BUY_SENDER + ') OR subject:("Day End Report")) newer_than:' + LOOKBACK + 'd';
  var out = [];
  GmailApp.search(q, 0, 200).forEach(function (thread) {
    thread.getMessages().forEach(function (m) { out.push(m); });
  });
  out.sort(function (a, b) { return a.getDate().getTime() - b.getDate().getTime(); });
  return out;
}

function _buyTabNameFor(date) {
  return 'Buy ' + MONTHS[date.getMonth()] + ' ' + String(date.getFullYear()).slice(-2);
}

// Non-Sunday days elapsed for one store block — see UPDATE_BUY_DAYS_THRU.
//
// Counted 1..lastDay rather than "how many cells are filled", so a single
// missed day cannot shrink the denominator and flatter the projection. Sundays
// are skipped when finding lastDay too: they carry a pre-entered $0 for the
// whole month ahead, so counting them would jump the figure to month-end on
// day one.
// Counted over the SPAN 1..lastDay rather than "cells that have a figure", and
// that is what makes the unplanned-closure rule work: a storm day sitting inside
// the span still counts whether it arrived as $0 or never arrived at all. Only
// days named as planned closures drop out.
//
// Planned closures are also skipped when finding lastDay — they are pre-zeroed
// for the whole month ahead, so counting them would jump the figure to month-end
// on day one.
//
// One known lag: if the storm day is the MOST RECENT day, lastDay stops short of
// it and it goes uncounted until any later day reports. It self-corrects, and
// the month-end total is right either way. That is deliberate — advancing the
// denominator off the calendar instead would penalise the store whenever an
// email merely failed to arrive, which is the case the sales twin guards against.
function _buyDaysThru(values, base, refDate) {
  var y = refDate.getFullYear(), m = refDate.getMonth();
  var last = 0;
  for (var r = HEADER_ROWS; r < values.length; r++) {
    var first = String(values[r][0]).trim().toUpperCase();
    if (first === 'TTL' || first.indexOf('TRACKING') === 0) break;
    var day = parseInt(values[r][base], 10);
    if (isNaN(day) || day < 1 || day > 31) continue;
    if (_isPlannedClosure(y, m, day)) continue;
    if (_num(values[r][base + COL_BUY]) != null && day > last) last = day;
  }
  if (!last) return 0;
  var n = 0;
  for (var d = 1; d <= last; d++) if (!_isPlannedClosure(y, m, d)) n++;
  return n;
}

// Cross-check: the hand-entered "Buying Days in Month" should equal the planned
// working days BUY_CLOSED_DATES implies. A disagreement almost always means a
// holiday is missing from the list (or was added to the sheet but not here), and
// catching it on the 1st is worth far more than discovering it at month end.
// Reports only — never writes, since that cell stays manual for now.
function _buyPlannedCheck(t, refDate) {
  var values = t.values;
  var want = _buyPlannedDaysInMonth(refDate);
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < Math.min(values[r].length, 8); c++) {
      if (typeof values[r][c] !== 'string' || !/buying\s*days\s*in\s*month/i.test(values[r][c])) continue;
      var cur = _num(values[r][BUY_COL_BASES.OVL + BUY_DAYS_THRU_COL] === undefined
        ? null : values[r][BUY_COL_BASES.OVL + BUY_DAYS_THRU_COL]);
      if (cur == null || cur === want) return null;
      return {
        note: 'Buying Days in Month disagrees with the closed-dates list',
        sheet: cur, expected: want,
        hint: cur < want
          ? 'the sheet excludes ' + (want - cur) + ' more day(s) than BUY_CLOSED_DATES knows about — add the holiday(s)'
          : 'BUY_CLOSED_DATES excludes ' + (cur - want) + ' day(s) the sheet still counts'
      };
    }
  }
  return null;
}

// Writes each store block's "Days thru Month". The label is merged across
// B:D and appears ONCE, while the five values sit at base+4 per block — so the
// row is located by label and the columns come from the block geometry, rather
// than the sales approach of "find a label, write the cell beside it".
//
// Anything holding a formula is skipped and reported: on the Sales tab only the
// first block is a literal and the rest chain off it, and the Buy tab may well
// be wired the same way.
function _syncBuyDaysThru(t, refDate, dryRun) {
  var out = [];
  var values = t.values;

  // If SPEEKS could not be reached, the closure list is UNKNOWN, not empty.
  // Writing anyway would silently count a holiday as a working day; skipping
  // leaves yesterday's figure standing, and tomorrow's run puts it right.
  if (_buyClosedDays(refDate.getFullYear(), refDate.getMonth()) === null) {
    out.push({ skipped: 'closed-day list unavailable — Days thru Month left alone this run' });
    return out;
  }

  var row = -1;
  for (var r = 0; r < values.length && row < 0; r++) {
    for (var c = 0; c < Math.min(values[r].length, 8); c++) {
      // "Buying Days in Month" sits directly above and must NOT match — it is
      // the month's total, not the elapsed count. The regex needs "days thru
      // month" contiguously, so "Days in Month" falls through.
      if (typeof values[r][c] === 'string' && DAYS_THRU_LABEL.test(values[r][c])) { row = r; break; }
    }
  }
  if (row < 0) return out;

  Object.keys(BUY_COL_BASES).forEach(function (store) {
    var base = BUY_COL_BASES[store];
    var col  = base + BUY_DAYS_THRU_COL;
    var want = _buyDaysThru(values, base, refDate);
    if (!want) return;                       // no buy data in this block yet

    var rng = t.sheet.getRange(row + 1, col + 1);
    if (rng.getFormula()) {
      out.push({ store: store, a1: rng.getA1Notation(), skipped: 'holds a formula: ' + rng.getFormula() });
      return;
    }
    var cur = _num(values[row][col]);
    if (cur === want) return;
    out.push({ store: store, a1: rng.getA1Notation(), from: cur, to: want });
    if (!dryRun) { rng.setValue(want); values[row][col] = want; }
  });
  return out;
}

// ------------------------------------------------------------
// Gmail
// ------------------------------------------------------------
// Searches ALL mail, not just the inbox — archiving or re-filing these emails
// cannot break the import. Only spam/trash are excluded by Gmail itself.
function _searchMessages() {
  var senders = Object.keys(STORE_SENDERS);
  if (!senders.length) return [];
  var q = 'from:(' + senders.join(' OR ') + ') newer_than:' + LOOKBACK + 'd';
  var out = [];
  GmailApp.search(q, 0, 200).forEach(function (thread) {
    thread.getMessages().forEach(function (m) { out.push(m); });
  });
  // Oldest first, so "later email wins" falls out of iteration order naturally.
  out.sort(function (a, b) { return a.getDate().getTime() - b.getDate().getTime(); });
  return out;
}

function _storeFor(msg) {
  var from = String(msg.getFrom() || '').toLowerCase();
  for (var addr in STORE_SENDERS) {
    if (from.indexOf(addr.toLowerCase()) !== -1) return STORE_SENDERS[addr];
  }
  return null;
}

// ------------------------------------------------------------
// Sheet helpers
// ------------------------------------------------------------
function _tabNameFor(date) {
  return 'Sales ' + MONTHS[date.getMonth()] + ' ' + String(date.getFullYear()).slice(-2);
}

// Locate the row by matching the day number in the block's own Date column
// rather than trusting a fixed start row — an inserted row in the sheet would
// otherwise shift every write by one and corrupt a month silently.
function _findDayRow(values, base, day) {
  for (var r = HEADER_ROWS; r < values.length; r++) {
    var first = String(values[r][0]).trim().toUpperCase();
    if (first === 'TTL' || first.indexOf('TRACKING') === 0) break;  // past the day rows
    var v = parseInt(values[r][base], 10);
    if (v === day) return r;
  }
  return -1;
}

function _num(v) {
  if (v === '' || v == null) return null;
  var n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}

// The furthest day-of-month in this tab that has a Sales figure for one store.
function _lastDayWithSales(values, base) {
  var last = 0;
  for (var r = HEADER_ROWS; r < values.length; r++) {
    var first = String(values[r][0]).trim().toUpperCase();
    if (first === 'TTL' || first.indexOf('TRACKING') === 0) break;
    var day = parseInt(values[r][base], 10);
    if (isNaN(day) || day < 1 || day > 31) continue;
    if (_num(values[r][base + COL_SALES]) != null && day > last) last = day;
  }
  return last;
}

// Which store block does a column fall inside? Blocks are 11 wide; anything
// outside the five known ones (the TTL group) returns null.
function _blockBaseFor(col) {
  var hit = null;
  Object.keys(SALES_COL_BASES).forEach(function (s) {
    var b = SALES_COL_BASES[s];
    if (col >= b && col < b + 11 && (hit === null || b > hit)) hit = b;
  });
  return hit;
}

// ------------------------------------------------------------
// Material-change email
// ------------------------------------------------------------
// One email per run listing every qualifying change, rather than one per change —
// a busy morning would otherwise arrive as five separate emails.
function _sendChangeAlert(list) {
  // FOUR columns, not six. At six the table overflowed a phone: the Change column —
  // the one number the email exists to deliver — was pushed off the right edge, and
  // "Aug 5, 2026" wrapped onto three lines in a column squeezed to nothing. Mobile
  // mail clients do not scroll a table sideways, they just clip it.
  //
  // Store and field share a cell, "was" and "now" share a cell, and the year is
  // dropped: these are always recent days, and it was the longest thing in the
  // narrowest column.
  var td = 'padding:10px 8px;border-bottom:1px solid #eaefeb;font-size:14px;'
         + 'vertical-align:top;';
  var rows = list.map(function (m) {
    var up = m.delta > 0;
    // Colour only once a change is worth reacting to. Everything here already
    // cleared the reporting threshold, so painting them all red and green made the
    // small ones shout as loudly as the big ones.
    var big = Math.abs(m.delta) >= NOTIFY_BIG_CHANGE;
    var colour = !big ? '#64707c' : (up ? '#17603a' : '#9b2c1f');
    return '<tr>'
      + '<td style="' + td + 'font-weight:700;color:#1a1f24;white-space:nowrap;">'
      + _fmtMDShort(m.date) + '</td>'
      + '<td style="' + td + 'font-weight:700;color:#1a1f24;">' + m.store
      + '<div style="font-weight:600;color:#9aa6ad;font-size:12px;margin-top:2px;">'
      + (m.field === 'cost' ? 'Cost' : 'Sales') + '</div></td>'
      + '<td style="' + td + 'color:#64707c;white-space:nowrap;">'
      + _fmtUsd(m.from) + '<div style="color:#1a1f24;font-weight:700;margin-top:2px;">'
      + _fmtUsd(m.to) + '</div></td>'
      + '<td style="' + td + 'font-weight:800;text-align:right;white-space:nowrap;color:'
      + colour + ';">' + (up ? '+' : '−') + _fmtUsd(Math.abs(m.delta))
      + (big ? '' : '<div style="font-weight:600;color:#9aa6ad;font-size:12px;'
        + 'margin-top:2px;">minor</div>') + '</td></tr>';
  }).join('');

  var one = list.length === 1 ? list[0] : null;
  var subject = one
    ? 'Sales import — ' + one.store + ' ' + _fmtMD(one.date) + ' ' + one.field
      + ' changed by ' + (one.delta > 0 ? '+' : '') + _fmtUsd(one.delta)
    : 'Sales import — ' + list.length + ' changes of ' + _fmtUsd0(NOTIFY_CHANGE_OVER) + ' or more';

  var html = '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;'
    + 'background:#f7faf8;padding:28px;">'
    + '<div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #eaefeb;'
    + 'border-radius:18px;overflow:hidden;">'
    + '<div style="padding:20px 24px;border-bottom:1px solid #eaefeb;">'
    + '<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#1f9d57;'
    + 'font-weight:700;">Sales Import</div>'
    + '<div style="font-size:17px;font-weight:700;color:#1a1f24;margin-top:3px;">'
    + 'Figures already in the sheet have changed</div></div>'
    + '<div style="padding:20px 24px;">'
    + '<p style="margin:0 0 14px;color:#64707c;font-size:14px;line-height:1.5;">'
    + 'Shopify now reports different numbers for the days below, and the sheet has been '
    + 'updated to match. Usually a refund or a late-posting order against a day that was '
    + 'already closed out.</p>'
    + '<table style="width:100%;border-collapse:collapse;table-layout:fixed;">'
    + '<tr>' + _chTh('Day', '19%', '') + _chTh('Store', '26%', '')
    + _chTh('Was &rarr; now', '30%', '') + _chTh('Change', '25%', 'text-align:right;')
    + '</tr>' + rows + '</table>'
    + '<p style="margin:16px 0 0;color:#9aa6ad;font-size:12px;line-height:1.5;">'
    + 'Reported once a figure moves by ' + _fmtUsd0(NOTIFY_CHANGE_OVER)
    + ' or more; shown in green or red once it reaches ' + _fmtUsd0(NOTIFY_BIG_CHANGE)
    + '. A day being filled in for the first time is not counted.</p>'
    + '</div></div></div>';

  // Plain-text alternative, for clients that will not render the HTML.
  var plain = list.map(function (m) {
    return _fmtMD(m.date) + '  ' + m.store + '  ' + m.field
      + ': ' + _fmtUsd(m.from) + ' -> ' + _fmtUsd(m.to)
      + '  (' + (m.delta > 0 ? '+' : '') + _fmtUsd(m.delta) + ')';
  }).join('\n');

  GmailApp.sendEmail(CHANGE_ALERT_TO, subject, plain, {
    htmlBody: html,
    name: 'SPEEKS Sales Import'
  });
}

// NB: _money() above PARSES money out of text. These two format it.
function _fmtUsd(n) {
  var v = Number(n) || 0, neg = v < 0;
  var p = Math.abs(v).toFixed(2).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-$' : '$') + p.join('.');
}

function _fmtMD(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1] : String(iso || '');
}

// No year. These are always days from the last week or so, and "Aug 5, 2026" was
// the longest string in the narrowest column of the change email.
function _fmtMDShort(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? MONTHS[+m[2] - 1] + ' ' + (+m[3]) : String(iso || '');
}

// Whole dollars, for thresholds quoted in prose — "$150.00 or more" reads like a
// figure someone calculated rather than a round number someone chose.
function _fmtUsd0(n) {
  return '$' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Header cell for the change table. Widths are explicit because the table is
// table-layout:fixed — that is what stops a long figure from stealing space and
// pushing the Change column off a phone screen.
function _chTh(label, width, extra) {
  return '<th width="' + width + '" style="padding:0 8px 8px;border-bottom:1px solid #eaefeb;'
    + 'text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;'
    + 'color:#9aa6ad;font-weight:700;' + (extra || '') + '">' + label + '</th>';
}

// Paints each block's goal-tracking pair green (>= 100% of GP goal) or red (below).
// A block whose percentage cannot be read is left exactly as it is rather than
// guessed at — an unpainted cell is honest, a wrongly painted one is not.
function _syncGoalColors(t, dryRun) {
  var out = [];
  for (var i = 0; i < GOAL_CELL_BASES.length; i++) {
    var col = GOAL_CELL_BASES[i] + 4 + 1;                  // +4 = the goal column, +1 = 1-indexed
    var pctCell = t.sheet.getRange(GOAL_PCT_ROW, col);
    var pct = _asPercent(pctCell.getDisplayValue(), pctCell.getValue());
    if (pct == null) continue;

    var color = pct >= 100 ? GOAL_GREEN : GOAL_RED;
    var painted = [];
    for (var r = 0; r < GOAL_FILL_ROWS.length; r++) {
      var cell = t.sheet.getRange(GOAL_FILL_ROWS[r], col);
      painted.push(cell.getA1Notation());
      // Skip the write when the fill is already right, so a no-op run does not
      // rack up a dozen pointless setBackground calls.
      if (!dryRun && String(cell.getBackground()).toLowerCase() !== color) cell.setBackground(color);
    }
    out.push({
      cells: painted.join(' + '),
      pct: Math.round(pct * 100) / 100,
      color: pct >= 100 ? 'green' : 'red'
    });
  }
  return out;
}

// A percent cell can arrive two ways: Sheets stores 124.04% as the number 1.2404,
// but an unformatted cell might hold 124.04 outright. The DISPLAY value settles it
// whenever it carries a "%"; only without one do we fall back to reading the raw
// number as a fraction.
function _asPercent(display, raw) {
  var d = String(display == null ? '' : display).trim();
  if (/%\s*$/.test(d)) {
    var n = parseFloat(d.replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? null : n;
  }
  var v = _num(raw);
  return v == null ? null : v * 100;
}

// Sets every "Days Thru month" cell in a tab to the derived value. A store
// block's counter follows that store's own data, so a store whose email never
// arrived does not get its tracking denominator advanced (which would understate
// its daily average). Cells outside the store blocks — the TTL group — get the
// furthest day any store reached.
function _syncDaysThru(t, dryRun) {
  var out = [];
  var values = t.values;

  var globalLast = 0;
  Object.keys(SALES_COL_BASES).forEach(function (s) {
    var d = _lastDayWithSales(values, SALES_COL_BASES[s]);
    if (d > globalLast) globalLast = d;
  });

  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      if (typeof values[r][c] !== 'string' || !DAYS_THRU_LABEL.test(values[r][c])) continue;

      var base = _blockBaseFor(c);
      var want = base === null ? globalLast : _lastDayWithSales(values, base);
      if (!want) continue;                       // no data in this block yet — leave it alone

      var valCol = c + 1;
      var rng = t.sheet.getRange(r + 1, valCol + 1);
      if (rng.getFormula()) {
        out.push({ a1: rng.getA1Notation(), label: values[r][c], skipped: 'holds a formula: ' + rng.getFormula() });
        continue;
      }
      var cur = _num(values[r][valCol]);
      if (cur === want) continue;
      out.push({ a1: rng.getA1Notation(), label: values[r][c], from: cur, to: want });
      if (!dryRun) {
        rng.setValue(want);
        values[r][valCol] = want;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------
// Date helpers — all day math happens in the store timezone, because the
// script's own clock is UTC and "yesterday" flips 7 hours early otherwise.
// Same trap as [[edge-fn-utc-timezone]].
// ------------------------------------------------------------
function _todayInTz() { return _dateInTz(new Date()); }

function _dateInTz(d) {
  var s = Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd').split('-');
  return new Date(+s[0], +s[1] - 1, +s[2]);
}

function _addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

function _iso(d) {
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

// ============================================================
// DIAGNOSTICS — run these from the Apps Script editor
// ============================================================

// RUN THIS FIRST. Prints exactly what the script can see so the parser can be
// confirmed against reality instead of assumptions: the sender, subject, any
// attachments, every "label: number" pair found in the body, and what the
// current parser extracts. Paste the log back to finalize SALES_LABELS /
// COST_LABELS.
function diagnoseShopifyEmails() {
  var msgs = _searchMessages();
  Logger.log('=== ' + msgs.length + ' message(s) from the 5 configured senders ===');
  if (!msgs.length) {
    Logger.log('NONE FOUND. Most likely one of:');
    Logger.log('  (a) STORE_SENDERS still holds placeholder addresses — run findCandidateSenders()');
    Logger.log('  (b) this mailbox was only just added to the Shopify recipient lists, so');
    Logger.log('      nothing has arrived yet — forward one from Outlook and use diagnoseQuery()');
    Logger.log('  (c) they are landing in spam');
  }
  return _dumpMessages(msgs);
}

// Finds the real sender addresses without needing to know them first. Sweeps the
// mailbox for anything report-shaped and groups by sender, so the 5 store
// addresses stand out. Counts may double up where queries overlap — the address
// list is the point, not the tallies.
function findCandidateSenders() {
  var queries = [
    'newer_than:30d paymore',
    'newer_than:30d (shopify OR "total sales" OR "gross sales" OR "net sales")',
    'newer_than:30d subject:(sales OR summary OR report OR daily)'
  ];
  var seen = {};
  queries.forEach(function (q) {
    var threads = [];
    try {
      threads = GmailApp.search(q, 0, 150);
    } catch (e) {
      Logger.log('query failed: ' + q + ' — ' + e);
      return;
    }
    threads.forEach(function (t) {
      t.getMessages().forEach(function (m) {
        var from = String(m.getFrom() || '');
        var addr = (from.match(/<([^>]+)>/) || [null, from])[1].toLowerCase().trim();
        if (!seen[addr]) seen[addr] = { n: 0, subject: m.getSubject(), last: '' };
        seen[addr].n++;
        seen[addr].last = Utilities.formatDate(m.getDate(), TIMEZONE, 'yyyy-MM-dd HH:mm');
      });
    });
  });

  var rows = Object.keys(seen).map(function (a) { return { addr: a, info: seen[a] }; })
    .sort(function (x, y) { return y.info.n - x.info.n; });

  Logger.log('=== ' + rows.length + ' distinct sender(s) in the last 30 days ===');
  if (!rows.length) Logger.log('Nothing matched. This mailbox has no report-shaped mail yet.');
  rows.forEach(function (r) {
    Logger.log(r.info.n + 'x  ' + r.addr + '   last: ' + r.info.last + '   e.g. "' + r.info.subject + '"');
  });
  return { ok: true, senders: rows };
}

// The Run button in the Apps Script editor cannot pass arguments, so THIS is the
// one to select and run after forwarding an email in — diagnoseQuery() below
// takes a parameter and would receive undefined. Widen DIAGNOSE_QUERY if the
// forward is older than two days.
var DIAGNOSE_QUERY = 'newer_than:2d';

function diagnoseForwarded() {
  return diagnoseQuery(DIAGNOSE_QUERY);
}

// Full dump for an arbitrary Gmail query, so a single forwarded email can be
// inspected before the real sends start arriving. Called by diagnoseForwarded();
// only invoke it directly from other code, never from the Run button.
function diagnoseQuery(query) {
  var msgs = [];
  try {
    GmailApp.search(query, 0, 50).forEach(function (t) {
      t.getMessages().forEach(function (m) { msgs.push(m); });
    });
  } catch (e) {
    Logger.log('search failed: ' + e);
    return { ok: false, error: String(e) };
  }
  msgs.sort(function (a, b) { return a.getDate().getTime() - b.getDate().getTime(); });
  Logger.log('=== ' + msgs.length + ' message(s) matching: ' + query + ' ===');
  return _dumpMessages(msgs);
}

function _dumpMessages(msgs) {
  var out = { ok: true, messages_found: msgs.length, samples: [] };
  msgs.slice(-6).forEach(function (m) {
    var body = _plainBody(m);
    var atts = m.getAttachments().map(function (a) { return a.getName() + ' (' + a.getContentType() + ')'; });
    var parsed = null;
    try { parsed = parseStoreEmail(m); } catch (e) { parsed = { error: String(e) }; }

    var sample = {
      store_matched: _storeFor(m),
      from: m.getFrom(),
      subject: m.getSubject(),
      received: Utilities.formatDate(m.getDate(), TIMEZONE, 'yyyy-MM-dd HH:mm'),
      attachments: atts,
      label_number_pairs: _labelPairs(body),
      date_parsed_from_body: parsed && parsed.rows && parsed.rows[0] ? _iso(parsed.rows[0].date) : null,
      parsed_sales: parsed && parsed.rows && parsed.rows[0] ? parsed.rows[0].sales : null,
      parsed_cost: parsed && parsed.rows && parsed.rows[0] ? parsed.rows[0].cost : null,
      body_first_1500: body.slice(0, 1500)
    };
    out.samples.push(sample);

    Logger.log('\n--- ' + sample.from + ' | ' + sample.subject + ' | ' + sample.received + ' ---');
    Logger.log('store matched: ' + sample.store_matched);
    Logger.log('attachments: ' + (atts.length ? atts.join(', ') : 'none'));
    Logger.log('PARSED -> date=' + sample.date_parsed_from_body
      + ' sales=' + sample.parsed_sales + ' cost=' + sample.parsed_cost);
    Logger.log('label/number pairs seen:\n  ' + sample.label_number_pairs.join('\n  '));
    Logger.log('body (first 1500 chars):\n' + sample.body_first_1500);
  });
  return out;
}

// Every "some label ... 1,234.56" pair in the body, so the real Shopify wording
// for the two figures is visible even when the current labels miss.
function _labelPairs(body) {
  var pairs = [];
  body.split(/\r?\n/).forEach(function (line) {
    var m = line.match(/([A-Za-z][A-Za-z \/&'-]{2,40}?)[^A-Za-z0-9]{0,12}(\(?-?\$?\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?\)?)\s*$/);
    if (m) pairs.push(m[1].trim() + '  =>  ' + m[2].trim());
  });
  return pairs.slice(0, 60);
}

// ------------------------------------------------------------
// Buying-email recon (read-only — writes nothing, changes nothing)
// ------------------------------------------------------------
// The daily BUYING reports all arrive from ONE address, unlike the Shopify sales
// reports where the sender IS the store. So the store has to come out of the
// subject or the body, and this dumps whatever is there so we can see which.
//
// Prints one sample per distinct subject shape rather than just the newest few:
// the five Shopify sales templates each turned out to be worded differently, and
// building a parser off a single sample cost us a round of rework.
var BUY_SENDER = 'no-reply@pmdev.site';

// Which of pmdev.site's reports is this? The address alone is not enough — the
// Saturday WEEKLY report shares the sender, the subject shape (store code +
// date) and the money labels, so anything that does not say "Day End Report" is
// somebody else's email. See the skip in ingestBuyingEmails.
var DAY_END_SUBJECT = /day\s*end\s*report/i;

// The PayMore Day End Report puts the store CODE in its own subject line:
//   "PayMore Stores - Day End Report PayMore Overland Park(KS01) August 5th 2026, 10:00 PM"
// The code is the identifier to trust, not the store name — it is exact, it is
// the same code family as the Shopify senders' local parts (ks01@paymore.com =
// OVL), and it survives a "Fwd:" prefix. Store NAMES are the fragile path: "Lee"
// and "Bal" appear inside ordinary words, and a renamed storefront would break
// the map silently.
//
// Highest-stakes constant in the buying path, exactly as STORE_SENDERS is for
// sales: swap two entries and one store's money lands in another's columns with
// the sheet still looking entirely plausible.
var BUY_STORE_CODES = { KS01: 'OVL', MO01: 'LEE', MO02: 'WSP', MO03: 'MPL', MO04: 'BAL' };

// Every known code found in the text, as STORE names. Returns an array so the
// caller can refuse on ambiguity rather than silently taking the first hit — a
// forwarded email can quote another store's report underneath.
function _buyStoresInText(text) {
  var hay = String(text || '').toUpperCase();
  var hits = [];
  Object.keys(BUY_STORE_CODES).forEach(function (code) {
    var store = BUY_STORE_CODES[code];
    if (new RegExp('\\b' + code + '\\b').test(hay) && hits.indexOf(store) === -1) hits.push(store);
  });
  return hits;
}

// Store + covered date, both out of the subject. `ok` is false unless EXACTLY
// one store matched and a date parsed — a caller must never guess past this.
function _buyParseSubject(subject) {
  var s = String(subject || '');
  var stores = _buyStoresInText(s);
  var date = _parseDateToken(s);
  return {
    store: stores.length === 1 ? stores[0] : null,
    stores_matched: stores,
    date: date,
    ok: stores.length === 1 && !!date,
    why: stores.length === 0 ? 'no store code in subject'
       : stores.length > 1  ? 'ambiguous — subject names ' + stores.join(' and ')
       : !date              ? 'no date in subject'
       : ''
  };
}

// Every way a store might be named in the body, so the dump says outright which
// identification path is available instead of us eyeballing it.
var BUY_STORE_HINTS = {
  OVL: ['ovl', 'overland', 'ks01'],
  LEE: ['lee', "lee's summit", 'lees summit', 'mo01'],
  WSP: ['wsp', 'westport', 'mo02'],
  MPL: ['mpl', 'maplewood', 'mo03'],
  BAL: ['bal', 'ballwin', 'mo04']
};

// Same date shapes _parseDatedRows() segments on, counted without caring what
// labels sit next to them.
function _buyCountDates(body) {
  var re = new RegExp(
    '(20\\d{2}-\\d{2}-\\d{2}'
    + '|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\s+\\d{1,2},?\\s*20\\d{2}'
    + '|\\d{1,2}\\/\\d{1,2}\\/20\\d{2})', 'gi');
  var n = 0;
  while (re.exec(String(body || '')) !== null) n++;
  return n;
}

// Word-boundary matched, not substring: the 3-letter codes are short enough that
// a plain indexOf finds "BAL" inside "balance" and "LEE" inside "fleet", which
// would make the dump claim a store confidently on a coincidence.
// More than one store in the result = the token is ambiguous, say so loudly.
function _buyStoreGuess(text) {
  var hay = String(text || '').toLowerCase();
  var out = [];
  Object.keys(BUY_STORE_HINTS).forEach(function (store) {
    var hit = BUY_STORE_HINTS[store].filter(function (tok) {
      var esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('\\b' + esc + '\\b', 'i').test(hay);
    });
    if (hit.length) {
      out.push(store + ' (via ' + hit.map(function (t) { return '"' + t + '"'; }).join(', ') + ')');
    }
  });
  return out;
}

function diagnoseBuyingEmails() {
  // Subject as well as sender: the reports currently reach this mailbox as
  // FORWARDS from another address, so `from:` alone finds nothing until the
  // Gmail address is added to the PayMore recipient list. The subject survives
  // forwarding (a "Fwd:" prefix and nothing else), so it catches both.
  var q = '(from:(' + BUY_SENDER + ') OR subject:("Day End Report")) newer_than:' + LOOKBACK + 'd';
  var msgs = [];
  try {
    GmailApp.search(q, 0, 200).forEach(function (t) {
      t.getMessages().forEach(function (m) { msgs.push(m); });
    });
  } catch (e) {
    Logger.log('search failed: ' + e);
    return { ok: false, error: String(e) };
  }
  msgs.sort(function (a, b) { return a.getDate().getTime() - b.getDate().getTime(); });

  Logger.log('=== ' + msgs.length + ' message(s) from ' + BUY_SENDER + ' in the last ' + LOOKBACK + ' days ===');
  if (!msgs.length) {
    Logger.log('NONE FOUND. Either nothing has arrived yet, or they are in spam.');
    Logger.log('Try widening: diagnoseQuery("from:pmdev.site newer_than:30d")');
    return { ok: true, messages_found: 0, samples: [] };
  }

  // One sample per subject shape — digits stripped so "… for Aug 5" and
  // "… for Aug 6" collapse to the same template.
  var bySubject = {};
  msgs.forEach(function (m) {
    var key = String(m.getSubject() || '').replace(/\d+/g, '#').trim();
    bySubject[key] = m;   // newest wins, since msgs is oldest-first
  });

  var out = { ok: true, messages_found: msgs.length, distinct_subjects: Object.keys(bySubject).length, samples: [] };
  Logger.log(out.distinct_subjects + ' distinct subject shape(s) — expecting 5 if the store is in the subject, 1 if not.\n');

  Object.keys(bySubject).slice(0, 8).forEach(function (key) {
    var m = bySubject[key];
    var body = _plainBody(m);
    var atts = m.getAttachments().map(function (a) { return a.getName() + ' (' + a.getContentType() + ')'; });
    var sample = {
      from: m.getFrom(),
      subject: m.getSubject(),
      received: Utilities.formatDate(m.getDate(), TIMEZONE, 'yyyy-MM-dd HH:mm'),
      attachments: atts,
      subject_parse: _buyParseSubject(m.getSubject()),
      store_hint_subject: _buyStoreGuess(m.getSubject()),
      store_hint_body: _buyStoreGuess(body),
      // Two different questions. `date_marks` = how many dates are in the body,
      // which is what says single-day vs month-to-date. `dated_rows_found` runs
      // the SALES parser, so it reports 0 whenever the buying email words its
      // figures differently — a 0 here next to a non-zero date_marks means the
      // date segmentation already works and only the labels need adding.
      date_marks: _buyCountDates(body),
      dated_rows_found: (function () { try { return _parseDatedRows(body).length; } catch (e) { return 'err: ' + e; } })(),
      label_number_pairs: _labelPairs(body),
      body_first_2000: body.slice(0, 2000)
    };
    out.samples.push(sample);

    Logger.log('\n--- ' + sample.subject + ' | ' + sample.received + ' ---');
    var amb = function (h) { return h.length > 1 ? '   <-- AMBIGUOUS, matches ' + h.length + ' stores' : ''; };
    var sp = sample.subject_parse;
    Logger.log('SUBJECT PARSE -> store=' + sp.store + ' date=' + (sp.date ? _iso(sp.date) : null)
      + ' ok=' + sp.ok + (sp.why ? '  (' + sp.why + ')' : ''));
    Logger.log('name-based hint, SUBJECT: ' + (sample.store_hint_subject.join(', ') || 'NONE') + amb(sample.store_hint_subject));
    Logger.log('name-based hint, BODY:    ' + (sample.store_hint_body.join(', ') || 'NONE') + amb(sample.store_hint_body));
    Logger.log('attachments: ' + (atts.length ? atts.join(', ') : 'none'));
    Logger.log('dates in body: ' + sample.date_marks + '  (1 = single-day, many = month-to-date)');
    Logger.log('rows the SALES parser can already read: ' + sample.dated_rows_found);
    Logger.log('label/number pairs seen:\n  ' + (sample.label_number_pairs.join('\n  ') || '(none)'));
    Logger.log('body (first 2000 chars):\n' + sample.body_first_2000);
  });
  return out;
}

/**
 * What does the Day End Report actually call the review count?
 *
 * REVIEW_LABELS is the only label list in this file that was written before
 * anybody had read a matching email, so it is a guess until this says otherwise.
 * Run it from the Run dropdown (no deploy needed — a diagnostic executes the
 * editor's code, unlike anything reached through /exec) and read the log.
 *
 * Prints every line containing "review" verbatim, then what the parser makes of
 * the whole body. The two answers to look for:
 *   MATCHED  <n>   -> the wording is already in REVIEW_LABELS. Nothing to do.
 *   NO MATCH       -> copy the exact wording out of the lines above into
 *                     REVIEW_LABELS, most specific first.
 *
 * Digits are NOT masked here, unlike diagnoseBuyingEmails: the number IS the
 * thing being verified, and one look at it against the store's Google page
 * settles month-to-date versus all-time faster than any heuristic.
 */
function diagnoseBuyingReviews() {
  var q = '(from:(' + BUY_SENDER + ') OR subject:("Day End Report")) newer_than:' + LOOKBACK + 'd';
  var msgs = [];
  try {
    GmailApp.search(q, 0, 200).forEach(function (t) {
      t.getMessages().forEach(function (m) { msgs.push(m); });
    });
  } catch (e) {
    Logger.log('search failed: ' + e);
    return { ok: false, error: String(e) };
  }
  msgs.sort(function (a, b) { return b.getDate().getTime() - a.getDate().getTime(); });

  Logger.log('=== ' + msgs.length + ' Day End Report(s) in the last ' + LOOKBACK + ' days ===');
  if (!msgs.length) {
    Logger.log('NONE FOUND — see diagnoseBuyingEmails() for why (they may still be arriving forwarded).');
    return { ok: true, messages_found: 0, samples: [] };
  }

  // One per STORE, newest first, so all five wordings are visible at once — the
  // five Shopify templates each turned out worded differently, and there is no
  // reason to assume these five agree either.
  var byStore = {};
  msgs.forEach(function (m) {
    var sub = _buyParseSubject(m.getSubject());
    var k = sub.store || ('?' + String(m.getSubject() || '').replace(/\d+/g, '#').trim());
    if (!byStore[k]) byStore[k] = m;       // msgs is newest-first
  });

  var out = { ok: true, messages_found: msgs.length, samples: [] };
  Object.keys(byStore).forEach(function (store) {
    var m = byStore[store];
    var body = _plainBody(m);
    var lines = body.split(/\r?\n/).filter(function (l) { return /review/i.test(l); });
    var parsed = _findCountNear(body, REVIEW_LABELS, REVIEW_STOPS);
    out.samples.push({ store: store, subject: m.getSubject(), review_lines: lines, parsed: parsed });

    Logger.log('\n--- ' + store + ' | ' + m.getSubject() + ' ---');
    Logger.log(lines.length
      ? 'lines mentioning "review":\n  ' + lines.join('\n  ')
      : 'NO LINE MENTIONS "review" — this store\'s report does not carry it yet.');
    Logger.log(parsed == null
      ? 'parser: NO MATCH  <-- add the exact wording above to REVIEW_LABELS'
      : 'parser: MATCHED ' + parsed + '  <-- check this against the store\'s Google page. '
        + 'It must be THIS MONTH\'s count, not all-time.');
  });
  return out;
}

/**
 * What does the Day End Report actually call the three cash figures?
 *
 * The cash label lists were written from a SCREENSHOT of the rendered email, so
 * they are a guess until this says otherwise — exactly the state REVIEW_LABELS
 * was in before diagnoseBuyingReviews() proved the report never says "Google".
 * Run it from the Run dropdown; a diagnostic executes the editor's code, so no
 * deploy is involved.
 *
 * Prints every line mentioning cash, safe or a balance, then what the parser
 * makes of the body. What to look for per store:
 *   drawer/safe/total all MATCHED and the total adds up  -> done, nothing to do.
 *   NO MATCH on a field  -> copy the exact wording from the lines above into the
 *                           matching CASH_*_LABELS, most specific first.
 *   MATCHED but the number is 100 / 50 / 20  -> it has read the denomination
 *                           grid. Add whatever sits between the label and the
 *                           grid to CASH_STOPS.
 *
 * Digits are deliberately NOT masked: the figures are the thing being verified,
 * and one look at them against the store's own count settles it instantly.
 */
function diagnoseCashSection() {
  var q = '(from:(' + BUY_SENDER + ') OR subject:("Day End Report")) newer_than:' + LOOKBACK + 'd';
  var msgs = [];
  try {
    GmailApp.search(q, 0, 200).forEach(function (t) {
      t.getMessages().forEach(function (m) { msgs.push(m); });
    });
  } catch (e) {
    Logger.log('search failed: ' + e);
    return { ok: false, error: String(e) };
  }
  msgs.sort(function (a, b) { return b.getDate().getTime() - a.getDate().getTime(); });

  Logger.log('=== ' + msgs.length + ' Day End Report(s) in the last ' + LOOKBACK + ' days ===');
  if (!msgs.length) {
    Logger.log('NONE FOUND — see diagnoseBuyingEmails() for why.');
    return { ok: true, messages_found: 0, samples: [] };
  }

  // One per store, newest first. The five reports are generated from one
  // template, unlike the Shopify five — but that is an assumption worth testing
  // once rather than trusting.
  var byStore = {};
  msgs.forEach(function (m) {
    var sub = _buyParseSubject(m.getSubject());
    var k = sub.store || ('?' + String(m.getSubject() || '').replace(/\d+/g, '#').trim());
    if (!byStore[k]) byStore[k] = m;
  });

  var out = { ok: true, messages_found: msgs.length, samples: [] };
  Object.keys(byStore).forEach(function (store) {
    var m = byStore[store];
    var body = _plainBody(m);
    var lines = body.split(/\r?\n/).filter(function (l) {
      return /cash|safe|balance|on hand/i.test(l);
    });
    var c = _parseCash(body);
    out.samples.push({ store: store, subject: m.getSubject(), cash_lines: lines, parsed: c });

    Logger.log('\n--- ' + store + ' | ' + m.getSubject() + ' ---');
    Logger.log(lines.length
      ? 'lines mentioning cash/safe/balance:\n  ' + lines.join('\n  ')
      : 'NO LINE MENTIONS cash, safe or balance — this store\'s report may not carry the section.');
    Logger.log('parser: drawer=' + (c.drawer == null ? 'NO MATCH' : c.drawer)
      + '  safe=' + (c.safe == null ? 'NO MATCH' : c.safe)
      + '  total=' + (c.total == null ? 'NO MATCH' : c.total));
    if (c.why) Logger.log('  ⚠ ' + c.why + '  <-- one of the three came off the wrong card');
    // The grid beneath each figure is the failure worth naming outright, because
    // 100 and 50 are perfectly plausible drawer totals.
    [['drawer', c.drawer], ['safe', c.safe], ['total', c.total]].forEach(function (p) {
      if (p[1] === 100 || p[1] === 50 || p[1] === 20 || p[1] === 10 || p[1] === 5 || p[1] === 1) {
        Logger.log('  ⚠ ' + p[0] + ' = ' + p[1] + ' is a BILL DENOMINATION. It has read the'
          + ' count grid, not the card total — widen CASH_STOPS.');
      }
    });
  });
  return out;
}

// Derives which store each sender address belongs to, instead of trusting the
// guesses in STORE_SENDERS. For every email found, it parses the figures and
// looks for the store whose sheet row for that same date already holds those
// numbers. Days a manager has already keyed in by hand are the answer key, so
// the mapping is proven rather than assumed.
//
// Matching on sales AND cost together makes a coincidental collision essentially
// impossible at cent precision. A sales-only match is reported as WEAK.
function mapSendersToStores() {
  var msgs = _searchMessages();
  Logger.log('=== deriving sender -> store from ' + msgs.length + ' message(s) ===');
  if (!msgs.length) {
    Logger.log('No messages. Check the addresses in STORE_SENDERS, or wait for the sends to land.');
    return { ok: false, error: 'no messages' };
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var tabs = {};
  var findings = {};

  msgs.forEach(function (m) {
    var from = String(m.getFrom() || '');
    var addr = (from.match(/<([^>]+)>/) || [null, from])[1].toLowerCase().trim();

    var parsed = null;
    try { parsed = parseStoreEmail(m); } catch (e) { parsed = null; }
    var row = parsed && parsed.rows && parsed.rows[0];
    if (!row || (row.sales == null && row.cost == null)) {
      Logger.log(addr + ': could not parse figures out of "' + m.getSubject() + '"');
      return;
    }

    var tabName = _tabNameFor(row.date);
    if (!tabs[tabName]) {
      var sh = ss.getSheetByName(tabName);
      tabs[tabName] = sh ? sh.getDataRange().getValues() : null;
    }
    var values = tabs[tabName];
    if (!values) { Logger.log(addr + ': no tab "' + tabName + '"'); return; }

    var day = row.date.getDate();
    var strong = [], weak = [];
    Object.keys(SALES_COL_BASES).forEach(function (store) {
      var base = SALES_COL_BASES[store];
      var r = _findDayRow(values, base, day);
      if (r < 0) return;
      var sheetSales = _num(values[r][base + COL_SALES]);
      var sheetCost  = _num(values[r][base + COL_COST]);
      if (sheetSales == null && sheetCost == null) return;   // nothing keyed in yet — no answer key
      var salesHit = row.sales != null && sheetSales != null && Math.abs(sheetSales - row.sales) < 0.01;
      var costHit  = row.cost  != null && sheetCost  != null && Math.abs(sheetCost  - row.cost)  < 0.01;
      if (salesHit && costHit) strong.push(store);
      else if (salesHit || costHit) weak.push(store);
    });

    var verdict = strong.length === 1 ? strong[0]
      : strong.length > 1 ? 'AMBIGUOUS (' + strong.join('/') + ')'
      : weak.length === 1 ? 'WEAK: ' + weak[0]
      : weak.length > 1 ? 'AMBIGUOUS (' + weak.join('/') + ')'
      : 'NO MATCH';

    if (!findings[addr]) findings[addr] = [];
    findings[addr].push({ date: _iso(row.date), sales: row.sales, cost: row.cost, verdict: verdict });

    Logger.log(addr + '  ' + _iso(row.date)
      + '  sales=' + row.sales + ' cost=' + row.cost
      + '  ->  ' + verdict
      + '   (configured as ' + (STORE_SENDERS[addr] || '?') + ')');
  });

  // Collapse to one verdict per address and print a block ready to paste in.
  Logger.log('\n=== derived mapping ===');
  var out = {};
  Object.keys(findings).forEach(function (addr) {
    var votes = {};
    findings[addr].forEach(function (f) {
      if (/^[A-Z]{3}$/.test(f.verdict)) votes[f.verdict] = (votes[f.verdict] || 0) + 1;
    });
    var best = Object.keys(votes).sort(function (a, b) { return votes[b] - votes[a]; })[0] || null;
    out[addr] = best;
    var configured = STORE_SENDERS[addr] || '?';
    var flag = !best ? '  <-- UNRESOLVED' : best === configured ? '' : '  <-- DIFFERS from the current config!';
    Logger.log("  '" + addr + "': '" + (best || '????') + "'," + flag);
  });

  var unresolved = Object.keys(out).filter(function (a) { return !out[a]; });
  if (unresolved.length) {
    Logger.log('\n' + unresolved.length + ' address(es) unresolved. Most likely the sheet has nothing');
    Logger.log('keyed in yet for the date those emails cover — re-run against a date you have');
    Logger.log('already filled in by hand, or widen LOOKBACK.');
  }
  return { ok: true, derived: out, detail: findings };
}

// Confirms the two target cells are writable literals (not formulas) before any
// real run touches them, and shows what is in them today.
function diagnoseSheetCells() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var d = _addDays(_todayInTz(), -1);
  var tabName = _tabNameFor(d);
  var sh = ss.getSheetByName(tabName);
  Logger.log('=== ' + tabName + ' / day ' + d.getDate() + ' ===');
  if (!sh) { Logger.log('TAB NOT FOUND: ' + tabName); return { ok: false, error: 'no tab ' + tabName }; }

  var values = sh.getDataRange().getValues();
  var res = { ok: true, tab: tabName, day: d.getDate(), cells: [] };
  Object.keys(SALES_COL_BASES).forEach(function (store) {
    var base = SALES_COL_BASES[store];
    var r = _findDayRow(values, base, d.getDate());
    if (r < 0) { Logger.log(store + ': no row for day ' + d.getDate()); return; }
    [['sales', base + COL_SALES], ['cost', base + COL_COST]].forEach(function (p) {
      var rng = sh.getRange(r + 1, p[1] + 1);
      var info = {
        store: store, field: p[0], a1: rng.getA1Notation(),
        value: values[r][p[1]], formula: rng.getFormula() || null
      };
      res.cells.push(info);
      Logger.log(store + ' ' + p[0] + ' @ ' + info.a1 + ' = ' + JSON.stringify(info.value)
        + (info.formula ? '  *** FORMULA: ' + info.formula + ' (will NOT be overwritten)' : ''));
    });
  });
  return res;
}

// Full end-to-end run that writes nothing. Use to confirm the report looks right
// before the cron goes live.
function dryRunImport() {
  var r = ingestSalesEmails({ dryRun: true });
  Logger.log(JSON.stringify(r, null, 2));
  return r;
}

// LIVE run from the editor — this one DOES write to the sheet. Exists because
// ingestSalesEmails() takes a parameter and so cannot be launched from the Run
// dropdown. Normal operation goes through pg_cron -> the sales-ingest function;
// this is for testing and for manually catching up after a failed morning.
function runImportNow() {
  var r = ingestSalesEmails({});
  Logger.log(JSON.stringify(r, null, 2));
  Logger.log('\nfilled ' + r.written.length + ' / corrected ' + r.corrected.length
    + ' / unchanged ' + r.unchanged + ' / missing ' + r.missing.length
    + ' / unverified ' + (r.unverified || []).length);
  return r;
}

// ---- buying twins of the two above -------------------------------------
// ALWAYS run dryRunBuying() first and read the `written` entries: they show the
// exact cell, the old value and the new one, so a wrong Buy-tab column or a
// store code mapped to the wrong block is visible BEFORE anything is written.
function dryRunBuying() {
  var r = ingestBuyingEmails({ dryRun: true });
  Logger.log(JSON.stringify(r, null, 2));
  _logBuySummary(r);
  return r;
}

// LIVE — writes to the Buy tab.
function runBuyingImportNow() {
  var r = ingestBuyingEmails({});
  Logger.log(JSON.stringify(r, null, 2));
  _logBuySummary(r);
  return r;
}

function _logBuySummary(r) {
  if (!r || r.ok === false) { Logger.log('FAILED: ' + (r && r.error)); return; }
  Logger.log('\nfilled ' + r.written.length + ' / overwrote-existing ' + r.corrected.length
    + ' / unchanged ' + r.unchanged + ' / missing ' + r.missing.length
    + ' / unverified ' + r.unverified.length + ' / errors ' + r.errors.length
    + ' / archived ' + (r.archived || 0)
    + ' / ignored-not-day-end ' + (r.ignored || 0));
  r.written.concat(r.corrected).forEach(function (w) {
    Logger.log('  ' + w.store + ' ' + w.date + ': '
      + w.changes.map(function (c) { return c.field + ' ' + c.from + ' -> ' + c.to; }).join(', '));
  });
  r.errors.forEach(function (e) { Logger.log('  ERROR: ' + e.subject + ' — ' + e.error); });
  (r.daysThru || []).forEach(function (d) {
    Logger.log('  days-thru ' + d.tab + ' ' + d.a1 + ' (' + d.store + '): '
      + (d.skipped ? 'skipped — ' + d.skipped : d.from + ' -> ' + d.to));
  });
  (r.warnings || []).forEach(function (w) {
    Logger.log('  WARNING [' + w.tab + '] ' + w.note + ': sheet=' + w.sheet
      + ' expected=' + w.expected + ' — ' + w.hint);
  });
}

// ============================================================
// WEEKLY SUMMARY recon (read-only — writes nothing, archives nothing)
// ============================================================
// Groundwork for automating the "Summary" tab, which is hand-filled every week.
// Two questions have to be answered before any of it can be written:
//
//   1. What is actually IN the Saturday weekly report, verbatim? The daily
//      parser cannot be reused blind: the weekly report renders most of its
//      figures as a value ABOVE its label (a stat card), not beside it, so the
//      same-line matching that reads the Day End Report will miss them.
//   2. Which Summary cells are formulas? A value written over a formula breaks
//      the sheet in a way nobody notices for weeks — the import already refuses
//      to do it, but the map has to be known first to place the writes at all.
//
// Both are reachable over the web app as well as the Run dropdown, so answering
// them does not need a redeploy each time (see the deploy-drift note on _handle).
var WEEKLY_SUBJECT  = /weekly\s*report/i;
var WEEKLY_LOOKBACK = 14;   // days; the forwarded copies are a few days old
var SUMMARY_STORES  = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];

// Same sender-OR-subject shape as the buying search, for the same reason: the
// first copies to reach this mailbox were forwards, so `from:` alone finds none.
function _searchWeeklyMessages() {
  var q = '(from:(' + BUY_SENDER + ') OR subject:("Weekly Report")) newer_than:' + WEEKLY_LOOKBACK + 'd';
  var out = [];
  GmailApp.search(q, 0, 200).forEach(function (thread) {
    thread.getMessages().forEach(function (m) { out.push(m); });
  });
  out = out.filter(function (m) { return WEEKLY_SUBJECT.test(String(m.getSubject() || '')); });
  out.sort(function (a, b) { return a.getDate().getTime() - b.getDate().getTime(); });
  return out;
}

/**
 * Dumps the weekly reports whole. Deliberately NOT summarised into label/value
 * pairs the way diagnoseBuyingEmails does: the figures we need sit in stat cards
 * ("80%" on one line, "52/65" on the next, "Customer Conversion Rate" under
 * that), and a pair extractor drops exactly the layout that has to be seen.
 *
 * Newest copy per store only — five bodies, not fourteen days of them.
 */
function diagnoseWeeklyEmails() {
  var msgs = _searchWeeklyMessages();
  var out = { ok: true, messages_found: msgs.length, samples: [] };

  var newest = {};
  msgs.forEach(function (m) {
    var sub = _buyParseSubject(m.getSubject());
    var key = sub.store || ('unknown:' + m.getSubject());
    newest[key] = m;   // list is date-ascending, so the last write is the newest
  });

  Object.keys(newest).sort().forEach(function (key) {
    var m = newest[key];
    var body = _plainBody(m);
    var sub  = _buyParseSubject(m.getSubject());
    out.samples.push({
      store_from_subject: sub.store,
      date_from_subject:  sub.date ? _iso(sub.date) : null,
      subject_parse_why:  sub.why,
      from:     m.getFrom(),
      subject:  m.getSubject(),
      received: Utilities.formatDate(m.getDate(), TIMEZONE, 'yyyy-MM-dd HH:mm'),
      attachments: m.getAttachments().map(function (a) { return a.getName(); }),
      body_chars: body.length,
      body: body.slice(0, 20000)
    });
    Logger.log('\n=== ' + key + ' | ' + m.getSubject() + ' | '
      + Utilities.formatDate(m.getDate(), TIMEZONE, 'yyyy-MM-dd HH:mm') + ' ===');
    Logger.log(body.slice(0, 20000));
  });
  return out;
}

// The Summary tab, by header content rather than by name — the name is a guess
// and the tab is the one thing here nobody has verified yet.
function _findSummarySheet(ss) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    var probe = sh.getRange(1, 1, Math.min(12, sh.getMaxRows()),
      Math.min(40, sh.getMaxColumns())).getValues();
    for (var r = 0; r < probe.length; r++) {
      for (var c = 0; c < probe[r].length; c++) {
        if (/paymore\s*rank/i.test(String(probe[r][c] || ''))) return sh;
      }
    }
  }
  return null;
}

/**
 * The Summary tab's structure, formulas included.
 *
 * `mask` is one character per column A..(last): 'f' = formula, '.' = a literal
 * value somebody typed, '-' = empty. That is the whole point of this function —
 * it says which columns an importer may write and which it must leave alone,
 * and it says it for every week block, so a formula that exists in three blocks
 * and not the fourth shows up as the inconsistency it is.
 */
function diagnoseSummaryTab() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = _findSummarySheet(ss);
  var out = {
    ok: true,
    all_tabs: ss.getSheets().map(function (s) { return s.getName(); })
  };
  if (!sh) { out.ok = false; out.error = 'no tab has a "PayMore Rank" header'; return out; }

  var nCols = Math.min(sh.getMaxColumns(), 40);
  var nRows = Math.min(sh.getMaxRows(), 80);
  var vals  = sh.getRange(1, 1, nRows, nCols).getDisplayValues();
  var forms = sh.getRange(1, 1, nRows, nCols).getFormulas();

  out.tab = sh.getName();
  out.rows = sh.getMaxRows();
  out.cols = sh.getMaxColumns();
  out.blocks = [];

  function mask(r) {
    var s = '';
    for (var c = 0; c < nCols; c++) {
      s += forms[r][c] ? 'f' : (String(vals[r][c] || '').trim() ? '.' : '-');
    }
    return s;
  }
  function rowCells(r) {
    var o = [];
    for (var c = 0; c < nCols; c++) {
      var f = forms[r][c], v = String(vals[r][c] || '').trim();
      if (!f && !v) continue;
      o.push(_a1col(c) + (r + 1) + '=' + (f ? f : v));
    }
    return o;
  }

  // A block is anchored on its OVL row; the title/header rows sit above it and
  // Company closes it. Found by scanning rather than assuming the 9-row stride,
  // so an inserted row shows up instead of silently shifting every write.
  for (var r = 0; r < nRows; r++) {
    if (String(vals[r][0] || '').trim().toUpperCase() !== 'OVL') continue;
    var block = {
      ovl_row: r + 1,
      title_row:  r - 2 >= 0 ? rowCells(r - 2) : [],   // "July | 13-19 | MTD ..."
      header_row: r - 1 >= 0 ? rowCells(r - 1) : [],   // "Revenue | COGS | GP ..."
      row_masks: [],
      cells: []
    };
    for (var k = 0; k < 6 && r + k < nRows; k++) {
      var label = String(vals[r + k][0] || '').trim();
      block.row_masks.push((label || '(blank)') + ' r' + (r + k + 1) + ' ' + mask(r + k));
      block.cells.push({ label: label, row: r + k + 1, cells: rowCells(r + k) });
    }
    out.blocks.push(block);
  }

  out.column_key = 'mask index 0 = col A; f=formula . =typed value - =empty';
  Logger.log('tab: ' + out.tab + '  (' + out.rows + ' rows x ' + out.cols + ' cols)');
  out.blocks.forEach(function (b) {
    Logger.log('\n--- block starting row ' + b.ovl_row + ' ---');
    Logger.log('title : ' + b.title_row.join(' | '));
    Logger.log('header: ' + b.header_row.join(' | '));
    b.row_masks.forEach(function (m) { Logger.log('  ' + m); });
    b.cells.forEach(function (c) { Logger.log('  ' + c.label + ': ' + c.cells.join(' | ')); });
  });
  return out;
}

// ============================================================
// WEEKLY SUMMARY import — the Summary tab, Mondays 7:30am Central
// ============================================================
// Fills the week block the user hand-keyed every Sunday. Three sources, and
// which one a column comes from is not a style choice:
//
//   Sales tab  -> B, C          (the sheet's own daily figures, summed Sun..Sat)
//   Buy tab    -> O, P, Q       (ditto; the email agrees to the dollar, but the
//                                sheet is there even when an email is not)
//   The email  -> R, T, V, Y, Z, AA, AB   (nowhere else carries these)
//
// Left alone, always: D and E are formulas; G, H, J, K, M, X and AC are the
// user's to key in. They are CLEARED on the new block rather than left holding
// last week's numbers — blank reads as "still needs you", a stale figure does
// not. S and U (MTD conversions) are deferred; the daily fractions that would
// feed them are being captured separately.
//
// The week is SUN..SAT, matching what the weekly report itself covers ("Aug 2 -
// Aug 8"). The sheet used to run Mon..Sun, which agreed with the email only
// because the stores are shut on Sundays; aligning the two removes that
// coincidence, and lets the email's own stated period be checked against the
// week being written instead of assumed compatible.
//
// It also takes the last day of the week off the critical path: the week closes
// on Saturday, whose figures the daily import files on Sunday morning — so the
// Monday run is never waiting on anything written that same morning.
var SUMMARY_TAB       = 'Summary';   // NOT by content — "Copy of Summary" sits next to it
var SUMMARY_BLOCKS    = 4;           // the running 4-week window
var MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// 0-indexed columns on the Summary tab.
var SUM_C = {
  REV: 1, COGS: 2, GP: 3, MARGIN: 4,
  RET_W: 6, RET_M: 7, EBAY_W: 9, EBAY_M: 10, RANK: 12,
  BUYVAL: 14, BMARG_W: 15, BMARG_M: 16,
  CUST_W: 17, CUST_M: 18, DEV_W: 19, DEV_M: 20, TRAFFIC: 21,
  LINE_ITEMS: 23, QTY: 24, VALUE: 25, PROC_ITEMS: 26, PROC_VAL: 27, B2B: 28
};

// Cleared on the new block, in the order they appear. D/E and the Company row's
// SUMs are absent on purpose: clearing a formula cell destroys it.
var SUM_CLEAR_STORE = [SUM_C.REV, SUM_C.COGS, SUM_C.RET_W, SUM_C.RET_M, SUM_C.EBAY_W,
  SUM_C.EBAY_M, SUM_C.RANK, SUM_C.BUYVAL, SUM_C.BMARG_W, SUM_C.BMARG_M, SUM_C.CUST_W,
  SUM_C.CUST_M, SUM_C.DEV_W, SUM_C.DEV_M, SUM_C.TRAFFIC, SUM_C.LINE_ITEMS, SUM_C.QTY,
  SUM_C.VALUE, SUM_C.PROC_ITEMS, SUM_C.PROC_VAL, SUM_C.B2B];
var SUM_CLEAR_COMPANY = [SUM_C.RET_W, SUM_C.RET_M, SUM_C.EBAY_W, SUM_C.EBAY_M, SUM_C.RANK,
  SUM_C.BMARG_W, SUM_C.BMARG_M, SUM_C.CUST_W, SUM_C.CUST_M, SUM_C.DEV_W, SUM_C.DEV_M];

// Written as a ratio and formatted, not as a rounded whole number — the Company
// row's rates are computed from these, and rounding first makes them wrong.
// Also normalises BAL's T35, which holds a bare 93 where every neighbour is 93%.
var SUM_PCT_COLS = [SUM_C.BMARG_W, SUM_C.BMARG_M, SUM_C.CUST_W, SUM_C.CUST_M,
  SUM_C.DEV_W, SUM_C.DEV_M];

// Only "PayMore Stores - Weekly Report". The SPEEKS weekly report emails also say
// "Weekly Report" in their subject and land in the same mailbox — they were in
// the search results the first time this ran.
var WEEKLY_SUBJECT_TAG = /paymore\s+stores\s*-\s*weekly\s+report/i;

// ------------------------------------------------------------
// Entry point
// ------------------------------------------------------------
function ingestWeeklySummary(opts) {
  opts = opts || {};
  _WK_TABS = {};   // per-run cache; a second call in the same execution must re-read

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'another import is already running' };

  try {
    var report = {
      ok: true, kind: 'weekly',
      ranAt: Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      dryRun: !!opts.dryRun,
      week: null, shifted: false, written: [], skipped: [], missingEmails: [],
      incomplete: [], warnings: [], errors: [], archived: 0
    };

    // The most recently COMPLETED Sun..Sat week — the same window the weekly
    // report covers, so the sheet block and the email now describe exactly the
    // same days. Expressed as "the last Saturday before today" so a manual run on
    // any day of the week still targets the same week.
    var today = _todayInTz();
    var end = _addDays(today, -1);
    while (end.getDay() !== 6) end = _addDays(end, -1);   // 6 = Saturday

    // `weekEnd` targets a specific week. Only used to rehearse a shift against a
    // copy of the tab — a week other than the current one is otherwise a mistake,
    // so it must name a Saturday and it says so loudly when it does not.
    if (opts.weekEnd) {
      var wanted = new Date(opts.weekEnd + 'T12:00:00');
      if (isNaN(wanted.getTime())) return { ok: false, error: 'weekEnd is not a date: ' + opts.weekEnd };
      if (wanted.getDay() !== 6) {
        return { ok: false, error: 'weekEnd ' + opts.weekEnd + ' is not a Saturday' };
      }
      end = new Date(wanted.getFullYear(), wanted.getMonth(), wanted.getDate());
    }
    var start = _addDays(end, -6);
    var label = _summaryWeekLabel(start, end);
    report.week = { start: _iso(start), end: _iso(end), month: label.month, range: label.range };

    // `tab` exists so the shift — the one destructive thing here — can be
    // rehearsed on a duplicate of the Summary tab before it runs on the real one.
    // A dry run cannot cover it: the shift is a copyTo, so there is nothing to
    // inspect until it has actually happened.
    var tabName = opts.tab || SUMMARY_TAB;
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(tabName);
    if (!sh) { report.ok = false; report.error = 'no tab named "' + tabName + '"'; return report; }
    report.tab = tabName;

    var values = sh.getDataRange().getValues();
    var blocks = _summaryBlocks(values);
    if (blocks.length !== SUMMARY_BLOCKS) {
      report.ok = false;
      report.error = 'expected ' + SUMMARY_BLOCKS + ' week blocks on "' + SUMMARY_TAB
        + '", found ' + blocks.length + ' — refusing to write';
      return report;
    }

    // Figures first, sheet second: nothing is shifted until we know the week can
    // actually be filled. A shift that runs and then fails leaves the tab with
    // last week duplicated and no way to tell from looking at it.
    var emails = _weeklyEmailsByStore(report, start, end);
    var figures = {};
    SUMMARY_STORES.forEach(function (store) {
      figures[store] = _weeklyFiguresFor(ss, store, start, end, emails[store], report);
    });

    var blocked = report.incomplete.length > 0;
    if (blocked && !opts.force) {
      report.ok = false;
      report.error = 'the week is not complete in the sheet yet — nothing written. '
        + 'Re-run once the daily import has filled the gaps, or pass force=1.';
      return report;
    }

    // Idempotent: a retry, or a second manual run, must not shift a fourth time.
    // The newest block's own range label is the marker.
    //
    // ⚠️ Compared on the DISPLAYED text, never the raw value. "3-9" typed into a
    // cell is parsed by Sheets as a date (March 9), so the raw value is a Date
    // that can never equal the string "3-9" — the check silently returned false
    // and the run would have shifted a week early, dropping the oldest block and
    // duplicating this one. "13-19" and "27 - 2" are not valid dates and stay
    // text, so the column holds both types and only the display is comparable.
    var newest = blocks[blocks.length - 1];
    var shown = sh.getRange(newest.titleRow + 1, 1, 1, 2).getDisplayValues()[0];
    var already = String(shown[1] || '').trim() === label.range
      && String(shown[0] || '').trim() === label.month;

    // `inPlace` overwrites the bottom block whatever it is currently labelled.
    // Needed for the Mon..Sun -> Sun..Sat changeover: the block holding "3-9" and
    // the week "2-8" are the same seven days under two definitions, and a shift
    // would file them as two different weeks and push a real one off the top.
    var inPlace = already || !!opts.inPlace;
    if (already) {
      report.warnings.push({ note: 'block already labelled ' + label.month + ' ' + label.range
        + ' — updating it in place, not shifting' });
    } else if (opts.inPlace) {
      report.warnings.push({ note: 'inPlace — overwriting the bottom block (currently "'
        + shown[0] + ' ' + shown[1] + '") without shifting' });
    } else if (!opts.dryRun) {
      _summaryShiftUp(sh, blocks);
      report.shifted = true;
    } else {
      report.shifted = 'would shift';
    }

    // The clear only makes sense AFTER a shift, where the new block is holding a
    // copy of last week and a leftover figure would read as this week's. On an
    // update in place there is nothing stale to remove, and clearing would wipe
    // the columns the user keys by hand (Return %, eBay %, Rank, Line Items, B2B)
    // for a week they have already filled in.
    _summaryWriteBlock(sh, newest, label, figures, opts.dryRun, report, !inPlace);
    _summaryCheckFormulas(sh, blocks, report);
    _weeklyArchive(emails, opts, report);
    return report;

  } catch (err) {
    return { ok: false, kind: 'weekly', error: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------
// Block geometry
// ------------------------------------------------------------
// Located by scanning column A for OVL..BAL followed by Company, never by the
// 9-row stride — an inserted row would otherwise shift every write by one and
// overwrite the wrong week, which is the same trap _findDayRow exists for.
function _summaryBlocks(values) {
  var out = [];
  for (var r = 2; r < values.length; r++) {
    if (String(values[r][0] || '').trim().toUpperCase() !== SUMMARY_STORES[0]) continue;
    if (r + SUMMARY_STORES.length >= values.length) continue;

    var rows = {}, ok = true;
    for (var k = 0; k < SUMMARY_STORES.length; k++) {
      if (String(values[r + k][0] || '').trim().toUpperCase() !== SUMMARY_STORES[k]) { ok = false; break; }
      rows[SUMMARY_STORES[k]] = r + k;
    }
    if (!ok) continue;
    var comp = r + SUMMARY_STORES.length;
    if (!/^company$/i.test(String(values[comp][0] || '').trim())) continue;

    out.push({ titleRow: r - 2, headerRow: r - 1, firstRow: r, rows: rows, companyRow: comp });
  }
  return out;
}

// Oldest block out, everything up one, newest block left holding a copy of the
// week before it (which the caller then clears and overwrites).
//
// copyTo, not setValues: it carries formats AND rewrites the relative formulas,
// so D22 =B22-C22 lands as D13 =B13-C13. A values-only shift would move last
// week's numbers up while leaving the formulas pointing at their old rows.
//
// Only the six DATA rows move, plus the month/range labels in A and B. The title
// row also carries a merged X:AC banner and the header row is identical in every
// block, so copying either would risk a merge error for nothing — the rest of
// the title row is per-block formulas (G2 =B2) that are already in place.
function _summaryShiftUp(sh, blocks) {
  var width = sh.getMaxColumns();
  for (var i = 0; i < blocks.length - 1; i++) {
    var from = blocks[i + 1], to = blocks[i];
    sh.getRange(from.titleRow + 1, 1, 1, 2)
      .copyTo(sh.getRange(to.titleRow + 1, 1, 1, 2));
    sh.getRange(from.firstRow + 1, 1, SUMMARY_STORES.length + 1, width)
      .copyTo(sh.getRange(to.firstRow + 1, 1, SUMMARY_STORES.length + 1, width));
  }
}

// "August" + "3-9", or "July- August" + "27 - 2" across a month boundary. Both
// spellings, spacing included, copied from what is already in the sheet.
function _summaryWeekLabel(start, end) {
  var same = start.getMonth() === end.getMonth();
  return {
    month: same ? MONTHS_FULL[start.getMonth()]
                : MONTHS_FULL[start.getMonth()] + '- ' + MONTHS_FULL[end.getMonth()],
    range: same ? start.getDate() + '-' + end.getDate()
                : start.getDate() + ' - ' + end.getDate()
  };
}

// ------------------------------------------------------------
// The figures
// ------------------------------------------------------------
function _weeklyFiguresFor(ss, store, start, end, email, report) {
  var f = { store: store };

  // --- Sales tab: revenue and cost, Sun..Sat. A week can straddle two months,
  // so this walks days and picks the tab per day rather than reading one tab.
  var rev = 0, cogs = 0, gaps = [];
  for (var d = new Date(start); d <= end; d = _addDays(d, 1)) {
    var cells = _dayCells(ss, _tabNameFor(d), SALES_COL_BASES[store], d, [COL_SALES, COL_COST]);
    if (!cells || cells[0] == null || cells[1] == null) { gaps.push(_iso(d)); continue; }
    rev += cells[0]; cogs += cells[1];
  }
  if (gaps.length) {
    report.incomplete.push({ store: store, field: 'revenue/cost', missing_days: gaps,
      hint: 'the daily sales import has not filled these yet' });
  }
  // Rounded because these are sums of floats: 15974.339999999998 displays as
  // $15,974.34 and is harmless, but it is the value an export or a comparison
  // would see, and "why does the sheet say .339999" is a question worth never
  // being asked.
  f.revenue = _round2(rev); f.cogs = _round2(cogs);

  // --- Buy tab: the week, and the month-to-date the week ends in.
  var wk = _buySpanTotals(ss, store, start, end, report, 'buy/sell');
  f.weekBuy = _round2(wk.buy); f.weekSell = _round2(wk.sell);

  var mStart = new Date(end.getFullYear(), end.getMonth(), 1);
  // Labelled apart from the week's own gaps: the two spans overlap, so the same
  // missing day is reported by both and reads as a duplicate rather than as the
  // two different columns it actually spoils (O/P vs Q).
  var mtd = _buySpanTotals(ss, store, mStart, end, report, 'buy/sell (MTD)');
  f.mtdBuy = _round2(mtd.buy); f.mtdSell = _round2(mtd.sell);

  f.buyMarginWeek = f.weekSell > 0 ? (f.weekSell - f.weekBuy) / f.weekSell : null;
  f.buyMarginMtd  = f.mtdSell  > 0 ? (f.mtdSell  - f.mtdBuy)  / f.mtdSell  : null;

  // --- MTD conversions, from the daily ledger. Same as-of date as Q: the 1st
  // through the week's end, in the month the week ends in.
  //
  // A single missing day is refused rather than absorbed. Summing a short
  // denominator produces a plausible rate that is quietly wrong, and there is
  // nothing in the cell afterwards to say so — whereas an empty S with the days
  // named in the report is fixable.
  var conv = _convMtd(ss, store, mStart, end);
  f.convMissing = conv.missing;
  if (conv.noTab) {
    report.warnings.push({ store: store, field: 'S/U',
      reason: 'no "' + CONV_TAB + '" tab yet — run backfillConversions first' });
  } else if (conv.missing.length) {
    report.warnings.push({ store: store, field: 'S/U',
      reason: 'no daily conversions banked for ' + conv.missing.length + ' day(s) this month',
      missing_days: conv.missing });
  } else {
    f.custMtd = conv.custDen > 0 ? conv.custNum / conv.custDen : null;
    f.devMtd  = conv.devDen  > 0 ? conv.devNum  / conv.devDen  : null;
    f.convTotals = conv;
  }

  // --- Email. A store with no email for THIS week gets its sheet-derived
  // columns and nothing else; the rest are reported rather than guessed at.
  if (!email) {
    report.missingEmails.push({ store: store, week: _iso(start) + '..' + _iso(end) });
    return f;
  }
  f.custNum = email.cust ? email.cust.num : null;
  f.custDen = email.cust ? email.cust.den : null;
  f.devNum  = email.dev  ? email.dev.num  : null;
  f.devDen  = email.dev  ? email.dev.den  : null;
  f.custRate = (f.custDen) ? f.custNum / f.custDen : null;
  f.devRate  = (f.devDen)  ? f.devNum  / f.devDen  : null;
  f.traffic  = f.custDen;
  f.qty            = email.availCount;
  f.value          = email.availProjection;
  f.processedItems = email.processedItems;
  f.processedValue = email.processedValue;

  // The email and the Buy tab compute the same week from different systems. They
  // matched to the dollar on every store when this was built, so a disagreement
  // now is worth surfacing rather than silently preferring one.
  if (email.estValue != null && Math.abs(email.estValue - f.weekSell) > 1) {
    report.warnings.push({ store: store, note: 'Estimated Value disagrees with the Buy tab',
      email: email.estValue, sheet: f.weekSell });
  }
  if (email.estMargin != null && f.buyMarginWeek != null
      && Math.abs(email.estMargin - f.buyMarginWeek) > 0.01) {
    report.warnings.push({ store: store, note: 'Gross Margin disagrees with the Buy tab',
      email: email.estMargin, sheet: f.buyMarginWeek });
  }
  return f;
}

// Buy/Sell summed over a date span, tab picked per day so a span can cross a
// month boundary. Missing days are reported, not silently treated as zero — a
// gap understates the total in a way that looks like a bad week.
function _buySpanTotals(ss, store, start, end, report, fieldLabel) {
  var buy = 0, sell = 0, gaps = [];
  for (var d = new Date(start); d <= end; d = _addDays(d, 1)) {
    var cells = _dayCells(ss, _buyTabNameFor(d), BUY_COL_BASES[store], d, [COL_BUY, COL_SELL]);
    if (!cells || cells[0] == null || cells[1] == null) {
      if (d.getDay() !== 0) gaps.push(_iso(d));   // Sundays are shut; a blank is normal
      continue;
    }
    buy += cells[0]; sell += cells[1];
  }
  if (gaps.length && report) {
    report.incomplete.push({ store: store, field: fieldLabel || 'buy/sell', missing_days: gaps,
      hint: 'the daily buying import has not filled these yet' });
  }
  return { buy: buy, sell: sell };
}

// One day's cells out of a monthly tab, row located by the day number in the
// block's own Date column. Tab values are cached per run — a 7-day span across
// two stores would otherwise re-read the same sheet fourteen times.
var _WK_TABS = {};
function _dayCells(ss, tabName, base, date, cols) {
  if (base == null) return null;
  if (!(tabName in _WK_TABS)) {
    var sh = ss.getSheetByName(tabName);
    _WK_TABS[tabName] = sh ? sh.getDataRange().getValues() : null;
  }
  var values = _WK_TABS[tabName];
  if (!values) return null;
  var row = _findDayRow(values, base, date.getDate());
  if (row < 0) return null;
  return cols.map(function (c) { return _num(values[row][base + c]); });
}

// ------------------------------------------------------------
// Writing
// ------------------------------------------------------------
function _summaryWriteBlock(sh, block, label, figures, dryRun, report, clearFirst) {
  // Title first, so a half-finished run is still labelled with the week it was
  // trying to write rather than the week it just shifted up.
  //
  // Forced to plain text: left alone, "10-16" would be swallowed as October 16
  // and "3-9" as March 9 — which is exactly how the existing cells came to hold
  // dates. Writing them as text also makes the idempotency check above compare
  // like with like from here on.
  _sumLabel(sh, block.titleRow, 0, label.month, 'title.month', dryRun, report);
  _sumLabel(sh, block.titleRow, 1, label.range, 'title.range', dryRun, report);

  SUMMARY_STORES.forEach(function (store) {
    var r = block.rows[store], f = figures[store] || {};
    if (clearFirst) SUM_CLEAR_STORE.forEach(function (c) { _sumClear(sh, r, c, dryRun, report); });

    _sumSet(sh, r, SUM_C.REV,        f.revenue,        store + '.revenue', dryRun, report);
    _sumSet(sh, r, SUM_C.COGS,       f.cogs,           store + '.cogs', dryRun, report);
    _sumSet(sh, r, SUM_C.BUYVAL,     f.weekSell,       store + '.buyingValue', dryRun, report);
    _sumSet(sh, r, SUM_C.BMARG_W,    f.buyMarginWeek,  store + '.margin', dryRun, report);
    _sumSet(sh, r, SUM_C.BMARG_M,    f.buyMarginMtd,   store + '.marginMTD', dryRun, report);
    _sumSet(sh, r, SUM_C.CUST_W,     f.custRate,       store + '.custConver', dryRun, report);
    _sumSet(sh, r, SUM_C.CUST_M,     f.custMtd,        store + '.custConverMTD', dryRun, report);
    _sumSet(sh, r, SUM_C.DEV_W,      f.devRate,        store + '.devConver', dryRun, report);
    _sumSet(sh, r, SUM_C.DEV_M,      f.devMtd,         store + '.devConverMTD', dryRun, report);
    _sumSet(sh, r, SUM_C.TRAFFIC,    f.traffic,        store + '.traffic', dryRun, report);
    _sumSet(sh, r, SUM_C.QTY,        f.qty,            store + '.qtyOfItems', dryRun, report);
    _sumSet(sh, r, SUM_C.VALUE,      f.value,          store + '.value', dryRun, report);
    _sumSet(sh, r, SUM_C.PROC_ITEMS, f.processedItems, store + '.processedItems', dryRun, report);
    _sumSet(sh, r, SUM_C.PROC_VAL,   f.processedValue, store + '.processedValue', dryRun, report);
  });

  // Company row. B/C/D/E/O/V/X..AC are already SUM formulas and are left alone;
  // these six are typed by hand today. Rates are weighted — the sum of the
  // numerators over the sum of the denominators, not the mean of five percentages.
  var r = block.companyRow;
  if (clearFirst) SUM_CLEAR_COMPANY.forEach(function (c) { _sumClear(sh, r, c, dryRun, report); });

  var t = { weekBuy: 0, weekSell: 0, mtdBuy: 0, mtdSell: 0,
            custNum: 0, custDen: 0, devNum: 0, devDen: 0,
            mCustNum: 0, mCustDen: 0, mDevNum: 0, mDevDen: 0 };
  var haveCust = false, haveDev = false, everyStoreHasMtd = true;
  SUMMARY_STORES.forEach(function (store) {
    var f = figures[store] || {};
    t.weekBuy += f.weekBuy || 0; t.weekSell += f.weekSell || 0;
    t.mtdBuy  += f.mtdBuy  || 0; t.mtdSell  += f.mtdSell  || 0;
    if (f.custDen) { t.custNum += f.custNum; t.custDen += f.custDen; haveCust = true; }
    if (f.devDen)  { t.devNum  += f.devNum;  t.devDen  += f.devDen;  haveDev = true; }
    // The company MTD rate is only meaningful if EVERY store contributed a full
    // month; one store short would weight the total towards the others.
    if (f.convTotals) {
      t.mCustNum += f.convTotals.custNum; t.mCustDen += f.convTotals.custDen;
      t.mDevNum  += f.convTotals.devNum;  t.mDevDen  += f.convTotals.devDen;
    } else {
      everyStoreHasMtd = false;
    }
  });

  _sumSet(sh, r, SUM_C.BMARG_W, t.weekSell > 0 ? (t.weekSell - t.weekBuy) / t.weekSell : null,
    'Company.margin', dryRun, report);
  _sumSet(sh, r, SUM_C.BMARG_M, t.mtdSell > 0 ? (t.mtdSell - t.mtdBuy) / t.mtdSell : null,
    'Company.marginMTD', dryRun, report);
  _sumSet(sh, r, SUM_C.CUST_W, haveCust ? t.custNum / t.custDen : null,
    'Company.custConver', dryRun, report);
  _sumSet(sh, r, SUM_C.DEV_W, haveDev ? t.devNum / t.devDen : null,
    'Company.devConver', dryRun, report);
  _sumSet(sh, r, SUM_C.CUST_M, everyStoreHasMtd && t.mCustDen > 0 ? t.mCustNum / t.mCustDen : null,
    'Company.custConverMTD', dryRun, report);
  _sumSet(sh, r, SUM_C.DEV_M, everyStoreHasMtd && t.mDevDen > 0 ? t.mDevNum / t.mDevDen : null,
    'Company.devConverMTD', dryRun, report);
}

// Every write goes through here, and every write refuses a formula cell. The
// Company row's SUMs and the store rows' D/E are one column index away from
// cells we do write, and a literal dropped on one of them breaks the tab in a
// way nobody would notice for weeks.
function _sumSet(sh, rowIdx, col, value, label, dryRun, report) {
  var a1 = _a1col(col) + (rowIdx + 1);
  // A field that parsed to nothing has to SAY so. Silence here reads exactly like
  // a field that was never meant to be written, and the two need different fixes.
  if (value == null || value === '') {
    report.skipped.push({ field: label, cell: a1, reason: 'no value — not written' });
    return;
  }
  var rng = sh.getRange(rowIdx + 1, col + 1);
  if (rng.getFormula()) {
    report.skipped.push({ field: label, cell: a1,
      reason: 'cell holds a formula (' + rng.getFormula() + ') — not overwriting' });
    return;
  }
  // `from` is what makes a dry run reviewable: on the first run the target block
  // is the one already filled by hand, so from -> to IS the comparison.
  report.written.push({ field: label, cell: a1, from: rng.getDisplayValue(), to: value });
  if (dryRun) return;
  rng.setValue(value);
  if (SUM_PCT_COLS.indexOf(col) !== -1) rng.setNumberFormat('0%');
}

// The week labels. Text format is set BEFORE the value, or Sheets parses the
// string on the way in and the format change arrives too late to stop it.
function _sumLabel(sh, rowIdx, col, text, label, dryRun, report) {
  var rng = sh.getRange(rowIdx + 1, col + 1);
  report.written.push({ field: label, cell: _a1col(col) + (rowIdx + 1),
    from: rng.getDisplayValue(), to: text });
  if (dryRun) return;
  rng.setNumberFormat('@');
  rng.setValue(text);
}

function _sumClear(sh, rowIdx, col, dryRun, report) {
  var rng = sh.getRange(rowIdx + 1, col + 1);
  if (rng.getFormula()) {
    report.skipped.push({ field: 'clear', cell: _a1col(col) + (rowIdx + 1),
      reason: 'formula cell — left alone' });
    return;
  }
  if (!dryRun) rng.clearContent();
}

// A block is only as good as the formulas nobody writes. D/E and the Company
// SUMs are invisible when they go missing — the cell just reads empty, and the
// next shift copies that emptiness up into the running window.
//
// Not repaired, only reported: a formula appearing on its own would be a bigger
// surprise than one going missing. (Seen for real — a hand-clear of the block
// took V36's =SUM(V31:V35) with it while every other formula survived.)
function _summaryCheckFormulas(sh, blocks, report) {
  var newest = blocks[blocks.length - 1], prev = blocks[blocks.length - 2];
  if (!prev) return;
  var width = Math.min(sh.getMaxColumns(), 34);
  var pRows = sh.getRange(prev.firstRow + 1, 1, SUMMARY_STORES.length + 1, width).getFormulas();
  var nRows = sh.getRange(newest.firstRow + 1, 1, SUMMARY_STORES.length + 1, width).getFormulas();

  for (var r = 0; r < pRows.length; r++) {
    for (var c = 0; c < width; c++) {
      if (pRows[r][c] && !nRows[r][c]) {
        report.warnings.push({
          note: 'formula missing', cell: _a1col(c) + (newest.firstRow + r + 1),
          expected_like: pRows[r][c] + ' (the block above has one here)'
        });
      }
    }
  }
}

// ------------------------------------------------------------
// The weekly email
// ------------------------------------------------------------
// Archived once the week is written, so the mailbox shows what has NOT been
// handled yet — same idea as the daily passes.
//
// Three things it will not archive, each for its own reason:
//   - anything on a dry run, or a run that wrote nothing;
//   - a store whose figures did not make it into the sheet, which is precisely
//     the mail somebody needs to still be able to find;
//   - the SPEEKS weekly report emails. They match `subject:"Weekly Report"` and
//     so come back in the same search, but they are the user's own reading —
//     hence the PayMore-specific subject test, not the search, as the gate.
function _weeklyArchive(emails, opts, report) {
  if (!ARCHIVE_AFTER_IMPORT || opts.dryRun) return;

  var wrote = {};
  report.written.forEach(function (w) { wrote[String(w.field).split('.')[0]] = true; });

  SUMMARY_STORES.forEach(function (store) {
    var e = emails[store];
    if (!e || !e.thread) return;
    if (!wrote[store]) {
      report.warnings.push({ store: store, note: 'nothing written for this store — its email '
        + 'is left in the inbox' });
      return;
    }
    try {
      e.thread.moveToArchive();
      report.archived++;
    } catch (err) {
      report.errors.push({ store: store, error: 'archive failed: ' + String(err && err.message || err) });
    }
  });
}


// Only emails whose OWN stated period is the week being written. Now that the
// block and the report cover the same Sun..Sat days, this is an exact match
// rather than a compatibility argument — and it is what stops a fortnight-old
// report, or a re-sent one, from filling a week it does not describe.
function _weeklyEmailsByStore(report, start, end) {
  var out = {};
  _searchWeeklyMessages().forEach(function (msg) {
    if (!WEEKLY_SUBJECT_TAG.test(String(msg.getSubject() || ''))) return;
    var p;
    try { p = parseWeeklyEmail(msg); } catch (e) {
      report.errors.push({ subject: msg.getSubject(), error: String(e && e.message || e) });
      return;
    }
    if (!p.ok) { report.errors.push({ subject: msg.getSubject(), error: p.why }); return; }
    if (_iso(p.periodStart) !== _iso(start) || _iso(p.periodEnd) !== _iso(end)) return;
    var prev = out[p.store];
    if (!prev || msg.getDate().getTime() >= prev.receivedAt) {
      p.receivedAt = msg.getDate().getTime();
      try { p.thread = msg.getThread(); } catch (_) { p.thread = null; }
      out[p.store] = p;
    }
  });
  return out;
}

/** One weekly report -> every figure the Summary tab needs from it. */
function parseWeeklyEmail(msg) {
  var subject = String(msg.getSubject() || '');
  var stores = _buyStoresInText(subject);
  if (stores.length !== 1) {
    return { ok: false, why: stores.length ? 'ambiguous — subject names ' + stores.join(' and ')
                                           : 'no store code in subject' };
  }
  var period = _wkPeriod(subject);
  if (!period) return { ok: false, why: 'no "Mon D - Mon D, YYYY" period in subject' };

  var lines = _wkLines(_plainBody(msg));

  var out = { ok: true, store: stores[0], periodStart: period.start, periodEnd: period.end };

  // --- Buying Statistics. Bounded at PaytonAI: everything past it is prose,
  // including store names and figures quoted out of customer reviews.
  var bs = _wkIdx(lines, /^buying statistics$/i, 0);
  var stop = _wkIdx(lines, /^paytonai/i, bs < 0 ? 0 : bs);
  if (bs < 0) return { ok: false, why: 'no "Buying Statistics" section' };
  if (stop < 0) stop = lines.length;

  var ci = _wkLabelIdx(lines, 'customer conversion rate', bs, stop);
  var di = _wkLabelIdx(lines, 'device conversion rate', bs, stop);
  out.cust = ci >= 0 ? _wkFraction(lines, ci) : null;
  out.dev  = di >= 0 ? _wkFraction(lines, di) : null;

  out.estValue  = _wkMoney(_wkAfter(lines, 'estimated value', bs, stop));
  out.estMargin = _wkPct(_wkAfter(lines, 'estimated gross margin', bs, stop));
  out.totalSpent = _wkMoney(_wkAfter(lines, 'total spent', bs, stop));

  // --- Inventory Snapshot -> the "Available" card.
  var av = _wkAvailable(lines);
  out.availCount = av.count; out.availCost = av.cost; out.availProjection = av.projection;
  if (av.why) out.availWhy = av.why;

  // --- Processed Stats. ⚠️ "Devices Processed" is ALSO a column header in the
  // Team Production table a few lines above, and "Total Value" would then read
  // one buyer's row. Anchored past the section heading, and matched as a whole
  // line, which the wide table header can never be.
  var ps = _wkIdx(lines, /^processed stats$/i, 0);
  if (ps >= 0) {
    out.processedItems = _wkInt(_wkAfter(lines, 'devices processed', ps, lines.length));
    out.processedValue = _wkMoney(_wkAfter(lines, 'total value', ps, lines.length));
  }
  return out;
}

// "Aug 2 - Aug 8, 2026" -> {start, end}. The year is stated once, at the end; a
// week spanning New Year has a start month LATER than its end month, which is
// the only signal that the start belongs to the previous year.
function _wkPeriod(subject) {
  var m = String(subject).match(
    /([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*[-‐-―]\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(20\d{2})/);
  if (!m) return null;
  var m1 = _wkMonthIdx(m[1]), m2 = _wkMonthIdx(m[3]);
  if (m1 < 0 || m2 < 0) return null;
  var year = parseInt(m[5], 10);
  return {
    start: new Date(m1 > m2 ? year - 1 : year, m1, parseInt(m[2], 10)),
    end:   new Date(year, m2, parseInt(m[4], 10))
  };
}

function _wkMonthIdx(name) {
  var n = String(name).slice(0, 3).toLowerCase();
  for (var i = 0; i < MONTHS.length; i++) if (MONTHS[i].toLowerCase() === n) return i;
  return -1;
}

// Body -> the lines every reader below works on.
//
// ⚠️ Two things happen here, and the second one is why the parser silently read
// nothing out of the real emails for a while.
//
//   1. Blank lines go: every rule is "the line before" or "the line after".
//   2. **Asterisks go.** getPlainBody() renders the report's bold table cells as
//      `* 6/7 *` and `*$ 670▼ 82%*`. A copy FORWARDED through Outlook is
//      re-rendered and arrives as a clean `78/95` — so a parser built and tested
//      against forwarded samples passes, then finds nothing at all once the
//      reports start arriving direct from pmdev.site. Every weekly sample used
//      to build this was forwarded; the daily backfill is what exposed it, on
//      exactly the three days that came direct.
//
// Stripped once, here, rather than tolerated in a dozen anchored regexes.
function _wkLines(body) {
  return String(body || '').split(/\r?\n/)
    .map(function (l) { return l.replace(/\*/g, ' ').replace(/[ \t]+/g, ' ').trim(); })
    .filter(function (l) { return l; });
}

function _wkIdx(lines, re, from) {
  for (var i = Math.max(0, from || 0); i < lines.length; i++) if (re.test(lines[i])) return i;
  return -1;
}

// Whole-line equality, not "contains". Every label in this email sits alone on
// its line, and "contains" is what makes a wide table header match a field name.
function _wkLabelIdx(lines, label, from, to) {
  for (var i = Math.max(0, from); i < Math.min(lines.length, to); i++) {
    if (lines[i].toLowerCase() === label) return i;
  }
  return -1;
}

// The value belongs to the line AFTER its label — except on the conversion
// cards, where it comes before. Hence two readers, not one.
function _wkAfter(lines, label, from, to) {
  var i = _wkLabelIdx(lines, label, from, to);
  if (i < 0 || i + 1 >= lines.length) return null;
  return _wkLevels(lines[i + 1])[0] || null;
}

// "78/95" on its own line, within a card's height of the label above it.
function _wkFraction(lines, labelIdx) {
  for (var i = labelIdx - 1; i >= Math.max(0, labelIdx - 3); i--) {
    var m = lines[i].replace(/,/g, '').match(/^(\d+)\s*\/\s*(\d+)$/);
    if (m) return { num: parseInt(m[1], 10), den: parseInt(m[2], 10) };
  }
  return null;
}

// Strips the trend deltas and returns the LEVELS in order:
//   "1,326▲ 14.6% $ 37,513▲ 17.5% $ 87,994▲ 16.7%"  ->  ["1,326", "$ 37,513", "$ 87,994"]
// Every figure in this email is followed by its own change, so a reader that
// does not do this reads growth as level — "52%▲ 2%" would parse as 2%.
function _wkLevels(line) {
  return String(line || '').split(/[▲▼]\s*[\d.,]+\s*%/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s; });
}

function _wkMoney(tok) {
  if (tok == null) return null;
  var m = String(tok).replace(/,/g, '').match(/\$\s*(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}
function _wkPct(tok) {
  if (tok == null) return null;
  var m = String(tok).match(/(-?\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) / 100 : null;
}
function _wkInt(tok) {
  if (tok == null) return null;
  if (String(tok).indexOf('$') !== -1) return null;   // a count is never money
  var m = String(tok).replace(/,/g, '').match(/(-?\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// The "Available" card out of the Inventory Snapshot — NOT "In Queue" above it
// or "Live" below, both of which carry the same three fields.
//
// The card's own header is required and read, rather than assuming the order:
// Cost and Projection are adjacent money columns, so if they were ever swapped
// upstream the Value column would fill with cost and still look like a number.
// The $-shape check below is what actually catches that.
function _wkAvailable(lines) {
  var snap = _wkIdx(lines, /^inventory snapshot$/i, 0);
  if (snap < 0) return { why: 'no "Inventory Snapshot" section' };
  var av = _wkIdx(lines, /^available$/i, snap);
  if (av < 0) return { why: 'no "Available" card' };

  // Tolerant of what sat between the words before _wkLines stripped it: direct
  // emails render this header as "*Device Count* *Cost* *Projection*", so a
  // plain \s+ between the words matched only forwarded copies.
  var hdr = -1;
  for (var i = av; i < Math.min(lines.length, av + 6); i++) {
    if (/device\W*count\W+cost\W+projection/i.test(lines[i])) { hdr = i; break; }
  }
  if (hdr < 0) return { why: 'the Available card is not laid out as "Device Count Cost Projection"' };

  var lv = _wkLevels(lines[hdr + 1]);
  if (lv.length < 3) return { why: 'Available row has ' + lv.length + ' figures, expected 3' };
  if (lv[0].indexOf('$') !== -1 || lv[1].indexOf('$') === -1 || lv[2].indexOf('$') === -1) {
    return { why: 'Available row is not count/money/money — the columns may have moved' };
  }
  return { count: _wkInt(lv[0]), cost: _wkMoney(lv[1]), projection: _wkMoney(lv[2]) };
}

function _round2(n) { return Math.round(n * 100) / 100; }

// ============================================================
// DAILY CONVERSIONS — the ledger behind Summary S and U
// ============================================================
// The Summary tab wants month-to-date customer and device conversion, and the
// weekly report has no MTD figure for either. The DAILY report does carry the
// day's fractions ("9/11", "36/51"), so MTD is the sum of the numerators over
// the sum of the denominators — exact, not apportioned.
//
// It cannot be recovered from the Summary blocks themselves: a month is never a
// whole number of weeks (Aug 1 sits in the Jul 26–Aug 1 week), the older blocks
// hold rounded rates, and only four weeks are kept. Same reason Q is computed
// from the Buy tab rather than from the blocks.
//
// So the fractions are banked daily, in this workbook, on their own hidden tab.
// The alternative was a Supabase table — but the weekly run lives in Apps Script
// and only ever PUSHES to Supabase; making it read back would add a secret and a
// new way for the Monday job to fail, for numbers whose only consumer is a tab in
// the same file.
//
// ⚠️ This is a VISIT-weighted rate: a customer who comes in twice counts twice.
// The report publishes no MTD figure of its own, so this is the definition — if
// PayMoreOS ever shows one and dedupes across the month, the two will disagree
// legitimately.
var CONV_TAB = 'Conversions';
var CONV_BASES = { OVL: 1, LEE: 5, WSP: 9, MPL: 13, BAL: 17 };   // 0-indexed; A = Date
var CONV_FIELDS = ['custNum', 'custDen', 'devNum', 'devDen'];
var CONV_HEADER_ROWS = 2;

// Created on first use and hidden — it is a ledger, not something to read.
function _convTab(ss, create) {
  var sh = ss.getSheetByName(CONV_TAB);
  if (sh || !create) return sh;

  sh = ss.insertSheet(CONV_TAB);
  var top = ['Date'], sub = [''];
  SUMMARY_STORES.forEach(function (store) {
    top.push(store, '', '', '');
    sub.push('Cust Conv', 'Cust Total', 'Dev Conv', 'Dev Total');
  });
  sh.getRange(1, 1, 1, top.length).setValues([top]).setFontWeight('bold');
  sh.getRange(2, 1, 1, sub.length).setValues([sub]).setFontWeight('bold');
  sh.setFrozenRows(CONV_HEADER_ROWS);
  // Dates as literal text. A "3-9" in this workbook already became March 9 once;
  // an ISO string sorts correctly and cannot be reinterpreted.
  sh.getRange(CONV_HEADER_ROWS + 1, 1, sh.getMaxRows() - CONV_HEADER_ROWS, 1).setNumberFormat('@');
  sh.hideSheet();
  return sh;
}

// Row for one ISO date, appended in date order if it is new. Located by matching
// the date text, never by offset from the top — the same rule the day-row lookups
// on the Buy and Sales tabs follow.
function _convRow(sh, iso, create) {
  var last = sh.getLastRow();
  if (last >= CONV_HEADER_ROWS + 1) {
    var col = sh.getRange(CONV_HEADER_ROWS + 1, 1, last - CONV_HEADER_ROWS, 1).getDisplayValues();
    for (var i = 0; i < col.length; i++) {
      if (String(col[i][0]).trim() === iso) return CONV_HEADER_ROWS + 1 + i;
    }
  }
  if (!create) return -1;
  var row = Math.max(last + 1, CONV_HEADER_ROWS + 1);
  sh.getRange(row, 1).setNumberFormat('@').setValue(iso);
  return row;
}

// One store-day. Idempotent: re-reading the same report rewrites the same four
// numbers, which is what lets the daily backfill window overlap harmlessly.
function _convWrite(ss, store, date, cust, dev, dryRun, report) {
  if (!cust && !dev) return;
  var base = CONV_BASES[store];
  if (base == null) return;

  var iso = _iso(date);
  var vals0 = [
    cust ? cust.num : null, cust ? cust.den : null,
    dev ? dev.num : null, dev ? dev.den : null
  ];

  // On a dry run before the tab exists there is nothing to diff against, but the
  // values still have to be VISIBLE — a dry run that reports "0 store-days"
  // because it could not open a sheet reads exactly like a parser that found
  // nothing, which is the one thing a dry run is for telling apart.
  var sh = _convTab(ss, !dryRun);
  if (!sh) {
    (report.conversions = report.conversions || []).push({
      store: store, date: iso, changes: ['(no tab yet) ' + vals0.join('/')]
    });
    return;
  }

  var row = _convRow(sh, iso, !dryRun);
  if (row < 0) return;

  var vals = [
    cust ? cust.num : null, cust ? cust.den : null,
    dev ? dev.num : null, dev ? dev.den : null
  ];
  var changed = [];
  for (var i = 0; i < vals.length; i++) {
    if (vals[i] == null) continue;
    var rng = sh.getRange(row, base + i + 1);
    var cur = _num(rng.getValue());
    if (cur === vals[i]) continue;
    changed.push(CONV_FIELDS[i] + ' ' + cur + '->' + vals[i]);
    if (!dryRun) rng.setValue(vals[i]);
  }
  if (changed.length) {
    (report.conversions = report.conversions || []).push({
      store: store, date: iso, changes: changed
    });
  }
}

// Month-to-date, summed over days 1..end. Sundays are never counted as missing:
// the stores are shut, so there is no report and nothing to add.
function _convMtd(ss, store, monthStart, end) {
  var out = { custNum: 0, custDen: 0, devNum: 0, devDen: 0, missing: [] };
  var sh = _convTab(ss, false);
  if (!sh) { out.noTab = true; return out; }

  var base = CONV_BASES[store];
  var last = sh.getLastRow();
  if (last < CONV_HEADER_ROWS + 1) { out.noTab = true; return out; }

  var dates = sh.getRange(CONV_HEADER_ROWS + 1, 1, last - CONV_HEADER_ROWS, 1).getDisplayValues();
  var data  = sh.getRange(CONV_HEADER_ROWS + 1, base + 1, last - CONV_HEADER_ROWS, 4).getValues();
  var byDate = {};
  for (var i = 0; i < dates.length; i++) byDate[String(dates[i][0]).trim()] = data[i];

  for (var d = new Date(monthStart); d <= end; d = _addDays(d, 1)) {
    if (d.getDay() === 0) continue;
    var row = byDate[_iso(d)];
    var cd = row ? _num(row[1]) : null, dd = row ? _num(row[3]) : null;
    if (cd == null || dd == null) { out.missing.push(_iso(d)); continue; }
    out.custNum += _num(row[0]) || 0; out.custDen += cd;
    out.devNum  += _num(row[2]) || 0; out.devDen  += dd;
  }
  return out;
}

// The two fractions out of a Day End or Weekly report body. Bounded to the
// Buying Statistics section: past it the review prose quotes numbers freely, and
// the Team Production table is full of x/y-shaped pairs.
function _convFromBody(body) {
  var lines = _wkLines(body);

  var from = _wkIdx(lines, /^buying statistics$/i, 0);
  if (from < 0) return {};
  var to = _wkIdx(lines, /^(review statistics|paytonai)/i, from);
  if (to < 0) to = lines.length;

  var ci = _wkLabelIdx(lines, 'customer conversion rate', from, to);
  var di = _wkLabelIdx(lines, 'device conversion rate', from, to);
  return {
    cust: ci >= 0 ? _wkFraction(lines, ci) : null,
    dev:  di >= 0 ? _wkFraction(lines, di) : null
  };
}

/**
 * Re-reads every Day End Report still in the mailbox and banks its fractions.
 *
 * Idempotent, so the window can be as wide as you like. Note what it CANNOT do:
 * a day whose report never reached this mailbox is simply absent, and the sum
 * would then run on a short denominator — which is why _convMtd reports the gaps
 * and the weekly run refuses to write S/U while any remain.
 */
function backfillConversions(opts) {
  opts = opts || {};
  var days = opts.days || 45;
  var report = { ok: true, kind: 'conversions-backfill', days: days,
    dryRun: !!opts.dryRun, conversions: [], warnings: [], errors: [],
    examined: 0, seen: 0, byDate: {} };

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var q = '(from:(' + BUY_SENDER + ') OR subject:("Day End Report")) newer_than:' + days + 'd';
  var msgs = [];
  GmailApp.search(q, 0, 400).forEach(function (t) {
    t.getMessages().forEach(function (m) { msgs.push(m); });
  });

  msgs.forEach(function (msg) {
    if (!DAY_END_SUBJECT.test(String(msg.getSubject() || ''))) return;
    report.examined++;
    var sub = _buyParseSubject(msg.getSubject());
    if (!sub.ok) { report.errors.push({ subject: msg.getSubject(), error: sub.why }); return; }
    var f = _convFromBody(_plainBody(msg));
    if (!f.cust && !f.dev) {
      report.warnings.push({ subject: msg.getSubject(), note: 'no conversion fractions found' });
      return;
    }
    report.seen++;
    report.byDate[_iso(sub.date)] = (report.byDate[_iso(sub.date)] || 0) + 1;
    _convWrite(ss, sub.store, sub.date, f.cust, f.dev, opts.dryRun, report);
  });

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

function dryRunConversionsBackfill() { return backfillConversions({ dryRun: true }); }
function runConversionsBackfill()    { return backfillConversions({}); }

/**
 * Proves the premise the MTD figure rests on: that a week of banked DAILY
 * fractions adds up to the WEEKLY report's own fraction for the same days.
 *
 * If they agree per store, then summing a month of dailies is a sound way to get
 * a month's rate, and S/U can be trusted. If they disagree, the daily and weekly
 * figures are counting different things and no amount of arithmetic fixes it —
 * which is worth finding out before the column is filled in, not after.
 *
 * Read-only.
 */
function verifyConversionWeek(opts) {
  opts = opts || {};
  var ss = SpreadsheetApp.openById(SHEET_ID);

  var end = _todayInTz();
  end = _addDays(end, -1);
  while (end.getDay() !== 6) end = _addDays(end, -1);
  if (opts.weekEnd) {
    var w = new Date(opts.weekEnd + 'T12:00:00');
    if (!isNaN(w.getTime())) end = new Date(w.getFullYear(), w.getMonth(), w.getDate());
  }
  var start = _addDays(end, -6);

  var out = { ok: true, week: _iso(start) + '..' + _iso(end), stores: [] };
  var report = { warnings: [], errors: [] };
  var emails = _weeklyEmailsByStore(report, start, end);

  SUMMARY_STORES.forEach(function (store) {
    // _convMtd over the WEEK rather than the month — same summing, narrower span.
    var daily = _convMtd(ss, store, start, end);
    var e = emails[store];
    var row = {
      store: store,
      daily_cust: daily.custNum + '/' + daily.custDen,
      email_cust: e && e.cust ? e.cust.num + '/' + e.cust.den : null,
      daily_dev: daily.devNum + '/' + daily.devDen,
      email_dev: e && e.dev ? e.dev.num + '/' + e.dev.den : null,
      missing_days: daily.missing
    };
    row.cust_match = row.email_cust != null && row.daily_cust === row.email_cust;
    row.dev_match  = row.email_dev  != null && row.daily_dev  === row.email_dev;
    out.stores.push(row);
  });

  out.all_match = out.stores.every(function (s) { return s.cust_match && s.dev_match; });
  out.emails_seen = Object.keys(emails).length;
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

// ------------------------------------------------------------
// Shift rehearsal
// ------------------------------------------------------------
// The shift is the one destructive step, and a dry run cannot show it: copyTo
// either happened or it did not, and only the result is inspectable. So it gets
// rehearsed for real, on a throwaway duplicate, targeting NEXT week so the
// labels genuinely differ and a shift is genuinely triggered.
//
// Reports the before and after of all four blocks' labels plus one column of
// formulas, which is what proves copyTo re-pointed them (D =B31-C31 must become
// =B22-C22, not follow the data up unchanged).
var SHIFT_TEST_TAB = 'Summary SHIFT TEST';

function rehearseWeeklyShift(opts) {
  opts = opts || {};
  var ss = SpreadsheetApp.openById(SHEET_ID);

  var old = ss.getSheetByName(SHIFT_TEST_TAB);
  if (old) ss.deleteSheet(old);
  var src = ss.getSheetByName(SUMMARY_TAB);
  if (!src) return { ok: false, error: 'no tab named "' + SUMMARY_TAB + '"' };
  var copy = src.copyTo(ss).setName(SHIFT_TEST_TAB);

  // Next Saturday, so the target week differs from whatever the copy's bottom
  // block is labelled and the run has to shift rather than update in place.
  var end = _todayInTz();
  while (end.getDay() !== 6) end = _addDays(end, 1);

  var out = { ok: true, tab: SHIFT_TEST_TAB, targetWeekEnd: _iso(end) };
  out.before = _shiftSnapshot(copy);
  // force: next week has no figures yet, and this is about the shift, not them.
  out.run = ingestWeeklySummary({ tab: SHIFT_TEST_TAB, weekEnd: _iso(end), force: true });
  out.after = _shiftSnapshot(copy);
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

function _shiftSnapshot(sh) {
  var values = sh.getDataRange().getValues();
  var blocks = _summaryBlocks(values);
  return blocks.map(function (b) {
    var shown = sh.getRange(b.titleRow + 1, 1, 1, 2).getDisplayValues()[0];
    var ovl = sh.getRange(b.firstRow + 1, 1, 1, 30);
    return {
      label: String(shown[0]).trim() + ' | ' + String(shown[1]).trim(),
      ovl_revenue: ovl.getDisplayValues()[0][SUM_C.REV],
      ovl_gp_formula: sh.getRange(b.firstRow + 1, SUM_C.GP + 1).getFormula(),
      ovl_traffic: ovl.getDisplayValues()[0][SUM_C.TRAFFIC],
      ovl_rank_manual: ovl.getDisplayValues()[0][SUM_C.RANK],
      company_rev_formula: sh.getRange(b.companyRow + 1, SUM_C.REV + 1).getFormula()
    };
  });
}

// ------------------------------------------------------------
// Run-dropdown entry points
// ------------------------------------------------------------
function dryRunWeeklySummary() {
  var r = ingestWeeklySummary({ dryRun: true });
  Logger.log(JSON.stringify(r, null, 2));
  return r;
}

function runWeeklySummaryNow() {
  var r = ingestWeeklySummary({});
  Logger.log(JSON.stringify(r, null, 2));
  return r;
}

// 0-indexed column number -> A1 letters.
function _a1col(c) {
  var s = '';
  c += 1;
  while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = (c - m - 1) / 26; }
  return s;
}
