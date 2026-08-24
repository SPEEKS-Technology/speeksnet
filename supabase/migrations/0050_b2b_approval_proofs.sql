-- ============================================================================
-- Proof that the client actually approved.
--
-- The dispute this exists for: a client says they never agreed to the price, and
-- the only thing on file is that somebody here ticked "accepted". That tick is
-- our word. This stores theirs -- the email, or a screenshot of it.
--
-- Modelled on the pickup signature (0022), which answers the same question one
-- stage earlier and has proven out: a PRIVATE bucket, the path on the row rather
-- than a URL, and the bytes streamed back through the edge function. A signed
-- URL is deliberately avoided -- it is a link that keeps working after it leaves
-- the page, and evidence about a named client is the last thing that should.
--
-- WHY BODY TEXT AS WELL AS A FILE. A pasted email is usually BETTER evidence
-- than a screenshot of one: it carries the headers, the address it came from and
-- the date, none of which survive a crop. It is also far easier to capture, and
-- evidence that is easy to capture is evidence that actually gets captured.
--
-- WHY IT HANGS OFF EITHER A DEAL OR AN EVALUATION. An accepted evaluation
-- converts into a deal at exactly those prices, so "we never agreed to that" is
-- the same dispute one stage earlier. One table with two nullable owners rather
-- than two tables: the reader, the upload path and the streaming route are
-- identical, and splitting them would mean the same evidence rules maintained in
-- two places.
--
-- REMOVAL IS A TOMBSTONE, NOT A DELETE. Someone will eventually attach the wrong
-- thing, so removal has to exist. But an evidence log that can be quietly pruned
-- is worth much less in the argument it exists for. A removal marks the row and
-- keeps the file: the entry stops counting, and the fact that something was
-- withdrawn, by whom and why, is permanent.
--
-- ORDERING: entirely additive -- new table, new bucket, new nullable columns.
-- The part that is NOT safe ahead of the code is the acceptance gate, which
-- lives in the edge function and ships with the UI that lets people satisfy it.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

create table if not exists public.b2b_approval_proofs (
  id        uuid primary key default gen_random_uuid(),
  deal_id   uuid references public.b2b_deals(id)   on delete cascade,
  preval_id uuid references public.b2b_prevals(id) on delete cascade,

  kind text not null default 'email'
    check (kind in ('email', 'screenshot', 'document', 'note')),
  label     text,
  from_addr text,
  sent_on   date,

  body_text text,
  file_path text,
  mime      text,
  bytes     int,

  added_by text not null,
  added_at timestamptz not null default now(),

  removed_at     timestamptz,
  removed_by     text,
  removed_reason text,

  -- Exactly one owner. Neither would orphan it; both would make "whose evidence
  -- is this" unanswerable at the moment it matters most.
  constraint b2b_proof_one_owner check (num_nonnulls(deal_id, preval_id) = 1),
  -- Something has to be on it. An empty proof is worse than no proof: it looks
  -- like evidence in a list and collapses the moment anyone opens it.
  constraint b2b_proof_has_content check (
    coalesce(btrim(body_text), '') <> '' or file_path is not null),
  -- A removal with no name and no reason is indistinguishable from tampering,
  -- which is exactly the accusation this table exists to answer.
  constraint b2b_proof_removal_explained check (
    removed_at is null
    or (coalesce(btrim(removed_by), '') <> ''
        and coalesce(btrim(removed_reason), '') <> '')),
  constraint b2b_proof_text_len check (
    length(coalesce(label, '')) <= 200 and
    length(coalesce(from_addr, '')) <= 200 and
    length(coalesce(body_text, '')) <= 100000 and
    length(coalesce(removed_reason, '')) <= 1000)
);

create index if not exists b2b_proofs_deal_idx   on public.b2b_approval_proofs (deal_id);
create index if not exists b2b_proofs_preval_idx on public.b2b_approval_proofs (preval_id);

-- The recorded reason for accepting WITHOUT proof. Exactly the shape
-- signature_skipped_by / _reason takes on a pickup, for the same reason: a
-- client can genuinely approve by phone or across a counter, and refusing to
-- record that would push people into attaching something meaningless.
alter table public.b2b_deals
  add column if not exists approval_waived_by     text,
  add column if not exists approval_waived_reason text;

alter table public.b2b_prevals
  add column if not exists approval_waived_by     text,
  add column if not exists approval_waived_reason text;

alter table public.b2b_deals
  drop constraint if exists b2b_deals_waiver_explained;
alter table public.b2b_deals
  add constraint b2b_deals_waiver_explained
  check (approval_waived_by is null
         or coalesce(btrim(approval_waived_reason), '') <> '');

alter table public.b2b_prevals
  drop constraint if exists b2b_prevals_waiver_explained;
alter table public.b2b_prevals
  add constraint b2b_prevals_waiver_explained
  check (approval_waived_by is null
         or coalesce(btrim(approval_waived_reason), '') <> '');

-- Private, like b2b-signatures. 10MB rather than 2: a screenshot of a long email
-- thread or a PDF export is bigger than a signature scribble. message/rfc822 is
-- a saved .eml, which is the best-quality evidence anyone here is likely to
-- produce.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('b2b-proofs', 'b2b-proofs', false, 10485760,
        array['image/png', 'image/jpeg', 'image/webp', 'application/pdf',
              'message/rfc822', 'text/plain'])
on conflict (id) do nothing;

revoke all on public.b2b_approval_proofs from anon, authenticated;
alter table public.b2b_approval_proofs enable row level security;
