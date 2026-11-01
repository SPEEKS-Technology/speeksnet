-- ============================================================================
-- 0155 — Returned But Not Back In Stock: mail every morning anything is open.
--
-- Ethan, 2026-10-22: "the only times this doesn't send out is when there is
-- nothing to report. I want to know if my managers did not do this correctly or
-- just did not do it at all." 0153's mail went out only on a morning with
-- something new, so an ignored item went quiet after one mention.
--
--   last_mailed_at  the once-a-day guard (a manual re-run cannot mail twice)
--   times_mailed    how many mornings an item has been on the mail
--
-- The rows mailed by the 2026-10-22 catch-up count as mailed once that day.
-- ============================================================================

alter table public.unrestocked_returns
  add column if not exists last_mailed_at timestamptz,
  add column if not exists times_mailed   integer not null default 0;

update public.unrestocked_returns
   set last_mailed_at = mailed_at, times_mailed = 1
 where mailed_at is not null and last_mailed_at is null;
