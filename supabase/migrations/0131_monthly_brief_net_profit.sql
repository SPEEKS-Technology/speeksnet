-- ============================================================================
-- Monthly Breakdown gains Net Profit (2026-10-02).
--
-- From October the company is graded on Net Profit. Ethan's call: GP STAYS in
-- the Monthly Breakdown (it is still keyed every month), and Net Profit is ADDED
-- beside it — plus eBay fees, because the fee gap between stores is the point of
-- the switch (BAL and MPL pay ~9% of eBay sales in final value fees and carry the
-- "very high item not as described" fee; OVL ~7.6%).
--
--   net_profit          manual, money   — the month's NP (the NP tab's month row,
--                                         or the P&L figure once it lands)
--   net_profit_pct      derived legacy  — net_profit / net_sales   (_MB_DERIVED)
--   ebay_fees           manual, money   — the NP tab's eBay fee column, month total
--   ebay_fee_pct_sales  derived legacy  — ebay_fees / net_sales    (_MB_DERIVED)
--
-- 'legacy' derived rows are computed in the browser by _MB_DERIVED and saved with
-- the month, the same as gross_profit_pct and shipping_cost_pct_sales.
--
-- SEPTEMBER IS PRE-FILLED from daily_np (the mirror of the "Net Profit Sep 26"
-- tab) so the first NP month has a figure to compare against and records-watch
-- has a starting point. Written as 'Net Profit tab' so it reads as imported, not
-- typed; Ethan can overwrite it with the P&L figure in the editor.
-- ============================================================================

insert into public.monthly_brief_metrics
  (metric_key, label, type, section, sort_order, active, lower_is_better, no_shade, source, formula_key, formula_arg)
values
  ('net_profit',         'Net Profit',             'money', 'Sales & Profit', 262, true, false, false, 'manual',  null,     null),
  ('net_profit_pct',     'Net Profit %',           'pct',   'Sales & Profit', 264, true, false, false, 'derived', 'legacy', null),
  ('ebay_fees',          'eBay Fees',              'money', 'Sales & Profit', 344, true, true,  false, 'manual',  null,     null),
  ('ebay_fee_pct_sales', 'eBay Fees % of Sales',   'pct',   'Sales & Profit', 346, true, true,  false, 'derived', 'legacy', null)
on conflict (metric_key) do nothing;

with sep as (
  select store, sum(np) np, sum(ebay_fee) ebay, sum(sales) sales
  from public.daily_np where date between '2026-09-01' and '2026-09-30'
  group by store
), rows as (
  select store, 'net_profit' k, round(np, 2) v from sep
  union all select store, 'ebay_fees', round(ebay, 2) from sep
  union all select store, 'net_profit_pct', round(np / nullif(sales, 0) * 100, 2) from sep
  union all select store, 'ebay_fee_pct_sales', round(ebay / nullif(sales, 0) * 100, 2) from sep
)
insert into public.monthly_brief (store, period_end_date, month, year, metric_key, value, updated_by)
select store, date '2026-09-30', 9, 2026, k, v, 'Net Profit tab' from rows
on conflict (store, period_end_date, metric_key) do nothing;
