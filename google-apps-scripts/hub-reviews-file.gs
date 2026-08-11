// ============================================================================
// GOOGLE REVIEWS → hub payload   (NEW FILE — paste this whole thing)
//
// In the Apps Script project "SPEEKSNET 2.0 Sales Summary" (the one bound to the
// Sales Summary sheet, where getDashboardData lives):
//
//   1. + (next to Files) → Script → name it  Reviews
//   2. Select everything in the new file and paste this over it.
//   3. In Code.gs, find getDashboardData()'s   return data;
//      and make it                            return addGoogleReviews(data);
//   4. Deploy → Manage deployments → pencil → Version: "New version" → Deploy.
//
// Step 3 is the ONLY edit to existing code, and it is one line. That is the whole
// reason this is a separate file: the previous version was a dozen lines pasted
// into the middle of a function, and it went in referencing a variable that does
// not exist there — which took the entire hub down (buying, selling, leaderboard,
// every Live Dashboard surface froze on their last cached payload) for one bonus
// figure.
//
// ⚠️ If Code.gs has more than one `return data;`, use the one at the END of
// getDashboardData(). An early return is a bail-out path with a half-built
// payload, and reviews on a half-built payload is not worth anything.
//
// ---------------------------------------------------------------------------
// WHAT THE SHEET NEEDS  (already done as of 2026-08-08 — here for next time)
//
// A Google Reviews block on the `Buy {Mon} {YY}` tab, right of the TTL block:
//
//   AE1  "Google Reviews"
//   AE2  "Goal"      AF2:AJ2   monthly 5-star target per store  ← set by hand
//   AE3  "Date"      AF3:AK3   OVL  LEE  WSP  MPL  BAL  TTL
//   AE4:AE34         day numbers 1-31
//   AF4:AJ34         CUMULATIVE month-to-date count per store   ← the importer
//                    writes these; leave them blank, and never put a formula
//                    here (the importer refuses to overwrite one, by design)
//   AK4   =IF(COUNT(AF4:AJ4)=0,"",SUM(AF4:AJ4))     fill down to AK34
//   AF35  =IFERROR(MAX(AF4:AF34),0)                 fill across to AK35
//   AF36  =IFERROR(AF35/$E$40*$E$39,0)              fill across to AK36
//
// BUYING DAYS, NOT CALENDAR DAYS (user's call 2026-08-08, and the righter one):
// a review comes from someone at the counter asking for one, and the stores are
// shut on Sundays.
//
// ⚠️ E40 and E39 are the Buy tab's OWN counters — "Days thru Month" and "Buying
// Days in Month", cell addresses confirmed by the user, not guessed. Reusing them
// rather than counting days here is the whole point:
//   - They already exclude HOLIDAYS as well as Sundays (BUY_CLOSED_DATES in
//     sales-email-import.gs, cross-checked every run by _buyPlannedCheck). A
//     NETWORKDAYS.INTL rule of my own would only know about Sundays, and would
//     read a day long after every holiday for the rest of the month.
//   - Reviews and buying can then never disagree about how long a month is.
//   - E40 tracks the last day the DATA covers, not the calendar, which is why the
//     projection does not dip every morning before the 7am import runs. Reviews
//     and buying ride the same email, so they advance together by construction.
// Absolute refs so they survive the fill across — every store shares one
// denominator, which is correct: they all import on the same day.
//
// There is deliberately NO per-buying-day rate row. It was built and removed the
// same afternoon: a rate has to be whole to be an instruction, and rounding up
// flattened four of five stores onto "2 a day" while asking LEE for 40 where 21
// would do. The tile shows the remainder instead ("9 of 30 · 21 to go"), computed
// in speeks.js from goal minus banked — both already on the payload.
//
// Two traps in those formulas, both of which fail quietly:
//   - ⚠️ DO NOT use the LOOKUP(2,1/(range<>""),range) "last non-blank" idiom for
//     row 35, which is what it said first. It builds a lookup vector of one number
//     and thirty #DIV/0! errors and asks Sheets to BINARY-SEARCH it, which is only
//     reliable once the column is mostly full. On the first real import — a single
//     figure at day 7 — every one of the six cells returned 0 while the data sat
//     visible two rows above. MAX has no sorted-range assumption, and for a
//     CUMULATIVE count the largest value IS the month to date.
//   - AK must leave an empty day BLANK rather than showing 0, so the TTL column
//     reads as "nothing yet" for days that have not imported. Nothing depends on
//     it now that the denominator comes from E40, but a column of 31 zeros is a
//     lie the moment anybody reads it.
// ============================================================================

/**
 * Adds the per-store Google review figures to the hub payload, and returns it.
 *
 * Takes and returns `data` so the call site is a single expression — see step 3
 * above. Adds no keys at all when the sheet has no reviews block, which every
 * surface in speeks.js already reads as "don't show reviews yet".
 */
function addGoogleReviews(data) {
  // ⚠️ THE try/catch IS THE POINT, not defensive habit.
  //
  // This runs inside the hub's only response path. Anything that throws in here
  // takes down buying, selling, the leaderboard and the whole Live Dashboard —
  // which is exactly what happened once already, on a variable name. So the
  // block reaches for NOTHING outside itself (it opens the tab by name rather
  // than borrowing a handle), and any failure at all costs reviews and nothing
  // else. Silence here degrades to the state before the feature existed.
  try {
    var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
      'Buy ' + Utilities.formatDate(new Date(), 'America/Chicago', 'MMM yy'));

    // getRange() THROWS on a column past the end of a sheet. The catch would
    // handle it, but a caught exception is still a wasted call every 10 minutes,
    // and this way a sheet without the block is silence rather than a swallowed
    // error nobody can see.
    if (!tab || tab.getMaxColumns() < 36) return data;

    // Coerce rather than trusting the sheet. A formula cell that errors hands
    // getValue() back the STRING "#N/A", which would travel all the way to the
    // browser as text; the client treats 0 as "nothing yet".
    var num = function (v) { var x = Number(v); return isFinite(x) ? x : 0; };

    var cols = { ovl: 'AF', lee: 'AG', wsp: 'AH', mpl: 'AI', bal: 'AJ' };
    Object.keys(cols).forEach(function (s) {
      var c = cols[s];
      data[s + 'Reviews']     = num(tab.getRange(c + '35').getValue());  // month to date
      data[s + 'ReviewsProj'] = num(tab.getRange(c + '36').getValue());  // projected month-end
      data[s + 'ReviewsGoal'] = num(tab.getRange(c + '2').getValue());   // monthly target
    });

    // ---- the DAY COLUMN, so the dashboard can see movement ------------------
    // Rows 35 and 36 above are the month's total and its projection: two numbers
    // that both go UP and never say whether anything happened yesterday. A store
    // that has not been asking for reviews for three days looks identical to one
    // that got four on the 2nd and stopped.
    //
    // AF4:AJ34 is already a per-day cumulative column, so the movement is sitting
    // right there — this just carries it across. Shaped as { OVL: [...31] } to
    // match wkBuy / wkSell / wkBuyMarginPct exactly, which is what _lvBuyArr in
    // speeks.js already knows how to read.
    //
    // ONE getValues() for the whole block. Thirty-one getValue() calls per store
    // would be 155 round trips to the sheet on a hub that runs every 10 minutes.
    //
    // ⚠️ A blank day stays NULL, and must not become 0. The counts are cumulative,
    // so a real 0 (a store that genuinely has none yet) and a day the importer has
    // not reached are different facts, and collapsing them would make every store
    // read as "no movement" for the whole back half of the month.
    var grid = tab.getRange('AF4:AJ34').getValues();
    var codes = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
    var daily = {};
    codes.forEach(function (code, ci) {
      daily[code] = grid.map(function (row) {
        var v = row[ci];
        if (v === '' || v === null || v === undefined) return null;
        var x = Number(v);
        return isFinite(x) ? x : null;
      });
    });
    data.wkReviews = daily;
  } catch (err) {
    // Deliberately swallowed. Reviews are a bonus figure; the hub is not.
  }
  return data;
}
