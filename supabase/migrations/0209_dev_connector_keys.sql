-- ============================================================================
-- 0209 — DEVELOPMENT TRACKER: keys for the speeksnet-dev Claude connector
-- (2026-11-25). Plan: docs/plans/dev-tracker-HANDOFF.md §6b step 4; rules for
-- Claude: docs/DEVELOPMENT-WORKFLOW.md.
--
-- Both developers do most of their branching and merging through Claude
-- (Nick, 2026-11-24). The dev-mcp function lets Claude read the pipeline and
-- move tickets — and every write it makes is made AS A PERSON, shown in the
-- history as "Claude, for Nick". So each developer has their own key, not a
-- shared one (the repo is public; speeks-mcp's shared URL key reads data only,
-- this one writes).
--
-- A key is made in the suite (your menu → Claude connector) and shown ONCE.
-- Only its SHA-256 is kept here, plus its last 4 characters so a person can
-- tell their keys apart. Revoking sets revoked_at; a revoked key never works
-- again.
--
-- user_id is users.id — stable since 2026-11-17 (CLAUDE.md, "Identity"); no FK,
-- deliberately, like Projects (the Manage Users save deletes and re-inserts).
-- If a person's PIN changes their id does too, and their keys stop working:
-- dev-mcp says so and they make a new one.
--
-- secret_hash is named so ai_reader_refresh_grants() leaves it out of the
-- read-only reader (its column filter drops anything matching "secret").
-- RLS on with no policies: only the service role (the edge functions) reads it.
--
-- 0209: database max was 0208_shopify_live_store_hours (2026-11-25); no branch
-- on origin carries anything past 0205.
-- ============================================================================

create table if not exists public.dev_mcp_keys (
  id            bigserial primary key,
  user_id       uuid not null,
  user_name     text not null,
  label         text not null default '' check (length(label) <= 60),
  secret_hash   text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  hint          text not null check (length(hint) between 1 and 8),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create index if not exists dev_mcp_keys_user_idx on public.dev_mcp_keys (user_id) where revoked_at is null;

alter table public.dev_mcp_keys enable row level security;

comment on table public.dev_mcp_keys is
  'Per-developer keys for the speeksnet-dev Claude connector (dev-mcp). Only a SHA-256 of each key is stored; the key is shown once when made. Writes through a key are attributed "Claude, for <name>".';

select public.ai_reader_refresh_grants();
