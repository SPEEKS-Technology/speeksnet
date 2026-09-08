-- ============================================================================
-- 0077 — Listing Titles: marking a denial's NOTE as read.
--
-- WHY THIS COLUMN EXISTS. A denial with a note is the only evidence a rule is
-- wrong, and until now it landed in the Confirmed Correct drawer where nobody
-- read it on a schedule. ?view=feedback now gathers those notes into one ask,
-- and the deck raises a card when there are un-triaged ones — so something has
-- to record that a note has been dealt with.
--
-- ⚠️ SERVER-SIDE, NOT localStorage, AND THAT IS THE WHOLE POINT. The recycle
-- reply card had exactly this shape and cleared only on the device that read it:
-- the DM viewed a reply on one machine and the alert stayed up everywhere else
-- (fixed 2026-09-04, commit 9cd1e46). A per-device high-water mark for this
-- would reproduce that bug knowingly. See [[popup-read-state]] for when a
-- localStorage mark IS the right tool — a per-viewer convenience, not a shared
-- work queue.
--
-- ⚠️ IT MARKS THE NOTE READ, NOT THE RULE FIXED. Stamping this says "this note
-- has been carried into an ask", which is the only thing the panel can honestly
-- claim: whether the rule then changed is decided in a conversation the tool
-- cannot see. Naming it 'triaged' rather than 'resolved' keeps that honest.
--
-- ⚠️ NULLABLE, AND OLD ROWS STAY NULL. Every note written before today is
-- un-triaged, which is correct — none of them have been carried into an ask yet.
-- Defaulting them to now() would silently swallow the three real notes this was
-- built to answer.
--
-- See [[title-deny-semantics]] for what a denial means in the first place, and
-- [[listing-titles-tool]] for the tool this belongs to.
-- ============================================================================

alter table public.listing_title_reviews
  add column if not exists feedback_triaged_at timestamptz,
  add column if not exists feedback_triaged_by text;

-- The card asks "are there notes nobody has carried into an ask yet", which is
-- a scan of denied rows with a note and a null stamp. Small table, but this runs
-- on a timer on the deck for every DM.
create index if not exists listing_title_reviews_untriaged_idx
  on public.listing_title_reviews (store_code, status)
  where status = 'denied' and feedback_triaged_at is null;
