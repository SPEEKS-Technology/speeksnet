-- ============================================================================
-- Pre-evaluations: pricing a client's list BEFORE we go and collect it.
--
-- A company rings up with "what would you give us for 40 laptops and a pallet of
-- monitors". Today the only way to answer is to create a deal, which means
-- signing off a pickup that has not happened, for goods we do not have. So the
-- quote either never gets recorded at all, or it gets recorded as a fiction.
--
-- A pre-evaluation is the pricing half on its own: a dated, per-client document
-- of what we would pay for a described list. If the client accepts, it converts
-- into a real deal with every line already filled in, and the deal carries a
-- reference back to the evaluation it came from.
--
-- ---------------------------------------------------------------------------
-- Why its own tables rather than a `preval` stage on b2b_deals
--
-- Adding a stage would inherit the whole pricing screen for free, which is the
-- obvious shortcut. Three things kill it:
--
--   1. deal_no is a per-client counter that mints the ref AND leads every SKU we
--      print. A pre-evaluation that never converts -- and most will not -- would
--      burn ACM-003 forever and leave a hole in that client's numbering.
--
--   2. Stage rank. `preval` has to sort below `pickup` (1) and above `declined`
--      (0), and there is no integer between them. Renumbering is precisely what
--      0018 documents at length as the dangerous part: three CHECK constraints
--      read those ranks, and b2b_stage_rank() returns NULL for an unknown stage,
--      which a CHECK treats as satisfied. Getting it wrong disables the
--      integrity constraints silently rather than failing loudly.
--
--   3. Every rollup counts deals. open_count, lifetime spend, the board, the
--      queue, the Overview -- all of them would begin counting enquiries as
--      business we have won.
--
-- So: two new tables, and a nullable FK on the deal pointing back at its origin.
--
-- ---------------------------------------------------------------------------
-- Why conversion is a SQL function and not edge-function JavaScript
--
-- Converting means: insert a deal, insert N line items with freshly minted SKUs,
-- and flip the evaluation to `converted`. supabase-js offers no transaction
-- across calls, so done in JS a failure halfway through leaves either a deal
-- with no lines or an evaluation that can be converted a second time.
-- b2b_preval_to_deal() does the lot in one block behind a row lock, so it either
-- all happens or none of it does.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

-- ------------------------------------------------------------- evaluations
create table if not exists public.b2b_prevals (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.b2b_clients(id) on delete restrict,
  -- Per-client counter, rendered ACM-PE-001. Its own sequence and its own infix
  -- on purpose: an evaluation and a deal for the same client must never be
  -- mistakable for one another on a printout or in an email.
  eval_no    int  not null,

  status text not null default 'draft' check (status in (
    'draft',      -- being priced
    'sent',       -- out with the client
    'accepted',   -- they said yes; the lines freeze here
    'converted',  -- became a deal; terminal
    'declined'    -- terminal
  )),

  -- "documented for a given client from a given date". The date the figures are
  -- good as of -- deliberately not created_at, because an evaluation is often
  -- entered days after the conversation that prompted it.
  eval_date   date not null default ((now() at time zone 'America/Chicago')::date),
  -- Optional. Expiry is DERIVED from this in the UI rather than being a status:
  -- a status would need a cron to maintain and would then have to fight with
  -- `accepted` over which one a row is really in.
  valid_until date,

  title    text,   -- short label, e.g. "Q3 laptop refresh"
  summary  text,   -- what the client says they have; becomes the deal's pickup_desc
  notes    text,   -- internal

  -- The store that raised it, or null for corp. Same job pricing_store does on a
  -- store-origin deal: it scopes the list to the people whose enquiry it is. An
  -- evaluation has no goods yet, so this is ownership of the conversation, not a
  -- claim about where anything physically sits.
  store text check (store in ('OVL','LEE','WSP','MPL','BAL')),

  created_by   text,
  evaluated_by text,
  sent_at      timestamptz, sent_by      text,
  accepted_at  timestamptz, accepted_by  text,
  declined_at  timestamptz, declined_by  text, declined_reason text,
  converted_at timestamptz, converted_by text,
  converted_deal_id uuid references public.b2b_deals(id) on delete set null,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),

  unique (client_id, eval_no),
  constraint b2b_prevals_text_len check (
    length(coalesce(title,   '')) <= 160  and
    length(coalesce(summary, '')) <= 4000 and
    length(coalesce(notes,   '')) <= 4000 and
    length(coalesce(declined_reason, '')) <= 1000),
  -- A window that closes before it opens is a typo, and it would render as
  -- expired the moment it was saved.
  constraint b2b_prevals_window_sane check (
    valid_until is null or valid_until >= eval_date),
  -- Converted means there is a deal to point at. Enforced because the entire
  -- feature rests on being able to follow that link, and a converted row without
  -- one is a dead end nobody can diagnose later.
  constraint b2b_prevals_converted_has_deal check (
    status <> 'converted'
    or (converted_deal_id is not null and converted_at is not null))
);

create index if not exists b2b_prevals_client_idx on public.b2b_prevals (client_id);
create index if not exists b2b_prevals_status_idx on public.b2b_prevals (status);
create index if not exists b2b_prevals_store_idx  on public.b2b_prevals (store);

-- ------------------------------------------------------------------ lines
-- Everything a deal item has MINUS sku, serials, cost, and the listed/recycled/
-- wiped counters. Not an oversight: we have not seen these units. There is
-- nothing to serialise, nothing to label, and no progress to count against.
--
-- The CHECK set otherwise mirrors b2b_deal_items exactly, so a line cannot be
-- valid here and then rejected the moment it converts -- which would strand an
-- accepted evaluation with no way forward.
create table if not exists public.b2b_preval_items (
  id         uuid primary key default gen_random_uuid(),
  preval_id  uuid not null references public.b2b_prevals(id) on delete cascade,
  line_no    int  not null,
  sort_order int  not null default 0,

  make         text,
  model        text,
  condition    text,
  staff_notes  text,
  client_notes text,

  quantity      int           not null default 1,
  value         numeric(12,2) not null default 0,
  offer         numeric(12,2) not null default 0,
  shipping_cost numeric(12,2) not null default 0,

  item_type text not null default 'other'
    check (item_type in ('computer','laptop','desktop','other')),
  cpu text, ram text, storage text, gpu text, battery_health text,

  disposition text not null default 'purchase'
    check (disposition in ('purchase','no_residual','recycle')),
  wipe_required boolean       not null default false,
  wipe_fee      numeric(12,2) not null default 0,

  created_at timestamptz not null default now(),

  unique (preval_id, line_no),
  constraint b2b_preval_items_line_no_sane check (line_no >= 1 and line_no <= 99999),
  constraint b2b_preval_items_qty_sane     check (quantity >= 1 and quantity <= 100000),
  constraint b2b_preval_items_money_sane   check (
    value >= 0 and offer >= 0 and value <= 9999999 and offer <= 9999999
    and shipping_cost >= 0 and shipping_cost <= 9999999),
  constraint b2b_preval_items_offer_by_disposition check (
    disposition = 'purchase' or offer = 0),
  constraint b2b_preval_items_recycle_worthless check (
    disposition <> 'recycle' or value = 0),
  constraint b2b_preval_items_wipe_sane check (
    (wipe_required or wipe_fee = 0) and wipe_fee <= 9999999),
  constraint b2b_preval_items_specs_fit_type check (
    (item_type <> 'other'
     or (cpu is null and ram is null and storage is null
         and gpu is null and battery_health is null))
    and (item_type <> 'desktop' or battery_health is null)),
  constraint b2b_preval_items_text_len check (
    length(coalesce(make,  '')) <= 120 and length(coalesce(model, '')) <= 200 and
    length(coalesce(condition, '')) <= 40 and
    length(coalesce(staff_notes,  '')) <= 1000 and
    length(coalesce(client_notes, '')) <= 1000 and
    length(coalesce(cpu, '')) <= 60 and length(coalesce(ram, '')) <= 60 and
    length(coalesce(storage, '')) <= 60 and length(coalesce(gpu, '')) <= 60 and
    length(coalesce(battery_health, '')) <= 60)
);

create index if not exists b2b_preval_items_preval_idx on public.b2b_preval_items (preval_id);

-- ---------------------------------------------------- the link on the deal
alter table public.b2b_deals
  add column if not exists preval_id uuid references public.b2b_prevals(id) on delete set null;

create index if not exists b2b_deals_preval_idx on public.b2b_deals (preval_id);

-- ----------------------------------------------------------------- trigger
-- Same shared function the deals and clients triggers use. The nesting is not
-- style: 0007 fixed a crash caused by writing `tg_table_name = 'x' and new.y`,
-- because PL/pgSQL hands the whole condition to the executor at once and NEW.y
-- has to resolve against the real row type before the table-name test can rule
-- it out. `and` does not short-circuit here.
create or replace function public.b2b_touch_row()
returns trigger language plpgsql as $fn$
begin
  new.updated_at := now();
  if tg_table_name = 'b2b_deals' then
    if new.stage is distinct from old.stage then
      new.stage_changed_at := now();
    end if;
  elsif tg_table_name = 'b2b_prevals' then
    if new.status is distinct from old.status then
      new.status_changed_at := now();
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists b2b_prevals_touch on public.b2b_prevals;
create trigger b2b_prevals_touch before update on public.b2b_prevals
  for each row execute function public.b2b_touch_row();

-- -------------------------------------------------------------- the view
-- Rolled up in Postgres for the same reason b2b_deal_list is: the list only ever
-- needs the totals, and summing in the edge function would mean shipping every
-- line of every evaluation on every draw.
create or replace view public.b2b_preval_list
with (security_invoker = true) as
select
  p.id, p.client_id, p.eval_no, p.status, p.eval_date, p.valid_until,
  p.title, p.summary, p.notes, p.store,
  p.created_by, p.evaluated_by,
  p.sent_at, p.sent_by, p.accepted_at, p.accepted_by,
  p.declined_at, p.declined_by, p.declined_reason,
  p.converted_at, p.converted_by, p.converted_deal_id,
  p.created_at, p.updated_at, p.status_changed_at,
  c.company, c.acronym, c.contact, c.contact_email, c.contact_phone,
  c.acronym || '-PE-' || lpad(p.eval_no::text, 3, '0') as ref,
  p.status in ('converted', 'declined')                as is_terminal,
  -- The deal it became, so the list can offer a way through to it without a
  -- second round trip. Its ref is rebuilt from the same acronym the evaluation
  -- already joined, because a deal and its evaluation are always one client.
  c.acronym || '-' || lpad(d.deal_no::text, 3, '0')    as deal_ref,
  d.stage                                              as deal_stage,
  coalesce(r.line_count,     0) as line_count,
  coalesce(r.total_units,    0) as total_units,
  coalesce(r.total_value,    0) as total_value,
  coalesce(r.total_offer,    0) as total_offer,
  coalesce(r.total_wipe_fee, 0) as total_wipe_fee,
  coalesce(r.total_shipping, 0) as total_shipping,
  greatest(coalesce(r.total_offer, 0) - coalesce(r.total_wipe_fee, 0), 0) as net_offer
from public.b2b_prevals p
  join public.b2b_clients c on c.id = p.client_id
  left join public.b2b_deals d on d.id = p.converted_deal_id
  left join lateral (
    select
      count(*)        as line_count,
      sum(i.quantity) as total_units,
      -- Recycle contributes no resale value, exactly as on b2b_deal_list.
      sum(case when i.disposition = 'recycle' then 0
               else i.value * i.quantity end)                     as total_value,
      sum(i.offer * i.quantity)                                   as total_offer,
      sum(case when i.wipe_required then i.wipe_fee * i.quantity
               else 0 end)                                        as total_wipe_fee,
      sum(i.shipping_cost * i.quantity)                           as total_shipping
    from public.b2b_preval_items i
    where i.preval_id = p.id) r on true;

-- ---------------------------------------------------------- the conversion
-- Everything or nothing. Takes the row lock first, so two people hitting Convert
-- at the same moment cannot mint two deals from one evaluation: the second waits,
-- then finds the status is no longer `accepted` and is refused.
--
-- The deal lands at `pickup`, NOT at `pricing`. A pre-evaluation replaced the
-- guesswork about price, not the pipeline -- the goods still have to be collected
-- and signed for. The lines simply exist earlier than usual, which is harmless:
-- OPEN_STAGES only gates EDITS, so by the time the pricing sheet opens the deal
-- is in `pricing` and every line is editable, pre-filled.
--
-- wipe_fee copies across rather than being re-snapshotted at today's rate. The
-- client was quoted that figure; re-reading the global fee here would silently
-- reprice an evaluation they have already accepted.
create or replace function public.b2b_preval_to_deal(
  p_preval_id     uuid,
  p_pricing_store text,
  p_intake_kind   text,
  p_user          text
) returns table (deal_id uuid, deal_no int, ref text, lines int)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_preval  public.b2b_prevals%rowtype;
  v_acronym text;
  v_no      int;
  v_deal    uuid;
  v_lines   int;
begin
  select * into v_preval from public.b2b_prevals where id = p_preval_id for update;
  if not found then
    raise exception 'That evaluation no longer exists.' using errcode = 'no_data_found';
  end if;
  if v_preval.status = 'converted' then
    raise exception 'That evaluation has already been turned into a deal.' using errcode = 'raise_exception';
  end if;
  if v_preval.status <> 'accepted' then
    raise exception 'Only an accepted evaluation can become a deal.' using errcode = 'raise_exception';
  end if;

  select acronym into v_acronym from public.b2b_clients where id = v_preval.client_id;

  -- Per-client deal counter, read under the evaluation's lock. Two conversions
  -- for the same client serialise on their own rows rather than on this one, so
  -- the unique index is still the real guard -- it just has nothing to catch at
  -- the volumes involved.
  select coalesce(max(deal_no), 0) + 1 into v_no
    from public.b2b_deals where client_id = v_preval.client_id;

  insert into public.b2b_deals (
    client_id, deal_no, stage, pricing_store, intake_kind,
    pickup_desc, created_by, preval_id)
  values (
    v_preval.client_id, v_no, 'pickup',
    nullif(p_pricing_store, ''),
    coalesce(nullif(p_intake_kind, ''), 'pickup'),
    -- What the client told us they had is the best description of the pickup we
    -- are about to make, so the pickup screen opens already filled in.
    v_preval.summary,
    coalesce(nullif(p_user, ''), 'Unknown'),
    v_preval.id)
  returning id into v_deal;

  insert into public.b2b_deal_items (
    deal_id, line_no, sort_order, sku,
    make, model, condition, staff_notes, client_notes,
    quantity, value, offer, shipping_cost,
    item_type, cpu, ram, storage, gpu, battery_health,
    disposition, wipe_required, wipe_fee)
  select
    v_deal,
    row_number() over (order by i.sort_order, i.line_no),
    row_number() over (order by i.sort_order, i.line_no) * 10,
    -- Minted here for the same reason add_item mints one: a label has to be
    -- printable the moment the line exists.
    v_acronym || '-' || lpad(v_no::text, 3, '0') || '-'
      || lpad((row_number() over (order by i.sort_order, i.line_no))::text, 4, '0'),
    i.make, i.model, i.condition, i.staff_notes, i.client_notes,
    i.quantity, i.value, i.offer, i.shipping_cost,
    i.item_type, i.cpu, i.ram, i.storage, i.gpu, i.battery_health,
    i.disposition, i.wipe_required, i.wipe_fee
  from public.b2b_preval_items i
  where i.preval_id = v_preval.id;

  get diagnostics v_lines = row_count;

  update public.b2b_prevals
     set status = 'converted',
         converted_at = now(),
         converted_by = coalesce(nullif(p_user, ''), 'Unknown'),
         converted_deal_id = v_deal
   where id = v_preval.id;

  return query select v_deal, v_no,
    v_acronym || '-' || lpad(v_no::text, 3, '0'), v_lines;
end;
$fn$;

revoke all on function public.b2b_preval_to_deal(uuid, text, text, text) from anon, authenticated;
revoke all on public.b2b_preval_list from anon, authenticated;
revoke all on public.b2b_prevals      from anon, authenticated;
revoke all on public.b2b_preval_items from anon, authenticated;

-- No policies, matching every other table here: the tables stay closed to the
-- anon client and all access goes through the service-role edge function.
alter table public.b2b_prevals      enable row level security;
alter table public.b2b_preval_items enable row level security;

-- ------------------------------------------- b2b_deal_list gains the link
-- The board has to be able to say a deal was priced in advance, and by which
-- evaluation, without a second round trip per row. preval_id and a rebuilt
-- preval_ref are appended after intake_kind, which is what keeps this inside
-- what CREATE OR REPLACE VIEW allows: append only, never reorder or rename.
--
-- The ref is rebuilt from the acronym the view has already joined rather than
-- read off the evaluation, because a deal and its evaluation are by
-- construction the same client -- and one source for the acronym means the two
-- refs can never disagree about how that client is spelled.
create or replace view public.b2b_deal_list as
 SELECT d.id,
    d.client_id,
    d.deal_no,
    d.stage,
    d.pickup_desc,
    d.signed_by,
    d.signed_at,
    d.pickup_date,
    d.pricing_store,
    d.listing_store,
    d.delivered_by,
    d.received_by,
    d.priced_by,
    d.quote_sent_at,
    d.quote_send_count,
    d.accepted_at,
    d.accepted_by,
    d.declined_reason,
    d.created_by,
    d.created_at,
    d.updated_at,
    d.stage_changed_at,
    d.declined_at,
    d.declined_by,
    d.declined_category,
    d.sendback_note,
    d.sendback_by,
    d.sendback_at,
    c.company,
    c.acronym,
    c.contact,
    c.contact_email,
    c.contact_phone,
    (c.acronym || '-'::text) || lpad(d.deal_no::text, 3, '0'::text) AS ref,
    b2b_stage_rank(d.stage) AS stage_rank,
    d.stage = ANY (ARRAY['completed'::text, 'declined'::text]) AS is_terminal,
    COALESCE(r.line_count, 0::bigint) AS line_count,
    COALESCE(r.total_units, 0::bigint) AS total_units,
    COALESCE(r.listed_units, 0::bigint) AS listed_units,
    COALESCE(r.recycled_units, 0::bigint) AS recycled_units,
    COALESCE(r.wiped_units, 0::bigint) AS wiped_units,
    COALESCE(r.outstanding_units, 0::bigint) AS outstanding_units,
    COALESCE(r.total_value, 0::numeric) AS total_value,
    COALESCE(r.total_offer, 0::numeric) AS total_offer,
    COALESCE(r.total_cost, 0::numeric) AS total_cost,
    COALESCE(r.total_wipe_fee, 0::numeric) AS total_wipe_fee,
    GREATEST(COALESCE(r.total_offer, 0::numeric) - COALESCE(r.total_wipe_fee, 0::numeric), 0::numeric) AS net_offer,
    COALESCE(r.total_shipping, 0::numeric) AS total_shipping,
    COALESCE(r.wipe_units, 0::bigint) AS wipe_units,
    d.signature_path,
    d.signature_at,
    d.signature_by,
    d.signature_skipped_by,
    d.signature_skipped_reason,
    -- Appended last on purpose: see the note above about CREATE OR REPLACE.
    d.intake_kind,
    d.preval_id,
    CASE WHEN p.eval_no IS NULL THEN NULL
         ELSE c.acronym || '-PE-'::text || lpad(p.eval_no::text, 3, '0'::text)
    END AS preval_ref
   FROM b2b_deals d
     JOIN b2b_clients c ON c.id = d.client_id
     LEFT JOIN b2b_prevals p ON p.id = d.preval_id
     LEFT JOIN LATERAL ( SELECT count(*) AS line_count,
            sum(i.quantity) AS total_units,
            sum(i.listed_qty) AS listed_units,
            sum(i.recycled_qty) AS recycled_units,
            sum(i.wiped_qty) AS wiped_units,
            sum(GREATEST(i.quantity - i.listed_qty - i.recycled_qty, 0)) AS outstanding_units,
            sum(
                CASE
                    WHEN i.disposition = 'recycle'::text THEN 0::numeric
                    ELSE i.value * i.quantity::numeric
                END) AS total_value,
            sum(i.offer * i.quantity::numeric) AS total_offer,
            sum(COALESCE(i.cost, 0::numeric) * i.quantity::numeric) AS total_cost,
            sum(
                CASE
                    WHEN i.wipe_required THEN i.wipe_fee * i.quantity::numeric
                    ELSE 0::numeric
                END) AS total_wipe_fee,
            -- Recycle lines still cost money to move, so unlike total_value this
            -- one has no disposition test: a pallet of scrap is freight too.
            sum(i.shipping_cost * i.quantity::numeric) AS total_shipping,
            sum(CASE WHEN i.wipe_required THEN i.quantity ELSE 0 END) AS wipe_units
           FROM b2b_deal_items i
          WHERE i.deal_id = d.id) r ON true;
