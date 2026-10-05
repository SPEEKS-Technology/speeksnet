-- ============================================================================
-- store_calendar_events.repeat — Never / Daily / Weekly / Monthly / Quarterly /
-- Yearly, replacing the yes/no repeats_yearly.
--
-- WHY. Ethan, 2026-10-04: "add a Repeat dropdown for daily, weekly, monthly,
-- quarterly, and yearly". A yes/no flag can't say which, so the rule moves to a
-- text column with a fixed list.
--
-- repeats_yearly STAYS and the edge function keeps it in step
-- (repeats_yearly = repeat = 'yearly'). Nothing else reads it today, but the
-- 14 imported birthdays and anniversaries were written with it (0126/0127), and
-- keeping both true at once means a browser still holding the previous
-- speeks.js draws them correctly until it reloads.
--
-- How a repeat is drawn (client, _scalOccurrences): the row keeps its FIRST
-- date and each repeat lands on the same weekday (weekly) or the same day of
-- the month (monthly every 1, quarterly every 3, yearly every 12). A month
-- without that day is skipped rather than shifted — the 31st does not slide to
-- the 30th — which is what Google does by default too. There is no end date;
-- a repeating event repeats until it is edited or deleted.
-- ============================================================================

alter table public.store_calendar_events
  add column if not exists repeat text not null default 'none'
  check (repeat in ('none', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly'));

update public.store_calendar_events set repeat = 'yearly' where repeats_yearly and repeat = 'none';
