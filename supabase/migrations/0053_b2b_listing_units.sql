-- One Shopify barcode can now cover several of a line's units. A qty-5 line is
-- usually listed as ONE listing of 5 under one barcode, but can still be split
-- across barcodes when needed.
--
-- Each listing row gets a `units` count (how many of the line's units it covers).
-- Existing rows are one-unit-per-barcode, so DEFAULT 1 keeps every one of them
-- meaning exactly what it did, and no data needs migrating. listed_qty becomes
-- the SUM of those counts instead of the row count.
ALTER TABLE public.b2b_item_listings
  ADD COLUMN IF NOT EXISTS units integer NOT NULL DEFAULT 1 CHECK (units > 0);

-- listed_qty = SUM(units), not COUNT(*). Also fire on UPDATE now, in case a
-- listing's unit count is edited after the fact. The b2b_deal_items capacity
-- CHECK (listed_qty + recycled_qty <= quantity) is unchanged and still holds,
-- because it is measured against the same summed listed_qty.
CREATE OR REPLACE FUNCTION public.b2b_sync_listed_qty()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  target uuid;
begin
  if tg_op = 'DELETE' then target := old.item_id; else target := new.item_id; end if;
  update public.b2b_deal_items
     set listed_qty = (select coalesce(sum(units), 0) from public.b2b_item_listings l where l.item_id = target)
   where id = target;
  return null;
end;
$function$;

DROP TRIGGER IF EXISTS b2b_item_listings_sync ON public.b2b_item_listings;
CREATE TRIGGER b2b_item_listings_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.b2b_item_listings
  FOR EACH ROW EXECUTE FUNCTION b2b_sync_listed_qty();
