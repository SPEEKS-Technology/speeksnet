-- ============================================================================
-- 0141 — Picture Quality: a person's grade on single photos.
--
-- Framing (centred, level, big enough) is the one call the Picture Quality
-- checker could not get right on 2026-10-08. Four approaches were scored
-- against Ethan's answer key: the model judging it inside the review (missed
-- what he would flag), the model reporting the item's position (centred every
-- item), pixels against the backdrop (white-on-white, the clear stand, cables),
-- and a separate framing call (agreed with itself on viewpoint as "crooked").
-- The key only said which LISTINGS were off, which cannot tell a rule which
-- PHOTO it got wrong. So Ethan grades photos one at a time beside the guide's
-- example, and the next framing check is scored against these rows offline —
-- for free — before any paid run. (Ethan: "I like building a tool to train the
-- system on this before we start spending money.")
--
-- ONE ROW PER PHOTO, keyed by the photo's CDN address without its query string:
-- the photo's identity survives a reorder, and a retaken photo is a new row.
-- `shot` is what the saved review called the photo, so a label can be compared
-- with the guide example it was shown beside.
--
-- ⚠️ labelled_by IS A DISPLAY NAME, like every "who" in this schema (see
-- CLAUDE.md, Identity). Fine for "whose eye is this", not an audit trail.
--
-- Written only by the picture-quality edge function (service role). RLS on with
-- no policy, the pattern for new tables here: anon holds table grants by
-- default, and this keeps them from meaning anything.
-- ============================================================================

create table if not exists public.pq_photo_labels (
    id           bigserial primary key,
    store_code   text not null,
    product_id   text not null,
    photo_src    text not null,
    photo_n      int,
    sheet_slug   text,
    shot         text,
    label        text not null check (label in ('fine', 'problem', 'not_item')),
    problems     text[] not null default '{}',
    note         text,
    labelled_by  text not null,
    labelled_at  timestamptz not null default now(),
    unique (product_id, photo_src)
);

comment on table public.pq_photo_labels is
  'Picture Quality training: one person''s grade of one listing photo (fine / problem / not the item). Scored against offline before a framing rule ships.';
comment on column public.pq_photo_labels.problems is
  'When label = problem: any of off_center, crooked, too_small, blurry, cut_off.';

alter table public.pq_photo_labels enable row level security;
