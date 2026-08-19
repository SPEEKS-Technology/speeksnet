-- Shopify -> eBay content sync.
--
-- PRODUCTS_UPDATE fires on every product edit, including ones that change
-- nothing eBay cares about (and Shopify's own inventory writes fire it too). A
-- full re-push costs several eBay calls plus Taxonomy and Metadata quota, which
-- is POOLED at 5,000/day across all five stores, so re-pushing on every webhook
-- would spend the estate's daily budget on no-op edits.
--
-- content_hash is a fingerprint of only the fields a re-push would actually
-- change on eBay: title, description HTML, image list and the spec-table
-- metafields. Price and quantity are deliberately EXCLUDED -- they already have
-- their own cheap, instant paths (reprice / reconcile), and folding them in here
-- would turn every price edit into a full listing rebuild.
alter table public.ebay_listings add column if not exists content_hash text;

comment on column public.ebay_listings.content_hash is
  'SHA-256 of the Shopify content last pushed to eBay (title, descriptionHtml, image urls, spec metafields). Excludes price and quantity, which sync via their own paths. Null means never content-synced, so the next products/update re-pushes once.';
