-- ============================================================================
-- 0144 — Picture Quality: the nightly sweep, through the Batch API.
--
-- Applied 2026-10-11 on Ethan's go, after a 3-listing test batch and a
-- 40-listing one worked. This is what starts the monthly spend (~$200/month at
-- ~3,600 new listings a month — the 2026-10-11 estimate).
--
-- 1:10am Central: each store's NEW listings (created in the last 3 days, not yet
-- graded or changed since) go out as one batch — up to 200 a store, which is
-- several nights' listing at the busiest store.
-- Every 30 minutes from 1am to 9am Central ONLY (Ethan, 2026-10-11: grade
-- overnight, not through the day): collect whatever has ended, save, and send
-- follow-ups (a re-sheet or a second look), which the next poll collects. A
-- batch still running at 9:30 waits for the next night's polls — rare, since
-- batches have been finishing in minutes.
-- Both go through pg_net, which queues rather than blocks.
-- ============================================================================

select cron.unschedule('pq-nightly-batch') where exists (select 1 from cron.job where jobname = 'pq-nightly-batch');
select cron.schedule('pq-nightly-batch', '10 6,7 * * *', $job$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/picture-quality?sweep=200&batch=1&days=3&store='
           || s || '&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 140000)
  from (values ('OVL'),('LEE'),('WSP'),('MPL'),('BAL')) as t(s)
  where extract(hour from (now() at time zone 'America/Chicago')) = 1;
$job$);

select cron.unschedule('pq-batch-poll') where exists (select 1 from cron.job where jobname = 'pq-batch-poll');
select cron.schedule('pq-batch-poll', '*/30 * * * *', $job$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/picture-quality?poll=1&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 140000)
  where extract(hour from (now() at time zone 'America/Chicago')) between 1 and 9;
$job$);

insert into public.cron_expectations (jobname, stale_after_min, note)
values ('pq-nightly-batch', 1560, 'Fires 1:10am Central once a day — allow 26h.'),
       ('pq-batch-poll', 1020, 'Every 30 minutes, 1–9am Central only — a 15h daytime gap, so allow 17h.')
on conflict (jobname) do update set stale_after_min = excluded.stale_after_min, note = excluded.note;
