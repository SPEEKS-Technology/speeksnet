-- ============================================================================
-- 0072 — teach the eBay watchdog what the live sweeps' cadence IS, so turning
-- them back on does not fire five permanent criticals.
--
-- ⚠️ CAUGHT BY A DRY RUN, NOT BY A USER'S INBOX. Immediately after 0071 flipped
-- the five sweeps to `active`, `ebay-alert?dryRun=1` returned five NEW criticals:
--     "An automatic job has stopped running — ebay-live-sweep-ovl"  (x5)
-- and `ebay-alert-watch` runs every 15 minutes, so they were about seven minutes
-- from being emailed.
--
-- TWO CAUSES, and both had to be fixed:
--
--   1. `ebay_cron_health` selects `WHERE j.active AND command ILIKE '%ebay%'`.
--      While the sweeps were paused they were invisible to the watchdog. Enabling
--      them put them back in scope with a `last_run` from 2026-08-24/25 — three
--      days stale, and correctly reported as such.
--
--   2. With no `cron_expectations` row, ebay-alert falls back to
--      CRON_STALE_MIN = 30 minutes, which is tuned for the every-2-minute ORDER
--      POLL. A job that runs every 6 hours would be "stale" 97% of the time —
--      five criticals a night, forever, about jobs that are working perfectly.
--      That is precisely how an alert email stops being read.
--
-- 480 = the 6-hour cadence (0071) plus two hours, so one skipped run is tolerated
-- and two are not.
--
-- ⚠️ IF 0071's SCHEDULE CHANGES, THIS NUMBER MUST CHANGE WITH IT. They are one
-- decision written in two places — same trap as the NET PROFIT close calendar and
-- the 36-hour freshness window in 0070/listing-titles.
--
-- The `sweep_stale` check in the same function is a separate thing and is already
-- correct: it skips any store whose `channel_mode` is `standby`, which all five
-- are today.
-- ============================================================================

insert into public.cron_expectations (jobname, stale_after_min, note)
values
  ('ebay-live-sweep-ovl', 480, 'Reads what OVL has live on eBay (GetMyeBaySelling — read only). Every 6 hours; 8 tolerates one miss. Feeds the Listing Titles queue, which stops filtering to eBay if this snapshot passes 36 hours.'),
  ('ebay-live-sweep-lee', 480, 'Reads what LEE has live on eBay (GetMyeBaySelling — read only). Every 6 hours; 8 tolerates one miss. Feeds the Listing Titles queue, which stops filtering to eBay if this snapshot passes 36 hours.'),
  ('ebay-live-sweep-wsp', 480, 'Reads what WSP has live on eBay (GetMyeBaySelling — read only). Every 6 hours; 8 tolerates one miss. Feeds the Listing Titles queue, which stops filtering to eBay if this snapshot passes 36 hours.'),
  ('ebay-live-sweep-mpl', 480, 'Reads what MPL has live on eBay (GetMyeBaySelling — read only). Every 6 hours; 8 tolerates one miss. Feeds the Listing Titles queue, which stops filtering to eBay if this snapshot passes 36 hours.'),
  ('ebay-live-sweep-bal', 480, 'Reads what BAL has live on eBay (GetMyeBaySelling — read only). Every 6 hours; 8 tolerates one miss. Feeds the Listing Titles queue, which stops filtering to eBay if this snapshot passes 36 hours.')
on conflict (jobname) do update
  set stale_after_min = excluded.stale_after_min,
      note = excluded.note;
