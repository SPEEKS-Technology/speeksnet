-- ============================================================================
-- 0193 — DEVELOPMENT TRACKER, Phase 5: the Branches panel (2026-11-19).
-- Plan: docs/plans/dev-tracker-HANDOFF.md (Phase 5, D5).
--
-- github_branches (0188) is the panel's cache: github-webhook refreshes a
-- branch's row on every delivery that touches it, and every row on a push to
-- pre-release / main and in the nightly reconcile. The browser never asks
-- GitHub — dev-tickets hands the rows over with the tickets.
--
-- What it gains here:
--   merged         everything on the branch is already on pre-release (ahead 0),
--                  or its PR merged and nothing was pushed after. Nick's call:
--                  ANY fully merged branch may be deleted from the panel (with a
--                  confirm) — no 14-day wait. main and pre-release never.
--   last_commit_message, pr_url — what the row shows.
--   marked_kind    a person's say-so, which the sync must not overwrite: today
--                  only 'release' ("this is an update branch, not a ticket's"),
--                  for branches like Main-December-Update-2---Ethan that no
--                  ticket owns. Who and when, for the record.
--
-- kind stays the sync's verdict: base (main, pre-release) · release (release/*
-- or marked) · ticket (an SN ticket, by name or a manual link) · untracked —
-- the flag.
--
-- 0193: database max was 0192_dev_github_sync; no branch carries a 0193+.
-- ============================================================================

alter table public.github_branches
  add column if not exists merged              boolean not null default false,
  add column if not exists last_commit_message text,
  add column if not exists pr_url              text,
  add column if not exists marked_kind         text check (marked_kind in ('release')),
  add column if not exists marked_by           text,
  add column if not exists marked_by_id        uuid,
  add column if not exists marked_at           timestamptz;

comment on table public.github_branches is
  'Cache of the repo''s branches for the Development page''s Branches tab, kept by github-webhook. ahead/behind are against pre-release. marked_* is a person''s override and survives every sync.';

select public.ai_reader_refresh_grants();
