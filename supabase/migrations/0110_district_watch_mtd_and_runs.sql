-- ============================================================================
-- 0110 — DISTRICT MATRIX: judged on the month and on days in a row
-- ----------------------------------------------------------------------------
-- Ethan, 2026-09-23, looking at MPL on the board — 80.9% conversion month to
-- date, under 85% for fourteen days, nine misses in a row, and green:
--
--   "on target needs to be MTD good and they don't have 2+ days in a row of
--    bad conversion
--    Watch is MTD good, but they do have 2+ days in a row of bad conversion
--    (beginning of bad trend)
--    Warning is MTD bad, but have had a mix of good and bad days over last 7
--    days
--    Critical is MTD is under and they have 4+ days in a row of bad
--    conversion
--    Listing should apply the same, but be on a daily goal basis"
--
-- WHAT THIS RETIRES. 0097-0101 judged a rolling 14-day window with a binomial
-- significance gate: a day only counted as under when the shortfall was bigger
-- than chance explains at its volume. That gate is what kept MPL green — its
-- pooled p was 0.114 against a 0.10 line — and because "the month is lost"
-- was only ever tested on top of a warning, a store the gate let through never
-- reached the month test at all. OVL at 80.1% MTD was Critical; MPL at 80.9%
-- was On target. Two stores in the same place, opposite colours.
--
-- THE NEW RULE IS LITERAL, on purpose. A day is bad when it finished under
-- target — conversion under 85%, margin under 53%, listing under that day's
-- staffed goal. No volume test. The DM reads this board to decide who to call,
-- and a rule he can check against the day's numbers by eye beats one that is
-- statistically right and has to be explained.
--
--   ok        MTD at/above target, fewer than watch_run misses in a row
--   watch     MTD at/above target, watch_run+ misses in a row      (new state)
--   warn      MTD under target,    fewer than critical_run in a row
--   critical  MTD under target,    critical_run+ misses in a row
--
-- A closed day (no customers, no buying, no goal set) is stepped over: it
-- neither extends a run nor breaks one, so Sunday never resets a store. Runs
-- cross the month boundary — four bad days spanning the 1st are four bad days.
--
-- LISTING MOVES OFF THE WEEK onto the same frame: month-to-date devices against
-- month-to-date staffed goal, only on days that had a goal (0100's rule about
-- unfilled rota still holds), and a bad day is one under its own goal. The
-- weekly catch-up test and listing_catchup_mult go dormant, not dropped.
--
-- The old columns (p_threshold, acute_*, gp_*, margin_recover_max,
-- listing_short_*, listing_catchup_mult) stay in watch_config and the old
-- booleans stay on watch_flags, written false. Nothing reads them now; dropping
-- them would make the history before this migration unreadable.
--
-- chronic_window keeps its name and becomes the "last N days" figure the board
-- shows beside MTD — 14 -> 7 (Ethan, same conversation: "adjust this down to
-- past 7 days"). It no longer decides anything; the verdict is MTD + the run.
--
-- ORDER: apply this BEFORE deploying the matching district-watch, which writes
-- state 'watch' and the three new columns. Then re-backfill from 2026-08-01 so
-- the history reads under one rule.
--
-- Apply via Supabase MCP `apply_migration`.
-- ============================================================================

alter table public.watch_flags drop constraint if exists watch_flags_state_check;
alter table public.watch_flags
  add constraint watch_flags_state_check
  check (state in ('ok', 'watch', 'warn', 'critical'));

alter table public.watch_flags
  add column if not exists mtd_under    boolean not null default false,
  add column if not exists miss_run     integer,
  add column if not exists recent_value numeric;

comment on column public.watch_flags.value is
  'Since 0110: the metric MONTH TO DATE (conversion %, dollar-weighted margin %, listing % of staffed goal). Before 0110: over the rolling window.';
comment on column public.watch_flags.mtd_under is
  'Month to date finished under target. Half of the 0110 verdict.';
comment on column public.watch_flags.miss_run is
  'Open days in a row, counting back from the judged day, that finished under target. The other half of the 0110 verdict. Closed days are stepped over.';
comment on column public.watch_flags.recent_value is
  'The metric over the last chronic_window calendar days. Shown beside MTD; decides nothing.';

alter table public.watch_config
  add column if not exists watch_run    integer not null default 2,
  add column if not exists critical_run integer not null default 4;

comment on column public.watch_config.watch_run is
  'Misses in a row that move a store that is fine for the month to Watch (0110).';
comment on column public.watch_config.critical_run is
  'Misses in a row that move a store that is under for the month from Warning to Critical (0110).';

alter table public.watch_config alter column chronic_window set default 7;
update public.watch_config set chronic_window = 7, updated_at = now() where id = 1;
