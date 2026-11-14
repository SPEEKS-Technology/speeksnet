-- 0183 — Marketplace Lister: record Facebook boosts (Ethan, 2026-11-13)
--
-- A boost is a paid Facebook ad bought on the person's own account, so
-- Facebook never tells us about it. The person records it in the extension's
-- Listed tab ("Mark Boosted": days + total budget, as Facebook showed them),
-- fb-lister writes it here, and the weekly boost email reads it.
--
-- boost_ends_at = boosted_at + boost_days, stored so "running now" and
-- "ending soon" are plain comparisons. boosted_by comes from the verified
-- extension sign-in, like listed_by.

alter table public.fb_listings
  add column if not exists boosted_at    timestamptz,
  add column if not exists boost_days    integer,
  add column if not exists boost_budget  numeric(10,2),
  add column if not exists boost_ends_at timestamptz,
  add column if not exists boosted_by    text;

create index if not exists fb_listings_boosted on public.fb_listings (boosted_at) where boosted_at is not null;
