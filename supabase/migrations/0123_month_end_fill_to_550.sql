-- ============================================================================
-- Month-end sales fill moves 6:50 -> 5:50 Central, the same day 0122 added it.
--
-- WHY. The last day of a month has to be finished BEFORE anything on the 1st
-- reads it, not just before the 7:00 alert (user, 2026-10-01: "we can't make our
-- goals or announcements on the 1st if the previous day wasn't filled out").
-- At 6:50 the 6:05 import had already synced Days Thru and the goal colours
-- against a month missing its final day, and the morning chain had gone out.
-- monthEnd reads Shopify, not the 6:00 mail, so nothing ties it to 6:00.
--
-- 5:50 against the Apps Script project's one LockService lock: 5:05
-- day-end-ingest calls action=dayEndFacts, which takes no lock and is done in
-- seconds. 6:05 import and 6:10 Net Profit are 15+ minutes clear. With the cells
-- already filled, the 6:05 run counts the day as `unverified`, not `missing`, so
-- neither pass alerts.
--
-- The Net Profit tab's final day is a separate fix, in the script and not here:
-- _npsPreClose in netprofit-schedule.gs has the 6:10 and 2pm passes write last
-- month too until it closes.
-- ============================================================================

select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'sales-month-end-fill-650am'),
  command := $$
  select net.http_post(
    url := 'https://script.google.com/macros/s/AKfycbxTQkoWLmrfGYro3kfSc4GqN2cvGDbtKOaoh_3kgXMv76E2tfOmTf0M21PxOQ-EYNL3/exec?secret=sp33ks-sync-k3y-2026-x9mq&action=monthEnd',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 5
      and extract(day  from (now() at time zone 'America/Chicago')) <= 3;
  $$
);
-- The job keeps its name ("650am"). Names can't be changed in place here, and
-- per 0096 the guard is the only authority on the hour. Read the guard, never
-- the name.
