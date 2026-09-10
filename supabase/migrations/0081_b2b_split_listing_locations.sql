-- ============================================================================
-- Split a priced deal across several listing locations.
--
-- Nick, 2026-09-10: "I need the ability to split a deal thats been priced out
-- between multiple listing locations... This way each store can only see the
-- part of the B2b DEAL that was actually brought to their store. I will also
-- need the ability to make changes and transfer items between listing locations
-- in the listing stage... The transferring and the assigning pricing locations
-- should be just available by corp."
--
-- And on how a split deal should then behave: "Treat it as 2 seperate deals from
-- that point to each store. Once they complete their part then it marks as
-- completed. For corp viewing the deal, it should break it down into two
-- progress bars, 1 for each store, both dropped down from the main deal
-- progress bar."
--
-- WHY THIS IS A SCHEMA CHANGE AND NOT A UI ONE
--
-- The listing location has always been ONE column on the deal
-- (b2b_deals.listing_store, 0001:67), and everything downstream keys off it:
--
--   * the store board is scoped with
--     `or(pricing_store.eq.X, listing_store.eq.X)` (b2b-deals index.ts ~2553),
--     so a store can only ever see a deal whose DEAL ROW names it;
--   * the listing screen is gated on `mine.includes(deal.listing_store)`;
--   * b2b_deals_listing_located (0018:88) requires that column at rank >= 7.
--
-- So "which store lists this item" has to move to the ITEM, and the deal has to
-- keep a roll-up of the set so the board query stays one indexed predicate
-- rather than a join.
--
-- ---------------------------------------------------------------------------
-- 1. THE ASSIGNMENT LIVES ON THE ITEM
-- ---------------------------------------------------------------------------
-- Nullable, and backfilled below, so that after this migration every accepted
-- deal's items carry a store whether or not it was ever split. A uniform model
-- is worth more than a clever one: per-store totals, per-store progress and the
-- store-scoped item fetch all then work the same way for a one-store deal as
-- for a five-store one, with no "if split" branch in the read paths.
--
-- CORP is deliberately not allowed. It is a pricing location, not a shop floor
-- -- the same five stores 0001 allows are the only places goods can be listed.
-- ---------------------------------------------------------------------------

alter table public.b2b_deal_items
  add column if not exists listing_store text
    check (listing_store in ('OVL','LEE','WSP','MPL','BAL'));

create index if not exists b2b_deal_items_listing_store_idx
  on public.b2b_deal_items (listing_store) where listing_store is not null;

-- ---------------------------------------------------------------------------
-- 2. THE DEAL KEEPS A DERIVED ROLL-UP
-- ---------------------------------------------------------------------------
-- Maintained by trigger rather than by the edge function, because there are
-- several write paths that can change it -- assigning at acceptance,
-- transferring an item, deleting a line, adding a line to a deal already in
-- listing -- and a roll-up that disagrees with the items is worse than no
-- roll-up: it decides who can SEE the deal. A trigger cannot be forgotten by
-- the next code path somebody adds.
--
-- Sorted so the array is stable and comparable, and so the UI gets a
-- predictable order without sorting it again.
-- ---------------------------------------------------------------------------

alter table public.b2b_deals
  add column if not exists listing_stores text[] not null default '{}';

create index if not exists b2b_deals_listing_stores_idx
  on public.b2b_deals using gin (listing_stores);

create or replace function public.b2b_sync_listing_stores()
returns trigger language plpgsql as $$
declare
  target uuid := coalesce(new.deal_id, old.deal_id);
begin
  update public.b2b_deals d
     set listing_stores = coalesce((
           select array_agg(distinct i.listing_store order by i.listing_store)
             from public.b2b_deal_items i
            where i.deal_id = target
              and i.listing_store is not null
         ), '{}')
   where d.id = target;
  return null;                       -- AFTER trigger; the row is already written
end;
$$;

drop trigger if exists b2b_deal_items_listing_stores_sync on public.b2b_deal_items;
create trigger b2b_deal_items_listing_stores_sync
  after insert or delete or update of listing_store, deal_id
  on public.b2b_deal_items
  for each row execute function public.b2b_sync_listing_stores();

-- ---------------------------------------------------------------------------
-- 3. PER-STORE COMPLETION
-- ---------------------------------------------------------------------------
-- "Treat it as 2 seperate deals from that point to each store. Once they
-- complete their part then it marks as completed."
--
-- So completion is per store and RECORDED, not derived from the item counts.
-- Derived would have been less to keep in step, but it cannot answer the
-- question this table exists for -- who finished which half, and when. A store
-- saying "we are done" is an act by a person, the same as signing a pickup, and
-- the deal reaching `completed` is then a consequence rather than a click
-- somebody has to be chased for.
--
-- A row here always means "every unit assigned to this store is accounted for",
-- because the edge function refuses to write one otherwise.
-- ---------------------------------------------------------------------------

create table if not exists public.b2b_deal_listing_parts (
  id           uuid primary key default gen_random_uuid(),
  deal_id      uuid not null references public.b2b_deals(id) on delete cascade,
  store        text not null check (store in ('OVL','LEE','WSP','MPL','BAL')),
  completed_at timestamptz not null default now(),
  completed_by text,
  unique (deal_id, store)
);

create index if not exists b2b_deal_listing_parts_deal_idx
  on public.b2b_deal_listing_parts (deal_id);

alter table public.b2b_deal_listing_parts enable row level security;

-- ---------------------------------------------------------------------------
-- 4. ITEM-LEVEL TRANSFERS REUSE THE EXISTING AUDIT TABLE
-- ---------------------------------------------------------------------------
-- 0021 already records deal-level store moves and says why: "a deal row only
-- ever holds where it is NOW", and "why is this pallet at MPL when the paperwork
-- says LEE" is exactly the question asked a month later. Moving ONE LINE between
-- stores is the same question at finer grain, so it belongs in the same log
-- rather than a second one that has to be read alongside it.
--
-- item_id is nullable: existing rows are deal-level moves and stay that way.
-- ---------------------------------------------------------------------------

alter table public.b2b_deal_transfers
  add column if not exists item_id uuid references public.b2b_deal_items(id) on delete set null;

alter table public.b2b_deal_transfers drop constraint if exists b2b_deal_transfers_kind_check;
alter table public.b2b_deal_transfers add constraint b2b_deal_transfers_kind_check
  check (kind in ('pricing', 'listing', 'item'));

-- An item move must name the item; a deal move must not.
alter table public.b2b_deal_transfers drop constraint if exists b2b_deal_transfers_item_shape;
alter table public.b2b_deal_transfers add constraint b2b_deal_transfers_item_shape
  check ((kind = 'item') = (item_id is not null));

create index if not exists b2b_deal_transfers_item_idx
  on public.b2b_deal_transfers (item_id) where item_id is not null;

-- ---------------------------------------------------------------------------
-- 5. BACKFILL, THEN RELAX THE STAGE CONSTRAINT
-- ---------------------------------------------------------------------------
-- Order matters. The backfill fires the trigger and fills listing_stores for
-- every existing deal, so by the time the constraint is replaced every row
-- already satisfies the new form of it.
-- ---------------------------------------------------------------------------

update public.b2b_deal_items i
   set listing_store = d.listing_store
  from public.b2b_deals d
 where i.deal_id = d.id
   and d.listing_store is not null
   and i.listing_store is null;

-- A deal in listing or completed needs a listing location -- which is now
-- EITHER the single-store column, or a non-empty set of item assignments. Both
-- are accepted so that a split deal (listing_store null, listing_stores
-- populated) and an unsplit one (both set) are equally legal, and so that
-- nothing already on the record has to be rewritten to fit.
alter table public.b2b_deals drop constraint if exists b2b_deals_listing_located;
alter table public.b2b_deals add constraint b2b_deals_listing_located
  check (b2b_stage_rank(stage) < 7
         or ((listing_store is not null
              or coalesce(array_length(listing_stores, 1), 0) > 0)
             and accepted_at is not null));

-- ---------------------------------------------------------------------------
-- 6. THE VIEW CARRIES THE PER-STORE BREAKDOWN
-- ---------------------------------------------------------------------------
-- listing_parts is a JSONB array, one entry per store on the deal, each with
-- that store's own line/unit counts, its money, and its completion. It exists
-- so the two things the UI needs cost one fetch and no extra round trip:
--
--   * corp's deal progress bar broken down per store, which is what was asked
--     for: "it should break it down into two progress bars, 1 for each store,
--     both dropped down from the main deal progress bar";
--   * a STORE's own numbers on the board, before it has opened anything --
--     picking its own entry out of this array is how a store row reads "2 of 5
--     listed" meaning its five, not the deal's eleven.
--
-- The deal-wide totals above are untouched: they are still the deal's, corp
-- still needs them, and a store simply does not read them.
--
-- ⚠️ REBUILT FROM THE LIVE DEFINITION (pg_get_viewdef), NOT from the text of
-- 0067. Those two had drifted -- the deployed view orders its columns
-- differently and does not carry priced_at at all -- and CREATE OR REPLACE VIEW
-- rejects any change to the name, type or POSITION of an existing column. So
-- the body below is the deployed view verbatim, with the two new columns
-- APPENDED and one lateral join added. Copying 0067 forward would have failed
-- outright, and "fixing" the order to match 0067 would have silently rewritten
-- the shape every read site depends on.
-- ---------------------------------------------------------------------------

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
    d.intake_kind,
    d.preval_id,
        CASE
            WHEN p.eval_no IS NULL THEN NULL::text
            ELSE (c.acronym || '-PE-'::text) || lpad(p.eval_no::text, 3, '0'::text)
        END AS preval_ref,
    d.approval_waived_by,
    d.approval_waived_reason,
    COALESCE(pf.n, 0::bigint) AS proof_count,
    d.delete_requested_at,
    d.delete_requested_by,
    d.quote_note,
    d.internal_note,
    d.paid_at,
    d.paid_by,
    d.paid_amount,
    d.pricing_started_at,
    d.pricing_started_by,
    -- APPENDED. See the note above: only the end of the list is safe.
    d.listing_stores,
    COALESCE(lp.parts, '[]'::jsonb) AS listing_parts
   FROM b2b_deals d
     JOIN b2b_clients c ON c.id = d.client_id
     LEFT JOIN b2b_prevals p ON p.id = d.preval_id
     LEFT JOIN LATERAL ( SELECT count(*) AS n
           FROM b2b_approval_proofs ap
          WHERE ap.deal_id = d.id AND ap.removed_at IS NULL) pf ON true
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
            sum(i.shipping_cost * i.quantity::numeric) AS total_shipping,
            sum(
                CASE
                    WHEN i.wipe_required THEN i.quantity
                    ELSE 0
                END) AS wipe_units
           FROM b2b_deal_items i
          WHERE i.deal_id = d.id) r ON true
     LEFT JOIN LATERAL ( SELECT jsonb_agg(x.part ORDER BY x.store) AS parts
           FROM ( SELECT i.listing_store AS store,
                    jsonb_build_object(
                      'store', i.listing_store,
                      'line_count', count(*),
                      'total_units', COALESCE(sum(i.quantity), 0),
                      'listed_units', COALESCE(sum(i.listed_qty), 0),
                      'recycled_units', COALESCE(sum(i.recycled_qty), 0),
                      'wiped_units', COALESCE(sum(i.wiped_qty), 0),
                      'outstanding_units', COALESCE(sum(GREATEST(i.quantity - i.listed_qty - i.recycled_qty, 0)), 0),
                      'total_value', COALESCE(sum(
                          CASE
                              WHEN i.disposition = 'recycle'::text THEN 0::numeric
                              ELSE i.value * i.quantity::numeric
                          END), 0::numeric),
                      'total_cost', COALESCE(sum(COALESCE(i.cost, 0::numeric) * i.quantity::numeric), 0::numeric),
                      'completed_at', max(pt.completed_at),
                      'completed_by', max(pt.completed_by)
                    ) AS part
                   FROM b2b_deal_items i
                     LEFT JOIN b2b_deal_listing_parts pt
                       ON pt.deal_id = i.deal_id AND pt.store = i.listing_store
                  WHERE i.deal_id = d.id AND i.listing_store IS NOT NULL
                  GROUP BY i.listing_store) x) lp ON true;
