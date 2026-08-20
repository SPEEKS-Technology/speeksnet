-- ============================================================================
-- A recycle line carries no shipping cost, matching value and offer.
--
-- This reverses a deliberate earlier choice, so it is worth saying why rather
-- than leaving the next reader to assume the old reasoning was never considered.
--
-- Freight was priced on scrap lines because a pallet of scrap genuinely does
-- cost money to move, and that figure fed the deal margin. The argument was
-- sound and it still lost on the floor: Value and Offer both render a dash on a
-- recycle line, because the client is paid nothing for scrap, so a live money
-- box sitting between the two of them was read as a bug every single time
-- somebody saw it. Three money columns disagreeing about what a scrap line means
-- cost more than the freight number was worth.
--
-- THE PRICE OF THIS CHANGE, recorded so nobody rediscovers it as a defect: the
-- margin on a recycle line now understates what that line costs us to move. If
-- freight on scrap ever needs to be visible again, it wants its own internal-only
-- column rather than this one, so it cannot be mistaken for a client-facing
-- figure a second time.
--
-- Safe to add: 30 recycle lines exist across b2b_deal_items and not one carries
-- a shipping cost, so this validates against live data without destroying a
-- single figure. Verified before applying, and the constraint was then proven to
-- fire by an UPDATE inside a rolled-back transaction.
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
