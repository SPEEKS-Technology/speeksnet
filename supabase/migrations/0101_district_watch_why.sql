-- 0101  District Matrix: record WHICH test fired, and whether a clear store is drifting
--
-- Ethan, 2026-09-21, looking at the board with three full sentences per store:
--
--   "I like the brief summary you have here, but I think we need to simplify
--    what exactly is being said here. This feels like too much info and I would
--    like to know at a glance why someone is in a warning or critical, or if
--    they are good and have a negative trend starting."
--
-- ---------------------------------------------------------------------------
-- WHY BOOLEANS AND NOT A SECOND, SHORTER SENTENCE
-- ---------------------------------------------------------------------------
-- The obvious move is a `headline` column holding a pre-written short phrase.
-- It was rejected. `reason` already exists, and a second prose column means
-- the same judgement is worded in two places that can drift apart, and every
-- change of wording costs a redeploy AND a re-backfill of 47 days to make the
-- history read consistently.
--
-- What the front end cannot work out for itself is not the WORDS, it is the
-- FACT: a row says state='warn' and shortfall=8, but nothing on it says
-- whether that came from the acute test, the chronic test, or both, and
-- nothing says a store sitting on 'ok' is quietly sliding. Those four facts
-- are what the engine knows and the board cannot re-derive.
--
-- So: store the facts, let the board choose the words. Re-wording the glance
-- line is then a JS edit and a cache-buster bump, which is what iterating on
-- a summary line should cost.
--
-- ---------------------------------------------------------------------------
-- `drifting` — the state that did not exist before
-- ---------------------------------------------------------------------------
-- Ethan asked for "good and have a negative trend starting", which the three
-- states could not express: a store was clear or it was flagged. `drifting` is
-- the space between, and it is deliberately NOT a fourth state — it never
-- changes the store's colour and never puts it on the triage list. It only
-- annotates a metric that is already reading 'ok'.
--
-- Set when the metric is 'ok' AND one of:
--
--   conversion  the window is UNDER TARGET and at least one day in the acute
--               window counted, but not enough of them to trip the test; or,
--               regardless of level, the second half of the window is worse
--               than the first by 9.0 points or more
--   margin      the same two shapes, with the per-day dollar gate in place of
--               the binomial and a 2.5-point half-over-half drop
--   listing     the week is behind the staffed goal, but by less than
--               listing_short_min — the "inside the margin worth raising" case
--               the sentence already described but nothing made scannable
--
-- THE UNDER-TARGET GUARD ON THE FIRST ARM IS NOT DECORATION. Without it a
-- store comfortably above target with one wobbly day reads as sliding, which
-- is the noise this engine exists to avoid. BAL margin, 55.1% with one $164
-- day, was caught by the first cut and is not now. The TREND arm carries no
-- such guard on purpose: good and getting worse is the case Ethan asked for.
--
-- The two drops were measured after a first cut at 2 and 1 point turned out to
-- sit near the MEDIAN of ordinary variation and marked three of five stores as
-- drifting on a normal day. Older half minus newer half, over 120 days:
--
--                p50    p75    p85    p90
--   conversion   0.41   4.49   7.32   8.99
--   margin       0.17   1.49   1.98   2.59
--
-- The 90th percentile is the line: 12% of clear conversion days and 17% of
-- clear margin days carry the annotation. They live in the edge function
-- rather than in watch_config, unlike every threshold that can FLAG a store,
-- because drift only annotates — a wrong value costs a word, not a colour.
-- ---------------------------------------------------------------------------

alter table public.watch_flags
  add column if not exists acute      boolean not null default false,
  add column if not exists chronic    boolean not null default false,
  add column if not exists month_lost boolean not null default false,
  add column if not exists drifting   boolean not null default false;

comment on column public.watch_flags.acute is
  'The recent-days test fired: acute_needed of the last acute_window days counted as under.';
comment on column public.watch_flags.chronic is
  'The pooled-window test fired: the whole window is under target by more than the floor.';
comment on column public.watch_flags.month_lost is
  'Critical because the month (conversion, margin) or the week (listing) can no longer be recovered.';
comment on column public.watch_flags.drifting is
  'State is ok, but sliding: one counting bad day, or the window getting worse half over half, or behind the weekly goal by less than the floor. Never changes the state - it annotates it.';
