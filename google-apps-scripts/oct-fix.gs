// ============================================================================
// oct-fix.gs — OCTOBER restatements on the Net Profit tab.
//
//   octFixPreview()   log every write, change nothing
//   octFixApply()     write them
//
// Same mechanics as sep-fix.gs: a bare number written as a formula, which the
// daily sync leaves alone, under the same script lock the refresh takes.
// ONE TAB this time, not two — the Sales Summary's "Sales Oct 26" tab was
// retired on 2026-10-03, so "Net Profit Oct 26" is the only place the day lives
// (and daily_np follows it through np-sync within 15 minutes).
//
// ---------------------------------------------------------------------------
// OCT 8 — every store. Ethan's catch-up refunds of the Refund Mismatch master
// sheet.
//
// Over the months, 61 orders were refunded or cancelled on eBay (claims, holds,
// disputes, failed deliveries) and never refunded in Shopify, so Shopify still
// counted each one as a sale. On Oct 8 Ethan refunded all of them in Shopify, in one
// sitting — orders sold between April and August. ShopifyQL books a refund on the day it is
// CREATED (netprofit-collect re-dates nothing: REDATE_REFUNDS_TO_SALE_DAY is
// false, and a cross-month refund could never move anyway), so five months
// of housekeeping landed on one October day and took MPL and BAL negative.
//
// None of it is October trading, and the goal is graded on October. Each figure
// below is the day as reported with EXACTLY those orders' Oct 8 rows added
// back — sales and cost both, because the refunds reversed COGS too (all but
// MPL #MO03-1576 and the $50 partial on #MO03-1614, whose rows carry no cost).
// Matched per order against ShopifyQL `GROUP BY order_name` for 2026-10-08,
// whose totals agree with the tab to the cent at all five stores. All 61 matched,
// each at the amount on the master sheet.
//
// ⚠️ ONLY THE "REFUNDED ON SHOPIFY" ROWS. MPL's #MO03-2452 (−74.99) and
// #MO03-2465 (−49.99) were resolved on EBAY, so they never touched Shopify on
// Oct 8 and there is nothing to add back.
//
// ⚠️ THE STORES' OWN OCT 8 REFUNDS STAY IN. Every refund not on the list is
// left exactly where Shopify put it, including:
//   OVL  #KS01-14917 349.99, #KS01-15441 133.00, #KS01-15330 75.00,
//        #KS01-15087 38.99, and the three same-day 15465/66/67 refunds
//   LEE  #MO01-9315 209.99 (an Aug 31 sale — not on the list), #MO01-10091 30.00
//   WSP  #MO02-7420 1,380.00 — an amount-only adjustment on the 82-unit
//        EliteBook B2B lot sold Sep 25. Not on the list, so it is treated as real;
//        it is why WSP's cost still reads high against its sales.
//   MPL  #MO03-3637, -3744, -3844, -3848
//   BAL  #MO04-3574, -3708
//
//                reported              restated            added back
//   OVL    6,715.35 / 3,888.00    8,108.28 / 4,414.55    1,392.93 /   526.55   (7)
//   LEE    2,949.81 / 1,236.43    4,023.72 / 1,637.44    1,073.91 /   401.01   (8)
//   WSP      706.88 / 1,380.11    3,506.83 / 2,700.11    2,799.95 / 1,320.00   (5)
//   MPL   −1,658.94 /  −799.12    4,963.79 / 2,187.00    6,622.73 / 2,986.12   (26)
//   BAL   −1,797.98 /  −829.54    2,117.87 /   882.11    3,915.85 / 1,711.65   (15)
//
// ⚠️ `was` IS CHECKED BEFORE ANYTHING IS WRITTEN. A cell holding neither the
// reported figure nor the restated one has moved since this was derived — a
// late refund, a re-collection, a hand edit — and the add-back would no longer
// be the right size. That cell is refused, not overwritten; re-derive it.
//
// The pins stay out of November by themselves: netprofit-rollover.gs clears
// every bare-number cell it copies, and the cell's note along with it.
// ============================================================================

var OCTF_SHEET_ID = '1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8';  // Sales Summary 2026
var OCTF_TAB      = 'Net Profit Oct 26';
var OCTF_BASES    = { OVL: 0, LEE: 18, WSP: 36, MPL: 54, BAL: 72 };   // = NP_BASES
var OCTF_COL_SALES   = 1;
var OCTF_COL_COST    = 4;
var OCTF_HEADER_ROWS = 4;

function _octfNote1008(n, sales, cost, orders) {
  return 'Oct 8 restated — ' + n + ' catch-up refund(s) from the Refund Mismatch master sheet '
    + 'added back (' + sales + ' sales / ' + cost + ' cost): orders sold Apr–Aug that '
    + 'eBay had already refunded, refunded in Shopify by Ethan on Oct 8. Not October '
    + 'trading. The store\'s own Oct 8 refunds are untouched. Orders: ' + orders
    + '. Real figure. Locked from the daily sync.';
}

var OCTF_FIX = [
  { store: 'OVL', day: 8, was: [6715.35, 3888.00], sales: 8108.28, cost: 4414.55,
    note: _octfNote1008(7, '1392.93', '526.55',
      '#KS01-10698, #KS01-10934, #KS01-10941, #KS01-11963, #KS01-13416, #KS01-13425, #KS01-14008') },
  { store: 'LEE', day: 8, was: [2949.81, 1236.43], sales: 4023.72, cost: 1637.44,
    note: _octfNote1008(8, '1073.91', '401.01',
      '#MO01-6107, #MO01-6669, #MO01-7717, #MO01-8507, #MO01-8751, #MO01-8899, #MO01-8928, #MO01-8947') },
  { store: 'WSP', day: 8, was: [706.88, 1380.11], sales: 3506.83, cost: 2700.11,
    note: _octfNote1008(5, '2799.95', '1320.00',
      '#MO02-3652, #MO02-3805, #MO02-5262, #MO02-5953, #MO02-6752') },
  { store: 'MPL', day: 8, was: [-1658.94, -799.12], sales: 4963.79, cost: 2187.00,
    note: _octfNote1008(26, '6622.73', '2986.12',
      '#MO03-1335, #MO03-1405, #MO03-1503, #MO03-1553, #MO03-1576, #MO03-1588, #MO03-1614, '
      + '#MO03-1653, #MO03-1717, #MO03-1749, #MO03-1758, #MO03-1842, #MO03-1859, #MO03-1990, '
      + '#MO03-1999, #MO03-2140, #MO03-2148, #MO03-2178, #MO03-2204, #MO03-2248, #MO03-2329, '
      + '#MO03-2455, #MO03-2654, #MO03-2712, #MO03-2733, #MO03-2969') },
  { store: 'BAL', day: 8, was: [-1797.98, -829.54], sales: 2117.87, cost: 882.11,
    note: _octfNote1008(15, '3915.85', '1711.65',
      '#MO04-1421, #MO04-1597, #MO04-1843, #MO04-1949, #MO04-2007, #MO04-2042, #MO04-2058, '
      + '#MO04-2148, #MO04-2151, #MO04-2197, #MO04-2203, #MO04-2266, #MO04-2482, #MO04-2682, #MO04-2804') }
];

function octFixPreview() { _octfAll(true); }
function octFixApply()   { _octfAll(false); }

var OCTF_LOCK_WAIT_MS = 120000;

// ⚠️ THE SAME SCRIPT LOCK netprofit-sheet.gs TAKES — see _sepfAll for the
// 2026-09-08 near-miss. A pin written inside a refresh is overwritten by it.
// A preview takes no lock: it writes nothing.
function _octfAll(dryRun) {
  Logger.log(dryRun ? '=== PREVIEW — nothing will be written ===' : '=== APPLYING ===');
  var lock = null;
  if (!dryRun) {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(OCTF_LOCK_WAIT_MS)) {
      Logger.log('!! another writer holds the script lock — NOTHING WAS WRITTEN. A Net Profit '
               + 'refresh is mid-write (6:10am and 2:05pm Central, several minutes each). '
               + 'Wait for it to finish and run this again.');
      return;
    }
  }
  try {
    _octfRun(dryRun);
  } finally {
    if (lock) lock.releaseLock();
  }
}

// Located by day number, never computed off the header.
function _octfFindDayRow(values, base, day) {
  for (var r = OCTF_HEADER_ROWS; r < values.length; r++) {
    var first = String(values[r][0]).trim().toUpperCase();
    if (first === 'TTL' || first.indexOf('TRACKING') === 0) break;
    if (parseInt(values[r][base], 10) === day) return r;
  }
  return -1;
}

function _octfIsBareNumber(f) {
  if (!f) return false;
  var body = String(f).replace(/^=/, '').trim();
  if (!body || /[A-Za-z]/.test(body)) return false;
  var ALLOWED = '0123456789 .,+-*/()';
  for (var i = 0; i < body.length; i++) if (ALLOWED.indexOf(body.charAt(i)) < 0) return false;
  return true;
}

function _octfA1(c) {
  var s = '';
  for (c = c + 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + (c - 1) % 26) + s;
  return s;
}

function _octfRun(dryRun) {
  var sh = SpreadsheetApp.openById(OCTF_SHEET_ID).getSheetByName(OCTF_TAB);
  if (!sh) { Logger.log('!! tab "%s" NOT FOUND — nothing done', OCTF_TAB); return; }
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();
  var wrote = 0, already = 0, refused = 0;

  for (var i = 0; i < OCTF_FIX.length; i++) {
    var f = OCTF_FIX[i];
    var base = OCTF_BASES[f.store];
    var r = _octfFindDayRow(values, base, f.day);
    if (r < 0) { Logger.log('  %s day %s: ROW NOT FOUND, skipped', f.store, f.day); refused++; continue; }

    var pairs = [
      { col: base + OCTF_COL_SALES, want: f.sales, was: f.was[0], what: 'sales' },
      { col: base + OCTF_COL_COST,  want: f.cost,  was: f.was[1], what: 'cost'  }
    ];
    // Both cells are judged before either is written: a store restated on
    // sales and not cost would read a margin that neither figure supports.
    var plan = [], bad = false;
    for (var p = 0; p < pairs.length; p++) {
      var c = pairs[p].col, cur = values[r][c], curF = formulas[r][c];
      var a1 = _octfA1(c) + (r + 1);
      if (curF && !_octfIsBareNumber(curF)) {
        Logger.log('  %s day %s %s @%s: LIVE FORMULA "%s" — refused', f.store, f.day, pairs[p].what, a1, curF);
        bad = true; continue;
      }
      var n = Number(cur);
      if (curF && Math.abs(n - pairs[p].want) < 0.005) {
        Logger.log('  %s day %s %s @%s: already pinned at %s', f.store, f.day, pairs[p].what, a1, pairs[p].want);
        already++; continue;
      }
      if (cur === '' || Math.abs(n - pairs[p].was) >= 0.005) {
        Logger.log('  %s day %s %s @%s: holds %s, expected %s — the day has MOVED since this was '
                 + 'derived. Refused; re-derive it.', f.store, f.day, pairs[p].what, a1,
                 (cur === '' ? '(blank)' : cur), pairs[p].was);
        bad = true; continue;
      }
      plan.push({ row: r + 1, col: c + 1, a1: a1, from: n, want: pairs[p].want, what: pairs[p].what });
    }
    if (bad) { refused++; Logger.log('  %s day %s: NOTHING written for this store', f.store, f.day); continue; }
    for (var k = 0; k < plan.length; k++) {
      Logger.log('  %s day %s %s @%s: %s -> %s', f.store, f.day, plan[k].what, plan[k].a1, plan[k].from, plan[k].want);
      if (!dryRun) {
        var rng = sh.getRange(plan[k].row, plan[k].col);
        rng.setFormula('=' + plan[k].want.toFixed(2));
        rng.setNote(f.note);
      }
      wrote++;
    }
  }
  Logger.log('');
  Logger.log('%s: %s cell(s), %s already pinned, %s store(s) refused',
             dryRun ? 'WOULD WRITE' : 'WROTE', wrote, already, refused);
  if (dryRun) Logger.log('Nothing was written. Run octFixApply() to write it.');
}
