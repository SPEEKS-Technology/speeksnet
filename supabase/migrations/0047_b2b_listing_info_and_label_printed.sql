-- ============================================================================
-- Two additions from the tester round.
--
-- listing_info: MOCD asked for "additional important listing information that
-- can't be explained in the other fields" -- the sentence a lister needs that is
-- neither a staff note (internal chatter, read while pricing) nor a client note
-- (prints on the quote). Its own column rather than folded into staff_notes
-- precisely because the audiences differ: merging them makes whoever is listing
-- pan through pricing chatter to find the one line addressed to them.
--
-- label_printed_at / _by: Ethan asked for printing the barcode to be REQUIRED.
-- A hard block was rejected -- a printer that is down must never strand pricing
-- -- so the compromise is to record it and warn at submit. That has to live on
-- the row, not in browser memory: pricing a pallet spans refreshes, devices and
-- people, and a counter held in one tab forgets everything another one printed.
--
-- ORDERING: purely additive. Nullable columns, no narrowing, so this is safe to
-- apply before the code that reads it -- the exact opposite of 0046, which
-- narrowed a column, went out ahead of its writers and had to be rolled back.
-- The length CHECKs only bind rows that set the column, and nothing sets it yet.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

alter table public.b2b_deal_items
  add column if not exists listing_info      text,
  add column if not exists label_printed_at  timestamptz,
  add column if not exists label_printed_by  text;

-- Evaluations get listing_info too, so the note survives conversion instead of
-- being retyped by whoever ends up listing it. b2b_preval_to_deal carries it.
alter table public.b2b_preval_items
  add column if not exists listing_info text;

alter table public.b2b_deal_items
  drop constraint if exists b2b_deal_items_listing_info_len;
alter table public.b2b_deal_items
  add constraint b2b_deal_items_listing_info_len
  check (length(coalesce(listing_info, '')) <= 2000);

alter table public.b2b_preval_items
  drop constraint if exists b2b_preval_items_listing_info_len;
alter table public.b2b_preval_items
  add constraint b2b_preval_items_listing_info_len
  check (length(coalesce(listing_info, '')) <= 2000);
