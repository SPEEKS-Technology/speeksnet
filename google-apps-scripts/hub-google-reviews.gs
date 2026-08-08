// ============================================================================
// GOOGLE REVIEWS → hub payload
//
// Paste the block below into getDashboardData() in the Apps Script project
// "SPEEKSNET 2.0 Sales Summary" (bound to the Sales Summary sheet), just before
// its `return data;`. Then Deploy → Manage deployments → pencil → Version:
// "New version" → Deploy.
//
// ⚠️ SAVING IS NOT DEPLOYING. The /exec URL serves the deployed VERSION, so the
// hub keeps returning the old payload until you publish a new one. This is the
// same trap that hid the MPL date fix for a day.
//
// ---------------------------------------------------------------------------
// WHAT THE SHEET NEEDS FIRST
//
// A Google Reviews block on the `Buy {Mon} {YY}` tab, in the columns to the
// right of the TTL block (the tab currently ends at AD). On the Buy tab rather
// than a new tab of its own so it carries forward when you duplicate the tab
// each month, and so it is on the page you already open every morning.
//
// VERIFIED row geometry of that tab (confirmed against the live hub payload,
// not assumed — ovlBuyVal reads C35 and equals the month total, ovlBuyProj
// reads C36 and equals the projection):
//     row 1   store titles          row 35  TTL
//     row 3   column headers        row 36  Tracking
//     rows 4-34  days 1-31
//
// So the reviews block mirrors it exactly:
//
//   AE1  "Google Reviews"
//   AE2  "Goal"      AF2:AJ2   monthly review target per store  ← you set these
//   AE3  "Date"      AF3:AK3   OVL  LEE  WSP  MPL  BAL  TTL
//   AE4:AE34         day numbers 1-31 (copy the Date column from any block)
//   AF4:AJ34         the CUMULATIVE month-to-date count per store  ← typed daily
//   AK4              =SUM(AF4:AJ4)                    (fill down to AK34)
//   AF35             =LOOKUP(2,1/(AF4:AF34<>""),AF4:AF34)          ← TTL: the
//                    latest figure entered, which for a cumulative count IS the
//                    month to date. Fill across AF35:AK35.
//   AF36             =IFERROR(AF35/LOOKUP(2,1/(AF4:AF34<>""),$AE$4:$AE$34)
//                             *DAY(EOMONTH(TODAY(),0)),0)          ← Tracking:
//                    month-to-date ÷ days elapsed × days in month. Fill across.
//
// NOTE the denominator is CALENDAR days, not the Buy tab's "days thru month"
// (which excludes Sundays because stores don't buy on them). Customers leave
// reviews any day of the week, so using the buying basis would overstate the
// projection by about a seventh.
//
// Once the daily report carries MTD reviews, the importer writes into these same
// cells and nothing downstream changes — that is the whole reason this lives in
// the sheet rather than being keyed into SPEEKSNET.
// ============================================================================

  // 4. GOOGLE REVIEWS  (Buy tab, AF-AJ; see the block comment above)
  //
  // Guarded on the tab actually being that wide. getRange() THROWS on a column
  // past the end of the sheet, and this runs inside getDashboardData() — so
  // pasting this before the columns exist would take down buying, selling, the
  // leaderboard and the whole Live Dashboard, not just reviews. With the guard,
  // a sheet without the block simply returns no review keys, and every surface
  // in speeks.js already treats "no keys" as "don't show reviews yet".
  if (buyingSheet && buyingSheet.getMaxColumns() >= 36) {
    var revCols = { ovl: 'AF', lee: 'AG', wsp: 'AH', mpl: 'AI', bal: 'AJ' };
    Object.keys(revCols).forEach(function (s) {
      var c = revCols[s];
      data[s + 'Reviews']     = buyingSheet.getRange(c + '35').getValue();  // month to date
      data[s + 'ReviewsProj'] = buyingSheet.getRange(c + '36').getValue();  // projected month-end
      data[s + 'ReviewsGoal'] = buyingSheet.getRange(c + '2').getValue();   // monthly target
    });
  }
