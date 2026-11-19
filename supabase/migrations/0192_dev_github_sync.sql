-- ============================================================================
-- 0192 — DEVELOPMENT TRACKER, Phase 4: GitHub sync, read only (2026-11-19).
-- Plan: docs/plans/dev-tracker-HANDOFF.md (Phase 4). The function that uses
-- all of this is github-webhook.
--
-- 1. dev_ticket_links grows what a PR row needs to drive status and checks:
--      sha        the MERGE commit (a merged PR) or the commit itself — what the
--                 "has it reached main?" compare runs on (reached main = Done)
--      head_sha   the PR's / branch's tip when last looked at — checks are only
--                 recomputed when it moves
--      base/head  branch names; base decides the move (pre-release → On
--                 pre-release, main → Done, anything else → nothing)
--      author, merged_at, updated_at
--      checks     [{kind:'migration'|'buster'|'function', level:'ok'|'todo'|
--                   'warn'|'error', text}] from the PR's changed files
--
-- 2. dev_applied_migrations(): the names in supabase_migrations.schema_migrations
--    — the AUTHORITY on which migration numbers are taken (CLAUDE.md trap 4),
--    which PostgREST can't reach directly. Service role only.
--
-- 3. The nightly reconcile at 03:15 Central (09:15 UTC; 08:15 during CDT — an
--    hour either way is fine for a catch-up). It re-reads PRs, branches and
--    commits since the last good run, so a missed or failed webhook delivery
--    costs a night's delay, not a wrong ticket. The ?secret= is the shared sync
--    secret every cron here uses; it can only trigger a read-and-reconcile.
--
-- 0192: database max was 0191_dev_ticket_attachments; no branch, local or
-- pushed, carries a 019x beyond it (swept 2026-11-19).
-- ============================================================================

alter table public.dev_ticket_links
  add column if not exists sha        text,
  add column if not exists head_sha   text,
  add column if not exists base       text,
  add column if not exists head       text,
  add column if not exists author     text,
  add column if not exists merged_at  timestamptz,
  add column if not exists checks     jsonb not null default '[]'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists dev_ticket_links_ref_idx on public.dev_ticket_links (kind, ref);

comment on column public.dev_ticket_links.sha is 'Merge commit (merged PR) or the commit itself: what the reached-main check compares against main.';
comment on column public.dev_ticket_links.checks is 'From the PR''s changed files: [{kind: migration|buster|function, level: ok|todo|warn|error, text}].';

create or replace function public.dev_applied_migrations()
returns table (version text, name text)
language sql stable security definer set search_path = ''
as $$ select m.version::text, m.name::text from supabase_migrations.schema_migrations m $$;
revoke all on function public.dev_applied_migrations() from public, anon, authenticated;
grant execute on function public.dev_applied_migrations() to service_role;

do $$ begin perform cron.unschedule('github-reconcile-nightly'); exception when others then null; end $$;
select cron.schedule('github-reconcile-nightly', '15 9 * * *', $$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/github-webhook?trigger=cron&secret=sp33ks-sync-k3y-2026-x9mq',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

-- The Claude connector reads through column grants it recomputes (0142).
select public.ai_reader_refresh_grants();
