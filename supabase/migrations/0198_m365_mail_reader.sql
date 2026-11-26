-- 0198 — Alerts Hub: read Ethan's SPEEKS Technology mailbox and push what matters
-- (docs/alerts-hub-plan.md phase 5; access setup in docs/alerts-hub-m365-setup-for-paul.md)
--
-- Ethan, 2026-11-21:
--   * Paul, any @paymore.com sender and the store managers push RIGHT AWAY.
--     The alert is "sender + a subject written from the email's contents" so he
--     can tell how urgent it is, with URGENT in caps when it truly is (Sonnet 5.5
--     reads those emails only; ~$0.006 each, quoted and approved).
--   * Everyone else who is a real person (not spam, promotions, automated mail)
--     is counted: a count push every 2 hours 9am–7pm when new ones arrived, and
--     the still-unread count in the morning digest.
--   * Check every 5 minutes, 7am–9pm Central.
--
-- Rules live here so the DM can change who is "top" without a deploy (plan
-- principle: rules in the database). Matching, first hit wins in this order:
-- exact address → display name ('name:<full name>') → '@domain'. A domain match
-- that looks automated (List-Unsubscribe, noreply, bulk) is still noise, so a
-- PayMore system mailer doesn't page anyone. tier 'ignore' never counts.
--
-- No addresses are written in this file: Paul's and the managers' come from
-- user_notify_prefs (the same addresses SPEEKSNET already emails), so the repo
-- carries no personal contact details.

create table if not exists public.m365_mail_rules (
  id          bigserial primary key,
  match       text not null unique,          -- 'someone@x.com' | '@x.com' | 'name:Full Name'
  tier        text not null check (tier in ('top', 'other', 'ignore')),
  label       text,                          -- what the alert calls them; null = sender's own name
  note        text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- One row per email the reader has seen. Kept 60 days (cron below). The subject
-- is stored so the 2-hour count can name senders; the body is never stored.
create table if not exists public.m365_mail_seen (
  id            text primary key,              -- Graph message id
  received_at   timestamptz not null,
  from_address  text,
  from_name     text,
  label         text,
  tier          text not null check (tier in ('top', 'other', 'noise', 'ignore')),
  subject       text,
  ai_subject    text,
  urgent        boolean,
  pushed_at     timestamptz,
  counted_at    timestamptz,                   -- included in a 2-hour count push
  ai_cost_usd   numeric(10,6),
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists m365_mail_seen_received on public.m365_mail_seen (received_at desc);
create index if not exists m365_mail_seen_other_uncounted on public.m365_mail_seen (tier) where counted_at is null;

-- Single-row state: how far the reader has read, and when each digest last went.
create table if not exists public.m365_mail_state (
  id               int primary key default 1 check (id = 1),
  cursor           timestamptz,
  last_poll_at     timestamptz,
  last_poll_error  text,
  last_other_push  timestamptz,
  last_morning     date,
  -- Off switch. Starts paused so the first deploy can be tested with dry runs
  -- before any real push; set false to go live, true to silence it.
  paused           boolean not null default true
);
insert into public.m365_mail_state (id) values (1) on conflict (id) do nothing;

-- RLS on with no policy: only the service role (edge functions) reads these.
alter table public.m365_mail_rules enable row level security;
alter table public.m365_mail_seen  enable row level security;
alter table public.m365_mail_state enable row level security;

-- Seed: Paul (address and name), PayMore, the store managers.
-- Labels read "<name> · <where>" (Ethan, 2026-11-21: "Scott from PayMore,
-- Doug from Cross", then a middle dot so it doesn't stack on iPhone's own
-- "from SPEEKSNET" line). A rule with no label lets the AI work it out from the
-- sender's signature and domain.
insert into public.m365_mail_rules (match, tier, label, note)
select lower(p.email), 'top', split_part(u.name, ' ', 1) || ' · SPEEKS', 'CEO — from user_notify_prefs'
from public.users u join public.user_notify_prefs p on lower(p.user_name) = lower(u.name)
where u.role ilike 'ceo' and coalesce(p.email, '') <> ''
on conflict (match) do nothing;

insert into public.m365_mail_rules (match, tier, label, note)
select 'name:' || lower(u.name), 'top', split_part(u.name, ' ', 1) || ' · SPEEKS', 'CEO by display name (any address he writes from)'
from public.users u where u.role ilike 'ceo'
on conflict (match) do nothing;

insert into public.m365_mail_rules (match, tier, label, note)
values ('@paymore.com', 'top', null, 'Any PayMore sender (corporate and the mo0X store mailboxes)')
on conflict (match) do nothing;

insert into public.m365_mail_rules (match, tier, label, note)
select lower(p.email), 'top', split_part(u.name, ' ', 1) || ' · ' || u.store, 'Store manager — from user_notify_prefs'
from public.users u join public.user_notify_prefs p on lower(p.user_name) = lower(u.name)
where u.role ilike 'manager' and coalesce(p.email, '') <> ''
on conflict (match) do nothing;

-- Every 5 minutes. The function decides from Central time what to do on each
-- tick (poll 7am–9pm, count push at 9/11/1/3/5/7, morning digest at 8:30), so
-- the schedule doesn't care about daylight saving.
select cron.schedule('m365-mail-tick', '*/5 * * * *', $job$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/m365-mail?action=tick&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 120000);
$job$);

select cron.schedule('m365-mail-retention', '17 9 * * *', $job$
  delete from public.m365_mail_seen where received_at < now() - interval '60 days';
$job$);
