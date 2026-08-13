-- The gross-profit goal each store is carrying for a month.
--
-- ⚠️ NOT public.store_monthly_goals, which is a different thing and a dead one:
-- it holds REVENUE goals, was fed by the onEdit push that died in May 2026, and
-- is now read only by the hub's fallback path. This table holds the GP goal —
-- the one the Daily Breakdown's goal bar and the workbook's "GP Goal" cell mean
-- — and it is entered on SPEEKS, not scraped off the spreadsheet.
--
-- Direction of travel is deliberately site -> sheet. A goal is a decision, not a
-- measurement: it is made once a month by the DM, and both the gp-goals function
-- (immediately) and the month rollover (on the 1st) write it into the workbook
-- so the sheet's own formulas keep working.
create table if not exists public.monthly_gp_goals (
    id          bigserial primary key,
    store       text not null,
    ym          text not null check (ym ~ '^\d{4}-\d{2}$'),
    gp_goal     numeric not null check (gp_goal >= 0),
    set_by      text,
    set_at      timestamptz not null default now(),
    unique (store, ym)
);

create index if not exists monthly_gp_goals_ym_idx on public.monthly_gp_goals (ym);

-- Service role only, like every other table behind the edge functions.
alter table public.monthly_gp_goals enable row level security;

-- August 2026 as the sheet already had it, so the goal bars do not go blank
-- between this landing and the first month that is entered on the site.
insert into public.monthly_gp_goals (store, ym, gp_goal, set_by) values
('OVL','2026-08',77000,'seeded from the sheet'),
('LEE','2026-08',62000,'seeded from the sheet'),
('WSP','2026-08',80000,'seeded from the sheet'),
('MPL','2026-08',60000,'seeded from the sheet'),
('BAL','2026-08',53000,'seeded from the sheet')
on conflict (store, ym) do nothing;
