-- Documents that were never announced.
--
-- The Documents view has always been a projection of the announcements table:
-- any announcement carrying a doc_url shows up there as a downloadable file.
-- That coupling meant the only way to put a document in front of the stores was
-- to post an announcement about it, and the only way to take one down was to
-- delete the announcement it arrived on — which also deleted the message, the
-- reactions and the comments underneath it.
--
-- doc_only marks a row that exists purely to hold a file. It never renders on
-- the announcement board and is never subject to the board's 30-day window; it
-- exists so the Documents list, the storage bucket, the title matching and the
-- card rendering all stay single-sourced instead of growing a second table that
-- would have to be kept in step with this one.
--
-- Two consequences the cms function depends on:
--   * the board's keep() filter excludes doc_only rows outright, so adding a
--     document cannot push an announcement out of view or show up as one;
--   * remove_document branches on this flag — a doc_only row is deleted whole,
--     whereas a real announcement only has its file detached, so removing a
--     document never destroys a message somebody wrote.
--
-- Added 2026-08-01. Applied to the live project before this file existed; the
-- guards below make re-running it against that database a no-op.

alter table public.announcements
  add column if not exists doc_only boolean not null default false;

comment on column public.announcements.doc_only is
  'True when the row exists only to carry a file for the Documents view. Never rendered on the announcement board and exempt from its 30-day window.';

-- The Documents view reads every doc_only row on every open, unbounded by date,
-- so it is the one query that cannot fall back to the board's date index.
create index if not exists announcements_doc_only_idx
  on public.announcements (doc_only)
  where doc_only;
