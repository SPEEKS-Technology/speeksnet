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
//
// ---------------------------------------------------------------------------
// SEP 2 — OVL and MPL. Draft-order invoices only; no duplicate this day.
//
// Both detectors were run first and agree the day is clean: dupe-open-pairs
// over every paid order since Aug 1 (2,929 scanned, 494 eBay ids at OVL alone)
// found ZERO open pairs, and ebay-alert's check #7 reported no issues. The Sep 1
// duplicate was a one-off, and its twin was an AUG 16 order — which is why the
// scan window starts a month back rather than at the incident. A window that
// only covers the new copy cannot see the old one, and MC back-fills backwards.
//
//   OVL  reported 6,453.72 / 3,129.07 cost
//        − drafts  −459.97 /  −245.00   = 5,993.75 / 2,884.07
//
// Three of OVL's four match a refund we made (#KS01-14564 229.99, #KS01-14575
// 199.99, #KS01-14581 29.99); the fourth, #KS01-14562, is worth 0.00 and moves
// nothing either way. LEE, WSP and BAL had no draft orders on Sep 2.
//
// ⚠️ MPL WAS ALSO PINNED HERE AND NO LONGER IS. #MO03-3217 (229.99 / 100.00)
// matched no refund MPL ever made — flagged at the time as corroborated by the
// date rule alone — and it was CANCELLED the next day. It was an ordinary
// invoiced sale. See "SEP 2 — MPL'S PIN IS WRONG" below: the row is gone and
// the cell has to be UNPINNED, which is a separate action from deleting it.
//
// ⚠️ MPL's +$99.99 mirror-back refund is NOT included, on the same reasoning as
// WSP's Sep 1 above: sales-true-daily would put MPL at 3,157.32, but that folds
// a refund judgment into a draft-order correction. Drafts only, as asked.
//
// ---------------------------------------------------------------------------
// ⚠️ THE RULE CHANGED ON 2026-09-06, AND SEP 2 AND SEP 4 MOVE BECAUSE OF IT.
//
// Ethan, stating the goal plainly: "I just want every store to accurately show
// what they sold each day excluding draft orders we sent to customers to get
// money back from the ebay glitch as those aren't real sales."
//
// That is NARROWER than the rule the pins above were built on. From Aug 27 the
// test was the DATE alone — every draft from Aug 26 came out — because at that
// point every draft going out was a repayment and the stores said so. Real
// draft sales have now resumed, so the date alone strips them:
//
//   LEE #MO01-9401  Sep 3  1,749.99, cost 1,200.00, matches no refund LEE made
//   MPL #MO03-3217  Sep 2    229.99, cost   100.00, matches no refund, and was
//                            CANCELLED the next day
//
// A repayment invoice has no cost of goods behind it — the customer is handing
// money back, not taking an item. Both of those carry real inventory. And a
// customer paying money back does not cancel.
//
// So sales-true-daily now requires BOTH the date AND an amount that equals an
// eBay order total we actually refunded at that store, from Sep 1 onward. Late
// August deliberately keeps the date rule: the stores confirmed order by order
// what they invoiced in that window, including LEE #MO01-9161 ($1,549.99) which
// matched nothing either, and their own account outranks this test.
//
// Replayed over every draft found Aug 31 - Sep 6, the new rule changes exactly
// three verdicts and leaves the other twelve alone:
//
//   LEE #MO01-9401 (1,749.99)  strip -> KEEP   a real sale
//   MPL #MO03-3217 (  229.99)  strip -> KEEP   a real sale
//   OVL #KS01-14562 (    0.00) strip -> KEEP   worth nothing either way
//
// ---------------------------------------------------------------------------
// SEP 2 — MPL'S PIN IS WRONG AND IS BEING REMOVED, NOT CORRECTED.
//
// #MO03-3217 was an ordinary invoiced sale that the customer cancelled on Sep 3.
// Under the rule above it should never have come out of Sep 2. Both days are
// then right exactly as Shopify reports them: the sale on Sep 2, its reversal
// on Sep 3, and nothing to pin on either.
//
// ⚠️ DELETING THE ROW FROM SEPF_FIX DOES NOT UNPIN THE CELL. sepFixApply wrote
// "=3057.33" into it, and a bare-number formula is precisely what locks a cell
// FROM the daily sync — that is the whole mechanism. Removing it from the list
// only stops it being rewritten; the stale pin sits there forever. The cell has
// to be CLEARED so the sync can refill it, which is what SEPF_UNPIN and
// sepFixUnpinApply() below are for. Run that once, then the row is gone.
//
//   MPL Sep 2 goes back to 3,287.32 / 1,341.66, as reported.
//
// ---------------------------------------------------------------------------
// SEP 3 — LEE IS NOT RESTATED, AND THAT IS THE ANSWER, NOT AN OMISSION.
//
// #MO01-9401 ($1,749.99, cost $1,200.00) is a real invoiced sale. It stays in
// the day and LEE's Sep 3 stands as reported. Recorded here because the earlier
// date-only rule flagged it as a repayment, and the next sweep must not
// "discover" it again.
//
// BAL's Sep 3 carries a -$549.99 Draft Orders figure and is also left alone: it
// is the refund of #MO04-2607, a draft sale from AUG 14 — before the repayment
// window opened — so it was an ordinary sale and its return is genuine.
//
// ⚠️ WSP's Sep 3 carries $769.97 of adjustment-only refunds (#MO02-6508 649.99,
// #MO02-6697 49.99, #MO02-6828 69.99) — refunds with no line items, which
// Shopify counts in the day's returns and the per-order pass cannot price. They
// are left in, which is the safe direction, but the day is NOT fully reconciled
// and should not be pinned on this derivation.
//
// ---------------------------------------------------------------------------
// SEP 4 — OVL only. Three repayment invoices, all three corroborated.
//
//   OVL  reported 9,658.27 / 4,714.75 cost
//        − drafts  −334.97 /  −170.00   = 9,323.30 / 4,544.75
//
// #KS01-14625 (64.99), #KS01-14628 (44.99) and #KS01-14631 (224.99). Every one
// matches an eBay order total OVL actually refunded, so the date rule and the
// amount test agree — these are the glitch repayments, and the best-evidenced
// removal in this file.
//
// OVL is the only store still receiving them: 12 of its 13 drafts from Aug 31
// to Sep 4 match a refund we made, and the thirteenth is worth $0.00. LEE, WSP,
// MPL and BAL had no drafts on Sep 4.
//
// ---------------------------------------------------------------------------
// ⚠️ HOW TO RUN THE CHECK, BECAUSE A ONE-DAY QUERY LIES.
//
// Shopify's order search takes `created_at` in UTC while the day belongs to the
// store's own Chicago calendar, so a single-day window actually covers 7pm the
// night before to 7pm that evening. Run for Sep 5 alone, sales-true-daily
// reported ZERO drafts everywhere while its own sourceName census showed
// shopify_draft_order at OVL and LEE — those were SEP 4's, dragged in by the
// UTC edge, and Sep 5's own evening sat outside the window entirely.
//
// Query a day either side of the one you mean to restate and read the per-day
// rows. The ShopifyQL channel split (`all_draft_orders_channel`) is the
// independent check: it groups by day in the store's own calendar, so when the
// per-order pass and the channel figure agree the day is settled.
//
// ---------------------------------------------------------------------------
// SEP 5 — NOTHING TO DO, AND THAT IS A RESULT, NOT A GAP.
//
// Checked 2026-09-06 over 2026-09-03..06. All five stores: zero draft orders on
// the per-order pass AND 0.00 on the Draft Orders channel, zero mirror-back
// add-backs, zero duplicate refunds. Reported equals true at every store, so no
// cell is written and September 5 stays live on the daily sync.
//
// ⚠️ LEE'S SEP 5 DOES NOT RECONCILE, though it needs no change. Shopify reports
// $1,236.00 of returns for the day while the per-order pass found no refunds at
// all and no adjustment-only refunds either — a residual with nothing attached
// to it. Nothing draft-related touched LEE that day (its Draft Orders channel
// is 0.00), so the drafts answer is still no; but if LEE's Sep 5 is ever
// restated for another reason, that $1,236 has to be explained first.
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

var SEPF_NOTE_0902_OVL =
  'Sep 2 restated — $459.97 of draft-order invoices removed (cost 245.00): #KS01-14564 '
  + '(229.99), #KS01-14575 (199.99), #KS01-14581 (29.99) and #KS01-14562 (0.00). Repayment '
  + 'of the August glitch, not selling. Real figure. Locked from the daily sync.';

var SEPF_NOTE_0904_OVL =
  'Sep 4 restated — $334.97 of draft-order invoices removed (cost 170.00): #KS01-14625 '
  + '(64.99), #KS01-14628 (44.99) and #KS01-14631 (224.99). Every one matches an eBay order '
  + 'total OVL actually refunded, so these are glitch repayments rather than selling — the '
  + 'date rule and the amount test both agree. Real figure. Locked from the daily sync.';

var SEPF_FIX = [
  { store: 'OVL', day: 1, sales:  949.33, cost:  168.00, note: SEPF_NOTE_0901_OVL },
  { store: 'OVL', day: 2, sales: 5993.75, cost: 2884.07, note: SEPF_NOTE_0902_OVL },
  { store: 'OVL', day: 4, sales: 9323.30, cost: 4544.75, note: SEPF_NOTE_0904_OVL }
  // MPL Sep 2: pin REMOVED — an ordinary sale, not a repayment. It is in
  //   SEPF_UNPIN below, because deleting the row does not clear the cell.
  // LEE Sep 3: #MO01-9401 is a real sale and stays in. No row, on purpose.
  // Sep 5: checked 2026-09-06, clean at all five stores. No rows, on purpose.
];

// ---------------------------------------------------------------------------
// UNPINNING — the other half of changing our mind, and the half that is easy
// to forget.
//
// The lock IS the bare-number formula. Taking a row out of SEPF_FIX only stops
// it being re-written; the "=3057.33" already in the cell keeps the daily sync
// out of that day forever, and the sheet goes on showing a figure no list
// explains. So a withdrawn restatement has to CLEAR the cell, note and all, and
// let the sync refill it on its next pass.
//
// `was` is the figure we expect to find. It is checked before anything is
// cleared: if the cell holds something else, somebody has moved it since and
// this refuses rather than discarding their work.
// ⚠️ THE SEP 3 ROWS ARE HERE BECAUSE THIS FILE ALREADY MADE THE MISTAKE IT
// WARNS ABOUT. On 2026-09-06 an earlier draft of SEPF_FIX carried LEE day 3,
// MPL day 3 and OVL day 4, and sepFixApply wrote all three. The rule then
// changed, LEE and MPL came off the list — and their CELLS stayed locked,
// showing figures that no list in this file explains any more. MPL day 3 was
// found reading 5,293.66 against a reported 5,063.67, which is the add-back
// that the new rule says should never have happened.
//
// That is the whole hazard in one incident: a list is not a state. Removing a
// row changes what will be written next time; it changes nothing about what was
// written last time. Every withdrawn restatement needs a row HERE too.
var SEPF_UNPIN = [
  { store: 'MPL', day: 2, sales: 3057.33, cost: 1241.66,
    why: '#MO03-3217 was an ordinary invoiced sale, cancelled the next day — not a glitch '
       + 'repayment. Sep 2 goes back to 3,287.32 / 1,341.66 as reported.' },
  { store: 'MPL', day: 3, sales: 5293.66, cost: 2120.61,
    why: 'the +229.99 / +100.00 add-back for #MO03-3217\'s cancellation. With Sep 2 keeping '
       + 'the sale, Sep 3 correctly keeps the reversal and needs no correction at all. '
       + 'Sep 3 goes back to 5,063.67 / 2,020.61 as reported.' },
  // ⚠️ THIS ONE IS INERT AND IS KEPT ON PURPOSE. Verified 2026-09-06: LEE day 3
  // was never pinned — it holds 3,175.80 / 2,014.74, the reported figure, on
  // both tabs. The row stays as a standing guard: if the 1,425.81 restatement
  // is ever applied by an older copy of this file, the next unpin run removes
  // it instead of leaving a real sale stripped out of LEE's day.
  { store: 'LEE', day: 3, sales: 1425.81, cost:  814.74,
    why: '#MO01-9401 (1,749.99 / 1,200.00) is a real invoiced sale, not a glitch repayment — '
       + 'it matches no refund LEE ever made and carries real inventory. Sep 3 goes back to '
       + '3,175.80 / 2,014.74 as reported.' }
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
             + 'sheets now disagree about the restated day(s). Fix the tab name and run it again.',
             missing);
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

// ============================================================================
// sepFixUnpinPreview() / sepFixUnpinApply() — give a day back to the daily sync.
//
// Clears the cell and its note on BOTH tabs, for the same reason sepFixApply
// writes both: a day restated on one tab and not the other leaves two sheets
// disagreeing, and so does a day unpinned on one tab and not the other.
//
// ⚠️ IT REFUSES ANYTHING IT DOES NOT RECOGNISE. Three guards, and each one has
// already been the difference between a fix and a loss somewhere in this
// workbook:
//   * not a formula at all      — the sync already owns it, nothing to undo
//   * a LETTER-BEARING formula  — somebody's work, never ours
//   * a bare number that is not `was` — the figure moved after we pinned it,
//     so clearing it would throw away a correction we cannot see
// ============================================================================
function sepFixUnpinPreview() { _sepfUnpinAll(true); }
function sepFixUnpinApply()   { _sepfUnpinAll(false); }

function _sepfUnpinAll(dryRun) {
  Logger.log(dryRun ? '=== UNPIN PREVIEW — nothing will be cleared ==='
                    : '=== UNPINNING ===');
  if (!SEPF_UNPIN.length) { Logger.log('SEPF_UNPIN is empty — nothing to do.'); return; }

  var ss = SpreadsheetApp.openById(SEPF_SHEET_ID);
  var cleared = 0, already = 0, refused = 0, missing = 0;

  for (var t = 0; t < SEPF_TARGETS.length; t++) {
    var target = SEPF_TARGETS[t];
    var sh = ss.getSheetByName(target.tab);
    Logger.log('');
    if (!sh) {
      Logger.log('tab: %s — NOT FOUND, nothing done here', target.tab);
      missing++;
      continue;
    }
    Logger.log('tab: %s', target.tab);

    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
    var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();

    for (var i = 0; i < SEPF_UNPIN.length; i++) {
      var u = SEPF_UNPIN[i];
      var base = target.bases[u.store];
      var r = _sepfFindDayRow(values, base, u.day);
      if (r < 0) { Logger.log('  %s day %s: ROW NOT FOUND, skipped', u.store, u.day); refused++; continue; }
      // The reason travels with the run. An unpin leaves nothing behind on the
      // cell — that is the point of it — so the log is the only record of why
      // a pinned day stopped being pinned.
      Logger.log('  %s day %s: %s', u.store, u.day, u.why);

      var pairs = [
        { col: base + SEPF_COL_SALES, was: u.sales, what: 'sales' },
        { col: base + SEPF_COL_COST,  was: u.cost,  what: 'cost'  }
      ];
      for (var p = 0; p < pairs.length; p++) {
        var c = pairs[p].col, was = pairs[p].was;
        var cur = values[r][c], curF = formulas[r][c];
        var a1 = _sepfA1(c) + (r + 1);

        if (!curF) {
          Logger.log('  %s day %s %s @%s: not pinned (holds %s) — already the sync\'s',
                     u.store, u.day, pairs[p].what, a1, (cur === '' ? '(blank)' : cur));
          already++;
          continue;
        }
        if (!_sepfIsBareNumber(curF)) {
          Logger.log('  %s day %s %s @%s: LIVE FORMULA "%s" — left alone',
                     u.store, u.day, pairs[p].what, a1, curF);
          refused++;
          continue;
        }
        if (Math.abs(Number(cur) - was) >= 0.005) {
          Logger.log('  !! %s day %s %s @%s: pinned at %s, expected %s — REFUSED. Somebody '
                   + 'restated this after we did; clearing it would discard their figure.',
                     u.store, u.day, pairs[p].what, a1, cur, was);
          refused++;
          continue;
        }
        Logger.log('  %s day %s %s @%s: %s -> (cleared, back to the daily sync)',
                   u.store, u.day, pairs[p].what, a1, cur);
        if (!dryRun) {
          var rng = sh.getRange(r + 1, c + 1);
          rng.clearContent();
          rng.clearNote();
        }
        cleared++;
      }
    }
  }

  Logger.log('');
  Logger.log('%s: %s cell(s), %s already unpinned, %s refused',
             dryRun ? 'WOULD CLEAR' : 'CLEARED', cleared, already, refused);
  // Same reasoning as _sepfAll: half an unpin is two sheets disagreeing.
  if (missing) {
    Logger.log('!! %s tab(s) were not found — the unpin is INCOMPLETE and the two sheets now '
             + 'disagree about the affected day(s). Fix the tab name and run it again.', missing);
  }
  // ⚠️ A CLEARED CELL IS EMPTY UNTIL THE SYNC NEXT RUNS, and an empty Sales cell
  // reads as zero to the tab's own formulas. Say so, rather than leaving someone
  // to notice a store apparently sold nothing that day.
  if (!dryRun && cleared) {
    Logger.log('These cells are BLANK until the next daily sync refills them. Run the '
             + 'importer (or wait for the 8am pass) before reading the day.');
  }
  if (dryRun) Logger.log('Nothing was cleared. Run sepFixUnpinApply() to clear it.');
}

// ============================================================================
// sepFixAudit() — READ-ONLY. What is actually pinned, and what is missing.
//
// Writes nothing. Answers one question the two lists above cannot: what does
// the WORKBOOK hold right now? SEPF_FIX says what should be pinned and
// SEPF_UNPIN says what should not, but neither is evidence — the 2026-09-06
// incident happened precisely because a cell held a figure that no list
// explained any more, and nothing would have told anyone.
//
// So this walks every store, every day, on both tabs, and sorts what it finds:
//
//   OK       a pin that SEPF_FIX asks for, at the value it asks for
//   WRONG    a pin SEPF_FIX asks for, holding a DIFFERENT figure
//   STRAY    a pin no list explains — the 2026-09-06 fault, by name
//   MISSING  SEPF_FIX asks for it and the cell is not pinned at all
//   BLANK    a day that has passed with an empty Sales cell, which reads as
//            ZERO to every formula on the tab and breaks the SUM chain below it
//
// Run it before and after any restatement. A clean run is five zeros and a
// list of the pins you meant to have.
// ============================================================================
var SEPF_AUDIT_STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];

function sepFixAudit() {
  Logger.log('=== PIN AUDIT — read-only, nothing is written ===');
  var ss = SpreadsheetApp.openById(SEPF_SHEET_ID);

  var want = {};
  for (var i = 0; i < SEPF_FIX.length; i++) {
    want[SEPF_FIX[i].store + '#' + SEPF_FIX[i].day] = SEPF_FIX[i];
  }

  var nOk = 0, nWrong = 0, nStray = 0, nMissing = 0, nBlank = 0;

  for (var t = 0; t < SEPF_TARGETS.length; t++) {
    var target = SEPF_TARGETS[t];
    var sh = ss.getSheetByName(target.tab);
    Logger.log('');
    if (!sh) { Logger.log('tab: %s — NOT FOUND', target.tab); continue; }
    Logger.log('--- %s ---', target.tab);

    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
    var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();

    // Days Thru, derived the same way the Net Profit tab derives it: the last
    // day any store carries Sales. A blank BELOW that is a hole; a blank above
    // it is simply a day that has not happened.
    var thru = 0;
    for (var s0 = 0; s0 < SEPF_AUDIT_STORES.length; s0++) {
      var b0 = target.bases[SEPF_AUDIT_STORES[s0]];
      for (var d0 = 1; d0 <= 31; d0++) {
        var r0 = _sepfFindDayRow(values, b0, d0);
        if (r0 < 0) continue;
        var v0 = values[r0][b0 + SEPF_COL_SALES];
        if (v0 !== '' && v0 !== null && d0 > thru) thru = d0;
      }
    }
    Logger.log('  days with data through: %s', thru);

    for (var s = 0; s < SEPF_AUDIT_STORES.length; s++) {
      var st = SEPF_AUDIT_STORES[s], base = target.bases[st];
      for (var day = 1; day <= 31; day++) {
        var r = _sepfFindDayRow(values, base, day);
        if (r < 0) continue;

        var exp = want[st + '#' + day] || null;
        var pairs = [
          { col: base + SEPF_COL_SALES, want: exp ? exp.sales : null, what: 'sales' },
          { col: base + SEPF_COL_COST,  want: exp ? exp.cost  : null, what: 'cost'  }
        ];
        for (var p = 0; p < pairs.length; p++) {
          var c = pairs[p].col, cur = values[r][c], curF = formulas[r][c];
          var a1 = _sepfA1(c) + (r + 1);
          var pinned = !!curF && _sepfIsBareNumber(curF);

          if (pinned && exp) {
            if (Math.abs(Number(cur) - pairs[p].want) < 0.005) {
              Logger.log('  OK      %s day %s %s @%s = %s', st, day, pairs[p].what, a1, cur);
              nOk++;
            } else {
              Logger.log('  WRONG   %s day %s %s @%s = %s, SEPF_FIX says %s',
                         st, day, pairs[p].what, a1, cur, pairs[p].want);
              nWrong++;
            }
          } else if (pinned) {
            Logger.log('  STRAY   %s day %s %s @%s = %s — pinned, but no row in SEPF_FIX '
                     + 'explains it. Either add one or put it in SEPF_UNPIN.',
                       st, day, pairs[p].what, a1, cur);
            nStray++;
          } else if (exp) {
            Logger.log('  MISSING %s day %s %s @%s: SEPF_FIX says %s but the cell is not '
                     + 'pinned (holds %s)', st, day, pairs[p].what, a1, pairs[p].want,
                       (cur === '' ? '(blank)' : cur));
            nMissing++;
          } else if (pairs[p].what === 'sales' && day <= thru && (cur === '' || cur === null)) {
            Logger.log('  BLANK   %s day %s sales @%s — the day has passed and the cell is '
                     + 'empty. Reads as ZERO and breaks the running total below it.',
                       st, day, a1);
            nBlank++;
          }
        }
      }
    }
  }

  Logger.log('');
  Logger.log('=== %s OK, %s WRONG, %s STRAY, %s MISSING, %s BLANK ===',
             nOk, nWrong, nStray, nMissing, nBlank);
  if (!nWrong && !nStray && !nMissing && !nBlank) {
    Logger.log('Clean. Every pin is one this file asks for, and no day is a hole.');
  } else {
    Logger.log('Not clean. WRONG/STRAY need a SEPF_UNPIN row or a SEPF_FIX row; MISSING '
             + 'needs sepFixApply(); BLANK needs the importer run.');
  }
}

// 0-based column index -> A1 letter.
function _sepfA1(c) {
  var s = '', n = c + 1;
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m) / 26); }
  return s;
}
