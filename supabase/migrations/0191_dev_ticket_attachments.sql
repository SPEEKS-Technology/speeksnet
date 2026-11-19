-- ============================================================================
-- 0191 — DEVELOPMENT TRACKER, Phase 3 part 2: a ticket can carry attachments
-- (Nick, 2026-11-19). Plan: docs/plans/dev-tracker-HANDOFF.md (Phase 3, D3).
--
-- Submit an Idea becomes Submit a Ticket: the popup every store uses now
-- creates a dev_tickets row in Triage (source 'idea') instead of only sending
-- an email. It always took an optional file, which went to the private
-- `idea-attachments` bucket (0173) and reached the DM as a signed link in the
-- email. The file now belongs to the ticket too, so a dev opening SN-n sees it
-- without digging the email out — hence this column.
--
--   attachments = [{ "path": "tickets/2026-11-19/<uuid>-photo.jpg",
--                    "name": "photo.jpg", "size": 123456, "type": "image/jpeg" }]
--
-- Paths into `idea-attachments`, never URLs: the bucket is private, and the
-- dev-tickets function signs a short-lived link for each on every read. A
-- stored URL would either expire on the ticket or have to live for ever.
--
-- 0191: the database already held 0189_listing_review_flow and
-- 0190_spot_check_notes (2026-11-19), which no branch here, local or pushed,
-- carries yet. Trap 4 — list_migrations is the authority.
-- ============================================================================

alter table public.dev_tickets
  add column if not exists attachments jsonb not null default '[]'::jsonb;

do $$ begin
  alter table public.dev_tickets
    add constraint dev_tickets_attachments_is_array check (jsonb_typeof(attachments) = 'array');
exception when duplicate_object then null; end $$;

comment on column public.dev_tickets.attachments is
  'Files on the ticket: [{path, name, size, type}], path inside the private idea-attachments bucket. The dev-tickets function signs a link per read.';

-- The Claude connector reads through column grants it recomputes (0142).
select public.ai_reader_refresh_grants();
