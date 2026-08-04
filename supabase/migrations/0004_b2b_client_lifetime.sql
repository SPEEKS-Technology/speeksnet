-- ============================================================================
-- Lifetime-per-client rollups for the Clients drill-down.
--
-- The board payload only carries open deals plus the recent tail of finished
-- ones, so summing a client's history in the browser would quietly undercount
-- the moment they had more deals than the archive window. These come from the
-- whole table instead, so "all time" means all time.
--
-- New columns are APPENDED after last_deal_at on purpose: `create or replace
-- view` refuses to reorder or rename existing columns, and inserting them in
-- the middle would force a drop/recreate.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

create or replace view public.b2b_client_list
with (security_invoker = true) as
select
  c.*,
  coalesce(d.deal_count, 0) as deal_count,
  coalesce(d.open_count, 0) as open_count,
  d.last_deal_at,
  coalesce(d.completed_count, 0) as completed_count,
  coalesce(d.declined_count, 0)  as declined_count,
  coalesce(d.lifetime_cost, 0)   as lifetime_cost,
  coalesce(d.lifetime_units, 0)  as lifetime_units,
  d.first_deal_at
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
