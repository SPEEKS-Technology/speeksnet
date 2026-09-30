-- ============================================================================
-- backup_runs — one row per finished SPEEKSNET backup, so a missing one is mailed.
--
-- WHY THIS EXISTS (2026-09-30). The nightly backup (tools/backup) runs on Ethan's
-- laptop and writes to Google Drive, and nothing it does reaches anyone. From
-- Sep 22 to Sep 30 it produced nothing at all while the scheduled task reported
-- success every night — found only because Ethan went and looked at the folder.
-- The fix for the cause is in the script; this is the fix for not hearing about
-- it. Every run that gets as far as its status file posts a row here, and the
-- 8:20 Claims & Disputes DM digest adds a "Backups" line when the newest row
-- with ok = true is older than its allowance (BACKUP_STALE_HOURS there).
--
-- A run that dies before its log exists writes nothing — which is the point: the
-- alert keys off the last GOOD backup getting old, not off a failure being
-- reported, because the failures worth fearing are the ones that report nothing.
--
-- Written by the backup script through the Management API (its access token),
-- read by claims-disputes-email with the service key. RLS on with no policy,
-- same as netprofit_runs: nothing reads it with an anon key.
-- ============================================================================

create table if not exists public.backup_runs (
  id           bigint generated always as identity primary key,
  finished_at  timestamptz not null default now(),
  started_at   timestamptz,
  -- Every part (database, config, functions, storage, git) succeeded, and the
  -- snapshot folder got its final name. false = a ".partial" folder was left.
  ok           boolean     not null,
  computer     text,
  snapshot     text,                    -- folder name, e.g. 2026-09-30_1110
  size         text,
  parts        jsonb                    -- { part: { ok, detail } }, as in LAST-BACKUP.txt
);

create index if not exists backup_runs_finished_idx on public.backup_runs (finished_at desc);

alter table public.backup_runs enable row level security;

-- The run that ended the gap: done by hand at 11:13 on Sep 30, before the script
-- knew to report. Without it the first digest would say none was ever recorded.
insert into public.backup_runs (started_at, finished_at, ok, computer, snapshot, size, parts)
select '2026-09-30 11:10:28-05', '2026-09-30 11:13:43-05', true, 'DESKTOP-H5QANIS', '2026-09-30_1110', null,
       '{"note":"recorded by 0120; see LAST-BACKUP.txt for the parts"}'::jsonb
where not exists (select 1 from public.backup_runs);
