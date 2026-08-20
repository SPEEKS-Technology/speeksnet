-- What the Fix prompt showed its answer FROM.
--
-- The prompt used to be a dropdown and nothing else, so answering "what
-- condition is this card?" meant opening the product in Shopify in another tab.
-- Everything needed to answer it — the full title, the picture, every spec row,
-- and which field the condition was actually read out of — is already computed
-- on the way to the failure and was being thrown away with the response.
--
-- Kept beside missing_fields rather than re-fetched on open: the evidence has to
-- be the state at the moment eBay refused, not the state now. A product edited
-- between the failure and someone pressing Fix would otherwise show rows that
-- had nothing to do with the refusal being explained.
--
-- The condition block matters most. A spec table cannot show why a card failed
-- when the culprit is an `ebay_condition` metafield the buyer-facing table never
-- mentions, which is exactly the 1500 (New (Other)) that stopped 21 graded cards
-- at MPL.
alter table public.ebay_listings
  add column if not exists evidence jsonb;

comment on column public.ebay_listings.evidence is
  'Product state at the moment of failure, for the Fix prompt to show: '
  '{title, price, image, images, specs: [[name, value], ...], '
  'condition: {read, source, allowedHere}}. Written by ebay-sync on failure.';
