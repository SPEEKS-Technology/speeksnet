-- Supersedes 0044's version of the view. Read 0039 and 0044 first.
--
-- 0044 put the per-job staleness comparison INSIDE this view, because ebay-alert
-- was 700 lines that could only be redeployed whole and the risky parts of it
-- (the systemic-error regex, two GraphQL documents, the HTML mail builder) are
-- where a transcription slip would land silently. 0044 said, in writing, that
-- the comparison belonged in the function and to move it there the next time
-- that function was edited for another reason.
--
-- That happened the same day: ebay-alert v14 rewrote every alert message in
-- plain English with a "who can fix this" tag, and took the comparison with it.
-- So the view goes back to being what its name says — the facts, plus the
-- expectation, and no opinion.
--
-- ⚠️ THE BUG IN BETWEEN, because it is the instructive part. 0044's version had
-- dropped `stale_after_min` and `watching_since` from the column list (it did
-- not need them once it was filtering internally). v14 selects them. So every
-- run failed the read outright and the watchdog reported ITSELF as blind:
-- `"ebay_cron_health": -1`. It was right to. A view and the function selecting
-- from it are ONE CONTRACT IN TWO FILES, and changing either half alone breaks
-- it — the only reason this was caught in ninety seconds instead of at the next
-- real outage is that read() treats a failed read as a critical alert rather
-- than as an empty result.
drop view public.ebay_cron_health;

create view public.ebay_cron_health as
select j.jobname,
       max(d.start_time) as last_run,
       count(*) filter (
         where d.status <> 'succeeded' and d.start_time > now() - interval '1 hour'
       ) as failures_1h,
       -- NULL for the fast eBay jobs, which is the signal to fall back to the
       -- function's CRON_STALE_MIN. A row in cron_expectations overrides it.
       e.stale_after_min,
       e.watching_since
from cron.job j
left join cron.job_run_details d on d.jobid = j.jobid
left join public.cron_expectations e on e.jobname = j.jobname
where j.command ilike '%ebay%' or e.jobname is not null
group by j.jobname, e.stale_after_min, e.watching_since;

comment on view public.ebay_cron_health is
  'Cron jobs the eBay error watch judges: every job whose command mentions eBay, plus any job with a cron_expectations row. stale_after_min is NULL when no expectation exists, and ebay-alert then applies its own 30-minute default.';

-- ⚠️ DROP VIEW RESETS GRANTS to the schema default, which hands anon and
-- authenticated everything back. 0039 revoked them because the anon key is
-- public and this view exposes the internal cron schedule. Repeat these two
-- lines after ANY redefinition of this view. This is the second time in one day.
revoke all on public.ebay_cron_health from anon, authenticated;
grant select on public.ebay_cron_health to service_role;
