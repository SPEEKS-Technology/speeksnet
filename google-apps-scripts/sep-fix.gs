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
// ⚠️ AND SO IS THE SCRIPT LOCK — PASTE BOTH FILES OR NEITHER. _sepfAll takes
// LockService.getScriptLock() so a restatement cannot land inside a refresh's
// write (see the block there for the 2026-09-08 near-miss). A lock only one side
// takes serializes nothing: with an OLD netprofit-sheet.gs the refresh will not
// ask for it, will not wait, and the race is exactly as open as it was — while
// this file now reads as though it were handled. Updating one file and not the
// other is worse than updating neither, because it removes the reason to look.
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
//
// ---------------------------------------------------------------------------
// SEP 7 — OVL only. One repayment invoice, corroborated both ways.
//
//   OVL  reported 4,442.21 / 2,742.44 cost
//        − draft    −219.99 /  −100.00   = 4,222.22 / 2,642.44   (GP 1,579.78)
//
// #KS01-14695, $219.99, an Unlocked Apple iPhone 13 128GB Green (KS01-7359C-E3),
// invoiced 12:38pm Central. It satisfies BOTH halves of the rule that took
// effect Sep 6: it is dated on or after Sep 1, AND its amount equals an eBay
// order total OVL actually refunded — sales-true-daily returns
// `matches_a_refund_amount: true` on it. Same evidence class as the Sep 4 pin,
// which is the best-evidenced kind of removal in this file.
//
// The two independent checks agree the day is settled, which is the condition
// the "A ONE-DAY QUERY LIES" note above asks for: the per-order pass and the
// ShopifyQL channel split both put OVL's Draft Orders at exactly 219.99.
//
// Both tabs report the same base figures from their two separate queries —
// netprofit-collect returns net_sales 4442.21 / cost 2742.44 for OVL Sep 7,
// cell for cell what the Sales Summary holds. So one correction fits both.
//
// WSP, MPL and BAL had no draft orders on Sep 7, and LEE none either (see
// below). OVL remains the only store still receiving these.
//
// ⚠️ THE DRAFT CARRIES $100.00 OF COST, AND THAT IS NOT A CONTRADICTION.
// The "a repayment invoice has no cost of goods behind it" argument from Sep 6
// is a TIE-BREAKER for drafts the amount test cannot corroborate — it is what
// rescued LEE #MO01-9401 and MPL #MO03-3217 — not a veto over one it can. The
// Sep 2 pin removed $245.00 of cost on exactly this footing. The amount match
// is the stronger evidence and it is present here.
//
// IT IS AUTHORIZED, NOT PAID — the money is not captured yet. That is the
// NORMAL state for these, not an anomaly: all three of the Sep 4 repayments
// (#KS01-14625, #KS01-14628, #KS01-14631) are AUTHORIZED too, and the Sep 1/2
// ones had settled to PAID by the time they were read. It changes nothing
// either way — ShopifyQL already counts the $219.99 in the day's Draft Orders
// channel, and an invoice the customer has not actually paid is even less of a
// sale than one they have.
//
// ⚠️ THE `created ...` TAG IS NOT EVIDENCE OF ANYTHING. #KS01-14695 carries
// `created 2026-08-31T14:01:38Z` and so does EVERY other OVL draft in the
// window, the seven confirmed repayments included — one bulk edit stamped the
// lot on Aug 31. It looks like a provenance marker and is not one. Checked so
// that the next sweep does not mistake it for a discriminator.
//
// ⚠️ OVL'S SEP 7 REFUNDS ARE LEFT EXACTLY AS REPORTED, and the pin does not
// depend on them. The day carries $681.48 of genuine refunds, $414.98 the
// classifier could not place, and a $99.99 adjustment-only refund (#KS01-14403,
// eBay 07-15097-93226 — a refund with no line items). All of it stays in.
//
// This is NOT the WSP Sep 3 situation despite the shared symptom. There the
// contemplated restatement was itself a refund judgment, so unpriceable refunds
// undermined the derivation. Here the derivation is `reported − the draft`:
// reported_net_sales has already netted every refund, whatever it is, and
// subtracting one draft order passes all of them through untouched. The day
// also reconciles to the penny, which WSP's did not — 1,096.46 classified +
// 99.99 adjustment-only = 1,196.45 reported returns, with an order attached to
// every dollar.
//
// Adding back the $414.98 is a separate judgment needing its own evidence. It
// is not bundled in here. Drafts only, as asked.
//
// ---------------------------------------------------------------------------
// ⚠️ LEE'S SEP 7 IS NOT RESTATED, AND THIS TIME THE DAY CAME RIGHT ON ITS OWN.
//
// dupe-open-pairs found one open duplicate pair on Sep 7 — the only one at any
// store, over every paid order back to Jun 1 (5,221 scanned). eBay order
// 04-15048-40910, a broken PlayStation 5 Slim, sold Aug 16 as #MO01-8797
// through SPEEKS Connect and re-imported by the new PayMore app at 9:30pm
// Central on Sep 7 as #MO01-9491 ($219.99) — two live, paid, fulfilled Shopify
// orders for one sale, neither refunded. Ethan cleared the copy on Sep 8.
//
// Unlike the Sep 1 duplicate, the deletion DID take it out of the day. Measured
// after the fact rather than assumed: LEE's Sep 7 went from 21 orders /
// $5,674.77 to 20 / $5,454.78, and both queries now agree at 5,454.78 /
// 2,887.44. There is nothing to pin, so LEE stays live on the daily sync.
//
// ⚠️ RE-CHECK LEE'S SEP 7 AFTER THE 2PM PASS ANYWAY. The Sep 1 lesson was that
// the sales dataset does NOT retroactively forget an order, and here it did.
// The two cases differ in timing — Sep 1's copy lived a full day before being
// deleted, this one a matter of hours — but "deleted in time" is a guess at the
// mechanism, not a measurement, and the guess is the sort this file has been
// wrong about before. If LEE's Sep 7 sales ever read 5,674.77 again the
// duplicate has come back into the figure and the day needs the pin after all:
//
//   LEE  5,454.78 / 2,887.44      ← only if the deleted copy reappears
//
// ⚠️ THE DUPLICATE ARRIVED IN A BACKFILL BATCH, which is the part worth
// watching rather than the single order. #MO01-9491 landed at 02:30:03Z and
// #MO01-9492 at 02:30:19Z, sixteen seconds apart, both carrying eBay ids from
// older sales — the new app importing history, not live sales coming through.
// That is the same mechanism that produced the Sep 1 duplicate. #MO01-9492
// (20.99, eBay 22-15116-20372) was checked and has no twin; it is a real
// order and stays in.
//
// SEP 6 was checked at OVL and LEE only, as a by-product of running the Sep 7
// window a day either side. Both clean — zero drafts on the per-order pass and
// 0.00 on the Draft Orders channel. That is NOT a district-wide result for
// Sep 6 and should not be read as one.
//
// ---------------------------------------------------------------------------
// ⚠️ WHAT PROTECTS A REAL DRAFT SALE — asked 2026-09-08, and worth writing down
// because the honest answer is not "we only strip the ones we created".
//
// The stores sell through draft orders on purpose: the Drafts list carries
// PayMore Upgrade and PayMore Consoles deals alongside the glitch repayments.
// Nothing in looksLikeRepayment() knows who created a draft, who the customer
// is, what the draft was called, or what is on it. It tests two things only:
// the day is on or after Aug 26, and — from Sep 1 — the amount equals an eBay
// order total that store actually refunded.
//
// So the real protection is STRUCTURAL, and it sits one level up: the strip only
// ever considers orders whose `sourceName` matches /draft/i. Measured on the
// upgrade deals themselves — #D356 and #D355, completed Sep 4 at 1:02 and
// 1:03pm, land at OVL as #KS01-14633 ($692.78) and #KS01-14634 ($358.79) with
// sourceName `35264036865`, an app id with no "draft" in it. They are invisible
// to the test, and ShopifyQL agrees: they sit in the PayMore channel while the
// repayment sits alone in Draft Orders. The Sep 4 pin above removed $334.97 and
// left both upgrades in, which is this working correctly on real data.
//
// ⚠️ THE AMOUNT TEST IS THE ONLY GUARD LEFT, AND IT IS A COINCIDENCE TEST.
// If an upgrade deal is ever completed through the invoice route instead — so
// that it DOES arrive as shopify_draft_order — nothing stands between it and
// the strip except its total failing to match any of the 81 refunded amounts
// known at OVL. Those are ordinary retail price points ($219.99, $224.99,
// $229.99), which is exactly where a real sale is most likely to land. The
// upgrade deals happen to price at $692.78 and $358.79 and would not collide,
// but that is luck, not a safeguard.
//
// ⚠️ AND THE FIELD THAT WOULD SETTLE IT CANNOT BE READ. `customer` — the
// column showing "PayMore Upgrade" in the admin — is walled off on all five
// tokens: "Access denied for customer field. Required access: read_customers".
// So does `app`, behind read_apps. Adding read_customers to the five custom
// apps would turn the customer into a real discriminator and make this test
// evidential instead of circumstantial. Until then, any draft that arrives as
// shopify_draft_order AND matches a refunded amount should be eyeballed against
// the store's Drafts list before it is pinned.
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

var SEPF_NOTE_0907_OVL =
  'Sep 7 restated — $219.99 of draft-order invoice removed (cost 100.00): #KS01-14695, an '
  + 'iPhone 13 invoiced 12:38pm. Its amount matches an eBay order total OVL actually refunded, '
  + 'so the date rule and the amount test both agree it is a glitch repayment rather than '
  + 'selling. Refunds are untouched — the $99.99 adjustment-only refund and $414.98 of '
  + 'unclassified refunds all stay in. Real figure. Locked from the daily sync.';

var SEPF_FIX = [
  { store: 'OVL', day: 1, sales:  949.33, cost:  168.00, note: SEPF_NOTE_0901_OVL },
  { store: 'OVL', day: 2, sales: 5993.75, cost: 2884.07, note: SEPF_NOTE_0902_OVL },
  { store: 'OVL', day: 4, sales: 9323.30, cost: 4544.75, note: SEPF_NOTE_0904_OVL },
  { store: 'OVL', day: 7, sales: 4222.22, cost: 2642.44, note: SEPF_NOTE_0907_OVL }
  // MPL Sep 2: pin REMOVED — an ordinary sale, not a repayment. It is in
  //   SEPF_UNPIN below, because deleting the row does not clear the cell.
  // LEE Sep 3: #MO01-9401 is a real sale and stays in. No row, on purpose.
  // Sep 5: checked 2026-09-06, clean at all five stores. No rows, on purpose.
  // LEE Sep 7: the duplicate #MO01-9491 left the day when the copy was
  //   deleted — verified, not assumed. No row unless it comes back; the
  //   figure to use if it does is in the Sep 7 block above.
  // Sep 7: WSP, MPL and BAL had no drafts and no duplicate pairs. No rows.
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

// A hand run waits longer than a scheduled one, because a person is watching and
// the thing it is waiting for is a refresh that can take minutes. Refusing is
// still better than racing: a pin written into the middle of a refresh is the
// failure this is here to stop.
var SEPF_LOCK_WAIT_MS = 120000;

function _sepfAll(dryRun) {
  Logger.log(dryRun ? '=== PREVIEW — nothing will be written ===' : '=== APPLYING ===');

  // ⚠️ THE SAME SCRIPT LOCK netprofit-sheet.gs TAKES, AND THE NEAR-MISS THAT
  // PUT IT HERE. On 2026-09-08 the morning refresh started at 8:44:48 and the
  // workbook's last write landed at 8:56:27. _npWrite reads every formula on the
  // tab once at the top of the run and decides what is pinned from that read, so
  // a pin applied anywhere inside those eleven minutes was invisible to it — and
  // the refresh would have written the unrestated figure back over it, silently,
  // with the run logging a perfectly ordinary "written".
  //
  // Restating during a refresh is exactly when somebody would do it: the numbers
  // have just landed, which is what prompts the correction.
  //
  // ⚠️ ONE APPS SCRIPT PROJECT IS ONE SCRIPT LOCK. That is the whole mechanism —
  // netprofit-sheet.gs calls LockService.getScriptLock() too, so the two reach
  // the same lock without either file knowing about the other. Do not "tidy"
  // this into a shared helper in the other file: either file has to be able to
  // be pasted in on its own and still take the lock.
  //
  // A PREVIEW TAKES NO LOCK — it writes nothing, and a preview you cannot run
  // while a refresh is going is a diagnostic missing at the moment you want it.
  var sepfLock = null;
  if (!dryRun) {
    sepfLock = LockService.getScriptLock();
    if (!sepfLock.tryLock(SEPF_LOCK_WAIT_MS)) {
      Logger.log('!! another writer holds the script lock — NOTHING WAS WRITTEN.');
      Logger.log('   A Net Profit refresh is mid-write (they run 8-9am and 2-3pm Central '
               + 'and take several minutes). Wait for it to finish and run this again. '
               + 'Pinning now would put these cells inside a write the refresh has '
               + 'already decided the contents of.');
      return;
    }
  }
  try {
    _sepfAllLocked(dryRun);
  } finally {
    if (sepfLock) sepfLock.releaseLock();
  }
}

function _sepfAllLocked(dryRun) {
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

  // Same lock as sepFixApply, and it matters here for the mirror-image reason.
  // An unpin CLEARS a cell to hand the day back to the daily sync; do that in
  // the middle of a refresh and the refresh — which decided what was pinned
  // minutes ago — leaves the now-empty cell alone as though it were still
  // locked. The day would read blank until the next pass, on a tab whose NP
  // formula treats a blank as arithmetic zero.
  var unpinLock = null;
  if (!dryRun) {
    unpinLock = LockService.getScriptLock();
    if (!unpinLock.tryLock(SEPF_LOCK_WAIT_MS)) {
      Logger.log('!! another writer holds the script lock — NOTHING WAS CLEARED.');
      Logger.log('   A Net Profit refresh is mid-write. Wait for it to finish and run '
               + 'this again; a cell cleared inside a refresh stays empty until the '
               + 'pass after it.');
      return;
    }
  }
  try {
    _sepfUnpinAllLocked(dryRun);
  } finally {
    if (unpinLock) unpinLock.releaseLock();
  }
}

function _sepfUnpinAllLocked(dryRun) {
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
