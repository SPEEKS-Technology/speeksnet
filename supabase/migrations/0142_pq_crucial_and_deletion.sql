-- ============================================================================
-- 0142 — Picture Quality scoring card v2 (Ethan, 2026-10-11): two columns.
--
-- pg_shots.crucial — a shot the DM marks Crucial in the Picture Guide editor.
-- A missing crucial view is an AUTOMATIC FLAG; any other missing view costs 8
-- points, and the first non-crucial one on a listing is free. Ethan: "if we are
-- missing a crucial view it should be automatic flag". It lives on the guide,
-- not in the checker's code, because what is crucial is a property of the kind
-- of item (a phone's button side, a laptop's port side) and Ethan wants rules
-- that are general — set once per sheet, followed by every listing on it.
-- Default false: nothing is crucial until a DM says so.
--
-- picture_quality_reviews.deletion — a duplicate photo the checker found, for
-- the One-Click Fixes tab's Approve Deletion (shape: {photos:[5], of:[1]}).
-- Kept beside `reorder`, not inside it: a listing can need either, or both,
-- and each is approved on its own.
-- ============================================================================

alter table public.pg_shots
  add column if not exists crucial boolean not null default false;

comment on column public.pg_shots.crucial is
  'Picture Quality: missing this shot is an automatic flag (any other missing view costs points). Set per sheet in the Picture Guide editor.';

alter table public.picture_quality_reviews
  add column if not exists deletion jsonb;

comment on column public.picture_quality_reviews.deletion is
  'Duplicate photos to delete on approval: {photos:[n…], of:[n…]} — photo numbers as graded. Applied only if the photos have not changed since (stamp).';
