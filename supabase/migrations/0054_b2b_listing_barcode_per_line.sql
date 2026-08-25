-- A Shopify barcode used to be unique system-wide (0005's
-- b2b_item_listings_barcode_uniq), on the premise that one barcode is one
-- Shopify listing and so can back only one of our units. In practice a single
-- listing can legitimately span units that were split across more than one of
-- our line items, so the same barcode needs to be attachable to different lines.
--
-- Uniqueness moves to (item_id, shopify_barcode): a single line still can't
-- carry the same barcode on two rows -- list_unit adds to the existing row
-- instead -- but two different lines may now share one barcode.
ALTER TABLE public.b2b_item_listings
  DROP CONSTRAINT IF EXISTS b2b_item_listings_barcode_uniq;

ALTER TABLE public.b2b_item_listings
  ADD CONSTRAINT b2b_item_listings_item_barcode_uniq UNIQUE (item_id, shopify_barcode);
