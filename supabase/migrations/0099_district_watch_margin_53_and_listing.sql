-- ============================================================================
-- 0099 — Buy margin target drops to 53%, and listing productivity starts being
-- flagged instead of merely shown.
--
-- Both asked for by Ethan on 2026-09-21, after a day of looking at the board.
--
-- ============================================================================
-- 1. MARGIN TARGET 54.5% -> 53.0%, AND THE DOLLAR FLOORS HAVE TO MOVE WITH IT
-- ============================================================================
-- This is the part that is NOT obvious and would have quietly broken the
-- engine if the target had been edited on its own.
--
-- Lowering the target lowers every store's measured shortfall by 1.5% of its
-- buy value — about $1,374 a fortnight at OVL. Measured over the 32 rolling
-- 14-day windows since 2026-08-14, the whole distribution collapses:
--
--            avg short @54.5   avg short @53.0   worst window @53.0
--   OVL           $1,873            $1,078             $2,581
--   LEE             $904              $284             $1,138
--   WSP             $632               -$2               $498
--   BAL          -$1,464           -$2,192              ahead
--   MPL          -$1,728           -$2,839              ahead
--
-- Left at 0098's floors ($1,250 / $3,000), OVL's WORST fortnight in six weeks
-- lands at $2,581 and never reaches red — the district's one genuine margin
-- problem, roughly $67k of gross profit a year at that run rate, could no
-- longer raise its voice. The floors are not independent of the target; they
-- are a distance FROM it, and a distance has to be restated when the thing it
-- is measured from moves.
--
-- Rescaled by the same ratio the shortfalls fell (~0.58), rounded:
--   gp_short_min  $1,250 -> $750
--   gp_short_red  $3,000 -> $1,750
--
-- Which restores the behaviour 0098 tuned for: OVL warns on roughly 18 of 32
-- windows and goes critical on about 12, LEE flickers on about 7, and WSP, BAL
-- and MPL stay silent.
--
-- ============================================================================
-- 2. LISTING PRODUCTIVITY BECOMES A FLAGGED METRIC
-- ============================================================================
-- 0097 allowed 'listing' in watch_flags.metric but deliberately never emitted
-- it, on two grounds. One has since expired and one has not:
--
--   EXPIRED — "the goals are mid-rework". store-targets shipped 2026-09-21.
--   STANDS  — devices_processed (Day End Report) runs 15-30% below the
--             manager-filed kpi_entries.listed_count (see 0095).
--
-- The rule Ethan asked for is simply: flag a store that misses the total it
-- was STAFFED to list. listing_goals holds one goal per person per day, so the
-- store's staffed goal for a day is the sum of its roster's goals, and the
-- window figure is those summed across 14 days.
--
-- ⚠️ THE SECOND GROUND STILL STANDS AND THE UI MUST KEEP SAYING SO. This
-- measures Day End processed against a manager-set goal, so it reads HARSHER
-- than the DM's Store Efficiency board, which scores the larger weekly-KPI
-- number. Two screens, two answers, both defensible. Whoever removes that note
-- from the popup is removing the only thing that explains the gap.
--
-- It is not a systematic penalty, though, and that is what makes it worth
-- flagging: BAL, LEE and WSP clear their staffed goal on this same yardstick
-- while OVL and MPL do not.
--
-- THRESHOLDS, in DEVICES SHORT over the 14-day window. Same shape as the other
-- two metrics — say the shortfall out loud, in the unit the work is done in.
-- Rolling 14-day windows since 2026-08-14, days at or above each floor / 32:
--
--            avg short   worst    >=25   >=60   >=120   >=200
--   OVL          157      242      32     30      25       8
--   MPL          103      163      32     26      13       0
--   WSP            6      135      15     11       5       0
--   LEE           -8      119      12      6       0       0
--   BAL          -16      123      11      7       2       0
--
-- 25 is too low: every store trips it a third of the time, including the three
-- that clear their goal on average. 60 / 200 leaves OVL as the standing problem
-- (30 windows warn, 8 critical), MPL clearly behind (26 warn), and the other
-- three occasional — which matches what the stores are actually doing.
--
-- listing_min_goal exists so a fortnight where the roster was barely filled in
-- cannot flag: with only a handful of goals set, "missed by 60" says more about
-- the rota than the floor.
--
-- ⚠️ THE FLOORS ARE ABSOLUTE, like the margin ones, and for the same reason. A
-- device listed is a device listed. A flat floor means the store staffed for
-- more trips on a smaller percentage, which is the intent.
--
-- Apply via Supabase MCP `apply_migration`. Re-run the backfill afterwards —
-- watch_flags stores the verdict, not the inputs.
-- ============================================================================

alter table public.watch_config alter column margin_target set default 53.0;
alter table public.watch_config alter column gp_short_min  set default 750.0;
alter table public.watch_config alter column gp_short_red  set default 1750.0;

-- Devices short of the staffed goal, pooled over chronic_window.
alter table public.watch_config
  add column if not exists listing_short_min numeric not null default 60.0;
alter table public.watch_config
  add column if not exists listing_short_red numeric not null default 200.0;
-- Minimum goal volume in the window before listing is judged at all.
alter table public.watch_config
  add column if not exists listing_min_goal  numeric not null default 60.0;

comment on column public.watch_config.listing_short_min is
  'Devices short of the staffed goal, pooled over chronic_window, before listing warns. Absolute, not a percentage - see 0099.';
comment on column public.watch_config.listing_short_red is
  'Devices short before listing goes critical.';
comment on column public.watch_config.listing_min_goal is
  'Minimum total staffed goal in the window before listing is judged at all - guards a fortnight with a barely-filled rota.';

update public.watch_config
   set margin_target     = 53.0,
       gp_short_min      = 750.0,
       gp_short_red      = 1750.0,
       listing_short_min = 60.0,
       listing_short_red = 200.0,
       listing_min_goal  = 60.0,
       updated_by        = '0099 migration',
       updated_at        = now()
 where id = 1;
