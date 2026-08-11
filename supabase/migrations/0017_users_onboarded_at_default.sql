-- Applied 2026-08-10.
--
-- A new user with onboarded_at NULL gets no announcement cutoff at all, so their
-- first sign-in shows every announcement of the last 30 days as unread — exactly
-- the flood the cutoff exists to prevent. Nothing in the app ever set this
-- column; the ten rows that carried a value were set by hand.
--
-- Defaulting it to now() means "you are caught up as of the day your account was
-- made". Older announcements stay fully readable in the hub's Archived view —
-- this marks them not-unread, it does not remove them.
--
-- ⚠️ The catch-up point is deliberately NOT the same thing as a read. Do not be
-- tempted to insert announcement_reads rows for pre-onboarding announcements
-- instead: the author-facing "N read" receipt reads that table, so it would
-- report that people had read announcements they never saw.
--
-- Deliberately NOT backfilled onto the existing NULL rows: every one of them
-- shares created_at 2026-08-08 from a bulk row recreation, so that date is not
-- anyone's real start and their current unread counts are genuine.
alter table public.users
  alter column onboarded_at set default now();

comment on column public.users.onboarded_at is
  'Announcement catch-up point. Unread announcements dated before this are treated as caught up (hub Archived, not Unread) rather than marked read — see _samAnnHidden in speeks.js. Defaults to account creation.';
