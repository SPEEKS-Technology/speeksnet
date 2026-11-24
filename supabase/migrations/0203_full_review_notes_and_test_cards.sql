-- 0203 — Full Listing Review: Notes Only, and a sandbox for test accounts
-- (Ethan, 2026-11-23).
--
-- NOTES ONLY: "maybe it's just a couple comments, but there's nothing they need
-- to fix … those don't go to the listers. Those go just to the manager, but it
-- doesn't count as a flag." A notes-only send is a card with returned_kind
-- 'notes': it sits on the store's list until the manager taps Got It, and it
-- never writes a listing_flags row. listing_full_reviews records it as
-- result 'notes'.
--
-- TEST SENDS: "a couple tests … from the test DM to the test manager for that
-- store, just so I don't accidentally send one." A test account (0160) may now
-- send a full review, mark that card fixed and confirm it — and nothing else.
-- Its cards live in their own table, listing_review_cards_test, because a card
-- is keyed by (store, listing): a test send-back on a real listing would
-- otherwise overwrite that listing's real card. Only test accounts read it; the
-- overnight re-grade, the settle job and every count read the real table only.
-- A test full review is a listing_full_reviews row with test = true, so it
-- never takes a real pick off Ethan's list. Test sends never write a flag.

alter table public.listing_review_cards drop constraint if exists listing_review_cards_returned_kind_check;
alter table public.listing_review_cards add constraint listing_review_cards_returned_kind_check
  check (returned_kind in ('spot','regrade','confirm','full','notes'));

alter table public.listing_full_reviews drop constraint if exists listing_full_reviews_result_check;
alter table public.listing_full_reviews add constraint listing_full_reviews_result_check
  check (result in ('good','back','notes'));
alter table public.listing_full_reviews add column if not exists test boolean not null default false;

create table if not exists public.listing_review_cards_test (like public.listing_review_cards including all);

-- RLS on, no policy: only the edge function (service role) reads or writes them.
alter table public.listing_review_cards_test enable row level security;
