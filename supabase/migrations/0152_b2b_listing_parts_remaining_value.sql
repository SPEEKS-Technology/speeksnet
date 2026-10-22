-- 0152 -- listing_parts carries the value still to list
--
-- Nick, 2026-10-22, on the pipeline hub: "For listing stage. Represent it as
-- projected amount to list remaining". A deal in listing is no longer about
-- what we offered -- that money is spent -- it is about how much resale value is
-- still sitting on the shelf unlisted. So the Listing stage tile, its column and
-- its cards show that figure.
--
-- The board never loads line items (that is the whole point of the view), so
-- the number has to arrive on the row. It goes where a listing figure already
-- lives: one more key on each listing_parts entry,
--
--   remaining_value = sum(value x max(quantity - listed - recycled, 0))
--
-- over the store's lines, recycle lines counting nothing (same rule as
-- total_value: a scrapped unit has no resale value to list). Per part rather
-- than per deal because a store's board row is its own part (narrowSplitRows in
-- b2b-deals filters listing_parts to the store and passes each entry through
-- untouched), so a store reads its own remaining value and corp sums the parts
-- -- with no edge-function deploy, since the key rides an existing column.
--
-- ⚠️ REBUILT FROM THE LIVE DEFINITION (pg_get_viewdef, 2026-10-22), not from an
-- older migration's text -- see the warning in 0081. The ONLY change is the
-- 'remaining_value' key inside listing_parts; every column keeps its name, type
-- and position, which CREATE OR REPLACE VIEW requires. security_invoker kept.

create or replace view public.b2b_deal_list with (security_invoker = true) as
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
    d.listing_stores,
    COALESCE(lp.parts, '[]'::jsonb) AS listing_parts,
    d.pickup_manifest,
    d.custody_path,
    d.custody_at,
    d.custody_by
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
                    jsonb_build_object('store', i.listing_store, 'line_count', count(*), 'total_units', COALESCE(sum(i.quantity), 0::bigint), 'listed_units', COALESCE(sum(i.listed_qty), 0::bigint), 'recycled_units', COALESCE(sum(i.recycled_qty), 0::bigint), 'wiped_units', COALESCE(sum(i.wiped_qty), 0::bigint), 'outstanding_units', COALESCE(sum(GREATEST(i.quantity - i.listed_qty - i.recycled_qty, 0)), 0::bigint), 'total_value', COALESCE(sum(
                        CASE
                            WHEN i.disposition = 'recycle'::text THEN 0::numeric
                            ELSE i.value * i.quantity::numeric
                        END), 0::numeric), 'total_cost', COALESCE(sum(COALESCE(i.cost, 0::numeric) * i.quantity::numeric), 0::numeric), 'completed_at', max(pt.completed_at), 'completed_by', max(pt.completed_by),
                    'remaining_value', COALESCE(sum(
                        CASE
                            WHEN i.disposition = 'recycle'::text THEN 0::numeric
                            ELSE i.value * GREATEST(i.quantity - i.listed_qty - i.recycled_qty, 0)::numeric
                        END), 0::numeric)) AS part
                   FROM b2b_deal_items i
                     LEFT JOIN b2b_deal_listing_parts pt ON pt.deal_id = i.deal_id AND pt.store = i.listing_store
                  WHERE i.deal_id = d.id AND i.listing_store IS NOT NULL
                  GROUP BY i.listing_store) x) lp ON true;
