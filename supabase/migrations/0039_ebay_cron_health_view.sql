-- The alerter needs to know whether the eBay cron jobs are still RUNNING, not
-- just whether their output looks sane. An order poll that has stopped and an
-- order poll that is finding nothing produce identical tables, and only one of
-- those is an emergency.
--
-- cron.job_run_details is not reachable through PostgREST, so this exposes the
-- two facts the alerter needs and nothing else: when each eBay job last ran, and
-- how many times it failed in the last hour.
create or replace view ebay_cron_health as
select
  j.jobname,
  max(d.start_time) as last_run,
  count(*) filter (
    where d.status <> 'succeeded' and d.start_time > now() - interval '1 hour'
  ) as failures_1h
from cron.job j
left join cron.job_run_details d on d.jobid = j.jobid
where j.command ilike '%ebay%'
group by j.jobname;

-- A view has no RLS of its own, so lock it down explicitly. Only the alerter
-- (service role) reads this; the browser never should, and anon certainly not.
revoke all on ebay_cron_health from anon, authenticated;
grant select on ebay_cron_health to service_role;
