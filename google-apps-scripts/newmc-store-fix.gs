// ============================================================================
// newmc-store-fix.gs — restore the real daily figures for each store as it moves
// onto PayMore new Marketplace Connect and its adoption duplicates that store
// Shopify orders. MPL and BAL are done; add each further store as it moves.
//
// THIS IS A DIFFERENT INCIDENT FROM mpc-dupe-fix.gs. That one covers Aug 16-20
// (the 2026-08-20 MC back-fill). This one covers Aug 22-23 (the 2026-08-24
// transition). Separate file, separate prefix, separate note text, so neither
// can clear or overwrite the other's work.
//
// ---------------------------------------------------------------------------
// WHY THESE DAYS ARE WRONG, AND WHY IT IS URGENT
// ---------------------------------------------------------------------------
// On 2026-08-24 the new system re-imported eBay sales that SPEEKS Connect had
// already imported: 22 phantoms at MPL, 18 at BAL, 81 at LEE. The duplicate orders were
// CREATED on Aug 24 — but Shopify's sales dataset attributes their revenue to the
// ORIGINAL SALE DAY, so the money landed on Aug 20, 21, 22 and 23. Every phantom
// has since been refunded, and a refund is credited to the REFUND day, so the
// whole reversal sits on Aug 24.
//
// Net effect: Aug 22 and Aug 23 are OVERSTATED in Shopify and will stay that way.
//
// A phantom is an order the new system created (tagged only "eBay", no
// ebay-<id> tag) for which one of OURS exists on the same day for the same
// item. TRUE = the day total with every phantom order removed entirely -- which
// takes out both its backdated sale and its Aug 24 refund credit, so the same
// rule gives the right answer on every day including Aug 24.
//
//   MPL   Shopify shows        phantom in it      TRUE
//   Aug 20  -2324.86 / -1038.01   1043.94 /  403.00   (see note below)
//   Aug 21   4018.86 /  1647.00      0.00 /    0.00   clean, no phantom
//   Aug 22   9712.97 /  4242.99   3844.91 / 1706.90   5868.06 / 2536.09  <-- fix
//   Aug 23   5356.80 /  2263.80   1820.94 /  720.40   3535.86 / 1543.40  <-- fix
//   Aug 24     moving             (9 phantoms)        re-derive tomorrow
//
//   BAL   Shopify shows        phantom in it      TRUE
//   Aug 20  -6757.77 / -2551.75    394.96 /  193.00   (see note below)
//   Aug 21   1569.35 /   710.01    364.97 /  159.00   1204.38 /  551.01  <-- fix
//   Aug 22   3843.89 /  1601.00   1724.96 /  710.00   2118.93 /  891.00  <-- fix
//   Aug 23   4124.08 /  1801.01   1744.94 /  693.00   2379.14 / 1108.01  <-- fix
//   Aug 24     moving             (18 phantoms)       re-derive tomorrow
//
//   LEE   Shopify shows        TRUE                 phantoms
//   Aug 16   8243.35            5716.50 / 2236.49     14   <-- fix
//   Aug 17   2684.80            2612.83 / 1138.00      3   <-- fix
//   Aug 18   6794.43            5392.50 / 2261.36      7   <-- fix
//   Aug 19   6797.50            4775.67 / 1988.92     11   <-- fix
//   Aug 20   8686.85            5301.95 / 2367.63     10   <-- fix
//   Aug 21   8312.68            6122.77 / 2996.32      8   <-- fix
//   Aug 22   8859.64            4904.82 / 2051.50     17   <-- fix
//   Aug 23   4401.52            3074.61 / 1603.89      9   <-- fix
//   Aug 24     moving           re-derive tomorrow    81 rows land here
//
// Three of BAL's six cells already hold the right value; they are in the list
// anyway, because an unlocked cell is what tomorrow's import overwrites.
//
// ⚠️ THE SHEET IS PROBABLY STILL CORRECT AS YOU READ THIS, AND THAT IS THE
// PROBLEM. The duplicates were created around 10am Central, AFTER the Aug 24
// 06:00 daily email was sent — so this morning's import carried the true Aug 22
// and Aug 23 figures. The Shopify daily report is a MONTH-TO-DATE RESTATEMENT and
// the importer re-verifies a rolling window every run, so TOMORROW's 06:00 email
// will restate Aug 22 and Aug 23 with the phantoms included and silently replace
// two good days. That is exactly how four good days were lost on Aug 21.
//
// So this is preventive: locking the true figures in before the next import is
// what stops them being overwritten. Run it TODAY.
//
// ---------------------------------------------------------------------------
// AUG 20 IS DELIBERATELY NOT IN THE LIST
// ---------------------------------------------------------------------------
// mpc-dupe-fix.gs already locked MPL Aug 20 at 3102.89 / 1277.75. That figure was
// derived on Aug 21, BEFORE these phantoms existed, so it is the true Aug 20 and
// needs no change — and because it is a bare-number formula the importer will not
// overwrite it. Shopify's own Aug 20 reads -3368.80 once the new phantoms come
// out, because last week's refund credits landed there; that is expected and is
// NOT what the sheet should say. Leave it alone.
//
// WHICH DAYS ARE HIT DIFFERS PER STORE. MPL Aug 21 has zero phantom
// involvement, so the importer figure is right there. BAL Aug 21 IS hit and is
// in the list. Derive the days for every store; never copy another store range.
//
// ---------------------------------------------------------------------------
// WSP AUG 15 — A COST GAP THAT IS CORRECT AND ALREADY PROTECTED. LEAVE IT.
// ---------------------------------------------------------------------------
// WSP Aug 15 sales agree with Shopify to the cent; the COST is 900.00 higher
// (sheet 2846.25, Shopify 1946.25) with ZERO phantom orders that day.
//
// RESOLVED 2026-08-25 (Ethan): order #MO02-6574 (1,999.99) was a DIRECTLY LISTED
// eBay item, so Shopify never had a cost for it — it reports
// cost_of_goods_sold 0 and always did. The 900.00 is a deliberate hardcoded cost
// in the sheet, entered by hand to account for exactly that. **The sheet is
// right and Shopify is the incomplete record here.**
//
// Confirmed independently: the importer re-verifies REVERIFY = 32 days on every
// run (sales-email-import.gs), so Aug 15 has been inside the window every single
// morning since it happened — and the cell still reads 2846.25. It could only
// have survived that if it is already formula-protected. Nothing to do.
//
// ⚠️ SO DO NOT ADD A WSP AUG 15 ROW. Writing the derived 1946.25 would overwrite
// a hand-entered correct figure with an incomplete one — the exact inverse of
// what every other row in NMC_FIX does.
//
// GENERAL RULE THIS ESTABLISHES: sales match + cost does not + no phantom on that
// day  ⇒  it is NOT a duplicate. Look for an order with revenue and
// cost_of_goods_sold 0, and expect a directly-listed eBay item with a hardcoded
// cost behind it. Shopify's cost is not authoritative for those.
//
// ---------------------------------------------------------------------------
// AUG 24 — DONE, 2026-08-25
// ---------------------------------------------------------------------------
// Aug 24 carried the ENTIRE reversal for each store. It is now complete and its
// three rows are in NMC_FIX below, so each August month total is whole again.
//
// ⚠️ DO NOT USE THE MIDDAY ESTIMATES THIS FILE CARRIED YESTERDAY. Every one of
// them was wrong by thousands, because the day was still trading — MPL read
// 957.59 midday and finished at 9756.42, and BAL was predicted NEGATIVE and
// finished at +3377.72 on the back of one 2949.99 sale that landed at 12:59pm.
// A part-day figure is not a small error on a final one; it is a different
// number. Re-derive after midnight, always.
//
// ---------------------------------------------------------------------------
// HOW TO RUN — no deployment, this is a Run-from-the-editor script
// ---------------------------------------------------------------------------
//   1. Paste this file into the Sales Summary Apps Script project as its own file.
//   2. Run `nmcFixPreview` and authorise. It writes NOTHING. Read the log: every
//      cell, what it holds now, what it would become.
//   3. Happy → run `nmcFixApply`. Idempotent; running it twice changes nothing.
//   4. Next month only: the rollover copies notes forward, so September's tab
//      inherits these notes on its own 22nd/23rd where they mean nothing. Run
//      `nmcClearCarriedNotes` once after the 1st.
//
// Prefixed NMC_/_nmc throughout: one Apps Script project is one global scope, and
// a collision with mpc-dupe-fix.gs, sales-email-import.gs or month-rollover.gs
// would silently read a different geometry.
// ============================================================================

var NMC_SHEET_ID = '1i_oV37lZXq8s91f9ymzwQlrM8WY2UlQQQ0qsRP3xLJ8';  // Sales Summary 2026
var NMC_TAB      = 'Sales Aug 26';

// Same geometry as the importer, restated here rather than imported: this file
// must be safe to paste into a project on its own.
var NMC_BASES       = { OVL: 0, LEE: 11, WSP: 22, MPL: 33, BAL: 44 };
var NMC_COL_SALES   = 1;   // base + 1
var NMC_COL_COST    = 4;   // base + 4
var NMC_HEADER_ROWS = 4;   // day rows start here; the row is still LOCATED by day

// Distinct from MPC_NOTE on purpose — nmcClearCarriedNotes matches this exact
// string, so it can never strip the Aug 16-20 fix's notes, and mpcClearCarried-
// Notes can never strip these.
var NMC_NOTE = 'New-MC adoption dupe fix — real figure. Locked from the daily sync.';

// Sales = Shopify net_sales, Cost = COGS, both with the 22 duplicate orders
// removed by SHOPIFY'S OWN day attribution — not by ebay_orders.sold_at, which
// disagrees for back-dated copies. Same method that reproduced the pre-
// contamination email to the cent, 8 of 8, on the Aug 16-20 fix.
// ---------------------------------------------------------------------------
// VERIFIED AGAINST THE SHEET, 2026-08-24 11:16 (nmcFixPreview)
// ---------------------------------------------------------------------------
// Aug 23 held 3535.86 / 1543.4 -- IDENTICAL to the reconstruction, to the cent,
// derived independently. That is the proof the method is right: same standard as
// the Aug 16-20 fix, which reproduced the pre-contamination email 8 of 8.
//
// Aug 22 held 5818.07 / 2526.09, which is 49.99 / 10.00 BELOW the figure here.
// Fully explained, and it is not a missed duplicate: #MO03-3042 is a REAL eBay
// sale (20-15049-68792) that SPEEKS Connect never imported -- one Shopify copy
// only, absent from ebay_orders -- which the new system imported at 15:06 and
// Shopify correctly booked to its Aug 22 sale date. The 06:00 email predated it
// by five hours, so the sheet was stale rather than wrong.
//
//   5818.07 + 49.99 = 5868.06      2526.09 + 10.00 = 2536.09
//
// Re-checked for new duplicates at the same time: none. All 15 partially-refunded
// phantoms were already staged; the new system had created no further copies.
var NMC_FIX = [
  { store: 'MPL', day: 22, sales: 5868.06, cost: 2536.09 },
  { store: 'MPL', day: 23, sales: 3535.86, cost: 1543.40 },

  // BAL, added 2026-08-24. 18 phantom orders. 17 were refunded here (3584.83);
  // the 18th, #MO04-2844, was already refunded from outside this work. All are
  // reversed to net_sales 0 / cogs 0 and every one of ours is left intact.
  //
  // WARNING: BAL IS HIT ON AUG 21 AS WELL, WHICH MPL WAS NOT. Do not assume the
  // two stores share a day range -- derive each one.
  //
  // ⚠️ BAL AUG 22 IS 2118.93, NOT 2818.92. An earlier draft of this file said
  // 2818.92 / 1191.00 and that was WRONG -- it counted the phantom #MO04-2844
  // (699.99 / 300.00) as a real sale. Its twin #MO04-2807 was ALREADY REFUNDED
  // when the pairing ran, so the pairing treated our copy as absent and called
  // the phantom unique. Both carry SKU MO04-2012B-R5R3. The corrected figure
  // equals what the sheet already held, so Aug 22 needs the formula lock only.
  //
  // BAL Aug 20 is deliberately absent: mpc-dupe-fix.gs locked it at
  // 2461.83 / 1079.25 before these phantoms existed, so it is already true and
  // the formula lock protects it. Shopify reads BAL Aug 20 as -7152.73 once the
  // new phantoms come out, because last week refund credits landed there. That
  // is expected and is NOT what the sheet should say.
  { store: 'BAL', day: 21, sales: 1204.38, cost:  551.01 },
  { store: 'BAL', day: 22, sales: 2118.93, cost:  891.00 },   // see AUG 22 note
  { store: 'BAL', day: 23, sales: 2379.14, cost: 1108.01 },

  // LEE, added 2026-08-24. 81 phantom orders, 16939.10, all refunded here.
  //
  // ⚠️ LEE REACHES BACK TO AUG 16 -- FOUR DAYS FURTHER THAN MPL OR BAL. The new
  // system back-filled nine days at LEE, not three. This is the clearest proof
  // that the day range must be derived per store and never copied.
  //
  // ⚠️ AUG 16-20 ARE NOT PROTECTED AT LEE. mpc-dupe-fix.gs locked Aug 16-20 for
  // MPL and BAL only -- LEE was not in that incident, so those cells are bare
  // numbers the importer will happily restate tomorrow. They are in this list.
  { store: 'LEE', day: 16, sales: 5716.50, cost: 2236.49 },
  { store: 'LEE', day: 17, sales: 2612.83, cost: 1138.00 },
  { store: 'LEE', day: 18, sales: 5392.50, cost: 2261.36 },
  { store: 'LEE', day: 19, sales: 4775.67, cost: 1988.92 },
  { store: 'LEE', day: 20, sales: 5301.95, cost: 2367.63 },
  { store: 'LEE', day: 21, sales: 6122.77, cost: 2996.32 },
  { store: 'LEE', day: 22, sales: 4904.82, cost: 2051.50 },
  { store: 'LEE', day: 23, sales: 3074.61, cost: 1603.89 }

  // -------------------------------------------------------------------------
  // AUG 24, added 2026-08-25 — the day that carried every store's reversal.
  // -------------------------------------------------------------------------
  // Derived after midnight from the completed day, same rule as every row above:
  // the day total with every phantom order removed ENTIRELY, by Shopify's own day
  // attribution. Removing the order takes out both its backdated sale and its
  // Aug 24 refund credit at once, which is why one rule covers the reversal day.
  //
  // PROOF THE METHOD IS RIGHT: re-derived from scratch today, it reproduced all
  // 14 previously-locked days — every MPL, BAL and LEE figure in this file and in
  // mpc-dupe-fix.gs — to the cent, including BAL Aug 22's 2118.93 and LEE Aug 19's
  // 4775.67, the two that needed the #MO04-2844 / #MO01-9103 corrections.
  //
  // ⚠️ THE PHANTOM SET IS THE UNION OF TWO LISTS, NOT EITHER ONE ALONE.
  // dup_order_cleanup alone misses #MO04-2844 and #MO01-9103 (phantoms refunded
  // from outside this work, so never staged) and gets BAL Aug 22 and LEE Aug 19
  // wrong by 699.99 and 88.99. Tag-matching alone misses the 2026-08-20 old-MC
  // pairs whose own copy predates the search window. Use both.
  //
  // BAL's Aug 24 is POSITIVE after all — yesterday's note predicted a negative day.
  // It still carries three genuine returns (-699.99, -339.99, -124.99), two of them
  // real eBay buyer cancellations of our own Aug 22/24 sales. Those are real and
  // stay in.
  , { store: 'MPL', day: 24, sales: 9756.42, cost: 4115.00 }
  , { store: 'BAL', day: 24, sales: 3377.72, cost: 1084.00 }
  , { store: 'LEE', day: 24, sales: 7466.41, cost: 3585.55 }

  // -------------------------------------------------------------------------
  // WSP, added 2026-08-25 — the fourth store to move. NINE DAYS, Aug 16-24.
  // -------------------------------------------------------------------------
  // 44 phantom orders, 12,206.57 refunded (43 by dup-cleanup batch
  // wsp-new-mc-adoption-2026-08-25, 1 already reversed from outside this work).
  //
  // ⚠️ AT WSP THE FOREIGN COPIES CARRY THE **OLD** MC TAG VOCABULARY
  // (`eBay-US` + `paymore_westport`), NOT the bare `["eBay"]` seen at MPL, BAL
  // and LEE. 325 of WSP's 420 eBay orders are old-MC tagged and MOST ARE
  // LEGITIMATE — MC has always imported the sales for its own listings there.
  // So the tag does NOT identify a phantom at this store. What identifies one is
  // a SHARED eBay Order Id with a copy of ours, which is source-blind. Proof the
  // cutover is real and not a long-standing overlap: the earliest foreign copy of
  // one of our sales is 2026-08-24T17:27Z, and there are none before it.
  //
  // Verified before refunding: 0 foreign orders lack an eBay Order Id (so the id
  // test is complete), 0 duplicates carry a different tracking number from ours
  // (no buyer got two labels), and 7 foreign orders since the cutover have no
  // twin — genuine sales MC captured that we never did. Those stay in the books.
  //
  // ⚠️ AUG 15 IS DELIBERATELY NOT IN THIS LIST, AND MUST NEVER BE ADDED —
  // its cost is a hand-entered figure for a directly-listed eBay item.
  , { store: 'WSP', day: 16, sales: 6407.77, cost: 2270.01 }
  , { store: 'WSP', day: 17, sales: 5434.80, cost: 2822.00 }
  , { store: 'WSP', day: 18, sales: 7304.41, cost: 3195.98 }
  , { store: 'WSP', day: 19, sales: 3486.29, cost: 1630.45 }
  , { store: 'WSP', day: 20, sales: 8493.29, cost: 3206.48 }
  , { store: 'WSP', day: 21, sales: 1894.85, cost: 1140.01 }
  , { store: 'WSP', day: 22, sales: 3209.96, cost: 1990.00 }
  , { store: 'WSP', day: 23, sales:  696.92, cost:  202.14 }
  , { store: 'WSP', day: 24, sales: 4899.90, cost: 2724.69 }

  // -------------------------------------------------------------------------
  // OVL, added 2026-08-25 — the fifth and last store. TEN DAYS, Aug 15-24.
  // -------------------------------------------------------------------------
  // 173 phantom orders, 31,381.19 refunded (batch ovl-new-mc-adoption-2026-08-25),
  // 163 SKUs raised from negative to 0, and the 6 unfulfilled copies cancelled.
  //
  // ⚠️ EVERY VALUE HERE EXCEPT AUG 20 EQUALS WHAT THE SHEET ALREADY HOLDS, AND
  // THAT IS THE POINT. OVL's duplicates were created at 16:00Z today — AFTER this
  // morning's 06:00 import — so the sheet is still correct as this is written. It
  // is the NEXT import that restates these ten days with the phantom sales folded
  // in: refunding puts the credit on Aug 25, not back on the original sale day, so
  // Aug 15-24 would each come back overstated. These rows are therefore a FORMULA
  // LOCK on figures that are already right. An unlocked cell is what the next
  // import overwrites — a correct-but-unlocked day still needs the lock.
  //
  // ⚠️ AUG 20 IS 5762.17, NOT THE 5748.18 THE SHEET SHOWS — AND THE SHEET IS THE
  // ONE THAT IS WRONG. #KS01-14293 (13.99 net / 4.00 cost) is a GENUINE MC sale
  // with no copy of ours; it arrived at 16:06:56Z today and Shopify correctly
  // booked it to its Aug 20 sale date, five hours after the 06:00 email went out.
  // Stale, not contaminated. Exactly the #MO03-3042 case from the MPL Aug 22 note
  // above, so the direction of a mismatch has to be read before it is "corrected".
  //
  // ⚠️ OVL WAS THE ONE STORE WHERE THE ITEM-ID TEST LIED. All 66 published SKUs are
  // STILL live under OUR eBay item ids — MC adopted them IN PLACE rather than
  // relisting — so the check that proved the transition at MPL/BAL/LEE/WSP reads
  // "not transitioned" here and is a false negative. What proved it instead: MC has
  // imported copies of our sales spanning Aug 16-25 including one from today, and
  // 60 of 60 of our last-five-days sales are covered (the 2 apparent gaps were
  // cancelled+refunded buyer cancellations MC rightly skipped).
  , { store: 'OVL', day: 15, sales:  4404.11, cost: 1984.52 }
  , { store: 'OVL', day: 16, sales: 12640.40, cost: 5624.60 }
  , { store: 'OVL', day: 17, sales:  7692.73, cost: 3369.03 }
  , { store: 'OVL', day: 18, sales: 10419.95, cost: 6103.29 }
  , { store: 'OVL', day: 19, sales:  3666.62, cost: 1623.75 }
  , { store: 'OVL', day: 20, sales:  5762.17, cost: 2865.35 }   // +13.99 / +4.00 vs the sheet: a real sale, see above
  , { store: 'OVL', day: 21, sales:  7427.59, cost: 3381.90 }
  , { store: 'OVL', day: 22, sales:  4687.26, cost: 2098.31 }
  , { store: 'OVL', day: 23, sales:  1686.87, cost:  740.00 }
  , { store: 'OVL', day: 24, sales:  9764.29, cost: 5349.05 }
];

function nmcFixPreview() { _nmcRun(true); }
function nmcFixApply()   { _nmcRun(false); }

// Locate the row by matching the day number in the block's OWN date column —
// never by arithmetic from a start row. Somebody inserting a row above the grid
// would otherwise shift every write and corrupt a month silently.
function _nmcFindDayRow(values, base, day) {
  for (var r = NMC_HEADER_ROWS; r < values.length; r++) {
    var first = String(values[r][0]).trim().toUpperCase();
    if (first === 'TTL' || first.indexOf('TRACKING') === 0) break;   // past the day rows
    if (parseInt(values[r][base], 10) === day) return r;
  }
  return -1;
}

// Is this formula one of ours (or an existing bare-number lock)? Anything else is
// somebody's real calculation and must not be touched.
function _nmcIsBareNumber(f) {
  if (!f) return false;
  var body = String(f).replace(/^=/, '').trim();
  if (!body) return false;
  if (/[A-Za-z]/.test(body)) return false;
  var ALLOWED = '0123456789 .,+-*/()';
  for (var i = 0; i < body.length; i++) {
    if (ALLOWED.indexOf(body.charAt(i)) < 0) return false;
  }
  return true;
}

function _nmcRun(dryRun) {
  var ss = SpreadsheetApp.openById(NMC_SHEET_ID);
  var sh = ss.getSheetByName(NMC_TAB);
  if (!sh) { Logger.log('NO TAB NAMED "' + NMC_TAB + '" — nothing done.'); return; }

  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var values   = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var formulas = sh.getRange(1, 1, lastRow, lastCol).getFormulas();

  var wrote = 0, already = 0, refused = 0;
  Logger.log((dryRun ? '=== PREVIEW (nothing written) ===' : '=== APPLYING ===') + '  tab: ' + NMC_TAB);
  Logger.log('cell     store day  field  holds now            ->  becomes');

  NMC_FIX.forEach(function (f) {
    var base = NMC_BASES[f.store];
    if (base == null) { Logger.log('unknown store ' + f.store); refused++; return; }
    var r = _nmcFindDayRow(values, base, f.day);
    if (r < 0) { Logger.log('no row for ' + f.store + ' day ' + f.day); refused++; return; }

    [{ col: base + NMC_COL_SALES, label: 'sales', want: f.sales },
     { col: base + NMC_COL_COST,  label: 'cost',  want: f.cost }].forEach(function (c) {
      var rng  = sh.getRange(r + 1, c.col + 1);
      var a1   = rng.getA1Notation();
      var curF = (formulas[r] || [])[c.col] || '';
      var curV = (values[r] || [])[c.col];
      var want = '=' + c.want.toFixed(2);

      // A real formula (a reference or a function) is somebody's calculation.
      // Refuse, loudly, rather than replacing it with a literal.
      if (curF && !_nmcIsBareNumber(curF)) {
        Logger.log(_nmcPad(a1, 8) + _nmcPad(f.store, 6) + _nmcPad(f.day, 5) + _nmcPad(c.label, 7)
          + 'REFUSED — real formula ' + curF);
        refused++;
        return;
      }
      // ⚠️ COMPARE THE VALUE, NOT THE FORMULA STRING.
      // Sheets normalises a stored formula: "=1543.40" comes back as "=1543.4".
      // A string test therefore never matches, so the cell is rewritten on every
      // run, Sheets re-normalises it, and the script can never report clean --
      // which is exactly how a fix script stops being trusted. Seen live on
      // AL27 (MPL day 23 cost) after the first apply: correct value, reported as
      // still needing a write.
      //
      // Compares the cell VALUE, which Sheets has already computed, so it holds
      // for "=1543.4", "=1543.40" and a plain typed 1543.4 alike. Guarded on
      // blank, because Number("") is 0 and would read an empty cell as a match
      // for a wanted 0.
      var already_ok = (curV !== "" && curV !== null && curV !== undefined
                        && Math.abs(Number(curV) - c.want) < 0.005);
      if (already_ok && curF) {
        already++;
        return;   // right number AND locked as a formula: nothing to do
      }

      Logger.log(_nmcPad(a1, 8) + _nmcPad(f.store, 6) + _nmcPad(f.day, 5) + _nmcPad(c.label, 7)
        + _nmcPad(curF ? curF + ' (locked)' : String(curV), 20) + ' ->  ' + want);
      if (!dryRun) {
        rng.setFormula(want);
        rng.setNote(NMC_NOTE);
      }
      wrote++;
    });
  });

  Logger.log('---');
  Logger.log((dryRun ? 'WOULD write ' : 'wrote ') + wrote + ' cell(s); '
    + already + ' already correct; ' + refused + ' refused.');
  if (dryRun) {
    Logger.log('Nothing was changed. Run nmcFixApply to write it.');
  } else {
    Logger.log('Done. The daily import will now skip these cells and say so '
      + '(deliberate: true, "cell holds a formula").');
    Logger.log('Aug 15-24 are now locked at their true figures for all five stores.');
    Logger.log('NEXT: AUG 25 IS NOT DONE AND IT IS THE BIGGEST ONE. Every refund '
      + 'issued on 2026-08-25 credits to Aug 25, not to the original sale day, so '
      + 'that day currently reads far below what the stores actually did:');
    Logger.log('   OVL 173 refunds  -31,381.19   |   WSP 43 refunds  -12,206.57');
    Logger.log('   LEE  1 refund       -539.99   |   MPL  1 refund       -389.99');
    Logger.log('   = -44,517.74 of reversal sitting on one day across four stores.');
    Logger.log('Once Aug 25 is final, derive each store the same way (day total with '
      + 'every phantom order removed entirely) and add four rows. BAL had no refunds '
      + 'on the 25th, so BAL needs no Aug 25 row.');
  }
}

function _nmcPad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

// The rollover copies notes forward, so next month's tab inherits these on its
// own 22nd/23rd where they mean nothing. Clears only notes that exactly match
// OURS, and only on Sales tabs OTHER than the August one — so it can never touch
// this fix, and never touch the Aug 16-20 fix's notes either.
function nmcClearCarriedNotes() {
  var ss = SpreadsheetApp.openById(NMC_SHEET_ID);
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.indexOf('Sales ') !== 0 || name === NMC_TAB) return;
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return;
    var rng = sh.getRange(1, 1, lastRow, lastCol);
    var notes = rng.getNotes();
    var touched = false;
    for (var r = 0; r < notes.length; r++) {
      for (var c = 0; c < notes[r].length; c++) {
        if (notes[r][c] === NMC_NOTE) { notes[r][c] = ''; touched = true; }
      }
    }
    if (touched) { rng.setNotes(notes); Logger.log('cleared carried notes on ' + name); }
  });
}
