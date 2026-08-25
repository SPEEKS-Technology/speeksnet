-- ============================================================================
-- 0050_collection_proposals_view — one definition of "which shelf is this on".
--
-- The matching lives in SQL rather than in shopify-recat so that the function
-- that WRITES to five live storefronts and the query a human audits before
-- letting it are the same code. A TypeScript reimplementation would drift, and
-- the drift would only show up as products on the wrong shelf.
--
-- THE SCOPE IS THE SAFETY PROPERTY. Only products whose ONLY real collection is
-- `other` are considered — `newly-listed-devices` doesn't count, it is a smart
-- collection on price > $1 that holds every product at every store. So a rule
-- can put something on the wrong shelf (recoverable, and logged in
-- collection_moves) but can never take a product out of a collection a human
-- chose (not recoverable, because nothing recorded what that choice was).
--
-- MATCHING: case-insensitive, WORD BOUNDARY, optional trailing "s", longest
-- keyword wins. Each part was forced by a real title — see 0049.
--
-- A rule whose target is `other` is a VETO: it wins on length like any other
-- rule and is then dropped from the result, which is how a title that a shorter
-- keyword would misfile gets pinned in place by name.
--
-- ⚠️ Views are re-created here with CREATE OR REPLACE. A DROP would reset the
-- grants and hand anon and authenticated a view they should never see — the
-- trap 0039/0044 hit on ebay_cron_health. The revoke is re-issued below
-- regardless, and belongs in any future migration that touches this view.
-- ============================================================================

create or replace view collection_proposals as
with pile as (
  select distinct on (store_code, product_id)
         store_code, product_id, sku, title, product_handle, collections
  from ebay_catalog
  where quantity > 0
    and 'other' = any(collections)
    and cardinality(array(
          select c from unnest(collections) c where c <> 'newly-listed-devices'
        )) = 1
  order by store_code, product_id, sku
), scored as (
  select p.store_code, p.product_id, p.sku, p.title, p.product_handle,
         r.keyword, r.target_handle,
         row_number() over (
           partition by p.store_code, p.product_id
           order by length(r.keyword) desc, r.keyword
         ) rn
  from pile p
  join collection_rules r
    on r.active
   and lower(p.title) ~ ('\m' || regexp_replace(r.keyword, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g') || 's?\M')
)
select store_code, product_id, sku, title, product_handle, keyword, target_handle
from scored where rn = 1 and target_handle <> 'other';

revoke all on collection_proposals from anon, authenticated;
