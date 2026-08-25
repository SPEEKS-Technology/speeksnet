-- Reverts 0046 in full. Google Places review tracking is scrapped: the site keeps
-- reading review counts through the Day End Report / sheet path
-- (google-apps-scripts/hub-google-reviews.gs), untouched by this and by 0046.
--
-- WHY IT WAS SCRAPPED. Using the Places API requires a Google Cloud billing
-- account with a card on file. Volume was ~155 calls a month against a recurring
-- 5,000/month free allowance, so the bill would have been zero, but "zero under
-- today's price list" is not the same promise as "free", and the POS lag it fixed
-- is not worth a payment method. Decision by the user, 2026-08-21.
--
-- ORDER MATTERS. The cron_expectations row goes first: 0044's watchdog emails
-- "Scheduled job stopped" for any expectation whose job has not run inside its
-- allowance, and a row left behind pointing at an unscheduled job is a permanent
-- daily false alarm — the exact failure 0044 was written to end.
delete from public.cron_expectations where jobname = 'google-reviews-snapshot';

-- Now the job itself. Guarded so this migration is safe to re-run.
select cron.unschedule('google-reviews-snapshot')
where exists (select 1 from cron.job where jobname = 'google-reviews-snapshot');

-- Both tables were verified empty (0 rows each) before dropping.
drop table if exists public.google_reviews_daily;
drop table if exists public.google_places;
