-- ============================================================================
-- 0111 — DISTRICT MATRIX: listing reads the WEEK, not the month
-- ----------------------------------------------------------------------------
-- Ethan, 2026-09-23, hours after 0110: "For listing, the one on the left can be
-- tracked for the week not the month" — then, asked which figure: "both
-- columns. Status can still say missed yesterday since it's tracking daily,
-- but the left column should be daily tracked against the week".
--
-- So for metric = 'listing' only, the "month" half of 0110's rule is WEEK TO
-- DATE (Monday through the judged day, Sunday belonging to the week just
-- closed): value and mtd_under are about the week, and the board shows that
-- figure both on the left and as the listing column's headline. miss_run is
-- unchanged — still open days in a row under their own goal. Conversion and
-- margin still read the month.
--
-- No schema change; the column names stay as 0110 made them. This file exists
-- to say what `value` and `mtd_under` mean on a listing row, because the name
-- mtd_under is now a lie for that one metric and renaming it would cost a
-- redeploy and a re-backfill to fix a word only we read (the same call 0097's
-- "watch" / "Matrix" seam made).
--
-- Applied with the matching district-watch deploy, then re-backfilled from
-- 2026-08-01. Apply via Supabase MCP `apply_migration`.
-- ============================================================================

comment on column public.watch_flags.value is
  'Since 0110: conversion and margin MONTH TO DATE (margin dollar-weighted); listing WEEK TO DATE as % of staffed goal (0111). Before 0110: over the rolling window.';
comment on column public.watch_flags.mtd_under is
  'The period finished under target: the month for conversion and margin, the week to date for listing (0111). Half of the 0110 verdict.';
