-- ============================================================================
-- Pickup custody form + optional itemized pickup (Nick, 2026-10-16).
--
-- "PDF downloadable. Client should read a document stating they are accepting
-- that we are taking custody of said items and then when they sign the
-- signature is placed into the document and saved as a pdf downloadable file."
--
-- "[Itemized pickup] becomes pricing lines and is put on the document for
-- signing custody."
--
-- What it needs:
--   * b2b_deals.pickup_manifest -- the optional scanned list (serial, what it
--     is, quantity), saved as it is built so the phone at the client's door and
--     the desktop back at the store see the same list. sign_pickup turns it into
--     pricing lines; the custody PDF prints it.
--   * custody_path / custody_at / custody_by -- the signed custody PDF, in a
--     private bucket like the signature, streamed back through b2b-deals
--     (?custody=<deal>) rather than handed out as a URL.
--   * b2b-custody -- its own bucket because b2b-signatures only accepts PNG,
--     and a mismatch there fails late and unhelpfully. PDF only, 10MB.
--   * the board view carries the new columns, appended after listing_parts,
--     which keeps this inside what CREATE OR REPLACE VIEW allows. Without them
--     DEAL_COLS 400s, exactly as 0022 notes for the signature columns.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

alter table public.b2b_deals
  add column if not exists pickup_manifest jsonb not null default '[]'::jsonb,
  add column if not exists custody_path text,
  add column if not exists custody_at timestamptz,
  add column if not exists custody_by text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('b2b-custody', 'b2b-custody', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

create or replace view public.b2b_deal_list
with (security_invoker = true) as
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
                        END), 0::numeric), 'total_cost', COALESCE(sum(COALESCE(i.cost, 0::numeric) * i.quantity::numeric), 0::numeric), 'completed_at', max(pt.completed_at), 'completed_by', max(pt.completed_by)) AS part
                   FROM b2b_deal_items i
                     LEFT JOIN b2b_deal_listing_parts pt ON pt.deal_id = i.deal_id AND pt.store = i.listing_store
                  WHERE i.deal_id = d.id AND i.listing_store IS NOT NULL
                  GROUP BY i.listing_store) x) lp ON true;

revoke all on public.b2b_deal_list from anon, authenticated;
