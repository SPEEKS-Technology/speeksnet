// ============================================================================
// refund-report-sheet.gs — builds the PayMore duplicate-refund workbook as a
// real Google Sheet, in your Drive, from live data.
//
// WHY THIS EXISTS RATHER THAN AN UPLOADED .xlsx: getting an 82KB workbook into
// Drive from the assistant side means transferring ~109,000 characters of
// base64 through a text channel, where one dropped character yields a file that
// looks fine until PayMore opens it. This script runs AS you, fetches the
// figures itself, and writes the cells natively. Nothing binary moves.
//
// TO RUN: paste into the Apps Script project, then Run -> buildRefundReport.
// No deployment — this is a Run-from-the-editor script. It logs the URL of the
// new spreadsheet. Re-running makes a NEW file; it never edits an old one, so a
// copy already sent to PayMore can never be altered underneath them.
//
// Prefixed RRS_/_rrs: one Apps Script project is one global scope.
// ============================================================================

var RRS_ENDPOINT = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/refund-export';
var RRS_SECRET   = 'sp33ks-sync-k3y-2026-x9mq';
var RRS_TZ       = 'America/Chicago';

var RRS_WAVE = {
  'mc-backfill-2026-08-20':         'Old MC (Aug 20)',
  'new-mc-adoption-2026-08-24':     'New MC LEE/MPL/BAL (Aug 24)',
  'ovl-new-mc-adoption-2026-08-25': 'New MC OVL (Aug 25)',
  'wsp-new-mc-adoption-2026-08-25': 'New MC WSP (Aug 25)',
  'newmc-stragglers-2026-08-25':    'New MC Stragglers (Aug 25)'
};

function _rrsMoney(v) { return Math.round(parseFloat(v || 0) * 100) / 100; }
function _rrsSum(a) {
  var t = 0;
  for (var i = 0; i < a.length; i++) t += a[i];
  return Math.round(t * 100) / 100;
}
function _rrsCentral(iso) {
  if (!iso) return '';
  return Utilities.formatDate(new Date(iso), RRS_TZ, 'yyyy-MM-dd HH:mm');
}

function buildRefundReport() {
  var res = UrlFetchApp.fetch(RRS_ENDPOINT + '?secret=' + encodeURIComponent(RRS_SECRET),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('refund-export returned ' + res.getResponseCode() + ': '
      + res.getContentText().slice(0, 300));
  }
  var src = JSON.parse(res.getContentText());
  var rows = src.rows || [];

  // Refuse to build a document for corporate off a partial measurement.
  if (src.non_200) throw new Error(src.non_200 + ' orders did not return HTTP 200 — re-probe first');
  if (!rows.length) throw new Error('no rows returned');
  for (var i = 0; i < rows.length; i++) {
    if (!RRS_WAVE[rows[i].batch]) throw new Error('unmapped batch: ' + rows[i].batch);
  }

  var affected = [], clear = [];
  for (var j = 0; j < rows.length; j++) {
    var r = rows[j];
    if (_rrsMoney(r.ebay_refund_total) > 0) affected.push(r); else clear.push(r);
  }
  affected.sort(function (a, b) { return _rrsMoney(b.ebay_refund_total) - _rrsMoney(a.ebay_refund_total); });
  clear.sort(function (a, b) { return _rrsMoney(b.shopify_refund) - _rrsMoney(a.shopify_refund); });

  var total    = _rrsSum(affected.map(function (r) { return _rrsMoney(r.ebay_refund_total); }));
  var exposure = _rrsSum(clear.map(function (r) { return _rrsMoney(r.shopify_refund); }));
  var shipped  = affected.filter(function (r) { return r.ebay_fulfillment_status === 'FULFILLED'; }).length;
  var newRows  = affected.filter(function (r) { return !(_rrsMoney(r.base_refund_total) > 0); });
  var newAmt   = _rrsSum(newRows.map(function (r) { return _rrsMoney(r.ebay_refund_total); }));

  var measured = _rrsCentral(src.measured_to);
  var stamp    = Utilities.formatDate(new Date(src.measured_to), RRS_TZ, 'yyyy-MM-dd');
  var ss = SpreadsheetApp.create('PayMore eBay Duplicate Refunds ' + stamp);

  // ---- Read Me -------------------------------------------------------------
  var notes = [
    ['PayMore — Duplicate eBay Orders Refunded To Buyers'],
    ['Re-measured ' + measured + ' US Central against the eBay Sell Fulfillment API. All times US Central.'],
    [''],
    ['HEADLINE'],
    [affected.length + ' orders, $' + total.toFixed(2) + ', refunded to buyers on eBay without anybody requesting it.'],
    [shipped + ' of those had already shipped, so the buyer kept the goods and got the money back.'],
    ['A further ' + clear.length + ' orders ($' + exposure.toFixed(2) + ') are refunded in Shopify and still show PAID on eBay.'],
    [''],
    ['WHAT HAPPENED'],
    ['We refunded a batch of duplicate orders inside Shopify. Those were bookkeeping corrections — each was a'],
    ['second copy of a sale that had already been fulfilled through another system, so no money was owed to'],
    ['anyone. Something then propagated those Shopify refunds through to eBay and returned the money to the'],
    ['buyer as well. Every affected order shows eBay cancelState = NONE_REQUESTED: no buyer asked for a refund.'],
    [''],
    ['WHY THIS FIGURE IS HIGHER THAN THE ONE SENT ON AUG 25'],
    ['The Aug 25 figure was ' + (affected.length - newRows.length) + ' orders / $' + (total - newAmt).toFixed(2) + '. It was not wrong; it was incomplete.'],
    [newRows.length + ' further orders ($' + newAmt.toFixed(2) + ') have since been confirmed — but their eBay refund dates are'],
    ['Aug 24, BEFORE that measurement ran. eBay\'s order API does not show a refund until it settles: the same'],
    ['order returned orderPaymentStatus PAID with an empty refunds array on Aug 25, and FULLY_REFUNDED on Aug 26,'],
    ['with a refundDate of Aug 24. Settlement lag ranged from about 3.5 hours to about 42 hours.'],
    [''],
    ['CONSEQUENCE: the ' + clear.length + ' orders still showing PAID cannot be treated as safe on a single reading.'],
    ['Some may already be refunded and not yet settled. Any figure quoted from this data needs its measurement'],
    ['date attached, and this workbook should be re-run before it is treated as final.'],
    [''],
    ['EVIDENCE ON TIMING — see the "Refund Timing" sheet'],
    ['All ' + affected.length + ' refunds landed in a handful of batches, and every batch fired between :35 and :37 past the hour.'],
    ['The delay between our Shopify refund and the eBay refund is simply the wait until the next :35 —'],
    ['8 to 14 minutes where we refunded at :21, 37 minutes where we refunded at :58, 47 minutes at :47.'],
    ['Our own refunds were spread across 00:33, 14:47, 16:21 and 16:58; the eBay side clusters on :35.'],
    ['That pattern is a scheduled hourly job, not an event-driven webhook.'],
    [''],
    ['EVIDENCE ON SCOPE'],
    ['A batch of 58 duplicate orders refunded in Shopify on Aug 20, before the cutover, has NEVER propagated:'],
    ['0 of 58, $0.00, still true six days later. Same code on our side, same refund call, different'],
    ['Marketplace Connect. That is a controlled comparison, not an inference.'],
    [''],
    ['WHAT WE ARE ASKING'],
    ['1. Confirm whether the ' + clear.length + ' orders still showing PAID are permanently safe or still queued to propagate.'],
    ['2. Confirm whether the hourly job can be disabled for these accounts so no further refunds propagate.'],
    ['3. Advise on recovery for the ' + shipped + ' orders where the buyer kept the goods and the money.'],
    [''],
    ['READING THE SHEETS'],
    ['Summary — per store, with the split between confirmed loss and unconfirmed exposure.'],
    ['Refunded On eBay — the ' + affected.length + ' orders where eBay confirms money went back to the buyer. This is the loss.'],
    ['Not Refunded On eBay — the ' + clear.length + ' orders refunded in Shopify where eBay still shows PAID.'],
    ['Refund Timing — every propagation batch, to the minute.'],
    [''],
    ['"Money Lost" is the amount eBay actually returned, which is the order total less eBay fees retained.'],
    ['"First Confirmed" records which measurement first saw a given refund, not when it happened.']
  ];
  var readme = ss.getSheets()[0].setName('Read Me');
  readme.getRange(1, 1, notes.length, 1).setValues(notes);
  readme.setColumnWidth(1, 720);
  readme.getRange(1, 1).setFontWeight('bold').setFontSize(14);

  // ---- Summary -------------------------------------------------------------
  var stores = ['OVL', 'LEE', 'MPL', 'BAL', 'WSP'];
  var sumHdr = ['Store', 'Duplicate Orders Refunded In Shopify', 'Refunded To Buyer On eBay',
    'Money Lost', 'Of Those, Already Shipped', 'Newly Confirmed Since Aug 25',
    'Not Yet Refunded On eBay', 'Unconfirmed Exposure'];
  var sumRows = [];
  for (var s = 0; s < stores.length; s++) {
    var st = stores[s];
    var a = affected.filter(function (r) { return r.store_code === st; });
    var c = clear.filter(function (r) { return r.store_code === st; });
    sumRows.push([st, a.length + c.length, a.length,
      _rrsSum(a.map(function (r) { return _rrsMoney(r.ebay_refund_total); })),
      a.filter(function (r) { return r.ebay_fulfillment_status === 'FULFILLED'; }).length,
      a.filter(function (r) { return !(_rrsMoney(r.base_refund_total) > 0); }).length,
      c.length, _rrsSum(c.map(function (r) { return _rrsMoney(r.shopify_refund); }))]);
  }
  sumRows.push(['TOTAL', affected.length + clear.length, affected.length, total,
    shipped, newRows.length, clear.length, exposure]);
  _rrsWrite(ss, 'Summary', sumHdr, sumRows, [70, 240, 190, 110, 170, 200, 175, 160], [4, 8]);

  // ---- Refunded On eBay ----------------------------------------------------
  var affHdr = ['Store', 'Shopify Order', 'SKU', 'eBay Order ID', 'Refunded To Buyer On eBay',
    'eBay Order Total', 'Shopify Refund Amount', 'eBay Payment Status', 'Shipped To Buyer',
    'Buyer Requested Refund', 'Shopify Refunded (Central)', 'eBay Refunded (Central)',
    'Cutover Wave', 'First Confirmed'];
  var affRows = affected.map(function (r) {
    return [r.store_code, r.order_name, r.sku, r.ebay_order_id,
      _rrsMoney(r.ebay_refund_total), _rrsMoney(r.ebay_order_total), _rrsMoney(r.shopify_refund),
      r.ebay_payment_status, r.ebay_fulfillment_status === 'FULFILLED' ? 'Yes' : 'No',
      r.ebay_cancel_state === 'NONE_REQUESTED' ? 'No' : r.ebay_cancel_state,
      _rrsCentral(r.shopify_refunded_at), _rrsCentral(r.ebay_refund_date),
      RRS_WAVE[r.batch], _rrsMoney(r.base_refund_total) > 0 ? 'Aug 25 measurement' : 'Aug 26 re-measurement'];
  });
  _rrsWrite(ss, 'Refunded On eBay', affHdr, affRows,
    [60, 120, 220, 130, 175, 130, 160, 150, 120, 165, 185, 175, 205, 165], [5, 6, 7]);

  // ---- Not Refunded On eBay ------------------------------------------------
  var clrHdr = ['Store', 'Shopify Order', 'SKU', 'eBay Order ID', 'eBay Order Total',
    'Shopify Refund Amount', 'eBay Payment Status', 'Shipped To Buyer',
    'Shopify Refunded (Central)', 'Cutover Wave'];
  var clrRows = clear.map(function (r) {
    return [r.store_code, r.order_name, r.sku, r.ebay_order_id,
      _rrsMoney(r.ebay_order_total), _rrsMoney(r.shopify_refund), r.ebay_payment_status,
      r.ebay_fulfillment_status === 'FULFILLED' ? 'Yes' : 'No',
      _rrsCentral(r.shopify_refunded_at), RRS_WAVE[r.batch]];
  });
  _rrsWrite(ss, 'Not Refunded On eBay', clrHdr, clrRows,
    [60, 120, 220, 130, 130, 160, 150, 120, 185, 205], [5, 6]);

  // ---- Refund Timing -------------------------------------------------------
  var bursts = {}, order = [];
  for (var k = 0; k < affected.length; k++) {
    var ar = affected[k];
    var key = ar.store_code + '|' + _rrsCentral(ar.ebay_refund_date);
    if (!bursts[key]) { bursts[key] = { n: 0, amt: 0 }; order.push(key); }
    bursts[key].n++; bursts[key].amt += _rrsMoney(ar.ebay_refund_total);
  }
  order.sort(function (a, b) { return a.split('|')[1] < b.split('|')[1] ? -1 : 1; });
  var timRows = order.map(function (key) {
    var p = key.split('|');
    return [p[0], p[1], p[1].slice(-2), bursts[key].n, Math.round(bursts[key].amt * 100) / 100];
  });
  _rrsWrite(ss, 'Refund Timing', ['Store', 'eBay Refund Batch (Central)', 'Minute Past The Hour',
    'Refunds In This Batch', 'Amount'], timRows, [60, 200, 150, 160, 110], [5]);

  Logger.log('Created: ' + ss.getUrl());
  Logger.log(affected.length + ' refunded on eBay, $' + total.toFixed(2)
    + ' | ' + clear.length + ' still PAID, $' + exposure.toFixed(2)
    + ' | ' + newRows.length + ' newly confirmed');
  Logger.log('NOT shared with anyone yet — share it from the file itself.');
  return ss.getUrl();
}

// Writes one tab: header + rows, frozen bold header, money columns formatted.
function _rrsWrite(ss, name, header, rows, widths, moneyCols) {
  var sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#efefef');
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  sh.setFrozenRows(1);
  for (var i = 0; i < widths.length; i++) sh.setColumnWidth(i + 1, widths[i]);
  if (moneyCols && rows.length) {
    for (var m = 0; m < moneyCols.length; m++) {
      sh.getRange(2, moneyCols[m], rows.length, 1).setNumberFormat('$#,##0.00');
    }
  }
}
