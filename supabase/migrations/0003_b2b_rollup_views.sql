-- ============================================================================
-- Rollups computed in Postgres instead of by shipping every line item to the
-- edge function and summing them in JS. One indexed pass per deal, and the
-- board stops transferring thousands of rows it only wanted totals from.
--
-- security_invoker so the base tables' RLS still applies: they are locked with
-- no policies, so anon gets nothing through PostgREST and only the
-- service-role edge function can read them.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

create or replace view public.b2b_deal_list
with (security_invoker = true) as
select
  d.id, d.client_id, d.deal_no, d.stage,
  d.pickup_desc, d.signed_by, d.signed_at, d.pickup_date,
  d.pricing_store, d.listing_store, d.delivered_by, d.received_by,
  d.priced_by, d.quote_sent_at, d.quote_send_count,
  d.accepted_at, d.accepted_by,
  d.declined_at, d.declined_by, d.declined_reason, d.declined_category,
  d.created_by, d.created_at, d.updated_at, d.stage_changed_at,

  c.company, c.acronym, c.contact, c.contact_email, c.contact_phone,
  c.acronym || '-' || lpad(d.deal_no::text, 3, '0')        as ref,
  public.b2b_stage_rank(d.stage)                            as stage_rank,
  (d.stage in ('completed', 'declined'))                    as is_terminal,

  coalesce(r.line_count, 0)                                 as line_count,
  coalesce(r.total_units, 0)                                as total_units,
  coalesce(r.listed_units, 0)                               as listed_units,
  coalesce(r.recycled_units, 0)                             as recycled_units,
  coalesce(r.outstanding_units, 0)                          as outstanding_units,
  coalesce(r.total_value, 0)                                as total_value,
  coalesce(r.total_offer, 0)                                as total_offer,
  coalesce(r.total_cost, 0)                                 as total_cost
from public.b2b_deals d
join public.b2b_clients c on c.id = d.client_id
left join lateral (
  select
    count(*)                                                          as line_count,
    sum(i.quantity)                                                   as total_units,
    sum(i.listed_qty)                                                 as listed_units,
    sum(i.recycled_qty)                                               as recycled_units,
    sum(greatest(i.quantity - i.listed_qty - i.recycled_qty, 0))      as outstanding_units,
    sum(case when i.recycle_only then 0 else i.value * i.quantity end)          as total_value,
    sum(case when i.recycle_only then 0 else i.offer * i.quantity end)          as total_offer,
    sum(case when i.recycle_only then 0 else coalesce(i.cost, 0) * i.quantity end) as total_cost
  from public.b2b_deal_items i
  where i.deal_id = d.id
) r on true;

create or replace view public.b2b_client_list
with (security_invoker = true) as
select
  c.*,
  coalesce(d.deal_count, 0) as deal_count,
  coalesce(d.open_count, 0) as open_count,
  d.last_deal_at
from public.b2b_clients c
left join lateral (
  select count(*) as deal_count,
         count(*) filter (where stage not in ('completed', 'declined')) as open_count,
         max(created_at) as last_deal_at
  from public.b2b_deals x where x.client_id = c.id
) d on true;

-- Belt and braces on top of RLS: nothing anonymous should reach these at all.
revoke all on public.b2b_deal_list   from anon, authenticated;
revoke all on public.b2b_client_list from anon, authenticated;
