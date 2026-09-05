// ============================================================================
// outreach-sheet.gs — build the refunded-buyer eBay outreach workbook.
//
//   Run -> buildOutreachSheet
//
// Creates a NEW Google Sheet with one tab per store, so each manager works only
// their own list and two people cannot message the same buyer. Logs the URL.
//
// The sheet is created UNSHARED. Share it deliberately — it carries buyer names
// and purchase history for ~209 people.
//
// ONE ROW PER ORDER. eBay message threads hang off a specific item, so a single
// message covering four purchases would land in one item's thread and read as
// being about that item alone. Five buyers have more than one affected order —
// their rows sit together, and the "Buyer Orders" column says how many, so a
// manager can space those sends out rather than firing three at once.
//
// The Message column is finished text — nothing to fill in. Click the Contact
// Link, paste, send, set Status.
//
// ⚠️ TEST THE FIRST CONTACT LINK BEFORE WORKING THROUGH A WHOLE STORE. eBay
// changes these URL shapes without notice. If it no longer opens a compose
// window, use the Order Link column instead and hit "Contact buyer" there.
//
// THROWAWAY: this whole file can be deleted once the outreach is done. It
// creates a standalone sheet and touches nothing else. See the note at the
// bottom for which scripts in this project must NOT be deleted.
// ============================================================================

var OUT_ENDPOINT = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/outreach-list';
var OUT_SECRET   = 'sp33ks-sync-k3y-2026-x9mq';
var OUT_TITLE    = 'PayMore — Refunded Buyer Outreach (eBay) 2026-08-26';

var OUT_STORES = [
  { code: 'OVL', label: 'Overland Park', manager: 'Nick' },
  { code: 'LEE', label: "Lee's Summit",  manager: 'Jurell' },
  { code: 'WSP', label: 'Westport',      manager: 'Eli' },
  { code: 'MPL', label: 'Maplewood',     manager: 'Joseph' },
  { code: 'BAL', label: 'Ballwin',       manager: 'Joseph' }
];

var OUT_STATUSES = ['Not sent', 'Sent', 'Replied - paying', 'Replied - returning',
                    'Replied - declined', 'No response'];

// Column order for the store tabs. Kept in one place so the formatting below
// indexes off it rather than off hard-coded numbers that drift when a column
// is added.
var OUT_HEAD = ['Status', 'Buyer Name', 'Greeting', 'Check', 'eBay Username',
  'Item', 'eBay Order', '$ Refunded', 'Buyer Orders', 'Contact Link', 'Order Link', 'Message'];

function _outCol(name) { return OUT_HEAD.indexOf(name) + 1; }

function buildOutreachSheet() {
  var res = UrlFetchApp.fetch(
    OUT_ENDPOINT + '?secret=' + encodeURIComponent(OUT_SECRET),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    Logger.log('!! endpoint returned HTTP %s: %s', res.getResponseCode(), res.getContentText().slice(0, 300));
    return;
  }

  var data = JSON.parse(res.getContentText());
  var all = data.rows || [];
  if (!all.length) { Logger.log('!! no rows returned — nothing to build'); return; }

  Logger.log('eBay orders refunded: %s | excluded by hand: %s | never shipped: %s | unresolved: %s',
    data.refunded_orders, data.excluded_by_hand, data.excluded_never_shipped, data.unresolved);
  Logger.log('messages to send: %s | distinct buyers: %s | total: $%s',
    data.messages_to_send, data.distinct_buyers, data.total_to_ask_for);

  var ss = SpreadsheetApp.create(OUT_TITLE);

  // --- summary --------------------------------------------------------------
  var sum = ss.getSheets()[0];
  sum.setName('Summary');

  var srows = [
    ['PayMore — Refunded Buyer Outreach', ''],
    ['Generated', data.generated_at],
    ['', ''],
    ['eBay orders refunded', data.refunded_orders],
    ['Excluded — caught before shipping', data.excluded_by_hand],
    ['Excluded — never shipped', data.excluded_never_shipped],
    ['Messages to send (one per order)', data.messages_to_send],
    ['Distinct buyers', data.distinct_buyers],
    ['Buyers with more than one order', data.buyers_with_multiple_orders],
    ['Total to ask for', Number(data.total_to_ask_for)],
    ['', ''],
    ['Store', 'Detail']
  ];
  OUT_STORES.forEach(function (s) {
    var b = (data.by_store || {})[s.code];
    srows.push([
      s.code + ' — ' + s.label + ' (' + s.manager + ')',
      b ? (b.messages + ' messages, ' + b.buyers + ' buyers, $' + b.total) : 'none'
    ]);
  });
  srows.push(['', '']);
  srows.push(['How to use', 'Open your store tab. Click Contact Link, paste Message, send, set Status.']);
  srows.push(['Before you start', 'Test the FIRST contact link. If it does not open a compose window, use Order Link instead.']);
  srows.push(['Names', 'Rows tinted and marked CHECK have a business or forwarder name — read the greeting before sending.']);
  srows.push(['Repeat buyers', 'Where Buyer Orders is above 1, that person gets more than one message. Space them out.']);

  sum.getRange(1, 1, srows.length, 2).setValues(srows);
  sum.getRange(1, 1, 1, 2).setFontWeight('bold').setFontSize(13);
  // Located by label, not by a hard-coded row: adding a line above it must not
  // silently money-format the wrong cell.
  for (var i = 0; i < srows.length; i++) {
    if (srows[i][0] === 'Total to ask for') { sum.getRange(i + 1, 2).setNumberFormat('$#,##0.00'); break; }
  }
  sum.setColumnWidth(1, 300);
  sum.setColumnWidth(2, 560);

  // --- one tab per store ----------------------------------------------------
  OUT_STORES.forEach(function (s) {
    var rows = all.filter(function (r) { return r.store === s.code; });
    var sh = ss.insertSheet(s.code + ' (' + rows.length + ')');
    if (!rows.length) {
      sh.getRange(1, 1).setValue('Nothing to send for ' + s.code + '.');
      return;
    }

    var values = [OUT_HEAD];
    rows.forEach(function (r) {
      values.push([
        'Not sent',
        r.full_name || '',
        r.greeting || '',
        r.name_needs_check ? 'CHECK' : '',
        r.username || '',
        r.item || '',
        r.ebay_order_id || '',
        Number(r.amount),
        r.buyer_order_count,
        r.ebay_contact_url || '',
        r.ebay_order_url || '',
        r.message || ''
      ]);
    });
    sh.getRange(1, 1, values.length, OUT_HEAD.length).setValues(values);

    sh.getRange(1, 1, 1, OUT_HEAD.length).setFontWeight('bold')
      .setBackground('#0f3d2e').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.getRange(2, _outCol('$ Refunded'), rows.length, 1).setNumberFormat('$#,##0.00');

    // Status as a dropdown so the column stays reportable instead of drifting
    // into free text.
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(OUT_STATUSES, true).setAllowInvalid(false).build();
    sh.getRange(2, _outCol('Status'), rows.length, 1).setDataValidation(rule);

    // The message is long. Wrap it but pin the row height, or every row becomes
    // a screen tall and the sheet stops being scannable.
    sh.getRange(2, _outCol('Message'), rows.length, 1).setWrap(true).setVerticalAlignment('top');

    sh.setColumnWidth(_outCol('Status'), 120);
    sh.setColumnWidth(_outCol('Buyer Name'), 200);
    sh.setColumnWidth(_outCol('Greeting'), 100);
    sh.setColumnWidth(_outCol('Check'), 60);
    sh.setColumnWidth(_outCol('eBay Username'), 150);
    sh.setColumnWidth(_outCol('Item'), 320);
    sh.setColumnWidth(_outCol('eBay Order'), 130);
    sh.setColumnWidth(_outCol('$ Refunded'), 100);
    sh.setColumnWidth(_outCol('Buyer Orders'), 100);
    sh.setColumnWidth(_outCol('Contact Link'), 160);
    sh.setColumnWidth(_outCol('Order Link'), 160);
    sh.setColumnWidth(_outCol('Message'), 620);
    sh.setRowHeights(2, rows.length, 21);

    // Tinted, not merely labelled: a CHECK row needs to be noticed before the
    // greeting goes out, and a one-word column is easy to scroll past.
    sh.getRange(2, 1, rows.length, OUT_HEAD.length).setBackgrounds(
      rows.map(function (r) {
        var c = r.name_needs_check ? '#fff4e5' : null;
        return OUT_HEAD.map(function () { return c; });
      }));

    sh.getRange(2, _outCol('Status'), rows.length, 1).setHorizontalAlignment('center');
    sh.getRange(2, _outCol('Buyer Orders'), rows.length, 1).setHorizontalAlignment('center');
  });

  // --- what was deliberately excluded --------------------------------------
  // Its own tab, because "who did we decide NOT to contact, and why" is the
  // question someone will ask in a week.
  var ex = ss.insertSheet('Excluded');
  var exRows = [['Store', 'eBay Order', 'Buyer', 'Item', '$ Refunded', 'Why not contacted']];
  (data.excluded_by_hand_rows || []).concat(data.never_shipped || []).forEach(function (x) {
    exRows.push([x.store, x.ebay_order_id, x.buyer || '', x.item || '', Number(x.refunded), x.why]);
  });
  ex.getRange(1, 1, exRows.length, 6).setValues(exRows);
  ex.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#0f3d2e').setFontColor('#ffffff');
  ex.setFrozenRows(1);
  ex.getRange(2, 5, Math.max(exRows.length - 1, 1), 1).setNumberFormat('$#,##0.00');
  ex.setColumnWidth(4, 320);
  ex.setColumnWidth(6, 340);

  ss.setActiveSheet(sum);
  Logger.log('DONE. Sheet created (unshared): %s', ss.getUrl());
}

// ============================================================================
// SAFE TO DELETE when the outreach is finished: this file, and
// refund-report-sheet.gs. Both only build standalone sheets from an endpoint.
//
// ⚠️ DO NOT DELETE from this project: sales-email-import.gs, month-rollover.gs,
// buysell-history.gs, sales-sync.gs, hub-google-reviews.gs, hub-reviews-file.gs
// and netprofit-sheet.gs — they are on live triggers or are the Net Profit
// writer. The dupe-fix scripts (mpc-, newmc-, nmc-) are one-shot but worth
// keeping as the record of what was written to the Sales Summary and why.
// ============================================================================
