-- ============================================================================
-- 0076 — A TITLE FIX NOW CARRIES INTO THE REST OF THE LISTING, SO THE LEDGER
-- HAS TO SAY WHAT ELSE IT MOVED.
--
-- Ethan, 2026-09-03: "if we change something in the title and that change is
-- something in the HTML spec table or the listing metafields, that needs to be
-- changed there too so the listing remains consistent from title to the rest.
-- Example would be if we change the model number in the title, we need to
-- change it everywhere in the listing."
--
-- Approving a title used to swap any WHOLE COPY of the old title found in the
-- description or a metafield. That misses the commoner case by a mile: the
-- listing does not repeat the title, it repeats the FACT. MPL's Sony ZV-E10
-- states "L-Mount" in four separate places — the title, the Mount Type row of
-- the description's spec table, the `mount_type` metafield, and again inside
-- `title_attributes`, the JSON array PayMore's lister builds titles from. Fixing
-- the title left three copies of the error standing, in the half of the page a
-- buyer scrolls to precisely BECAUSE they want to check the title.
--
-- The edge function now carries the reviewer's changed words into every field
-- that states them (planEchoes). `listing_title_moves` is the only record of
-- what this tool has ever done to a catalogue, so it stores which fields moved
-- with the title — without it the ledger would say a title changed on Sep 3 and
-- nothing at all about the four other edits made to the same listing in the same
-- second.
--
-- Measured over the 104 queued rows that had a suggestion on 2026-09-03:
-- 50 would carry a change into a spec field (a Speed, an Interface, a Mount
-- Type, a misspelled Brand), and 3 would leave a field stating something the
-- title has stopped stating — which is reported to the reviewer rather than
-- guessed at, because a deletion has no replacement value to write.
--
-- Shape: [{ "field": "Mount Type", "was": "L-Mount", "now": "E-Mount",
--           "where": ["spec table", "mount_type", "title_attributes"] }]
-- ============================================================================

alter table public.listing_title_moves
  add column if not exists spec_changes jsonb not null default '[]'::jsonb;

comment on column public.listing_title_moves.spec_changes is
  'Spec fields rewritten alongside the title when this move was applied: the '
  'description spec table, the individual metafields, and the {key,value} JSON '
  'attribute arrays. Empty when the changed words appeared nowhere else.';
