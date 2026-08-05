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

// Candidate labels for the two numbers, most-specific first. Shopify's wording
// varies by report type, so each number is matched against a list rather than
// one hardcoded string. diagnoseShopifyEmails() prints every "label: $number"
// pair it can see, which is how this list gets confirmed.
var SALES_LABELS = ['net sales', 'total sales', 'gross sales', 'sales'];
var COST_LABELS  = ['cost of goods sold', 'total cost', 'cogs', 'cost'];

// ------------------------------------------------------------
// Web app entry points
// ------------------------------------------------------------
function doPost(e) { return _handle(e); }
function doGet(e)  { return _handle(e); }

function _handle(e) {
  var p = (e && e.parameter) || {};
  if (p.secret !== SECRET) return _json({ ok: false, error: 'unauthorized' });

  var action = p.action || 'ingest';
  try {
    if (action === 'diagnose') return _json(diagnoseShopifyEmails());
    return _json(ingestSalesEmails({
      reverify: p.reverify ? parseInt(p.reverify, 10) : REVERIFY,
      dryRun:   p.dryRun === '1'
    }));
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
      daysThru: [], goalColors: [], archived: 0
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

  m = String(s).match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s*(20\d{2})\b/i);
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
