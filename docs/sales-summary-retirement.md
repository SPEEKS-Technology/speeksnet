# Retiring the Sales Summary import (after the GP → NP switch)

Written 2026-10-02, when the site moved to Net Profit. This is the checklist for
deleting the old Shopify-sales-email → "Sales {Mon} {YY}" tab automation.
The order matters because buying, cash, Day End and Net Profit share the same
workbook, Apps Script project, `/exec` router and script lock as the sales import.

## DONE 2026-10-03 (Ethan: "delete all of the old sales summary automation so I can delete those tabs for October")

- **0136**: `capture_daily_buysell()` takes `sell`/`gp` from `daily_np` for dates ≥ 2026-10-01 (verified equal to the
  cent Sep 28 – Oct 1); unscheduled jobs 73 (month-end fill) and 21/22 (summary-weekly). Applied with
  `supabase db query --linked -f` (the MCP was down), so it is not in `supabase_migrations` history.
- **buysell-history-sync**: `sell`/`gp` from `daily_np` for dates ≥ 2026-10-01; creates rows for NP days with no buying.
- **sales-ingest**: calls the Apps Script's `action=buying` (already published), report re-wrapped in the old shape.
  The Shopify → Sales tab import no longer runs. No Apps Script deploy was needed.
- **shopify-live**: `np.sellByDay` (daily sales off the NP tab) replaces the hub's `wkSell` for bought-vs-sold.
- **Front end**: leaderboard no longer asks for a hub redeploy when the hub has no Sales arrays; Weekly Summary control
  and its feature key removed; the daily import line/messages say buying; "Updated as of" reads the NP tab's last
  closed day (`_ccUpdatedNp`); the records hint no longer names the Daily Sales Summary.
- **month-rollover.gs needs NO change**: `_mrRoll` builds next month from whatever tabs this month has, so with
  "Sales Oct 26" deleted Nov 1 builds only "Buy Nov 26". `_mrWriteGoals` answers "no Sales tab" to a goal save,
  which nothing reads.
- The hub tolerates a missing Sales tab (every read is inside `if (salesSheet)`).

## RESOLVED 2026-10-03: the Summary stays, its revenue/cost read the NP tab

Ethan: "point the revenue to the net profit tab since it's the same numbers". `_weeklyFiguresFor` reads days from
2026-10-01 off "Net Profit {Mon} {YY}" (NP_BASES / NP_OFF_SALES / NP_OFF_COST; same day-row lookup). Checked with
the real functions against the real Oct tab: Oct 1-2 equal daily_np to the cent for all five stores. 0137 put jobs
21/22 back (now 77/78) and the front end's Weekly Summary control is restored. **Needs sales-email-import.gs
published as a new version before Monday 7:30am**, or the run is blocked as incomplete.

Background, kept for the record:

## The weekly Summary tab feeds the Monday unlisted-backlog report

`unlisted-backlog` reads `store_weekly_sales.inventory_line_items`, which only exists because summary-weekly writes the
Summary tab and the old `sales-sync.gs` onEdit trigger pushes it to Supabase. Line items are NOT in `day_end_facts`
(`available_count` is units = `qty_items`). And `_weeklyFiguresFor` reads revenue/cost off the Sales tabs, so with
"Sales Oct 26" gone the Summary run is `blocked` (incomplete) and writes nothing. Needs a decision: re-plumb line items
straight to `store_weekly_sales`, point the Summary's revenue/cost at the NP tab, or drop the backlog report.

## Still to do (cleanup, nothing depends on it)

- Delete the dead sales code from sales-email-import.gs (list below) and the deployed `summary-weekly` function.
- Hub: `{s}BuyDate` stamps on Sales Rev/GP changes and will stop moving; the front end no longer shows it on NP months.

## What replaced it

- `daily_np` (0129): per store per day sales / cost / GP / eBay / shipping / card / royalty / NP,
  mirrored from the Net Profit tab by `np-sync` every 15 min (0130).
- `monthly_np_goals` (0129): set in Month Setup through `gp-goals` (NP from `2026-10`).
- `shopify-live` `np` block: live NP, goal, pace, tracking for the Live dashboard, the DCC and the leaderboard.
- `buysell-daily`: Daily Breakdown sells, GP and NP from `daily_np` wherever it has the day.
- `ebay_fee_month` (0132): eBay fees by kind, from `ebay-fee-mix` (0133).

## Must change BEFORE the Sales tabs stop being made

1. **`daily_buysell.sell` / `.gp` would be overwritten with NULL/0.**
   - `capture_daily_buysell()` (cron 5, hourly; also called by records-watch) writes `wkSell`/`wkGP` from the hub.
     Make it write only `buy` / `buy_margin_pct`, or take `sell`/`gp` from `daily_np`.
   - `buysell-history-sync/index.ts` ~160-170 writes `sell: sales ?? 0, gp: gp ?? 0`. Stop writing those columns
     (or source them from `daily_np`).
   - Readers that would silently break: records-watch (Daily Sell record, `sell <= 0` = "waiting"),
     daily-brief (netSales / sellMargin fallback), shopify-live comparisons (`loadBuyCompare`), buysell-daily past months.
2. **Hub (`hub-code.gs` `getDashboardData`, bound project, not deployed from repo):** its Sales-tab fields
   (`{s}Rev/GP/SellMargin/Goal/Pct/TrackRev/TrackGP`, `leaderboard.*`, `wkSell`, `wkGP`) go stale.
   Front-end readers still on them: `fetchHubData`, `renderBuyingSales`, `renderLiveData` (write to IDs no page
   has; probably dead), `_lvBuyFor` (`wkSell` for bought-vs-sold), `_dccRow` (Rev / sell margin), `initTicker`,
   `syncAllData`. `{s}BuyDate` change-detection compares Sales Rev/GP; re-base it on BuyVal/`wkBuy`.
   KEEP the Buy-tab fields: `{s}BuyVal/BuyMargin/BuyProj`, `wkBuy`, `wkBuyMarginPct`, reviews.
3. **weekly-report** still reads hub buying (all months) and hub selling for pre-October weeks.
4. Fetch and commit the source of deployed-only functions first: `hub`, `sync-buysell`, `sync-sales`, `ebay-alerts`.

## Apps Script — sales-email-import.gs (shared project with Net Profit)

- **Delete (sales/Summary only):** `ingestSalesEmails`, `fillMonthEndFromShopify` (+ `SHOPIFY_DAY_URL`,
  `MONTH_END_WINDOW`), `parseStoreEmail`, `_parseDatedRows`, `_findLabeled`, `_periodDate`, `_searchMessages`,
  `_storeFor`, `_tabNameFor`, `_lastDayWithSales`, `_blockBaseFor`, the change-alert + goal-colour block
  (`_sendChangeAlert` … `_syncDaysThru`), sales diagnostics (`diagnoseShopifyEmails` … `_dumpMessages`,
  `mapSendersToStores`, `diagnoseSheetCells`, `dryRunImport`, `runImportNow`), the whole Weekly/Summary block
  (`ingestWeeklySummary` and helpers; KEEP `SUMMARY_STORES`, used by `_convTab`), `_round2`, `_convMtd`,
  `verifyConversionWeek`, `rehearseWeeklyShift` and friends, `_a1col`. Constants: `REVERIFY`, `EXPECT_FROM`,
  `STORE_SENDERS`, `NOT_A_REPORT_SUBJECTS`, `SALES_COL_BASES`, `COL_SALES/COST`, `UPDATE_DAYS_THRU`,
  `COLOR_GOAL_CELLS`/`GOAL_*`, `NOTIFY_*`, `CHANGE_ALERT_TO`, `SALES_LABELS`, `COST_LABELS`.
- **KEEP:** `LOOKBACK`, all buying/cash/reviews/closures code, `_plainBody`, `_valueAfterLabel`,
  `_findLabeledNear`, `_money`, `_parseDateToken`, `_findDayRow`, `_num`, date helpers, `_labelPairs`, the
  `_wk*` parsing helpers (Day End uses them), all Day End Facts code, `scopeTest`.
- **Router `_handle`:** keep `buying`, `dayEndFacts`, `netprofit`, `diagnoseBuying`, `diagnoseReviews`
  (and `backfillConversions` until decided). Remove `diagnose`, `diagnoseWeekly`, `diagnoseSummary`, `weekly`,
  `rehearseShift`, `verifyConversions`, `monthEnd`, and the sales half of the default `ingest`.
  Safest: keep `ingest` as an ALIAS that runs buying only, so the deployed sales-ingest keeps working mid cut-over.
- **sales-ingest/index.ts:** call `action=buying`; the report is then top-level (`report.cash`, not
  `report.buying.cash`); re-gate `kickSyncBuysell` on buying writes; drop the "Selling" section of the alert.
  Keep cron 8/10 off the NP minutes (:10 of 6, :05 of 14) — same script lock.

## Apps Script — Net Profit files

- netprofit-schedule.gs: remove the `_syoySync` blocks in `npsDailyRefresh` (~384-407) and `npsTailRecovery` (~618-624).
- netprofit-summary.gs: remove `NPX_SALES_*`, `_npxSalesTabTotals`, `lmSales`, the `'sales-tab'` branches.
  Keep `NPX_YOY_2025`.
- Delete sales-yoy.gs; tests: sales-yoy-check.js, the `_syoySync` stub in np-schedule-flow-check.js,
  np-lastmonth-source-check.js.

## month-rollover.gs (standalone)

- Roll Buy only: drop the Sales `_mrBuildTab` call in `_mrRoll`; source check `!src || !src.buy`;
  `mrRollThisMonth` "already rolled" test → `idx[ym].buy`; drop the sales pair in `mrVerifyPastMonth`/`_mrRepairLastDay`.
- Drop `_mrWriteGoals` (GP Goal on Sales tab) from `doPost`; keep `npGoals` and `buyDays`.
- NP tabs roll themselves (`_npsEnsureTab` → `_nprRoll`), nothing here needed.

## pg_cron

- Unschedule: **73** `sales-month-end-fill-650am`, **21/22** `summary-weekly-mon-*`, inactive twins 9/11.
- Keep: 8/10 (buying + cash), 1 sync-buysell, 5 capture (after fix), 25/26/74 buysell-history (after fix), 57/58 NP.
- Order: publish the new Apps Script version (with `buying`, `ingest` alias) → deploy new sales-ingest →
  unschedule 21/22/73 → then remove their router actions.

## Edge functions

- Delete: `summary-weekly` (+ `summary_weekly_alert` list in email-recipients).
- Keep `sales-true-daily` while company-performance-sheet.gs uses it.

## Front end

- Hotbar "Sales Summary" links (index.html ~784/799/831/840, feature keys `hb-*-sales-summary`): **KEEP as they
  are, name included** (Ethan 2026-10-02: it is still called the Sales Summary; it just reads Net Profit now).
- Delete the Weekly Summary control (`SUMMARY_WEEKLY_URL`, `runWeeklySummary`, `_swLineHtml`).
- Relabel the Sales Import status line as the Buying Import.
- Records hint ("fill themselves in every morning from the Daily Sales Summary…", speeks.js ~11150) and
  records-watch ~582.

## Whole files that can go

sales-yoy.gs; one-off restatements mpc-dupe-fix.gs, newmc-store-fix.gs, newmc-dupe-fix.gs, mirror-fix.gs,
sep-fix.gs (+ tests/sep-fix-cells-check.js). Verify first: sales-sync.gs / `sync-sales` (a bound-project onEdit
trigger may still exist). Do NOT delete the old Sales tabs themselves — history reads them and August has no NP tab.
