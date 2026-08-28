// ============================================================================
// netprofit-alerts.gs — the NET PROFIT tab's email alerts.
//
//   npaTestEmail()   send one of each, with made-up figures, to prove delivery.
//
// Mirrors sales-email-import.gs's _sendChangeAlert deliberately: same
// thresholds, same four-column table, same green/red rule, same "a day being
// filled for the FIRST time is not a change" rule. Two feeds that behave the
// same way should look the same in the inbox.
//
// THREE ALERTS, and only the first is a mirror:
//
//   1. FIGURES CHANGED. A day's Net Profit that already had a value now has a
//      different one. This matters MORE here than on the Sales tab: 81% of
//      shipping labels post the day after the sale and 13% two to three days
//      later, so a day's Net Profit genuinely keeps moving for most of a week.
//      The alert is how that stops being invisible.
//
//   2. THE RUN FAILED, OR WROTE NOTHING. New, and the reason this file exists
//      at all. Every guard built into these scripts — no tab, month behind the
//      60-day wall, close-calendar drift, collector returned no days — logs a
//      line and returns. Nobody reads Apps Script logs. An unattended job that
//      fails politely is indistinguishable from one that never ran.
//
//   3. THE MONTH CLOSED. One confirmation on close night, because that is the
//      moment the figure stops moving and becomes the number a bonus is paid
//      from. Silence on that night is the wrong default.
//
// ⚠️ SEPTEMBER ONLY, BY AGREEMENT (user, 2026-08-28). Once the two sheets
// become one, this duplicates the Sales alerts and should be switched off with
// NPA_ENABLED rather than left to double-mail every change.
//
// Prefixed NPA_/_npa: one Apps Script project is one global scope, and this
// must not collide with the Sales importer if the two ever share a project.
// ============================================================================

var NPA_ENABLED   = true;
var NPA_ALERT_TO  = 'ethan.kushnir@speekstechnology.com';

// Same numbers as the Sales importer, on purpose. Worth revisiting after a
// week of real September data: a day's Net Profit is a smaller number than a
// day's sales, so the same dollar threshold is a coarser filter here.
var NPA_CHANGE_OVER = 150;   // report at or above this
var NPA_BIG_CHANGE  = 300;   // colour it green or red at or above this

var NPA_FROM_NAME = 'SPEEKS Net Profit';

// ---------------------------------------------------------------------------
// snapshot / diff
// ---------------------------------------------------------------------------

// Net Profit per store per day, plus the month total, read off the tab. NP is a
// formula (+12), so this is the computed figure — the same one a person reads.
// Returns null when there is no tab yet, which is not an error: the very first
// run of a month has nothing to compare against.
function _npaSnapshot(ym) {
  try {
    var ss = SpreadsheetApp.openById(NP_SHEET_ID);
    var sh = ss.getSheetByName(_npTabName(ym));
    if (!sh) return null;
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    var v = sh.getRange(1, 1, lastRow, lastCol).getValues();
    var ttl = _npxFindRow(v, NP_BASES.OVL, 'TTL');
    if (ttl < 0) return null;

    var snap = { days: {}, month: {} };
    for (var i = 0; i < NP_ORDER.length; i++) {
      var st = NP_ORDER[i], b = NP_BASES[st];
      for (var r = NP_HEADER_ROWS; r < ttl; r++) {
        var day = parseInt(v[r][b], 10);
        if (!day) continue;
        var np = v[r][b + NPX_OFF_NP];
        // Only a NUMBER counts as "had a value". An empty cell, an #N/A from a
        // blocked fee column, or the "" a formula returns for a blank day are
        // all "not filled yet" — and filling one is not a change.
        if (typeof np !== 'number' || !isFinite(np)) continue;
        snap.days[st + ':' + day] = Math.round(np * 100) / 100;
      }
      var m = v[ttl][b + NPX_OFF_NP];
      if (typeof m === 'number' && isFinite(m)) snap.month[st] = Math.round(m * 100) / 100;
    }
    return snap;
  } catch (e) {
    Logger.log('  (alert snapshot failed, continuing without one: %s)', e);
    return null;   // never let the alerting break the write it is watching
  }
}

function _npaDiff(before, after) {
  var out = [];
  if (!before || !after) return out;
  for (var k in after.days) {
    if (!(k in before.days)) continue;          // first fill is not a change
    var d = Math.round((after.days[k] - before.days[k]) * 100) / 100;
    if (Math.abs(d) < NPA_CHANGE_OVER) continue;
    var p = k.split(':');
    out.push({ store: p[0], day: Number(p[1]), from: before.days[k], to: after.days[k], delta: d });
  }
  out.sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
  return out;
}

// ---------------------------------------------------------------------------
// the one entry point the schedule calls
// ---------------------------------------------------------------------------

function _npaReport(before, ym, what) {
  if (!NPA_ENABLED) return;
  var after = _npaSnapshot(ym);
  var list = _npaDiff(before, after);
  if (!list.length) {
    Logger.log('  no Net Profit figure moved by %s or more — no alert sent.',
      _npaUsd0(NPA_CHANGE_OVER));
    return;
  }
  Logger.log('  %s figure(s) moved by %s or more — alerting.', list.length,
    _npaUsd0(NPA_CHANGE_OVER));
  _npaSendChanges(list, ym, what);
}

// ---------------------------------------------------------------------------
// 1. figures changed
// ---------------------------------------------------------------------------

function _npaSendChanges(list, ym, what) {
  // FOUR columns. The Sales version learned this the hard way: at six, the
  // Change column — the one number the email exists to deliver — was pushed off
  // the right edge of a phone, and mobile mail clients clip rather than scroll.
  var td = 'padding:10px 8px;border-bottom:1px solid #eaefeb;font-size:14px;vertical-align:top;';
  var rows = list.map(function (m) {
    var up = m.delta > 0;
    var big = Math.abs(m.delta) >= NPA_BIG_CHANGE;
    // Colour only once it is worth reacting to, or the small ones shout as
    // loudly as the big ones.
    var colour = !big ? '#64707c' : (up ? '#17603a' : '#9b2c1f');
    return '<tr>'
      + '<td style="' + td + 'font-weight:700;color:#1a1f24;white-space:nowrap;">'
      + _npaMonAbbr(ym) + ' ' + m.day + '</td>'
      + '<td style="' + td + 'font-weight:700;color:#1a1f24;">' + m.store
      + '<div style="font-weight:600;color:#9aa6ad;font-size:12px;margin-top:2px;">'
      + 'Net Profit</div></td>'
      + '<td style="' + td + 'color:#64707c;white-space:nowrap;">' + _npaUsd(m.from)
      + '<div style="color:#1a1f24;font-weight:700;margin-top:2px;">' + _npaUsd(m.to)
      + '</div></td>'
      + '<td style="' + td + 'font-weight:800;text-align:right;white-space:nowrap;color:'
      + colour + ';">' + (up ? '+' : '−') + _npaUsd(Math.abs(m.delta))
      + (big ? '' : '<div style="font-weight:600;color:#9aa6ad;font-size:12px;'
        + 'margin-top:2px;">minor</div>') + '</td></tr>';
  }).join('');

  var one = list.length === 1 ? list[0] : null;
  var subject = one
    ? 'Net Profit — ' + one.store + ' ' + _npaMonAbbr(ym) + ' ' + one.day
      + ' changed by ' + (one.delta > 0 ? '+' : '−') + _npaUsd(Math.abs(one.delta))
    : 'Net Profit — ' + list.length + ' changes of ' + _npaUsd0(NPA_CHANGE_OVER) + ' or more';

  var body = '<p style="margin:0 0 14px;color:#64707c;font-size:14px;line-height:1.5;">'
    + 'Days already in the sheet now report a different Net Profit, and the sheet has '
    + 'been updated to match. This is normal and usually means a shipping label posted '
    + 'late: 81% are bought the day after the sale and 13% two to three days later, so '
    + 'a day keeps moving for most of a week. Worth a look if a figure moves after that, '
    + 'or moves a long way.</p>'
    + '<table style="width:100%;border-collapse:collapse;table-layout:fixed;">'
    + '<tr>' + _npaTh('Day', '19%', '') + _npaTh('Store', '26%', '')
    + _npaTh('Was &rarr; now', '30%', '') + _npaTh('Change', '25%', 'text-align:right;')
    + '</tr>' + rows + '</table>'
    + '<p style="margin:16px 0 0;color:#9aa6ad;font-size:12px;line-height:1.5;">'
    + 'Reported once a figure moves by ' + _npaUsd0(NPA_CHANGE_OVER)
    + ' or more; coloured once it reaches ' + _npaUsd0(NPA_BIG_CHANGE)
    + '. A day being filled in for the first time is not counted. From the ' + what + '.</p>';

  var plain = list.map(function (m) {
    return _npaMonAbbr(ym) + ' ' + m.day + '  ' + m.store + '  Net Profit: '
      + _npaUsd(m.from) + ' -> ' + _npaUsd(m.to)
      + '  (' + (m.delta > 0 ? '+' : '') + _npaUsd(m.delta) + ')';
  }).join('\n');

  _npaSend(subject, plain, _npaShell('Net Profit', 'Figures already in the sheet have changed',
    '#1f9d57', body));
}

// ---------------------------------------------------------------------------
// 2. the run failed, or wrote nothing
// ---------------------------------------------------------------------------
// ⚠️ EVERY LINE HERE SAYS WHO FIXES IT. House rule: an alert that only says
// what broke leaves the reader deciding whether it is theirs, and the usual
// answer to that is to do nothing.
function _npaSendFailure(where, detail, whoFixes) {
  if (!NPA_ENABLED) return;
  var body = '<p style="margin:0 0 14px;color:#64707c;font-size:14px;line-height:1.5;">'
    + '<b>' + _npaEsc(where) + '</b> did not complete. The NET PROFIT tab may be '
    + 'missing a day, or the whole run.</p>'
    + '<div style="background:#fdf3f2;border:1px solid #f3d9d5;border-radius:12px;'
    + 'padding:14px 16px;margin:0 0 14px;">'
    + '<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;'
    + 'color:#9b2c1f;font-weight:700;margin-bottom:6px;">What happened</div>'
    + '<div style="font-size:13px;color:#1a1f24;line-height:1.5;font-family:ui-monospace,'
    + 'SFMono-Regular,Menlo,monospace;word-break:break-word;">' + _npaEsc(detail) + '</div></div>'
    + '<div style="background:#f4f8f5;border:1px solid #dfeae3;border-radius:12px;'
    + 'padding:14px 16px;">'
    + '<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;'
    + 'color:#1f9d57;font-weight:700;margin-bottom:6px;">Who fixes it</div>'
    + '<div style="font-size:14px;color:#1a1f24;line-height:1.5;">'
    + _npaEsc(whoFixes) + '</div></div>'
    + '<p style="margin:16px 0 0;color:#9aa6ad;font-size:12px;line-height:1.5;">'
    + 'The next scheduled run rewrites the whole month to date, so a single missed run '
    + 'usually repairs itself. Two in a row does not.</p>';

  _npaSend('Net Profit — ' + where + ' did not complete',
    where + ' did not complete.\n\n' + detail + '\n\nWho fixes it: ' + whoFixes,
    _npaShell('Net Profit', where + ' did not complete', '#9b2c1f', body));
}

// ---------------------------------------------------------------------------
// 3. the month closed
// ---------------------------------------------------------------------------
function _npaSendClose(ym, snap) {
  if (!NPA_ENABLED) return;
  var td = 'padding:10px 8px;border-bottom:1px solid #eaefeb;font-size:14px;';
  var total = 0, rows = '';
  for (var i = 0; i < NP_ORDER.length; i++) {
    var st = NP_ORDER[i];
    var v = snap && snap.month && (st in snap.month) ? snap.month[st] : null;
    if (v !== null) total += v;
    rows += '<tr><td style="' + td + 'font-weight:700;color:#1a1f24;">' + st + '</td>'
      + '<td style="' + td + 'text-align:right;font-weight:700;color:'
      + (v === null ? '#9b2c1f' : (v < 0 ? '#9b2c1f' : '#1a1f24')) + ';">'
      + (v === null ? 'not available' : _npaUsd(v)) + '</td></tr>';
  }
  var body = '<p style="margin:0 0 14px;color:#64707c;font-size:14px;line-height:1.5;">'
    + '<b>' + _npaMonthName(ym) + '</b> is closed. Nothing rewrites it from here — the '
    + 'daily refresh only ever touches the current month, and anything that arrives late '
    + 'books to the day it is charged, in the new month. These are the figures.</p>'
    + '<table style="width:100%;border-collapse:collapse;">' + rows
    + '<tr><td style="' + td + 'font-weight:800;color:#1a1f24;border-top:2px solid #1a1f24;">'
    + 'Company</td><td style="' + td + 'text-align:right;font-weight:800;color:#1a1f24;'
    + 'border-top:2px solid #1a1f24;">' + _npaUsd(total) + '</td></tr></table>'
    + '<p style="margin:16px 0 0;color:#9aa6ad;font-size:12px;line-height:1.5;">'
    + 'If one of these looks wrong, say so before it is paid on. Reopening a closed month '
    + 'is deliberate and manual (npsReopenMonth).</p>';

  _npaSend('Net Profit — ' + _npaMonthName(ym) + ' is closed at ' + _npaUsd(total),
    _npaMonthName(ym) + ' closed. Company Net Profit ' + _npaUsd(total),
    _npaShell('Net Profit', _npaMonthName(ym) + ' is closed', '#1f9d57', body));
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

function _npaSend(subject, plain, html) {
  try {
    GmailApp.sendEmail(NPA_ALERT_TO, subject, plain, { htmlBody: html, name: NPA_FROM_NAME });
    Logger.log('  alert sent: %s', subject);
  } catch (e) {
    // An alert that throws must never take the write down with it.
    Logger.log('  !! could not send the alert (%s): %s', subject, e);
  }
}

function _npaShell(eyebrow, title, accent, inner) {
  return '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,'
    + 'sans-serif;background:#f7faf8;padding:28px;">'
    + '<div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #eaefeb;'
    + 'border-radius:18px;overflow:hidden;">'
    + '<div style="padding:20px 24px;border-bottom:1px solid #eaefeb;">'
    + '<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:'
    + accent + ';font-weight:700;">' + eyebrow + '</div>'
    + '<div style="font-size:17px;font-weight:700;color:#1a1f24;margin-top:3px;">'
    + title + '</div></div>'
    + '<div style="padding:20px 24px;">' + inner + '</div></div></div>';
}

function _npaTh(label, width, extra) {
  return '<th style="width:' + width + ';text-align:left;padding:0 8px 8px;font-size:11px;'
    + 'letter-spacing:.06em;text-transform:uppercase;color:#9aa6ad;font-weight:700;'
    + extra + '">' + label + '</th>';
}

function _npaEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _npaUsd(n) {
  var v = Number(n) || 0, neg = v < 0;
  var p = Math.abs(v).toFixed(2).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '−$' : '$') + p.join('.');
}

function _npaUsd0(n) {
  return '$' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function _npaMonAbbr(ym) { return NP_MON_ABBR[Number(ym.slice(5, 7)) - 1]; }

function _npaMonthName(ym) {
  var full = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
              'August', 'September', 'October', 'November', 'December'];
  return full[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Prove delivery without waiting for something to go wrong.
// ---------------------------------------------------------------------------
function npaTestEmail() {
  var ym = String(NP_FROM).slice(0, 7);
  Logger.log('Sending three sample alerts to %s for %s', NPA_ALERT_TO, ym);
  _npaSendChanges([
    { store: 'OVL', day: 3, from: 2410.55, to: 1902.18, delta: -508.37 },
    { store: 'WSP', day: 4, from: 1655.00, to: 1836.42, delta: 181.42 }
  ], ym, 'test run');
  _npaSendFailure('The 2pm daily refresh', 'OVL: collector returned HTTP 500',
    'Claude — the collector is failing, not the sheet. Send this email on.');
  _npaSendClose(ym, { month: { OVL: 46748.07, LEE: 41654.54, WSP: 60340.92,
                               MPL: 29132.06, BAL: 39746.49 } });
  Logger.log('Sent. Nothing was read from or written to the sheet.');
}
