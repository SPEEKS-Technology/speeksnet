-- ============================================================================
-- Net Profit: the two daily passes move from Apps Script triggers to pg_cron.
--
-- WHY. The refresh ran at 8:46am, not 8:00. ScriptApp's .atHour(8) does not
-- mean 8:00 — it means "somewhere inside the 8 o'clock hour" and Google picks
-- the minute. It had settled on :46 and was holding there (2026-09-10 started
-- 13:46:15Z, 2026-09-11 started 13:46:17Z — two seconds apart, so stable, just
-- not eight o'clock). The Sales Summary is already pg_cron and lands at
-- 13:00:00Z on the second, so the two reports sat 46 minutes apart.
--
-- Next month Net Profit stands alone and the Sales Summary retires, so the 8am
-- pass has to be punctual on its own. Tightening the Apps Script trigger with
-- .nearMinute(0) would still leave a +/-15 minute window AND would be thrown
-- away in October, so it moves to cron now.
--
-- WHICH PASS IS WHICH IS NOT SET HERE. npsDailyRefresh reads the Central hour
-- off the clock and sets NP_SKIP_SHIP from it: before 14 writes everything
-- except shipping, 14 or later writes shipping final. So these two jobs differ
-- ONLY in their guard hour and the function cannot be told the wrong thing.
-- ⚠️ Moving a job across 14:00 Central silently changes what it writes.
--
-- HOURLY SCHEDULE, CENTRAL-HOUR GUARD — the same pattern as migration 0086 and
-- for the same reason: pg_cron speaks UTC, exactly one firing per day lands in
-- a given Central hour whatever the offset, so DST cannot misalign it and there
-- is no -cdt/-cst twin to keep in step. The hour appears once, in the guard.
--
-- THE OLD TRIGGERS OUTLIVE THIS MIGRATION ON PURPOSE. Removing them first would
-- leave the reports with no schedule at all if cron turned out not to fire, so
-- they stay armed for one cycle as a backstop and each pass simply runs twice —
-- once here on time, once at Google's :46. That is safe because the refresh
-- rewrites month-to-date from scratch rather than appending, and the two runs
-- are 45 minutes apart so they never overlap. Both land on the same side of the
-- 14:00 shipping cutoff, so the duplicate is the same pass, not a different one.
--
-- Once a cron firing has been seen in the logs, run npsInstallTriggers() from
-- the editor; it now installs only the 7pm month close. npsStatus() then expects
-- ZERO npsDailyRefresh triggers, and the duplicate stops.
-- ============================================================================

-- The web app is the same /exec sales-ingest already calls; only the action is
-- new. ⚠️ Editing the Apps Script does NOT change what /exec serves — a new
-- deployment VERSION must be published, or these jobs get back
-- {"ok":false,"error":"unknown action \"netprofit\""}, which is the allowlist
-- doing its job rather than silently running a sales import.
--
-- ⚠️ THE WEB APP RETURNS IMMEDIATELY. It does not run the refresh; it creates a
-- one-off trigger and hands back {"ok":true,"scheduled":"npsDailyRefresh"} in
-- under a second. Running it inline was tried first and died at 6m04s —
-- "Exceeded maximum execution time", because a web app execution gets six
-- minutes and the pass no longer fits in them (five collector calls alone took
-- 5m24s on 2026-09-11). A trigger execution is a fresh six minutes, which is the
-- budget this job has always run in.
--
-- So 30s is ample and a timeout here means the CALL failed, not the refresh —
-- which is the useful thing to be told.
select cron.schedule(
  'netprofit-8am',
  '0 * * * *',
  $job$
  select net.http_post(
    url := 'https://script.google.com/macros/s/AKfycbxTQkoWLmrfGYro3kfSc4GqN2cvGDbtKOaoh_3kgXMv76E2tfOmTf0M21PxOQ-EYNL3/exec?secret=sp33ks-sync-k3y-2026-x9mq&action=netprofit',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 8;
$job$);

select cron.schedule(
  'netprofit-2pm',
  '0 * * * *',
  $job$
  select net.http_post(
    url := 'https://script.google.com/macros/s/AKfycbxTQkoWLmrfGYro3kfSc4GqN2cvGDbtKOaoh_3kgXMv76E2tfOmTf0M21PxOQ-EYNL3/exec?secret=sp33ks-sync-k3y-2026-x9mq&action=netprofit',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 14;
$job$);

-- ---------------------------------------------------------------------------
-- THE WATCHDOG. Registered for the same reason sales-ingest was in 0086: a job
-- that quietly stops firing looks exactly like one with nothing to do. Net
-- Profit has no downstream email of its own to go missing, so without this a
-- dead 8am pass shows up as a tab that simply stopped moving — which is what
-- somebody notices a week later, not the next morning.
--
-- 8am and a 2pm pass, so anything past ~26h means a day was missed.
-- ---------------------------------------------------------------------------
insert into public.cron_expectations (jobname, stale_after_min, note) values
  ('netprofit-8am', 1560,
   'NET PROFIT tab, morning pass: every column EXCEPT shipping. 8:00am Central, '
   || 'hourly firing with a Central-hour guard = 8. Calls the sales-email-import '
   || 'web app with action=netprofit.'),
  ('netprofit-2pm', 1560,
   'NET PROFIT tab, afternoon pass: adds shipping once the day''s labels are '
   || 'bought. 2:00pm Central, guard = 14. Same call — npsDailyRefresh reads the '
   || 'clock to decide which pass it is.')
on conflict (jobname) do update
  set stale_after_min = excluded.stale_after_min,
      note            = excluded.note;
