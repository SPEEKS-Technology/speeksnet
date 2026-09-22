-- ============================================================================
-- 0097 — District Watch: the tables behind the flag engine
--
-- WHAT THIS IS
-- A nightly judgement on each store's daily numbers, so the DM opens one tab
-- and sees which stores need him today and why. Every number it reads already
-- exists in day_end_facts. The only thing this adds is the decision that a
-- number is far enough from target, for long enough, at enough volume, to be
-- worth a conversation.
--
-- See docs/district-watch-plan.md for the whole design. The parts that a future
-- reader is most likely to try to "simplify" are recorded below, because each
-- one looks wrong until you see the data behind it.
--
-- ⚠️ WHY A SIGNIFICANCE TEST AND NOT A THRESHOLD
-- The obvious build is `flag when conversion < 85`. That was measured against
-- 43 real days and it is useless — it flags 20 days at BAL, 25 at WSP and 28 at
-- OVL. Three stores permanently red is not an alert, it is wallpaper, and a
-- board nobody reads is worse than no board.
--
-- The reason it over-fires is volume. A store that sees 5 customers and misses
-- one is at 80% and has done nothing wrong; a store that sees 20 and misses six
-- is at 70% and has. A percentage cannot tell those apart, so this asks a
-- different question: IS THIS SHORTFALL BIGGER THAN CHANCE EXPLAINS AT THIS
-- DAY'S VOLUME? One-sided binomial, p < p_threshold.
--
-- Same 43 days, same 85% target, counting only days that clear that test:
--
--            literally under 85%     statistically under 85%
--   LEE               9                        1
--   MPL              18                        1          <-- the proof
--   BAL              20                        4
--   WSP              25                        6
--   OVL              28                        8
--
-- MPL is why this exists. Eighteen days under target, ONE of them real. Every
-- other MPL miss is a 4-out-of-5 day. No fixed threshold can make that
-- distinction; this does, and it does it without a minimum-volume gate that
-- would have thrown the small days away entirely.
--
-- ⚠️ 0.10, NOT 0.05. At p < 0.05 the engine goes nearly silent (OVL 3 days in
-- 43, MPL and LEE 1 each) and a store can drift for a fortnight unremarked.
-- 0.10 is deliberately looser than a research default: the cost of a wrong flag
-- here is one unnecessary phone call, not a false finding. Tune it in the
-- table, not in the function.
--
-- ⚠️ MARGIN GETS NO BINOMIAL TEST, AND MUST NOT BE GIVEN ONE.
-- Conversion is a count of successes out of trials. Margin is a ratio of
-- dollars, so the binomial model does not apply to it at all. Margin is judged
-- on GROSS PROFIT SHORT OF TARGET:
--
--     gp_short = target_margin * sum(est_value) - (sum(est_value) - sum(total_spent))
--
-- and ranked on that, never on percentage points, because points ignore volume.
-- The 14 days to 2026-09-19 are the argument:
--
--            buy value    margin    gp short
--   OVL        $91,557     50.2%     -$3,936
--   LEE        $40,198     52.5%       -$819
--   WSP        $36,740     53.7%       -$283
--   BAL        $32,206     55.1%       +$189
--   MPL        $50,770     56.4%       +$967
--
-- OVL and LEE both read as "a couple of points under". In money OVL is nearly
-- five times the problem, because it buys more than twice the volume — around
-- $100k of gross profit a year on that run rate. A points threshold would have
-- ranked them as roughly equal offenders and sent the DM to the wrong store.
--
-- ⚠️ MARGIN IS DOLLAR-WEIGHTED, NEVER AN AVERAGE OF DAILY PERCENTAGES.
-- 0004_buying_margin.sql already says this and it still bites: over 14 days the
-- naive average and the weighted figure differ by 1.1 points at OVL, which is
-- enough to move it across a line. Sum value and cost, then divide.
--
-- ⚠️ est_margin_pct IS STORED AS A FRACTION (0.52 = 52%), unlike most percent
-- columns in this schema. The engine does not read it — it recomputes from
-- est_value and total_spent so the weighting above is guaranteed — but anyone
-- spot-checking these numbers by hand will trip on it.
--
-- STORE LEVEL ONLY, AND THAT IS NOT AN OVERSIGHT.
-- The ask was per-store AND per-employee. Per-employee buy margin and customer
-- conversion do not exist in any daily feed: the Day End Report carries no
-- per-employee buying or conversion breakdown (see _deParse in
-- google-apps-scripts/sales-email-import.gs). They exist only in kpi_entries,
-- which is weekly and hand-filed. Two further blockers, both in live data:
-- listing_goals.result has never been populated (zero on every row since June,
-- 8,000+ goals set), and names do not join — 43 of 216 nightly Team Production
-- rows fail to match a goal row over 14 days, and MPL's entire weekly-KPI
-- roster matches none of its Team Production names. Per-employee needs a roster
-- table and probably a repair to listing_goals first. Both are their own
-- projects; neither blocks this one.
--
-- No RLS policies, matching every other table in this project: closed to the
-- anon client, all access through the service-role `district-watch` edge fn.
--
-- Apply via Supabase MCP `apply_migration`.
-- ============================================================================

-- 1. Tunable thresholds. Single row, DM-editable, so tuning the engine never
--    needs a deploy. The first set of numbers WILL be wrong somewhere — they
--    were fitted to 43 days of one late-summer period — and this table is the
--    whole reason that is cheap to fix.
create table public.watch_config (
  id              smallint primary key default 1 check (id = 1),

  conv_target     numeric not null default 85.0,   -- customer conversion %, the company standard
  margin_target   numeric not null default 54.5,   -- matches bm_config.target_margin; keep them equal

  -- The significance gate. A day counts as "under" only when the one-sided
  -- binomial p-value against conv_target falls below this. See the header.
  p_threshold     numeric not null default 0.10,

  -- The acute test: "acute_needed counting days within the last acute_window".
  -- 2 of 3 was the DM's own rule. Over 60 days it fires 6 times district-wide,
  -- which is about one event per ten days — quiet enough to still mean something.
  acute_window    integer not null default 3,
  acute_needed    integer not null default 2,

  -- The chronic test pools this many days and runs the same binomial on the
  -- pooled counts. It exists because the acute test is structurally blind to a
  -- store that runs 81% every single day and never has a dramatic one — which
  -- is exactly OVL, the district's worst store and only 3 acute yellows in 60
  -- days. 14 is long enough to build significance at ~13 customers/day.
  chronic_window  integer not null default 14,

  -- Margin's floors, in DOLLARS of gross profit short over chronic_window.
  -- A $60 shortfall on a slow fortnight is noise no matter how bad the
  -- percentage looks; $2,000+ is a conversation whatever the percentage says.
  gp_short_min    numeric not null default 250.0,
  gp_short_red    numeric not null default 2000.0,

  updated_by      text,
  updated_at      timestamptz not null default now()
);
insert into public.watch_config (id) values (1) on conflict (id) do nothing;

comment on table public.watch_config is
  'District Watch thresholds. One row. Edited by the DM from the board rather than by deploy — see 0097 header for why each default is what it is.';

-- 2. One row per store, per metric, per day. Append-only in spirit; the engine
--    upserts so a re-run repairs rather than duplicates.
--
--    'ok' DAYS ARE STORED TOO, deliberately. Without them a streak cannot be
--    computed without re-deriving history, and "when did OVL last come good"
--    stops being answerable. Five stores x three metrics x 365 days is under
--    5,500 rows a year, which is nothing.
create table public.watch_flags (
  day          date    not null,
  store        text    not null,

  -- 'listing' is allowed by the constraint but NOT emitted by the v1 engine.
  -- The listing-goals rework (0091-0093) only lands its store-targets and front
  -- end on 2026-09-21, and 0095 records that day_end_facts.devices_processed
  -- and kpi_entries.listed_count disagree by 15-30% at every store. Flagging a
  -- goal that moves next week, measured against whichever of two disagreeing
  -- numbers we happened to pick, would be a flag nobody could act on. Listed
  -- here so switching it on later needs no migration.
  metric       text    not null check (metric in ('conversion', 'margin', 'listing')),

  state        text    not null check (state in ('ok', 'warn', 'critical')),

  value        numeric,          -- the metric as measured over the window
  target       numeric,          -- what it was measured against
  sample_n     numeric,          -- customers, or dollars of buy value
  sample_k     numeric,          -- converted customers; null for margin
  p_value      numeric,          -- binomial p; null for margin, which has no such test
  shortfall    numeric,          -- customers short, or dollars of GP short
  streak       integer not null default 1,   -- consecutive days already in this state

  -- The English sentence the board and any future email both show.
  --
  -- Stored rather than computed in the browser, and it earns the column: the
  -- sentence IS the product here. A number without "and this is the 14th day
  -- running" is just another number. Computing it client-side would also mean
  -- the board and an email could word the same flag differently, which is how
  -- two screens start disagreeing about one fact.
  reason       text,

  computed_at  timestamptz not null default now(),

  primary key (day, store, metric)
);

comment on table public.watch_flags is
  'One judgement per store per metric per day, written nightly by the district-watch edge function. ok rows are kept so streaks and history stay queryable.';

-- The board reads "latest day, all stores"; the history reads "one store, one
-- metric, back in time". Both are covered.
create index if not exists watch_flags_day_idx   on public.watch_flags (day desc);
create index if not exists watch_flags_hist_idx  on public.watch_flags (store, metric, day desc);

-- Service-role only, like day_end_facts and bm_config: written by an edge
-- function, read by one tab. No anon path exists or should.
alter table public.watch_config enable row level security;
alter table public.watch_flags  enable row level security;

-- ============================================================================
-- SCHEDULE — applied via Supabase MCP `execute_sql`, because cron.schedule is a
-- function call rather than DDL. Recorded here for provenance, same convention
-- as 0089, 0095 and 0096.
--
-- 6:25am CENTRAL, as ONE hourly job with a Central-hour guard — the pattern
-- 0096 moved day-end-ingest and sales-ingest onto, not the older cdt/cst pair.
-- A pair needs two rows kept in step and leaves the dormant twin looking stale
-- to the cron watchdog; a guarded hourly job cannot drift across a DST boundary
-- into a minute someone else owns.
--
-- WHY :25, AND WHY HOUR 6. day_end_facts is filled by day-end-ingest at 5:05,
-- so the data has been ready for over an hour. 0096 records that the Apps
-- Script project owns :05 of hour 5, :05 and :10 of hour 6 and :00 of hour 7,
-- and that nothing else may sit on those minutes — this function touches no
-- Apps Script and takes no LockService lock, but :25 is clear of every one of
-- them anyway, and clear of processed-report at :15. It lands before anyone
-- opens the board in the morning.
--
--   select cron.schedule('district-watch-625am', '25 * * * *', $job$
--     select net.http_post(
--       url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/district-watch?secret=sp33ks-sync-k3y-2026-x9mq&trigger=cron',
--       headers := '{"Content-Type":"application/json"}'::jsonb,
--       body := '{}'::jsonb,
--       timeout_milliseconds := 120000
--     ) where extract(hour from (now() at time zone 'America/Chicago')) = 6;
--   $job$);
-- ============================================================================

-- The watchdog's account of when this is due. 1560 minutes (26h) is the
-- allowance every other once-a-day job in this project uses.
insert into public.cron_expectations (jobname, stale_after_min, note) values (
  'district-watch-625am',
  1560,
  'District Watch flag engine. 6:25am Central (hourly at :25, Central-hour '
  || 'guard = 6). Reads day_end_facts, which day-end-ingest fills at 5:05, and '
  || 'writes one watch_flags row per store per metric. Recomputes nothing '
  || 'upstream and sends no mail, so a missed run costs a stale board and '
  || 'nothing else — the next run repairs it.'
) on conflict (jobname) do update
  set stale_after_min = excluded.stale_after_min,
      note            = excluded.note;
