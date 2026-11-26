-- ============================================================================
-- 0200 — Returned But Not Back In Stock: "On A Claim" (Ethan, 2026-11-23)
--
-- OVL #KS01-15437, a $349.99 MacBook Air refunded on eBay with the note
-- "SHIPPING CLAIM OPENED". The parcel was lost, so nothing ever comes back to
-- restock, and the store had already filed it in Shopify Claims (case
-- SHPLI-111926173701, same SKU). It still went on the mail every morning,
-- because nothing tied the two together.
--
-- The #restock card can now link the line to a claim at the same store that
-- lists the SAME SKU. The function checks that; the manager only picks it. A
-- linked line closes and goes on the next DM mail under Closed By A Manager,
-- like any other hand-close. If the claim is later deleted, the morning run
-- reopens the line (claim_id points at nothing any more).
--
-- No FK: a deleted claim must leave claim_id behind so the morning run can see
-- the link went dead. A cascade or set-null would erase that evidence.
-- ============================================================================
alter table public.unrestocked_returns
  add column if not exists claim_id        uuid,
  add column if not exists claim_case      text,
  add column if not exists claim_linked_by text,
  add column if not exists claim_linked_at timestamptz;

comment on column public.unrestocked_returns.claim_id is
  'shopify_claims.id this line was linked to from the #restock card (On A Claim). No FK on purpose: a deleted claim reopens the line on the next morning run.';
comment on column public.unrestocked_returns.claim_case is
  'The claim''s case number at link time, kept for the mail even if the claim goes away.';
