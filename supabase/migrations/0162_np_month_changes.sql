-- ============================================================================
-- 0162 — NP MONTH CHANGES: what moved in a finished month before it locked
-- (Ethan, 2026-11-02).
--
-- "We leave the net profit report open for 6 or 7 days after month end ... if
-- it changes tonight to 180, I would want that changed automatically ... and I
-- want to know that there were changes made." Same day the close moved from the
-- 1st to the 7th (CLOSE_DAY in netprofit-collect, NPS_CLOSE_DAY in
-- netprofit-schedule.gs), so a finished month now keeps moving for a week.
--
-- np-sync (every 15 min) diffs the finished month's tab against daily_np before
-- it overwrites it, then makes the rest of the site follow — the Monthly
-- Breakdown's Net Profit / eBay Fees rows and a Net Profit record that month
-- holds — and logs every change here. Ethan's rules for those, same day:
--   · ANY change is reported, not just $150+ like the in-month alert.
--   · The sheet always wins, even over a figure typed in the Monthly Breakdown:
--     "if I notice the sheet is wrong, we'll fix the sheet, which will then
--     overwrite it again."
--   · A record set on a figure that later fell is corrected down, and if it is
--     no longer a record at all the old record comes back.
--
-- One email per batch, not per sync: the 6:10 / 2pm passes write the tab over
-- ~5 minutes and a sync can land mid-write. np-sync sends once a sync finds
-- nothing new and the newest pending row is 14+ minutes old.
--
-- kind:  day     one column of one store-day (what = the column, day = the date;
--                'added' / 'removed' for a whole day appearing or going)
--        total   a store's month NP total, once per sync it moved
--        brief   a Monthly Breakdown row np-sync rewrote (what = metric_key)
--        record  a records row np-sync corrected (what = the record label)
--
-- RLS on, no policy: only the service role (np-sync) touches it.
-- ============================================================================

create table if not exists public.np_month_changes (
  id          bigserial primary key,
  ym          text not null,
  store       text not null,
  kind        text not null check (kind in ('day', 'total', 'brief', 'record')),
  what        text not null,
  day         date,
  was         numeric,
  now         numeric,
  was_text    text,
  now_text    text,
  seen_at     timestamptz not null default now(),
  emailed_at  timestamptz,
  relay       text
);

create index if not exists np_month_changes_pending
  on public.np_month_changes (seen_at) where emailed_at is null;

alter table public.np_month_changes enable row level security;

comment on table public.np_month_changes is
  'Changes np-sync found in a finished month''s Net Profit tab before it locked, and the site rows it corrected to follow (0162). emailed_at null = not yet sent.';
