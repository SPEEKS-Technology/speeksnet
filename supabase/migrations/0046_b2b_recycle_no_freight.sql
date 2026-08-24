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
-- ---------------------------------------------------------------------------
-- ORDERING: THIS MUST NOT LAND BEFORE THE EDGE FUNCTION THAT SATISFIES IT
--
-- Applied once, on 19 Aug, and immediately rolled back off production -- because
-- the deployed b2b-deals still wrote shipping_cost unconditionally and the
-- deployed frontend never zeroed it when a line was switched to Recycle. So the
-- constraint was live while the only two things that write to the column still
-- violated it: type a shipping cost, choose Recycle, and the save came back a
-- 500 instead of a save. Six deals were in flight at the time.
--
-- Re-apply this AFTER `b2b-deals` ships with
-- `shipping_cost: disposition === "recycle" ? 0 : money(...)` in both item
-- builders. Not before.
--
-- The general rule this is an instance of: a CHECK that narrows what a column
-- may hold is a deploy-ordering problem, not just a schema change. The writers
-- have to agree with it first. `intake_kind` went out the safe way round -- the
-- column landed before the code that used it -- and this one went out backwards.
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
