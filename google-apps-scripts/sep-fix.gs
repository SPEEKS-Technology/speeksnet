// ============================================================================
// sep-fix.gs — SEPTEMBER restatements, on BOTH tabs that carry the figure.
//
// A new file rather than another block in mirror-fix.gs, which is an AUGUST
// artifact and should stay one. Same mechanics, same lock convention: a bare
// number written as a formula, which the daily sync leaves alone.
//
//   sepFixPreview()   log every write, change nothing
//   sepFixApply()     write them
//
// ⚠️ TWO TABS, ONE TRUTH. The same day's sales appear in "Sales Sep 26" and in
// "Net Profit Sep 26", filled by two different jobs from two different queries.
// Restating one and not the other does not leave the second one merely stale —
// it leaves two sheets disagreeing about a day, with nothing on either saying
// which is right. So both are done in one run, from one list of figures.
//
// ---------------------------------------------------------------------------
// SEP 1 — OVL only. Two things in the day that are not selling.
//
// 1. DRAFT-ORDER INVOICES, $166.98 (cost $25.01). The repayment invoices from
//    the August glitch are still arriving. Recovery of a loss, not a sale, and
//    they come out of the day exactly as they did all through late August.
//
// 2. THE MARKETPLACE CONNECT DUPLICATE, $899.99 (cost $375.00). eBay order
//    11-15038-98055, a Lenovo Yoga Pro 9i, SOLD ON AUG 16 as #KS01-13840
//    through SPEEKS Connect. New MC re-imported it on Sep 1 at 6:30pm as
//    #KS01-14551 — a second live, paid, fulfilled Shopify order for one sale.
//    Ethan deleted the copy on Sep 2.
//
//    ⚠️ DELETING IT DID NOT TAKE IT OUT OF SEP 1. Checked after the deletion:
//    ShopifyQL still reports OVL's Sep 1 net sales as $2,016.30 with $1,005.84
//    on the PayMore channel, which is the duplicate plus $105.85 of real
//    selling. This is the same lesson dup-probe measured in August — the sales
//    dataset does not retroactively forget an order — and it is exactly why
//    these cells get pinned rather than waiting for the sync to come right.
//
//    The cost comes off the REAL order's line item ($375.00 unit cost on
//    KS01-7416A-R5R2), because the duplicate no longer exists to be read.
//
//    ⚠️ IF SHOPIFY LATER DROPS THE DELETED ORDER FROM SEP 1 ON ITS OWN, this
//    pin is still correct and still wins — a locked cell has stopped tracking
//    the sync by definition. Do not "unpin to let it settle".
//
//   reported   2,016.30 sales / 568.01 cost
//   − drafts    −166.98        −25.01
//   − duplicate −899.99       −375.00
//   = true        949.33        168.00      (GP 781.33)
//
//   Both tabs report the same two wrong figures, from two independent queries —
//   netprofit-collect returns net_sales 2016.3 / cost 568.01 for OVL Sep 1, cell
//   for cell what the Sales Summary holds. So one correction fits both.
//
// ⚠️ PINNING THE NET PROFIT TAB USED TO FREEZE THE WHOLE DAY. Its writer
// refused a row outright if any of the five columns it fills held a formula, so
// pinning Sales and Cost would have frozen that day's eBay Fee, Shipping and CC
// Fee at whatever they happened to hold — silently, for the rest of the month.
// netprofit-sheet.gs now locks PER COLUMN (see _npWriteRuns), so the two pinned
// cells stay pinned and the other three keep updating underneath them. That
// change is a prerequisite for this one; do not run this against an older copy.
//
// ⚠️ WSP's Sep 1 is NOT restated here. It carries a +$334.99 mirror-back refund
// that sales-true-daily says should be added back, which would take WSP from
// $4,885.73 to $5,220.72. That is a different correction from the two above —
// it says a refund was not a real return — and Ethan asked only for the draft
// orders. It is left visible rather than quietly bundled in.
// ============================================================================

var SEPF_SHEET_ID = '1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8';  // Sales Summary 2026

// The two tabs, and the ONLY thing that differs between them: how wide a store
// block is. Sales tabs stride 11, Net Profit strides 18 — but Sales sits at +1
// and Cost at +4 from the day column in both, which is why one figure list can
// serve both. Measured, not assumed: npProbe on 2026-08-26 for Net Profit, and
// mirror-fix.gs's map for Sales.
var SEPF_TARGETS = [
  { tab: 'Sales Sep 26',      bases: { OVL: 0, LEE: 11, WSP: 22, MPL: 33, BAL: 44 } },
  { tab: 'Net Profit Sep 26', bases: { OVL: 0, LEE: 18, WSP: 36, MPL: 54, BAL: 72 } }
];

var SEPF_COL_SALES   = 1;
var SEPF_COL_COST    = 4;
var SEPF_HEADER_ROWS = 4;

var SEPF_NOTE_0901_OVL =
  'Sep 1 restated — $166.98 of repayment draft orders removed (cost 25.01), AND the '
  + 'Marketplace Connect duplicate #KS01-14551 removed ($899.99 / $375.00 cost): eBay '
  + '11-15038-98055 already sold on Aug 16 as #KS01-13840. Deleting the copy did not take '
  + 'it out of the day. Real figure. Locked from the daily sync.';

var SEPF_FIX = [
  { store: 'OVL', day: 1, sales: 949.33, cost: 168.00, note: SEPF_NOTE_0901_OVL }
];

function sepFixPreview() { _sepfAll(true); }
function sepFixApply()   { _sepfAll(false); }

function _sepfAll(dryRun) {
  Logger.log(dryRun ? '=== PREVIEW — nothing will be written ===' : '=== APPLYING ===');
  var ss = SpreadsheetApp.openById(SEPF_SHEET_ID);
  var wrote = 0, already = 0, skipped = 0, missing = 0;
  for (var t = 0; t < SEPF_TARGETS.length; t++) {
    var r = _sepfRun(ss, SEPF_TARGETS[t], dryRun);
    wrote += r.wrote; already += r.already; skipped += r.skipped; missing += r.missing;
  }
  Logger.log('');
  Logger.log('%s: %s cell(s) across %s tab(s), %s already pinned, %s skipped',
             dryRun ? 'WOULD WRITE' : 'WROTE', wrote, SEPF_TARGETS.length, already, skipped);
  // ⚠️ A MISSING TAB IS NOT A QUIET SUCCESS. Half a restatement is worse than
  // none: the two sheets would disagree about the same day, and the run that
  // caused it would have logged "wrote 2 cells" and looked fine.
  if (missing) {
    Logger.log('!! %s tab(s) were not found — the restatement is INCOMPLETE and the two '
             + 'sheets now disagree about Sep 1. Fix the tab name and run it again.', missing);
  }
  if (dryRun) Logger.log('Nothing was written. Run sepFixApply() to write it.');
}

// The row is LOCATED by day number, never computed — the September grid is 30
// rows where August's was 31, and arithmetic off a header would be a row out.
function _sepfFindDayRow(values, base, day) {
  for (var r = SEPF_HEADER_ROWS; r < values.length; r++) {
    var first = String(values[r][0]).trim().toUpperCase();
    if (first === 'TTL' || first.indexOf('TRACKING') === 0) break;
    if (parseInt(values[r][base], 10) === day) return r;
  }
  return -1;
}

// The workbook's lock: a formula with no letters in it. The daily sync treats
// any formula as a deliberate lock and writes past nothing.
function _sepfIsBareNumber(f) {
  if (!f) return false;
  var body = String(f).replace(/^=/, '').trim();
  if (!body || /[A-Za-z]/.test(body)) return false;
  var ALLOWED = '0123456789 .,+-*/()';
  for (var i = 0; i < body.length; i++) if (ALLOWED.indexOf(body.charAt(i)) < 0) return false;
  return true;
}

function _sepfRun(ss, target, dryRun) {
  var out = { wrote: 0, already: 0, skipped: 0, missing: 0 };
  var sh = ss.getSheetByName(target.tab);
  Logger.log('');
  if (!sh) {
    Logger.log('tab: %s — NOT FOUND, nothing done here', target.tab);
    out.missing = 1;
    return out;
  }
  Logger.log('tab: %s', target.tab);

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();

  for (var i = 0; i < SEPF_FIX.length; i++) {
    var f = SEPF_FIX[i];
    var base = target.bases[f.store];
    var r = _sepfFindDayRow(values, base, f.day);
    if (r < 0) { Logger.log('  %s day %s: ROW NOT FOUND, skipped', f.store, f.day); out.skipped++; continue; }

    var pairs = [
      { col: base + SEPF_COL_SALES, want: f.sales, what: 'sales' },
      { col: base + SEPF_COL_COST,  want: f.cost,  what: 'cost'  }
    ];
    for (var p = 0; p < pairs.length; p++) {
      var c = pairs[p].col, want = pairs[p].want;
      var cur = values[r][c], curF = formulas[r][c];
      var a1 = _sepfA1(c) + (r + 1);

      // ⚠️ A REAL FORMULA IS SOMEBODY'S WORK, NOT A STALE FIGURE. Only a bare
      // number — ours or the workbook's own lock idiom — may be replaced.
      if (curF && !_sepfIsBareNumber(curF)) {
        Logger.log('  %s day %s %s @%s: LIVE FORMULA "%s" — left alone', f.store, f.day, pairs[p].what, a1, curF);
        out.skipped++;
        continue;
      }
      if (Math.abs(Number(cur) - want) < 0.005 && curF) {
        Logger.log('  %s day %s %s @%s: already pinned at %s', f.store, f.day, pairs[p].what, a1, want);
        out.already++;
        continue;
      }
      Logger.log('  %s day %s %s @%s: %s -> %s', f.store, f.day, pairs[p].what, a1,
                 (cur === '' ? '(blank)' : cur), want);
      if (!dryRun) {
        var rng = sh.getRange(r + 1, c + 1);
        rng.setFormula('=' + want.toFixed(2));
        rng.setNote(f.note);
      }
      out.wrote++;
    }
  }
  return out;
}

// 0-based column index -> A1 letter.
function _sepfA1(c) {
  var s = '', n = c + 1;
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m) / 26); }
  return s;
}
