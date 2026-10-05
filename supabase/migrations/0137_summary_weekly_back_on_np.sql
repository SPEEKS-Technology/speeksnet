-- ============================================================================
-- 0137 — put the Monday Summary run back (undoes the summary-weekly half of 0136).
--
-- 0136 switched it off with the rest of the Sales Summary import. That was wrong:
-- the Summary tab is also how the Monday unlisted-backlog report gets each
-- store's inventory LINE ITEMS (Summary tab -> sales-sync.gs onEdit ->
-- store_weekly_sales.inventory_line_items), and nothing else carries that figure
-- (day_end_facts.available_count is units, not lines).
--
-- What actually broke it was the Summary's revenue/cost, read off the Sales tabs:
-- with "Sales Oct 26" deleted the week is "incomplete" and the run writes
-- nothing. Ethan 2026-10-03: "point the revenue to the net profit tab since it's
-- the same numbers". sales-email-import.gs _weeklyFiguresFor now reads days from
-- 1 Oct 2026 off "Net Profit {Mon} {YY}" (checked: Oct 1-2 equal daily_np to the
-- cent for all five stores) — and it only does so once that Apps Script is
-- PUBLISHED as a new version. Until then a Monday run with the Sales tab gone is
-- blocked and alerts, which is the run saying so rather than writing blanks.
--
-- Commands are the originals, recovered verbatim from cron.job_run_details.
-- 12:30 / 13:30 UTC with a 7am-Central guard = 7:30am Central either side of DST.
-- ============================================================================

select cron.schedule('summary-weekly-mon-cdt', '30 12 * * 1', $$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/summary-weekly?secret=sp33ks-sync-k3y-2026-x9mq&trigger=cron',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 7;
$$);

select cron.schedule('summary-weekly-mon-cst', '30 13 * * 1', $$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/summary-weekly?secret=sp33ks-sync-k3y-2026-x9mq&trigger=cron',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  ) where extract(hour from (now() at time zone 'America/Chicago')) = 7;
$$);
