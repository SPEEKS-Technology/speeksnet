-- ============================================================================
-- 0144 — Picture Quality: the nightly sweep, through the Batch API.
--
-- ⚠️ NOT APPLIED until Ethan says go (2026-10-11). This is the line that starts
-- the monthly spend (~$200/month at ~3,600 new listings a month — see the
-- estimate in the 2026-10-11 conversation), so it waits for a test batch to be
-- seen working first.
--
-- 1:10am Central: each store's NEW listings (created in the last 3 days, not yet
-- graded or changed since) go out as one batch — up to 200 a store, which is
-- several nights' listing at the busiest store.
-- Every 30 minutes: collect whatever has ended, save, and send follow-ups (a
-- re-sheet or a second look), which the next poll collects in turn.
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
    timeout_milliseconds := 140000);
$job$);

insert into public.cron_expectations (jobname, stale_after_min, note)
values ('pq-nightly-batch', 1560, 'Fires 1:10am Central once a day — allow 26h.'),
       ('pq-batch-poll', 90, 'Every 30 minutes — allow 90.')
on conflict (jobname) do update set stale_after_min = excluded.stale_after_min, note = excluded.note;
