-- ============================================================================
-- 0094 — stop `ebay_cron_health` timing out, by bounding the table underneath it.
--
-- THE SYMPTOM. Roughly five times a day since mid-September, ebay-alert mailed
-- its own worst alert:
--     "This error check is partly blind — we cannot read ebay_cron_health …
--      canceling statement due to statement timeout"
-- and then cleared on the next pass, so `ebay_alert_state` was empty by the time
-- anyone looked. Transient, self-healing, and mailed every single time.
--
-- WHERE IT COMES FROM, and it is not the view's logic. `ebay_cron_health` reads
-- `cron.job_run_details` to answer two questions per job — when did it last run,
-- and how often did it fail in the last hour. pg_cron NEVER PRUNES THAT TABLE.
-- It had 131,126 rows going back to 2026-06-10, 54 MB, and its only index is the
-- primary key on `runid` — nothing on `jobid` and nothing on `start_time`. So
-- every read of the view is a full sequential scan of the whole history: 6,531
-- buffers, ~500 ms warm, to produce seventeen rows.
--
-- WHY :00 AND :30 AND NO OTHER MINUTE. Every timeout in the logs landed at
-- HH:00:09 or HH:30:09 — PostgREST's 8-second statement_timeout plus the second
-- it took to start. `ebay-alert-watch` is `*/15`, and :00 and :30 are the only
-- minutes where it collides with `sync-buysell-10min` (`*/10`), the per-minute
-- Shopify refresh, the 5-minute notify drain and (at :00) eight hourly jobs. The
-- scan is 500 ms with the cache to itself and past 8 seconds when it is not. At
-- :15 and :45 the same query has never once timed out.
--
-- WHY NOT AN INDEX, WHICH IS THE OBVIOUS ANSWER. `cron.job_run_details` is owned
-- by `supabase_admin` and `postgres` has no CREATE on the `cron` schema, so we
-- cannot index it. We CAN delete from it and we have MAINTAIN on it, so the fix
-- has to be "make the table small" rather than "make the scan smart".
--
-- THE THING THAT MAKES A PURGE SAFE. ebay-alert distinguishes two facts with
-- different wording, deliberately (see 0045): a job that "last ran 40 hours ago"
-- and a job that "has never run since it was set up". A naive DELETE turns the
-- first into the second as soon as a dead job falls out of the window — still a
-- critical, but now a lie. So the purge writes each job's high-water mark to
-- `cron_run_archive` BEFORE deleting, and the view takes `greatest()` of the
-- live maximum and the archived one. Retention then costs nothing in meaning.
--
-- Keyed on `jobid`, not `jobname`, on purpose: pg_cron's jobid comes from a
-- sequence and is never reused, so a job that is dropped and recreated under the
-- same name gets a fresh id, finds no archive row, and correctly reads as new.
-- Keyed on the name it would inherit the dead job's last_run and read as healthy
-- — the 0044 false-alarm bug with the sign flipped, which is worse.
--
-- 7 days = 15,047 rows at today's 2,150/day, an 8.7x smaller scan, and still a
-- week of history to read by hand when something needs debugging.
-- ============================================================================

create table if not exists public.cron_run_archive (
  jobid      bigint primary key,
  jobname    text        not null,
  last_run   timestamptz not null,
  updated_at timestamptz not null default now()
);

comment on table public.cron_run_archive is
  'High-water mark of cron.job_run_details.start_time per job, written by purge_cron_run_details() just before it deletes. Exists so retention on that table cannot turn "last ran N hours ago" into "has never run".';

alter table public.cron_run_archive enable row level security;
-- No policies, same convention as cron_expectations (0044): the anon key is
-- public, and the only reader is a view owned by postgres.
revoke all on public.cron_run_archive from anon, authenticated;
grant select on public.cron_run_archive to service_role;

-- ---------------------------------------------------------------------------
create or replace function public.purge_cron_run_details(keep_days integer default 7)
returns integer
language plpgsql
set search_path = public, cron, pg_temp
as $fn$
declare
  deleted integer;
begin
  if keep_days is null or keep_days < 1 then
    raise exception 'keep_days must be >= 1, got %', keep_days;
  end if;

  -- ARCHIVE FIRST, DELETE SECOND, and never the other way round. If this
  -- statement fails the delete never runs and the next pass simply catches up;
  -- if the order were reversed, one failure would silently erase the only record
  -- that a dead job ever ran at all.
  insert into public.cron_run_archive (jobid, jobname, last_run, updated_at)
  select d.jobid, j.jobname, max(d.start_time), now()
    from cron.job_run_details d
    join cron.job j on j.jobid = d.jobid
   group by d.jobid, j.jobname
  on conflict (jobid) do update
     set jobname    = excluded.jobname,
         -- greatest(), not excluded.last_run: the archive must never move
         -- backwards, whatever the live table happens to hold this minute.
         last_run   = greatest(public.cron_run_archive.last_run, excluded.last_run),
         updated_at = now();

  delete from cron.job_run_details
   where start_time < now() - make_interval(days => keep_days);
  get diagnostics deleted = row_count;

  -- A job someone unscheduled leaves an archive row nothing joins to. Harmless,
  -- but it would accumulate for ever, which is the problem this file is about.
  delete from public.cron_run_archive a
   where not exists (select 1 from cron.job j where j.jobid = a.jobid);

  return deleted;
end
$fn$;

comment on function public.purge_cron_run_details(integer) is
  'Archives each job''s last start_time to cron_run_archive, then deletes cron.job_run_details rows older than keep_days. pg_cron never prunes that table and it has no index on jobid or start_time, so its size IS the cost of every ebay_cron_health read.';

revoke all on function public.purge_cron_run_details(integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Same shape as 0061, plus the archive. CREATE OR REPLACE, not DROP: the column
-- list is unchanged, so the grants survive — see the warning 0044 and 0045 both
-- carry about DROP VIEW resetting them and handing anon everything back.
--
-- greatest() ignores NULLs in Postgres, which is exactly what is wanted here:
-- a job with no archive row reads its live maximum, a job whose history has been
-- purged reads the archive, and a job that has genuinely never run reads NULL
-- and is described as never having run.
create or replace view public.ebay_cron_health as
select j.jobname,
       greatest(max(d.start_time), a.last_run) as last_run,
       count(*) filter (where d.status <> 'succeeded'
                          and d.start_time > (now() - interval '1 hour')) as failures_1h,
       e.stale_after_min,
       e.watching_since
  from cron.job j
  left join cron.job_run_details d on d.jobid = j.jobid
  left join public.cron_expectations e on e.jobname = j.jobname
  left join public.cron_run_archive  a on a.jobid   = j.jobid
 where j.active
   and (j.command ilike '%ebay%' or e.jobname is not null)
 group by j.jobname, e.stale_after_min, e.watching_since, a.last_run;

comment on view public.ebay_cron_health is
  'Per-job staleness for the eBay crons, read by ebay-alert. Inactive jobs are excluded: an intentionally-paused job must not read as a failure. last_run is the greater of what cron.job_run_details still holds and what purge_cron_run_details() archived before trimming it, so retention on that table never turns a stale job into a never-run one.';

revoke all on public.ebay_cron_health from anon, authenticated;
grant select on public.ebay_cron_health to service_role;

-- ---------------------------------------------------------------------------
-- TWO JOBS, NOT ONE, BECAUSE VACUUM CANNOT RUN IN A TRANSACTION. pg_cron wraps a
-- multi-statement command in one, so `select purge(); vacuum …` would fail every
-- night. Split exactly like pgnet-response-compact-weekly, which is the same
-- problem solved for net._http_response.
--
-- A DELETE alone would not have fixed this. It frees tuples but not pages: the
-- heap stays 6,531 pages of mostly-dead rows and the sequential scan keeps
-- reading every one of them. VACUUM FULL is what returns the space, and it is
-- why MAINTAIN on the table mattered.
--
-- Minutes chosen to miss the pile-ups. Nothing else in this project fires at :13
-- or at :50, and neither job may land on :00 or :30 — those are the two minutes
-- that caused this bug.
select cron.schedule('cron-run-details-purge', '13 5 * * *',
  $job$select public.purge_cron_run_details(7);$job$);

select cron.schedule('cron-run-details-compact-weekly', '50 8 * * 0',
  $job$vacuum (full, analyze) cron.job_run_details$job$);

-- ⚠️ THE WATCHDOG MUST WATCH ITS OWN PLUMBING. If the purge silently stops, the
-- table grows back and this bug returns months later looking brand new. A
-- cron_expectations row is what puts a non-eBay job in ebay_cron_health's scope
-- (0044), so these two lines are the whole mechanism.
--
-- Allowances sized the way 0072 insists: the cadence plus real headroom, because
-- an allowance that is merely equal to the cadence fires a permanent critical.
-- 1560 = 26h for a daily, matching the callback-* rebuilds. 11520 = 8 days for a
-- weekly. IF EITHER SCHEDULE ABOVE CHANGES, THESE MUST CHANGE WITH IT.
insert into public.cron_expectations (jobname, stale_after_min, note)
values
  ('cron-run-details-purge', 1560,
   'Daily 05:13 UTC. Trims cron.job_run_details to 7 days. If this stops, the table grows unbounded and ebay_cron_health starts timing out under load again — the bug 0094 fixed.'),
  ('cron-run-details-compact-weekly', 11520,
   'Sundays 08:50 UTC. VACUUM FULL on cron.job_run_details — the purge frees tuples, this returns the pages. Without it the sequential scan keeps reading the old heap size.')
on conflict (jobname) do update
  set stale_after_min = excluded.stale_after_min,
      note = excluded.note;
