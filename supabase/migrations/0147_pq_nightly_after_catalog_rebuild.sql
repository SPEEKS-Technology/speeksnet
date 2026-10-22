-- ============================================================================
-- 0147 — Picture Quality: the nightly moves to 3:10am Central, after the
-- catalog rebuild.
--
-- Ethan, 2026-10-16: "Did all 3 stores not list 10 items yesterday?" The first
-- all-store nightly (10-16) sent BAL 6, WSP 6, LEE 4. The sweep picks from
-- ebay_catalog, and at 1:10am that table was last refreshed at 3pm the day
-- before (callback-catalog-refresh runs 9am / 12pm / 3pm only). BAL had 31
-- eligible listings from that day, but the run could see only about 6.
-- callback-catalog-rebuild (full=1) fires at 2am Central and had rewritten all
-- five stores within that hour, so 3:10 sees the whole day. LEE and WSP really
-- did list few (3-4 and ~7 eligible).
--
-- The poll (1–9am, 0144) still collects; a 3:10 batch has nearly six hours.
-- Same UTC pair + Chicago-hour guard as 0144, so DST needs no edit.
-- ============================================================================

select cron.unschedule('pq-nightly-batch') where exists (select 1 from cron.job where jobname = 'pq-nightly-batch');
select cron.schedule('pq-nightly-batch', '10 8,9 * * *', $job$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/picture-quality?sweep=200&batch=1&days=3&store='
           || s || '&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 140000)
  from (values ('OVL'),('LEE'),('WSP'),('MPL'),('BAL')) as t(s)
  where extract(hour from (now() at time zone 'America/Chicago')) = 3;
$job$);

update public.cron_expectations set note = 'Fires 3:10am Central once a day (after the 2am catalog rebuild) — allow 26h.'
where jobname = 'pq-nightly-batch';
