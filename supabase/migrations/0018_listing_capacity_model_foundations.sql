-- Applied 2026-08-10 as `listing_capacity_model_foundations`.
--
-- Foundations for the capacity-based listing goal model, replacing the headcount
-- ladder (±20/person anchored at 4 = 190) and the performance ratchet.
--
-- The model: a person's listing output is their SCHEDULED HOURS × the RATE of the
-- role they are in that day. Roles differ enormously — the person on the buy
-- counter is interrupted by every customer who walks in, a protected lister is
-- not — so hours alone say nothing. Capacity is the sum over everyone scheduled.
--
-- Capacity is a CEILING, not a forecast. The weekly goal is a fraction of it.
-- 0.75 is the starting factor because it reproduces the old ladder's 190 for a
-- 4-person store: the derivation changes, the number people see on day one does
-- not. See 0019 for how that held up against six weeks of real output.

-- ---------------------------------------------------------------------------
-- Staffing facts the model needs and the app has never held
-- ---------------------------------------------------------------------------
alter table public.users
  add column if not exists employment_type text
    not null default 'full_time'
    check (employment_type in ('full_time', 'part_time')),
  -- Home store stays in users.store. can_float means this person may be claimed
  -- by another store for a day. Deliberately NOT a new users.role value: role
  -- drives permission allow-lists across the whole app (KPI edit gates, Feature
  -- Access, tools panel, dashboard widgets) and a new value there would need
  -- every one of them audited — miss one and the person is silently locked out.
  add column if not exists can_float boolean not null default false,
  -- Needed for the new-hire ramp: someone in their first weeks lists at the
  -- new-hire rate even when assigned as a dedicated lister.
  add column if not exists hire_date date;

comment on column public.users.employment_type is
  'Drives weekly scheduled hours for the listing capacity model (see listing_config).';
comment on column public.users.can_float is
  'May be claimed by another store for a day (Zach M covers KC). Home store is users.store.';

-- ---------------------------------------------------------------------------
-- Every constant in one place. No admin UI by design (user, 2026-08-10) — these
-- are changed deliberately, with the reasoning written down, not tuned casually.
-- ---------------------------------------------------------------------------
create table if not exists public.listing_config (
  key         text primary key,
  value       numeric not null,
  note        text,
  updated_at  timestamptz not null default now()
);

insert into public.listing_config (key, value, note) values
  ('rate_buyer_1',        0.5,  'Line items/hr. Primary on the buy counter — takes every customer the moment they walk in, interrupted most, rarely finishes a listing.'),
  ('rate_buyer_2',        1.0,  'Line items/hr. Backup on the counter — only pulled in for a second customer, so has longer uninterrupted stretches.'),
  ('rate_lister',         3.0,  'Line items/hr. Scheduled to list and protected from other duties.'),
  ('rate_new_hire',       1.0,  'Line items/hr. Applies ONLY when a new hire is a dedicated lister; a new hire on the counter already uses the low buyer rates.'),
  ('new_hire_weeks',      2,    'Length of the new-hire ramp, in weeks from hire_date.'),
  ('hours_full_time',     40,   'Scheduled hours/week.'),
  ('hours_part_time',     20,   'Scheduled hours/week.'),
  ('days_off_full_time',  1,    'Store is open 6 days; a full-timer works 5 of them, staggered across the team.'),
  ('goal_factor',         0.75, 'Weekly goal = capacity x this.'),
  ('customer_time_source', 1,   'See 0019 — turned off there as a double-count.')
on conflict (key) do nothing;

alter table public.listing_config enable row level security;
-- Service role only, like the other config-shaped tables; the frontend reads it
-- through the edge function that computes goals.
create policy listing_config_service_only on public.listing_config
  for all to service_role using (true) with check (true);
