-- ============================================================================
-- 0197 — FULL LISTING REVIEW: Ethan reviews any listing by hand.
--
-- Ethan, 2026-11-21 (design: the Listing Review Redesign canvas, "Full listing
-- review" row):
--   - DM only for now. He picks a store and a listing, sees the whole listing
--     as a shopper does, flags any part (a photo, a field, the category, the
--     description) with a note, then Looks Good or Send Back.
--   - ONLY A SEND-BACK COUNTS AS A FLAG against the lister. "If it looks good
--     … that lister should not get flagged for it because there's nothing
--     wrong with it." Looks Good is recorded here and nowhere else.
--   - A send-back goes on the store's list like a spot-check one
--     (listing_review_cards, returned_kind 'full'); its I Fixed It comes back
--     to his Confirm Fixes — "I would want to see if they took what my notes
--     were and applied the fixes."
-- ============================================================================

create table if not exists public.listing_full_reviews (
  id          bigserial primary key,
  store_code  text not null,
  product_id  text not null,
  sku         text,
  title       text,
  price       numeric,
  lister_tag  text,
  result      text not null check (result in ('good','back')),
  parts       jsonb,      -- [{part, note}] — the listing parts he flagged
  photos      jsonb,      -- [{n, tags, note, thumb}] — per photo, as the spot check
  note        text,       -- the whole-listing note
  reviewed_by text,
  reviewed_at timestamptz not null default now()
);
create index if not exists listing_full_reviews_listing_idx on public.listing_full_reviews (store_code, product_id, reviewed_at desc);
alter table public.listing_full_reviews enable row level security;

-- A card sent back from a full review says so.
alter table public.listing_review_cards drop constraint if exists listing_review_cards_returned_kind_check;
alter table public.listing_review_cards add constraint listing_review_cards_returned_kind_check
  check (returned_kind in ('spot','regrade','confirm','full'));
