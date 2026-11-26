-- 0201 — the all-day guide check (Ethan, 2026-11-23).
--
-- Picture checks move from one nightly batch to a TRICKLE: every 20 minutes,
-- 7am–9pm Central, picture-quality?trickle=1 puts every store's new listings
-- (30+ minutes old, not graded yet) into a half-price Batch, and the poller
-- collects the answers through the day instead of only 1–9am.
--
-- ⚠️ NOTHING IS SPENT UNTIL ETHAN SAYS GO. The function answers {off:true}
-- until the PQ_TRICKLE_ON=1 secret is set, so this cron fires harmlessly. The
-- old nightly (job pq-nightly-batch) stays paused by PQ_NIGHTLY_PAUSED=1 — keep
-- it paused when the trickle is on, or new listings are paid for twice.
--
-- Cost Ethan approved in principle: ~$0.02–0.025 a listing batched under the
-- guide-only check (guide shots, square, order), ~$65–90 a month at ~90 new
-- listings a working day.

select cron.schedule('pq-trickle', '5,25,45 * * * *', $$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/picture-quality?trickle=1&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 140000)
  where extract(hour from (now() at time zone 'America/Chicago')) between 7 and 21;
$$);

-- The poller was nightly-only (1–9am). Free (it only reads ended batches), so
-- it now runs every 30 minutes all day: a trickle batch lands within the hour.
select cron.schedule('pq-batch-poll', '*/30 * * * *', $$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/picture-quality?poll=1&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 140000);
$$);
