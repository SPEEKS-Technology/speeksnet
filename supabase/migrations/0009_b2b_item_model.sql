-- ============================================================================
-- Richer line items: types + specs, per-unit serials, a three-way disposition,
-- certified data wipes, and a send-back message on the deal.
--
-- Applied to EMPTY tables -- every B2B client and deal was test data and was
-- deleted first -- so there is no backfill anywhere below and `recycle_only` is
-- simply dropped rather than migrated.
--
-- Four things worth knowing before reading:
--
--   * disposition replaces recycle_only, which conflated two different
--     outcomes. `recycle` is scrap we dispose of. `no_residual` is worth
--     nothing to the CLIENT but may still be worth something to US -- so it
--     keeps its `value` and can be listed for resale. That distinction is the
--     entire reason the boolean had to go.
--
--   * serials is one comma-separated column, not a row per unit. A qty-5 line
--     stays one row. Spreading quantity out into unit rows was considered and
--     rejected: it would double the row count of the biggest table to hold one
--     short string per unit.
--
--   * wipe_fee is SNAPSHOTTED onto the item when the flag is set, not read live
--     from settings. Otherwise changing the global fee would silently rewrite
--     the price on a quote the client has already seen.
--
--   * both views have to be dropped and rebuilt, not replaced: they read
--     i.recycle_only, so the column cannot be dropped while they exist, and
--     `create or replace view` cannot reorder or retype columns anyway.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

drop view if exists public.b2b_deal_list;
drop view if exists public.b2b_client_list;

-- ---------------------------------------------------------------- line items

alter table public.b2b_deal_items
  add column if not exists item_type text not null default 'other'
      check (item_type in ('laptop', 'desktop', 'other')),
  add column if not exists cpu            text,
  add column if not exists ram            text,
  add column if not exists storage        text,
  add column if not exists gpu            text,
  add column if not exists battery_health text,
  add column if not exists serials        text,
  add column if not exists disposition text not null default 'purchase'
      check (disposition in ('purchase', 'no_residual', 'recycle')),
  add column if not exists wipe_required boolean not null default false,
  add column if not exists wipe_fee  numeric(12,2) not null default 0,
  add column if not exists wiped_qty int not null default 0 check (wiped_qty >= 0);

alter table public.b2b_deal_items drop column if exists recycle_only;

alter table public.b2b_deal_items drop constraint if exists b2b_deal_items_recycle_free;

-- Only a purchase carries money to the client. Both other dispositions are free
-- to them, so offer (and the cost it freezes into) must be zero.
alter table public.b2b_deal_items add constraint b2b_deal_items_offer_by_disposition check (
  disposition = 'purchase' or (offer = 0 and coalesce(cost, 0) = 0)
);

-- Recycle is scrap, so it has no resale value either. no_residual keeps its
-- value -- that is what separates the two.
alter table public.b2b_deal_items add constraint b2b_deal_items_recycle_worthless check (
  disposition <> 'recycle' or value = 0
);

-- Specs belong to the type that has them, so a type change can never leave a
-- stale CPU on a line that is now a box of cables. The edge function nulls them
-- explicitly; this is the backstop.
alter table public.b2b_deal_items add constraint b2b_deal_items_specs_fit_type check (
  (item_type <> 'other' or (cpu is null and ram is null and storage is null
                            and gpu is null and battery_health is null))
  and (item_type <> 'desktop' or battery_health is null)
);

alter table public.b2b_deal_items add constraint b2b_deal_items_wipe_sane check (
  wiped_qty <= quantity and (wipe_required or wipe_fee = 0) and wipe_fee <= 9999999
);

-- Extends the existing length guard to the new text columns rather than adding
-- a second constraint that would report a different name for the same class of
-- mistake. serials holds one entry per unit, so it needs real headroom.
alter table public.b2b_deal_items drop constraint if exists b2b_deal_items_text_len;
alter table public.b2b_deal_items add constraint b2b_deal_items_text_len check (
  length(coalesce(make, ''))           <= 120  and
  length(coalesce(model, ''))          <= 200  and
  length(coalesce(condition, ''))      <= 40   and
  length(coalesce(staff_notes, ''))    <= 1000 and
  length(coalesce(client_notes, ''))   <= 1000 and
  length(coalesce(cpu, ''))            <= 60   and
  length(coalesce(ram, ''))            <= 60   and
  length(coalesce(storage, ''))        <= 60   and
  length(coalesce(gpu, ''))            <= 60   and
  length(coalesce(battery_health, '')) <= 60   and
  length(coalesce(serials, ''))        <= 4000
);

-- The rollup lateral reads these columns for every line on every board draw.
drop index if exists public.b2b_deal_items_rollup_idx;
create index b2b_deal_items_rollup_idx on public.b2b_deal_items (deal_id)
  include (quantity, value, offer, cost, disposition, listed_qty, recycled_qty,
           wipe_required, wipe_fee, wiped_qty);

-- --------------------------------------------------------- send-back message

alter table public.b2b_deals
  add column if not exists sendback_note text,
  add column if not exists sendback_by   text,
  add column if not exists sendback_at   timestamptz;

alter table public.b2b_deals drop constraint if exists b2b_deals_sendback_len;
alter table public.b2b_deals add constraint b2b_deals_sendback_len check (
  length(coalesce(sendback_note, '')) <= 2000
);

-- ------------------------------------------------------------------ settings

alter table public.b2b_crm_settings
  add column if not exists wipe_fee numeric(12,2) not null default 8
      check (wipe_fee >= 0 and wipe_fee <= 9999999),
  add column if not exists quote_ready_enabled boolean not null default true;

-- ---------------------------------------------------------------- deal rollup

create view public.b2b_deal_list
with (security_invoker = true) as
select
  d.*,
  c.company, c.acronym, c.contact, c.contact_email, c.contact_phone,
  c.acronym || '-' || lpad(d.deal_no::text, 3, '0')        as ref,
  public.b2b_stage_rank(d.stage)                            as stage_rank,
  (d.stage in ('completed', 'declined'))                    as is_terminal,

  coalesce(r.line_count, 0)                                 as line_count,
  coalesce(r.total_units, 0)                                as total_units,
  coalesce(r.listed_units, 0)                               as listed_units,
  coalesce(r.recycled_units, 0)                             as recycled_units,
  coalesce(r.wiped_units, 0)                                as wiped_units,
  coalesce(r.outstanding_units, 0)                          as outstanding_units,
  coalesce(r.total_value, 0)                                as total_value,
  coalesce(r.total_offer, 0)                                as total_offer,
  coalesce(r.total_cost, 0)                                 as total_cost,
  coalesce(r.total_wipe_fee, 0)                             as total_wipe_fee,
  -- What we actually pay: the offer less the certified-wipe charge, clamped so
  -- a deal can never come out negative. Computed here, once, so the board, the
  -- quote screen and the client's email cannot disagree about the number.
  greatest(coalesce(r.total_offer, 0) - coalesce(r.total_wipe_fee, 0), 0) as net_offer
from public.b2b_deals d
join public.b2b_clients c on c.id = d.client_id
left join lateral (
  select
    count(*)                                                          as line_count,
    sum(i.quantity)                                                   as total_units,
    sum(i.listed_qty)                                                 as listed_units,
    sum(i.recycled_qty)                                               as recycled_units,
    sum(i.wiped_qty)                                                  as wiped_units,
    sum(greatest(i.quantity - i.listed_qty - i.recycled_qty, 0))      as outstanding_units,
    -- Only recycle is worthless to us. no_residual is free to the client but
    -- still carries resale value, so it belongs in total_value.
    sum(case when i.disposition = 'recycle' then 0 else i.value * i.quantity end) as total_value,
    -- No CASE needed on the money we pay: the disposition CHECK already forces
    -- offer and cost to zero on anything that is not a purchase.
    sum(i.offer * i.quantity)                                         as total_offer,
    sum(coalesce(i.cost, 0) * i.quantity)                             as total_cost,
    sum(case when i.wipe_required then i.wipe_fee * i.quantity else 0 end) as total_wipe_fee
  from public.b2b_deal_items i
  where i.deal_id = d.id
) r on true;

-- -------------------------------------------------------------- client rollup

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
  public.b2b_outreach_next_u(
    c.outreach_start, c.outreach_every, c.outreach_unit, c.outreach_last_touch_at::date
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
    -- the client accepts and it freezes into cost. Net of wipe charges, since
    -- that is what actually left the bank.
    sum(case when x.stage = 'completed' then coalesce(t.net, 0) else 0 end)   as lifetime_cost,
    sum(case when x.stage = 'completed' then coalesce(t.units, 0) else 0 end) as lifetime_units
  from public.b2b_deals x
  left join lateral (
    select
      greatest(
        sum(coalesce(i.cost, 0) * i.quantity)
        - sum(case when i.wipe_required then i.wipe_fee * i.quantity else 0 end), 0
      )                                     as net,
      sum(i.listed_qty + i.recycled_qty)    as units
    from public.b2b_deal_items i
    where i.deal_id = x.id
  ) t on true
  where x.client_id = c.id
) d on true;

revoke all on public.b2b_deal_list   from anon, authenticated;
revoke all on public.b2b_client_list from anon, authenticated;
