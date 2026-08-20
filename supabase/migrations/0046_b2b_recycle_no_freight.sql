-- ============================================================================
-- A recycle line carries no shipping cost, matching value and offer.
--
-- We do not pay to ship scrap. So zero is not a simplification or a tradeoff --
-- it is the true figure, and the column being editable on a recycle line was
-- simply wrong. Value and Offer already rendered a dash there because the client
-- is paid nothing; freight sat between them as a live money box and was read as
-- a bug every time somebody saw it, which is how this surfaced.
--
-- All three money columns now agree that a recycle line costs nothing and earns
-- nothing.
--
-- Safe to add: 30 recycle lines exist across b2b_deal_items and not one carries
-- a shipping cost -- which is itself the evidence that nobody has ever had cause
-- to put freight on scrap. Verified before applying, and the constraint was then
-- proven to fire by an UPDATE inside a rolled-back transaction.
--
-- Named to sit beside b2b_deal_items_recycle_worthless, which is the same idea
-- applied to value.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

alter table public.b2b_deal_items
  drop constraint if exists b2b_deal_items_recycle_no_freight;
alter table public.b2b_deal_items
  add constraint b2b_deal_items_recycle_no_freight
  check (disposition <> 'recycle' or shipping_cost = 0);

alter table public.b2b_preval_items
  drop constraint if exists b2b_preval_items_recycle_no_freight;
alter table public.b2b_preval_items
  add constraint b2b_preval_items_recycle_no_freight
  check (disposition <> 'recycle' or shipping_cost = 0);
