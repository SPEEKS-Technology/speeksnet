-- ============================================================================
-- One row per listed unit, carrying the 8-digit barcode of the Shopify listing
-- it became.
--
-- Why a table and not a column: a Shopify listing is per UNIT, not per line. A
-- quantity-5 line becomes five listings with five different barcodes, so there
-- is nowhere on b2b_deal_items to put them. This also turns listed_qty from a
-- bare counter into something derived from evidence, and gives an audit trail of
-- who listed which unit and when.
--
-- listed_qty stays on the item, maintained by trigger, so the existing CHECK
-- (listed_qty + recycled_qty <= quantity), the rollup views and every index
-- keep working untouched -- and stay the backstop if the edge function's
-- capacity check is ever wrong.
--
-- Units listed before this existed keep their historical listed_qty: nothing
-- recomputes an item until a listing row is inserted or deleted for it, and
-- those actions are gated to the `listing` stage. Verified at write time that
-- no deal was in that stage, so nothing in flight could be caught by the
-- change; the only rows with a nonzero listed_qty were on completed deals,
-- which are terminal.
--
-- RLS enabled with no policies, matching every other table here: access is
-- exclusively through the service-role edge function.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

create table if not exists public.b2b_item_listings (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.b2b_deal_items(id) on delete cascade,
  deal_id uuid not null references public.b2b_deals(id)      on delete cascade,
  -- Exactly 8 digits. Strict on purpose: it is what stops a mis-scanned B2B
  -- SKU (ACM-001-0002) being recorded as a Shopify barcode.
  shopify_barcode text not null check (shopify_barcode ~ '^[0-9]{8}$'),
  listed_by text,
  listed_at timestamptz not null default now(),
  -- One listing, one barcode, anywhere in the system.
  constraint b2b_item_listings_barcode_uniq unique (shopify_barcode)
);

create index if not exists b2b_item_listings_item_idx on public.b2b_item_listings (item_id);
create index if not exists b2b_item_listings_deal_idx on public.b2b_item_listings (deal_id, listed_at);

alter table public.b2b_item_listings enable row level security;

-- NEW is unassigned on DELETE and OLD on INSERT, so this branches on TG_OP
-- rather than coalescing the two -- touching the unassigned one is an error.
create or replace function public.b2b_sync_listed_qty()
returns trigger language plpgsql as $$
declare
  target uuid;
begin
  if tg_op = 'DELETE' then target := old.item_id; else target := new.item_id; end if;
  update public.b2b_deal_items
     set listed_qty = (select count(*) from public.b2b_item_listings l where l.item_id = target)
   where id = target;
  return null;
end;
$$;

drop trigger if exists b2b_item_listings_sync on public.b2b_item_listings;
create trigger b2b_item_listings_sync
after insert or delete on public.b2b_item_listings
for each row execute function public.b2b_sync_listed_qty();
