-- Google reviews, read from GOOGLE instead of through the POS.
--
-- WHY. The only review figure the site had arrived via the nightly Day End
-- Report, and the POS behind it lags: LEE stood at 29 reviews on the month while
-- the report still said 26. That lag is indistinguishable from a store that has
-- stopped earning reviews, which is why reviews were pulled out of the daily
-- store messages entirely (daily-brief v25, commit cac29ec).
--
-- ⚠️ THE METRIC CHANGES. The POS figure is FIVE-STAR reviews month to date. The
-- Places API returns `userRatingCount`, which is EVERY review at any star rating,
-- and there is no way to decompose it: Places gives a rating average rounded to
-- one decimal, so rating × count cannot recover the star split at a store with
-- hundreds of reviews. The four surfaces are already LABELLED "Google Reviews",
-- so this makes the label honest rather than breaking it — but the goal row in
-- the sheet was set as a five-star target and becomes slightly easier to hit.
--
-- HOW A MONTHLY COUNT COMES OUT OF A RUNNING TOTAL. Places only ever tells us the
-- all-time count, so a snapshot is taken once a day per store and the month's
-- reviews are a difference between two snapshots. Exact, same-day, and needs no
-- cooperation from the POS. See supabase/functions/google-reviews.

-- The Place ID per store, resolved once and stored rather than hardcoded: a
-- listing that gets recreated gets a new id, and a constant in a function would
-- then silently report the wrong shop's reviews. `display_name` and
-- `formatted_address` are kept so a human can confirm we matched the right
-- storefront, which is the failure this table exists to make visible.
create table if not exists public.google_places (
  store             text primary key,
  place_id          text not null,
  display_name      text,
  formatted_address text,
  resolved_at       timestamptz not null default now()
);

-- One row per store per Central day. `total_reviews` is the all-time count as
-- Google reported it at capture time; everything else is derived from the
-- difference between rows.
create table if not exists public.google_reviews_daily (
  store         text not null,
  date          date not null,
  total_reviews integer not null,
  rating        numeric(2,1),
  captured_at   timestamptz not null default now(),
  primary key (store, date)
);

-- Finding a month's reviews means reaching for the newest snapshot at or before
-- the last day of the previous month, per store.
create index if not exists google_reviews_daily_store_date_idx
  on public.google_reviews_daily (store, date desc);

alter table public.google_places enable row level security;
alter table public.google_reviews_daily enable row level security;
-- No policies, by convention: the anon key is public and every reader here is an
-- edge function on the service role.
revoke all on public.google_places from anon, authenticated;
revoke all on public.google_reviews_daily from anon, authenticated;
grant select, insert, update on public.google_places to service_role;
grant select, insert, update on public.google_reviews_daily to service_role;

-- The snapshot cron. 11:30pm Central so the row belongs unambiguously to that
-- Central date, which is what the month arithmetic depends on. Both UTC hours
-- with a Central-hour guard, so exactly one fires year-round — the pattern from
-- 0044, not the -cdt/-cst pair where both halves fire and one runs at the wrong
-- local time.
select cron.schedule('google-reviews-snapshot', '30 4,5 * * *', $job$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/google-reviews?snap=1&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 55000)
  where extract(hour from (now() at time zone 'America/Chicago')) = 23;
$job$);

-- Watched like every other slow job (see 0044). 26 hours: a daily snapshot that
-- misses one night leaves a hole in the month-to-date difference, and nothing
-- else would say so.
insert into public.cron_expectations (jobname, stale_after_min, note) values
  ('google-reviews-snapshot', 1560, 'Daily at 11:30pm Central. A missed night leaves a hole in the month-to-date difference.')
on conflict (jobname) do update
  set stale_after_min = excluded.stale_after_min, note = excluded.note;
