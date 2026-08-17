-- ONE ROW PER LIVE LISTING, NOT PER SKU.
--
-- ebay_live answers "what is live on this eBay account, whoever listed it", and
-- the honest answer is sometimes two listings for one SKU. The sweep already
-- detected that and threw it away: it counted duplicateSkus and kept only the
-- first item_id, because the primary key had room for nothing else. Eight SKUs
-- at OVL are in that state right now — four are genuinely different products
-- sharing one SKU in Shopify (three Game Boy games under KS01-5550B-E4), one is
-- Marketplace Connect having listed the same item twice, and three are a unit we
-- listed that MC then listed again when it came back online.
--
-- Keeping only one of them is not just lost reporting, it is a hole in the
-- ownership guard. That guard now verifies the cached listing against eBay
-- before refusing, and prunes it if eBay says it has ended — so for a SKU with
-- two live MC listings where only the stored one was ended, it would clear the
-- row and publish, putting a third listing against a unit that already had one.
-- The guard is already written to loop over every row it finds; it just never
-- got more than one.
--
-- item_id is part of the key, so it must stop being nullable. A row without one
-- names no listing and could never have been verified or ended anyway.

delete from public.ebay_live where item_id is null;

alter table public.ebay_live alter column item_id set not null;

alter table public.ebay_live drop constraint if exists ebay_live_pkey;

alter table public.ebay_live add primary key (store_code, sku, item_id);

-- The guard and the coverage diff both look up by (store, sku); the primary key
-- now leads with store_code and sku, so it already serves those. This one is for
-- the prune, which sweeps by store and age.
create index if not exists ebay_live_seen_idx on public.ebay_live (store_code, seen_at);
