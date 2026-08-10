-- ============================================================================
-- Catch-up: two B2B schema changes that exist in the database but had no file
-- in this repo, so a rebuilt environment would not have reproduced them.
--
-- This is the drift 0001_b2b_baseline.sql was written to eliminate, showing up
-- again. Both sections are written to be safe to re-run against the live
-- database, which already has both changes -- the point is to record them, not
-- to alter anything.
--
--   1. item_type gained 'computer'. Applied out-of-band on 2026-08-04 as remote
--      migration b2b_item_type_add_computer, six minutes before b2b-deals v23
--      was deployed to accept it. The repo's copy of that function was never
--      updated to match and is reconciled in the same commit as this file --
--      deploying the old copy would have rejected the type outright and nulled
--      the specs on every 'computer' row.
--
--   2. b2b_crm_settings had no CREATE TABLE anywhere in the repo. The table was
--      created out-of-band and only its two newest columns (wipe_fee,
--      quote_ready_enabled) had DDL here. It holds the CEO's notification
--      address, so an environment rebuilt without it loses that silently: the
--      edge function's UPDATE ... WHERE id = 1 matches no row and returns
--      success.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

-- 1 ------------------------------------------------------------ item_type ---
-- 'computer' folds the old laptop/desktop split into one type. The legacy keys
-- stay accepted so rows written before the merge still save; b2b_deal_items
-- still holds rows of both 'computer' and 'other'.
--
-- Kept in step with ITEM_TYPES in the b2b-deals edge function and
-- B2B_ITEM_TYPES in speeks.js. All three have to agree or a save fails on the
-- round trip.
alter table public.b2b_deal_items
  drop constraint if exists b2b_deal_items_item_type_check;
alter table public.b2b_deal_items
  add constraint b2b_deal_items_item_type_check
  check (item_type in ('computer', 'laptop', 'desktop', 'other'));

-- 'computer' carries every spec including battery health, so the only
-- restrictions left are that 'other' carries none and 'desktop' has no battery.
-- Restated here so the two constraints are legible together rather than one
-- being defined three migrations away from the other.
alter table public.b2b_deal_items
  drop constraint if exists b2b_deal_items_specs_fit_type;
alter table public.b2b_deal_items
  add constraint b2b_deal_items_specs_fit_type
  check (
    (item_type <> 'other'
      or (cpu is null and ram is null and storage is null
          and gpu is null and battery_health is null))
    and (item_type <> 'desktop' or battery_health is null)
  );

-- 2 -------------------------------------------------------- crm settings ---
-- A single row, id pinned to 1, holding the CEO's notification address and the
-- B2B email toggles. One row rather than a key/value table because every reader
-- wants all of it at once, and because "there is exactly one notification
-- address" is the actual rule -- the CHECK enforces it rather than trusting
-- callers to keep using the same id.
create table if not exists public.b2b_crm_settings (
  id                  smallint primary key default 1 check (id = 1),
  notify_email        text,
  enabled             boolean not null default true,
  overdue_only        boolean not null default false,
  wipe_fee            numeric(12, 2) not null default 8
                        check (wipe_fee >= 0 and wipe_fee <= 9999999),
  quote_ready_enabled boolean not null default true,
  updated_at          timestamptz default now(),
  updated_by          text
);

-- For an environment created by the earlier out-of-band table, before these two
-- columns were added.
alter table public.b2b_crm_settings
  add column if not exists wipe_fee numeric(12, 2) not null default 8,
  add column if not exists quote_ready_enabled boolean not null default true;

-- The singleton. Every write is an UPDATE ... WHERE id = 1, so without this row
-- settings changes succeed and do nothing.
insert into public.b2b_crm_settings (id) values (1) on conflict (id) do nothing;

-- Same posture as every other table here: RLS on, no policies, so the table is
-- reachable only through the service-role edge functions.
alter table public.b2b_crm_settings enable row level security;
