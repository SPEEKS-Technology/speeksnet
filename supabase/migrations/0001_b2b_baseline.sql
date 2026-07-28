-- ============================================================================
-- B2B baseline — clean rebuild of the B2B tracker schema.
-- ----------------------------------------------------------------------------
-- The previous B2B tables grew out-of-band: only two migrations were ever
-- committed (on the abandoned B2B-Work branch) and most columns had no DDL in
-- the repo at all. Every row in them was dummy test data, so this drops the
-- lot and rebuilds properly — real FKs, indexes, checks and defaults.
--
-- Pipeline (7 stages + a terminal cancel):
--   pickup → pricing_location → pricing → quote → [listing_location] → listing
--          → completed
--   listing_location is only entered when pricing happened at CORP; every other
--   pricing store becomes the listing store automatically on acceptance.
--
-- Identifiers:
--   deal ref  ACM-001        client acronym + per-client deal counter
--   item sku  ACM-001-0004   + per-deal line counter, assigned on entering
--                            `quote`, frozen once the quote is accepted
--
-- No RLS policies, matching every other table in this project: the tables stay
-- closed to the anon client and all access goes through the service-role
-- `b2b-deals` edge function.
--
-- Apply via Supabase MCP `apply_migration` (or the SQL editor).
-- ============================================================================

-- 1. Tear down the old model (dummy data only — nothing to preserve).
drop table if exists public.b2b_deal_items cascade;
drop table if exists public.b2b_deals      cascade;
drop table if exists public.b2b_clients    cascade;
drop sequence if exists public.b2b_quote_seq;

-- 2. Client directory. The acronym is required and unique because it is the
--    leading segment of every SKU we print on a label.
create table public.b2b_clients (
  id            uuid primary key default gen_random_uuid(),
  company       text not null unique,
  acronym       text not null unique check (acronym ~ '^[A-Z0-9]{2,6}$'),
  contact       text,
  contact_email text,
  contact_phone text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 3. Deals. deal_no is a per-client counter starting at 1 (rendered 001), so
--    ACME's third deal is ACM-003 regardless of what other clients are doing.
create table public.b2b_deals (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.b2b_clients(id) on delete restrict,
  deal_no       int  not null,

  stage text not null default 'pickup' check (stage in (
    'pickup', 'pricing_location', 'pricing', 'quote',
    'listing_location', 'listing', 'completed', 'cancelled'
  )),

  -- stage 1: pickup sign-off (typed-name acknowledgment)
  pickup_desc   text,
  signed_by     text,
  signed_at     timestamptz,
  pickup_date   date,

  -- stage 2 / 5: where it gets priced, where it gets listed
  pricing_store text check (pricing_store in ('OVL','LEE','WSP','MPL','BAL','CORP')),
  listing_store text check (listing_store in ('OVL','LEE','WSP','MPL','BAL')),
  delivered_by  text,
  received_by   text,

  -- stage 3 / 4
  priced_by        text,
  quote_sent_at    timestamptz,
  quote_send_count int not null default 0,
  accepted_at      timestamptz,
  accepted_by      text,

  cancelled_reason text,
  created_by       text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  stage_changed_at timestamptz not null default now(),

  unique (client_id, deal_no)
);

-- 4. Line items.
--    offer  = what we offer the client (editable right up to acceptance)
--    cost   = offer frozen at acceptance; the goods are our inventory now
--    recycle_only = scrap from the start, quoted at $0, still needs listing
--                   sign-off but contributes nothing to the totals
--    listed_qty / recycled_qty = per-unit progress during listing; a line is
--                   satisfied once listed + recycled >= quantity
create table public.b2b_deal_items (
  id           uuid primary key default gen_random_uuid(),
  deal_id      uuid not null references public.b2b_deals(id) on delete cascade,
  line_no      int  not null,
  sku          text unique,

  make         text,
  model        text,
  condition    text,
  staff_notes  text,
  client_notes text,

  quantity     int not null default 1 check (quantity > 0),
  value        numeric(12,2) not null default 0,
  offer        numeric(12,2) not null default 0,
  cost         numeric(12,2),

  recycle_only boolean not null default false,
  listed_qty   int not null default 0 check (listed_qty   >= 0),
  recycled_qty int not null default 0 check (recycled_qty >= 0),

  created_at   timestamptz not null default now(),

  unique (deal_id, line_no),
  constraint b2b_deal_items_progress_fits
    check (listed_qty + recycled_qty <= quantity)
);

-- 5. Indexes for the three access patterns: a deal's items, the pipeline board
--    grouped by stage, and a client's deal history.
create index b2b_deal_items_deal_id_idx on public.b2b_deal_items (deal_id);
create index b2b_deals_stage_idx        on public.b2b_deals (stage);
create index b2b_deals_client_id_idx    on public.b2b_deals (client_id);

-- 6. RLS on with no policies: the tables are closed to the anon client and
--    every read and write goes through the service-role b2b-deals function.
--    The linter flags this as INFO; it is the same posture as every other
--    table in this project, and it is deliberate.
alter table public.b2b_clients    enable row level security;
alter table public.b2b_deals      enable row level security;
alter table public.b2b_deal_items enable row level security;
