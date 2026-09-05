-- Listing Titles: the name check runs once a day, at 4am Central.
--
-- Ethan asked for midnight — "so every morning we get a fresh stock of what to
-- fix" — and the intent is right but the hour was wrong. Measured:
--
--   * listing happens 8am-7pm Central (nothing meaningful after 19:00)
--   * callback-catalog-refresh's LAST incremental run is 16:28 Central
--   * callback-catalog-rebuild (the full one) runs ~2am Central
--
-- So midnight sits in the gap between the last refresh and the rebuild, and
-- anything listed after ~16:30 — about 7 listings a day — would not be in
-- ebay_catalog yet and would go unchecked until the following night, every
-- night. 4am is after the rebuild, so the catalogue is complete, and it is still
-- hours before anyone opens the panel.
--
-- ⚠️ ONE JOB, BOTH DST-CANDIDATE UTC HOURS, GATED INSIDE — the same shape
-- listing-titles-sweep and callback-catalog-refresh use. 4am Central is 09:00
-- UTC in CDT and 10:00 UTC in CST; the gate makes exactly one of them fire.
-- A plain UTC schedule would silently shift by an hour twice a year.
--
-- ⚠️ llm=1 IS THE ONLY PASS THAT SPENDS MONEY, and it is capped at NAME_MAX
-- (100) per store per run inside the function. It cannot run away: the pass
-- takes ONLY listings whose exact title it has never been shown, so on a normal
-- morning it asks about the ~55 new listings across all five stores (~11 each,
-- measured) and costs roughly $0.14. A store with nothing new returns
-- examined:0 and asks nothing at all.
--
-- ⚠️ It must NOT replace the twice-daily rules sweep. That one still runs at
-- 10:20 and 16:20 Central over the whole estate; this one only visits listings
-- it has never asked about. The rules sweep carries NAME_CODES forward so it
-- cannot stamp a paid-for verdict `clean` — see the edge function.

select cron.schedule(
  'listing-titles-name-check',
  '0 9,10 * * *',
  $job$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/listing-titles?sweep=1&store='
           || s || '&llm=1&limit=100&save=1&secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 55000)
  from (values ('OVL'),('LEE'),('WSP'),('MPL'),('BAL')) as t(s)
  where extract(hour from (now() at time zone 'America/Chicago')) = 4;
  $job$
);

-- 26 hours, matching callback-catalog-rebuild: a daily job has a 24h gap by
-- design, so anything tighter would page every morning.
insert into cron_expectations (jobname, stale_after_min, watching_since, note)
values ('listing-titles-name-check', 1560, now(),
        'Daily at 4am Central (after the 2am catalogue rebuild) — a 24h gap by design, so allow 26h. The only job that calls a paid API; capped at 100 listings per store per run and asks only about titles it has never seen.')
on conflict (jobname) do update
  set stale_after_min = excluded.stale_after_min,
      note            = excluded.note;
