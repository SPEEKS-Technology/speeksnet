-- ============================================================================
-- 0068 — the Listing Titles sweep, on a schedule.
--
-- WHY THIS TOOL NEEDS A CRON AND ITS TWO NEIGHBOURS DO NOT.
-- Categories and No Pictures are VIEWS (`collection_proposals`,
-- `collection_misfiled`, `listing_no_photos`) computed at read time from
-- `ebay_catalog`, so they are current the moment that table is — and it is, from
-- `callback-catalog-refresh` three times a day plus a full rebuild at 2am.
-- Neither tool has ever had a cron of its own.
--
-- Listing Titles is a stored TABLE instead, because the market half costs an eBay
-- Browse call per model and cannot be computed while somebody waits. So it alone
-- needs sweeping.
--
-- ⚠️ RULES-ONLY. NO `market=1` HERE, DELIBERATELY.
-- Without it the sweep touches no eBay API at all — it reads `ebay_catalog` and
-- Shopify, exactly like the two Shopify sweeps that already run. That matters
-- because the ten eBay-API crons are currently PAUSED
-- (`ebay-live-sweep-*`, `ebay-orders-poll-*`); this job must not quietly become
-- an eleventh. A rules-only pass finds the DEFECTS — a title naming a product
-- that does not exist is the market half's job and stays a manual run
-- (`?sweep=1&store=&market=1&limit=…&save=1&secret=`), which is also far slower.
--
-- ⚠️ IT NEVER WRITES A LISTING. `save=1` persists QUEUE ROWS. The only thing in
-- listing-titles that writes to a live catalogue is POST approve, which needs a
-- person's PIN and one product id.
--
-- TIMING. 10am and 4pm Central, each just after `callback-catalog-refresh`
-- (9:28 / 15:28) has topped up the Shopify data this reads — sweeping first would
-- reason about yesterday's catalogue.
--
-- ONE JOB, NOT A cdt/cst PAIR. Scheduled at both DST-candidate UTC hours and
-- gated on the CENTRAL hour inside, the way `callback-catalog-refresh` and
-- `google-reviews-snapshot` do it. The pair-of-jobs pattern elsewhere fires twice
-- a year too often; this cannot.
--
-- LIMIT 1200 covers every store whole — the biggest holds 798 in-scope products
-- and all five together take 49 seconds. A cap that could not cover one store in
-- one run would only mean half a store was permanently out of date for no saving.
--
-- The five calls go out through pg_net, which queues them rather than blocking,
-- so the statement does not sit for the sum of the five.
-- ============================================================================

select cron.unschedule('listing-titles-sweep')
 where exists (select 1 from cron.job where jobname = 'listing-titles-sweep');

select cron.schedule('listing-titles-sweep', '20 15,16,21,22 * * *', $job$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/listing-titles?sweep=1&store='
           || s || '&limit=1200&save=1&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 55000)
  from (values ('OVL'),('LEE'),('WSP'),('MPL'),('BAL')) as t(s)
  where extract(hour from (now() at time zone 'America/Chicago')) in (10,16);
$job$);

-- --- the watchdog has to know about it --------------------------------------
-- ⚠️ A cron nobody watches is a cron that stops without telling anybody, which
-- for this tool means a queue that silently freezes and reads as "no title
-- problems" — the worst possible failure for a review queue. See
-- [[ebay-alert-cron-watchdog]]; per-job allowances arrived in 0044.
--
-- 1200 minutes because the gap that matters is the OVERNIGHT one: 4pm to 10am is
-- 18 hours by design, so anything tighter would page every morning. Same number
-- and same reasoning as callback-catalog-refresh.
insert into public.cron_expectations (jobname, stale_after_min, note)
values ('listing-titles-sweep', 1200,
        'Fires 10:20/16:20 Central — an 18h gap overnight, so allow 20h. Rules-only: no eBay API.')
on conflict (jobname) do update
  set stale_after_min = excluded.stale_after_min,
      note = excluded.note;
