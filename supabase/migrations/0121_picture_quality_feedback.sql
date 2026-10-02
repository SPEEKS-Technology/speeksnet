-- ============================================================================
-- 0121 — Picture Quality: a dismissal's note is feedback, and gets read.
--
-- Ethan, 2026-09-30, on the first look at the Picture Quality screen: "When a
-- user says they are fine, should we add a notes section as well and act just
-- like the listing health notes tool currently for you to fix?" Yes — the same
-- loop the title tool runs (0077): a manager dismisses a flag and writes why,
-- the note lands in Listing Health Notes with a ready ask for Claude, and once
-- the rule has been looked at the notes are CLEARED (not deleted) by a person.
--
-- These two columns are that "cleared" stamp. Separate from decided_at on
-- purpose: deciding a row and having its note read are two different acts by
-- two different people, and folding them together is what made the title
-- tool's first version clear notes the moment they were copied.
-- ============================================================================

alter table public.picture_quality_reviews
    add column if not exists feedback_triaged_at timestamptz,
    add column if not exists feedback_triaged_by text;
