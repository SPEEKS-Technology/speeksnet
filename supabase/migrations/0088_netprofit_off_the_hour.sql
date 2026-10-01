-- ============================================================================
-- Net Profit's two daily passes move from :00 to :05, off the import's minute.
--
-- WHAT HAPPENED (2026-09-12). 0087 put netprofit-8am on '0 * * * *', the same
-- second as sales-ingest (jobid 8). Both call the SAME Apps Script project, and
-- one project is one LockService script lock:
--
--   08:00:06  the sales import takes the lock, fills Sep 11, releases it
--   ~08:01:40 npsDailyRefresh — waiting in _npWrite (NP_LOCK_WAIT_MS = 60s) —
--             takes it, and holds it for the WHOLE pass (~5 min: the collector
--             calls run inside the lock)
--   ~08:01:40 ingestBuyingEmails asks for it, waits 30s, gives up:
--             "another import is already running"
--
-- The sales half and Net Profit both landed, which is why the morning looked
-- mostly fine. Everything that rides on BUYING did not: the buying stats were
-- not written, the Day End Report emails were not read or archived, and with no
-- cash rows the cash email went to the CEO reading 0 of 5 stores.
--
-- WHY :05 IS ENOUGH, AND NOT A GUESS. The import's Apps Script run is ~90-100s
-- (08:00:02 -> 08:01:32 on 09-11). Starting Net Profit at :05 leaves three
-- minutes of air, and _npWrite then waits up to 60s more for the lock, so the
-- two can only meet if the import runs past 08:06 — which a web app execution
-- cannot, its hard limit being six minutes. The 9:00 retry is clear of both
-- (Net Profit is done by ~08:11). The shipping split is untouched: it keys off
-- the Central HOUR, and 14:05 is still hour 14.
--
-- ⚠️ ANYTHING NEW ON THIS APPS SCRIPT PROJECT AT :00 RE-OPENS THIS. The import
-- owns :00 of hours 8 and 9; Net Profit owns :05 of hours 8 and 14.
--
-- cron.alter_job, not a reschedule: Supabase grants alter_job but not UPDATE on
-- cron.job, and the jobids are referenced by name in cron_expectations.
-- ============================================================================

select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'netprofit-8am'),
                      schedule := '5 * * * *');
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'netprofit-2pm'),
                      schedule := '5 * * * *');

update public.cron_expectations
   set note = 'NET PROFIT tab, morning pass: every column EXCEPT shipping. 8:05am Central '
           || '(hourly at :05, Central-hour guard = 8) — five minutes after sales-ingest, '
           || 'because both take the same Apps Script lock (see 0088). Calls the '
           || 'sales-email-import web app with action=netprofit.'
 where jobname = 'netprofit-8am';

update public.cron_expectations
   set note = 'NET PROFIT tab, afternoon pass: adds shipping once the day''s labels are '
           || 'bought. 2:05pm Central (hourly at :05, guard = 14). Same call — '
           || 'npsDailyRefresh reads the clock to decide which pass it is.'
 where jobname = 'netprofit-2pm';
