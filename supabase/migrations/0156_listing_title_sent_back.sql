-- 0156 — A DENIAL THE RULE REVIEW OVERTURNED GOES BACK TO THE STORE, WITH WHY.
--
-- Ethan, 2026-10-22: "If the user has to go back in and correct it, like we
-- made a change to the system and then they still have to fix it, make sure we
-- put this back in the queue for the teams to fix on SPEEKS Connect."
--
-- The review of the 30-day notes found four denials where the reviewer was
-- mistaken (LEE's PSP "PCH-1001", Canon "f/1.5-4.9", NES Zapper "NUS-005", and
-- the i9 combo) — and every one of them stayed denied, because a denial survives
-- every later sweep by design. The listing was still wrong and nobody was going
-- to be asked again.
--
-- The `reopen` action already put a row back, but it was built as Undo: it
-- wipes decided_* so the row reads as never decided, and it says nothing to the
-- store. A row that returns with no reason gets denied a second time by the same
-- person for the same reason. So these columns carry the WHY to the reviewer:
--   returned_note — written for the store ("PCH-1001 is the PS Vita's number;
--                   photo 7 shows PSP-1001"), shown on the row in the queue
--   returned_by / returned_at — who sent it back and when
-- They are left in place after the row is decided again, as history; the panel
-- only shows them on an open row.
alter table listing_title_reviews
  add column if not exists returned_note text,
  add column if not exists returned_by   text,
  add column if not exists returned_at   timestamptz;

-- The queue view as 0079 left it, with the three columns appended (a replaced
-- view may only ADD columns at the end). security_invoker restated, because
-- CREATE OR REPLACE does not carry reloptions forward on its own.
create or replace view listing_title_queue with (security_invoker = on) as
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
    r.lister_tag,
    r.returned_note,
    r.returned_by,
    r.returned_at
   from listing_title_reviews r
     join ebay_catalog c on c.store_code = r.store_code and c.sku = r.sku and c.product_id = r.product_id
     left join live_seen ls on ls.store_code = r.store_code
  where r.status = 'open'::text and c.title = r.current_title and c.quantity > 0 and c.online_published and (ls.last_seen is null or ls.last_seen < (now() - '36:00:00'::interval) or (exists ( select 1
           from ebay_live el
             join ebay_catalog c2 on c2.store_code = el.store_code and c2.sku = el.sku
          where el.store_code = r.store_code and c2.product_id = r.product_id)));
