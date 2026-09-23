-- 0100  District Matrix: margin judged like conversion, listing judged by the week
--
-- Two rule changes Ethan asked for on 2026-09-21, after a fortnight of looking
-- at the board:
--
--   "I think warning and critical are good for conversion. For listing per
--    week, warning needs to be if they are behind on goal and it switches to
--    critical if they realistically based on our set daily goals can't catch up
--    by end of day saturday. For margin, same concept as conversion just with a
--    53% threshold."
--
-- ---------------------------------------------------------------------------
-- MARGIN STOPS BEING A PURE DOLLAR FLOOR AND GETS CONVERSION'S SHAPE
-- ---------------------------------------------------------------------------
-- Until now margin was one test: pooled gross profit behind target, warn at
-- $750, red at $1,750. That has no sense of TIME. A store $900 behind because
-- of one bad Tuesday and a store $900 behind because it has missed every day
-- for a fortnight read identically, and they are not the same conversation.
--
-- Conversion already solves this with three tests, so margin now borrows all
-- three:
--
--   per-day gate  a day counts as under only if it is below target AND at
--                 least `gp_day_min` of gross profit behind that day
--   acute         `acute_needed` of the last `acute_window` counting days
--   chronic       the pooled window is under target and at least
--                 `gp_short_min` behind
--   critical      the month can no longer reach target
--
-- The per-day gate is margin's answer to conversion's binomial test. It cannot
-- BE a binomial test — margin is not a count of successes — but it does the
-- same job: keep a day off the board when the miss is too small to mean
-- anything. $150 was measured, over the 43 buying days to 2026-09-21, against
-- a 53% target:
--
--   floor      OVL   LEE   WSP   MPL   BAL      what it does
--   $100        19    12     9     0     1      44% of OVL's days — too chatty
--                                               to sit under a 2-of-3 test
--   $150        12     8     7     0     1      the three stores with a real
--                                               margin problem, a quarter of
--                                               their days, the two good ones
--                                               silent
--   $250         8     3     2     0     0      loses most of LEE and WSP
--
-- $150 it is. For scale, an average buying day is $3,900-$6,500 of value, so
-- $150 behind is roughly 3 points of margin on one day's buying — one deal
-- priced wrong, not a rounding error.
--
-- `margin_recover_max` is margin's version of conversion's 95% line: the rate
-- a store would have to run for the REST of the month to still land on target.
-- Conversion uses 95% because nobody converts better than that for a month.
-- The margin equivalent had to be measured rather than assumed, so: the best
-- rolling 10-open-day dollar-weighted margin any store has posted in the last
-- twelve months.
--
--   BAL 60.0   MPL 58.5   OVL 55.3   WSP 55.2   LEE 54.1
--
-- 60.0% is the district record. A store being asked to beat the district
-- record every remaining day has lost the month, and saying so on the 20th is
-- the entire point of the flag.
--
-- `gp_short_red` is RETIRED, not dropped. The month-lost test replaces it, the
-- same way it is the only red for conversion. The column stays so the history
-- in watch_flags remains readable against the config that produced it, and so
-- re-introducing a dollar red later needs no migration.
--
-- ---------------------------------------------------------------------------
-- LISTING MOVES FROM A 14-DAY WINDOW TO THE WORKING WEEK
-- ---------------------------------------------------------------------------
-- Listing goals are set per person per day and the store lives by the week, so
-- a rolling 14-day window was always the wrong frame: it straddles two weeks,
-- and "240 devices short" over eleven days is a number nobody can do anything
-- about on a Wednesday. The week can be acted on while it is still running.
--
-- THE WEEK IS MONDAY TO SATURDAY. Sunday is closed at every store, which the
-- engine already knew (openDaysBetween skips it), and Ethan's own framing is
-- "by end of day saturday".
--
--   warning   behind the staffed goal week-to-date by more than
--             `listing_short_min` devices
--   critical  behind, and the rest of the week cannot absorb it: the shortfall
--             is more than `listing_catchup_mult` - 1 of the goal still to come
--
-- `listing_catchup_mult` = 1.30, measured over RUNS of days rather than over
-- single days, because a run is what catching up actually asks for. Across 196
-- three-day runs, processed / goal comes out:
--
--   median 0.84   p75 1.15   p90 1.48   p95 1.65   max 2.29
--
-- 1.30 sits between the 75th and 90th percentiles — a pace a store manages
-- about one week in five. The SINGLE-DAY distribution is much wider (median
-- 0.89, p75 1.29, p90 1.89, max 5.11) and using it would have been the wrong
-- call: a 1.9x day happens, but you cannot roster four of them in a row, and
-- one big day is not a week of recovery.
--
-- A CLOSED WEEK IS GRADED, NOT ESCALATED. Once Saturday has gone nothing can
-- absorb a shortfall, so "they cannot catch up" is trivially true of every
-- miss. Judged that way on the first cut, 28 of the 73 reds the rule produced
-- over six weeks were Saturdays and Sundays — a whole weekend of red for any
-- store that missed by a device. So a finished week is graded on the same
-- yardstick applied to the whole week instead of to what is left of it: MPL
-- closing 36 behind on a goal of 154 is a warning, OVL closing 85 behind on
-- 190 is not.
--
-- The floors move with the frame. `listing_short_min` 60 -> 25 and
-- `listing_min_goal` 60 -> 25, because a week's staffed goal is 100-300
-- devices and a DAY's is about 30: a 60-device floor inside a week means a
-- store can be a third behind on Monday and Tuesday with nothing said, and a
-- 60-device minimum goal means Monday is never judged at all. 25 is most of a
-- day's work missed, which is the smallest miss worth a sentence.
--
-- `listing_short_red` is retired for the same reason gp_short_red is: the
-- catch-up test replaces it, and a fixed 200-device red inside a 170-device
-- week could never fire.
-- ---------------------------------------------------------------------------

alter table public.watch_config
  add column if not exists gp_day_min           numeric not null default 150.0,
  add column if not exists margin_recover_max   numeric not null default 60.0,
  add column if not exists listing_catchup_mult numeric not null default 1.30;

comment on column public.watch_config.gp_day_min is
  'Minimum gross profit behind target, in dollars, for ONE day to count toward the margin acute test. Margins answer to conversion per-day significance gate. Measured: see 0100.';
comment on column public.watch_config.margin_recover_max is
  'Margin percent a store would have to run for the rest of the month for the month to still reach target. Above this the month is lost. 60.0 = the best rolling 10-day margin any store posted in twelve months.';
comment on column public.watch_config.listing_catchup_mult is
  'How much of its remaining staffed goal a store can realistically list when catching up. 1.30 = the 75th percentile store-day. Only the 0.30 above goal counts as catch-up room.';
comment on column public.watch_config.gp_short_red is
  'RETIRED by 0100 — the month-lost test is margins only red now, as it is for conversion. Kept so old watch_flags rows stay readable.';
comment on column public.watch_config.listing_short_red is
  'RETIRED by 0100 — the catch-up test is listings only red now. Kept so old watch_flags rows stay readable.';

update public.watch_config
   set listing_short_min = 25.0,
       listing_min_goal  = 25.0,
       updated_at        = now(),
       updated_by        = 'migration 0100'
 where id = 1;
