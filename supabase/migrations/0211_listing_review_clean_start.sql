-- 0211 — a clean start for photos and manual reviews (Ethan, 2026-11-25).
--
-- "Clear out all of the photo things that have been graded or tested before, so
-- it's just the listings and categories as normal. You can clear all the manual
-- listings as well." Go-live is Friday 2026-11-27: the 5-minute picture check
-- grades listings made from that day on (PQ_QUICK_FROM), and the daily top 10
-- for Full Listing Review starts again from Thursday's 6am pick.
--
-- Everything removed is COPIED FIRST into *_archive_20261125 tables (RLS on, no
-- policy — service role only), so nothing here is unrecoverable.
-- Kept: title flags and every title/category row (they carry on as normal), and
-- the Picture Guide training labels (pq_shot_labels, picture_quality_feedback).

create table if not exists public.picture_quality_reviews_archive_20261125 as select * from public.picture_quality_reviews;
create table if not exists public.listing_review_cards_archive_20261125 as select * from public.listing_review_cards;
create table if not exists public.listing_spot_checks_archive_20261125 as select * from public.listing_spot_checks;
create table if not exists public.listing_full_picks_archive_20261125 as select * from public.listing_full_picks;
create table if not exists public.listing_full_reviews_archive_20261125 as select * from public.listing_full_reviews;
create table if not exists public.listing_flags_archive_20261125 as select * from public.listing_flags where source in ('photos', 'ethan');

alter table public.picture_quality_reviews_archive_20261125 enable row level security;
alter table public.listing_review_cards_archive_20261125 enable row level security;
alter table public.listing_spot_checks_archive_20261125 enable row level security;
alter table public.listing_full_picks_archive_20261125 enable row level security;
alter table public.listing_full_reviews_archive_20261125 enable row level security;
alter table public.listing_flags_archive_20261125 enable row level security;

delete from public.picture_quality_reviews;
delete from public.listing_review_cards;
delete from public.listing_spot_checks;
delete from public.listing_full_picks;
delete from public.listing_full_reviews;
delete from public.listing_flags where source in ('photos', 'ethan');
