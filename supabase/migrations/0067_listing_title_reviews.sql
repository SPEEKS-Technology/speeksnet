-- ============================================================================
-- 0067 — Listing Titles: the third tool on the Listing Health page.
--
-- WHAT THIS IS FOR, and it is not mainly SEO. Sampling the 4,015 in-stock
-- items across the five stores turned up titles that name a product which does
-- not exist (OVL KS01-7548G-E7, $1,499.99: "Sony OX 7 IV 33MP Mirrorless
-- Digital Camera" — the alpha character of an a7 IV mangled into "OX"), titles
-- that assert the wrong hardware (a Nikon Z 6 called a "Digital SLR DSLR", a
-- ZV-E10 called L-Mount when it is E-mount), six internal wipe-station items
-- worth $3,454.94 listed to the public, and three live listings whose eBay
-- title CONTRADICTS Shopify's (Shopify says RTX 3050, eBay says GTX 1060).
-- Those are wrong listings, not unoptimised ones. The headroom finding — an
-- average title of 52 characters against eBay's cap of 80, with only 3.6% of
-- items near the cap — rides along behind them.
--
-- WHY A QUEUE TABLE AND NOT A VIEW. Categories can be a pure view because a
-- proposal is a pure function of a title and the rule set. A title suggestion
-- is not: the market half costs a Browse call per item against a rate-limited
-- API, so the answer is SWEPT and stored. The view on top is what makes a
-- stored answer safe to act on (see the staleness guard below).
--
-- WHERE THE FIX LANDS. Marketplace Connect mirrors the Shopify title verbatim
-- onto eBay — measured, not assumed: of 1,283 SKUs live on both sides 1,254
-- titles are byte-identical and 25 of the 29 differences are only `&` vs
-- `&amp;` in our own sweep. So writing the Shopify product title is the whole
-- write path. It needs no eBay scope, touches nothing Marketplace Connect owns,
-- and so does not collide with [[ebay-standby-mode]]. `write_products` has been
-- granted at all five shops since 2026-08-05.
--
-- ⚠️ IT ALSO MEANS THE STOREFRONT TITLE CHANGES. The Shopify title is what a
-- shopper sees on paymore-*.myshopify.com and what prints on a receipt. That is
-- the accepted trade (Ethan, 2026-08-28: the point is to sell the item), and it
-- is the reason nothing here writes without a person pressing Approve.
--
-- See [[listing-health-photos]] for the page this joins, [[db-rls-convention]]
-- for why there are no policies, and [[ebay-channel-ui]] for the accessory-swarm
-- trap that governs how comps may be sampled.
-- ============================================================================

-- --- the queue --------------------------------------------------------------
create table if not exists public.listing_title_reviews (
  store_code      text        not null,
  product_id      text        not null,
  sku             text,
  product_handle  text,

  -- The title AS IT WAS WHEN SWEPT. This is not decoration: it is the staleness
  -- key. See listing_title_queue below.
  current_title   text        not null,
  suggested_title text,

  -- [{ code, says, fixes }] — one entry per defect found. The panel renders
  -- these as the reason, so `says` is a sentence a manager can read, never a
  -- rule name. Plain English is the house rule for anything alert-shaped.
  findings        jsonb       not null default '[]'::jsonb,

  -- HOW MUCH THE SUGGESTION IS WORTH TRUSTING, and it must be visible on the
  -- row. 'rules' needed no market data at all (a doubled phrase, an internal
  -- ops title) and is the most trustworthy of the lot. 'gtin' means a live
  -- listing shared this item's barcode — the only anchor that proves identity.
  -- 'model' matched a model number; 'category' is title words inside the same
  -- leaf category and is the weakest thing we will act on.
  basis           text        not null default 'rules',
  confidence      text        not null default 'low',

  -- The live listings the suggestion was drawn from, kept so a reviewer can see
  -- what "the market" meant. [{ title, price, itemId, gtin }]
  comps           jsonb       not null default '[]'::jsonb,
  -- The leaf the comps were sampled INSIDE. ⚠️ Sampling without it returns ~70%
  -- accessories for any popular device — an iPad Air query comes back mostly
  -- cases, because every case names the device it fits. Copying keywords from
  -- that sample puts "Case Cover Folio" into the title of an actual iPad.
  category_id     text,
  category_name   text,

  price           numeric,
  quantity        integer,

  -- What eBay's own live title was at sweep time. Only populated when it
  -- DISAGREES with Shopify, which is the drift finding: the listing in front of
  -- a buyer says something the catalogue does not.
  ebay_title      text,

  -- 3 the listing is wrong (drift, wrong hardware, not a real listing)
  -- 2 the listing cannot be found (no product noun, a model name that matches
  --   nothing on the market)
  -- 1 the listing is leaving money on the table (unused characters, an
  --   undeclared bundle, the brand buried mid-title)
  -- The panel sorts on this, so a $1,499 camera named after a nonexistent model
  -- cannot sit below forty items that are merely short.
  severity        smallint    not null default 1,

  -- open | applied | denied. A denied row STAYS, so the queue stops offering it
  -- — and it stops being denied on its own the moment the title changes,
  -- because the staleness guard drops it and the next sweep re-reads it fresh.
  status          text        not null default 'open',
  decided_by      text,
  decided_at      timestamptz,
  decided_note    text,
  applied_title   text,

  swept_at        timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  primary key (store_code, product_id)
);

create index if not exists listing_title_reviews_open_idx
  on public.listing_title_reviews (store_code, status, severity desc);

-- --- the ledger -------------------------------------------------------------
-- Every applied title, before and after, with the person. A title write is the
-- only thing in this tool that leaves the building, and `current_title` on the
-- queue row is overwritten by the next sweep — so without this there would be
-- no record of what a listing used to be called.
create table if not exists public.listing_title_moves (
  id           bigserial primary key,
  store_code   text        not null,
  product_id   text        not null,
  sku          text,
  before_title text        not null,
  after_title  text        not null,
  -- Whether the person took the suggestion as offered or typed their own. The
  -- proportion is the only honest measure of whether the analyser is any good.
  edited       boolean     not null default false,
  basis        text,
  findings     jsonb       not null default '[]'::jsonb,
  applied_by   text,
  applied_at   timestamptz not null default now()
);

create index if not exists listing_title_moves_store_idx
  on public.listing_title_moves (store_code, applied_at desc);

-- --- what the panel is allowed to see ---------------------------------------
--
-- ⚠️ THE STALENESS GUARD IS THE WHOLE REASON THIS IS A VIEW.
-- A suggestion is computed against one exact title. If somebody fixes the title
-- in Shopify by hand between the sweep and the review — which is exactly what
-- we are asking people to start doing — then approving the stored suggestion
-- would OVERWRITE THEIR FIX with a rewrite of a title that no longer exists.
-- Requiring ebay_catalog.title to still equal current_title makes that
-- impossible: the row silently leaves the queue instead, and the next sweep
-- re-reads the new title and either has nothing to say or says something new.
--
-- The join is on SKU, not product_id, for the reason [[ebay-sku-rename]]
-- records in the other direction — but here product_id is the stable half and
-- ebay_catalog is keyed (store_code, sku), so both are matched and a renamed
-- SKU simply drops out rather than being paired with the wrong product.
create or replace view public.listing_title_queue as
select r.store_code, r.product_id, r.sku, r.product_handle,
       r.current_title, r.suggested_title, r.findings, r.basis, r.confidence,
       r.comps, r.category_id, r.category_name, r.ebay_title,
       r.severity, r.status, r.decided_by, r.decided_at, r.decided_note,
       r.swept_at,
       c.price, c.quantity, c.online_published
  from public.listing_title_reviews r
  join public.ebay_catalog c
    on c.store_code = r.store_code
   and c.sku = r.sku
   and c.product_id = r.product_id
 where r.status = 'open'
   -- Still the same title we reasoned about.
   and c.title = r.current_title
   -- Still worth somebody's attention: in stock, and reachable by a shopper.
   -- A title is a findability asset, and an unpublished product cannot be found
   -- at any price. Same scope the other two Listing Health queues use, for the
   -- same reason (see 0056).
   and c.quantity > 0
   and c.online_published;

-- No policies, on purpose: every reader comes through an edge function on the
-- service role, and the anon key is public. See [[db-rls-convention]].
alter table public.listing_title_reviews enable row level security;
alter table public.listing_title_moves   enable row level security;
