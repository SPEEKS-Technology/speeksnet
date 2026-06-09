-- B2B quote enhancements:
--   • per-item "recycle only" flag (kept as a line item, but no offer/price)
--   • sequential human quote numbers starting at Q-100
--   • delivered_by / received_by custody captured at store assignment
-- Apply via Supabase MCP `apply_migration` (or the SQL editor).

-- 1. Recycle-only line items.
alter table public.b2b_deal_items
  add column if not exists recycle boolean default false;

-- 2. Delivered / received custody at assignment.
alter table public.b2b_deals
  add column if not exists delivered_by text,
  add column if not exists received_by  text;

-- 3. Human quote number (Q-<n>), starting at 100.
create sequence if not exists public.b2b_quote_seq;
alter table public.b2b_deals
  add column if not exists quote_no integer;

-- Backfill existing deals chronologically: oldest = 100, then increment.
do $$
declare r record; n integer := 100;
begin
  for r in (select id from public.b2b_deals where quote_no is null order by created_at asc, id asc) loop
    update public.b2b_deals set quote_no = n where id = r.id;
    n := n + 1;
  end loop;
  -- Advance the sequence so new deals continue after the highest assigned number.
  perform setval('public.b2b_quote_seq', n, false);
end $$;

-- New rows auto-assign the next quote number.
alter table public.b2b_deals
  alter column quote_no set default nextval('public.b2b_quote_seq');
