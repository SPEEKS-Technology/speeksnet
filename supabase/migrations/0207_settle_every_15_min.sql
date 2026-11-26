-- 0207 — fixed cards settle on the 5-minute check's grades (Ethan, 2026-11-24).
--
-- listing-review?settle=1 read the overnight re-grade only, 4–10am CT. With the
-- overnight re-grade off and the 5-minute picture check (0206) re-grading a
-- re-shot listing by itself, a card a store marked fixed now settles on ANY grade
-- newer than fixed_at (the function reads status fixed as well as regrading), and
-- it runs every 15 minutes, 4am–10pm CT, so the store hears within the hour
-- instead of next morning. Free: it only reads saved grades.
select cron.unschedule('listing-review-settle') where exists (select 1 from cron.job where jobname = 'listing-review-settle');
select cron.schedule('listing-review-settle', '*/15 * * * *', $$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/listing-review?settle=1&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 140000)
  where extract(hour from (now() at time zone 'America/Chicago')) between 4 and 22;
$$);
