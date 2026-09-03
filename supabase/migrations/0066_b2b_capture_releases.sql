-- Version history for the SPEEKS Capture bench tool.
--
-- The tool is a 35KB zip that MOCD maintains and the bench downloads. It was
-- shipping as a static file in the repo, which meant every update needed a
-- commit, a merge through pre-release, and someone with push access -- so in
-- practice it would not get updated, or it would get updated by handing a stick
-- round, which is how two benches end up on two different tools.
--
-- So it lives here instead. It is small enough that a table plus a private
-- bucket is the whole of the infrastructure it needs.
--
-- THE POINT OF THIS TABLE IS THAT NOTHING IS EVER OVERWRITTEN. Each upload is a
-- new immutable object in the bucket and a new row here; "which one is live" is
-- a pointer (is_current) that can be moved back. A broken tool cannot destroy
-- the one that worked -- it can only take the pointer, and taking it back is one
-- click. That is the entire backup story and it is deliberately that simple.
create table public.b2b_capture_releases (
  id          uuid primary key default gen_random_uuid(),

  -- The label the uploader types. Free text on purpose: MOCD may version this
  -- "1.2.0", or "2026-09-04 panel fix", and forcing semver on a bench tool
  -- would only mean people fight the field. Unique case-insensitively, so two
  -- uploads cannot both claim to be "1.2.0" and leave nobody able to say which
  -- stick has which.
  version     text not null,
  notes       text,

  -- Immutable storage path. Timestamped, so an upload can never land on top of
  -- an earlier one even if the version label repeats after a delete.
  file_path   text not null unique,
  -- What the browser saves it as.
  file_name   text not null,
  size_bytes  integer not null check (size_bytes > 0),

  -- So "is the zip on this stick the one the sheet is serving" has an answer
  -- without unzipping anything. Printed in the history list.
  sha256      text not null,

  uploaded_by text,
  uploaded_at timestamptz not null default now(),

  -- Exactly one row may be current; see the index below.
  is_current  boolean not null default false
);

-- At most one live version. A partial unique index rather than a trigger: the
-- constraint is the same shape as the question being asked, and promoting a
-- version is then a clear-then-set inside one statement pair.
create unique index b2b_capture_releases_one_current
  on public.b2b_capture_releases (is_current)
  where is_current;

-- Two uploads cannot both be "1.2.0".
create unique index b2b_capture_releases_version_uniq
  on public.b2b_capture_releases (lower(version));

create index b2b_capture_releases_recent_idx
  on public.b2b_capture_releases (uploaded_at desc);

-- Private bucket, same posture as b2b-proofs and b2b-signatures: nothing is
-- served straight from storage, every read goes through the function.
-- 20MB ceiling against a 35KB artefact is deliberate headroom -- the cost of
-- being wrong the other way is MOCD unable to ship a tool that grew.
--
-- The mime list is what a zip actually arrives as across browsers and
-- PowerShell's Compress-Archive; application/x-zip-compressed is what Windows
-- reports and leaving it out would reject the exact file we expect.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('b2b-capture', 'b2b-capture', false, 20971520,
        array['application/zip', 'application/x-zip-compressed',
              'application/octet-stream'])
on conflict (id) do nothing;

revoke all on public.b2b_capture_releases from anon, authenticated;
alter table public.b2b_capture_releases enable row level security;
