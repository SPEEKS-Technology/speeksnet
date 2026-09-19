-- 0093 — freeze a store-week's capacity once the week is over
--
-- WHY
-- breakdown() and evaluate() both say the weekly figure is "frozen Monday
-- morning". It never was. capacityFor(store, weekStart) calls rosterFor(store),
-- which has no date parameter at all — it reads the users table as it stands
-- RIGHT NOW. weekStart reaches only as far as the new-hire ramp.
--
-- So every past week silently re-scored itself whenever anyone was hired, left,
-- or had their hours changed. The DM's `Goal` and `Ceiling` columns for the week
-- of 2026-08-31 read 260 and 346 — numbers nobody was ever shown at the time,
-- computed from a roster that week did not have. Worse, this change makes it
-- much more visible: correcting one part-timer's hours from 20 to 10 would have
-- moved OVL's goal for every week in the archive.
--
-- WHAT IS STORED
-- The roster as it stood, and everything derived from it, per store-week. The
-- roster itself goes in as JSONB rather than as a join table: it is a snapshot,
-- read back whole, never queried across, and it has to survive the person being
-- deleted from users entirely — which is precisely the case that re-scored the
-- archive before.
--
-- WHEN IT IS WRITTEN
-- The CURRENT week is re-captured on every read, so adding someone on Tuesday
-- shows up in this week's ceiling the way it should. A week that has ENDED is
-- written once and never touched again. That gives the live week the honesty of
-- tracking reality and the closed week the honesty of not moving.
--
-- A week that finished BEFORE this migration has no snapshot and cannot get a
-- real one — the roster it had is not recoverable. Those fall back to a live
-- computation, flagged `estimated`, so the UI can say the figure is a
-- reconstruction rather than quietly presenting it as what the store was told.

CREATE TABLE IF NOT EXISTS listing_week_capacity (
    store        TEXT        NOT NULL,
    week_start   DATE        NOT NULL,
    roster       JSONB       NOT NULL,   -- [{name, role, hours, days, shift, employment, newHire, floater, homeStore}]
    hours        NUMERIC     NOT NULL,   -- contracted hours the week actually had
    capacity     INTEGER     NOT NULL,   -- the ceiling, before the stretch factor
    planned      INTEGER     NOT NULL,   -- capacity x goal_factor — the suggestion
    goal_factor  NUMERIC     NOT NULL,   -- the store's factor as it stood that week
    seats        JSONB       NOT NULL,   -- {buyer1, buyer2, lister, newHire} hours
    captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    sealed_at    TIMESTAMPTZ,            -- set when the week ends; non-null = never rewrite
    PRIMARY KEY (store, week_start)
);

COMMENT ON TABLE listing_week_capacity IS
  'What a store-week was actually staffed with, frozen. Added in 0093 because capacityFor() recomputed every past week from today''s roster, so hiring anyone re-scored the archive.';
COMMENT ON COLUMN listing_week_capacity.sealed_at IS
  'Non-null once the week has ended. A sealed row is never rewritten; the current week is re-captured on every read.';
