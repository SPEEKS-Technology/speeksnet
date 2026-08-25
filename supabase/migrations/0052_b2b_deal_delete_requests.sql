-- B2B deal deletion requests.
--
-- A trashcan on the deal (any stage, any B2B user) raises a request rather than
-- deleting: it stamps these two columns, which puts the deal in CORP's Delete
-- Requests queue. CORP (ceo/mocd/district manager, or a cap-b2b-corp delegate)
-- approves -> the deal and everything under it is hard-deleted; denies -> the
-- columns clear and the deal carries on. Same model as the recycle_requests /
-- shopify-claims delete flow, adapted to b2b_deals.
--
-- Both columns are nullable and additive; NULL means "no request outstanding".
ALTER TABLE public.b2b_deals
  ADD COLUMN IF NOT EXISTS delete_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS delete_requested_by text;

-- Expose the two columns on the board view so a board draw carries the pending
-- flag -- the client filters for it to paint the badge, the red dots and the
-- Delete Requests modal without a second round trip. Appended to the end of the
-- select list so CREATE OR REPLACE accepts it.
CREATE OR REPLACE VIEW public.b2b_deal_list AS
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
    d.delete_requested_by
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
          WHERE i.deal_id = d.id) r ON true;
