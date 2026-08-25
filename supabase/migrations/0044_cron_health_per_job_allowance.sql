-- Supersedes 0039_ebay_cron_health_view.sql. Read that one first; this changes
-- what the view MEANS, so 0039 on its own is now misleading.
--
-- WHAT WENT WRONG. ebay-alert judges every row this view returns against one
-- threshold, CRON_STALE_MIN = 30 minutes. That is right for an order poll that
-- runs every two minutes and wrong for anything slower. 0039 also scoped the
-- view by `command ILIKE '%ebay%'` — a match on the SQL text, not on ownership —
-- so when the Call Back matcher's jobs were added on 2026-08-21 and two of them
-- called ebay-catalog three times a day, the eBay watchdog adopted them on
-- creation and mailed "Scheduled job stopped" within fifteen minutes. They were
-- not stopped. They had not reached their first fire.
--
-- THE FIX, AND WHY IT IS HERE RATHER THAN IN THE FUNCTION. The honest place for
-- a per-job threshold is ebay-alert's check 6. But that function is 700 lines
-- containing a systemic-error regex, two GraphQL documents and an HTML mail
-- builder, and it can only be redeployed whole — so a transcription slip while
-- editing it would land silently in the parts that decide which real failures
-- get mailed. This is the smaller, safer surface for the same outcome.
--
-- So the view's contract becomes "the rows the watchdog should JUDGE", not
-- "every job's status", and it is named in the comment below so the next reader
-- is not surprised. A job with a cron_expectations row is omitted while it is
-- healthy by its OWN allowance and appears only when genuinely overdue or
-- failing. eBay's own fast jobs are returned unconditionally, exactly as before.
--
-- Everything the watchdog then prints stays literally true: every allowance is
-- well over 30 minutes, so a job surfaced as overdue really does have a
-- last_run older than the function's threshold, and one that has never run past
-- its grace window still reports NULL and is described as such.
--
-- IF ebay-alert IS EVER EDITED FOR ANOTHER REASON: move the comparison into it
-- (read stale_after_min and watching_since, default to CRON_STALE_MIN) and
-- simplify this back to a plain health view. That is the better end state.

create table if not exists public.cron_expectations (
  jobname          text primary key,
  stale_after_min  integer not null check (stale_after_min > 0),
  -- Set on insert, never touched again. A job that has NEVER run is only a
  -- problem once it has had long enough to run — without this, every new job is
  -- "stopped" for the minutes between being scheduled and first firing.
  watching_since   timestamptz not null default now(),
  note             text
);

alter table public.cron_expectations enable row level security;
-- No policies, by convention: the anon key is public and every reader here is an
-- edge function on the service role.
revoke all on public.cron_expectations from anon, authenticated;
grant select on public.cron_expectations to service_role;

insert into public.cron_expectations (jobname, stale_after_min, note) values
  ('callback-catalog-refresh',  1200, 'Fires 9:28/12:28/15:28 Central — an 18h gap overnight, so allow 20h.'),
  ('callback-match-sweep',      1200, 'Fires 9:30/12:30/15:30 Central — same overnight gap.'),
  ('callback-catalog-rebuild',  1560, 'Daily at 2am Central — a 24h gap by design, so allow 26h.'),
  ('callback-match-rebuild',    1560, 'Daily at 2:40am Central — same.')
on conflict (jobname) do update
  set stale_after_min = excluded.stale_after_min,
      note = excluded.note;

-- DROP, not CREATE OR REPLACE: the column list changes shape between the two
-- definitions and Postgres refuses to replace a view whose columns move.
drop view public.ebay_cron_health;

create view public.ebay_cron_health as
with runs as (
  select j.jobname,
         j.command,
         max(d.start_time) as last_run,
         count(*) filter (
           where d.status <> 'succeeded' and d.start_time > now() - interval '1 hour'
         ) as failures_1h
  from cron.job j
  left join cron.job_run_details d on d.jobid = j.jobid
  group by j.jobname, j.command
)
select r.jobname, r.last_run, r.failures_1h
from runs r
left join public.cron_expectations e on e.jobname = r.jobname
where
  -- A job nobody wrote an expectation for: unchanged behaviour, always judged.
  (e.jobname is null and r.command ilike '%ebay%')
  -- A job with an allowance: surfaced only when it has actually missed it.
  or (e.jobname is not null and (
        r.failures_1h > 0
        or coalesce(r.last_run, e.watching_since)
             < now() - make_interval(mins => e.stale_after_min)
     ));

comment on view public.ebay_cron_health is
  'Cron jobs the eBay error watch should JUDGE, not every job''s health. Jobs with a cron_expectations row are omitted while healthy by their own allowance; eBay jobs are always returned and judged against the function''s 30-minute default.';

-- ⚠️ DROP VIEW RESETS GRANTS to the schema default, which here hands anon and
-- authenticated everything back. 0039 revoked them because the anon key is
-- public and this view exposes the internal cron schedule; replacing the view
-- silently undid that, and it was only caught by checking afterwards. Any future
-- redefinition of this view must repeat these two lines.
revoke all on public.ebay_cron_health from anon, authenticated;
grant select on public.ebay_cron_health to service_role;
