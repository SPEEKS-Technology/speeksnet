-- B2B tracker: expand 5-stage pipeline → 6-stage design model.
-- Stages: Location Pending → Pricing → Quote → Awaiting Client → Listing → Completed
-- Apply via Supabase MCP `apply_migration` (or the SQL editor) when the server is reachable.

-- 1. Drop the old CHECK so we can remap existing rows.
alter table public.b2b_deals drop constraint if exists b2b_deals_status_check;

-- 2. Migrate any existing rows from the old model.
update public.b2b_deals set status = 'Quote'   where status = 'Approval Pending';
update public.b2b_deals set status = 'Listing' where status = 'Approved';

-- 3. New deal-level columns.
alter table public.b2b_deals
  add column if not exists contact          text,
  add column if not exists client_payout    numeric,
  add column if not exists quoted           boolean default false,
  add column if not exists quote_emailed    boolean default false,
  add column if not exists client_confirmed boolean default false,
  add column if not exists priced_by        text;

-- 4. Re-add the CHECK with the 6 new statuses.
alter table public.b2b_deals
  add constraint b2b_deals_status_check
  check (status in ('Location Pending','Pricing','Quote','Awaiting Client','Listing','Completed'));

-- 5. Per-line "listed" flag for the Listing checklist.
alter table public.b2b_deal_items
  add column if not exists listed boolean default false;
