-- ============================================================================
-- 0149 — Confirm Shots: everything else the rules read from the model.
--
-- 0148 held the shot label plus five optional flags. Ethan (2026-10-16), on
-- what the flags are for: "add in anything else that you see our rules use if
-- this is for the purpose of training". A local model has to report every field
-- rules.ts decides on, so each one now has a human answer to be scored against.
--
--   flags          per-photo, named as the model's own fields so scoring is a
--                  lookup. Framing: crooked, off_center, too_small, cut_off,
--                  turned, wrong_angle. Issues the rules cost (only MAJOR ones
--                  count, so a flag means "a buyer would notice"): blurry,
--                  too_dark_or_glare, reflection, clutter, dirty_backdrop,
--                  loose_cord, not_on_stand, personal_info, stock_photo,
--                  fake_or_edited, wrong_item. Plus closeup (whole_item =
--                  false), screen_on, label_legible, different_spot (outside
--                  the listing's main setup). Rows saved before this keep
--                  'cropped', which means cut_off.
--   repeat_of      this photo repeats an earlier one (the model's `repeats`).
--                  It drives Approve Deletion.
--   flags_checked  TRUE = the flags were looked at, so a blank flag means NO.
--                  Before this a flag was optional, so blank meant "not
--                  looked", and those rows stay false and are never scored as a
--                  "no".
--   listing        the listing-level facts, the same on every row of one
--                  listing: lead_unclear, serial_hidden, main_flaw_shown
--                  (yes / partly / no, when the notes name a flaw on this
--                  unit), new_claim_wrong, units_apart, flat_package, and
--                  needed (the If-Needed shots the listing calls for). Missing
--                  shots, screen_never_on, serial shown and all_sides_shown
--                  follow from the photo labels, so they are not asked.
-- ============================================================================
alter table public.pq_shot_labels
    add column if not exists repeat_of     int,
    add column if not exists flags_checked boolean not null default false,
    add column if not exists listing       jsonb;
comment on column public.pq_shot_labels.flags is
  'Per-photo facts, named as the model''s fields (see 0149). Scored as "no" when blank only if flags_checked.';
comment on column public.pq_shot_labels.repeat_of is
  'This photo repeats photo N of the listing (the model''s repeats field).';
comment on column public.pq_shot_labels.listing is
  'Listing-level facts, same on every row of a listing: lead_unclear, serial_hidden, main_flaw_shown, new_claim_wrong, units_apart, flat_package, needed[].';
