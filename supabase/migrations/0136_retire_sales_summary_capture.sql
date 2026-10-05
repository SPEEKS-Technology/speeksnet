-- ============================================================================
-- 0136 — retire the Sales Summary import, part 1: the database side.
--
-- Ethan 2026-10-02: "delete all of the old sales summary automation so I can
-- delete those tabs for October". The Net Profit tab (daily_np, mirrored every
-- 15 min by np-sync) is the selling source from October 2026.
--
-- 1. capture_daily_buysell() — THE TRAP docs/sales-summary-retirement.md names.
--    It copies the hub's wkSell / wkGP arrays (read off the "Sales Oct 26" tab)
--    into daily_buysell every hour. With the tab deleted the hub sends no
--    arrays, and the old function would have written NULL over every October
--    day's sell and gp — the Daily Sell record, the daily brief and the
--    Live dashboard's comparisons all read those columns.
--
--    From 2026-10-01 sell and gp come from daily_np instead. Checked before the
--    switch: Sep 28 – Oct 1, all five stores, the two sources agree to the cent
--    on both columns. A day the NP tab has not reached keeps whatever it already
--    had (0 on a new row, which is what the hub wrote for an unkeyed day), so a
--    morning before the 6:10 pass never blanks a figure. Before October nothing
--    changes: the hub path is kept as it was.
--
-- 2. Unschedules the jobs whose only work was the Sales / Summary tabs:
--      73  sales-month-end-fill-650am  (fills the last day of the Sales tab)
--      21  summary-weekly-mon-cdt      (the weekly Summary tab)
--      22  summary-weekly-mon-cst
--    Jobs 8/10 (sales-ingest) STAY: they carry buying, reviews and cash. The
--    function itself is switched to buying-only in the same change.
-- ============================================================================

create or replace function public.capture_daily_buysell()
 returns void
 language sql
 security definer
 set search_path to 'public'
as $function$
  with h as (select payload as p from app_cache where key = 'buy_sell_hub'),
  d as (select (now() at time zone 'America/Chicago')::date as today),
  mo as (select extract(year from today)::int as y, extract(month from today)::int as mth, extract(day from today)::int as dmax from d),
  src as (
    select make_date(mo.y, mo.mth, gs.day) as dt, s.store,
           nullif(h.p->'wkBuy'->s.store->>(gs.day - 1), '')::numeric as buy,
           nullif(h.p->'wkSell'->s.store->>(gs.day - 1), '')::numeric as hub_sell,
           nullif(h.p->'wkGP'->s.store->>(gs.day - 1), '')::numeric as hub_gp,
           nullif(h.p->'wkBuyMarginPct'->s.store->>(gs.day - 1), '')::numeric as buy_margin_pct
    from h, mo,
         (values ('OVL'), ('LEE'), ('WSP'), ('MPL'), ('BAL')) as s(store),
         generate_series(1, mo.dmax) as gs(day)
  )
  insert into public.daily_buysell (date, store, buy, sell, gp, buy_margin_pct)
  select src.dt, src.store, src.buy,
         case when src.dt >= date '2026-10-01' then coalesce(n.sales, b.sell, 0) else src.hub_sell end,
         case when src.dt >= date '2026-10-01' then coalesce(n.gp,    b.gp,   0) else src.hub_gp   end,
         src.buy_margin_pct
  from src
  left join public.daily_np n on n.date = src.dt and n.store = src.store
  left join public.daily_buysell b on b.date = src.dt and b.store = src.store
  on conflict (date, store) do update set
    buy = excluded.buy, sell = excluded.sell, gp = excluded.gp,
    buy_margin_pct = excluded.buy_margin_pct, captured_at = now()
  where (daily_buysell.buy, daily_buysell.sell, daily_buysell.gp, daily_buysell.buy_margin_pct)
     is distinct from (excluded.buy, excluded.sell, excluded.gp, excluded.buy_margin_pct);
$function$;

select cron.unschedule(j) from unnest(array[
  'sales-month-end-fill-650am', 'summary-weekly-mon-cdt', 'summary-weekly-mon-cst'
]) j
where exists (select 1 from cron.job where jobname = j);
