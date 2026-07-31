-- Margin Guide — adjustments layer.
--
-- WHY THIS EXISTS. The ten tiers in mg_tiers are shared: 'High' carries 63 cells
-- across 35 devices, so retuning it moves all of them. That is the point of the
-- tier model and it is right for a global change ("we pay too much for Used-A
-- everywhere"). It is wrong for the two edits the DM actually asked for, because
-- both cut ACROSS tiers rather than along them:
--
--   * "Laptops can't hold these numbers"  -> 39 cells spanning 9 of the 10 tiers
--   * "all new-in-box up 5"               -> 101 cells spanning 4 tiers
--
-- Doing either by editing tiers means forking them: Laptops alone would take the
-- catalogue from 10 tiers to 19, and several categories drifting would put it past
-- a hundred. Worse, forking has an ordering hazard — a cell whose shifted value
-- happens to equal another tier's CURRENT value must not be pointed at that tier
-- if that tier is also moving in the same sweep, or it silently gains the other
-- tier's shift too.
--
-- So an adjustment is a filter plus a delta, layered on top of the shared ladder.
-- mg_tiers stays ten rows forever, a bulk sweep is one row instead of four tier
-- operations, and reverting is a delete.
--
-- SHIFT ONLY, NOT ABSOLUTE VALUES. A delta preserves the ladder's shape — the gaps
-- between start, team ceiling and manager ceiling stay put, so an adjusted cell is
-- still recognisably the same rung pattern the buyer has learned. Absolute
-- overrides would let two adjustments disagree about what a cell should be, with no
-- non-arbitrary way to resolve it. Narrow the filter instead: scoping to one
-- condition gives fine control without that ambiguity.

create table if not exists mg_adjustments (
    id          bigserial primary key,

    -- The filter. Every non-null column narrows the slice; all-null would match
    -- every cell, which is what mg_tiers is for, so it is rejected below.
    category    text,          -- null = every category
    device_id   bigint references mg_devices (id) on delete cascade,
    condition   text,          -- null = every condition
    band_id     bigint references mg_bands (id) on delete cascade,

    -- Points added to all three rungs. Bounded because a delta big enough to
    -- invert the ladder is a mistake, not a policy.
    delta       integer not null check (delta between -60 and 60 and delta <> 0),

    note        text,
    created_by  text,
    created_at  timestamptz not null default now(),

    -- An adjustment with no filter at all is just a worse way to edit every tier.
    constraint mg_adjustments_needs_scope check (
        category is not null or device_id is not null
        or condition is not null or band_id is not null
    )
);

-- The resolver reads every row on each catalogue build, so keep the common
-- lookups cheap even though the table is expected to stay small.
create index if not exists mg_adjustments_category_idx  on mg_adjustments (category);
create index if not exists mg_adjustments_device_idx    on mg_adjustments (device_id);
create index if not exists mg_adjustments_condition_idx on mg_adjustments (condition);

-- Same rule as the rest of the Margin Guide tables: RLS on with no policies, so
-- only the service-role edge function can read or write. The anon key is public in
-- speeks.js — without this, anyone could shift the whole buy ladder.
alter table mg_adjustments enable row level security;

comment on table mg_adjustments is
    'Scoped +/- point shifts layered on mg_tiers. A cell''s percentages are its tier plus the sum of every adjustment whose non-null filters match it, clamped to a climbing ladder within 1..100.';
