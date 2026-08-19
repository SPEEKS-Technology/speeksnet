-- Dedupe ledger for the SPEEKS Connect error alerter.
--
-- The alerter runs every 15 minutes. Without this table a single failed listing
-- would mail 96 times a day, which trains the reader to ignore the mail -- the
-- exact opposite of the point. One row per distinct problem, keyed by a stable
-- description of the problem itself (not by a timestamp), so the same fault
-- recognises itself on the next pass.
create table if not exists ebay_alert_state (
  issue_key     text primary key,
  store_code    text,
  severity      text,
  summary       text,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  last_alerted  timestamptz,
  times_alerted integer not null default 0
);

create index if not exists ebay_alert_state_last_seen_idx on ebay_alert_state (last_seen);

alter table ebay_alert_state enable row level security;
-- No policies: the alerter reaches this only with the service-role key, exactly
-- like the other ops tables. Nothing in the browser reads it.
