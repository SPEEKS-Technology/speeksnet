-- Live bench intake: a capture tool running on the machine being tested posts
-- its own specs to the deal that is open on the pricing sheet, instead of the
-- results travelling by USB and being retyped.
--
-- Two tables, and the split matters. A SESSION is the pricer saying "for the
-- next while, machines may report into this deal" -- it is the credential, it is
-- scoped to one deal, and it can be closed. A SUBMISSION is one machine's
-- reading, and it lands INERT: nothing reaches b2b_deal_items until a person
-- accepts it. That is deliberate. The bench is a shared, unattended network and
-- a line item is money; the accept step is what makes an anonymous POST safe.
--
-- Nothing here changes the existing paths. A deal with no session behaves
-- exactly as it always has, and the manual sheet and the USB/collate route are
-- untouched. This is an option, not a replacement.

create table public.b2b_intake_sessions (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references public.b2b_deals(id) on delete cascade,

  -- What the bench operator types into the capture tool. Short enough to read
  -- off a screen and key in without a mistake, which is why the alphabet that
  -- generates it drops 0/O and 1/I/L (see b2b-intake). Unique across all time,
  -- not merely among open sessions: a code that has ever meant something must
  -- never come to mean something else, or a stale USB stick left running posts
  -- last Tuesday's pallet into today's deal.
  code        text not null unique,

  status      text not null default 'open' check (status in ('open', 'closed')),
  opened_by   text,
  created_at  timestamptz not null default now(),

  -- A session nobody closed must not stay open forever. The bench goes home;
  -- the credential should not still be live in the morning.
  expires_at  timestamptz not null,
  closed_at   timestamptz
);

-- One open session per deal. Two would mean two live codes for one pallet and
-- no way for a pricer to know which stick is talking to which. Enforced as a
-- partial unique index because CLOSED sessions are history and may pile up.
create unique index b2b_intake_sessions_one_open_per_deal
  on public.b2b_intake_sessions (deal_id)
  where status = 'open';

create index b2b_intake_sessions_deal_idx on public.b2b_intake_sessions (deal_id);

create table public.b2b_intake_submissions (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.b2b_intake_sessions(id) on delete cascade,

  -- The machine's own serial, lifted out of the payload because everything
  -- interesting keys on it: it is how a re-test replaces rather than duplicates,
  -- and it is what gets appended to the line's serial pool on accept.
  serial       text not null,

  -- The capture tool's JSON, whole and unaltered. Stored rather than shredded
  -- into columns on purpose: the tool will grow fields faster than this schema
  -- can chase them, and a submission that was accepted six weeks ago should
  -- still be able to answer what the machine actually reported.
  payload      jsonb not null,

  device       text,
  status       text not null default 'pending'
                 check (status in ('pending', 'accepted', 'rejected')),

  -- Which line it became. Null while pending, null if rejected, and null again
  -- if that line is later deleted -- the submission survives as a record of what
  -- was reported either way.
  item_id      uuid references public.b2b_deal_items(id) on delete set null,

  decided_by   text,
  decided_at   timestamptz,
  received_at  timestamptz not null default now()
);

-- A bench machine that gets re-tested (a wipe, a second opinion, a tester who
-- fat-fingered the condition) must UPDATE its pending row, not add a second one.
-- Without this, two readings of one laptop become two line items and the pallet
-- is overcounted -- the exact error the serial pool exists to prevent.
create unique index b2b_intake_submissions_one_per_serial
  on public.b2b_intake_submissions (session_id, serial);

create index b2b_intake_submissions_pending_idx
  on public.b2b_intake_submissions (session_id, status);

-- Same posture as every other table here: RLS on, no policies, and all access
-- through the service-role b2b-intake function. The anon client never touches
-- these directly, which is what stops the join code being brute-forced against
-- the database rather than against the function's own rate limiting.
alter table public.b2b_intake_sessions    enable row level security;
alter table public.b2b_intake_submissions enable row level security;
