-- 0109 — pin search_path on the seven functions that did not set it
--
-- Housekeeping in the wake of 0108. The advisor's remaining WARN:
-- "function has a role mutable search_path". A function without an explicit
-- search_path resolves its table names against whatever the CALLER's
-- search_path happens to be, so a caller who can create objects can put a
-- decoy `b2b_deals` in front of the real one and the function will happily
-- use it.
--
-- All seven are SECURITY INVOKER (checked: prosecdef = false), so they run
-- with the caller's own rights — this is not the privilege-escalation case
-- that makes the same warning urgent on a SECURITY DEFINER function. It is
-- cheap to close anyway, and it stops the weekly advisor mail from carrying
-- a live warning that everyone then learns to scroll past.
--
-- `set search_path` does not touch a function body; existing triggers and
-- callers see identical behaviour. pg_temp goes last, explicitly, so a
-- temporary table can never shadow a real one.
alter function public.b2b_stage_rank(text)                        set search_path = public, pg_temp;
alter function public.b2b_touch_row()                             set search_path = public, pg_temp;
alter function public.b2b_sync_listed_qty()                       set search_path = public, pg_temp;
alter function public.b2b_sync_listing_stores()                   set search_path = public, pg_temp;
alter function public.b2b_outreach_next(date, integer, date)      set search_path = public, pg_temp;
alter function public.b2b_outreach_next_u(date, integer, text, date) set search_path = public, pg_temp;
alter function public.mg_resolve_band(smallint, numeric)          set search_path = public, pg_temp;
