-- 0181 — the in-stock catalog refreshes hourly during the day (Ethan, 2026-11-13)
--
-- 'callback-catalog-refresh' runs ebay-catalog's INCREMENTAL sweep for all five
-- stores (Shopify products touched since the last finished run — about a second
-- and one GraphQL page per store). It fed Call Backs at 9:28, 12:28 and 3:28
-- Central only, so the Marketplace Lister's in-stock list missed anything added
-- after 3:28 until the 2am full rebuild. Now: every hour at :28 from 9am to 8pm
-- Central.
--
-- Cost checked before the change: Shopify Admin API is free, no AI calls, and
-- 12 runs x 5 stores is ~1,800 edge-function calls a month against the Pro
-- plan's 2M.
--
-- The schedule fires every hour in UTC and the hour filter in the command does
-- the Central-time choosing, so daylight saving needs no second edit.
--
-- KEEP IN STEP: fb-lister's REFRESH_HOURS_CT (supabase/functions/fb-lister)
-- shows people "next refresh" from this same list of hours.

select cron.alter_job(
  (select jobid from cron.job where jobname = 'callback-catalog-refresh'),
  schedule := '28 * * * *',
  command := $cmd$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/ebay-catalog?store='
           || s || '&sweep=1&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 55000)
  from (values ('OVL'),('LEE'),('WSP'),('MPL'),('BAL')) as t(s)
  where extract(hour from (now() at time zone 'America/Chicago')) between 9 and 20;
$cmd$
);
