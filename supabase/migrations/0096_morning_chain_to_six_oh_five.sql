-- ============================================================================
-- The morning chain moves from 8:00 to 6:05 Central — as early as the source
-- mail allows, and no earlier.
--
-- WHAT WAS ASKED (user, 2026-09-20): the Sales Summary update, the morning Net
-- Profit pass, the Processed Stats report and the cash email all at 5:00am
-- Central instead of 8:00.
--
-- ⚠️ 5:00 IS NOT POSSIBLE FOR HALF OF IT, AND THE REASON IS IN THE MAILBOX.
-- The two feeds do not arrive at the same time of day, which nothing in this
-- schedule had ever had to care about while everything sat at 8:00:
--
--   Day End Report      no-reply@pmdev.site     19:00-19:01 THE SAME EVENING
--     (all five stores, one hour after close, per the email's own preamble)
--   Daily Sales Report  ks01/mo01-mo04@paymore.com          06:00 SHARP
--     (all five stores, verified 09-19 and 09-20 via action=diagnose)
--
-- So buying, cash and Processed Stats could run at 5:00 — their mail has been
-- sitting there since the night before. The Sales Summary cannot: at 5:00 the
-- newest Daily Sales Report is YESTERDAY morning's, which carries the month
-- through the day before yesterday. sales-ingest would find nothing to write
-- for yesterday, count five stores missing, and fire the DM/CEO missing-data
-- alert every single morning. A schedule that cries wolf daily is worse than
-- the one it replaced.
--
-- Net Profit reads Shopify's API directly and could have gone at 5:05, but the
-- Sales Summary and the NET PROFIT tab are read as one picture (see
-- [[morning-reports-8am-central]]). Net Profit standing a day ahead of the
-- sheet beside it is a discrepancy to chase, not an early answer.
--
-- 6:05 CHOSEN, AND THE :00/:05/:10 SHAPE PRESERVED EXACTLY. 0088 spaced these
-- five minutes apart because they share one Apps Script LockService lock and
-- npsDailyRefresh holds it for its whole ~5-minute pass. That spacing is
-- carried across unchanged — only the hour moves:
--
--   was  8:00 sales-ingest / 8:05 netprofit / 8:10 processed / 9:00 retry
--   now  6:05 sales-ingest / 6:10 netprofit / 6:15 processed / 7:00 retry
--
-- Five minutes of air after the 06:00 mail is thin, but the send is a scheduled
-- one that has not moved, and the 7:00 retry is the net under it.
--
-- ⚠️ day-end-ingest HAD TO MOVE TOO, OR THE PROCESSED REPORT MAILS STALE ROWS.
-- processed-report only reads day_end_facts; it recomputes nothing. That table
-- was filled at 7:05am — AFTER the new 6:15 send. Left alone, the 6:15 email
-- would have gone out carrying the day before yesterday, silently and
-- correctly-looking. It moves to 5:05, which its 7pm mail has allowed all along.
--
-- And the pair becomes one guarded job. day-end-ingest-7am-cdt/cst were two
-- UTC-pinned jobs with NO Central-hour guard, so both fired every day — 7:05
-- and 8:05 in CDT. Harmless while the upsert is idempotent, but in CST the
-- earlier of the two would have landed on 6:05, the minute sales-ingest now
-- takes the lock: 0088's exact failure, waiting for November. One hourly job
-- with a guard cannot drift into it.
--
-- ⚠️ THE GUARD IS THE SCHEDULE HERE. pg_cron speaks only UTC, so the Central
-- hour lives in the `where extract(hour ...)` inside each command. sales-ingest's
-- own header records what happens when only the cron line is edited: the job
-- fires an hour outside the only hour it may act in, does nothing, and records
-- "succeeded". Both are changed together below, every time.
--
-- ⚠️ THE APPS SCRIPT PROJECT NOW OWNS :05 OF HOUR 5, :05 AND :10 OF HOUR 6, AND
-- :00 OF HOUR 7. Nothing else may be put on those minutes. (0088's note said
-- :00 of hours 8 and 9 and :05 of hours 8 and 14; the 2pm pass is unchanged.)
--
-- cron.alter_job, not a reschedule: Supabase grants alter_job but not UPDATE on
-- cron.job, and the jobids are referenced by name in cron_expectations.
-- ============================================================================

-- ── 5:05 — day-end-ingest, so day_end_facts is full before anything reads it ──
select cron.alter_job(
  job_id   := (select jobid from cron.job where jobname = 'day-end-ingest-7am-cdt'),
  schedule := '5 * * * *',
  command  := $cmd$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/day-end-ingest?secret=sp33ks-sync-k3y-2026-x9mq&trigger=cron',
    headers := '{"Content-Type":"application/json"}'::jsonb
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 5;
$cmd$);

-- The CST twin is what the guard replaces. Deactivated rather than unscheduled
-- so the job row, and this decision, stay readable in cron.job.
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'day-end-ingest-7am-cst'),
  active := false);

-- ── 6:05 — the Sales Summary write, and the cash email that rides on its end ──
select cron.alter_job(
  job_id   := (select jobid from cron.job where jobname = 'sales-ingest-7am-cdt'),
  schedule := '5 * * * *',
  command  := $cmd$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/sales-ingest?secret=sp33ks-sync-k3y-2026-x9mq&trigger=cron',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 6;
$cmd$);

-- ── 6:10 — Net Profit, five minutes behind the import, exactly as before ──────
select cron.alter_job(
  job_id   := (select jobid from cron.job where jobname = 'netprofit-8am'),
  schedule := '10 * * * *',
  command  := $cmd$
  select net.http_post(
    url := 'https://script.google.com/macros/s/AKfycbxTQkoWLmrfGYro3kfSc4GqN2cvGDbtKOaoh_3kgXMv76E2tfOmTf0M21PxOQ-EYNL3/exec?secret=sp33ks-sync-k3y-2026-x9mq&action=netprofit',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 6;
$cmd$);

-- ── 6:15 — Processed Stats. Still UTC-pinned in a cdt/cst pair, because it has
-- no other reason to wake up hourly; the guard picks which twin is allowed to
-- act. 6:15 CDT = 11:15 UTC, 6:15 CST = 12:15 UTC. ────────────────────────────
select cron.alter_job(
  job_id   := (select jobid from cron.job where jobname = 'processed-report-810am-cdt'),
  schedule := '15 11 * * *',
  command  := $cmd$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/processed-report?secret=sp33ks-sync-k3y-2026-x9mq&trigger=cron',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 6;
$cmd$);

select cron.alter_job(
  job_id   := (select jobid from cron.job where jobname = 'processed-report-810am-cst'),
  schedule := '15 12 * * *',
  command  := $cmd$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/processed-report?secret=sp33ks-sync-k3y-2026-x9mq&trigger=cron',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 6;
$cmd$);

-- ── 7:00 — the retry, kept one hour behind the main pass ──────────────────────
-- Not 7:05: day-end-ingest's CST twin used to sit there, and :05 of hour 7 is
-- the minute the old chain's lock contention lived on. :00 is clear, and it is
-- the minute this job has always used.
select cron.alter_job(
  job_id   := (select jobid from cron.job where jobname = 'sales-ingest-retry-cdt'),
  schedule := '0 * * * *',
  command  := $cmd$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/sales-ingest?secret=sp33ks-sync-k3y-2026-x9mq&trigger=retry&alert=1',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 7;
$cmd$);

-- ── The watchdog's account of when each of these is due ───────────────────────
update public.cron_expectations
   set note = 'Banks the Day End Report into day_end_facts. 5:05am Central (hourly at '
           || ':05, Central-hour guard = 5). Moved off 7:05 in 0096 because '
           || 'processed-report reads this table at 6:15 and recomputes nothing. The '
           || 'cst twin is deactivated — the guard replaced it.'
 where jobname = 'day-end-ingest-7am-cdt';

update public.cron_expectations
   set note = 'Sales Summary write + cash-report email. 6:05am Central (hourly at :05, '
           || 'guard = 6; the name says 7am, the guard is the truth). Five minutes after '
           || 'the 06:00 Daily Sales Report mail, which is the earliest this can run at '
           || 'all — see 0096.'
 where jobname = 'sales-ingest-7am-cdt';

update public.cron_expectations
   set note = 'Retry pass, 7:00am Central (guard = 7), carries &alert=1. One hour behind '
           || 'the main pass, which is the relationship it was built with: it is what '
           || 'sends the cash email when the 6:05 buying half broke.'
 where jobname = 'sales-ingest-retry-cdt';

update public.cron_expectations
   set note = 'NET PROFIT tab, morning pass: every column EXCEPT shipping. 6:10am Central '
           || '(hourly at :10, Central-hour guard = 6) — five minutes after sales-ingest, '
           || 'because both take the same Apps Script lock (see 0088, moved in 0096). '
           || 'Calls the sales-email-import web app with action=netprofit.'
 where jobname = 'netprofit-8am';
