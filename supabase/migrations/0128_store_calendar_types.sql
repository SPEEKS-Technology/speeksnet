-- ============================================================================
-- store_calendar_categories — the Store Calendar's event types, now data the
-- DM manages instead of a list in code.
--
-- WHY. Ethan, 2026-10-01: "make a bunch of categories that almost anything can
-- fit into and only give DM access to remove or add categories", and capitalize
-- the first letter of each word. The 18 seeded here cover everything the old
-- Google calendar held (0126) plus the obvious neighbours, so a store rarely
-- has to reach for Other. The first eight are Ethan's names, word for word.
--
-- KEYS NEVER CHANGE. store_calendar_events.category holds the key, and the
-- keys below are the ones 0125/0126 already wrote, so no event moves. A type
-- the DM adds gets a key made from its name at the time; renaming would only
-- touch label.
--
-- REMOVING IS A SOFT DELETE (active = false). The type leaves the dropdowns,
-- but the events already filed under it keep their name and colour, so taking
-- a type away can never turn old events into unlabelled grey dots.
--
-- Who may add or remove: the district manager role ONLY, enforced in the
-- store-calendar edge function from the PIN (not CEO, not MOCD — Ethan's words
-- were "only give DM access"). Everyone reads them.
--
-- RLS on, no policy: the house pattern (0102, 0108, 0125).
-- ============================================================================

create table if not exists public.store_calendar_categories (
  key         text primary key check (key ~ '^[a-z0-9_]{1,40}$'),
  label       text not null check (length(trim(label)) between 1 and 40),
  color       text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  sort        integer not null default 100,
  active      boolean not null default true,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.store_calendar_categories enable row level security;

insert into public.store_calendar_categories (key, label, color, sort, created_by) values
  ('meeting',     'Meetings',             '#2563eb',  10, 'seed'),
  ('hours',       'Holiday/Hour Changes', '#dc2626',  20, 'seed'),
  ('payday',      'Pay Day',              '#16a34a',  30, 'seed'),
  ('celebration', 'Birthday/Anniversary', '#db2777',  40, 'seed'),
  ('staffing',    'Staffing/PTO',         '#7c3aed',  50, 'seed'),
  ('travel',      'Travel',               '#0d9488',  60, 'seed'),
  ('community',   'Events',               '#65a30d',  70, 'seed'),
  ('delivery',    'B2B Pickups',          '#64748b',  80, 'seed'),
  ('recycling',   'Recycling Pickups',    '#ca8a04',  90, 'seed'),
  ('inventory',   'Inventory',            '#b45309', 100, 'seed'),
  ('promo',       'Promotions',           '#ea580c', 110, 'seed'),
  ('training',    'Training',             '#0284c7', 120, 'seed'),
  ('opening',     'Store Opening',        '#9f1239', 130, 'seed'),
  ('maintenance', 'Maintenance/Repairs',  '#334155', 140, 'seed'),
  ('shipment',    'Deliveries',           '#c026d3', 150, 'seed'),
  ('audit',       'Audits/Inspections',   '#0891b2', 160, 'seed'),
  ('deadline',    'Deadlines',            '#78350f', 170, 'seed'),
  ('other',       'Other',                '#94a3b8', 999, 'seed')
on conflict (key) do nothing;
