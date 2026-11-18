-- ============================================================================
-- 0187 — DEVELOPMENT TRACKER, Phase 1: the data model (Nick, 2026-11-18).
-- Plan and every decision behind it: docs/plans/dev-tracker-HANDOFF.md.
--
-- GitHub keeps the CODE; everything about the WORK — tickets, which branch and
-- PR belongs to which ticket, releases, shipping — moves into SPEEKSNET, and
-- (Phase 7) production is reached only from here. This file is the tables;
-- the dev-tickets edge function is the only thing that reads or writes them.
--
-- 0187: database max was 0186_projects and no open branch had anything higher
-- on 2026-11-18 (Ethan's December branch stops at 0184, already applied).
--
-- TICKET NUMBERS (Q5). A ticket's id IS its number, shown as SN-<id>. Issues
-- imported from GitHub (Phase 2) are inserted WITH their GitHub number, so a
-- "#573" in an old commit or PR still finds SN-573. Everything created here
-- takes the next value of dev_ticket_number_seq, which starts at 1000 — clear of
-- every imported number, because GitHub stops numbering issues once Issues is
-- switched off after the import (PRs keep the shared counter, but PRs are not
-- tickets).
--
-- TYPE + AREA (Q1). A broken B2B quote is a Bug in the B2B area, not one or the
-- other. Both lists are tables so they can grow without a deploy.
--
--   triage ─▶ backlog ─▶ in_progress ─▶ in_review ─▶ on_prerelease ─▶ done
--      └──────────┴────────────┴─────────────┴──────────────┴──────▶ wont_do
--   (any status can move to any other by hand in Phase 1; Phase 4 drives
--    in_review / on_prerelease / done from GitHub)
--
-- REAL PEOPLE (D10). Reporter, assignee and every actor are users.id values
-- resolved server-side from the PIN, each with the name at the time for anyone
-- later removed. No foreign key to users, deliberately: the Manage Users save
-- deletes and re-inserts every row (see 0186's header).
--
-- RLS on, no policy: the house pattern. Only the service role reads or writes.
-- ============================================================================

-- ---- lookup lists ----------------------------------------------------------
create table if not exists public.dev_ticket_types (
  key        text primary key,
  label      text not null,
  sort       int  not null default 0,
  dev_only   boolean not null default false,  -- true: devs can pick it, the Phase 3 "Submit a ticket" form can't
  active     boolean not null default true
);
alter table public.dev_ticket_types enable row level security;

insert into public.dev_ticket_types (key, label, sort) values
  ('bug',         'Bug',         10),
  ('suggestion',  'Suggestion',  20),
  ('improvement', 'Improvement', 30),
  ('task',        'Task',        40)
on conflict (key) do nothing;

create table if not exists public.dev_ticket_areas (
  key        text primary key,
  label      text not null,
  sort       int  not null default 0,
  active     boolean not null default true
);
alter table public.dev_ticket_areas enable row level security;

insert into public.dev_ticket_areas (key, label, sort) values
  ('b2b',         'B2B',              10),
  ('claims',      'Claims',           20),
  ('ebay',        'eBay & listings',  30),
  ('kpis',        'KPIs',             40),
  ('quickportal', 'QuickPortal',      50),
  ('operations',  'Operations',       60),
  ('callbacks',   'Callbacks',        70),
  ('other',       'Other',            99)
on conflict (key) do nothing;

-- ---- releases --------------------------------------------------------------
-- One row per update. Phase 2 imports GitHub's milestones and releases into
-- it; Phase 6's release builder creates and publishes from it.
create table if not exists public.dev_releases (
  id                bigserial primary key,
  version           text unique,                -- 'v3.12.0'; null while a release is only a plan with a name
  title             text not null,              -- 'Main December Update'
  notes             text,
  status            text not null default 'planned' check (status in ('planned', 'in_progress', 'published')),
  target_date       date,
  published_at      timestamptz,
  published_by      text,
  published_by_id   uuid,
  github_milestone  int unique,                 -- milestone number, for imported rows
  github_release_id bigint unique,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table public.dev_releases enable row level security;

-- ---- tickets ---------------------------------------------------------------
create sequence if not exists public.dev_ticket_number_seq start with 1000 minvalue 1000;

create table if not exists public.dev_tickets (
  id             bigint primary key default nextval('public.dev_ticket_number_seq'),
  title          text not null check (length(btrim(title)) between 1 and 200),
  description    text not null default '' check (length(description) <= 20000),
  type           text not null references public.dev_ticket_types (key) on update cascade,
  area           text references public.dev_ticket_areas (key) on update cascade,
  priority       text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status         text not null default 'triage' check (status in (
                   'triage', 'backlog', 'in_progress', 'in_review', 'on_prerelease', 'done', 'wont_do')),
  assignee_id    uuid,                          -- users.id
  assignee_name  text,                          -- name at the time
  reporter_id    uuid,                          -- users.id; null for an imported issue from someone not mapped
  reporter_name  text not null,
  reporter_store text,
  stores         text[] not null default '{}', -- which stores it affects, if any
  release_id     bigint references public.dev_releases (id) on delete set null,
  due            date,
  source         text not null default 'dev' check (source in ('dev', 'idea', 'github_import')),
  github_number  int unique,                    -- the issue it came from (= id for imports)
  project_id     bigint references public.projects (id) on delete set null,  -- Q7: a Project folded into SPEEKSNET
  closed_at      timestamptz,                   -- set on done / wont_do, cleared on reopen
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter sequence public.dev_ticket_number_seq owned by public.dev_tickets.id;
alter table public.dev_tickets enable row level security;

create index if not exists dev_tickets_status_idx   on public.dev_tickets (status);
create index if not exists dev_tickets_assignee_idx on public.dev_tickets (assignee_id);
create index if not exists dev_tickets_release_idx  on public.dev_tickets (release_id);

comment on table public.dev_tickets is
  'Development tickets for SPEEKSNET itself, shown as SN-<id>. Imported GitHub issues keep their issue number as id; new tickets number from 1000. type + area are lookup keys (dev_ticket_types, dev_ticket_areas). status: triage → backlog → in_progress → in_review → on_prerelease → done, or wont_do.';
comment on column public.dev_tickets.assignee_id is 'users.id of whoever is doing it. assignee_name is their name at the time.';
comment on column public.dev_tickets.reporter_id is 'users.id of whoever raised it, resolved from their PIN (or from github_people for an import).';

-- Comments on a ticket. Imported GitHub comments keep their id so a re-run of
-- the import can't duplicate them.
create table if not exists public.dev_ticket_comments (
  id                bigserial primary key,
  ticket_id         bigint not null references public.dev_tickets (id) on delete cascade,
  body              text not null check (length(btrim(body)) between 1 and 20000),
  author_name       text not null,
  author_id         uuid,
  source            text not null default 'speeksnet' check (source in ('speeksnet', 'github')),
  github_comment_id bigint unique,
  created_at        timestamptz not null default now(),
  edited_at         timestamptz
);
alter table public.dev_ticket_comments enable row level security;
create index if not exists dev_ticket_comments_ticket_idx on public.dev_ticket_comments (ticket_id, created_at);

-- Append-only history: every change, who made it, from what to what.
create table if not exists public.dev_ticket_events (
  id          bigserial primary key,
  ticket_id   bigint not null references public.dev_tickets (id) on delete cascade,
  kind        text not null check (kind in (
                'created', 'imported', 'edited', 'status', 'assigned', 'release', 'linked', 'unlinked')),
  actor_name  text not null,                    -- a person, or 'GitHub' for what Phase 4 does on its own
  actor_id    uuid,
  from_value  text,
  to_value    text,
  note        text,
  created_at  timestamptz not null default now()
);
alter table public.dev_ticket_events enable row level security;
create index if not exists dev_ticket_events_ticket_idx on public.dev_ticket_events (ticket_id, created_at);

-- Code that belongs to a ticket: a branch, a commit, a PR. Phase 4 fills it
-- from "SN-123" in branch names, commit messages and PR titles.
create table if not exists public.dev_ticket_links (
  id         bigserial primary key,
  ticket_id  bigint not null references public.dev_tickets (id) on delete cascade,
  kind       text not null check (kind in ('branch', 'commit', 'pr')),
  ref        text not null,                     -- branch name / full sha / PR number
  url        text,
  title      text,
  state      text,                              -- PR: open / merged / closed
  created_at timestamptz not null default now(),
  unique (ticket_id, kind, ref)
);
alter table public.dev_ticket_links enable row level security;

-- ---- GitHub side -----------------------------------------------------------
-- Who's who: a GitHub login → a SPEEKSNET person (D10). Seeded with the two
-- accounts that do the work today, by users.id (there are two Ethans).
create table if not exists public.github_people (
  login      text primary key,                  -- lower case
  user_id    uuid,
  name       text not null,
  updated_at timestamptz not null default now()
);
alter table public.github_people enable row level security;

insert into public.github_people (login, user_id, name) values
  ('eckushnir', '523bae7a-5308-4294-ba7e-540a081e67b9', 'Ethan Kushnir'),
  ('back707',   '01b159e2-bbbd-4151-b650-6c64780e782d', 'Nick Hettinger')
on conflict (login) do nothing;

-- Phase 5's branches panel reads this cache rather than GitHub on every open.
create table if not exists public.github_branches (
  name               text primary key,
  sha                text,
  ahead              int,                       -- vs pre-release
  behind             int,
  last_commit_at     timestamptz,
  last_commit_author text,
  pr_number          int,
  pr_state           text,
  ticket_id          bigint references public.dev_tickets (id) on delete set null,
  kind               text check (kind in ('ticket', 'release', 'base', 'untracked')),
  synced_at          timestamptz not null default now()
);
alter table public.github_branches enable row level security;

-- Every conversation with GitHub, in or out: webhook deliveries, the nightly
-- reconcile, the import, and (Phase 5/6) every write and who pressed it.
create table if not exists public.github_sync_log (
  id          bigserial primary key,
  kind        text not null check (kind in ('webhook', 'reconcile', 'import', 'write')),
  event       text,                             -- 'push', 'pull_request', 'create_tag', …
  delivery_id text,                             -- GitHub's X-GitHub-Delivery, to spot redeliveries
  ok          boolean not null default true,
  detail      jsonb,
  actor_name  text,
  actor_id    uuid,
  created_at  timestamptz not null default now()
);
alter table public.github_sync_log enable row level security;
create index if not exists github_sync_log_created_idx on public.github_sync_log (created_at desc);

-- ---- who may use it (D2) ---------------------------------------------------
-- dev-tracker defaults OFF for every role (FEATURE_CATALOG and the function's
-- DEFAULTS); these two user overrides are what switch it on. They are ordinary
-- Feature Access rows — visible, and revocable, in the Feature Access tool.
-- subject is the lower-cased name, as feature-access writes it.
insert into public.feature_overrides (feature_key, subject_type, subject, enabled, updated_by, updated_at) values
  ('dev-tracker', 'user', 'nick hettinger', true, 'migration 0187', now()),
  ('dev-tracker', 'user', 'ethan kushnir',  true, 'migration 0187', now())
on conflict (feature_key, subject_type, subject) do nothing;

-- The Claude connector reads through column grants it recomputes (0142).
select public.ai_reader_refresh_grants();
