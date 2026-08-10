-- ============================================================================
-- STORE CASH — the three balances off the daily Day End Report.
-- ----------------------------------------------------------------------------
-- The report already feeds buying and Google reviews into the Sales Summary
-- sheet. Cash does NOT go to the sheet: nothing on the site charts it, and a new
-- column block on the Buy tab is a geometry change that risks the two feeds that
-- already depend on that layout. It lands here instead, where the 7am email can
-- read it and history accumulates for free.
--
-- One row per store per day. `day` is the day the report COVERS (the Day End
-- Report is generated an hour after close and carries its own date in the
-- subject), not the day it was read.
-- ============================================================================

create table if not exists store_cash (
  day        date        not null,
  store      text        not null,
  -- Named for what the report calls them. "drawer" is the report's "Cash
  -- Balance" — its own sub-heading reads "Cash Drawer Cash count bills", and
  -- "cash balance" beside "total cash on hand" is too easy to misread.
  drawer     numeric(12,2),
  safe       numeric(12,2),
  -- Sent, not derived. If the report's own total ever disagrees with
  -- drawer + safe, that disagreement is worth seeing rather than papering over.
  total      numeric(12,2),
  source     text        not null default 'day_end_report',
  updated_at timestamptz not null default now(),
  primary key (day, store)
);

create index if not exists store_cash_day_idx on store_cash (day desc);

-- One row per day the morning email actually went out. The 7am import has an
-- 8am retry behind it (see sales-ingest), and without this the retry would send
-- Paul a second copy of the same table every time the first pass was merely
-- late rather than broken.
create table if not exists cash_report_sends (
  day        date primary key,
  sent_at    timestamptz not null default now(),
  recipients text[]      not null default '{}',
  stores     int         not null default 0
);

alter table store_cash        enable row level security;
alter table cash_report_sends enable row level security;
-- Service-role only, like sales_ingest_runs: these are written by edge functions
-- and read by one email. No anon path exists or should.
