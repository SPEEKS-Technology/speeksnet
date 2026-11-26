-- ============================================================================
-- 0186 — PROJECTS: approval and tracking for work that sits next to SPEEKSNET
-- (Nick, 2026-11-17). A tab in the Analytics Workspace (workspace.html#projects).
--
-- Claude-built tools, browser extensions, scripts, side tools someone wants to
-- build. Rule from the same day: no project starts until Ethan (DM) approves it.
-- Approval IS the start — an approved project goes straight to in_progress — and
-- only he marks it completed. Once it is done he records what happens to it:
-- folded into SPEEKSNET, kept standalone, or retired.
--
-- 0186: Main-December-Update-2---Ethan holds 0181-0184 as files, and the
-- database already had a 0185 (ebay_deletion_notices_retention) applied from
-- somewhere else on 2026-11-18 — this file was written as 0185 the day before
-- and caught only by list_migrations. Check every open branch AND the database
-- before picking a number (CLAUDE.md, trap 4).
--
--   requested ──approve──▶ in_progress ──complete──▶ completed ──outcome
--      │  ▲                    │  ▲
--      │  └─resubmit─ changes_requested     park │  │ resume
--      ├─request_changes──▶────┘             ▼  │
--      ├─decline──▶ declined               parked
--      └─withdraw─▶ withdrawn  (requester)
--
-- WHO, from the feature switches the projects edge function reads (same
-- user > role > default resolution as the browser, so what a person can see
-- and what the server lets them do cannot drift apart):
--   nav-projects       see the board      manager, owner-manager, MOCD, DM, CEO
--   projects-request   ask for a project  manager, owner-manager, MOCD, DM
--   projects-approve   decide             DM
--
-- REAL PEOPLE, NOT TYPED NAMES (Nick: "from a token list of the employees at
-- the company so we can … have actual users attached"). The requester and
-- everyone involved are users.id values, picked from the roster and checked
-- against users by the function. Each carries the name it had too, so a person
-- later removed from the roster still reads as somebody; the function shows
-- the CURRENT name for anyone still there, so a rename follows them.
--
-- No foreign key, deliberately: the Manage Users save deletes and re-inserts
-- every users row (auth function), so an FK would either block that save or
-- cascade every project's people away. What makes the id worth storing is the
-- other half of this change — auth now carries each person's id across that
-- save (matched by PIN), so it stays put for as long as their PIN does.
--
-- RLS on, no policy: the house pattern. Only the service role (the projects
-- function) reads or writes. Granted to the Claude connector's reader below so
-- "what projects are in flight?" can be answered in a chat.
-- ============================================================================

create table if not exists public.projects (
  id              bigserial primary key,
  -- THREE FIELDS, on purpose (Nick, 2026-11-17: "as simple as Project Title,
  -- Project Description, and Who's involved"). The first draft also asked for
  -- a summary, goal, plan, tools, stores, needs and links; a form that long is
  -- one people put off filling in, and the description can say all of it.
  title           text not null check (length(btrim(title)) between 1 and 120),
  description     text not null check (length(btrim(description)) between 1 and 4000),
  involved        jsonb not null default '[]'::jsonb,  -- [{id: users.id, name}] — the requester if left empty
  status          text not null default 'requested' check (status in (
                    'requested', 'changes_requested', 'in_progress',
                    'parked', 'completed', 'declined', 'withdrawn')),
  outcome         text check (outcome in ('incorporate', 'standalone', 'retire')),
  requested_by    text not null,                 -- name at the time (display)
  requested_by_id uuid,                          -- users.id: who it really is
  requested_store text,
  decided_by      text,
  decided_at      timestamptz,
  decision_note   text,                          -- the reason given with the last decision
  started_at      timestamptz,
  completed_at    timestamptz,
  outcome_note    text,
  outcome_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table public.projects enable row level security;

create index if not exists projects_status_idx on public.projects (status);

comment on table public.projects is
  'Projects next to SPEEKSNET (Claude-built tools, extensions, scripts) that need DM approval before work starts. Shown as PRJ-<id>. status: requested → in_progress (approved) → completed; or changes_requested / declined / withdrawn / parked. outcome is recorded after completion: incorporate (into SPEEKSNET), standalone, retire.';
comment on column public.projects.involved is 'Who is working on the project: [{id, name}] where id is users.id, picked from the roster (not typed). name is the name at the time, kept for anyone later removed. The requester if left empty. Anyone listed can post progress updates.';
comment on column public.projects.requested_by_id is 'users.id of the requester, resolved from their PIN. requested_by holds their name at the time.';
comment on column public.projects.decision_note is 'Reason given with the most recent approve / decline / request-changes decision.';

-- Append-only history. The detail page's timeline reads this, and it is the
-- record of who approved what, when.
create table if not exists public.project_events (
  id          bigserial primary key,
  project_id  bigint not null references public.projects (id) on delete cascade,
  kind        text not null check (kind in (
                'created', 'edited', 'resubmitted', 'approved', 'declined',
                'changes_requested', 'withdrawn', 'update', 'parked', 'resumed',
                'completed', 'outcome')),
  actor       text not null,
  note        text,
  from_status text,
  to_status   text,
  created_at  timestamptz not null default now()
);
alter table public.project_events enable row level security;

create index if not exists project_events_project_idx on public.project_events (project_id, created_at);

comment on table public.project_events is
  'History of each project: every status change with who made it and the note they gave, plus progress updates (kind = update).';

-- The Claude connector reads through column grants it recomputes (0142).
select public.ai_reader_refresh_grants();
