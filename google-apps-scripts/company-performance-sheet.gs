// ============================================================================
// company-performance-sheet.gs — "how did we ACTUALLY do this month", as a real
// Google Sheet in your Drive, timestamped, fit to hand to the CEO and CFO.
//
//   Run -> buildCompanyPerformance    (creates the sheet, logs its URL)
//   Run -> cpsStatusCensus            (read-only; only needed to move recovery
//                                      onto a per-order read — see below)
//
// ONE TAB, ON PURPOSE (Ethan, 2026-09-01). This started as eight — Bridge, By
// Store, Daily, Recovery, Refunded Orders, Reconciliation and a Read Me — and
// every one of them was either evidence Ethan already holds in the duplicates
// workbook or a check that belonged in my working rather than in his document.
// One page a CFO reads in a sitting beats a workbook nobody opens past the first
// tab. Expanding it again is easy: the figures are all computed below whether or
// not they get printed.
//
// ============================================================================
// THE THREE STEPS, WHICH ARE ETHAN'S AND NOT MINE
//
//   1. What we sold, as if it had been a normal month. Straight off the Sales
//      Summary sheet — sales AND cost, unadjusted, not recomputed.
//   2. Less the cash eBay actually handed back to buyers. The COST of those
//      goods STAYS IN: the buyer kept the item, so we lost the product as well
//      as the money, and crediting the cost back would pretend it came back to
//      the shelf.
//   3. Plus what customers have paid back since, through draft orders and
//      replacement eBay listings.
//
// ⚠️ THE BASELINE IS THE SHEET, AND THAT WAS A CORRECTION. The first version of
// this script rebuilt step 1 from Shopify via sales-true-daily and got
// $747,894.97. That is too high by $54,204.89: when the Marketplace Connect
// fault duplicated an order, BOTH Shopify copies ended up carrying a refund —
// ours on the phantom copy and the mirror-back on the real one — and
// sales-true-daily adds back both, so 294 eBay sales were counted twice.
// Subtracting the refunded cash from that inflated base produced a gross profit
// that landed almost exactly on the sheet's, because the two errors were nearly
// the same size and cancelled each other out.
//
// Ethan caught it from the answer alone: "my sheet took all of our daily sales
// assuming we did not refund any of those sales, so my 364 should be what we
// would've done." Correct. The sheet already IS that figure. The double count is
// still measured below and printed as a cross-check, so it cannot recur quietly.
//
// Re-running makes a NEW file every time and never edits an old one, so a copy
// already sent upstairs cannot change underneath the people reading it.
//
// Prefixed CPS_/_cps: one Apps Script project is one global scope.
// ============================================================================

var CPS_TZ   = 'America/Chicago';
var CPS_BASE = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1';

// ⚠️ ONE-TIME SETUP. Project Settings -> Script Properties -> Add script property
//     name: SYNC_SECRET    value: (the shared sync key)
//
// Every other .gs in this project carries that key as a plain string, and this
// repository is PUBLIC on github.com/SPEEKS-Technology/speeksnet. The key is the
// only gate in front of refund-export and sales-true-daily, so anyone who reads
// the repo can pull every refunded order with buyer names, and the company's
// whole revenue, with one curl. That is already true and this file cannot undo
// it — but it is a new file that nothing depends on, which makes it the cheapest
// place to stop making it worse.
function _cpsSecret() {
  var v = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  if (!v) {
    throw new Error('SYNC_SECRET is not set. Project Settings -> Script Properties '
      + '-> Add script property, name SYNC_SECRET, value the shared sync key.');
  }
  return v;
}

var CPS_MONTH      = '2026-08';
var CPS_MONTH_NAME = 'August 2026';

// The Sales Summary. Read only — never written to.
var CPS_SALES_BOOK  = '1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8';
var CPS_SALES_TAB   = 'Sales Aug 26';
var CPS_COL_BASES   = { OVL: 0, LEE: 11, WSP: 22, MPL: 33, BAL: 44 };
var CPS_COL_SALES   = 1;    // base+1
var CPS_COL_COST    = 4;    // base+4
var CPS_HEADER_ROWS = 3;

// ⚠️ WHAT WE HAVE ACTUALLY GOT BACK, AS A COMPANY TOTAL. The managers keep a
// running "returned $ entered so far" column in the duplicates workbook and it
// stood at $13,537.74 on 2026-09-01 (Ethan). Recovery is real money, and leaving
// it at zero because the plumbing is unfinished understates the month by that
// much — a zero meaning "not measured yet" reads exactly like a zero meaning
// "nobody paid", and only one of those is true.
//
// A COMPANY TOTAL, SHOWN AS ONE. A hand-entered figure has no store split, and
// apportioning it across five stores by refund share would look tidier and would
// be invented.
//
// To replace it with a per-order read: fill in CPS_REFUND_BOOK_ID, run
// cpsStatusCensus to confirm the column mapping, then set this to null.
var CPS_RECOVERED_OVERRIDE = 13537.74;
var CPS_RECOVERED_AS_OF    = '2026-09-01';

// The duplicates workbook, converted to a Google Sheet — SpreadsheetApp cannot
// open the uploaded .xlsx, so in that file: File -> Save as Google Sheets. Only
// needed to compute recovery per order instead of using the total above.
var CPS_REFUND_BOOK_ID = '';

// Statuses meaning the money came back: PAID for a settled draft order, and
// PAID LISTING <n> for a replacement eBay listing the customer bought to pay
// through. ⚠️ PREFIX MATCH — "PAID LISTING 3" and "PAID LISTING 7" are different
// strings, and an exact list would silently skip every one of them.
var CPS_PAID_PREFIXES = ['paid', 'repaid'];
var CPS_PAID_STATUSES = ['replied - paying', 'paying'];

var CPS_STORES = [
  { code: 'OVL', label: 'Overland Park' },
  { code: 'LEE', label: "Lee's Summit" },
  { code: 'WSP', label: 'Westport' },
  { code: 'MPL', label: 'Maplewood' },
  { code: 'BAL', label: 'Ballwin' }
];

var CPS_INK   = '#1f2937';
var CPS_HEAD  = '#0f766e';
var CPS_SOFT  = '#f0fdfa';
var CPS_MONEY = '$#,##0.00';
var CPS_PCT   = '0.0%';

// ---------------------------------------------------------------- helpers ----
function _cpsMoney(v) { return Math.round((parseFloat(v) || 0) * 100) / 100; }

function _cpsSum(a) {
  var t = 0;
  for (var i = 0; i < a.length; i++) t += (parseFloat(a[i]) || 0);
  return Math.round(t * 100) / 100;
}

function _cpsNorm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

// "$747,908.96". Written out by hand because Apps Script has no locale grouping
// on a plain number, and prose is the one place a figure cannot carry a cell
// format with it.
function _cpsDollars(v) {
  var n = _cpsMoney(v), neg = n < 0;
  var parts = Math.abs(n).toFixed(2).split('.');
  var whole = parts[0], grouped = '';
  while (whole.length > 3) {
    grouped = ',' + whole.slice(-3) + grouped;
    whole = whole.slice(0, -3);
  }
  return (neg ? '-$' : '$') + whole + grouped + '.' + parts[1];
}

function _cpsFetch(path) {
  var url = CPS_BASE + '/' + path + (path.indexOf('?') >= 0 ? '&' : '?')
          + 'secret=' + encodeURIComponent(_cpsSecret());
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error(path + ' returned HTTP ' + res.getResponseCode() + ': '
      + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText());
}

function _cpsIsPaid(status) {
  var n = _cpsNorm(status);
  if (!n) return false;
  if (CPS_PAID_STATUSES.indexOf(n) >= 0) return true;
  for (var i = 0; i < CPS_PAID_PREFIXES.length; i++) {
    var p = CPS_PAID_PREFIXES[i];
    if (n === p || n.indexOf(p + ' ') === 0) return true;
  }
  return false;
}

function _cpsColLetter(i) {
  var n = i + 1, out = '';
  while (n > 0) {
    var r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = (n - r - 1) / 26;
  }
  return out;
}

function _cpsLastDay() {
  var y = Number(CPS_MONTH.slice(0, 4)), m = Number(CPS_MONTH.slice(5, 7));
  return CPS_MONTH + '-' + new Date(y, m, 0).getDate();
}

// ------------------------------------------------------- the Sales Summary ----
// ⚠️ THIS IS THE BASELINE, SO IT IS READ AND NOT RECOMPUTED. Sales and cost for
// every store, every day of the month, exactly as the sheet holds them.
function _cpsSheetMonth() {
  var out = { ok: false, why: '', sales: 0, cost: 0, cells: 0 };
  var values;
  try {
    var tab = SpreadsheetApp.openById(CPS_SALES_BOOK).getSheetByName(CPS_SALES_TAB);
    if (!tab) throw new Error('no tab named "' + CPS_SALES_TAB + '"');
    values = tab.getRange(1, 1, tab.getLastRow(), tab.getLastColumn()).getValues();
  } catch (e) {
    out.why = String(e).slice(0, 200);
    return out;
  }
  var dim = new Date(Number(CPS_MONTH.slice(0, 4)), Number(CPS_MONTH.slice(5, 7)), 0).getDate();
  for (var d = 1; d <= dim; d++) {
    for (var i = 0; i < CPS_STORES.length; i++) {
      var base = CPS_COL_BASES[CPS_STORES[i].code];
      var row = _cpsSheetDayRow(values, base, d);
      if (row < 0) continue;
      out.sales = _cpsMoney(out.sales + _cpsMoney(values[row][base + CPS_COL_SALES]));
      out.cost  = _cpsMoney(out.cost  + _cpsMoney(values[row][base + CPS_COL_COST]));
      out.cells++;
    }
  }
  out.ok = out.cells > 0;
  if (!out.ok) out.why = 'opened the tab but found no day rows';
  return out;
}

function _cpsSheetDayRow(values, base, day) {
  for (var r = CPS_HEADER_ROWS; r < values.length; r++) {
    var first = String(values[r][0]).trim().toUpperCase();
    if (first === 'TTL' || first.indexOf('TRACKING') === 0) break;   // past the day rows
    if (parseInt(values[r][base], 10) === day) return r;
  }
  return -1;
}

// --------------------------------------------------------- the double count ----
// ⚠️ HOW MUCH sales-true-daily COUNTS TWICE. For one eBay sale the fault left two
// Shopify orders and a refund landed on each: ours on the phantom copy ("our
// duplicate refund") and the mirror-back on the real one ("mirror-back"). Both
// get added back, so the sale is counted twice. Exactly one add-back per eBay id
// is right, so the smaller leg is the error.
//
// Measured, never assumed, because this is the thing that made the first version
// of this document wrong, and it moves as orders settle.
function _cpsDoubleCount(daily) {
  var out = { orders: 0, sales: 0 };
  var byEid = {};
  Object.keys(daily.per_store || {}).forEach(function (st) {
    (daily.per_store[st].detail || []).forEach(function (d) {
      if (!d.ebay_order_id) return;
      if (d.kind !== 'mirror-back' && d.kind !== 'our duplicate refund') return;
      var e = byEid[d.ebay_order_id] || (byEid[d.ebay_order_id] = { mirror: 0, dupe: 0 });
      if (d.kind === 'mirror-back') e.mirror = _cpsMoney(e.mirror + d.amount);
      else e.dupe = _cpsMoney(e.dupe + d.amount);
    });
  });
  Object.keys(byEid).forEach(function (e) {
    var x = byEid[e];
    if (x.mirror > 0 && x.dupe > 0) {
      out.orders++;
      out.sales = _cpsMoney(out.sales + Math.min(x.mirror, x.dupe));
    }
  });
  return out;
}

// ------------------------------------------------ the duplicates workbook ----
// Only used when CPS_RECOVERED_OVERRIDE is null. Columns are found by NAME, not
// by position: five managers have been working in that workbook for a week and
// the columns have already moved once.
function _cpsHeaderMap(values) {
  for (var r = 0; r < Math.min(values.length, 12); r++) {
    var row = values[r], map = {};
    for (var c = 0; c < row.length; c++) {
      var h = _cpsNorm(row[c]);
      if (!h) continue;
      if (h === 'status') map.status = c;
      else if (h === 'ebay order' || h === 'ebay order id') map.order = c;
      else if (h === '$ refunded' || h === 'amount' || h === 'refunded') map.amount = c;
      // Money actually received beats money we asked for: a customer can settle
      // a draft order for a different figure, or pay only part of it.
      else if (h.indexOf('return') >= 0 || h.indexOf('recovered') >= 0
               || h.indexOf('received') >= 0 || h.indexOf('paid back') >= 0) map.returned = c;
    }
    if (map.status != null && map.order != null) { map.row = r; return map; }
  }
  return null;
}

function _cpsReadStatuses() {
  var out = { byOrder: {}, tabs: [], rows: 0, blank: 0, ok: false, why: '',
              map: null, sheetTotal: 0, returnedTotal: 0 };
  if (!CPS_REFUND_BOOK_ID) { out.why = 'CPS_REFUND_BOOK_ID is blank'; return out; }
  var book;
  try {
    book = SpreadsheetApp.openById(CPS_REFUND_BOOK_ID);
  } catch (e) {
    out.why = 'could not open CPS_REFUND_BOOK_ID (' + String(e).slice(0, 120) + '). If the file '
            + 'is an uploaded .xlsx, use File -> Save as Google Sheets and use the new id.';
    return out;
  }
  var sheets = book.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    if (sh.getLastRow() < 2 || sh.getLastColumn() < 2) continue;
    var values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
    var map = _cpsHeaderMap(values);
    if (!map) continue;
    out.tabs.push(sh.getName());
    if (!out.map) {
      out.map = {};
      ['status', 'order', 'amount', 'returned'].forEach(function (k) {
        out.map[k] = map[k] == null ? null : _cpsColLetter(map[k]);
      });
    }
    for (var r = map.row + 1; r < values.length; r++) {
      var id = String(values[r][map.order] || '').trim();
      if (!id) continue;
      out.rows++;
      var stat = String(values[r][map.status] || '').trim();
      if (!stat) out.blank++;
      var amt = map.amount != null ? _cpsMoney(values[r][map.amount]) : 0;
      var ret = map.returned != null ? _cpsMoney(values[r][map.returned]) : null;
      out.byOrder[id] = { status: stat, tab: sh.getName(), amount: amt, returned: ret };
      out.sheetTotal = _cpsMoney(out.sheetTotal + amt);
      out.returnedTotal = _cpsMoney(out.returnedTotal + (ret || 0));
    }
  }
  out.ok = out.rows > 0;
  if (!out.ok && !out.why) out.why = 'no tab had both a Status and an eBay Order column';
  return out;
}

function _cpsPad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

// ============================================================================
// cpsStatusCensus — read-only. Only needed to move recovery off the hand-entered
// total onto a per-order read. Prints the column mapping it found, the
// workbook's own totals, and the live eBay measurement beside them.
//
// ⚠️ THREE DIFFERENT TOTALS ARE IN PLAY AND NONE OF THEM IS WRONG. On
// 2026-09-01 the live probe said $54,736.63 of cash taken back and $60,402.77 of
// order value, while Ethan's workbook totalled $57,639.86 — matching neither,
// because eBay credits the final-value fee back on a refund and the workbook is
// a 2026-08-26 snapshot that has since been restructured by hand. Printing all
// of them together is the only way to see which is which.
// ============================================================================
function cpsStatusCensus() {
  var st = _cpsReadStatuses();
  Logger.log('=== STATUS CENSUS — %s ===', CPS_MONTH_NAME);
  if (!st.ok) { Logger.log('!! %s', st.why); return; }
  Logger.log('tabs read: %s', st.tabs.join(', '));
  Logger.log('rows with an eBay order: %s   (blank status: %s)', st.rows, st.blank);
  Logger.log('columns -> status %s | eBay order %s | amount %s | returned %s',
    st.map.status || '(none)', st.map.order || '(none)',
    st.map.amount || '(none)', st.map.returned || '(none)');
  if (!st.map.returned) {
    Logger.log('!! no "returned so far" column found — tell me its exact header text.');
  }

  var ref = _cpsFetch('refund-export');
  var amt = {}, live = 0, liveOrder = 0, matched = 0;
  for (var i = 0; i < ref.rows.length; i++) {
    var rr = ref.rows[i];
    if (_cpsMoney(rr.ebay_refund_total) <= 0) continue;
    amt[rr.ebay_order_id] = _cpsMoney(rr.ebay_refund_total);
    live = _cpsMoney(live + _cpsMoney(rr.ebay_refund_total));
    liveOrder = _cpsMoney(liveOrder + _cpsMoney(rr.ebay_order_total));
    if (st.byOrder[rr.ebay_order_id]) matched++;
  }

  var tally = {};
  Object.keys(st.byOrder).forEach(function (id) {
    var key = st.byOrder[id].status || '(blank)';
    if (!tally[key]) tally[key] = { n: 0, ref: 0, got: 0 };
    tally[key].n++;
    if (amt[id] != null) tally[key].ref = _cpsMoney(tally[key].ref + amt[id]);
    tally[key].got = _cpsMoney(tally[key].got + (st.byOrder[id].returned || 0));
  });
  var keys = Object.keys(tally).sort(function (a, b) { return tally[b].ref - tally[a].ref; });
  Logger.log('');
  Logger.log('%s%s%s%s%s', _cpsPad('STATUS AS TYPED', 26), _cpsPad('ROWS', 7),
             _cpsPad('$ REFUNDED', 15), _cpsPad('$ RETURNED', 15), 'COUNTED AS');
  keys.forEach(function (k) {
    var t = tally[k];
    Logger.log('%s%s%s%s%s', _cpsPad(k, 26), _cpsPad(String(t.n), 7),
      _cpsPad(_cpsDollars(t.ref), 15), _cpsPad(_cpsDollars(t.got), 15),
      _cpsIsPaid(k) ? 'PAID -> added back' : 'not recovered');
  });

  Logger.log('');
  Logger.log('=== YOUR WORKBOOK vs THE LIVE eBAY MEASUREMENT ===');
  Logger.log('  cash eBay actually took back from us   %s  <- what the statement subtracts',
    _cpsDollars(live));
  Logger.log('  what the buyers were charged           %s  (eBay credits the fee back to us)',
    _cpsDollars(liveOrder));
  Logger.log('  your amount column                     %s', _cpsDollars(st.sheetTotal));
  Logger.log('  your returned-so-far column            %s', _cpsDollars(st.returnedTotal));
  Logger.log('  your rows matched to a live refund     %s of %s',
    matched, Object.keys(st.byOrder).length);
  Logger.log('');
  Logger.log('Send me this log. Nothing was written.');
}

// ============================================================================
// buildCompanyPerformance
// ============================================================================
function buildCompanyPerformance() {
  var t0 = new Date();

  // detail=1 gives the per-refund classification, the only way to see the double
  // count described at the top of this file.
  var daily = _cpsFetch('sales-true-daily?detail=1&from=' + CPS_MONTH + '-01&to=' + _cpsLastDay());
  var ref   = _cpsFetch('refund-export');
  if (ref.non_200) {
    throw new Error(ref.non_200 + ' eBay orders did not answer — re-probe before building a '
      + 'document for corporate. A partial measurement understates the loss.');
  }

  var sheet = _cpsSheetMonth();
  var dbl   = _cpsDoubleCount(daily);
  var shopSales = _cpsSum(daily.rows.map(function (r) { return _cpsMoney(r.true_sales); }));

  // ---- step 1: what we sold, as if nothing had happened --------------------
  var sold, cost, fromSheet;
  if (sheet.ok) {
    sold = sheet.sales; cost = sheet.cost; fromSheet = true;
  } else {
    // Loudly, never silently: a document that swaps its own foundation without
    // saying so is worse than one that fails outright.
    sold = _cpsMoney(shopSales - dbl.sales);
    cost = _cpsSum(daily.rows.map(function (r) { return _cpsMoney(r.true_cost); }));
    fromSheet = false;
  }

  // ---- step 2: the cash that actually left --------------------------------
  var affected = ref.rows.filter(function (r) { return _cpsMoney(r.ebay_refund_total) > 0; });
  var refunded = _cpsSum(affected.map(function (r) { return _cpsMoney(r.ebay_refund_total); }));
  var charged  = _cpsSum(affected.map(function (r) { return _cpsMoney(r.ebay_order_total); }));
  var shipped  = affected.filter(function (r) { return r.ebay_fulfillment_status === 'FULFILLED'; });
  var shippedAmt = _cpsSum(shipped.map(function (r) { return _cpsMoney(r.ebay_refund_total); }));

  // ---- step 3: what has come back -----------------------------------------
  var recovered, recSource;
  if (CPS_RECOVERED_OVERRIDE != null) {
    recovered = _cpsMoney(CPS_RECOVERED_OVERRIDE);
    recSource = 'Your running "returned $ so far" total from the duplicates workbook, entered here '
              + 'by hand as of ' + CPS_RECOVERED_AS_OF + ', and shown as a company total. Splitting '
              + 'it across five stores by refund share would look tidier and would be made up.';
  } else {
    var st = _cpsReadStatuses();
    var got = 0, n = 0;
    if (st.ok) {
      affected.forEach(function (r) {
        var hit = st.byOrder[r.ebay_order_id];
        if (!hit || !_cpsIsPaid(hit.status)) return;
        n++;
        got = _cpsMoney(got + ((hit.returned != null && hit.returned > 0)
          ? hit.returned : _cpsMoney(r.ebay_refund_total)));
      });
      recSource = n + ' orders marked paid in the duplicates workbook, read order by order. Where '
                + 'a "returned so far" figure is entered that is used; where it is not, the order '
                + 'is assumed to have been repaid in full.';
    } else {
      recSource = '⚠️ NOT MEASURED — ' + st.why + '. Treat the line above as zero, not as proof '
                + 'that nobody has paid.';
    }
    recovered = _cpsMoney(got);
  }

  var afterRefunds = _cpsMoney(sold - refunded);
  var kept     = _cpsMoney(afterRefunds + recovered);
  var gpHad    = _cpsMoney(sold - cost);
  var gpBefore = _cpsMoney(afterRefunds - cost);
  var gp       = _cpsMoney(kept - cost);
  var hit      = _cpsMoney(gpHad - gp);

  // ---- the page -----------------------------------------------------------
  var title = 'PayMore — ' + CPS_MONTH_NAME + ' Company Performance (measured '
            + Utilities.formatDate(t0, CPS_TZ, 'yyyy-MM-dd HH:mm') + ')';
  var ss = SpreadsheetApp.create(title);
  var $ = _cpsDollars;

  var L = [], push = function (a, b) { L.push([a, b === undefined ? '' : b]); };

  push('PayMore — ' + CPS_MONTH_NAME);
  push('What the company actually did. Measured '
    + Utilities.formatDate(t0, CPS_TZ, 'MMMM d, yyyy') + ' at '
    + Utilities.formatDate(t0, CPS_TZ, 'h:mm a') + ' US Central.');
  push('');

  push('IN ONE SENTENCE');
  push('We sold ' + $(sold) + ' in ' + CPS_MONTH_NAME + '. A software fault refunded ' + $(refunded)
    + ' to ' + affected.length + ' buyers who never asked for it, and ' + shipped.length
    + ' of them had already received their goods — so we lost the money AND the product. '
    + (recovered > 0 ? 'Customers have since paid back ' + $(recovered) + '. ' : '')
    + 'That turned ' + $(gpHad) + ' of gross profit into ' + $(gp) + '.');
  push('');

  push('THE NUMBERS');
  push('What we sold', sold);
  push('Refunded to buyers by the fault', -refunded);
  push('WHERE WE STOOD AFTER THE REFUNDS', afterRefunds);
  push('Got back from buyers so far', recovered);
  push('WHAT WE KEPT', kept);
  push('Cost of the goods we sold', -cost);
  push('GROSS PROFIT', gp);
  push('');

  push('THE SAME THING IN GROSS PROFIT');
  push('What we would have made', gpHad);
  push('Before anything was recovered', gpBefore);
  push('With what has come back so far', gp);
  push('Still down on the month', hit);
  push('Still down, as a share of what we would have made', gpHad ? hit / gpHad : 0);
  push('Recovered so far, as a share of what was refunded', refunded ? recovered / refunded : 0);
  push('');

  push('WHAT EACH LINE IS');
  push('What we sold', fromSheet
    ? 'Taken straight off the Sales Summary (' + CPS_SALES_TAB + '), sales and cost both. That '
      + 'sheet records what we sold as though nothing had been refunded, which is exactly the right '
      + 'place to start. It is not recomputed and not adjusted here.'
    : '⚠️ THE SALES SUMMARY COULD NOT BE READ, so this is a Shopify recomputation instead. Check it '
      + 'before circulating. ' + sheet.why);
  push('Refunded to buyers', 'Measured order by order against eBay itself — ' + affected.length
    + ' orders, of which ' + shipped.length + ' (' + $(shippedAmt) + ') had already been delivered, '
    + 'so the buyer kept the goods and the money. This figure is what eBay took back from US. The '
    + 'buyers were charged ' + $(charged) + '; the difference is the final-value fee, which eBay '
    + 'credits back to us when a refund goes through.');
  push('Cost of the goods', 'STAYS IN, deliberately. The buyer kept the item, so we lost the '
    + 'product as well as the money, and crediting the cost back would flatter the month by '
    + 'pretending the unit returned to the shelf. This is the most conservative choice in the '
    + 'document and it is made on purpose.');
  push('Got back from buyers', recSource);
  push('');

  push('A CROSS-CHECK, AND THE TRAP IN IT');
  push('Shopify, recomputed independently, puts the month at', _cpsMoney(shopSales - dbl.sales));
  push('Before correction it said', shopSales);
  push('The difference is a genuine double count', dbl.sales);
  push('Why that correction exists', 'When the fault duplicated an order, BOTH Shopify copies ended '
    + 'up with a refund on them — ours on the phantom copy, the mirror-back on the real one — and '
    + 'the recomputation adds back both, so ' + dbl.orders + ' eBay sales get counted twice. An '
    + 'earlier version of this document used that inflated figure as its starting point; '
    + 'subtracting the refunded cash from it produced a gross profit that landed almost exactly on '
    + 'the Sales Summary\'s, because the two errors were nearly the same size and cancelled. The '
    + 'sheet is the baseline now precisely so that cannot happen again.');
  push('');

  push('WHAT IS NOT IN THIS');
  push('Operating costs', 'Rent, payroll, marketing, eBay and card fees are not here. This is '
    + 'revenue and gross profit — the top of a P&L, not a P&L.');
  push('Orders still showing PAID on eBay', 'Some orders carry a Shopify refund that never reached '
    + 'eBay. They are real sales that were never refunded to anybody, so they sit in the month '
    + 'exactly as the Sales Summary already has them, and nothing is subtracted for them.');
  push('');
  push('Every figure here is re-derivable, and both measurements stamp their own time, so any '
    + 'number in this document can be traced to the minute it was taken. Re-running the builder '
    + 'creates a NEW file and never edits this one.');

  var sh = ss.getSheets()[0];
  sh.setName('Summary');
  sh.getRange(1, 1, L.length, 2).setValues(L);
  sh.getRange(1, 1).setFontSize(18).setFontWeight('bold').setFontColor(CPS_HEAD);
  sh.getRange(2, 1).setFontColor('#6b7280').setFontStyle('italic');
  sh.setColumnWidth(1, 430);
  sh.setColumnWidth(2, 620);
  sh.getRange(1, 1, L.length, 2).setVerticalAlignment('top').setWrap(true).setFontColor(CPS_INK);
  sh.getRange(1, 1).setFontColor(CPS_HEAD);

  // ⚠️ FORMAT BY CONTENT, NOT BY ROW NUMBER. Hardcoded row indices broke this
  // document twice: adding or removing a single line silently moved every
  // heading and bold group below it onto the wrong rows.
  for (var r = 2; r <= L.length; r++) {
    var label = String(L[r - 1][0] || '');
    var val = L[r - 1][1];
    var letters = label.replace(/[^A-Za-z]/g, '');
    var shouty = letters.length > 4 && label === label.toUpperCase();
    if (typeof val === 'number') {
      var isPct = label.indexOf('share of') >= 0;
      sh.getRange(r, 2).setNumberFormat(isPct ? CPS_PCT : CPS_MONEY)
        .setHorizontalAlignment('right');
      // The three lines a reader should find without having to read.
      if (shouty) {
        sh.getRange(r, 1, 1, 2).setFontWeight('bold').setFontSize(12).setBackground(CPS_SOFT);
      }
    } else if (val === '' && shouty) {
      sh.getRange(r, 1, 1, 2).setFontWeight('bold').setFontColor(CPS_HEAD)
        .setBackground(CPS_SOFT).setWrap(false);
    } else if (val !== '' && label.length < 46) {
      sh.getRange(r, 1).setFontWeight('bold');
    }
  }
  sh.setFrozenRows(2);

  Logger.log('=== BUILT ===');
  Logger.log('%s', title);
  Logger.log('%s', ss.getUrl());
  Logger.log('');
  Logger.log('sold %s | refunded %s | recovered %s | kept %s | gross profit %s',
    $(sold), $(refunded), $(recovered), $(kept), $(gp));
  if (!fromSheet) Logger.log('!! baseline is a RECOMPUTATION, not the sheet: %s', sheet.why);
  Logger.log('The file is UNSHARED. Share it deliberately.');
}
