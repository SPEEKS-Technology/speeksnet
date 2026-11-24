-- ============================================================================
-- 0190 — SPOT CHECK NOTES ARE THEIR OWN THING.
--
-- Ethan, 2026-11-18: "we should keep the passes that I regrade to its own
-- thing. It can look just like listing health but be a separate popup just for
-- these and have it work the same way. Clear notes and stuff like that."
--
-- So a Grade It Myself / Send Back from the spot check no longer writes a
-- "should flag" dismissal onto picture_quality_reviews (which put it in Listing
-- Health Notes beside the stores' "Not Wrong" reasons). The note lives on the
-- spot check row itself, and Clear stamps it here — the same assertion
-- feedback_triaged_at makes for the other notes (0077): a person saying Claude
-- has been through it, never something a copy does on its own.
-- ============================================================================

alter table public.listing_spot_checks
  add column if not exists triaged_at timestamptz,
  add column if not exists triaged_by text;

create index if not exists listing_spot_checks_waiting_idx
  on public.listing_spot_checks (result, triaged_at);
