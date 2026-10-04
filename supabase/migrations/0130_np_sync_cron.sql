-- ============================================================================
-- np-sync every 15 minutes — keep daily_np level with the Net Profit tab.
--
-- Not hour-guarded like the morning chain, on purpose. The tab changes at the
-- 6:10 pass (all but shipping), the 2:05pm pass (shipping), the 7pm close on the
-- 1st/2nd, AND whenever Ethan hand-corrects a cell against the P&L. A mirror that
-- only looked after the passes would miss the corrections. A sync is two gviz
-- reads and one upsert, takes no Apps Script lock and so cannot collide with the
-- :05/:10 import + Net Profit minutes (see morning-reports notes, 2026-09-12).
--
-- A 6:10 pass takes ~5 minutes, so the 6:15 read may catch it half-written; the
-- 6:30 read has it whole. Every read is a full re-mirror, so a partial one is
-- simply overwritten 15 minutes later.
-- ============================================================================

select cron.schedule(
  'np-sync-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/np-sync?secret=sp33ks-sync-k3y-2026-x9mq',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
