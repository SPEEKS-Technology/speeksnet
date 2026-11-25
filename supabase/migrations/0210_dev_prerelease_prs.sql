-- ============================================================================
-- 0210 — DEVELOPMENT TRACKER: every PR merged into pre-release, until it ships
-- (2026-11-25).
--
-- Nick, 2026-11-25: "I need any branch thats been merged into pre release that
-- hasnt been shipped to main to show up on the patch notes."
--
-- The patch notes were built from TICKETS on pre-release only, so a merge with
-- no ticket on its branch shipped without a line — PR #590 ("B2B: Recycle Out
-- modal…", merged today) was invisible. This is the list of what's actually on
-- pre-release: one row per PR merged into it, kept by github-webhook (the
-- merge event, and the nightly / "Sync" reconcile), and marked shipped_at when
-- its merge commit is on main (a push to main, or the reconcile).
--
-- The suite shows the unshipped ones in the patch notes. One whose branch's
-- tickets already cover it reads as those tickets; one with none is flagged
-- "needs a patch note", with a button to write one (a ticket made straight onto
-- pre-release — dev-tickets create {prerelease: true}).
--
-- A cache of GitHub, like github_branches: the branch may be deleted after the
-- merge, the row stays. RLS on, no policies — the functions read it.
--
-- 0210: database max was 0209_dev_connector_keys; no branch on origin carries
-- anything past 0209.
-- ============================================================================

create table if not exists public.dev_prerelease_prs (
  pr_number   integer primary key,
  title       text not null default '',
  head        text,
  author      text,
  url         text,
  merged_at   timestamptz not null,
  merge_sha   text,
  shipped_at  timestamptz,
  synced_at   timestamptz not null default now()
);

create index if not exists dev_prerelease_prs_unshipped on public.dev_prerelease_prs (merged_at) where shipped_at is null;

alter table public.dev_prerelease_prs enable row level security;

comment on table public.dev_prerelease_prs is
  'Every PR merged into pre-release (kept by github-webhook); shipped_at once its merge commit is on main. The unshipped ones are what the next update contains — the suite''s patch notes show them.';

select public.ai_reader_refresh_grants();
