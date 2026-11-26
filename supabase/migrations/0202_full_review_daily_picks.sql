-- 0202 — the Full Listing Review's daily ten (Ethan, 2026-11-23).
--
-- "I want the top 10 most expensive items from each store … starting tomorrow,
-- because I'm going to start doing these manual reviews tomorrow for every
-- store." Each morning (listing-review ?daily=1, 6am CT) every store gets the
-- ten highest-priced listings MADE THE DAY BEFORE (CT), in stock. He reviews
-- them that day; any he does not get to stay on his list the next day under
-- the new ten ("and whatever I might have missed from yesterday").
--
-- One row per (store, listing). `day` is the day the listing was made. Picks
-- for a day are recomputed until one of them is reviewed, so a preview run
-- before the day ends is replaced by the full day's ten the next morning.

create table if not exists listing_full_picks (
  id          bigserial primary key,
  day         date not null,
  store_code  text not null,
  product_id  text not null,
  sku         text,
  title       text,
  price       numeric,
  lister_tag  text,
  rank        int,
  picked_at   timestamptz not null default now(),
  unique (store_code, product_id)
);
create index if not exists listing_full_picks_store_day on listing_full_picks (store_code, day desc);

-- RLS on, no policy: only the edge function (service role) reads or writes it.
alter table listing_full_picks enable row level security;
