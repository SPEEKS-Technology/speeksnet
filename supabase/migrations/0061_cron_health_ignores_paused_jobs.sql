-- A cron job that somebody deliberately switched off is not a broken cron job.
--
-- ebay_cron_health feeds one thing: ebay-alert's "has this job stopped?" check.
-- It had no `active` filter, so the moment MPL/BAL/LEE's order polls were
-- deactivated for the new-Marketplace-Connect handover, their last_run began
-- ageing and the check was set to fire a CRITICAL for each of them every 15
-- minutes, for ever. Pausing the three live sweeps as well would have made it
-- six. Six permanent false criticals is how an alert channel gets ignored, and
-- the alert we need it for is a real duplicate import.
--
-- Filtered here rather than in the function on purpose: this holds even if the
-- function is never redeployed.
--
-- The trade-off, stated: a job someone switches off BY ACCIDENT also goes quiet
-- here. That is accepted because cron jobs do not deactivate themselves — a
-- person does, deliberately — and the alternative trains everyone to ignore the
-- email. `select jobname, active from cron.job where jobname ilike '%ebay%'` is
-- the one place that shows the true picture.
create or replace view ebay_cron_health as
select j.jobname,
       max(d.start_time) as last_run,
       count(*) filter (where d.status <> 'succeeded'
                          and d.start_time > (now() - interval '1 hour')) as failures_1h,
       e.stale_after_min,
       e.watching_since
  from cron.job j
  left join cron.job_run_details d on d.jobid = j.jobid
  left join cron_expectations e on e.jobname = j.jobname
 where j.active
   and (j.command ilike '%ebay%' or e.jobname is not null)
 group by j.jobname, e.stale_after_min, e.watching_since;

comment on view ebay_cron_health is
  'Per-job staleness for the eBay crons, read by ebay-alert. Inactive jobs are excluded: an intentionally-paused job must not read as a failure. Re-enable a job and it reappears on its next run.';
