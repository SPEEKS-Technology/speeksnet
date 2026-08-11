-- ============================================================================
-- How many units were sold a certified data wipe.
--
-- The Overview needed to answer "how many wipes do we still owe", and there was
-- no honest way to get it from what the view already had. total_wipe_fee is
-- money, and dividing it by a per-unit rate does not work: the rate is
-- snapshotted onto each line when the wipe is flagged, precisely so that
-- changing the global fee cannot reprice a quote already sent. Two lines on one
-- deal can legitimately carry different rates.
--
-- So the count comes from the same place as everything else: a rollup.
-- wiped_units (already present) is how many have been certified; wipe_units is
-- how many were promised. The difference is the debt.
--
-- Appended after total_shipping, which keeps this inside what CREATE OR REPLACE
-- VIEW allows. The body below is generated from 0017's so the two cannot drift
-- in the parts meant to be identical.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

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
    -- Appended last on purpose: see the note above about CREATE OR REPLACE.
    -- NOT clamped against anything and NOT subtracted from net_offer -- the
    -- client's figure is untouched by what it costs us to move the goods.
    COALESCE(r.total_shipping, 0::numeric) AS total_shipping,
    COALESCE(r.wipe_units, 0::bigint) AS wipe_units
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
