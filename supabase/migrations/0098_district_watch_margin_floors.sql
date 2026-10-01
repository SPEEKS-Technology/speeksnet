-- ============================================================================
-- 0098 — District Watch: the margin dollar floors were too low
--
-- 0097 shipped gp_short_min = $250 and gp_short_red = $2,000 as guesses. The
-- 50-day backfill immediately proved the first one wrong, in exactly the way
-- 0097's own header warned the thresholds might be.
--
-- WHAT $250 PRODUCED, over the 50 days to 2026-09-19 (days flagged / 50):
--
--            OVL   LEE   WSP   BAL   MPL
--   $250      49    45    37     0     0
--
-- LEE warned for 45 consecutive days and WSP for 37. Both were true — each is
-- genuinely a point or two under target — but a warning that never clears and
-- never changes is not information, it is furniture. The board would have
-- opened every morning with three permanent ambers, which is the precise
-- failure mode 0097 set out to avoid and then walked into from the other side:
-- the conversion test was tuned against real data, the margin floors were not.
--
-- WHY $250 WAS NEVER RIGHT. It is an absolute figure with no relationship to
-- how much a store buys. Against LEE's ~$40k of buying in a 14-day window it
-- is 0.6% of value — comfortably inside the noise of which deals happened to
-- land in the window.
--
-- THE FLOORS, MEASURED (days at or above each floor, out of 50):
--
--             OVL   LEE   WSP
--   $250       49    45    37     <- shipped in 0097; wallpaper
--   $750       41    28    27
--   $1,250     32    15     1     <- chosen
--   $2,000     21     0     0
--   $3,000     12     0     0     <- chosen for red
--
-- $1,250 leaves OVL as the standing problem, which is correct — it averages
-- $1,873 behind over any 14-day window, near $100k of gross profit a year on
-- that run rate, and Ethan's rule is that a store under target stays flagged
-- until it climbs back. LEE flickers at 15 days, which matches a real but
-- unurgent $904 average. WSP drops to a single day and BAL and MPL stay clear;
-- both of those two actually run AHEAD of target ($1,464 and $1,728 to the
-- good per window), so silence is the honest answer for them.
--
-- $3,000 for red rather than $2,000, so critical means OVL's worst stretches
-- rather than its ordinary ones — 12 days instead of 21.
--
-- ⚠️ THE FLOORS ARE ABSOLUTE ON PURPOSE, and this is the part most likely to
-- be "fixed" later into a percentage. A flat dollar floor means the busiest
-- store trips on a smaller percentage gap than a quiet one. That is the
-- intent, not a defect: a 1-point gap at OVL costs more real money than a
-- 2-point gap at BAL, and the whole reason this engine ranks on dollars is to
-- send the DM where the money is rather than where the percentage looks worst.
--
-- Column defaults AND the live row are both moved, so a fresh database and
-- this one agree. district-watch's own DEFAULTS constant is kept in step in
-- the same change.
--
-- Apply via Supabase MCP `apply_migration`. Re-run the backfill afterwards —
-- watch_flags stores the verdict, not the inputs, so existing rows keep the
-- old thresholds' answers until they are recomputed.
-- ============================================================================

alter table public.watch_config alter column gp_short_min set default 1250.0;
alter table public.watch_config alter column gp_short_red set default 3000.0;

update public.watch_config
   set gp_short_min = 1250.0,
       gp_short_red = 3000.0,
       updated_by   = '0098 migration',
       updated_at   = now()
 where id = 1;
