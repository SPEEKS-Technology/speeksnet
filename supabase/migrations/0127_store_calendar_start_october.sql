-- ============================================================================
-- Start the Store Calendar in October 2026: nothing from the old Google
-- calendar shows before the month the new one went live.
-- APPLIED 2026-10-01 through the Supabase MCP (execute_sql), right after 0126.
--
-- Ethan, 2026-10-01: "since we are moving to a new calendar, you can start
-- this on October." Of the 109 imported rows, 100 began before Oct 1 and none
-- of those ran into October, so it is a clean cut:
--   * 86 one-off rows (past inventories, pickups, travel, pay days, ...)
--     are deleted.
--   * 14 yearly rows (current staff's birthdays and work anniversaries) are
--     KEPT, with their first date moved to its 2027 date. Deleting them would
--     have lost them for good. Leaving them at 2026 would have drawn them on
--     the calendar in Feb–Sep 2026, before the start. The "Started YYYY."
--     notes on anniversaries are unchanged and still right.
-- Left: 23 rows (9 in October 2026 + the 14 yearly ones).
-- Only source = 'google' rows were touched; nothing a person entered.
-- ============================================================================

update public.store_calendar_events
   set event_date = (event_date + interval '1 year')::date, updated_at = now()
 where source = 'google' and repeats_yearly and event_date < '2026-10-01';

delete from public.store_calendar_events
 where source = 'google' and not repeats_yearly and event_date < '2026-10-01';
