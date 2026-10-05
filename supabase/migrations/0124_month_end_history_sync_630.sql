-- ============================================================================
-- An extra buysell-history-sync at 6:30 Central on the 1st-3rd, so records-watch
-- can judge the last day of the month.
--
-- WHY. records-watch (6:40) judges exactly one day, lastOpenDay(today), which on
-- the 1st is the month's last day. It reads daily_buysell. On the 1st nothing
-- has put that day there yet:
--   * capture_daily_buysell() copies only the CURRENT month out of the hub cache.
--     On the 1st that is the new month, so it cannot reach the 30th/31st.
--   * buysell-history-sync (prev + current month from the workbook) is the
--     thing that does, but it ran at 9:00, after records-watch had been and gone.
-- On 2026-10-01, 9/30 sat in daily_buysell with sell = 0, so records-watch
-- waited at 6:40 and 7:40. On the 2nd it judges 10/1 and never looks back, so the
-- last day of every month was never checked for a record (user, 2026-10-01:
-- the last day of the month must not be impacted by anything).
--
-- WHEN. 6:30 is after everything that fills that day in the workbook (5:50
-- monthEnd sales from Shopify, 0122/0123; 6:05 import, which writes buying from
-- the Day End mail) and before records-watch at 6:40. buysell-history.gs is its
-- own Apps Script project, so this does not touch the sales-import project's
-- script lock. The 9:00 run (jobs 25/26) is unchanged. Hour-guarded like the
-- rest: read the guard, not the name.
-- ============================================================================

select cron.schedule(
  'buysell-history-month-end-630am',
  '30 * * * *',
  $$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/buysell-history-sync?secret=sp33ks-sync-k3y-2026-x9mq',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 6
      and extract(day  from (now() at time zone 'America/Chicago')) <= 3;
  $$
);
