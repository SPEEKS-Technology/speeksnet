-- ============================================================================
-- Buying Margin Review — schema.
-- ----------------------------------------------------------------------------
-- Modeled on Variance Replies, with one structural difference: the aggregate
-- half needs no upload. `kpi_entries` (period_type='weekly', period_end_date =
-- Sunday) already stores per-buyer `buying_value` (projected resale) and
-- `buying_cost` (paid), so summing two weekly rows yields the dollar-weighted
-- 2-week margin directly — never an average of percentages.
--
-- Only the line items (SKU, buy cost, projected resale, buy date) exist nowhere
-- in the system; the DM uploads those from the POS for flagged buyers only.
--
-- Weekly cycle:
--   Mon 10:00 Central  cron → generate_period for all 5 stores.
--     (10:00, not 08:30: weekly KPIs are *due* 08:30, so generating then races
--      managers who submit late. 90-minute grace window.)
--   DM sees which buyers flagged → pulls those buyers from the POS → uploads.
--   Managers answer the line items; DM responds; managers reply back.
--
-- The rule (all six numbers live in bm_config, DM-editable — the item gate in
-- particular cannot be calibrated until the first real upload lands):
--   buyer gate   rolling 2-week margin < 54%, >= 10 buys combined
--   item gate    previous week only, item margin <= 50%, >= $25 lost vs target
--   ranking      margin dollars lost vs 54.5%, descending, top 10
--   no cap       on flagged buyers per store — that count IS the progress
--                metric managers watch shrink, so capping it would hide the
--                difference between a 5-problem store and a 3-problem one.
--   A flagged buyer with zero qualifying items owes NOTHING. Separating "who
--   gets looked at" from "what must be written about" is the workload valve.
--
-- No RLS policies, matching every other table in this project: closed to the
-- anon client, all access through the service-role `buying-margin` edge fn.
--
-- Apply via Supabase MCP `apply_migration` (or the SQL editor).
-- ============================================================================

-- 1. Tunable thresholds. Single row — the DM edits these from the tool rather
--    than asking for a code change. Snapshotted onto every period (see
--    bm_periods.config) so old reports stay interpretable after a change.
create table public.bm_config (
  id                smallint primary key default 1 check (id = 1),
  buyer_margin_max  numeric not null default 54.0,   -- flag buyers under this 2wk margin
  min_buys_2wk      integer not null default 10,     -- combined across BOTH weeks, not per week
  item_margin_max   numeric not null default 50.0,   -- only items at/below this margin become line items
  min_dollars_lost  numeric not null default 25.0,   -- ...and only if they lost at least this vs target
  target_margin     numeric not null default 54.5,   -- the bar dollars-lost is measured against
  top_n_items       integer not null default 10,     -- cap per buyer
  reply_days        integer not null default 5,      -- business days managers get to answer
  updated_by        text,
  updated_at        timestamptz not null default now()
);
insert into public.bm_config (id) values (1) on conflict (id) do nothing;

-- 2. Per-store review state. Mirrors variance_store_status: a store "in the
--    clear" stops owing replies. Graduation is earned by posting zero flagged
--    buyers, but the DM can also set it by hand.
create table public.bm_store_status (
  store             text primary key,
  in_the_clear      boolean not null default false,
  clear_streak      integer not null default 0,  -- consecutive periods with zero flagged buyers
  updated_by        text,
  updated_at        timestamptz not null default now()
);

-- 3. One generated report per store per week. week_end is the Sunday that
--    closed the week; the 2-week evaluation window is [week_end-13, week_end].
create table public.bm_periods (
  id                  uuid primary key default gen_random_uuid(),
  store               text not null,
  week_end            date not null,               -- Sunday closing the reported week
  window_from         date not null,               -- week_end - 13
  window_to           date not null,               -- = week_end
  generated_at        timestamptz not null default now(),
  generated_by        text,                        -- 'cron' or a DM name for a manual re-run
  manager_due_at      timestamptz,
  dm_notes_at         timestamptz,                 -- first DM note; starts the manager review cycle
  -- Store rollups, all dollar-weighted across every buyer with data.
  store_margin_2wk    numeric,
  store_margin_week   numeric,
  store_margin_prior  numeric,                     -- the week before week_end, for the delta
  buy_value_2wk       numeric,
  -- The progress metric. flagged_count is what managers watch fall over time.
  buyers_evaluated    integer not null default 0,
  flagged_count       integer not null default 0,
  prior_flagged_count integer,                     -- previous period's count, for the delta arrow
  -- Buyers who appear in kpi_entries but are missing a week of the window, so
  -- their margin rests on a shorter sample than it looks. Surfaced, not hidden.
  incomplete_count    integer not null default 0,
  config              jsonb,                       -- bm_config as it stood at generation
  raw_file_name       text,
  raw_file_path       text,
  unique (store, week_end)
);
create index bm_periods_store_week_idx on public.bm_periods (store, week_end desc);

-- 4. One row per buyer per period — a snapshot, so history stays immutable even
--    after a manager edits a past KPI week. Buyers are keyed by (store, name):
--    people transfer mid-window (Ethan Frye had rows at both OVL and LEE in the
--    same week), and each manager reviews only the buys made at THEIR store.
create table public.bm_buyers (
  id                 uuid primary key default gen_random_uuid(),
  period_id          uuid not null references public.bm_periods (id) on delete cascade,
  store              text not null,
  buyer_name         text not null,
  margin_2wk         numeric,                      -- the gate
  margin_week        numeric,                      -- reported week alone
  margin_prior_week  numeric,                      -- the other week in the window
  buys_2wk           integer not null default 0,
  buys_week          integer not null default 0,
  buy_value_2wk      numeric,
  cust_conv          numeric,
  cust_conv_prior    numeric,
  device_conv        numeric,
  device_conv_prior  numeric,
  -- Margin improved while a conversion metric fell >3 points: margin bought by
  -- walking deals. Context for a different conversation — never a review trigger.
  guardrail          boolean not null default false,
  weeks_present      smallint not null default 0,  -- 1 = short sample (schedule gap or transfer)
  flagged            boolean not null default false,
  -- eligible / below_min_buys / incomplete / ok — precomputed for the UI so the
  -- frontend never re-derives the rule.
  status             text not null default 'ok',
  consecutive_flags  integer not null default 1,   -- flagged this many periods running; 2+ escalates
  sort_order         integer not null default 0,
  unique (period_id, buyer_name)
);
create index bm_buyers_period_idx on public.bm_buyers (period_id);
create index bm_buyers_name_idx   on public.bm_buyers (store, buyer_name);

-- 5. The ranked line items a manager answers. Uploaded by the DM from the POS,
--    for flagged buyers only, drawn from the reported week ONLY (not the full
--    2-week window) so the buyer still remembers the transaction.
create table public.bm_items (
  id                uuid primary key default gen_random_uuid(),
  period_id         uuid not null references public.bm_periods (id) on delete cascade,
  buyer_id          uuid references public.bm_buyers (id) on delete cascade,
  sort_order        integer not null default 0,    -- rank by dollars_lost desc, assigned at upload
  txn_id            text,
  sku               text,
  product_name      text,
  category          text,                          -- stored for later benchmark work; unused in v1 logic
  buy_cost          numeric,
  projected_resale  numeric,
  item_margin_pct   numeric,
  dollars_lost      numeric,                       -- (target × resale) − (resale − cost)
  buy_date          date,
  -- Reply cycle, identical in shape to variance_reply_items so the reminder,
  -- dot and popup logic ports across unchanged.
  gm_note           text,
  gm_note_by        text,
  gm_note_at        timestamptz,
  dm_note           text,
  dm_note_by        text,
  dm_note_at        timestamptz,
  dm_reply_requested boolean not null default false,
  mgr_reply         text,
  mgr_reply_by      text,
  mgr_reply_at      timestamptz,
  -- Structured reason codes were proposed and declined in favour of free text.
  -- The column stays so they can be switched on later without a migration.
  reason_code       text
);
create index bm_items_period_idx on public.bm_items (period_id);
create index bm_items_buyer_idx  on public.bm_items (buyer_id);

-- 6. Closed to the anon client; the edge function holds the service role.
alter table public.bm_config       enable row level security;
alter table public.bm_store_status enable row level security;
alter table public.bm_periods      enable row level security;
alter table public.bm_buyers       enable row level security;
alter table public.bm_items        enable row level security;
