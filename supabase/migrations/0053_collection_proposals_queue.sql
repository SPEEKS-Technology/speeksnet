-- ============================================================================
-- 0053_collection_proposals_queue — the view becomes a QUEUE, and stops
-- taking four and a half seconds to say so.
--
-- WHAT IT NOW DROPS, beyond the veto rules of 0050:
--   · anything a reviewer skipped (0052)
--   · anything already MOVED. ebay_catalog keeps the stale collection list
--     until the next full sweep, so without this the queue re-offers its own
--     finished work and the panel looks like it did nothing. An undone move
--     (undone_at set) puts the product back, which is what an undo should do.
--
-- THE PERFORMANCE STORY, because the fix is not the obvious one.
-- The view cost 4,445ms per call, and the panel paid it SIX times per open —
-- once for the queue, five more for the per-store counts — so opening the tab
-- read as a hang. EXPLAIN ANALYZE showed why: a nested loop applying the
-- boundary regex to every product × every rule, 134,715 evaluations, each one
-- first rebuilding its pattern with regexp_replace.
--
-- Two changes:
--   1. the escaped pattern becomes a STORED GENERATED COLUMN on
--      collection_rules, so it is built 295 times rather than 134,715.
--   2. a plain substring test guards the regex. Every keyword that matches on a
--      word boundary is also a substring, so `position(keyword in title) > 0`
--      can never reject a pair the regex would have accepted — it only throws
--      away the 99% that were never going to match.
--
-- ⚠️ THE GUARD HAS TO BE A `CASE`, NOT AN `AND`. Written as a conjunct, the
-- planner is free to order it however it costs it — and it put the regex FIRST,
-- so all 134,715 regexes still ran and the view still took 4.4s. A CASE is
-- evaluation order, not a hint. 4,445ms → 168ms, same 374 rows.
--
-- ⚠️ CREATE OR REPLACE, never DROP: a DROP resets the grants and hands anon and
-- authenticated a view they should never see. See 0050 and [[db-rls-convention]].
-- ============================================================================

alter table collection_rules
  add column if not exists pattern text
  generated always as
    ('\m' || regexp_replace(keyword, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g') || 's?\M') stored;

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
   and case when position(r.keyword in lower(p.title)) > 0
            then lower(p.title) ~ r.pattern
            else false end
)
select s.store_code, s.product_id, s.sku, s.title, s.product_handle, s.keyword, s.target_handle
from scored s
where s.rn = 1
  and s.target_handle <> 'other'
  and not exists (select 1 from collection_skips k
                   where k.store_code = s.store_code and k.product_id = s.product_id)
  and not exists (select 1 from collection_moves m
                   where m.store_code = s.store_code and m.product_id = s.product_id
                     and m.undone_at is null);

revoke all on collection_proposals from anon, authenticated;
