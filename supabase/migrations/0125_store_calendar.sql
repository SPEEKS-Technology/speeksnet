-- ============================================================================
-- store_calendar_events — the Store Calendar, replacing the Google Calendar
-- embed that every page's calendar button used to open.
--
-- WHY. The embed was one shared Google calendar: every store saw every store's
-- entries, nobody but the DM could add to it, and it only rendered for someone
-- signed in to a Google account with access to it (an anonymous fetch of the
-- embed is a 401). The ask (Ethan, 2026-10-01): each store gets its own calendar
-- its manager fills out on SPEEKSNET, and the DM posts company events that show
-- on every store's calendar at once.
--
-- ONE TABLE, TWO KINDS OF ROW, told apart by scope:
--   scope = 'store'    store is the one store it belongs to; stores is null.
--                      Written by that store's manager (or the MSM for BAL/MPL).
--   scope = 'company'  store is null; stores is the list of stores it shows on.
--                      Written by the DM / CEO / MOCD. A company event posted to
--                      all five stores is still ONE row — editing it edits it
--                      everywhere, which is the point of posting it company-wide.
-- The check constraint holds the two shapes apart so a half-and-half row (a
-- store event with a store list, a company event with no stores) can't exist.
--
-- WHO MAY WRITE is decided in the store-calendar edge function from the
-- writer's PIN, not from anything the browser says about itself — the same
-- rule store-comments uses for its "from your Manager" wording. created_by is
-- the resolved name, kept for display only (see CLAUDE.md, Identity).
--
-- end_date is inclusive and optional (null = a one-day event). start_time and
-- end_time are only meaningful when all_day is false. repeats_yearly is expanded
-- by the client for whichever month it is showing; the row keeps its first date.
--
-- source = 'google' marks rows carried over from the old Google calendar, so the
-- import can be re-run (delete where source = 'google', insert again) without
-- touching anything a manager has entered since.
--
-- RLS on, no policy: the house pattern (0102, 0108). anon holds full grants on
-- public, so without it the anon key in speeks.js could read and rewrite this.
-- The edge function comes in on the service role.
-- ============================================================================

create table if not exists public.store_calendar_events (
  id              uuid primary key default gen_random_uuid(),
  scope           text not null check (scope in ('store', 'company')),
  store           text,
  stores          text[],
  title           text not null check (length(trim(title)) > 0),
  event_date      date not null,
  end_date        date,
  all_day         boolean not null default true,
  start_time      time,
  end_time        time,
  category        text not null default 'other',
  notes           text,
  repeats_yearly  boolean not null default false,
  source          text not null default 'manual',
  created_by      text,
  updated_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint store_calendar_shape check (
    (scope = 'store'   and store is not null and stores is null) or
    (scope = 'company' and store is null and stores is not null and cardinality(stores) > 0)
  ),
  constraint store_calendar_end_after_start check (end_date is null or end_date >= event_date)
);

create index if not exists store_calendar_events_date_idx  on public.store_calendar_events (event_date);
create index if not exists store_calendar_events_store_idx on public.store_calendar_events (store) where scope = 'store';

alter table public.store_calendar_events enable row level security;
