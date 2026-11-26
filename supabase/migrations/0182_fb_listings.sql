-- 0182 — Marketplace Lister: one shared "Listed" list per store (Ethan, 2026-11-13)
--
-- Until now the extension kept what it had filled in chrome.storage.local, so
-- each computer only knew its own listings: two people at LEE each saw half,
-- and a new computer saw nothing ("Nothing filled from this computer yet").
-- This table is the store's list instead. fb-lister (service role) is the only
-- thing that reads or writes it; the extension never talks to the table.
--
-- A row is written once the person's own Publish click goes through (from
-- extension 1.5.4; 1.5.2–1.5.3 wrote it at Fill On Facebook, which listed
-- forms nobody published). done_at is how a row leaves the list: "Marked
-- Sold" (sold, and marked sold on Facebook) or "Remove" (taken down).
--
-- fb_category is the Facebook category the person picked, read off the form at
-- Confirm & Next. fb-lister suggests the most-picked category for the same
-- kind of item (the item's Shopify collection, `kind`) on the next listing, so
-- category picking is learned from people's own choices rather than guessed.
--
-- listed_by / done_by come from the signed token fb-lister verified, not from
-- the browser, so unlike most attribution in this app they can be trusted.
--
-- RLS on with no policy: anon/authenticated get nothing; the service role
-- bypasses it. (Same pattern as the other tables only an edge function uses.)

create table if not exists public.fb_listings (
  id          bigserial primary key,
  store_code  text not null,
  sku         text not null,
  product_id  text,
  title       text,
  price       numeric,
  kind        text,
  fb_category text,
  listed_by   text,
  listed_at   timestamptz not null default now(),
  done_at     timestamptz,
  done_by     text
);

-- One open row per item per store; re-filling the same item updates it.
create unique index if not exists fb_listings_open_one
  on public.fb_listings (store_code, sku, coalesce(product_id, ''))
  where done_at is null;
create index if not exists fb_listings_store_open on public.fb_listings (store_code) where done_at is null;
create index if not exists fb_listings_kind_cat on public.fb_listings (kind) where fb_category is not null;

alter table public.fb_listings enable row level security;
