-- ============================================================================
-- 0071 — the five `ebay-live-sweep-*` crons back on, at 4x a day instead of 3x
-- an hour.
--
-- Ethan, 2026-08-28: "As long as it is read only and we are safe there that
-- nothing can write, you can reenable them."
--
-- ⚠️ VERIFIED READ-ONLY BEFORE ENABLING, not assumed. `ebay-catalog?live=1`
-- makes exactly TWO calls to eBay in the whole file:
--     /identity/v1/oauth2/token            OAuth refresh
--     /ws/api.dll  GetMyeBaySelling        a READ of the seller's ActiveList
-- There is no AddItem, ReviseItem or EndItem, and no Inventory API PUT/POST/
-- DELETE anywhere in the path. The two DELETEs in the function are PostgREST
-- against our own cache tables.
--
-- ⚠️ THE ONE SIDE EFFECT THAT IS NOT A CACHE WRITE: a complete sweep marks
-- `ebay_listings` rows `published` -> `ended` when eBay no longer lists the SKU.
-- That is a real state change other tools read. Checked first: ZERO rows are
-- `published` at any store today (all `disabled` under standby, plus 6
-- `dismissed`), so the reconcile is a no-op — and all five manual runs returned
-- `reconciled: 0`, confirming it. If SPEEKS Connect ever comes off standby this
-- clause becomes live again and should be re-read then.
--
-- Proven on all five stores before scheduling. Our count equalled EBAY'S OWN
-- count in every one, no SKU-less listings, nothing truncated:
--     OVL 469/469   LEE 203/203   WSP 352/352   MPL 462/462   BAL 373/373
-- The stale snapshot had OVL at 256 against a real 469 — 213 listings invisible
-- to us — which is exactly why migration 0070 refuses to filter on a stale one.
--
-- ⚠️ WHY 4x A DAY AND NOT THE OLD 3x AN HOUR. The old cadence was for
-- ebay-autolist, which needed to know within minutes whether a SKU was already
-- listed. Nothing needs that today: the only live consumer is the title queue's
-- scope filter, whose freshness window is 36 HOURS (0070). At the old rate five
-- stores upsert ~100k rows a day to re-state what has not changed, on a project
-- that has already taken a Disk IO warning for exactly that shape of no-op write
-- (see [[disk-io-budget]]). Every 6 hours gives a snapshot never older than ~6h,
-- six times the margin the filter needs, at 5% of the write volume.
--
-- Staggered by 7 minutes so five stores never refresh their tokens at once.
-- ⚠️ Raise this again if ebay-autolist is ever taken off standby.
--
-- No `cron_expectations` row on purpose: the ebay jobs are outside the
-- watchdog's scope, and this one already has a better and more visible monitor —
-- the Titles panel prints an amber line naming the snapshot's age the moment it
-- passes 36 hours, in front of the person whose list would be affected.
-- ============================================================================

do $$
declare
  j record;
  want text;
begin
  for j in select jobid, jobname from cron.job where jobname like 'ebay-live-sweep-%' loop
    want := case j.jobname
      when 'ebay-live-sweep-ovl' then '5 0,6,12,18 * * *'
      when 'ebay-live-sweep-lee' then '12 0,6,12,18 * * *'
      when 'ebay-live-sweep-wsp' then '19 0,6,12,18 * * *'
      when 'ebay-live-sweep-mpl' then '26 0,6,12,18 * * *'
      when 'ebay-live-sweep-bal' then '33 0,6,12,18 * * *'
    end;
    if want is null then
      raise exception 'unexpected live-sweep job: %', j.jobname;
    end if;
    perform cron.alter_job(j.jobid, schedule := want, active := true);
  end loop;
end $$;

-- ⚠️ RE-ENABLING NEEDS A WARM-UP RUN, and skipping it emails five criticals.
-- `ebay_cron_health` is scoped `WHERE j.active`, so a paused job is invisible to
-- the watchdog and its `cron.job_run_details.last_run` keeps ageing. The moment
-- these went active they re-entered the watchdog carrying a three-day-old
-- last_run and were reported — correctly — as stopped.
--
-- Curling the endpoint by hand does NOT fix it: only pg_cron writes
-- job_run_details. So the sequence that was actually run here was:
--     1. this file's schedule + active
--     2. temporarily `* * * * *`, wait for one tick, confirm all five succeeded
--     3. back to the 6-hourly schedule above
--     4. 0072, so the 30-minute default does not condemn a 6-hourly job
-- Confirmed afterwards with `ebay-alert?dryRun=1`: open 0, wouldAlert 0.
