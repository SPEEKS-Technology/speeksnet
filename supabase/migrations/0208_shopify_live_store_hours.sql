-- 0208 — Shopify live refresh runs in store hours only, plus one 7am pass
-- (Ethan, 2026-11-25).
--
-- WHY: Supabase warned on 11-24 that the project is using up its Disk IO budget
-- (Micro compute). The database itself is tiny and sits in memory; the steady
-- load is background-job churn — every cron run writes a cron.job_run_details
-- row (updated three times), a net.http_request_queue row and a
-- net._http_response row, and each is deleted again later. shopify-live-refresh
-- was the busiest job by far: every minute, 24/7, 1,440 runs a day, although
-- the function itself only does real work 8am–9pm and outside that just checks
-- whether the cache is an hour stale.
--
-- TWO LAYERS, because a WHERE clause alone saves nothing on the cron side:
-- pg_cron logs a job_run_details row for every firing even when the WHERE
-- matches no rows. So the cron expression (pg_cron runs in GMT here) is the
-- UTC union of both DST offsets — hours 15-01 UTC, Mon-Sat UTC — which is what
-- cuts the firings, and the WHERE pins the exact Chicago hours inside it so
-- DST needs no second job. Chicago Mon-Fri evenings fall on Tue-Sat 00-01 UTC,
-- hence 1-6 covers Friday night too; the few Sunday-evening (Mon 00-01 UTC)
-- firings are the only ones the WHERE throws away.
--
-- NOW (America/Chicago):
--   shopify-live-refresh  every minute, Mon–Fri 10:00–19:59, Sat 10:00–16:59.
--                         That is trading hours (shopify-live's isTrading:
--                         Mon–Fri 10–7, Sat 10–4, closed Sunday) plus the hour
--                         after close, so the last tickets and refunds at
--                         close still land on the Live Dashboard.
--   shopify-live-morning  once a day at 7:00, every day, so anyone opening the
--                         app before the doors open sees this morning's
--                         numbers, not last night's. The function refreshes on
--                         this call because the cache is over an hour stale.
-- About 570 firings a day on average instead of 1,440. The 7am job fires at
-- 12 and 13 UTC and keeps whichever one is 7am Central.
--
-- Nothing else reads app_cache/shopify_live — only shopify-live's own read
-- path for the browser — so no scheduled tool depends on the overnight passes.
-- In store hours the Live Dashboard updates exactly as often as before.
--
-- To restore round-the-clock: re-schedule shopify-live-refresh with the old
-- command (no WHERE clause) and unschedule shopify-live-morning.

select cron.unschedule('shopify-live-refresh') where exists (select 1 from cron.job where jobname = 'shopify-live-refresh');
select cron.schedule('shopify-live-refresh', '* 0-1,15-23 * * 1-6', $$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/shopify-live?secret=sp33ks-sync-k3y-2026-x9mq',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 25000)
  from (select extract(isodow from now() at time zone 'America/Chicago') as dow,
               extract(hour   from now() at time zone 'America/Chicago') as hr) t
  where (t.dow between 1 and 5 and t.hr between 10 and 19)
     or (t.dow = 6            and t.hr between 10 and 16);
$$);

select cron.unschedule('shopify-live-morning') where exists (select 1 from cron.job where jobname = 'shopify-live-morning');
select cron.schedule('shopify-live-morning', '0 12,13 * * *', $$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/shopify-live?secret=sp33ks-sync-k3y-2026-x9mq',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 25000)
  where extract(hour from now() at time zone 'America/Chicago') = 7;
$$);
