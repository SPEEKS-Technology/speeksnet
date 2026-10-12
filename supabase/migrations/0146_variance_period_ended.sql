-- ============================================================================
-- 0146 — Variance Replies: the DM can END a period.
--
-- Ethan, 2026-10-12: a manager never replied and is overdue, "I'm not going to
-- make him do them this time but I'm still being pinged to review it ... with
-- no way to essentially end that". Before this the DM's "ready for review" card
-- only cleared by writing DM notes, so an unanswered period nagged forever, and
-- the manager kept being nagged (site + email) for replies nobody wanted now.
--
-- ended_at set = the reply cycle is over: no reminders on either side, no
-- emails, notes read-only. The report itself stays — ending is not deleting.
-- Reversible: the DM can reopen it (both columns cleared).
-- ============================================================================

alter table public.variance_reply_periods add column if not exists ended_at timestamptz;
alter table public.variance_reply_periods add column if not exists ended_by text;
