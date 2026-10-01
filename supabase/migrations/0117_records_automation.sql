-- ============================================================================
-- 0117 — Company Records fill themselves in, and a store that breaks or comes
--        within 5% of its daily buy/sell record hears about it before opening.
--
-- Ethan, 2026-09-28. Every record on the Records tab was hand-typed text
-- ("$ 11,212.00", "January, 2026", one reviews row dated August 26, 2027), and
-- two had already been beaten without anybody noticing: MPL sold $9,756.42 on
-- Aug 24 against an $8,665.77 record, and closed 90% in August against 87%.
--
-- WHERE EACH RECORD COMES FROM. Checked against the hand-typed tab before any
-- of this was written; every store row the data can see reproduced exactly.
--   Daily Buy / Daily Sell       daily_buysell.buy / .sell (the Sales Summary,
--                                captured hourly off buy_sell_hub). `buy` is the
--                                resale value bought, which is what the tab has
--                                always called the buy record.
--   Monthly Revenue              monthly_brief net_sales  (NOT gross_sales)
--   Monthly Gross Profit         monthly_brief gross_profit
--   Monthly Sell Margin          monthly_brief gross_profit_pct, EXCLUDING each
--                                store's opening month — Ethan left OVL Sep 2024,
--                                WSP Jun 2025 and BAL Apr 2026 out on purpose:
--                                a part-month is not representative volume.
--   Monthly Customer Conversion  monthly_brief customer_close_rate
--   Single Day Google Reviews    stays manual. The data only has reviews by
--                                month; the record is one person's best day.
--
-- ONLY 2026 IS READ, and a record is never lowered. Ethan keeps the tab right
-- through 2026, so anything older on it (LEE's $18,086 buy, Oct 2025 — before
-- daily_buysell begins) is trusted as typed and only a bigger number replaces it.
--
-- THE COMPANY ROW CHANGES MEANING. It used to mirror whichever store was top,
-- which the card already shows as its headline. It is now the company-wide
-- figure: all five stores summed on one day / in one month. Those rows are
-- cleared here and refilled by records-watch from 2026 data only — a "company"
-- month from 2024, when only OVL was open, is not a company record. The
-- records GET hides these rows unless ?company=1 is asked for, so a browser
-- still on the old speeks.js keeps its headline on the top store instead of
-- suddenly showing a district total with no holder.
--
-- The job itself (records-watch) is documented at the top of its index.ts.
-- ============================================================================

-- Numbers the job can compare without re-parsing hand-typed text, and the exact
-- day a daily record was set (month start for a monthly one). Both are null on a
-- row nobody has recomputed yet; value stays the display text.
alter table public.records
  add column if not exists value_num numeric,
  add column if not exists record_on date;

-- The one row dated a year that has not happened.
update public.records
   set period = 'August 26, 2026'
 where label = 'Single Day Google Reviews' and period = 'August 26, 2027';

-- Parse what is typed today so the first run has something to compare against.
update public.records
   set value_num = nullif(regexp_replace(value, '[^0-9.\-]', '', 'g'), '')::numeric
 where person is null and store <> 'Company';

-- Company rows: reset, one per store-held metric. value is NOT NULL, so empty
-- text until the first run fills it; the page hides an empty company tile.
delete from public.records where store = 'Company' and person is null;
insert into public.records (store, label, value, period)
select 'Company', l, '', null
  from unnest(array[
    'Daily Buy Record', 'Daily Sell Record',
    'Monthly Revenue Record', 'Monthly Gross Profit Record',
    'Monthly Sell Margin Record', 'Monthly Customer Conversion Record'
  ]) as l;

-- ONE ROW PER STORE PER DAY EVALUATED — the whole idempotency story. A row
-- exists the moment that store-day has been judged, whether or not it hit
-- anything, so the 7:40 catch-up and any re-run skip it. notified_at is set
-- only once the relay accepted the mail, so a failed send is retried on the
-- next run from what was recorded here, never recomputed against a record the
-- same day may already have raised.
create table if not exists public.record_watch_log (
  day          date        not null,
  store        text        not null,
  buy          numeric,
  sell         numeric,
  -- The record each figure was judged against, as it stood BEFORE this day.
  buy_record   numeric,
  buy_period   text,
  sell_record  numeric,
  sell_period  text,
  -- [{ metric: 'buy'|'sell', kind: 'record'|'near', value, prior, pct }]
  hits         jsonb       not null default '[]'::jsonb,
  evaluated_at timestamptz not null default now(),
  notified_at  timestamptz,
  recipients   text[],
  relay        text,
  primary key (day, store)
);
comment on table public.record_watch_log is
  'One row per store per trading day judged by records-watch against its daily buy/sell record. hits non-empty = an email was due; notified_at = it went. See 0117.';
alter table public.record_watch_log enable row level security;

-- 6:40 Central, with a 7:40 catch-up for any store whose figures were late.
-- Hourly + a Central-hour guard, the house pattern since 0096: change the hour
-- in the guard, never only the cron line. :40 is clear of everything the Apps
-- Script lock owns (:05/:10 of 6, :00 of 7) and of processed-report at 6:15,
-- which mails through the same relay.
select cron.schedule(
  'records-watch-640am',
  '40 * * * *',
  $$
  select net.http_post(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/records-watch?secret=sp33ks-sync-k3y-2026-x9mq&trigger=cron',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) where extract(hour from (now() at time zone 'America/Chicago')) in (6, 7);
  $$
);

-- Applied by hand straight after the first run (2026-09-28), recorded here for
-- provenance: the hand-typed rows the job left alone were tidied to its own
-- format — "$ 11,771.50" → "$11,771.50", "January, 2026" → "January 2026".
-- Text only; no value changed.
--   update public.records
--      set value  = regexp_replace(value, '^\$\s+', '$'),
--          period = regexp_replace(period, '^([A-Za-z]+),\s*(\d{4})$', '\1 \2'),
--          updated_at = now()
--    where person is null
--      and (value ~ '^\$\s+' or period ~ '^[A-Za-z]+,\s*\d{4}$');
