-- ============================================================================
-- A drawn signature on the pickup form, replacing a typed name.
--
-- Flow: the pickup screen shows a QR; a staff member scans it with their own
-- phone, which opens the same PIN-gated app at this deal's signing screen; they
-- hand the phone over and the client signs on it. So there is no public route
-- and no anonymous write path -- the phone is a signed-in session like any
-- other.
--
-- signed_by (the typed name) stays. It is who released the goods, which is still
-- worth recording, and the signature is the evidence beside it rather than a
-- replacement for it.
--
-- ---------------------------------------------------------------------------
-- The bucket is PRIVATE, unlike ann-docs and audit-photos.
--
-- Their public-URL pattern is fine for a store photo and wrong for a signature:
-- a public bucket means anyone holding the path can fetch the image, and the
-- paths here are guessable from a deal id. variance-reports is the existing
-- private precedent. Reads go back through the edge function.
--
-- ---------------------------------------------------------------------------
-- No CHECK requiring a signature past pickup, deliberately.
--
-- Existing deals are already at quote and listing with neither a signature nor a
-- recorded skip, so a constraint would either fail on apply or need those rows
-- backfilled with a fiction. The rule belongs on the TRANSITION instead:
-- sign_pickup refuses unless there is a signature or an explicit, attributed
-- bypass. That binds every future sign-off without rewriting the past.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

alter table public.b2b_deals
  -- The object path inside the bucket, not a URL: the bucket is private, so a
  -- stored URL would be a link that only works for the service role and would
  -- rot the moment the bucket or project moved.
  add column if not exists signature_path text,
  add column if not exists signature_at   timestamptz,
  -- The staff member who captured it, not the client -- the client's name is
  -- already in signed_by. This answers "whose phone was this taken on".
  add column if not exists signature_by   text,
  -- The bypass, and why. Both or neither: a skip with no reason is the thing
  -- worth making impossible, because it is indistinguishable from an oversight.
  add column if not exists signature_skipped_by     text,
  add column if not exists signature_skipped_reason text;

-- Its own statement, and dropped first: ADD CONSTRAINT has no IF NOT EXISTS, so
-- folding it into the ALTER above would make this migration fail on a re-run.
alter table public.b2b_deals drop constraint if exists b2b_deals_skip_explained;
alter table public.b2b_deals add constraint b2b_deals_skip_explained
  check (signature_skipped_by is null
         or length(btrim(coalesce(signature_skipped_reason, ''))) > 0);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('b2b-signatures', 'b2b-signatures', false, 2097152, array['image/png'])
on conflict (id) do nothing;

-- The board reads b2b_deal_list, not b2b_deals, so the new columns have to
-- surface on the view too or DEAL_COLS 400s. Appended after wipe_units, which
-- keeps this inside what CREATE OR REPLACE VIEW allows.
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
    COALESCE(r.wipe_units, 0::bigint) AS wipe_units,
    d.signature_path,
    d.signature_at,
    d.signature_by,
    d.signature_skipped_by,
    d.signature_skipped_reason
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
