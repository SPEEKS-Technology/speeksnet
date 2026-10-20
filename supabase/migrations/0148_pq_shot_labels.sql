-- ============================================================================
-- 0148 — Picture Quality: a person's call on which SHOT each photo is.
--
-- The gold set (scripts/pq-gold/, 2026-10-16) found no human shot labels
-- anywhere in the database. pq_photo_labels (0141) is framing only, and its
-- `shot` column is what the model said, shown to Ethan with no way to say it
-- was wrong. Approved Quick Fixes accept a model's labels as a whole and check
-- none of them one by one. A local vision model can only replace the API if
-- it is measured against labels a person made, so Confirm Shots (Picture
-- Quality, DM/CEO only) shows a graded listing's photos with the model's shot
-- prefilled. One key keeps the label and another changes it, and each answer
-- lands here.
--
-- ONE ROW PER PHOTO, keyed by the photo's CDN address without its query
-- string, like 0141: the identity survives a reorder, and a retaken photo is a
-- new question. photo_n is where it sat when confirmed.
--   shots        — the person's labels (one photo can be two shots: front AND
--                  lens open). "Extra" and "Box" as the sheet prompt uses them.
--   model_shots  — what the saved grade said, so agreement is one comparison.
--   sheet_slug   — the sheet the person confirmed; model_sheet the one graded.
--   flags        — optional facts about the photo: screen_on, label_legible,
--                  blurry, turned, cropped.
--   review_stamp / model — which grade was shown, so a later re-grade can't
--                  be mistaken for the one that was confirmed.
--
-- ⚠️ confirmed_by IS A DISPLAY NAME, like every "who" here (CLAUDE.md,
-- Identity). It's good for "whose eye is this", but it is not an audit trail.
--
-- Written only by the picture-quality edge function (service role). RLS is on
-- with no policy, the pattern for new tables here ([[supabase-rls-new-tables]]):
-- anon holds table grants by default, and this keeps them from meaning anything.
-- ============================================================================
create table if not exists public.pq_shot_labels (
    id            bigserial primary key,
    store_code    text not null,
    product_id    text not null,
    sheet_slug    text not null,
    model_sheet   text,
    photo_src     text not null,
    photo_n       int  not null,
    shots         text[] not null,
    model_shots   text[] not null default '{}',
    flags         text[] not null default '{}',
    model         text,
    review_stamp  text,
    confirmed_by  text not null,
    confirmed_at  timestamptz not null default now(),
    unique (product_id, photo_src)
);
create index if not exists pq_shot_labels_sheet on public.pq_shot_labels (sheet_slug);
comment on table public.pq_shot_labels is
  'Picture Quality gold set: a person''s confirmed shot label(s) for one listing photo, beside the model''s. Written by Confirm Shots (picture-quality fn). See 0148.';
comment on column public.pq_shot_labels.flags is
  'Optional per-photo facts: screen_on, label_legible, blurry, turned, cropped.';
alter table public.pq_shot_labels enable row level security;
revoke all on public.pq_shot_labels from anon, authenticated;
