// ============================================================================
// company-performance-sheet.gs — "how did we ACTUALLY do this month", as a real
// Google Sheet in your Drive, timestamped, fit to hand to the CEO and CFO.
//
//   Run -> cpsStatusCensus            (read-only; do this FIRST, see below)
//   Run -> buildCompanyPerformance    (creates the workbook, logs its URL)
//
// WHY THIS IS A DIFFERENT NUMBER FROM THE SALES SUMMARY SHEET, AND WHY BOTH ARE
// RIGHT. The Sales Summary answers "what did we sell?", so it ADDS BACK every
// order that was refunded by the Marketplace Connect fault — those were real
// sales to real customers who kept real goods, and a bookkeeping accident is not
// a reason to un-sell them. This workbook answers the harder question the CFO
// will actually ask: "what did we KEEP?" It starts from the same real sales and
// then takes out the cash that genuinely left the building.
//
// THE FOUR ACCOUNTING CHOICES, ALL DELIBERATE, ALL ETHAN'S CALL (2026-09-01):
//   1. Sales are the REAL sales — refunds caused by the fault added back.
//   2. The cash we refunded to eBay buyers comes OFF, in full. It is gone.
//   3. The COST of those goods STAYS IN. The buyer kept the item, so we lost the
//      product as well as the money; reversing the COGS would flatter the month
//      by pretending the unit came back to the shelf.
//   4. Only buyers whose status says they PAID US BACK are added back, because
//      only that money actually returned.
//
// ⚠️ RUN cpsStatusCensus FIRST. Choice 4 depends on the exact words in the
// Status column of the outreach workbook, and those are typed by hand by five
// managers. The census lists every distinct value it finds with the money
// sitting against it, so CPS_PAID_STATUSES can be set to the real vocabulary
// instead of a guess. A guess here misstates a document going to the CFO.
//
// ⚠️ THE OUTREACH WORKBOOK MUST BE A GOOGLE SHEET, NOT AN UPLOADED .xlsx.
// The share link ending in "rtpof=true" is an Excel file sitting in Drive, and
// SpreadsheetApp cannot open one. In that file: File -> Save as Google Sheets,
// then put the NEW file's id in CPS_REFUND_BOOK_ID. If the id is left blank the
// workbook still builds — recovery simply shows as "not yet applied" rather
// than as zero, so nobody reads a blank as "nobody paid".
//
// Re-running makes a NEW file every time and never edits an old one, so a copy
// already sent upstairs cannot change underneath the people reading it.
//
// Prefixed CPS_/_cps: one Apps Script project is one global scope.
// ============================================================================

var CPS_TZ     = 'America/Chicago';
var CPS_BASE   = 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1';

// ⚠️ ONE-TIME SETUP, AND WHY IT IS NOT JUST TYPED IN HERE LIKE THE OTHER SCRIPTS.
// Project Settings -> Script Properties -> Add script property
//     name: SYNC_SECRET    value: (the shared sync key)
//
// Every other .gs in this project carries that key as a plain string, and this
// repository is PUBLIC on github.com/SPEEKS-Technology/speeksnet. The key is the
// only gate in front of refund-export, outreach-list and sales-true-daily, so
// anyone who reads the repo can pull all 415 refunded orders with buyer names
// and the company's whole revenue with one curl. That is already true and this
// file cannot undo it — but it is a brand-new file that nothing depends on yet,
// which makes it the cheapest place to stop making it worse.
//
// Fixing it properly means rotating the key and moving all 67 files to secrets;
// that breaks every deployed function and cron until they are redeployed, so it
// is a decision to take deliberately, not a side effect of this report.
function _cpsSecret() {
  var v = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  if (!v) {
    throw new Error('SYNC_SECRET is not set. Project Settings -> Script Properties '
      + '-> Add script property, name SYNC_SECRET, value the shared sync key. '
      + 'See the note at the top of company-performance-sheet.gs.');
  }
  return v;
}

// The month this workbook reports on, and the month it reads from the sheet.
var CPS_MONTH      = '2026-08';
var CPS_MONTH_NAME = 'August 2026';

// The Sales Summary workbook, read ONLY to prove this recomputation agrees with
// the sheet the business has been running on. Never written to.
var CPS_SALES_BOOK  = '1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8';
var CPS_SALES_TAB   = 'Sales Aug 26';
var CPS_COL_BASES   = { OVL: 0, LEE: 11, WSP: 22, MPL: 33, BAL: 44 };
var CPS_COL_SALES   = 1;    // base+1
var CPS_COL_COST    = 4;    // base+4
var CPS_HEADER_ROWS = 3;

// ⚠️ FILL THIS IN — the outreach workbook, converted to a Google Sheet.
var CPS_REFUND_BOOK_ID = '';

// Statuses that mean "the money came back". Matched case-insensitively after
// trimming. Set from what cpsStatusCensus actually reports; every value found
// and NOT counted is printed on the Recovery tab with its dollar amount, so a
// missing word here is visible on the face of the document rather than silent.
var CPS_PAID_STATUSES = ['paid', 'repaid', 'paid back', 'replied - paying', 'paying'];

// Statuses that mean the goods came back to us instead of the money. Reported
// as a SEPARATE, clearly-marked line and deliberately NOT in the headline: the
// cash is still gone, but the unit is back on the shelf, so its cost is not
// truly lost. Ethan asked for cost to stay in; this line lets the CFO see the
// size of that choice without it being made for them.
var CPS_RETURNED_STATUSES = ['returned', 'replied - returning', 'returning', 'item returned'];

// ⚠️ THE DOUBLE COUNT, AND WHY IT IS SETTLED BY EVIDENCE RATHER THAN BY A NOTE.
// A buyer can "pay us back" two ways. If they sent money outside Shopify, that
// cash is nowhere in the sales figure and adding it back is right. But if they
// paid a draft-order invoice or simply bought the item again, that is a NEW
// Shopify order which is ALREADY inside true_sales — adding it to recovery as
// well counts the same money twice, in a document going to the CFO.
//
// resale-check settles it per order: it looks for a later sale of the same SKU
// at the same store after the refund timestamp and returns RESOLD with the
// order number, date and amount. A sampled 25 orders per store came back about
// a quarter RESOLD, so this is not a hypothetical.
//
// Default is to EXCLUDE a resold order from the add-back and say so on the face
// of the document. Set false to include it anyway; the exclusion list is
// printed either way, so the choice is never invisible.
var CPS_EXCLUDE_RESOLD_FROM_RECOVERY = true;

// Which orders to spend resale-check calls on. 'paid' is the decision-relevant
// set and keeps the run inside Apps Script's execution limit; 'all' sweeps every
// refunded order (306 of them, chunked, and slow); 'off' skips it entirely and
// falls back to flagging the risk rather than resolving it.
var CPS_RESALE_CHECK = 'paid';
var CPS_RESALE_CHUNK = 25;

var CPS_STORES = [
  { code: 'OVL', label: 'Overland Park' },
  { code: 'LEE', label: "Lee's Summit" },
  { code: 'WSP', label: 'Westport' },
  { code: 'MPL', label: 'Maplewood' },
  { code: 'BAL', label: 'Ballwin' }
];

var CPS_INK   = '#1f2937';
var CPS_RULE  = '#d1d5db';
var CPS_HEAD  = '#0f766e';
var CPS_SOFT  = '#f0fdfa';
var CPS_WARN  = '#fef3c7';
var CPS_LOSS  = '#fee2e2';
var CPS_MONEY = '$#,##0.00';
var CPS_PCT   = '0.0%';

// ---------------------------------------------------------------- helpers ----
function _cpsMoney(v) { return Math.round((parseFloat(v) || 0) * 100) / 100; }
function _cpsSum(a) {
  var t = 0;
  for (var i = 0; i < a.length; i++) t += (parseFloat(a[i]) || 0);
  return Math.round(t * 100) / 100;
}
function _cpsStamp(iso) {
  if (!iso) return '(unknown)';
  return Utilities.formatDate(new Date(iso), CPS_TZ, 'yyyy-MM-dd HH:mm') + ' US Central';
}
function _cpsNorm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

// "$747,908.96". Written out by hand because Apps Script has no locale grouping
// on a plain number, and prose is the one place a number cannot carry a cell
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

// Find a header row and the columns we need, by NAME. The outreach workbook was
// built by outreach-sheet.gs with Status first and eBay Order seventh, but five
// managers have been working in it for a week — a column may have been inserted,
// so nothing here indexes off a hard-coded number.
function _cpsHeaderMap(values) {
  for (var r = 0; r < Math.min(values.length, 12); r++) {
    var row = values[r], map = {}, hits = 0;
    for (var c = 0; c < row.length; c++) {
      var h = _cpsNorm(row[c]);
      if (!h) continue;
      if (h === 'status') { map.status = c; hits++; }
      else if (h === 'ebay order' || h === 'ebay order id') { map.order = c; hits++; }
      else if (h === '$ refunded' || h === 'amount' || h === 'refunded') { map.amount = c; hits++; }
      else if (h === 'ebay username' || h === 'username') { map.user = c; }
      else if (h === 'buyer name' || h === 'full name') { map.name = c; }
      else if (h === 'item' || h === 'short item') { map.item = c; }
      else if (h.indexOf('note') === 0 || h === 'how repaid') { map.note = c; }
    }
    if (map.status != null && map.order != null) { map.row = r; map.hits = hits; return map; }
  }
  return null;
}

// Every Status typed against every eBay order, across all tabs of the outreach
// workbook. Returns { byOrder: {id: {...}}, tabs: [...], missing: [...] }.
function _cpsReadStatuses() {
  var out = { byOrder: {}, tabs: [], rows: 0, blank: 0, ok: false, why: '' };
  if (!CPS_REFUND_BOOK_ID) {
    out.why = 'CPS_REFUND_BOOK_ID is blank — recovery not applied. See the header of this script.';
    return out;
  }
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
    for (var r = map.row + 1; r < values.length; r++) {
      var id = String(values[r][map.order] || '').trim();
      if (!id) continue;
      var st = String(values[r][map.status] || '').trim();
      out.rows++;
      if (!st) out.blank++;
      out.byOrder[id] = {
        status: st,
        tab: sh.getName(),
        sheetAmount: map.amount != null ? _cpsMoney(values[r][map.amount]) : null,
        note: map.note != null ? String(values[r][map.note] || '').trim() : ''
      };
    }
  }
  out.ok = out.rows > 0;
  if (!out.ok && !out.why) out.why = 'opened the workbook but found no tab with both a Status and an eBay Order column';
  return out;
}

// Ask resale-check whether each of these orders' items went out of the door
// again after the refund. Chunked, because one call per order would be 306 round
// trips and one call for all of OVL's 173 would sit on a Shopify query long
// enough to time out. Returns { id: {verdict, order, at, amount} }.
//
// Failure here must never sink the build: a document that is complete but has
// "not checked" in one column beats no document at all. Any chunk that errors is
// recorded so the Recovery tab can say how many orders went unverified.
function _cpsResaleMap(rows) {
  var out = { byOrder: {}, checked: 0, failed: 0, notes: [] };
  if (CPS_RESALE_CHECK === 'off' || !rows.length) return out;
  var byStore = {};
  rows.forEach(function (r) {
    if (!byStore[r.store_code]) byStore[r.store_code] = [];
    byStore[r.store_code].push(r.ebay_order_id);
  });
  Object.keys(byStore).forEach(function (store) {
    var ids = byStore[store];
    for (var i = 0; i < ids.length; i += CPS_RESALE_CHUNK) {
      var chunk = ids.slice(i, i + CPS_RESALE_CHUNK);
      try {
        var res = _cpsFetch('resale-check?store=' + store + '&ebay=' + chunk.join(','));
        (res.results || []).forEach(function (x) {
          out.byOrder[x.ebay_order_id] = {
            verdict: x.verdict,
            order:  x.resale ? x.resale.order : '',
            at:     x.resale ? x.resale.at : '',
            amount: x.resale ? _cpsMoney(x.resale.amount) : 0
          };
          out.checked++;
        });
      } catch (e) {
        out.failed += chunk.length;
        out.notes.push(store + ' ' + chunk.length + ' orders: ' + String(e).slice(0, 90));
      }
    }
  });
  return out;
}

// ============================================================================
// STEP 1 — the census. Read-only. Tells us the real Status vocabulary.
// ============================================================================
function cpsStatusCensus() {
  var st = _cpsReadStatuses();
  Logger.log('=== STATUS CENSUS — %s ===', CPS_MONTH_NAME);
  if (!st.ok) { Logger.log('!! %s', st.why); return; }
  Logger.log('workbook tabs read: %s', st.tabs.join(', '));
  Logger.log('rows with an eBay order: %s   (blank status: %s)', st.rows, st.blank);

  var ref = _cpsFetch('refund-export');
  var amt = {};
  for (var i = 0; i < ref.rows.length; i++) {
    amt[ref.rows[i].ebay_order_id] = _cpsMoney(ref.rows[i].ebay_refund_total);
  }

  var tally = {};
  Object.keys(st.byOrder).forEach(function (id) {
    var key = st.byOrder[id].status || '(blank)';
    if (!tally[key]) tally[key] = { n: 0, $: 0, matched: 0 };
    tally[key].n++;
    if (amt[id] != null) { tally[key].matched++; tally[key].$ += amt[id]; }
  });

  var keys = Object.keys(tally).sort(function (a, b) { return tally[b].$ - tally[a].$; });
  Logger.log('');
  Logger.log('%s  %s  %s  %s', _cpsPad('STATUS AS TYPED', 26), _cpsPad('ROWS', 6),
             _cpsPad('$ REFUNDED', 14), 'COUNTED AS');
  for (var k = 0; k < keys.length; k++) {
    var t = tally[keys[k]], n = _cpsNorm(keys[k]);
    var role = CPS_PAID_STATUSES.indexOf(n) >= 0 ? 'PAID -> added back'
             : (CPS_RETURNED_STATUSES.indexOf(n) >= 0 ? 'returned (disclosed only)' : 'not recovered');
    Logger.log('%s  %s  %s  %s', _cpsPad(keys[k], 26), _cpsPad(String(t.n), 6),
               _cpsPad('$' + t.$.toFixed(2), 14), role);
  }
  Logger.log('');
  Logger.log('Set CPS_PAID_STATUSES to the values above that mean the money actually came');
  Logger.log('back, then Run -> buildCompanyPerformance. Nothing was written.');
}

function _cpsPad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

// ============================================================================
// STEP 2 — build the workbook
// ============================================================================
function buildCompanyPerformance() {
  var t0 = new Date();

  // ---- live measurements, both timestamped by the endpoint itself ----------
  var daily = _cpsFetch('sales-true-daily?from=' + CPS_MONTH + '-01&to=' + _cpsLastDay());
  var ref   = _cpsFetch('refund-export');
  var reach = _cpsFetch('outreach-list');
  if (ref.non_200) {
    throw new Error(ref.non_200 + ' eBay orders did not answer — re-probe before building a '
      + 'document for corporate. A partial measurement understates the loss.');
  }
  var st = _cpsReadStatuses();

  // ---- layer 1: what we sold ----------------------------------------------
  var byStore = {}, byDay = {};
  CPS_STORES.forEach(function (s) { byStore[s.code] = { sales: 0, cost: 0, reported: 0 }; });
  daily.rows.forEach(function (r) {
    var b = byStore[r.store];
    if (!b) return;
    b.sales += _cpsMoney(r.true_sales);
    b.cost  += _cpsMoney(r.true_cost);
    b.reported += _cpsMoney(r.reported_net_sales);
    if (!byDay[r.day]) byDay[r.day] = {};
    byDay[r.day][r.store] = { sales: _cpsMoney(r.true_sales), cost: _cpsMoney(r.true_cost) };
  });

  // ---- layer 2: what actually left ---------------------------------------
  var affected = ref.rows.filter(function (r) { return _cpsMoney(r.ebay_refund_total) > 0; });
  var stillPaid = ref.rows.filter(function (r) { return _cpsMoney(r.ebay_refund_total) === 0; });
  var refByStore = {}, shipByStore = {}, shipN = {};
  CPS_STORES.forEach(function (s) { refByStore[s.code] = 0; shipByStore[s.code] = 0; shipN[s.code] = 0; });
  affected.forEach(function (r) {
    if (refByStore[r.store_code] == null) return;
    refByStore[r.store_code] += _cpsMoney(r.ebay_refund_total);
    if (r.ebay_fulfillment_status === 'FULFILLED') {
      shipByStore[r.store_code] += _cpsMoney(r.ebay_refund_total);
      shipN[r.store_code]++;
    }
  });

  // ---- layer 3: recovery, from the hand-typed statuses --------------------
  var rec = { byStore: {}, rows: [], counted: 0, returnedCost: 0, returnedN: 0,
              notCounted: {}, excluded: [], excludedAmt: 0 };
  CPS_STORES.forEach(function (s) { rec.byStore[s.code] = 0; });

  // Classify first, so resale-check is asked about the claimed add-backs only.
  var claimed = [];
  affected.forEach(function (r) {
    var hit = st.byOrder[r.ebay_order_id];
    var n = _cpsNorm(hit ? hit.status : '');
    if (CPS_PAID_STATUSES.indexOf(n) >= 0) claimed.push(r);
  });
  var resale = _cpsResaleMap(CPS_RESALE_CHECK === 'all' ? affected : claimed);

  affected.forEach(function (r) {
    var hit = st.byOrder[r.ebay_order_id];
    var status = hit ? hit.status : '';
    var n = _cpsNorm(status);
    var isPaid = CPS_PAID_STATUSES.indexOf(n) >= 0;
    var isRet  = CPS_RETURNED_STATUSES.indexOf(n) >= 0;
    var rs = resale.byOrder[r.ebay_order_id] || null;
    var resold = !!(rs && rs.verdict === 'RESOLD');
    var addBack = isPaid && !(resold && CPS_EXCLUDE_RESOLD_FROM_RECOVERY);

    if (addBack) {
      rec.byStore[r.store_code] = _cpsMoney(rec.byStore[r.store_code] + _cpsMoney(r.ebay_refund_total));
      rec.counted++;
    } else if (isPaid) {
      // Marked paid, but the item sold again after the refund — so the money is
      // already inside the sales figure and must not be added a second time.
      rec.excluded.push({ store: r.store_code, order: r.order_name,
        ebay: r.ebay_order_id, amount: _cpsMoney(r.ebay_refund_total),
        resale: rs.order, at: rs.at, resaleAmount: rs.amount });
      rec.excludedAmt = _cpsMoney(rec.excludedAmt + _cpsMoney(r.ebay_refund_total));
    } else if (isRet) {
      rec.returnedN++;
      rec.returnedCost += _cpsMoney(r.ebay_order_total);   // proxy; disclosed as such
    } else if (n) {
      rec.notCounted[status] = (rec.notCounted[status] || 0) + _cpsMoney(r.ebay_refund_total);
    }
    rec.rows.push({ r: r, status: status, isPaid: isPaid, isRet: isRet,
                    addBack: addBack, resold: resold, rs: rs,
                    tab: hit ? hit.tab : '', note: hit ? hit.note : '' });
  });
  rec.resale = resale;
  var recTtl = _cpsSum(CPS_STORES.map(function (s) { return rec.byStore[s.code]; }));

  // ---- the document -------------------------------------------------------
  var title = 'PayMore — ' + CPS_MONTH_NAME + ' Company Performance (measured '
            + Utilities.formatDate(t0, CPS_TZ, 'yyyy-MM-dd HH:mm') + ')';
  var ss = SpreadsheetApp.create(title);

  var sheet = _cpsSheetMonth();

  var ctx = { ss: ss, t0: t0, daily: daily, ref: ref, reach: reach, st: st, sheet: sheet,
              byStore: byStore, byDay: byDay, affected: affected, stillPaid: stillPaid,
              refByStore: refByStore, shipByStore: shipByStore, shipN: shipN,
              rec: rec, recTtl: recTtl };

  _cpsSummary(ctx);
  _cpsReadMe(ctx);
  _cpsBridge(ctx);
  _cpsByStore(ctx);
  _cpsDaily(ctx);
  _cpsRecovery(ctx);
  _cpsRefundedOrders(ctx);
  _cpsStillExposed(ctx);
  _cpsReconcile(ctx);

  var first = ss.getSheets()[0];
  if (first.getName() === 'Sheet1') ss.deleteSheet(first);
  ss.setActiveSheet(ss.getSheetByName('Read Me'));

  Logger.log('=== BUILT ===');
  Logger.log('%s', title);
  Logger.log('%s', ss.getUrl());
  Logger.log('');
  Logger.log('sold %s | refunded to buyers %s | recovered %s | kept %s',
    _cpsSum([byStore.OVL.sales, byStore.LEE.sales, byStore.WSP.sales, byStore.MPL.sales, byStore.BAL.sales]).toFixed(2),
    _cpsSum(CPS_STORES.map(function (s) { return refByStore[s.code]; })).toFixed(2),
    recTtl.toFixed(2), '(see Bridge)');
  if (!st.ok) Logger.log('!! recovery NOT applied: %s', st.why);
  Logger.log('The file is UNSHARED. Share it deliberately.');
}

// The Sales Summary month, read once. Both the Summary tab (which has to explain
// why its gross profit is not the sheet's) and the Reconciliation tab (which
// shows it day by day) need this grid, and it is a whole-tab getValues.
//
// ⚠️ THE SHEET IS NOT A CLEAN "WHAT WE SOLD" FIGURE, AND THAT IS THE WHOLE POINT
// OF SHOWING IT. Its unrestated days carry Shopify's reported net sales, which
// already had the fault's refunds netted out on the day they landed — so the
// sheet has quietly absorbed most of the damage already. See _cpsSummary.
function _cpsSheetMonth() {
  var out = { ok: false, why: '', values: null, sales: 0, cost: 0, cells: 0 };
  try {
    var tab = SpreadsheetApp.openById(CPS_SALES_BOOK).getSheetByName(CPS_SALES_TAB);
    if (!tab) throw new Error('no tab named "' + CPS_SALES_TAB + '"');
    out.values = tab.getRange(1, 1, tab.getLastRow(), tab.getLastColumn()).getValues();
  } catch (e) {
    out.why = String(e).slice(0, 200);
    return out;
  }
  var dim = new Date(Number(CPS_MONTH.slice(0, 4)), Number(CPS_MONTH.slice(5, 7)), 0).getDate();
  for (var d = 1; d <= dim; d++) {
    for (var i = 0; i < CPS_STORES.length; i++) {
      var base = CPS_COL_BASES[CPS_STORES[i].code];
      var row = _cpsSheetDayRow(out.values, base, d);
      if (row < 0) continue;
      out.sales = _cpsMoney(out.sales + _cpsMoney(out.values[row][base + CPS_COL_SALES]));
      out.cost  = _cpsMoney(out.cost  + _cpsMoney(out.values[row][base + CPS_COL_COST]));
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
    if (first === 'TTL' || first.indexOf('TRACKING') === 0) break;
    if (parseInt(values[r][base], 10) === day) return r;
  }
  return -1;
}

function _cpsLastDay() {
  var y = Number(CPS_MONTH.slice(0, 4)), m = Number(CPS_MONTH.slice(5, 7));
  return CPS_MONTH + '-' + new Date(y, m, 0).getDate();
}

// The days the SHEET is short on, derived rather than typed in — CPS_MONTH is a
// variable and a hardcoded "Aug 20, 24 and 25" would be stated as fact in a
// September workbook.
//
// ⚠️ THE SHEET'S SHORT DAYS, NOT eBAY'S PAYOUT DAYS. They are different lists.
// eBay's cash left on Aug 24 and 25, but the sheet is also short about seventeen
// thousand on Aug 20 — the Marketplace Connect back-fill, refunded inside Shopify
// and never propagated, so no money ever left. It still sits in the sheet as a
// negative, so it belongs in a sentence about why the sheet is low. Naming eBay's
// dates above numbers derived from the sheet gap is the sort of mismatch that
// gets a document sent back.
//
// Days carrying under 2% of the gap are left out: a sentence about where the
// damage sits should not list four days worth a few hundred dollars.
function _cpsShortDays(c) {
  if (!c.sheet || !c.sheet.ok) return '';
  var gap = {}, total = 0;
  Object.keys(c.byDay).forEach(function (day) {
    var d = Number(day.slice(8, 10)), g = 0;
    for (var i = 0; i < CPS_STORES.length; i++) {
      var code = CPS_STORES[i].code, base = CPS_COL_BASES[code];
      var row = _cpsSheetDayRow(c.sheet.values, base, d);
      if (row < 0) continue;
      var mine = (c.byDay[day] || {})[code] || { sales: 0 };
      g += _cpsMoney(mine.sales) - _cpsMoney(c.sheet.values[row][base + CPS_COL_SALES]);
    }
    g = _cpsMoney(g);
    if (g > 0.005) { gap[d] = g; total += g; }
  });
  var days = Object.keys(gap).map(Number)
    .filter(function (d) { return total > 0 && gap[d] / total >= 0.02; })
    .sort(function (a, b) { return a - b; });
  if (!days.length) return '';
  var mon = MR_CPS_MON[Number(CPS_MONTH.slice(5, 7)) - 1];
  var names = days.map(function (d) { return mon + ' ' + d; });
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

var MR_CPS_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ------------------------------------------------------------------ Summary --
// One screen, no jargon, nothing to page through. Everything here is repeated in
// detail somewhere else in the workbook; this tab exists so that nobody has to go
// and find it.
//
// ⚠️ IT ANSWERS THE SHEET QUESTION HEAD-ON, because it is the first thing anyone
// who knows the business will ask: "why is your gross profit almost the same as
// the sheet's, if the sheet is supposed to be before the damage?" The answer is
// that the sheet is NOT before the damage. The refunds fired on Aug 20, 24 and
// 25; those days were never restated, so the sheet still carries them as
// negatives and has already absorbed most of the loss. The two figures landing
// close together is the two methods agreeing, not an error — and burying that
// would leave the most obvious challenge unanswered.
function _cpsSummary(c) {
  var sold = _cpsSum(CPS_STORES.map(function (s) { return c.byStore[s.code].sales; }));
  var cost = _cpsSum(CPS_STORES.map(function (s) { return c.byStore[s.code].cost; }));
  var out  = _cpsSum(CPS_STORES.map(function (s) { return c.refByStore[s.code]; }));
  var kept = _cpsMoney(sold - out + c.recTtl);
  var gp   = _cpsMoney(kept - cost);
  var gpHad = _cpsMoney(sold - cost);
  var hit  = _cpsMoney(gpHad - gp);
  var ship = _cpsSum(CPS_STORES.map(function (s) { return c.shipByStore[s.code]; }));
  var shipN = c.shipN.OVL + c.shipN.LEE + c.shipN.WSP + c.shipN.MPL + c.shipN.BAL;
  var $ = _cpsDollars;

  var L = [];
  var push = function (a, b) { L.push([a, b === undefined ? '' : b]); };

  push('PayMore — ' + CPS_MONTH_NAME);
  push('What the company actually did, measured '
    + Utilities.formatDate(c.t0, CPS_TZ, 'MMMM d, yyyy') + ' at '
    + Utilities.formatDate(c.t0, CPS_TZ, 'h:mm a') + ' US Central');
  push('');
  push('IN ONE SENTENCE');
  push(CPS_MONTH_NAME + ' was a ' + $(sold) + ' month. A software fault refunded '
    + $(out) + ' to ' + c.affected.length + ' buyers who never asked for it, and '
    + shipN + ' of them had already received their goods — so we lost the money AND the '
    + 'product. That turned ' + $(gpHad) + ' of gross profit into ' + $(gp) + '.');
  push('');
  push('THE NUMBERS');
  push('What we sold', sold);
  push('Refunded to buyers by the fault', -out);
  push('Got back from buyers who paid us', c.recTtl);
  push('WHAT WE KEPT', kept);
  push('Cost of the goods we sold', -cost);
  push('GROSS PROFIT', gp);
  push('');
  push('WHAT IT COST US');
  push('Gross profit if the fault had never happened', gpHad);
  push('Gross profit as it actually landed', gp);
  push('The fault cost us', hit);
  push('  which is this share of the month', gpHad ? hit / gpHad : 0);
  push('');
  push('STILL AT RISK');
  push('Orders refunded in Shopify that eBay has NOT refunded yet', c.stillPaid.length);
  push('  if they follow, this much more leaves',
    _cpsSum(c.stillPaid.map(function (r) { return _cpsMoney(r.shopify_refund); })));
  push('');

  // ---- the sheet question ----
  push('WHY THIS IS NOT THE SAME AS THE SALES SUMMARY SHEET');
  if (c.sheet.ok) {
    var shGp = _cpsMoney(c.sheet.sales - c.sheet.cost);
    push('The sheet shows this much gross profit for ' + CPS_MONTH_NAME, shGp);
    push('This workbook says our gross profit was', gp);
    push('Difference (this workbook minus the sheet)', _cpsMoney(gp - shGp));
    push('');
    push('That looks wrong, and it is not. The sheet is NOT a "before the damage" figure. '
      + (_cpsShortDays(c)
          ? 'Almost all of the gap sits on ' + _cpsShortDays(c) + '. Those days were never '
            + 'restated, so the sheet still carries their refunds as negatives — it has already '
            + 'absorbed most of the loss without anyone deciding that it should.'
          : 'Its unrestated days still carry the fault\'s refunds as negatives, so it has '
            + 'already absorbed most of the loss without anyone deciding that it should.'));
    push('');
    push('Sales the sheet never added back', _cpsMoney(sold - c.sheet.sales));
    push('Cost the sheet reversed along with them', _cpsMoney(cost - c.sheet.cost));
    push('  so the sheet is short this much gross profit',
      _cpsMoney((sold - c.sheet.sales) - (cost - c.sheet.cost)));
    push('Cash that actually left the building', out);
    push('  this workbook is more conservative by',
      _cpsMoney(out - ((sold - c.sheet.sales) - (cost - c.sheet.cost))));
    push('');
    push('The difference is one decision: when a buyer keeps the goods AND the money, the sheet '
      + 'credits the cost of those goods back as though they returned to the shelf. This workbook '
      + 'does not, because they did not. Two methods, from opposite directions, landing within '
      + $(Math.abs(_cpsMoney(gp - shGp))) + ' of each other.');
    push('');
    push('⚠️ SO THE SHEET UNDERSTATES WHAT WE SOLD. Our real ' + CPS_MONTH_NAME
      + ' gross profit, before the fault, was ' + $(gpHad) + ' — not ' + $(shGp)
      + (_cpsShortDays(c)
          ? '. If ' + _cpsShortDays(c) + ' are ever restated the way the later days were, the '
            + 'sheet will move to meet this.'
          : '.'));
  } else {
    push('The Sales Summary could not be read, so the comparison is not shown here.',
      c.sheet.why);
  }
  push('');
  push('Every figure above is order-level and re-derivable. See the other tabs.');

  var sh = c.ss.insertSheet('Summary');
  sh.getRange(1, 1, L.length, 2).setValues(L);

  // ---- looks ----
  sh.getRange(1, 1).setFontSize(18).setFontWeight('bold').setFontColor(CPS_HEAD);
  sh.getRange(2, 1).setFontColor('#6b7280').setFontStyle('italic');
  sh.setColumnWidth(1, 520);
  sh.setColumnWidth(2, 170);
  sh.getRange(1, 1, L.length, 2).setVerticalAlignment('top').setWrap(true).setFontColor(CPS_INK);
  sh.getRange(1, 1).setFontColor(CPS_HEAD);
  sh.getRange(1, 2, L.length, 1).setHorizontalAlignment('right');

  for (var r = 1; r <= L.length; r++) {
    var label = String(L[r - 1][0]);
    var val = L[r - 1][1];
    var bare = label.replace(/[^A-Za-z]/g, '');
    // A heading is a line with no figure that is entirely capitals.
    if (val === '' && bare.length > 4 && label === label.toUpperCase()) {
      sh.getRange(r, 1, 1, 2).setFontWeight('bold').setFontColor(CPS_HEAD)
        .setBackground(CPS_SOFT).setWrap(false);
    }
    if (typeof val === 'number') {
      var isCount = label.indexOf('Orders refunded') === 0;
      var isPct = label.indexOf('which is this share') >= 0;
      sh.getRange(r, 2).setNumberFormat(isPct ? CPS_PCT : (isCount ? '#,##0' : CPS_MONEY));
      if (label === label.toUpperCase() && bare.length > 4) {
        sh.getRange(r, 1, 1, 2).setFontWeight('bold').setFontSize(12);
      }
    }
  }
  sh.setFrozenRows(2);
}

// ------------------------------------------------------------------ Read Me --
function _cpsReadMe(c) {
  var sold  = _cpsSum(CPS_STORES.map(function (s) { return c.byStore[s.code].sales; }));
  var cost  = _cpsSum(CPS_STORES.map(function (s) { return c.byStore[s.code].cost; }));
  var out   = _cpsSum(CPS_STORES.map(function (s) { return c.refByStore[s.code]; }));
  var ship  = _cpsSum(CPS_STORES.map(function (s) { return c.shipByStore[s.code]; }));
  var kept  = _cpsMoney(sold - out + c.recTtl);
  var gp    = _cpsMoney(kept - cost);
  var gpHad = _cpsMoney(sold - cost);
  // Utilities.formatString has no grouping flag and toFixed has no separators,
  // so a headline reads "$747908.96" — a number a CFO has to count digits on.
  var $ = _cpsDollars;

  var L = [
    ['PayMore — ' + CPS_MONTH_NAME + ': how the company actually did'],
    [''],
    ['MEASURED'],
    ['Shopify sales and cost', _cpsStamp(c.t0.toISOString())],
    ['eBay refund state', _cpsStamp(c.ref.measured_to)],
    ['Outreach statuses', c.st.ok ? 'read from ' + c.st.tabs.length + ' tabs, '
        + c.st.rows + ' rows (' + c.st.blank + ' blank)' : 'NOT READ — ' + c.st.why],
    ['Built by', Session.getActiveUser().getEmail() || '(unknown)'],
    [''],
    ['THE HEADLINE'],
    ['We sold ' + $(sold) + ' of goods in ' + CPS_MONTH_NAME + '.'],
    [$(out) + ' of that was refunded back to eBay buyers by a fault in Marketplace Connect. Nobody asked for it.'],
    [$(ship) + ' of those refunds went to buyers who had ALREADY RECEIVED the goods — they kept the item and the money.'],
    [c.recTtl > 0 ? $(c.recTtl) + ' has been recovered from buyers who paid us back, and is added back below.'
                  : (c.st.ok ? 'No recovery has been recorded yet against the statuses currently marked as paid.'
                             : 'Recovery is NOT included in this build — see MEASURED above.')],
    [c.rec.excluded.length ? c.rec.excluded.length + ' further orders are marked as paid but are NOT added back: the '
        + 'item sold again afterwards, so that money (' + $(c.rec.excludedAmt) + ') is already inside the sales figure '
        + 'above and counting it twice would overstate the month. Each one is listed with its later sale on the '
        + 'Recovery tab.'
      : 'No order claimed as paid turned out to be a re-sale in disguise, so nothing is counted twice.'],
    ['So the company kept ' + $(kept) + ' of revenue and ' + $(gp) + ' of gross profit.'],
    ['Had the fault never happened, the same month would have produced ' + $(gpHad) + ' of gross profit.'],
    [''],
    ['HOW EACH LINE IS BUILT — the four choices, all deliberate'],
    ['1. SALES ARE THE REAL SALES.', 'Orders refunded by the fault are added back. They were genuine sales to genuine '
      + 'customers who kept genuine goods; a bookkeeping accident does not un-sell them. This is the same basis as the '
      + 'Sales Summary sheet, and the Reconciliation tab proves the two agree.'],
    ['2. THE REFUNDED CASH COMES OFF IN FULL.', 'Every dollar eBay returned to a buyer is subtracted, measured order by '
      + 'order against the eBay Sell Fulfillment API rather than estimated.'],
    ['3. THE COST OF THOSE GOODS STAYS IN.', 'The buyer kept the item, so we lost the product as well as the money. '
      + 'Reversing the cost would flatter the month by pretending the unit came back to the shelf. This is the single '
      + 'most conservative choice in the document and it is made on purpose.'],
    ['4. ONLY BUYERS WHO PAID US BACK ARE ADDED BACK.', 'Driven by the Status column the five managers maintain in the '
      + 'outreach workbook. Every status found is listed on the Recovery tab with the money against it, including the '
      + 'ones NOT counted, so nothing is hidden in a mapping.'],
    [''],
    ['WHAT IS NOT IN THIS NUMBER'],
    ['Operating costs.', 'This is revenue and gross profit. Rent, payroll, marketing and eBay/card fees are not here. '
      + 'This is not a P&L; it is the top of one.'],
    ['The still-exposed orders.', c.stillPaid.length + ' orders (' + $(_cpsSum(c.stillPaid.map(function (r) {
        return _cpsMoney(r.shopify_refund); }))) + ') are refunded in Shopify and still show PAID on eBay. They have '
      + 'NOT been subtracted, because the money has not left. If the hourly job fires again they will, so treat that '
      + 'figure as exposure, not loss. See the Still Exposed tab.'],
    ['Goods that came back.', c.rec.returnedN + ' buyers are marked as returning the item. Their cost is still counted '
      + 'as lost per choice 3. The Recovery tab shows what that decision is worth so it can be revisited.'],
    [''],
    ['HOW TO CHALLENGE IT'],
    ['Every figure on every tab is order-level and re-derivable. The two measurements are re-runnable on demand and '
      + 'each one stamps its own time, so any number in this workbook can be traced to the minute it was taken.'],
    ['Re-running the builder creates a NEW file and never edits this one, so the copy you are reading cannot change '
      + 'underneath you.']
  ];

  var sh = c.ss.insertSheet('Read Me');
  sh.getRange(1, 1, L.length, 2).setValues(L.map(function (r) {
    return [r[0] || '', r.length > 1 ? r[1] : ''];
  }));
  sh.getRange(1, 1).setFontSize(16).setFontWeight('bold').setFontColor(CPS_HEAD);
  [3, 9, 18, 24, 29].forEach(function (r) {
    sh.getRange(r, 1, 1, 2).setFontWeight('bold').setFontColor(CPS_HEAD).setBackground(CPS_SOFT);
  });
  sh.getRange(19, 1, 4, 1).setFontWeight('bold');
  sh.getRange(25, 1, 3, 1).setFontWeight('bold');
  sh.setColumnWidth(1, 330);
  sh.setColumnWidth(2, 760);
  sh.getRange(1, 1, L.length, 2).setVerticalAlignment('top').setWrap(true).setFontColor(CPS_INK);
  sh.getRange(1, 1).setFontColor(CPS_HEAD);
  sh.setFrozenRows(1);
}

// ------------------------------------------------------------------- Bridge --
function _cpsBridge(c) {
  var sold = _cpsSum(CPS_STORES.map(function (s) { return c.byStore[s.code].sales; }));
  var cost = _cpsSum(CPS_STORES.map(function (s) { return c.byStore[s.code].cost; }));
  var out  = _cpsSum(CPS_STORES.map(function (s) { return c.refByStore[s.code]; }));
  var kept = _cpsMoney(sold - out + c.recTtl);
  var gp   = _cpsMoney(kept - cost);
  var gpHad = _cpsMoney(sold - cost);

  var sh = c.ss.insertSheet('Bridge');
  var rows = [
    ['THE BRIDGE — from what we sold to what we kept', '', ''],
    ['as measured ' + Utilities.formatDate(c.t0, CPS_TZ, 'yyyy-MM-dd HH:mm') + ' US Central', '', ''],
    ['', '', ''],
    ['', 'Amount', '% of sales'],
    ['What we sold in ' + CPS_MONTH_NAME + ' (real sales)', sold, 1],
    ['Less: cash refunded to eBay buyers by the fault', -out, -out / sold],
    ['Add: recovered from buyers who paid us back', c.recTtl, c.recTtl / sold],
    ['= REVENUE THE COMPANY ACTUALLY KEPT', kept, kept / sold],
    ['', '', ''],
    ['Less: cost of goods sold, including the goods we lost', -cost, -cost / sold],
    ['= GROSS PROFIT AS IT ACTUALLY LANDED', gp, gp / sold],
    ['', '', ''],
    ['Gross margin as it landed', '', gp / kept],
    ['Gross margin had the fault never happened', '', gpHad / sold],
    ['', '', ''],
    ['WHAT THE INCIDENT COST US', '', ''],
    // ⚠️ THIS EQUALS THE CASH REFUNDED, AND THAT IS NOT AN ERROR — it is the
    // whole point. The cost of those units was already spent and the buyer kept
    // them, so nothing came back to offset it. Every refunded dollar was a
    // dollar of gross profit, not a dollar of revenue with a margin on it. The
    // label says so, because the first question in the room will be "why are
    // these two numbers the same?"
    ['Gross profit lost to the fault — nearly all of the refund, because the goods '
      + 'were already paid for and did not come back, so no cost reverses to offset it',
      -(gpHad - gp), -(gpHad - gp) / gpHad],
    ['Orders refunded without anyone asking', c.affected.length, ''],
    ['of those, already delivered (buyer kept goods AND cash)',
      c.shipN.OVL + c.shipN.LEE + c.shipN.WSP + c.shipN.MPL + c.shipN.BAL, ''],
    ['Still exposed: refunded in Shopify, still PAID on eBay',
      _cpsSum(c.stillPaid.map(function (r) { return _cpsMoney(r.shopify_refund); })), '']
  ];
  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  sh.getRange(1, 1).setFontSize(15).setFontWeight('bold').setFontColor(CPS_HEAD);
  sh.getRange(2, 1).setFontColor('#6b7280').setFontStyle('italic');
  sh.getRange(4, 1, 1, 3).setFontWeight('bold').setBackground(CPS_HEAD).setFontColor('#ffffff');
  sh.getRange(5, 2, 16, 1).setNumberFormat(CPS_MONEY);
  sh.getRange(18, 2, 2, 1).setNumberFormat('#,##0');
  sh.getRange(5, 3, 16, 1).setNumberFormat(CPS_PCT);
  [8, 11].forEach(function (r) {
    sh.getRange(r, 1, 1, 3).setFontWeight('bold').setBackground(CPS_SOFT).setBorder(
      true, null, true, null, null, null, CPS_HEAD, SpreadsheetApp.BorderStyle.SOLID);
  });
  sh.getRange(6, 1, 1, 3).setBackground(CPS_LOSS);
  sh.getRange(16, 1, 1, 3).setFontWeight('bold').setFontColor(CPS_HEAD).setBackground(CPS_SOFT);
  sh.getRange(17, 1, 1, 3).setBackground(CPS_LOSS);
  sh.getRange(20, 1, 1, 3).setBackground(CPS_WARN);
  sh.setColumnWidth(1, 420); sh.setColumnWidth(2, 150); sh.setColumnWidth(3, 120);
  sh.getRange(1, 1, rows.length, 3).setFontColor(CPS_INK);
  sh.getRange(1, 1).setFontColor(CPS_HEAD);
  sh.setFrozenRows(4);
}

// ----------------------------------------------------------------- By Store --
function _cpsByStore(c) {
  var sh = c.ss.insertSheet('By Store');
  var head = ['', 'Sold (real sales)', 'Refunded to buyers', 'Recovered',
              'Revenue kept', 'Cost of goods', 'Gross profit', 'GP% kept', 'GP% had it not happened'];
  var body = [];
  var T = [0, 0, 0, 0, 0, 0];
  CPS_STORES.forEach(function (s) {
    var b = c.byStore[s.code];
    var out = _cpsMoney(c.refByStore[s.code]), rc = _cpsMoney(c.rec.byStore[s.code]);
    var kept = _cpsMoney(b.sales - out + rc), gp = _cpsMoney(kept - b.cost);
    T[0] += b.sales; T[1] += out; T[2] += rc; T[3] += kept; T[4] += b.cost; T[5] += gp;
    body.push([s.label + ' (' + s.code + ')', _cpsMoney(b.sales), -out, rc, kept,
               -_cpsMoney(b.cost), gp, kept ? gp / kept : 0,
               b.sales ? (b.sales - b.cost) / b.sales : 0]);
  });
  body.push(['COMPANY', _cpsMoney(T[0]), -_cpsMoney(T[1]), _cpsMoney(T[2]), _cpsMoney(T[3]),
             -_cpsMoney(T[4]), _cpsMoney(T[5]), T[3] ? T[5] / T[3] : 0,
             T[0] ? (T[0] - T[4]) / T[0] : 0]);

  sh.getRange(1, 1, 1, head.length).setValues([head])
    .setFontWeight('bold').setBackground(CPS_HEAD).setFontColor('#ffffff').setWrap(true);
  sh.getRange(2, 1, body.length, head.length).setValues(body);
  sh.getRange(2, 2, body.length, 6).setNumberFormat(CPS_MONEY);
  sh.getRange(2, 8, body.length, 2).setNumberFormat(CPS_PCT);
  sh.getRange(body.length + 1, 1, 1, head.length).setFontWeight('bold').setBackground(CPS_SOFT)
    .setBorder(true, null, null, null, null, null, CPS_HEAD, SpreadsheetApp.BorderStyle.SOLID);
  sh.setColumnWidth(1, 210);
  for (var i = 2; i <= head.length; i++) sh.setColumnWidth(i, 128);
  sh.setFrozenRows(1); sh.setFrozenColumns(1);
  sh.getRange(1, 1, body.length + 1, head.length).setFontColor(CPS_INK);
  sh.getRange(1, 1, 1, head.length).setFontColor('#ffffff');
}

// --------------------------------------------------------------------- Daily --
function _cpsDaily(c) {
  var sh = c.ss.insertSheet('Daily');
  var head = ['Day'];
  CPS_STORES.forEach(function (s) { head.push(s.code + ' sales', s.code + ' cost'); });
  head.push('COMPANY sales', 'COMPANY cost', 'COMPANY GP', 'GP%');

  var days = Object.keys(c.byDay).sort();
  var body = [], T = { s: 0, c: 0 };
  days.forEach(function (d) {
    var row = [d], ds = 0, dc = 0;
    CPS_STORES.forEach(function (st) {
      var v = c.byDay[d][st.code] || { sales: 0, cost: 0 };
      row.push(v.sales, v.cost); ds += v.sales; dc += v.cost;
    });
    ds = _cpsMoney(ds); dc = _cpsMoney(dc);
    T.s += ds; T.c += dc;
    row.push(ds, dc, _cpsMoney(ds - dc), ds ? (ds - dc) / ds : 0);
    body.push(row);
  });
  var tot = ['MONTH'];
  CPS_STORES.forEach(function (s) {
    tot.push(_cpsMoney(c.byStore[s.code].sales), _cpsMoney(c.byStore[s.code].cost));
  });
  tot.push(_cpsMoney(T.s), _cpsMoney(T.c), _cpsMoney(T.s - T.c), T.s ? (T.s - T.c) / T.s : 0);
  body.push(tot);

  sh.getRange(1, 1, 1, head.length).setValues([head])
    .setFontWeight('bold').setBackground(CPS_HEAD).setFontColor('#ffffff').setWrap(true);
  sh.getRange(2, 1, body.length, head.length).setValues(body);
  sh.getRange(2, 2, body.length, head.length - 2).setNumberFormat(CPS_MONEY);
  sh.getRange(2, head.length, body.length, 1).setNumberFormat(CPS_PCT);
  sh.getRange(body.length + 1, 1, 1, head.length).setFontWeight('bold').setBackground(CPS_SOFT)
    .setBorder(true, null, null, null, null, null, CPS_HEAD, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(2, head.length - 3, body.length, 4).setBackground(CPS_SOFT);
  sh.setColumnWidth(1, 100);
  for (var i = 2; i <= head.length; i++) sh.setColumnWidth(i, 96);
  sh.setFrozenRows(1); sh.setFrozenColumns(1);
  sh.getRange(1, 1, body.length + 1, head.length).setFontColor(CPS_INK);
  sh.getRange(1, 1, 1, head.length).setFontColor('#ffffff');

  var note = sh.getRange(body.length + 3, 1);
  // ⚠️ DO NOT CLAIM THESE ARE THE SHEET'S NUMBERS. They are a systematic
  // recomputation of the whole month on one consistent rule. The Sales Summary
  // is a mixture: days 1-23 and 25 are as the daily emails reported them, and
  // only 24 and 26-31 carry the hand restatements in mirror-fix.gs. So the two
  // agree on most days and differ on a few, every difference for a reason that
  // is written down. Saying "exactly the basis the sheet runs on" would be a
  // claim the Reconciliation tab immediately disproves.
  note.setValue('These are the real daily figures on ONE consistent rule for the whole month: Shopify net sales '
    + 'with the fault\'s refunds added back and draft-order invoices removed. The Sales Summary sheet is the '
    + 'published record and is built the same way, except that only the restated days carry the hand corrections '
    + 'documented in mirror-fix.gs — so the two agree on most days and differ on a few. The Reconciliation tab '
    + 'shows every difference so it can be checked rather than taken on trust.');
  // ⚠️ DO NOT MERGE THIS. The tab freezes column 1 so the day stays visible while
  // you scroll across five stores, and Sheets refuses to merge a range that
  // straddles the frozen boundary: "You can't merge frozen and non-frozen
  // columns." Left unmerged and unwrapped, the text simply overflows across the
  // empty cells to its right and reads the same, with no merge to refuse.
  sh.getRange(body.length + 3, 1).setWrap(false).setFontColor('#6b7280').setFontStyle('italic');
}

// ------------------------------------------------------------------ Recovery --
function _cpsRecovery(c) {
  var sh = c.ss.insertSheet('Recovery');
  var L = [['RECOVERY — what came back, and on whose word', ''],
           [c.st.ok ? 'Statuses read from: ' + c.st.tabs.join(', ')
                    : 'STATUSES NOT READ — ' + c.st.why, ''],
           ['', ''],
           ['Counted as PAID (added back to sales)', ''],
           ['Statuses treated as paid', CPS_PAID_STATUSES.join(', ')],
           ['Orders counted', c.rec.counted],
           ['Money added back', c.recTtl],
           ['', '']];
  CPS_STORES.forEach(function (s) { L.push(['  ' + s.code, _cpsMoney(c.rec.byStore[s.code])]); });
  L.push(['', '']);
  L.push(['FOUND BUT NOT COUNTED — check nothing belongs above', '']);
  var nk = Object.keys(c.rec.notCounted).sort(function (a, b) {
    return c.rec.notCounted[b] - c.rec.notCounted[a]; });
  if (!nk.length) L.push(['(every status found is either paid or returned)', '']);
  nk.forEach(function (k) { L.push(['  "' + k + '"', _cpsMoney(c.rec.notCounted[k])]); });
  L.push(['', '']);
  L.push(['GOODS RETURNED INSTEAD OF MONEY — disclosed, NOT in the headline', '']);
  L.push(['Orders marked as returning the item', c.rec.returnedN]);
  L.push(['Their eBay order value (a proxy for the cost back on the shelf)', _cpsMoney(c.rec.returnedCost)]);
  L.push(['', '']);
  L.push(['THE DOUBLE COUNT, AND WHAT WAS DONE ABOUT IT', '']);
  L.push(['A buyer can pay us back two ways. Money sent outside Shopify is nowhere in the sales figure, so adding '
    + 'it back is right. But a buyer who paid a draft-order invoice or simply bought the item again created a NEW '
    + 'Shopify order, which is ALREADY inside the sales figure on the Bridge — adding it to recovery as well would '
    + 'count the same money twice. Every order claimed as paid was therefore checked against Shopify for a later '
    + 'sale of the same item, and the ones that had one are listed below and NOT added back.', '']);
  L.push(['Orders claimed as paid but excluded (item sold again)', c.rec.excluded.length]);
  L.push(['Money NOT added back for that reason', _cpsMoney(c.rec.excludedAmt)]);
  L.push(['Setting used', CPS_EXCLUDE_RESOLD_FROM_RECOVERY
    ? 'resold orders EXCLUDED from the add-back (conservative)'
    : 'resold orders INCLUDED — the double count is live, see the list below']);
  L.push(['Resale check coverage', c.rec.resale.checked + ' orders verified'
    + (c.rec.resale.failed ? ', ' + c.rec.resale.failed + ' could NOT be verified' : '')
    + ' (mode: ' + CPS_RESALE_CHECK + ')']);
  c.rec.resale.notes.forEach(function (n) { L.push(['  unverified: ' + n, '']); });
  if (c.rec.excluded.length) {
    L.push(['', '']);
    L.push(['  Excluded order', '  The later sale that already carries the money']);
    c.rec.excluded.forEach(function (e) {
      L.push(['  ' + e.store + ' ' + e.order + ' (' + e.ebay + ')  ' + _cpsDollars(e.amount),
              '  ' + e.resale + '  ' + String(e.at || '').slice(0, 10) + '  ' + _cpsDollars(e.resaleAmount)]);
    });
  }
  L.push(['', '']);
  L.push(['Outreach position at ' + _cpsStamp(c.reach.generated_at), '']);
  L.push(['  Orders in the outreach list', c.reach.refunded_orders]);
  L.push(['  Messages already sent', c.reach.already_sent]);
  L.push(['  Still to send', c.reach.still_to_send]);
  L.push(['  Total being asked for', _cpsMoney(c.reach.total_to_ask_for)]);

  sh.getRange(1, 1, L.length, 2).setValues(L);
  sh.getRange(1, 1).setFontSize(15).setFontWeight('bold').setFontColor(CPS_HEAD);
  sh.getRange(2, 1).setFontColor('#6b7280').setFontStyle('italic');
  sh.setColumnWidth(1, 520); sh.setColumnWidth(2, 200);
  sh.getRange(1, 1, L.length, 2).setVerticalAlignment('top').setWrap(true).setFontColor(CPS_INK);
  sh.getRange(1, 1).setFontColor(CPS_HEAD);
  for (var r = 1; r <= L.length; r++) {
    var v = String(L[r - 1][0]);
    if (v === v.toUpperCase() && v.replace(/[^A-Z]/g, '').length > 5) {
      sh.getRange(r, 1, 1, 2).setFontWeight('bold').setFontColor(CPS_HEAD).setBackground(CPS_SOFT);
    }
    if (typeof L[r - 1][1] === 'number' && String(L[r - 1][0]).indexOf('Orders') < 0
        && String(L[r - 1][0]).indexOf('Messages') < 0 && String(L[r - 1][0]).indexOf('Still') < 0) {
      sh.getRange(r, 2).setNumberFormat(CPS_MONEY);
    }
  }
  sh.getRange(4, 1, 1, 2).setFontWeight('bold').setFontColor(CPS_HEAD).setBackground(CPS_SOFT);
}

// ----------------------------------------------------------- Refunded Orders --
function _cpsRefundedOrders(c) {
  var sh = c.ss.insertSheet('Refunded Orders');
  var head = ['Store', 'Shopify order', 'eBay order', 'SKU', 'eBay order total',
              '$ refunded to buyer', 'Delivered?', 'eBay refund date (Central)',
              'Buyer asked for it?', 'Status as typed', 'Added back to sales?',
              'Item sold again?', 'The later sale', 'Manager note'];
  var body = c.rec.rows.map(function (x) {
    var r = x.r;
    var added = x.addBack ? 'YES'
              : (x.isPaid ? 'NO — already a new sale'
              : (x.isRet ? 'no — goods came back' : 'no'));
    var again = !x.rs ? (x.isPaid ? 'not checked' : '')
              : (x.resold ? 'RESOLD' : 'no');
    var later = x.rs && x.rs.order
              ? x.rs.order + '  ' + String(x.rs.at || '').slice(0, 10) + '  '
                + _cpsDollars(x.rs.amount)
              : '';
    return [r.store_code, r.order_name, r.ebay_order_id, r.sku,
            _cpsMoney(r.ebay_order_total), _cpsMoney(r.ebay_refund_total),
            r.ebay_fulfillment_status === 'FULFILLED' ? 'YES — kept the goods' : 'no',
            r.ebay_refund_date ? Utilities.formatDate(new Date(r.ebay_refund_date), CPS_TZ, 'yyyy-MM-dd HH:mm') : '',
            r.ebay_cancel_state === 'NONE_REQUESTED' ? 'NO — nobody requested it' : r.ebay_cancel_state,
            x.status || '(blank)', added, again, later, x.note || ''];
  });
  body.sort(function (a, b) { return b[5] - a[5]; });

  sh.getRange(1, 1, 1, head.length).setValues([head])
    .setFontWeight('bold').setBackground(CPS_HEAD).setFontColor('#ffffff').setWrap(true);
  if (body.length) {
    sh.getRange(2, 1, body.length, head.length).setValues(body);
    sh.getRange(2, 5, body.length, 2).setNumberFormat(CPS_MONEY);
    sh.getRange(2, 1, body.length, head.length).setFontColor(CPS_INK);
  }
  var w = [64, 130, 130, 190, 120, 130, 150, 150, 175, 150, 165, 120, 215, 220];
  for (var i = 0; i < head.length; i++) sh.setColumnWidth(i + 1, w[i]);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, head.length).setFontColor('#ffffff');
  if (body.length) {
    var rules = [
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('YES')
        .setBackground('#dcfce7').setRanges([sh.getRange(2, 11, body.length, 1)]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextContains('already a new sale')
        .setBackground(CPS_WARN).setRanges([sh.getRange(2, 11, body.length, 1)]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('RESOLD')
        .setBackground('#dbeafe').setRanges([sh.getRange(2, 12, body.length, 1)]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextContains('kept the goods')
        .setBackground(CPS_LOSS).setRanges([sh.getRange(2, 7, body.length, 1)]).build()
    ];
    sh.setConditionalFormatRules(rules);
  }
}

// ------------------------------------------------------------ Still Exposed --
function _cpsStillExposed(c) {
  var sh = c.ss.insertSheet('Still Exposed');
  var head = ['Store', 'Shopify order', 'eBay order', 'SKU', 'Refunded in Shopify',
              'eBay payment status', 'Delivered?', 'Shopify refunded at (Central)', 'Batch'];
  var body = c.stillPaid.map(function (r) {
    return [r.store_code, r.order_name, r.ebay_order_id, r.sku, _cpsMoney(r.shopify_refund),
            r.ebay_payment_status, r.ebay_fulfillment_status === 'FULFILLED' ? 'yes' : 'no',
            r.shopify_refunded_at ? Utilities.formatDate(new Date(r.shopify_refunded_at), CPS_TZ, 'yyyy-MM-dd HH:mm') : '',
            r.batch];
  }).sort(function (a, b) { return b[4] - a[4]; });

  sh.getRange(1, 1, 1, 1).setValue('STILL EXPOSED — refunded in Shopify, eBay has not (yet) followed. '
    + 'NOT subtracted anywhere in this workbook: the money has not left. Measured '
    + _cpsStamp(c.ref.measured_to) + '.');
  sh.getRange(1, 1, 1, head.length).merge().setWrap(true).setBackground(CPS_WARN).setFontColor(CPS_INK);
  sh.getRange(2, 1, 1, head.length).setValues([head])
    .setFontWeight('bold').setBackground(CPS_HEAD).setFontColor('#ffffff').setWrap(true);
  if (body.length) {
    sh.getRange(3, 1, body.length, head.length).setValues(body);
    sh.getRange(3, 5, body.length, 1).setNumberFormat(CPS_MONEY);
    sh.getRange(3, 1, body.length, head.length).setFontColor(CPS_INK);
  }
  var w = [64, 130, 130, 190, 140, 165, 100, 175, 230];
  for (var i = 0; i < head.length; i++) sh.setColumnWidth(i + 1, w[i]);
  sh.setFrozenRows(2);
}

// ----------------------------------------------------------- Reconciliation --
// Reads the Sales Summary tab and compares it, day by day and store by store,
// with this recomputation. The point is not to find fault with either: it is so
// that when the CFO asks "does this match the sheet we have been running on?"
// the answer is a number and not an opinion.
function _cpsReconcile(c) {
  var sh = c.ss.insertSheet('Reconciliation');
  var head = ['Day', 'Store', 'Sheet sales', 'This workbook', 'Diff',
              'Sheet cost', 'This workbook', 'Diff'];
  var body = [], why = '';
  try {
    if (!c.sheet.ok) throw new Error(c.sheet.why || 'the Sales Summary could not be read');
    var values = c.sheet.values;
    Object.keys(c.byDay).sort().forEach(function (d) {
      var dayNo = Number(d.slice(8, 10));
      CPS_STORES.forEach(function (s) {
        var base = CPS_COL_BASES[s.code];
        var row = -1;
        for (var r = CPS_HEADER_ROWS; r < values.length; r++) {
          var first = String(values[r][0]).trim().toUpperCase();
          if (first === 'TTL' || first.indexOf('TRACKING') === 0) break;
          if (parseInt(values[r][base], 10) === dayNo) { row = r; break; }
        }
        var mine = c.byDay[d][s.code] || { sales: 0, cost: 0 };
        if (row < 0) { body.push([d, s.code, '(no row)', mine.sales, '', '(no row)', mine.cost, '']); return; }
        var shS = _cpsMoney(values[row][base + CPS_COL_SALES]);
        var shC = _cpsMoney(values[row][base + CPS_COL_COST]);
        body.push([d, s.code, shS, mine.sales, _cpsMoney(mine.sales - shS),
                   shC, mine.cost, _cpsMoney(mine.cost - shC)]);
      });
    });
  } catch (e) {
    why = 'Could not read the Sales Summary sheet: ' + String(e).slice(0, 200);
  }

  sh.getRange(1, 1, 1, 1).setValue(why ||
    ('SHEET vs THIS WORKBOOK. A difference is not automatically an error — the pinned days carry deliberate '
     + 'restatements documented in mirror-fix.gs, and the sheet is the published record. Anything unexplained '
     + 'here is worth a look before this goes upstairs.'));
  sh.getRange(1, 1, 1, head.length).merge().setWrap(true)
    .setBackground(why ? CPS_LOSS : CPS_SOFT).setFontColor(CPS_INK);
  sh.getRange(2, 1, 1, head.length).setValues([head])
    .setFontWeight('bold').setBackground(CPS_HEAD).setFontColor('#ffffff').setWrap(true);
  if (body.length) {
    sh.getRange(3, 1, body.length, head.length).setValues(body);
    sh.getRange(3, 3, body.length, 6).setNumberFormat(CPS_MONEY);
    sh.getRange(3, 1, body.length, head.length).setFontColor(CPS_INK);
    var rule = SpreadsheetApp.newConditionalFormatRule()
      .whenNumberNotBetween(-0.005, 0.005).setBackground(CPS_WARN)
      .setRanges([sh.getRange(3, 5, body.length, 1), sh.getRange(3, 8, body.length, 1)]).build();
    sh.setConditionalFormatRules([rule]);
  }
  sh.setColumnWidth(1, 100); sh.setColumnWidth(2, 64);
  for (var i = 3; i <= head.length; i++) sh.setColumnWidth(i, 120);
  sh.setFrozenRows(2);
}
