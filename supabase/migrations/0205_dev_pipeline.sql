-- ============================================================================
-- 0205 — DEVELOPMENT TRACKER: the pipeline (2026-11-24).
-- Plan: docs/plans/dev-tracker-HANDOFF.md §6b. Rules: docs/DEVELOPMENT-WORKFLOW.md.
--
-- Nick's model (2026-11-24): Backlog → a branch → pre-release → live.
--   * A BRANCH carries tickets. Each branch is a column in the suite. A ticket
--     can be ticked done on its branch while the work goes on, or taken off it.
--   * PRE-RELEASE IS THE NEXT UPDATE. Whatever merges into pre-release ships in
--     the next update — all of it. When a branch merges, EVERY ticket on it
--     comes along, ticked or not.
--   * The next update has a SIZE — minor (x.y.Z), major (x.Y.0) or overhaul
--     (X.0.0) — and its version is worked out from the live one, never typed.
--     Major and overhaul need a title (dev-tickets enforces that at Go live,
--     not here: the title can be written before the size is chosen).
--
-- WHAT CHANGES
--   dev_tickets.branch       the branch the ticket is being built on. Kept after
--                            the merge, so a patch note can say where it came from.
--   dev_tickets.branch_done  ticked on its branch (+ when). Cleared when it leaves.
--   dev_releases.size        minor / major / overhaul. Only the next update needs
--                            one; published rows keep null (their version says it).
--   ONE next update          the release with status 'in_progress' — at most one,
--                            by a partial unique index. Release 14 ("Main December
--                            Update") is it, as a major. 'planned' stays for the
--                            Roadmap Nick wants later; nothing uses it now.
--   dev_branch_merged()      the merge, in one statement: every open ticket on a
--                            branch → on_prerelease, release_id = the next update,
--                            each with a history row.
--                            NOT CALLED (note added after applying): it can't tell
--                            a ticket put on a reused branch AFTER an old merge,
--                            which the nightly reconcile replays. github-webhook's
--                            mergeBranch() does the move itself, checking each
--                            ticket's 'branch' history row against the merge time.
--                            A 0206 adding a branch_at column for this was
--                            declined. Drop this function in a later migration.
--   event kinds              + 'branch' (on / off a branch), 'branch_done' (ticked).
--
-- WHERE A TICKET SITS, from its own columns (the suite and the connector agree):
--   Backlog       status triage / backlog
--   a branch      status in_progress / in_review, branch = its name
--   Pre-release   status on_prerelease (release_id = the next update)
--   Live          status done (release_id = the update it shipped in)
--
-- release_id ON AN UNSHIPPED TICKET is a wish, not a stage: the 12 backlog
-- tickets Nick filed under release 14 keep it (a "wanted for December" hint).
-- Being on pre-release is decided by status alone. Go live (Phase 6) clears the
-- wish from anything that didn't make it, so a published release's tickets are
-- exactly the ones that shipped.
--
-- 0205: database max was 0204_listing_review_my_fixes (2026-11-24); no branch on
-- origin carries anything past 0196.
-- ============================================================================

alter table public.dev_tickets
  add column if not exists branch          text,
  add column if not exists branch_done     boolean not null default false,
  add column if not exists branch_done_at  timestamptz;

create index if not exists dev_tickets_branch_idx on public.dev_tickets (branch) where branch is not null;

comment on column public.dev_tickets.branch is
  'The git branch this ticket is being built on (the suite''s branch column). Kept after the merge for the patch notes'' "from <branch>".';
comment on column public.dev_tickets.branch_done is
  'Ticked done on its branch while the branch is still open. Cleared when the ticket leaves the branch.';

alter table public.dev_releases
  add column if not exists size text check (size in ('minor', 'major', 'overhaul'));

comment on column public.dev_releases.size is
  'The next update''s size: minor bumps x.y.Z, major x.Y.0, overhaul X.0.0. Set on the in_progress row; the version is computed from the live one.';

-- The next update: one at a time.
create unique index if not exists dev_releases_one_next on public.dev_releases ((true)) where status = 'in_progress';

update public.dev_releases set size = 'major', updated_at = now()
 where status = 'in_progress' and size is null;

-- History kinds for the pipeline.
alter table public.dev_ticket_events drop constraint if exists dev_ticket_events_kind_check;
alter table public.dev_ticket_events add constraint dev_ticket_events_kind_check
  check (kind in ('created', 'imported', 'edited', 'status', 'assigned', 'release', 'linked', 'unlinked', 'branch', 'branch_done'));

-- ---------------------------------------------------------------------------
-- The next update's id, making one (minor, untitled) if there isn't one —
-- straight after a Go live there isn't, until something merges or someone
-- sets the size.
-- ---------------------------------------------------------------------------
create or replace function public.dev_next_release()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  rid bigint;
begin
  select id into rid from dev_releases where status = 'in_progress' limit 1;
  if rid is null then
    insert into dev_releases (title, status, size) values ('', 'in_progress', 'minor')
    on conflict do nothing
    returning id into rid;
    if rid is null then  -- a concurrent call made it first
      select id into rid from dev_releases where status = 'in_progress' limit 1;
    end if;
  end if;
  return rid;
end;
$$;

-- ---------------------------------------------------------------------------
-- A branch merged into pre-release: everything on it is now in the next
-- update. Tickets already shipped, already on pre-release or Won't do are left
-- alone. Returns the ids it moved.
-- ---------------------------------------------------------------------------
create or replace function public.dev_branch_merged(p_branch text, p_note text, p_actor_name text default 'GitHub', p_actor_id uuid default null)
returns setof bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  rid bigint := dev_next_release();
begin
  return query
  with moved as (
    update dev_tickets t
       set status = 'on_prerelease', release_id = rid, closed_at = null, updated_at = now()
      from dev_tickets o                       -- o = the row as it was, for the history
     where o.id = t.id
       and t.branch = p_branch
       and t.status in ('triage', 'backlog', 'in_progress', 'in_review')
    returning t.id, o.status as was
  ), logged as (
    insert into dev_ticket_events (ticket_id, kind, actor_name, actor_id, from_value, to_value, note)
    select m.id, 'status', p_actor_name, p_actor_id, m.was, 'on_prerelease', p_note from moved m
    returning ticket_id
  )
  select ticket_id from logged;
end;
$$;

revoke all on function public.dev_next_release() from public, anon, authenticated;
revoke all on function public.dev_branch_merged(text, text, text, uuid) from public, anon, authenticated;

select public.ai_reader_refresh_grants();
