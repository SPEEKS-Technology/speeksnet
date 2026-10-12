-- ============================================================================
-- 0145 — Recycle requests: a required reason.
--
-- Ethan, 2026-10-12: every recycle request now picks a reason from a fixed list
-- (Poor Testing / Damaged-Broken / Low Value / Other) on top of the free-text
-- note, so the review tab can filter and total by WHY things are being recycled.
--
-- Stored as a slug, not the label, so a relabel in the UI never orphans old rows.
-- Nullable on purpose: every row filed before today has no reason, and the
-- front end shows those as "No reason (older)". "Required" is enforced by the
-- form and by the edge function rejecting an unknown value — not by NOT NULL,
-- which would have broken the live page in the window between this migration
-- and the front end shipping.
-- ============================================================================

alter table public.recycle_requests add column if not exists reason text;

alter table public.recycle_requests drop constraint if exists recycle_requests_reason_check;
alter table public.recycle_requests add constraint recycle_requests_reason_check
  check (reason is null or reason in ('poor_testing', 'damaged', 'low_value', 'other'));
