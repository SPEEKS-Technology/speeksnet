-- ============================================================================
-- 0187 — PROJECTS: the DM signs off a finished project, not only approves the
-- start (Ethan's feedback on 0186, 2026-11-18; Nick: "Lets have it so he has to
-- approve it when its completed as well").
--
-- 0186 approved a project once, before work began, and the DM then marked it
-- complete himself whenever he judged it done. Ethan read the flow as "submit a
-- tool for final approval" — so the people doing the work now say when it is
-- finished, and the DM approves it as complete or sends it back:
--
--   in_progress ──request_signoff──▶ awaiting_signoff ──complete──▶ completed
--        ▲            (requester or anyone involved)    │   (DM)
--        └──────────────return_signoff (DM, note)───────┘
--
-- The DM can still mark a running project complete directly — he is the one
-- who signs off, so his completing it IS the sign-off; this only stops a
-- requester's "it's done" from being invisible to him.
--
-- Additive only: two new values in each check constraint, nothing renamed, so
-- the 0186 front end on main keeps working against the new function.
--
-- 0187: the database's highest was 0186_projects on 2026-11-18, and no open
-- branch (Main-December-Update-2---Ethan tops out at 0184) holds anything above
-- it. Check list_migrations and every open branch again before reusing this.
-- ============================================================================

alter table public.projects drop constraint if exists projects_status_check;
alter table public.projects add constraint projects_status_check check (status in (
  'requested', 'changes_requested', 'in_progress', 'parked',
  'awaiting_signoff', 'completed', 'declined', 'withdrawn'));

alter table public.project_events drop constraint if exists project_events_kind_check;
alter table public.project_events add constraint project_events_kind_check check (kind in (
  'created', 'edited', 'resubmitted', 'approved', 'declined',
  'changes_requested', 'withdrawn', 'update', 'parked', 'resumed',
  'signoff_requested', 'signoff_returned',
  'completed', 'outcome'));

comment on table public.projects is
  'Projects next to SPEEKSNET (Claude-built tools, extensions, scripts) that need DM approval before work starts AND DM sign-off when finished. Shown as PRJ-<id>. status: requested → in_progress (approved) → awaiting_signoff (the people on it say it is done) → completed (DM signs off); or changes_requested / declined / withdrawn / parked. outcome is recorded after completion: incorporate (into SPEEKSNET), standalone, retire.';
