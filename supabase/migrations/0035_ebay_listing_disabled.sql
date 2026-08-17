-- SPEEKS Connect: a listing you turned off on purpose.
--
-- 'ended' already existed, but it means "eBay no longer has this" and it is
-- written by the machinery: ebay-inventory ends a listing when Shopify hits
-- zero stock, and ebay-catalog's reconciling sweep marks a row ended when the
-- listing vanished from eBay behind our back. Both of those are reversible by
-- the same machinery — reconcile() republishes anything sitting at 'ended' the
-- moment stock comes back.
--
-- That is exactly wrong for a Disable button. Somebody pulling a listing down
-- deliberately, while the unit is still on the shelf and still in stock in
-- Shopify, would watch it come back on the next products/update webhook. So a
-- deliberate stop needs a state the automatic paths do not touch: reconcile()
-- only acts on published/ended, and the sweep only reconciles published, so a
-- row parked at 'disabled' stays down until a person uploads it again.

alter table ebay_listings drop constraint if exists ebay_listings_status_check;

alter table ebay_listings add constraint ebay_listings_status_check
  check (status in ('pending', 'published', 'failed', 'ended', 'disabled'));
