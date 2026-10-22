-- Pause the Monday 9am Unlisted Inventory Weekly Update email (Ethan, 2026-10-22).
--
-- Replaced by the "Unlisted Inventory Trend" dashboard
-- (claude.ai/artifact/RX1ZkpnCYgSLe9BxyrLcpS), which reads SPEEKSNET live through
-- the SPEEKSNET Claude connector. Paul wanted the trend over time, not one week
-- against the last.
--
-- Two other reasons the email was not worth keeping alongside it:
--   - it sends at 9:00 and the Monday Sales Summary sync lands after that
--     (9:14 on 10-19), so it reported the previous week's pile as this week's;
--   - it reads listed from the Weekly KPI, where the dashboard and Listing Goals
--     count Total Listed Devices off the Day End report.
--
-- Paused, not unscheduled: the unlisted-backlog function and its recipient list
-- stay as they are. To bring it back, set both jobs active again.
select cron.alter_job(job_id := jobid, active := false)
from cron.job
where jobname in ('unlisted-backlog-mon-cdt', 'unlisted-backlog-mon-cst');
