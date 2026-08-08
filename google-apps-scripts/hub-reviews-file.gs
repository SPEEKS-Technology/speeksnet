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
//   AK4   =IF(COUNT(AF4:AJ4)=0,"",SUM(AF4:AJ4))                    fill down
//   AF35  =IFERROR(MAX(AF4:AF34),0)                                fill across
//   AF36  =IFERROR(AF35/_ELAPSED*_INMONTH,0)                       fill across
//   AF37  =IFERROR(MAX(0,(AF$2-AF35)/MAX(1,_INMONTH-_ELAPSED)),0)  fill across
//   AE37  "Need / buying day"
//
// where, written out in full (Sheets has no LET on old files, so both appear
// inline in each formula):
//   _ELAPSED  = NETWORKDAYS.INTL(EOMONTH(TODAY(),-1)+1,
//                 EOMONTH(TODAY(),-1)+MAXIFS($AE$4:$AE$34,$AK$4:$AK$34,">0"),11)
//   _INMONTH  = NETWORKDAYS.INTL(EOMONTH(TODAY(),-1)+1,EOMONTH(TODAY(),0),11)
//
// BUYING DAYS, NOT CALENDAR DAYS (user's call 2026-08-08, and the righter one):
// reviews come from someone at the counter asking for one, and the stores are shut
// on Sundays. `11` is NETWORKDAYS.INTL's "Sunday only" weekend code, which is the
// same rule the Buy tab's own "Days thru Month" uses.
//
// Note this does NOT know about holidays, where the Buy tab's hand-kept "Buying
// Days in Month" does (BUY_CLOSED_DATES in sales-email-import.gs). One closed
// holiday makes this read one day long. Deliberate: reaching across to that cell
// means hard-coding its address, and guessing an address is what took the hub down.
//
// _ELAPSED reads the last day the TTL column reported, so the projection is
// measured over exactly the window the data covers — which is why it does not dip
// every morning before the 7am import runs. Absolutely referenced so it survives
// the fill across; all five stores import together, so they share a denominator.
//
// Three traps in those formulas, all of which fail quietly:
//   - ⚠️ DO NOT use the LOOKUP(2,1/(range<>""),range) "last non-blank" idiom for
//     row 35, which is what it said first. It builds a lookup vector of one number
//     and thirty #DIV/0! errors and asks Sheets to BINARY-SEARCH it, which is only
//     reliable once the column is mostly full. On the first real import — a single
//     figure at day 7 — every one of the six cells returned 0 while the data sat
//     visible two rows above. MAX has no sorted-range assumption, and for a
//     CUMULATIVE count the largest value IS the month to date.
//   - AK must leave an empty day BLANK, because _ELAPSED asks it which day the
//     import last ran. A plain SUM writes 0 into all 31 rows on day one.
//   - Row 37 needs MAX(0,…) on the numerator and MAX(1,…) on the denominator. A
//     store past its goal would otherwise show a NEGATIVE daily rate, and the last
//     buying day of the month would divide by zero.
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
      data[s + 'ReviewsNeed'] = num(tab.getRange(c + '37').getValue());  // per buying day, to goal
      data[s + 'ReviewsGoal'] = num(tab.getRange(c + '2').getValue());   // monthly target
    });
  } catch (err) {
    // Deliberately swallowed. Reviews are a bonus figure; the hub is not.
  }
  return data;
}
