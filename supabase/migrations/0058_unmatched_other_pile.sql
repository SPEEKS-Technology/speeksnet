-- ============================================================================
-- 0058 — THE OTHER PILE HAD A THIRD OF IT INVISIBLE.
--
-- The panel's queue is `collection_proposals`, and a proposal only exists when
-- a RULE matches the title. So the panel was never a list of the Other pile —
-- it was a list of the pile we happened to have a guess for. Everything else
-- sat in Other on the live storefront and appeared on NO screen anywhere:
--
--   MEASURED, live on the online store and in stock, in Other, no rule match:
--   OVL 13, MPL 16, BAL 9, LEE 6, WSP 4 — 48 items.
--
-- They are not exotic. "Xreal One Pro Smart Glasses", "Roland V-60HD HD Video
-- Switcher", "Bose Alto Audio Sunglasses", "Planet COSMO Communicator". They
-- are the ones no keyword was ever going to reach, which is exactly why a
-- human has to see them — and the panel's own shelf picker has been sitting
-- there the whole time, one click from filing any of them.
--
-- So: a third queue. Same pile, no guess, the person picks the shelf.
--
-- THE INVARIANT THIS ADDS, and the reason it is worth a migration rather than
-- a smarter rule set: every live in-stock listing in Other is now in exactly
-- one of five states — proposed, unmatched, skipped, filed, or vetoed. Nothing
-- can fall between the queues again, because "no rule matched" is now a state
-- with a screen rather than the absence of one.
--
--   select ... from ebay_catalog where online_published and quantity > 0
--     and 'other' = any(collections)
--   == proposals + unmatched + skips + moves + veto-matched
--
-- A VETO IS A DECISION, SO IT STAYS INVISIBLE. Two rules target `other` on
-- purpose (see their notes: a vintage Kaypro 286i, an Apple IIe). A product a
-- veto rule matches is deliberately not offered, which is why the exclusion
-- below is "no active rule matches" and not "no rule proposes a real shelf".
-- One item at OVL is in that state today.
--
-- ⚠️ CREATE OR REPLACE, never DROP: a DROP resets the grants and hands anon a
-- view it should never see. See 0050 and [[db-rls-convention]].
-- ============================================================================

-- `= 1` meant "Other is its only real shelf", and a product in Other AND a real
-- category matched no queue at all: proposals wanted 1, misfiled wanted no
-- Other, unmatched would want the same 1. Zero rows are in that state today at
-- all five stores, which is the only reason this is a one-line relaxation and
-- not a repair — filing one still LEAVES Other, which is the whole point.
create or replace view collection_proposals as
with pile as (
  select distinct on (store_code, product_id)
         store_code, product_id, sku, title, product_handle, collections
  from ebay_catalog
  where quantity > 0
    and online_published
    and 'other' = any(collections)
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

-- The third queue. No keyword, no target — the row is a QUESTION, and the
-- answer is whatever a person picks. `keyword` and `target_handle` are carried
-- as nulls rather than dropped so the queue is one shape for all three modes;
-- the function refuses to file a row that still has no shelf.
create or replace view collection_unmatched as
with pile as (
  select distinct on (store_code, product_id)
         store_code, product_id, sku, title, product_handle, collections
  from ebay_catalog
  where quantity > 0
    and online_published
    and 'other' = any(collections)
  order by store_code, product_id, sku
)
select p.store_code, p.product_id, p.sku, p.title, p.product_handle,
       null::text  as keyword,
       null::text  as target_handle,
       array['other']::text[] as wrong_handles
from pile p
where not exists (select 1 from collection_rules r
                   where r.active
                     and case when position(r.keyword in lower(p.title)) > 0
                              then lower(p.title) ~ r.pattern
                              else false end)
  and not exists (select 1 from collection_skips k
                   where k.store_code = p.store_code and k.product_id = p.product_id)
  and not exists (select 1 from collection_moves m
                   where m.store_code = p.store_code and m.product_id = p.product_id
                     and m.undone_at is null);

revoke all on collection_unmatched from anon, authenticated;
