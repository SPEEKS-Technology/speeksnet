-- ============================================================================
-- How the goods got here: we collected them, or the business carried them in.
--
-- Until now every deal was a pickup, because every deal started with corp
-- routing a collection. A store can raise its own deals as of the change that
-- ships with this, and a good number of those are a walk-in: a customer is
-- already at the counter with more than the buy desk can sensibly price, and we
-- take the lot in as B2B rather than send them away.
--
-- The pipeline is IDENTICAL either way -- same stages, same gates, same
-- signature rule. What differs is what you have to ask for at the counter:
--
--   pickup   a collection run. Somebody drove out on a date, somebody handed
--            the goods over, somebody took them in at the other end. All three
--            are worth recording because none of them are obvious afterwards.
--   walkin   the client is standing in front of you. The date is today, the
--            person who received it is whoever is signing, and there is no
--            hand-off between a driver and a store because there was no drive.
--
-- So this column buys exactly one thing: permission for the intake screen to
-- stop asking questions whose answers are already known. It deliberately does
-- NOT relax the signature rule -- a client physically present is the easiest
-- signature we will ever get, and it is the moment their property becomes ours
-- to hold, which is precisely what the signature is evidence of.
--
-- ---------------------------------------------------------------------------
-- Why a column and not a derivation
--
-- "pricing_store was set at creation" nearly means walk-in and is nearly always
-- right, which is what makes it the wrong thing to key off. A store can raise a
-- deal for a collection it is about to drive out on, and corp can take a
-- drop-off at CORP. Those two cases are not rare enough to misreport, and a
-- derived flag would silently pick the wrong vocabulary for both.
--
-- NOT NULL DEFAULT 'pickup' backfills every existing row correctly: every deal
-- that exists today came in on a collection run, because until now there was no
-- other way for one to exist.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

alter table public.b2b_deals
  add column if not exists intake_kind text not null default 'pickup';

-- Its own statement, and dropped first: ADD CONSTRAINT has no IF NOT EXISTS, so
-- folding it into the ALTER above would make this migration fail on a re-run.
alter table public.b2b_deals drop constraint if exists b2b_deals_intake_kind_check;
alter table public.b2b_deals add constraint b2b_deals_intake_kind_check
  check (intake_kind in ('pickup', 'walkin'));

-- The board reads b2b_deal_list, not b2b_deals, so the new column has to surface
-- on the view too or DEAL_COLS 400s. Appended after signature_skipped_reason,
-- which is what keeps this inside what CREATE OR REPLACE VIEW allows: it may add
-- columns at the end and may not reorder, rename or drop the ones already there.
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
    d.intake_kind
   FROM b2b_deals d
     JOIN b2b_clients c ON c.id = d.client_id
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
