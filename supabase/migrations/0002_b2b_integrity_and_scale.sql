-- ============================================================================
-- B2B: integrity constraints, a declined terminal state, and DB-side rollups.
--
-- The list endpoint was reading every deal AND every line item just to draw a
-- board, aggregating in JS. At thousands of items that is the bottleneck, so
-- the rollups move into a view (0003) and the function stops transferring
-- items it only wanted to sum.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

-- 1. Stage rank. Lets the state machine be expressed as CHECK constraints
--    instead of living only in the edge function. `declined` ranks 0 so a deal
--    that died early is exempt from every "must have X by now" rule.
create or replace function public.b2b_stage_rank(s text)
returns int language sql immutable parallel safe as $$
  select case s
    when 'declined'         then 0
    when 'pickup'           then 1
    when 'pricing_location' then 2
    when 'pricing'          then 3
    when 'quote'            then 4
    when 'listing_location' then 5
    when 'listing'          then 6
    when 'completed'        then 7
  end;
$$;

-- 2. Terminal state for a deal that dies. `cancelled` was a half-measure with
--    no audit trail; `declined` records who, when, why and under what heading
--    so the Overview can report on why deals are lost.
alter table public.b2b_deals drop constraint if exists b2b_deals_stage_check;
update public.b2b_deals set stage = 'declined' where stage = 'cancelled';

alter table public.b2b_deals rename column cancelled_reason to declined_reason;
alter table public.b2b_deals
  add column if not exists declined_at       timestamptz,
  add column if not exists declined_by       text,
  add column if not exists declined_category text;

alter table public.b2b_deals
  add constraint b2b_deals_stage_check check (stage in (
    'pickup', 'pricing_location', 'pricing', 'quote',
    'listing_location', 'listing', 'completed', 'declined'
  ));

alter table public.b2b_deals
  add constraint b2b_deals_declined_category_check check (
    declined_category is null or declined_category in (
      'client_declined', 'client_unresponsive', 'withdrawn', 'not_viable', 'other'
    )
  );

-- 3. The state machine, enforced by the database rather than by trust.
alter table public.b2b_deals
  add constraint b2b_deals_pickup_recorded check (
    public.b2b_stage_rank(stage) < 2
    or (signed_by is not null and signed_at is not null and pickup_date is not null)
  ),
  add constraint b2b_deals_pricing_located check (
    public.b2b_stage_rank(stage) < 3 or pricing_store is not null
  ),
  add constraint b2b_deals_listing_located check (
    public.b2b_stage_rank(stage) < 6
    or (listing_store is not null and accepted_at is not null)
  ),
  add constraint b2b_deals_declined_explained check (
    stage <> 'declined'
    or (declined_at is not null and length(btrim(coalesce(declined_reason, ''))) > 0)
  );

-- 4. Bounds. Unbounded text is how a table quietly becomes unqueryable, and a
--    fat-fingered quantity should fail loudly rather than skew every rollup.
alter table public.b2b_deals
  add constraint b2b_deals_deal_no_sane check (deal_no between 1 and 999999),
  add constraint b2b_deals_text_len check (
    length(coalesce(pickup_desc, ''))      <= 2000 and
    length(coalesce(signed_by, ''))        <= 120  and
    length(coalesce(delivered_by, ''))     <= 120  and
    length(coalesce(received_by, ''))      <= 120  and
    length(coalesce(priced_by, ''))        <= 120  and
    length(coalesce(created_by, ''))       <= 120  and
    length(coalesce(accepted_by, ''))      <= 120  and
    length(coalesce(declined_by, ''))      <= 120  and
    length(coalesce(declined_reason, ''))  <= 1000
  ),
  add constraint b2b_deals_send_count_sane check (quote_send_count between 0 and 1000);

alter table public.b2b_clients
  add constraint b2b_clients_text_len check (
    length(company)                        between 1 and 160 and
    length(coalesce(contact, ''))          <= 120 and
    length(coalesce(contact_email, ''))    <= 200 and
    length(coalesce(contact_phone, ''))    <= 40  and
    length(coalesce(notes, ''))            <= 2000
  ),
  add constraint b2b_clients_email_shape check (
    contact_email is null or contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  );

alter table public.b2b_deal_items
  add constraint b2b_deal_items_money_sane check (
    value >= 0 and offer >= 0 and (cost is null or cost >= 0)
    and value <= 9999999 and offer <= 9999999
  ),
  add constraint b2b_deal_items_qty_sane check (quantity between 1 and 100000),
  add constraint b2b_deal_items_line_no_sane check (line_no between 1 and 99999),
  add constraint b2b_deal_items_text_len check (
    length(coalesce(make, ''))         <= 120 and
    length(coalesce(model, ''))        <= 200 and
    length(coalesce(condition, ''))    <= 40  and
    length(coalesce(staff_notes, ''))  <= 1000 and
    length(coalesce(client_notes, '')) <= 1000
  ),
  -- A recycle-only line is scrap by definition: it must not carry money.
  add constraint b2b_deal_items_recycle_free check (
    not recycle_only or (value = 0 and offer = 0 and coalesce(cost, 0) = 0)
  );

-- 5. Timestamps by trigger, so a hand-written update can't skip them and leave
--    the "days in stage" clock lying.
create or replace function public.b2b_touch_row()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if tg_table_name = 'b2b_deals' and new.stage is distinct from old.stage then
    new.stage_changed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists b2b_deals_touch on public.b2b_deals;
create trigger b2b_deals_touch before update on public.b2b_deals
  for each row execute function public.b2b_touch_row();

drop trigger if exists b2b_clients_touch on public.b2b_clients;
create trigger b2b_clients_touch before update on public.b2b_clients
  for each row execute function public.b2b_touch_row();

-- 6. Indexes matching how the module actually reads.
--    The board wants open deals newest-first; the queue filters by store; the
--    archive is only ever the tail of the terminal deals.
drop index if exists public.b2b_deals_stage_idx;
create index if not exists b2b_deals_open_idx
  on public.b2b_deals (stage, created_at desc)
  where stage not in ('completed', 'declined');
create index if not exists b2b_deals_terminal_idx
  on public.b2b_deals (stage_changed_at desc)
  where stage in ('completed', 'declined');
create index if not exists b2b_deals_pricing_store_idx on public.b2b_deals (pricing_store);
create index if not exists b2b_deals_listing_store_idx on public.b2b_deals (listing_store);
create index if not exists b2b_deals_created_idx       on public.b2b_deals (created_at desc);
-- Covers the rollup's per-deal read without touching the heap.
create index if not exists b2b_deal_items_rollup_idx
  on public.b2b_deal_items (deal_id) include (quantity, value, offer, cost, recycle_only, listed_qty, recycled_qty);
