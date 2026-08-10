-- Site usage telemetry + the nightly 8pm Central usage report.
--
-- Applied via the Supabase MCP (apply_migration / execute_sql), recorded here
-- for provenance — same convention as 0008_b2b_outreach_cron.sql. cron.schedule
-- is a function call, not DDL, so it cannot be run by a migration runner.
--
-- Context: nothing on this site recorded a READ before this. Every usage signal
-- was a side effect of someone writing something, so read-only tools (the Margin
-- Guide above all) were invisible, and there was no record that a person had
-- even opened the site. usage_events fixes that; usage-report reads it against
-- an expected-headcount denominator derived from Listing Goals.

-- ---------------------------------------------------------------- raw events
create table if not exists public.usage_events (
  id           bigserial primary key,
  occurred_at  timestamptz not null default now(),
  day          date not null,
  user_name    text not null,
  user_role    text,
  store        text,
  event        text not null,           -- 'signin' | 'open' | 'jump'
  feature      text not null,           -- modal id / tab key / data-feature key
  label        text,
  opens        int  not null default 1,
  meta         jsonb,
  session_id   text not null default ''
);

comment on table public.usage_events is
  'One row per user per surface per session (first open), with repeat opens folded into opens. day is the America/Chicago date, stamped by the usage edge function.';
comment on column public.usage_events.session_id is
  'Client session UUID, minted at sign-in. Upsert key, and the unit for counting sessions per user per day.';
comment on column public.usage_events.opens is
  'Cumulative opens of this surface within the session. Re-sent whole on every flush, not incremented server-side.';

create index if not exists usage_events_day_store_idx   on public.usage_events (day, store);
create index if not exists usage_events_day_user_idx    on public.usage_events (day, user_name);
create index if not exists usage_events_day_feature_idx on public.usage_events (day, feature);

-- The client keeps a cumulative open-count per surface for the life of a session
-- and re-sends it on every flush. Upserting on this key means a repeat open
-- updates opens rather than piling up rows.
alter table public.usage_events
  drop constraint if exists usage_events_session_surface_key;
alter table public.usage_events
  add constraint usage_events_session_surface_key unique (session_id, event, feature);

alter table public.usage_events enable row level security;

-- ------------------------------------------------------------- daily rollup
create table if not exists public.usage_daily_snapshots (
  day        date not null,
  store      text not null,
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  unique (day, store)
);

comment on table public.usage_daily_snapshots is
  'One row per store (+ ALL for the district) per day. Written by the usage-report edge function so trend deltas survive the 90-day usage_events prune.';

alter table public.usage_daily_snapshots enable row level security;

-- ------------------------------------------------------------------- recipient
insert into public.email_recipients (list_key, email)
values ('usage_report', 'ethan.kushnir@speekstechnology.com')
on conflict (list_key, email) do nothing;

-- ------------------------------------------------------------------- schedule
-- 8:00pm Central year-round. Two UTC schedules an hour apart, both guarded on
-- the same Central hour, so exactly one fires whether the US is on CDT (UTC-5)
-- or CST (UTC-6). Note those UTC times fall on the NEXT calendar day — which is
-- why every date boundary inside the function is computed in Central.
--
-- select cron.schedule('usage-report-cdt', '0 1 * * *', $job$
--   select net.http_post(
--     url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/usage-report?secret=sp33ks-sync-k3y-2026-x9mq',
--     headers := '{"Content-Type":"application/json"}'::jsonb,
--     body := '{}'::jsonb,
--     timeout_milliseconds := 120000
--   ) where extract(hour from (now() at time zone 'America/Chicago')) = 20;
-- $job$);
-- select cron.schedule('usage-report-cst', '0 2 * * *', $job$ ... same body ... $job$);
--
-- Live as jobid 13 (cdt) and 14 (cst) since 2026-08-08.
