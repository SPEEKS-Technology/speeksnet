-- eBay Channel: the coverage question, and the tables that can answer it.
--
-- Replacing Marketplace Connect meant reproducing the one thing its admin
-- screen did that we had no equivalent for: telling a store what is NOT on
-- eBay. We recorded every listing we pushed (ebay_listings) and nothing else,
-- so "what did we miss" had no answer at all — and the honest answer turned
-- out to be 991 of Overland Park's 1,378 in-stock items.
--
-- THE TRAP THAT SHAPES ALL OF THIS. Each store shares ONE eBay account with
-- Marketplace Connect. MC lists through the older Trading API, and listings
-- created that way are invisible to the Inventory API the rest of this
-- integration uses: GET /sell/inventory/v1/inventory_item/{sku} answers
-- 25710 NOT FOUND for an item that is live and selling right now. Verified on
-- three in-stock OVL SKUs, 2026-08-15.
--
-- So "absent from ebay_listings" does NOT mean "not on eBay". Computing
-- coverage that way would have offered 387 already-live items up for listing,
-- and listing them would have put two live listings against one physical unit —
-- an oversell by construction. ebay_live exists to make that impossible:
-- coverage is always ebay_catalog minus ebay_live, never minus ebay_listings.

-- --- what eBay knows about the items WE listed -------------------------------
-- A listing row with no title is a row nobody can read; the panel had to join
-- back to Shopify for every line just to show a name.
alter table public.ebay_listings
  add column if not exists title           text,
  add column if not exists price           numeric,
  add column if not exists quantity        integer,
  -- Auto-listing retries. attempts drives the backoff; last_attempt_at is when
  -- we last called eBay, which is NOT published_at (a failure never publishes)
  -- and NOT updated_at (a price sync touches that too).
  add column if not exists attempts        integer not null default 0,
  add column if not exists last_attempt_at timestamptz;

-- --- Shopify's side, cached ---------------------------------------------------
-- Sweeping Shopify live on every page load is 30+ paginated GraphQL calls per
-- store, so it is cached here the same way shopify-live caches sales.
create table if not exists public.ebay_catalog (
  store_code         text        not null,
  sku                text        not null,
  product_id         text,
  variant_id         text,
  title              text,
  price              numeric,
  quantity           integer     not null default 0,
  image_count        integer     not null default 0,
  product_created_at timestamptz,
  -- Stamped on every row a sweep sees. A row left behind by the sweep that
  -- wrote its peers no longer exists in Shopify — deleted, or its SKU changed —
  -- and must drop out of Needs Listing rather than sit there forever.
  seen_at            timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (store_code, sku)
);

create index if not exists ebay_catalog_store_qty_idx
  on public.ebay_catalog (store_code, quantity, product_created_at desc);

create table if not exists public.ebay_catalog_runs (
  store_code   text primary key,
  started_at   timestamptz,
  finished_at  timestamptz,
  variants     integer,
  pages        integer,
  error        text
);

-- --- eBay's side: what is live, whoever listed it -----------------------------
-- Swept from GetMyeBaySelling (Trading API), which returns the SKU of every
-- active listing regardless of which API created it. See the header note.
create table if not exists public.ebay_live (
  store_code text        not null,
  sku        text        not null,
  item_id    text,
  title      text,
  quantity   integer,
  seen_at    timestamptz not null default now(),
  primary key (store_code, sku)
);

create index if not exists ebay_live_store_idx on public.ebay_live (store_code);

create table if not exists public.ebay_live_runs (
  store_code    text primary key,
  started_at    timestamptz,
  finished_at   timestamptz,
  listings      integer,
  without_sku   integer,
  error         text
);

-- --- auto-listing, per store, off by default ----------------------------------
-- OVL alone has 724 in-stock items that are eligible and not on eBay. A default
-- of "on" would put all 724 live the first time the cron fired, onto an account
-- Marketplace Connect is still managing. That is a decision somebody makes while
-- watching, not one inherited from the migration that created the column.
alter table public.ebay_stores
  add column if not exists auto_list_enabled boolean not null default false,
  -- Ceiling per cron run, so a first switch-on is a trickle and not a stampede.
  add column if not exists auto_list_per_run integer not null default 8;

alter table public.ebay_catalog      enable row level security;
alter table public.ebay_catalog_runs enable row level security;
alter table public.ebay_live         enable row level security;
alter table public.ebay_live_runs    enable row level security;
