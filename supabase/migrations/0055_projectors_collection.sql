-- ============================================================================
-- 0055_projectors_collection — a 64th shelf, and the rule that fills it.
--
-- 19 projectors were in stock and PayMore had no collection for them, so the
-- rule filed them under Monitors & Displays on the grounds that a projector is
-- a display. Created at all five stores 2026-08-21 with collectionCreate; the
-- Shopify half is not in this file because it is an API write, not a migration.
--
-- ⚠️ A COLLECTION CREATED BY THE API IS NOT PUBLISHED TO THE STOREFRONT.
-- /collections/projectors returned 404 while an existing empty collection
-- (televisions) returned 200. Publishing needs `write_publications`, which the
-- app does not hold — it cannot even READ publications. So it has to be turned
-- on in Shopify admin per store, or the scope added and every store
-- re-installed. Until then the shelf works for the Call Back matcher (which
-- reads the Admin API) and is invisible to shoppers.
--
-- The customer vocabulary moves with the rule: a shelf with no types is a
-- shelf nobody can log a Call Back against.
-- ============================================================================

insert into shopify_collections (handle, title, product_count, store_count, matchable, sort_order)
values ('projectors', 'Projectors', 0, 5, true,
        coalesce((select max(sort_order) from shopify_collections), 0) + 1)
on conflict (handle) do update set title = excluded.title, matchable = true;

update collection_rules
   set target_handle = 'projectors',
       note = 'a Projectors collection now exists at all 5 stores (created 2026-08-21)'
 where keyword = 'projector';

update callback_types
   set collection_handle = 'projectors', sort_order = 1
 where collection_handle = 'monitors-displays' and name = 'Projector';
