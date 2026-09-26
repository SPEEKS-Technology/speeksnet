-- ============================================================================
-- 0086 — the sales ingest run time lives in ONE place per job.
--
-- Applied by hand on 2026-09-10 and recorded here so the repo matches the
-- database. Idempotent: re-running it is a no-op.
--
-- WHAT BROKE. On 2026-09-09 the ingest moved from 7:00am to 8:00am Central so
-- the Sales Summary would land with the NET PROFIT tab. The run time lived in
-- FOUR places — a -cdt schedule, a -cst schedule (a hand-maintained DST table,
-- since pg_cron only speaks UTC) and a Central-hour guard inside each job's
-- own command. The move edited the two schedules and neither guard:
--
--     jobid  8   0 13   fired 8am CDT, guard said 7   -> no-op
--     jobid  9   0 14   fired 9am CDT, guard said 7   -> no-op
--     jobid 10   0 14   fired 9am CDT, guard said 8   -> no-op
--     jobid 11   0 15   fired 10am CDT, guard said 8  -> no-op
--
-- Every job fired an hour after the only hour it was permitted to act in, did
-- nothing, and recorded "succeeded". On 2026-09-10 the Sales Summary write and
-- the cash-report email were both lost. Recovered by hand; store_cash for
-- 2026-09-09 was backfilled from the Apps Script buying import and the empty
-- cash_report_sends row was cleared so a correct email could go out.
--
-- WHY NOTHING ALERTED, which matters more than the typo. The alert lives inside
-- the retry job (&alert=1), so it can only sound if the run happens. An alarm
-- inside the thing it is meant to watch is not a watchdog. And cron_expectations
-- — which does exist and does drive the cron-health view — had never had these
-- jobs registered, so nine days of silence would have gone unnoticed just as
-- easily as one.
--
-- THE FIX IS THE SHAPE, NOT THE NUMBER. Schedule HOURLY and let the
-- Central-hour guard be the only authority. Exactly one firing a day lands in
-- the guarded hour whatever the offset is — verified over the following 398
-- days, across both DST transitions, always exactly once and never twice — so
-- the DST twins are unnecessary and the hour appears once, in one place. The
-- other 23 firings evaluate one `extract` and do nothing. capture-daily-buysell
-- has run '0 * * * *' for the same reason since the beginning.
-- ============================================================================

-- Main pass, 8:00am Central.
select cron.alter_job(8,
       schedule := '0 * * * *',
       command  := regexp_replace(command, '= 7;', '= 8;'))
  from cron.job where jobid = 8 and schedule <> '0 * * * *';

-- Retry pass, 9:00am Central (carries &alert=1).
select cron.alter_job(10,
       schedule := '0 * * * *',
       command  := regexp_replace(command, '= 8;', '= 9;'))
  from cron.job where jobid = 10 and schedule <> '0 * * * *';

-- The DST twins can never match a guard again. Left in place rather than
-- dropped so this is reversible and the history stays readable.
select cron.alter_job(9,  active := false) from cron.job where jobid = 9  and active;
select cron.alter_job(11, active := false) from cron.job where jobid = 11 and active;

-- The watchdog, from OUTSIDE the jobs it watches. 8:00am plus a 9:00am retry,
-- so anything past ~26h means a day was missed.
insert into public.cron_expectations (jobname, stale_after_min, note) values
  ('sales-ingest-7am-cdt',   1560,
   'Sales Summary write + the cash-report email. 8:00am Central — the name '
   || 'still says 7am because Supabase grants cron.alter_job but not UPDATE on '
   || 'cron.job, so the schedule could be moved and the label could not. Read '
   || 'the schedule, never the name.'),
  ('sales-ingest-retry-cdt', 1560,
   'Retry pass for the above, 9:00am Central, carries &alert=1.'),
  ('day-end-ingest-7am-cdt', 1560,
   'Banks the PayMore Day End Report into day_end_facts. 7:05am Central.')
on conflict (jobname) do update
  set stale_after_min = excluded.stale_after_min,
      note            = excluded.note;
