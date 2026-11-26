-- 0206 — the 5-minute picture check (Ethan, 2026-11-24).
--
-- "Grade them as they come in … they finish a listing, it grades, they come
-- back and there's just a notification." Picture checks move from the 20-minute
-- trickle (0201) to SMALL BATCHES EVERY 5 MINUTES: picture-quality?quick=1 reads
-- each store's listings straight from Shopify, takes the ones live, in stock and
-- untouched for 5 minutes, picks their guide sheet live and sends the look in a
-- half-price batch. The poller collects every 2 minutes and asks any second look
-- live; a batch still out after 20 minutes is cancelled and graded live.
-- Ethan picked this over fully live grading: ~10–20 minutes to a grade for about
-- the batched price (~$100–120 a month at ~2,300 listings, an estimate until the
-- first test batch is measured).
--
-- ⚠️ NOTHING IS SPENT UNTIL ETHAN SAYS GO. The function answers {off:true} until
-- the PQ_QUICK_ON=1 secret is set, so this cron fires harmlessly. Keep
-- PQ_NIGHTLY_PAUSED=1 and PQ_TRICKLE_ON unset — this replaces both.

-- WHO LISTED IT, saved with the grade: the pop-up and My Listing Corrections
-- find a lister's own grades by this, without a Shopify read per row. Read from
-- the listing's tags against SPEEKSNET accounts (listerFrom) at grading time;
-- null when no account matches (no tag, a temp) — then it is the manager's alone.
alter table public.picture_quality_reviews add column if not exists lister_name text;
create index if not exists picture_quality_reviews_lister_idx
    on public.picture_quality_reviews (store_code, lister_name, reviewed_at desc);

-- ONE COLLECTOR PER BATCH: the poller claims an ended batch by moving it to
-- 'collecting' before it saves, so two overlapping polls never save (or pay for
-- the live second looks) twice.
alter table public.pq_batches drop constraint if exists pq_batches_status_check;
alter table public.pq_batches add constraint pq_batches_status_check
    check (status in ('submitted', 'collecting', 'done', 'failed'));

-- The 20-minute trickle is replaced, not run alongside (it would pay twice).
select cron.unschedule('pq-trickle') where exists (select 1 from cron.job where jobname = 'pq-trickle');

select cron.schedule('pq-quick', '*/5 * * * *', $$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/picture-quality?quick=1&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 140000)
  where extract(hour from (now() at time zone 'America/Chicago')) between 7 and 21;
$$);

-- Collecting is free (it only reads ended batches); every 2 minutes so a grade
-- reaches the lister as soon as its batch ends.
select cron.unschedule('pq-batch-poll') where exists (select 1 from cron.job where jobname = 'pq-batch-poll');
select cron.schedule('pq-batch-poll', '*/2 * * * *', $$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/picture-quality?poll=1&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 140000);
$$);
