-- ============================================================================
-- 0060 — SPEEKS Connect standby mode, and a record of what was ours at handover
-- ============================================================================
--
-- WHY. PayMore shipped a new Marketplace Connect whose setup "scans all of our
-- live eBay listings and pulls them onto their new system". Our listings are
-- live eBay listings, so it will adopt them. The moment it does, one physical
-- unit is managed by two systems that both believe they own it.
--
-- The expensive half of that is NOT duplicate listings, it is DUPLICATE ORDERS.
-- ebay-orders claims any eBay sale whose SKU sits at published/ended in
-- ebay_listings; MC claims the sales for the listings it now holds. Post-
-- adoption those are the SAME sales, so every SPEEKS Connect item that sells
-- becomes two Shopify orders — double revenue, stock decremented twice, the
-- variant driven negative. That already happened once without adoption
-- (2026-08-20: 77 duplicates, $13,820.44 of phantom revenue at BAL and MPL, and
-- the day-level split of those four days is permanently skewed because a refund
-- credits the refund day, not the sale day). Adoption turns that incident from
-- a one-off back-fill into the steady state at all five stores.
--
-- WHAT THIS IS NOT. It is not a teardown. Ethan's requirement is that SPEEKS
-- Connect stays as break-glass for the next time MC is down for a week — the
-- tab, the panel and every route keep working. What standby removes is the
-- AUTOMATIC writing: nothing publishes, imports, withdraws, republishes or
-- reprices on its own while MC owns the account.
--
-- Read paths stay live ON PURPOSE. The catalog/live sweeps and ebay-alert are
-- how we watch what MC is doing to our listings, and a channel that has gone
-- quiet is exactly when you most want the watchdog awake.
-- ============================================================================

-- --- 1. the mode ------------------------------------------------------------
-- 'active'  — today's behaviour, unchanged.
-- 'standby' — read-only: no publish, no order import, no stock/price/content
--             push. Sweeps and alerting continue.
--
-- Per store, because adoption will not land at all five at the same moment and
-- a store still on old MC must keep working while the others move.
--
-- DEFAULT 'active' so applying this migration changes NOTHING. The switch is
-- thrown deliberately, per store, once that store's adoption is confirmed —
-- flipping it here would silently stop real eBay sales reaching Shopify.
alter table public.ebay_stores
  add column if not exists channel_mode text not null default 'active';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ebay_stores_channel_mode_chk'
  ) then
    alter table public.ebay_stores
      add constraint ebay_stores_channel_mode_chk
      check (channel_mode in ('active', 'standby'));
  end if;
end $$;

-- Who threw the switch and when. An estate this size forgets, and "why is OVL
-- not listing" is the question this column answers in one look.
alter table public.ebay_stores
  add column if not exists channel_mode_at   timestamptz,
  add column if not exists channel_mode_by   text,
  add column if not exists channel_mode_note text;

comment on column public.ebay_stores.channel_mode is
  'active = SPEEKS Connect writes to eBay. standby = break-glass; reads and '
  'alerting only, no publish/import/withdraw/reprice. Set per store as '
  'Marketplace Connect adopts that store''s listings.';

-- --- 2. what was ours at handover -------------------------------------------
-- ⚠️ THIS IS TIME-SENSITIVE AND CANNOT BE RECONSTRUCTED LATER.
--
-- Right now "which live eBay listings are ours" is answerable: ours carry an
-- ebay_offer_id and the Inventory API returns them, while an MC listing returns
-- 25710 NOT FOUND. Once MC adopts ours, that test stops separating them —
-- adopted-from-us and MC-native look alike from the outside, and ebay_live has
-- never distinguished them.
--
-- So capture the answer BEFORE the scan runs. Everything afterwards depends on
-- it: which duplicates are ours to reverse, which listings to re-claim if we
-- ever break the glass, and whether MC's adoption actually covered what it
-- claimed to cover (a listing of ours that MC did NOT adopt is now orphaned —
-- live on eBay, managed by nobody).
create table if not exists public.ebay_handover (
  id                bigserial primary key,
  store_code        text        not null,
  sku               text        not null,
  ebay_listing_id   text,
  ebay_offer_id     text,
  shopify_variant_id text,
  title             text,
  price             numeric,
  quantity          integer,
  -- The ebay_listings.status at capture time. 'published' is the set that
  -- matters; 'ended'/'disabled' are kept so the snapshot reconciles against the
  -- table it came from rather than being a filtered view of it.
  listing_status    text,
  -- Was eBay still showing it active when we looked? Null = we did not ask.
  -- Recorded separately from listing_status because our row disagreeing with
  -- eBay is itself a finding worth keeping.
  live_on_ebay      boolean,
  captured_at       timestamptz not null default now(),
  -- Free text for the run: 'pre-MC-adoption 2026-08-24', a re-capture reason.
  batch             text
);

-- One row per store+sku+batch: re-running a capture must not silently double
-- the snapshot, and a second capture under a new batch label is how you compare
-- before and after.
create unique index if not exists ebay_handover_store_sku_batch_uidx
  on public.ebay_handover (store_code, sku, batch);

create index if not exists ebay_handover_store_idx
  on public.ebay_handover (store_code, captured_at desc);

-- House convention: RLS on, NO policies. The anon key is public and every edge
-- function here uses the service role, which bypasses RLS — so a table with no
-- policies is readable by our functions and by nobody else.
alter table public.ebay_handover enable row level security;

revoke all on public.ebay_handover from anon, authenticated;

comment on table public.ebay_handover is
  'Snapshot of the eBay listings SPEEKS Connect owned at the moment Marketplace '
  'Connect adopted them. Not reconstructable after the fact — once MC holds a '
  'listing, ours and MC-native are indistinguishable from outside.';
