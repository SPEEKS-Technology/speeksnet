-- 0194 ALERTS HUB, PHASE 1: PHONE PUSH
-- ---------------------------------------------------------------------------
-- The Alerts Hub (docs/alerts-hub-plan.md) puts every work notification for a
-- store on one work phone: SPEEKSNET decides what matters and pushes it. This
-- is the delivery half only. Rules, reminders, the inbox reader and the digest
-- come in later phases and all end in the same `alerts-hub` send.
--
-- push_subscriptions: one row per phone/browser that tapped "Turn On Phone
-- Alerts". The endpoint is the push service's address for that device (Apple
-- for an iPhone home-screen app, Google for Android Chrome); p256dh + auth are
-- the device's keys, needed to encrypt each message so only it can read it.
-- Who it belongs to is the same free-text name/role/store as everywhere else
-- (no user_id exists in this schema — see CLAUDE.md "Identity"). A dead
-- endpoint (404/410 from the push service) is disabled, not deleted, so the
-- log keeps saying where a message went.
--
-- alert_log: every push attempted, one row per device. Later phases add "Done"
-- taps and the Missed/Wrong feedback against these rows.
--
-- RLS on with no policy (house pattern, see 0108): only the service role in
-- the edge function reads or writes these.

create table if not exists push_subscriptions (
  id           bigint generated always as identity primary key,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_name    text not null,
  role         text,
  store        text,
  device       text,
  user_agent   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  last_ok_at   timestamptz,
  fail_count   int not null default 0,
  last_error   text,
  disabled_at  timestamptz
);
create index if not exists push_subscriptions_user_idx  on push_subscriptions (lower(user_name)) where disabled_at is null;
create index if not exists push_subscriptions_store_idx on push_subscriptions (store) where disabled_at is null;

create table if not exists alert_log (
  id               bigint generated always as identity primary key,
  created_at       timestamptz not null default now(),
  source           text not null default 'manual',
  rule_key         text,
  user_name        text,
  store            text,
  title            text not null,
  body             text,
  url              text,
  tag              text,
  subscription_id  bigint references push_subscriptions(id) on delete set null,
  status           text not null,
  http_status      int,
  error            text
);
create index if not exists alert_log_created_idx on alert_log (created_at desc);

alter table push_subscriptions enable row level security;
alter table alert_log          enable row level security;
