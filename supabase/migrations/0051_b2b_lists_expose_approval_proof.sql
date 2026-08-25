-- ============================================================================
-- Surface the approval evidence on both list views.
--
-- proof_count as a rollup rather than the rows themselves: the board wants to
-- know whether a deal HAS evidence, not to carry every email body on every
-- draw -- some of those are 100KB of quoted thread. The rows are fetched only
-- when somebody opens the deal.
--
-- Removed entries are excluded from the count. They are kept as tombstones for
-- the record, but a deal whose only proof was withdrawn should read as having
-- none, because that is the position it is actually in.
--
-- Both views are re-stated in full with the new columns appended at the end,
-- which is what CREATE OR REPLACE VIEW allows: append only, never reorder,
-- rename or drop.
--
-- The bodies below were read back out of the live database with pg_get_viewdef
-- after applying, so this file is provably the definition that is running
-- rather than a retyped approximation of it.
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
    COALESCE(pf.n, 0::bigint) AS proof_count
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

create or replace view public.b2b_preval_list
with (security_invoker = true) as
 SELECT p.id,
    p.client_id,
    p.eval_no,
    p.status,
    p.eval_date,
    p.valid_until,
    p.title,
    p.summary,
    p.notes,
    p.store,
    p.created_by,
    p.evaluated_by,
    p.sent_at,
    p.sent_by,
    p.accepted_at,
    p.accepted_by,
    p.declined_at,
    p.declined_by,
    p.declined_reason,
    p.converted_at,
    p.converted_by,
    p.converted_deal_id,
    p.created_at,
    p.updated_at,
    p.status_changed_at,
    c.company,
    c.acronym,
    c.contact,
    c.contact_email,
    c.contact_phone,
    (c.acronym || '-PE-'::text) || lpad(p.eval_no::text, 3, '0'::text) AS ref,
    p.status = ANY (ARRAY['converted'::text, 'declined'::text]) AS is_terminal,
    (c.acronym || '-'::text) || lpad(d.deal_no::text, 3, '0'::text) AS deal_ref,
    d.stage AS deal_stage,
    COALESCE(r.line_count, 0::bigint) AS line_count,
    COALESCE(r.total_units, 0::bigint) AS total_units,
    COALESCE(r.total_value, 0::numeric) AS total_value,
    COALESCE(r.total_offer, 0::numeric) AS total_offer,
    COALESCE(r.total_wipe_fee, 0::numeric) AS total_wipe_fee,
    COALESCE(r.total_shipping, 0::numeric) AS total_shipping,
    GREATEST(COALESCE(r.total_offer, 0::numeric) - COALESCE(r.total_wipe_fee, 0::numeric), 0::numeric) AS net_offer,
    p.approval_waived_by,
    p.approval_waived_reason,
    COALESCE(pf.n, 0::bigint) AS proof_count
   FROM b2b_prevals p
     JOIN b2b_clients c ON c.id = p.client_id
     LEFT JOIN b2b_deals d ON d.id = p.converted_deal_id
     LEFT JOIN LATERAL ( SELECT count(*) AS n
           FROM b2b_approval_proofs ap
          WHERE ap.preval_id = p.id AND ap.removed_at IS NULL) pf ON true
     LEFT JOIN LATERAL ( SELECT count(*) AS line_count,
            sum(i.quantity) AS total_units,
            sum(
                CASE
                    WHEN i.disposition = 'recycle'::text THEN 0::numeric
                    ELSE i.value * i.quantity::numeric
                END) AS total_value,
            sum(i.offer * i.quantity::numeric) AS total_offer,
            sum(
                CASE
                    WHEN i.wipe_required THEN i.wipe_fee * i.quantity::numeric
                    ELSE 0::numeric
                END) AS total_wipe_fee,
            sum(i.shipping_cost * i.quantity::numeric) AS total_shipping
           FROM b2b_preval_items i
          WHERE i.preval_id = p.id) r ON true;

revoke all on public.b2b_preval_list from anon, authenticated;
