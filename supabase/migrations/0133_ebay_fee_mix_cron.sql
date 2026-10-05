-- ============================================================================
-- ebay-fee-mix once a day at 3:20pm Central (see 0132).
--
-- After the 2:05pm Net Profit pass, and on none of the minutes the Apps Script
-- project owns (:05/:10 of 6, :05 of 14, :50 of 5 on days 1–3). It talks only to
-- eBay's Finances API and to ebay_fee_month, so it cannot collide with the NP
-- chain's script lock either way. Hourly with a Central-hour guard, like every
-- other job here, so DST needs no twin.
-- ============================================================================

select cron.schedule(
  'ebay-fee-mix-320pm',
  '20 * * * *',
  $$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/ebay-fee-mix?secret=sp33ks-sync-k3y-2026-x9mq',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 15;
  $$
);
