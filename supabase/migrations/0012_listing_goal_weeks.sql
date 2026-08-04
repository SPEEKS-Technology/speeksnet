-- Weekly listing goals, set by hand by the District Manager on Monday mornings.
--
-- This replaces the automatic ladder + performance ratchet as the SOURCE of the
-- number. The ladder survives only as the prefill when a week has never been set
-- (see baseForSize in the store-targets function) — it is a suggestion now, not
-- an authority, and nothing raises or lowers a target on its own any more.
--
-- Stored PER WEEK rather than as one mutable value on store_targets so that the
-- "Last 4 Weeks" green/red bars can judge each completed week against the goal
-- that was actually in force that week. With a single value, changing this
-- Monday's goal would silently re-colour every past week.

create table if not exists public.listing_goal_weeks (
    id          uuid primary key default gen_random_uuid(),
    store       text        not null,
    -- Monday that starts the week. The frontend and the edge function both
    -- normalise to Monday, so this is the natural key alongside store.
    week_start  date        not null,
    target      integer     not null check (target >= 0 and target <= 2000),
    set_by      text,
    set_at      timestamptz not null default now(),
    unique (store, week_start)
);

create index if not exists listing_goal_weeks_store_week_idx
    on public.listing_goal_weeks (store, week_start desc);

-- Service-role only, like every other table here: RLS on with no policies, so
-- all reads and writes go through the store-targets edge function.
alter table public.listing_goal_weeks enable row level security;
