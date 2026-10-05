-- ============================================================================
-- The last day of every month gets filled from Shopify at 6:50 on the 1st-3rd.
--
-- WHY. The Daily Sales Report (ks01/mo01-mo04@paymore.com, 6:00am) is
-- month-to-date: each morning it carries "the 1st through yesterday". On the 1st
-- the new month has no finished days, so no store sends anything. From the 2nd it
-- covers the new month only. So the last day of the month is never in any email:
-- 8/31 and 9/30 both came up missing for all five stores, had to be keyed by
-- hand, and set off the 7:00 missing-data alert (user, 2026-10-01).
--
-- WHAT. action=monthEnd on the sales-email-import web app runs
-- fillMonthEndFromShopify, which reads that one day from sales-true-daily (the
-- same ShopifyQL the email is built from; matched to the cent on 9/1, 9/2 and
-- 9/29) and writes it into BLANK cells only. The reasoning is in the banner
-- above that function.
--
-- WHEN. 6:50 Central (MOVED TO 5:50 BY 0123 THE SAME DAY — read that one), hour-guarded like every job since 0096: change the hour
-- in the guard, never only the cron line. Chosen against the minutes the Apps
-- Script project already owns (one shared LockService lock):
--   6:05 import (~2 min) · 6:10 Net Profit (~5 min) · 7:00 retry
-- 6:50 is clear of all three and lands BEFORE the 7:00 retry, which then sees
-- the cells filled and stays quiet. The day-of-month guard (1-3) is a second
-- copy of MONTH_END_WINDOW in the script; the script refuses outside it anyway,
-- so the guard only saves 28 pointless calls a month.
--
-- Safe to apply before the Apps Script version is published: the web app
-- answers an action it does not know with "unknown action" and writes nothing.
-- ============================================================================

select cron.schedule(
  'sales-month-end-fill-650am',
  '50 * * * *',
  $$
  select net.http_post(
    url := 'https://script.google.com/macros/s/AKfycbxTQkoWLmrfGYro3kfSc4GqN2cvGDbtKOaoh_3kgXMv76E2tfOmTf0M21PxOQ-EYNL3/exec?secret=sp33ks-sync-k3y-2026-x9mq&action=monthEnd',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 6
      and extract(day  from (now() at time zone 'America/Chicago')) <= 3;
  $$
);
