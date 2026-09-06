-- ============================================================================
-- 0079 — Listing Titles: carry lister_tag through the queue view.
--
-- 0078 added the column to the table. A view names its columns explicitly, so
-- the panel's queue could not see it until here.
--
-- ⚠️ CREATE OR REPLACE, AND THE NEW COLUMN GOES LAST. Postgres allows a replace
-- only when the existing column list is unchanged and additions are appended —
-- which is exactly what is wanted, because DROP VIEW takes the grants with it.
-- That trap has already cost this project once (see the ebay-alert cron
-- watchdog, where a dropped view came back ungranted and the job read empty).
--
-- ⚠️ EVERYTHING ELSE IS VERBATIM from pg_get_viewdef, including the 36-hour
-- ebay_live staleness rule from 0070. Retyping it from memory is how a scope
-- rule silently changes; this was copied out of the database.
-- ============================================================================

create or replace view public.listing_title_queue as
 with live_seen as (
         select ebay_live.store_code,
            max(ebay_live.seen_at) as last_seen
           from ebay_live
          group by ebay_live.store_code
        )
 select r.store_code,
    r.product_id,
    r.sku,
    r.product_handle,
    r.current_title,
    r.suggested_title,
    r.findings,
    r.basis,
    r.confidence,
    r.comps,
    r.category_id,
    r.category_name,
    r.ebay_title,
    r.severity,
    r.status,
    r.decided_by,
    r.decided_at,
    r.decided_note,
    r.swept_at,
    c.price,
    c.quantity,
    c.online_published,
    r.lister_tag
   from listing_title_reviews r
     join ebay_catalog c on c.store_code = r.store_code and c.sku = r.sku and c.product_id = r.product_id
     left join live_seen ls on ls.store_code = r.store_code
  where r.status = 'open'::text and c.title = r.current_title and c.quantity > 0 and c.online_published
    and (ls.last_seen is null or ls.last_seen < (now() - '36:00:00'::interval) or (exists ( select 1
           from ebay_live el
             join ebay_catalog c2 on c2.store_code = el.store_code and c2.sku = el.sku
          where el.store_code = r.store_code and c2.product_id = r.product_id)));
