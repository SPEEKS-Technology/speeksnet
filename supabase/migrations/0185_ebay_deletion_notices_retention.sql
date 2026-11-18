-- ============================================================================
-- 0185 — keep ebay_deletion_notices to 30 days.
--
-- WHY. On 2026-11-17 Supabase mailed a Disk IO Budget warning. The database
-- itself was quiet (reads served from cache, ~40 MB/day of WAL), but this one
-- table was 108 MB of a 224 MB database: 184k rows, ~1,500 more every day, and
-- the backup task COPYs the whole thing on every run (~15 s each).
--
-- WHAT THESE ROWS ARE. ebay-notify (see its header) answers eBay's Marketplace
-- Account Deletion endpoint. eBay sends EVERY developer app a notice whenever
-- ANY eBay user anywhere closes their account — not our buyers, which is why
-- the volume is what it is. The function parks each notice here "so the
-- deletion can be handled deliberately", but that handler was never built:
-- 1 row of 184k was ever marked handled, and nothing in the app, edge
-- functions, views or SQL functions reads this table back.
--
-- WHAT RETENTION COSTS. Nothing on screen and nothing for eBay compliance —
-- eBay checks only that the endpoint answers 200, which ebay-notify still does.
-- 30 days is kept rather than zero because if the personal-data purge is ever
-- built, recent notices are the ones it would need.
--
-- One-off purge done by hand the same day: 117,659 rows older than 30 days
-- deleted, then VACUUM FULL — table 108 MB → 37 MB, database 224 → 154 MB.
--
-- NO WEEKLY VACUUM FULL here, unlike 0094/pgnet. A nightly delete of ~1,500
-- rows leaves space autovacuum hands straight back to the next day's inserts,
-- so the table holds steady at ~30 days' worth on its own. The big compaction
-- was only needed once, to undo three months of unbounded growth.
--
-- :17 because nothing else in this project fires on it, and it is clear of
-- cron-run-details-purge at :13.
-- ============================================================================

select cron.schedule('ebay-deletion-notices-purge', '17 5 * * *',
  $job$delete from public.ebay_deletion_notices where received_at < now() - interval '30 days'$job$);

-- Watched like the 0094 purge: if this silently stops, the table grows back
-- and the next IO warning looks brand new. 1560 = 26h for a daily job (0072).
-- IF THE SCHEDULE ABOVE CHANGES, THIS MUST CHANGE WITH IT.
insert into public.cron_expectations (jobname, stale_after_min, note)
values
  ('ebay-deletion-notices-purge', 1560,
   'Daily 05:17 UTC. Trims ebay_deletion_notices to 30 days. If this stops, the table grows ~35 MB a month with rows nothing reads — the Disk IO warning 0185 answered.')
on conflict (jobname) do update
  set stale_after_min = excluded.stale_after_min,
      note = excluded.note;
