-- ============================================================================
-- 0067 — three additions to b2b_deals, sharing one view rebuild.
--
-- 1. QUOTE NOTES (Haydn, 2026-09-02): "can you add a custom line at the bottom
--    of the b2b quote when we send it out, just to add an additional note and
--    also a large field i can put stuff for paul to know for when hes sending
--    it?" Two fields, because those are two different audiences and conflating
--    them is how internal context ends up in front of a client:
--      quote_note    -- prints on the quote the client receives
--      internal_note -- never leaves the building; context for the approver
--
--    The UI shows them side by side, each labelled, for the same reason.
--
-- 2. PAYMENT (Paul, 2026-08-22): he asked for a section showing "payment has
--    been made to customer" and there was no payment concept in B2B at all --
--    no stage, no flag, no column. Recorded as a fact on the deal rather than
--    as a new stage: paying the client does not gate listing (the goods are
--    already ours from acceptance), so making it a stage would stall a pallet
--    behind an accounts task. paid_at is what the Overview reads.
--
--    Guarded on acceptance: money cannot have gone out on a deal the client
--    never agreed to, and a paid-but-unaccepted row would be a data-entry slip
--    that reads as a real payment.
--
-- 3. PRICING STARTED (Nick, 2026-09-03): "Stage that differentiates from
--    awaiting pricing, to actively pricing."
--
--    Deliberately NOT a new stage. The stage list is a rank-ordered state
--    machine (0018) whose CHECK constraints and three integrity gates all key
--    off b2b_stage_rank, so inserting a rank between pricing and review means
--    renumbering every later stage and revisiting all of them -- a large, risky
--    change to draw one distinction inside a stage nobody otherwise disagrees
--    about. A timestamp on the existing `pricing` stage answers the same
--    question ("has anyone actually started?"), and _b2bStageChip reads it so
--    the board says "Awaiting Pricing" until somebody opens the sheet. If it
--    ever does need to be a real stage, this column is the backfill source for
--    when each deal started.
--
-- All additive: new nullable columns and an appended-to view. Postgres allows
-- new columns only at the END of a CREATE OR REPLACE VIEW, which is why they go
-- last rather than beside their relatives.
--
-- Applied via Supabase MCP `apply_migration` as
-- `b2b_quote_notes_payment_and_pricing_started`.
-- ============================================================================

alter table public.b2b_deals
  add column if not exists quote_note          text,
  add column if not exists internal_note       text,
  add column if not exists paid_at             timestamptz,
  add column if not exists paid_by             text,
  add column if not exists paid_amount         numeric(12, 2),
  add column if not exists pricing_started_at  timestamptz,
  add column if not exists pricing_started_by  text;

comment on column public.b2b_deals.quote_note is
  'A custom line printed at the bottom of the quote the CLIENT receives.';
comment on column public.b2b_deals.internal_note is
  'Context for whoever sends the quote. Never printed on the quote.';
comment on column public.b2b_deals.paid_at is
  'When the client was actually paid. Read by the Overview; does not gate listing.';
comment on column public.b2b_deals.pricing_started_at is
  'When someone first opened this deal to price it -- tells "actively pricing" from "awaiting pricing" inside the pricing stage.';

alter table public.b2b_deals
  drop constraint if exists b2b_deals_note_len;
alter table public.b2b_deals
  add constraint b2b_deals_note_len
  check (length(coalesce(quote_note, '')) <= 2000
     and length(coalesce(internal_note, '')) <= 4000
     and length(coalesce(paid_by, '')) <= 120
     and length(coalesce(pricing_started_by, '')) <= 120);

-- A payment needs a payer's name and a non-negative amount, and cannot exist on
-- a deal the client never accepted.
alter table public.b2b_deals
  drop constraint if exists b2b_deals_payment_recorded;
alter table public.b2b_deals
  add constraint b2b_deals_payment_recorded
  check (paid_at is null
         or (coalesce(btrim(paid_by), '') <> ''
             and coalesce(paid_amount, 0) >= 0
             and accepted_at is not null));

-- Reproduced from pg_get_viewdef with the seven new columns appended at the end.
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
    d.pricing_started_by
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
