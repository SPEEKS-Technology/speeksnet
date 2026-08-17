-- The eBay category a listing was matched into, in words.
--
-- We already stored category_id, but "56083" answers nobody's question. The
-- category is chosen for us by eBay's taxonomy suggestion from the product
-- title, so it is the one part of a listing nobody at the store picked and
-- nobody could see — and when it comes out wrong (a phone landing in Sunglasses)
-- the refusal that follows reads as a condition problem rather than a category
-- problem. Storing the name is what lets the panel show it.
--
-- Nullable and unbackfilled on purpose: the name is only known at the moment
-- the taxonomy is queried, so existing rows keep their id and show a dash until
-- they are uploaded again.

alter table ebay_listings add column if not exists category_name text;
