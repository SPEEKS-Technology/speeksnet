-- ============================================================================
-- Coaching notes on the Weekly / Monthly KPI grid.
--
-- One note per store per period — NOT one per employee. A manager reviewing the
-- week writes "Jake's device conversion is slipping, and the whole floor is slow
-- on Saturdays" as one thought; splitting that across employee rows would force
-- them to decide which person a floor-wide observation belongs to before they
-- can write it down.
--
-- Its own table rather than a column on kpi_entries, because kpi_entries is one
-- row PER EMPLOYEE per period. A note stored there would either duplicate across
-- every employee row or arbitrarily live on one of them, and it could only exist
-- for a period that already has saved numbers.
--
-- Two things that deliberately differ from kpi_entries:
--
--   * NO PERIOD LOCK. Numbers lock the moment the period closes, because a
--     changed number rewrites history that reports have already gone out on. A
--     note is the opposite: coaching happens the week AFTER the numbers land, so
--     the note has to be writable exactly when the numbers no longer are. The
--     edge function enforces the lock on numbers and skips it for notes.
--
--   * A note can exist for a period with no saved KPI rows at all. "Nobody
--     filled these in and here's why" is worth recording.
--
-- Access is split, and the split is the point:
--
--   READ   — same gate as the KPIs themselves (canEnterKPIs): store leadership
--            plus corp. A DM can read a store's notes.
--   WRITE  — store management only (canEditNotes): manager, owner-manager, and a
--            multi-store manager for the stores they oversee. Not the DM, not
--            the CEO, not assistant managers.
--
-- The numbers are a shared record, so corp editing them is legitimate. A note is
-- the store manager's own prep for a conversation with their team — someone above
-- them editing it would be rewriting what that manager plans to say. `updated_by`
-- is therefore always a store manager.
--
-- RLS is on with no policies, matching every other table here — reads and writes
-- go exclusively through the service-role edge function, which is where both
-- gates live.
-- ============================================================================

create table if not exists public.kpi_notes (
  id uuid primary key default gen_random_uuid(),
  store           text not null,
  period_type     text not null check (period_type in ('weekly', 'monthly')),
  period_end_date date not null,
  note            text,
  -- Who last touched it, so a note found six weeks later has an author to ask.
  -- Name, not PIN: this is displayed, and kpi_entries.submitted_by already
  -- stores a PIN that nothing can render.
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- One note per period per store — the upsert target.
  constraint kpi_notes_period_uniq unique (store, period_type, period_end_date),
  -- Long enough for a real set of observations, bounded so a paste can't put
  -- an unbounded blob in every GET of the grid.
  constraint kpi_notes_len check (length(coalesce(note, '')) <= 4000)
);

-- Every read is "the notes for this store and period type", matching the grid's
-- own query shape.
create index if not exists kpi_notes_lookup_idx
  on public.kpi_notes (store, period_type, period_end_date desc);

alter table public.kpi_notes enable row level security;

comment on table public.kpi_notes is
  'Manager coaching notes attached to a KPI period. One per store per period. Unlike kpi_entries these stay editable after the period locks — coaching happens after the numbers are in.';
