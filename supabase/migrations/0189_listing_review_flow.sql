-- ============================================================================
-- 0189 — THE LISTING REVIEW FLOW: one Fix Queue per store, Ethan's daily Spot
-- Check, the overnight re-grade loop, and the per-lister flag rate.
-- Design: docs/listing-review-flow-design.md (approved by Ethan 2026-11-18).
--
-- ⚠️ THE CARD IS AN ENVELOPE, NOT A COPY. What is wrong with a listing stays
-- in the tables that found it — picture_quality_reviews, listing_title_reviews
-- (through listing_title_queue), the collection_* views. A card row exists only
-- once something has HAPPENED to a listing: Ethan sent it back, the store
-- marked it fixed, the re-grade answered. Copying the lines here would give
-- every finding two states that drift; reading them live means a title fixed
-- by hand in Shopify drops off the card the moment the queue view stops
-- matching it, with nobody pressing anything.
--
-- ⚠️ THE TITLE QUEUE WIDENS: EITHER CHANNEL, NOT BOTH. Ethan, 2026-11-18: "This
-- should have always been both online store and eBay live listings" — asked
-- to be sure, he picked "live on the online store OR on eBay". 0070 had made it
-- online store AND eBay, which on 2026-11-18 showed 8 of 126 live findings:
-- ~62% of live Shopify stock is not on eBay, and the eBay-live findings got
-- worked off because they were the only ones shown, so the hidden ones were
-- where the open findings piled up. 0070's freshness guard existed only to
-- stop a stale eBay snapshot from EMPTYING the queue; with OR, a stale snapshot
-- can only leave out eBay-only listings, never hide a storefront one, so the
-- guard goes.
-- ============================================================================

create or replace view public.listing_title_queue as
 select r.store_code, r.product_id, r.sku, r.product_handle, r.current_title,
        r.suggested_title, r.findings, r.basis, r.confidence, r.comps,
        r.category_id, r.category_name, r.ebay_title, r.severity, r.status,
        r.decided_by, r.decided_at, r.decided_note, r.swept_at,
        c.price, c.quantity, c.online_published, r.lister_tag,
        r.returned_note, r.returned_by, r.returned_at
   from listing_title_reviews r
   join ebay_catalog c
     on c.store_code = r.store_code and c.sku = r.sku and c.product_id = r.product_id
  where r.status = 'open'
    and c.title = r.current_title
    and c.quantity > 0
    and (c.online_published
         or exists (select 1 from ebay_live el
                      join ebay_catalog c2 on c2.store_code = el.store_code and c2.sku = el.sku
                     where el.store_code = r.store_code and c2.product_id = r.product_id));

-- --- the card --------------------------------------------------------------
-- One row per listing, updated in place through its rounds:
--   open       Ethan sent it back (spot check or Confirm), or the re-grade
--              failed — it is on the store's queue with returned_note on top
--   fixed      the store pressed Mark Fixed; waits for tonight's re-grade
--              (like Resolve on Claims & Disputes — never re-graded on the spot)
--   regrading  submitted to the overnight Batch; regrade_batch says which
--   confirm    the re-grade passed; on Ethan's Confirm Fixes list
--   done       Ethan confirmed it
-- `ticks` are Ethan's own lines from Grade It Myself — they show on the card
-- as lines until the card is done, because no checker row carries them.
create table if not exists public.listing_review_cards (
  store_code     text not null,
  product_id     text not null,
  sku            text,
  title          text,
  price          numeric,
  lister_tag     text,
  status         text not null default 'open'
                 check (status in ('open','fixed','regrading','confirm','done')),
  round          integer not null default 0,
  ticks          jsonb,
  returned_kind  text check (returned_kind in ('spot','regrade','confirm')),
  returned_note  text,
  returned_by    text,
  returned_at    timestamptz,
  fixed_by       text,
  fixed_at       timestamptz,
  regrade_batch  text,
  regrade        jsonb,
  regraded_at    timestamptz,
  confirmed_by   text,
  confirmed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (store_code, product_id)
);
create index if not exists listing_review_cards_status_idx on public.listing_review_cards (status, store_code);

-- --- who listed what ---------------------------------------------------------
-- New listings and their lister, read from Shopify tags by the daily job (the
-- same listerFrom matcher picture-quality and listing-titles use). It is the
-- flag rate's denominator ("Listed") and the lister on every spot-check card.
-- lister_tag is the raw tag; lister_name is who it matched, or null.
create table if not exists public.listing_listers (
  store_code   text not null,
  product_id   text not null,
  sku          text,
  title        text,
  price        numeric,
  lister_tag   text,
  lister_name  text,
  created_at   timestamptz,
  seen_at      timestamptz not null default now(),
  primary key (store_code, product_id)
);
create index if not exists listing_listers_created_idx on public.listing_listers (store_code, created_at);

-- --- Ethan's daily ten -------------------------------------------------------
-- Picked once a day (6am CT) so the list does not move under him. A listing is
-- spot-checked once, ever — hence the unique on (store_code, product_id).
-- checker_passed: which checks had passed it, so a Grade It Myself knows which
-- checker to record the miss against.
create table if not exists public.listing_spot_checks (
  id              bigserial primary key,
  day             date not null,
  store_code      text not null,
  product_id      text not null,
  sku             text,
  title           text,
  price           numeric,
  lister_tag      text,
  rank            smallint not null,
  result          text not null default 'pending' check (result in ('pending','agree','graded')),
  ticks           jsonb,
  note            text,
  decided_by      text,
  decided_at      timestamptz,
  checker_passed  jsonb,
  unique (store_code, product_id)
);
create index if not exists listing_spot_checks_day_idx on public.listing_spot_checks (day, store_code);

-- --- the flag ledger ---------------------------------------------------------
-- What the weekly Flag Rates view sums. One row per (listing, source), so a
-- re-run of the daily job never counts a flag twice and a listing with three
-- photo lines is still one photo flag. `week` is the Monday (CT) of the week
-- the listing was LISTED, so a flag lands in the same week as its Listed count.
-- source 'ethan' = his Grade It Myself; checker_miss marks that it was a pass
-- the checks got wrong. dismissed = every line from that source was dismissed
-- by the store — shown greyed, not counted.
create table if not exists public.listing_flags (
  id            bigserial primary key,
  week          date not null,
  store_code    text not null,
  product_id    text not null,
  lister_tag    text,
  source        text not null check (source in ('photos','title','label','category','ethan')),
  checker_miss  boolean not null default false,
  missed_by     text[],
  dismissed     boolean not null default false,
  at            timestamptz not null default now(),
  unique (store_code, product_id, source)
);
create index if not exists listing_flags_week_idx on public.listing_flags (week, store_code);

-- RLS on, no policy: the house pattern. Only the edge function (service role)
-- reads and writes these.
alter table public.listing_review_cards enable row level security;
alter table public.listing_listers      enable row level security;
alter table public.listing_spot_checks  enable row level security;
alter table public.listing_flags        enable row level security;

-- --- the schedule ------------------------------------------------------------
-- All free (no model call): the daily job reads Shopify tags and the tables;
-- settle reads what the re-grade wrote. The re-grade SUBMIT is the one paid
-- step, and it is gated inside the function (LR_REGRADE_ON) — off until Ethan
-- says go — so this cron firing costs nothing while it is off.
select cron.schedule('listing-review-daily', '0 * * * *', $cron$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/listing-review?daily=1&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 140000)
  where extract(hour from (now() at time zone 'America/Chicago')) = 6;
$cron$);

select cron.schedule('listing-review-regrade', '20 * * * *', $cron$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/listing-review?regrade=1&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 140000)
  where extract(hour from (now() at time zone 'America/Chicago')) = 3;
$cron$);

select cron.schedule('listing-review-settle', '45 * * * *', $cron$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/listing-review?settle=1&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 140000)
  where extract(hour from (now() at time zone 'America/Chicago')) between 4 and 10;
$cron$);
