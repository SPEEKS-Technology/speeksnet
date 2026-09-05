-- ============================================================================
-- 0070 — the title queue is CUSTOMER-FACING STOCK ONLY: in stock, published to
-- the online store, AND live on eBay.
--
-- Ethan, 2026-08-28: "we should only show devices that are a combination of
-- in-stock, on sales channels, and on eBay. This will help make sure everything
-- customer facing is being fixed."
--
-- Two of the three were already enforced (0067): `c.quantity > 0` and
-- `c.online_published`. This adds the third.
--
-- ⚠️ WHY THIS IS IN THE VIEW AND NOT IN THE SWEEP.
-- The sweep would be the cheaper place — it would stop analysing ~64% of the
-- estate. Two reasons it is wrong:
--   1. A row the sweep skips is never re-examined, so its old `open` row would
--      sit in the queue forever. Excluding in the view is automatic and
--      reversible; excluding in the sweep leaves orphans behind.
--   2. Keeping the analysis means the moment an item IS listed on eBay it
--      appears in the queue immediately, already reasoned about, instead of
--      waiting for the next sweep to reach it.
--
-- ⚠️⚠️ THE FRESHNESS GUARD IS THE LOAD-BEARING PART OF THIS FILE.
-- `ebay_live` is filled by the five `ebay-live-sweep-*` crons, and ALL FIVE ARE
-- PAUSED (see [[ebay-exposure-false-positives]] — every eBay cron was switched
-- off after the exposure false-positive sweep). The snapshot was 76 hours old
-- when this was written and is getting older.
--
-- A hard filter on a decaying snapshot does not narrow the queue, it EMPTIES it:
-- every item listed on eBay since the last sweep reads as "not on eBay" and its
-- title problem disappears from the tool silently, forever. That is the exact
-- failure this whole tool is written to avoid — a queue that looks clean because
-- nobody asked.
--
-- So the filter only applies while the store's snapshot is FRESH. Stale, and it
-- stops filtering and shows everything, which is the safe direction: too many
-- rows is visible, too few is not. The edge function reports which state it is in
-- and the panel says so out loud, so "the eBay filter is on" is never assumed.
--
-- Measured on the 2026-08-25 snapshot: 77 queued rows -> 32 with the filter
-- active (BAL 31->13, OVL 14->4, LEE 12->3, MPL 12->6, WSP 8->6). eBay holds
-- 1,503 active listings against 2,963 in-stock published Shopify products, so
-- roughly half the estate is genuinely not on eBay — the filter is doing real
-- work, not hiding a matching bug.
--
-- ⚠️ MATCHED ON product_id, NOT ON sku. `ebay_live` is keyed by SKU and a
-- multi-variant product contributes one catalogue row per variant, while the
-- review row keeps only the FIRST sku (see candidatesFor). Matching sku to sku
-- would hide a product whose eBay listing hangs off a sibling variant. The title
-- belongs to the product, so the presence test does too.
--
-- To turn the filter off again: drop the last AND block. To make it
-- unconditional (once the sweeps are running reliably), delete the two
-- `ls.last_seen` lines and keep the EXISTS.
-- ============================================================================

create or replace view public.listing_title_queue as
with live_seen as (
  -- One aggregate over ~1,500 rows, rather than a correlated max() per queue
  -- row. `ebay_live_seen_idx` is (store_code, seen_at).
  select store_code, max(seen_at) as last_seen
    from public.ebay_live
   group by store_code
)
select r.store_code, r.product_id, r.sku, r.product_handle,
       r.current_title, r.suggested_title, r.findings, r.basis, r.confidence,
       r.comps, r.category_id, r.category_name, r.ebay_title,
       r.severity, r.status, r.decided_by, r.decided_at, r.decided_note,
       r.swept_at,
       c.price, c.quantity, c.online_published
  from public.listing_title_reviews r
  join public.ebay_catalog c
    on c.store_code = r.store_code
   and c.sku = r.sku
   and c.product_id = r.product_id
  left join live_seen ls
    on ls.store_code = r.store_code
 where r.status = 'open'
   -- Still the same title we reasoned about.
   and c.title = r.current_title
   -- Still worth somebody's attention: in stock, and reachable by a shopper.
   -- A title is a findability asset, and an unpublished product cannot be found
   -- at any price. Same scope the other two Listing Health queues use, for the
   -- same reason (see 0056).
   and c.quantity > 0
   and c.online_published
   -- And live on eBay — but only while we can honestly say so. See the header.
   and (
     ls.last_seen is null
     or ls.last_seen < now() - interval '36 hours'
     or exists (
       select 1
         from public.ebay_live el
         join public.ebay_catalog c2
           on c2.store_code = el.store_code
          and c2.sku = el.sku
        where el.store_code = r.store_code
          and c2.product_id = r.product_id)
   );
