-- ============================================================================
-- Client outreach scheduling -- the "mini CRM" half of B2B.
--
-- Cadence is "every N months from a set date", so the schedule is anchored to
-- the date the CEO chose rather than drifting forward from whenever the last
-- email happened to go out.
--
-- Two clocks, deliberately separate:
--   outreach_last_touch_at   when we actually reached out. This is what moves
--                            the schedule on.
--   outreach_reminded_for    the due date we last sent a reminder about. Stops
--                            the daily job nagging every morning about the same
--                            occurrence, without letting the reminder itself
--                            count as having reached out -- which would advance
--                            the schedule and produce exactly one reminder ever.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

alter table public.b2b_clients
  add column if not exists outreach_active        boolean not null default false,
  add column if not exists outreach_start         date,
  add column if not exists outreach_months        int,
  add column if not exists outreach_note          text,
  add column if not exists outreach_last_touch_at timestamptz,
  add column if not exists outreach_reminded_for  date;

alter table public.b2b_clients drop constraint if exists b2b_clients_outreach_months_sane;
alter table public.b2b_clients add constraint b2b_clients_outreach_months_sane
  check (outreach_months is null or outreach_months between 1 and 60);

-- A schedule that is on but has no schedule is the one state that would make the
-- daily job guess.
alter table public.b2b_clients drop constraint if exists b2b_clients_outreach_complete;
alter table public.b2b_clients add constraint b2b_clients_outreach_complete
  check (not outreach_active or (outreach_start is not null and outreach_months is not null));

-- The next occurrence in the series start, start+N, start+2N, ... that falls
-- after the last time we reached out.
--
-- No day-of-month adjustment on purpose: counting whole months elapsed means a
-- touch logged a few days EARLY still counts for that period. The alternative
-- rounds the other way and re-fires days later, and a duplicate "just checking
-- in" to a real client costs more than an outreach landing a week early.
create or replace function public.b2b_outreach_next(start_on date, every_months int, last_on date)
returns date language sql immutable parallel safe as $$
  select case
    when start_on is null or every_months is null or every_months < 1 then null
    when last_on is null or last_on < start_on then start_on
    else (start_on + make_interval(months => every_months * ((
           (extract(year from last_on) - extract(year from start_on))::int * 12
         + (extract(month from last_on) - extract(month from start_on))::int
         ) / every_months + 1)))::date
  end;
$$;

-- What went out, so the automation can be audited rather than trusted.
create table if not exists public.b2b_outreach_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.b2b_clients(id) on delete cascade,
  kind text not null check (kind in ('reminder', 'touch')),
  due_on date,
  sent_to text,
  ok boolean not null default true,
  detail text,
  logged_by text,
  created_at timestamptz not null default now()
);
create index if not exists b2b_outreach_log_client_idx on public.b2b_outreach_log (client_id, created_at desc);
create index if not exists b2b_outreach_log_kind_idx   on public.b2b_outreach_log (kind, created_at desc);

alter table public.b2b_outreach_log enable row level security;

-- Rebuilt rather than replaced: the new b2b_clients columns land inside `c.*`,
-- which reorders the view's columns, and `create or replace view` refuses that.
drop view if exists public.b2b_client_list;

create view public.b2b_client_list
with (security_invoker = true) as
select
  c.*,
  coalesce(d.deal_count, 0)      as deal_count,
  coalesce(d.open_count, 0)      as open_count,
  coalesce(d.completed_count, 0) as completed_count,
  coalesce(d.declined_count, 0)  as declined_count,
  coalesce(d.lifetime_cost, 0)   as lifetime_cost,
  coalesce(d.lifetime_units, 0)  as lifetime_units,
  d.first_deal_at,
  d.last_deal_at,
  public.b2b_outreach_next(
    c.outreach_start, c.outreach_months, c.outreach_last_touch_at::date
  ) as outreach_next_due
from public.b2b_clients c
left join lateral (
  select
    count(*)                                                        as deal_count,
    count(*) filter (where x.stage not in ('completed', 'declined')) as open_count,
    count(*) filter (where x.stage = 'completed')                    as completed_count,
    count(*) filter (where x.stage = 'declined')                     as declined_count,
    min(x.created_at)                                                as first_deal_at,
    max(x.created_at)                                                as last_deal_at,
    -- Only completed deals count towards spend: an offer is not money until
    -- the client accepts and it freezes into cost.
    sum(case when x.stage = 'completed' then coalesce(t.cost,  0) else 0 end) as lifetime_cost,
    sum(case when x.stage = 'completed' then coalesce(t.units, 0) else 0 end) as lifetime_units
  from public.b2b_deals x
  left join lateral (
    select
      sum(case when i.recycle_only then 0 else coalesce(i.cost, 0) * i.quantity end) as cost,
      sum(i.listed_qty + i.recycled_qty)                                             as units
    from public.b2b_deal_items i
    where i.deal_id = x.id
  ) t on true
  where x.client_id = c.id
) d on true;

revoke all on public.b2b_client_list from anon, authenticated;
