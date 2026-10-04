-- ============================================================================
-- 0134 — switch off ebay-fee-mix-320pm (0133). Nothing reads its output any more.
--
-- WHY: Ethan removed the Daily Breakdown eBay Standing panel on 2026-10-02 (the
-- cost strip's red eBay fee / shipping figures say it), and that panel was the
-- only reader of ebay_fee_month.
--
-- AND IT WAS MAILING AN ALERT EVERY HOUR. ebay_cron_health watches any active job
-- whose command mentions "ebay", and a job with no cron_expectations row is held
-- to the 30-minute allowance made for the 2-minute order poll (see 0072, which
-- is the same trap). An hourly job with a 15:00 guard was "stopped" for 30
-- minutes of every hour, then "fixed", then stopped again — one "An automatic job
-- has stopped running — ebay-fee-mix-320pm" email per hour.
--
-- Unscheduling takes it out of the view (it selects j.active), so the alert
-- resolves itself. The function and the table stay: ebay_fee_month keeps
-- September and October, and turning this back on needs this job AND a
-- cron_expectations row (≥ 1500 min for a daily run) in the same migration.
-- ============================================================================

select cron.unschedule('ebay-fee-mix-320pm')
where exists (select 1 from cron.job where jobname = 'ebay-fee-mix-320pm');
