-- 0176 — remove the SPEEKS Connect Pricing tool (Ethan, 2026-11-06: "We are
-- going to put this on pause. You can revert everything related to this
-- pricing tool" → "Remove everything").
--
-- What it undoes (all applied 2026-11-04/05; their files were never committed —
-- they live in git stash "December Update 1 open work (pricing tool, claims)"):
--   0165_price_history        price_history + snapshot_prices() + cron price-history-daily
--   0166_pos_reprices         pos_reprices (31,935 POS Repricer Report rows, Jan–Nov 4 2026)
--   0167_pos_reprice_cuts     view pos_reprice_cuts
--   0171_pricing_reviews      pricing_reviews (the BAL sweep's verdicts)
--   0172_pricing_sweep_cron   cron pricing-sweep-hourly + its cron_expectations row
-- The listing-pricing edge function is deleted alongside this.
--
-- If it comes back: re-apply those files from the stash, re-deploy the function,
-- and re-import the Repricer Reports (pos_reprices) — the data dropped here is
-- not recoverable; the price snapshots only went back to 2026-11-04 anyway.

select cron.unschedule('pricing-sweep-hourly') where exists (select 1 from cron.job where jobname = 'pricing-sweep-hourly');
select cron.unschedule('price-history-daily')  where exists (select 1 from cron.job where jobname = 'price-history-daily');
delete from public.cron_expectations where jobname in ('pricing-sweep-hourly', 'price-history-daily');

drop view if exists public.pos_reprice_cuts;
drop table if exists public.pos_reprices;
drop table if exists public.pricing_reviews;
drop function if exists public.snapshot_prices();
drop table if exists public.price_history;
