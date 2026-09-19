-- 0095 — the 8:10am Processed Stats email
--
-- WHY
-- Leadership reads the morning mail as one picture: Sales Summary, buying stats,
-- cash, Net Profit. None of them says how much got LISTED. Devices Processed and
-- its Total Value are already banked daily in `day_end_facts` by day-end-ingest
-- at 7:05am and, until now, were read only by daily-brief's per-store narrative
-- — a store-by-store message, never a district table anyone could scan.
--
-- The `processed-report` edge function reads that table and mails it. It creates
-- nothing, recomputes nothing and calls no Apps Script beyond the Gmail relay,
-- so the only new state is this one row per day.
--
-- WHY NOT % OF GOAL
-- Recorded here as well as in the function, because it is the design decision a
-- future reader is most likely to try to "fix". Listed ÷ daily listing goal
-- would look like the obvious column and would be wrong twice over:
--
--   * The DM's Store Efficiency board scores the manager-filed WEEKLY KPI
--     (kpi_entries.listed_count). This email has only the Day End Report's own
--     Devices Processed. Measured over Sep 8–13 they disagree by 15–30% at every
--     store — BAL 104 vs 149, LEE 115 vs 163, MPL 103 vs 115, OVL 119 vs 147,
--     WSP 207 vs 233. Two screens, two "efficiency" numbers, no way to tell
--     which is right.
--   * The goals are mid-rework. 0091–0093 landed the new capacity model but
--     store-targets and the front end are held to Mon 2026-09-21, so a goal read
--     today is a number that moves next week.
--
-- The email carries no benchmark at all as a result. It shipped on 2026-09-18
-- with a trailing six-open-day average under Listed and an In Queue column
-- showing the backlog in days; Ethan cut both the same afternoon, on the grounds
-- that a glance email should not make you read a second figure to reach the
-- first. Three columns: store, what it listed, what that was worth. `queue_count`
-- stays in `day_end_facts` and stays free to read, so a backlog view is still
-- available later — as its own report, not as a sub-line here.
--
-- (Only the comments above changed after the DDL below was applied. The table
-- and the seeded list are exactly what went in.)
--
-- ============================================================================

-- One row per day the morning email actually went out.
--
-- `stores` is the point of the table, not decoration: the guard in the function
-- is "already sent with AT LEAST THIS MUCH", so a first pass that covered three
-- stores is allowed to be superseded by a later one holding five. Recording only
-- a timestamp would let an early, half-empty send stand as the day's answer —
-- which is exactly what happened to the cash email on 2026-09-12 (see 0086).
create table if not exists processed_report_sends (
  day        date primary key,
  sent_at    timestamptz not null default now(),
  recipients text[]      not null default '{}',
  stores     int         not null default 0
);

-- Service-role only, like cash_report_sends and sales_ingest_runs: written by an
-- edge function, read by one email. No anon path exists or should.
alter table processed_report_sends enable row level security;

-- The recipient list. Seeded with the two people it was built for so the first
-- morning send is not a silent no-op; both are editable from Operations → Email
-- Recipients afterwards, and the function's FALLBACK_TO stops covering the list
-- the moment it is non-empty.
insert into email_recipients (list_key, email) values
  ('processed_report', 'ethan.kushnir@speekstechnology.com'),
  ('processed_report', 'paul.kushnir@pikinvestments.com')
on conflict (list_key, email) do nothing;

-- ============================================================================
-- SCHEDULE — applied via Supabase MCP `execute_sql`, because cron.schedule is a
-- function call rather than DDL. Recorded here for provenance, same convention
-- as 0089_refund_mismatch_alert.sql.
--
-- Two UTC schedules, each gated on the local hour, so exactly one fires per day
-- through both halves of the year.
--
-- ⚠️ 8:10am CENTRAL, AND THE TEN MINUTES MATTER. The ask was 8:00 "same as the
-- other morning emails". The morning sales import runs at :00 and Net Profit at
-- :05, and both share an Apps Script lock with the Gmail relay this function
-- mails through — 0089 moved refund-mismatch to :20 for exactly that reason.
-- :10 is clear of both, ahead of refund-mismatch, and still inside the 8 o'clock
-- read. day-end-ingest fills the table this reads at 7:05, so the data is a full
-- hour old by then.
--
-- APPLIED 2026-09-18. Both jobs are live (jobid 63 and 64).
--
--   select cron.schedule('processed-report-810am-cdt', '10 13 * * *', $job$
--     select net.http_post(
--       url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/processed-report?secret=sp33ks-sync-k3y-2026-x9mq&trigger=cron',
--       headers := '{"Content-Type":"application/json"}'::jsonb,
--       body := '{}'::jsonb,
--       timeout_milliseconds := 300000
--     ) where extract(hour from (now() at time zone 'America/Chicago')) = 8;
--   $job$);
--
--   select cron.schedule('processed-report-810am-cst', '10 14 * * *', $job$
--     select net.http_post(
--       url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/processed-report?secret=sp33ks-sync-k3y-2026-x9mq&trigger=cron',
--       headers := '{"Content-Type":"application/json"}'::jsonb,
--       body := '{}'::jsonb,
--       timeout_milliseconds := 300000
--     ) where extract(hour from (now() at time zone 'America/Chicago')) = 8;
--   $job$);
-- ============================================================================
