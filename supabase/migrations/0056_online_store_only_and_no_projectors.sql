-- ============================================================================
-- 0056 — two corrections from the storefront owner.
--
-- 1. THE SHELVES ARE PAYMORE'S, NOT OURS. Franchise corporate runs the online
--    store; the 63 collections are the same at all five shops by standard, and
--    a 64th invented here is a shelf only we know about. So `projectors` is
--    retired: the collection is deleted at Ballwin (the only store where the
--    create actually landed — see below), the one product filed onto it is back
--    on Monitors & Displays, and the rule points there again, which is where it
--    pointed before 0055.
--
--    ⚠️ 0055 SAID "created at all five stores". IT WASN'T. A collection count
--    per shop reads 64 at Ballwin and 63 at the other four, and both
--    `handle:projectors` and `title:Projector*` find nothing at those four. One
--    collection existed, one was deleted.
--
--    The foreign keys below are the part that outlives this. A rule or a Call
--    Back type may now only name a collection that exists in
--    shopify_collections, so the next time a shelf looks missing the write
--    fails loudly instead of quietly filing stock somewhere no shopper can
--    reach. Adding a shelf now means PayMore adds it and we record it, in that
--    order.
--
-- 2. ONLY WHAT IS ON THE ONLINE STORE. A product that is not published to the
--    Online Store sales channel is not merchandised, so which collection it
--    sits in changes nothing a customer can see, and reviewing it spends the
--    scarcest thing here — somebody's attention — on a shelf nobody visits.
--    ebay_catalog.online_published already carries this: ebay-catalog reads
--    `onlineStoreUrl`, which is non-null only while the product is live on the
--    online store.
--
--    MEASURED, in stock, unpublished: OVL 496, WSP 160, MPL 161, LEE 99,
--    BAL 51. The junk-drawer queue goes 373 → 289; misfiled 21 → 17.
-- ============================================================================

-- --- 1. the shelf that was ours and should not have been --------------------

update collection_rules
   set target_handle = 'monitors-displays',
       note = 'PayMore has no Projectors collection and corp owns the storefront '
              || '(the one created 2026-08-21 was deleted); a projector is filed as a display'
 where keyword = 'projector';

update callback_types
   set collection_handle = 'monitors-displays'
 where collection_handle = 'projectors';

-- The Hisense really is on Monitors & Displays now (verified by reading the
-- product back), so the ledger says so. Rewriting it to name a collection that
-- no longer exists anywhere would make the row a lie AND break the new FK's
-- premise the moment anyone trusted it.
update collection_moves
   set added_handle = 'monitors-displays',
       rule_keyword = rule_keyword || ' · re-filed when the Projectors shelf was retired'
 where added_handle = 'projectors';

delete from shopify_collections where handle = 'projectors';

alter table collection_rules
  drop constraint if exists collection_rules_target_handle_fkey,
  add constraint collection_rules_target_handle_fkey
    foreign key (target_handle) references shopify_collections(handle)
    on update cascade on delete restrict;

alter table callback_types
  drop constraint if exists callback_types_collection_handle_fkey,
  add constraint callback_types_collection_handle_fkey
    foreign key (collection_handle) references shopify_collections(handle)
    on update cascade on delete restrict;

-- --- 2. the queues only show live listings ----------------------------------
-- ⚠️ CREATE OR REPLACE, never DROP: a DROP resets the grants and hands anon a
-- view it should never see. See 0050 and [[db-rls-convention]].

create or replace view collection_proposals as
with pile as (
  select distinct on (store_code, product_id)
         store_code, product_id, sku, title, product_handle, collections
  from ebay_catalog
  where quantity > 0
    and online_published
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

create or replace view collection_misfiled as
with pile as (
  select distinct on (store_code, product_id)
         store_code, product_id, sku, title, product_handle, collections
  from ebay_catalog
  where quantity > 0
    and online_published
    and not ('other' = any(collections))
    and cardinality(array(
          select c from unnest(collections) c where c <> 'newly-listed-devices'
        )) >= 1
  order by store_code, product_id, sku
), scored as (
  select p.store_code, p.product_id, p.sku, p.title, p.product_handle, p.collections,
         r.keyword, r.target_handle,
         row_number() over (
           partition by p.store_code, p.product_id
           order by length(r.keyword) desc, r.keyword
         ) rn
  from pile p
  join collection_rules r
    on r.active and r.strong
   and case when position(r.keyword in lower(p.title)) > 0
            then lower(p.title) ~ r.pattern
            else false end
)
select s.store_code, s.product_id, s.sku, s.title, s.product_handle,
       s.keyword, s.target_handle,
       array(select c from unnest(s.collections) c
              where c <> 'newly-listed-devices' and c <> s.target_handle) wrong_handles
from scored s
where s.rn = 1
  and not (s.target_handle = any(s.collections))
  and not exists (select 1 from collection_skips k
                   where k.store_code = s.store_code and k.product_id = s.product_id)
  and not exists (select 1 from collection_moves m
                   where m.store_code = s.store_code and m.product_id = s.product_id
                     and m.undone_at is null);

revoke all on collection_misfiled from anon, authenticated;
