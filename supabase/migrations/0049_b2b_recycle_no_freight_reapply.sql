-- ============================================================================
-- Re-applying 0046, now that its writers agree with it.
--
-- 0046 went out ahead of the edge function that enforces the same rule, so the
-- deployed function still wrote shipping_cost unconditionally while the
-- constraint refused it: type a shipping cost, pick Recycle, get a 500 instead
-- of a save. It was rolled straight back off -- see the ordering note in 0046.
--
-- b2b-deals v40 now zeroes freight on a recycle line in both item builders, and
-- the sheet renders a dash instead of a field, so nothing that writes this
-- column can violate the rule any more. Safe to put back.
--
-- ---------------------------------------------------------------------------
-- CLEANING UP WHAT LANDED IN THE GAP
--
-- Three recycle lines picked up freight between 21 and 22 Aug -- after the rule
-- was decided, before the code enforcing it shipped, while the box was still
-- editable:
--
--   LOCHCC-002-0042  Cisco Meraki MX84            $15.00
--   LOCHCC-002-0052  Microsoft Surface Laptop 2   $15.00
--   LOCHCC-002-0058  Lenovo ThinkCentre M810z     $10.00
--
-- Zeroed rather than grandfathered. They are not history worth preserving: we do
-- not pay to ship scrap, so they were never real costs -- they are typos the old
-- UI invited. Nothing client-facing moves, because shipping_cost is internal by
-- construction and net_offer is offer minus wipe fees only. The deal's internal
-- margin improves by $40, to what it always actually was.
--
-- The UPDATE and the ADD CONSTRAINT are in one migration deliberately: there
-- must be no window where the rows are corrected but the rule is not yet in
-- force, or where the rule is in force against rows that still violate it.
--
-- Applied via Supabase MCP `apply_migration`, guarded by a pre-check that
-- refused the first attempt and is what surfaced these three rows at all.
-- ============================================================================

update public.b2b_deal_items
   set shipping_cost = 0
 where disposition = 'recycle' and shipping_cost <> 0;

update public.b2b_preval_items
   set shipping_cost = 0
 where disposition = 'recycle' and shipping_cost <> 0;

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
