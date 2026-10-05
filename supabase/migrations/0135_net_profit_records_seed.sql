-- ============================================================================
-- 0135 — start the Monthly Net Profit Record at September 2026 for every store.
--
-- Ethan 2026-10-02: "start every store's record as their September net profit
-- numbers". September is the first month the Net Profit tab is trusted (August
-- was thrown out by the eBay/Shopify mass-refund mix-up), so it is the floor.
-- The figures are monthly_brief net_profit (0131), which is daily_np summed off
-- the NP tab — the same source records-watch reads, so its ratchet compares like
-- with like and only a strictly bigger month moves one.
--
-- Company is the five added up ($214,617), the same rule records-watch uses
-- (a Company NP only for months every store has one).
--
-- Text is money0 like the GP records ("$55,361"); value_num keeps the cents so
-- the ratchet compares raw. record_on = the month, as records-watch writes it.
-- Idempotent: a store that already has the record is left alone.
-- ============================================================================

insert into public.records (store, label, value, period, value_num, record_on)
select s.store, 'Monthly Net Profit Record',
       '$' || to_char(round(s.np), 'FM999,999,990'), 'September 2026', s.np, date '2026-09-01'
from (
  select store, value::numeric np from public.monthly_brief
  where year = 2026 and month = 9 and metric_key = 'net_profit'
  union all
  select 'Company', sum(value::numeric) from public.monthly_brief
  where year = 2026 and month = 9 and metric_key = 'net_profit'
  having count(*) = 5
) s
where not exists (
  select 1 from public.records r
  where r.store = s.store and r.label = 'Monthly Net Profit Record' and r.person is null
);
