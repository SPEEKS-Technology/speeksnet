-- ============================================================================
-- 0118 — records-watch judges the monthly records too, in the same email.
--
-- Ethan, 2026-09-28, the day after 0117: he enters the previous month in the
-- Monthly Breakdown on the 1st, and expected a store that broke (or came within
-- 5% of) its revenue, gross profit, sell margin or conversion record to hear on
-- the morning of the 2nd — "Multiple records beaten or within the 5% on the same
-- day should be shown on one email." 0117 only raised the monthly records
-- silently.
--
-- The log grows a SCOPE. A monthly verdict is dated the 1st of its month, which
-- is also a real trading day, so (day, store) can no longer be the key: Sep 1's
-- daily row and September's monthly row would collide.
--
-- AUGUST 2026 IS MARKED JUDGED, and nothing is sent for it. It was on the tab
-- before monthly judging existed, so the first run would otherwise judge it
-- against records it already set — or, where it did not set one, mail a stale
-- "so close" a month late (LEE's August revenue is 98% of its July record).
-- ============================================================================

alter table public.record_watch_log
  add column if not exists scope text not null default 'daily',
  add column if not exists figures jsonb;

alter table public.record_watch_log drop constraint if exists record_watch_log_pkey;
alter table public.record_watch_log add primary key (day, store, scope);

alter table public.record_watch_log
  add constraint record_watch_log_scope_chk check (scope in ('daily', 'monthly'));

comment on table public.record_watch_log is
  'One row per store per judged period: scope daily = a trading day vs Daily Buy/Sell; scope monthly = a closed month (day = the 1st) vs the four monthly records. hits non-empty = an email was due; notified_at = it went. See 0117, 0118.';

insert into public.record_watch_log (day, store, scope, hits, notified_at, relay)
select date '2026-08-01', s, 'monthly', '[]'::jsonb, now(),
       'seeded by 0118 — on the tab before monthly judging existed'
  from unnest(array['OVL', 'LEE', 'WSP', 'MPL', 'BAL']) as s
on conflict do nothing;
