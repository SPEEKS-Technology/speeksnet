-- ============================================================================
-- 0153 — Returned But Not Back In Stock: a morning mail to the DM.
--
-- Ethan, 2026-10-22: tell me whenever a store refunds a whole item (Shopify or
-- eBay, not a partial refund) and does not put it back in stock — so nothing
-- walks out unrecorded, and nothing sits on a shelf at quantity 0 for months.
-- Tell me the next day, not the same day.
--
-- The rules live in the unrestocked-returns function header. This adds:
--   1. unrestocked_returns — one row per refunded line found not restocked.
--      mailed_at is what stops a line being mailed as "new" twice; resolved_at
--      is set once it is on hand or has sold again, and the row is kept.
--   2. the unrestocked_returns recipient list, seeded with the DM. Empty, the
--      function falls back to claims_disputes_dm.
--   3. the cron: 7:35am Central. Hourly + Chicago-hour guard, so DST needs no
--      edit. :35 is a minute nothing else in the morning uses.
-- ============================================================================

create table if not exists public.unrestocked_returns (
  issue_key     text primary key,          -- <store>:<refund id>:<line item id>
  store_code    text not null,
  order_id      text not null,
  order_name    text,
  channel       text,                      -- eBay / In store / Online / ...
  kind          text,                      -- return | cancel
  flag          text,                      -- not_restocked | listing_deleted
  refund_at     timestamptz,
  refund_note   text,
  sku           text,
  title         text,
  amount        numeric(12,2),
  first_seen    timestamptz not null default now(),
  last_checked  timestamptz,
  mailed_at     timestamptz,
  resolved_at   timestamptz,
  resolved_how  text
);
create index if not exists unrestocked_returns_open on public.unrestocked_returns (store_code) where resolved_at is null;

-- RLS on, no policy: only the service role (the function) reads or writes it.
alter table public.unrestocked_returns enable row level security;

insert into public.email_recipients (list_key, email)
select 'unrestocked_returns', 'ethan.kushnir@speekstechnology.com'
where not exists (select 1 from public.email_recipients where list_key = 'unrestocked_returns');

select cron.unschedule('unrestocked-returns-735am') where exists (select 1 from cron.job where jobname = 'unrestocked-returns-735am');
select cron.schedule('unrestocked-returns-735am', '35 * * * *', $job$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/unrestocked-returns?secret=sp33ks-sync-k3y-2026-x9mq&store=ALL',
    timeout_milliseconds := 140000)
  where extract(hour from (now() at time zone 'America/Chicago')) = 7;
$job$);

insert into public.cron_expectations (jobname, stale_after_min, note)
values ('unrestocked-returns-735am', 1560, 'Fires 7:35am Central once a day — allow 26h.')
on conflict (jobname) do update set stale_after_min = excluded.stale_after_min, note = excluded.note;
