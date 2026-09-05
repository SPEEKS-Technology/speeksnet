-- ============================================================================
-- 0065 — A LISTING NOBODY PHOTOGRAPHED IS A BLANK SQUARE IN A SHOP WINDOW.
--
-- The user checks this by hand every week: walk the online store, find anything
-- live with no picture, tell the manager to fix it. That is a person doing a
-- query. This is the query.
--
-- IT IS AN ALARM, NOT A BACKLOG, and that is the whole design. The right
-- reading is ZERO. Today, measured across all five stores, it is ONE:
--
--   OVL · KS01-7382A1-E5 · PNY 2.5" CS900 250GB SATA III SSD · published Aug 10
--
-- Verified against the storefront itself, not just this table —
-- /products/<handle>.json returns `images: []` and a null featured image, so a
-- shopper reaching that page sees a placeholder where the product should be.
-- That agreement matters: it is what makes image_count trustworthy enough to
-- put an alarm on.
--
-- WHY THERE IS NO WRITE PATH HERE. Every other queue in this panel proposes
-- something SPEEKS can do for you. This one cannot: the fix is uploading a
-- photograph, which happens in Shopify with the item in your hands. So the row
-- carries the SKU and a Shopify link and stops there. A Submit button that
-- could only ever mean "I did it elsewhere" would be a button that lies.
--
-- ON `image_count`. Written by ebay-catalog from Shopify's own
-- `images(first: 5)`, refreshed by callback-catalog-refresh three times a day
-- (09/12/15 Central) and rebuilt nightly. The cap at 5 makes the column useless
-- for "how many photos does this have" above 5 — but this view only ever asks
-- whether it is ZERO, which no cap can distort.
--
-- ⚠️ PUBLISHED IS THE GATE, NOT STOCK. 516 in-stock products have no photos
-- and 515 of them are UNPUBLISHED — real stock (a $429 RTX 3080 at LEE) that
-- no shopper can reach. That is a genuine and much larger problem, and it is
-- deliberately NOT this view: mixing a 500-row backlog into an alarm that is
-- supposed to read zero destroys the only thing the alarm is good for. It
-- belongs to unlisted-backlog, which already measures that pile weekly.
--
-- ⚠️ NO `-CheckOut` FILTER, ON PURPOSE. Those 156 SKUs are POS counter
-- artifacts and average 0.06 photos, so they poison any query about photos —
-- but they poison it through `online_published`, which is already false for
-- all but one of them (and that one has five photos). They self-filter here.
-- If one ever DOES leak onto the storefront without a picture, that is a real
-- defect a shopper can see, and this alarm should be the thing that says so.
--
-- Re-run to audit:
--   select store_code, count(*) from listing_no_photos group by store_code;
-- ============================================================================

create or replace view listing_no_photos as
select c.store_code,
       c.sku,
       c.product_id,
       c.product_handle,
       c.title,
       c.price,
       c.quantity,
       c.collections,
       c.product_created_at,
       c.seen_at
from ebay_catalog c
where c.online_published
  and coalesce(c.image_count, 0) = 0;

comment on view listing_no_photos is
  'Live on the online store with zero photographs. An alarm that should read 0 — '
  'not a backlog. Unpublished no-photo stock is deliberately excluded (see 0065).';

-- The anon key ships to every browser; the panel reaches this through
-- shopify-recat on the service role, which authenticates the person's PIN.
revoke all on listing_no_photos from anon, authenticated;
