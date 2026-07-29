-- ============================================================================
-- Daily outreach sweep, 8:30am Chicago.
--
-- Two UTC schedules, each gated on the local hour, so exactly one of them clears
-- the guard on any given day and the digest lands at the same local time through
-- both halves of the year. Same pattern as weekly-report-mon-cdt / -cst.
--
-- The sweep is a no-op unless a client is actually due, so this stays silent
-- until someone sets a cadence.
--
-- Applied via Supabase MCP `execute_sql` (cron.schedule is a function call, not
-- DDL). Recorded here so the schedule lives in the repo rather than only in the
-- database.
-- ============================================================================

select cron.schedule('b2b-outreach-daily-cdt', '30 13 * * *', $job$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/b2b-outreach?secret=sp33ks-sync-k3y-2026-x9mq',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 8;
$job$);

select cron.schedule('b2b-outreach-daily-cst', '30 14 * * *', $job$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/b2b-outreach?secret=sp33ks-sync-k3y-2026-x9mq',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 8;
$job$);
