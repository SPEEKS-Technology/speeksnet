-- ============================================================================
-- claims-disputes — the manager side of "our money is held or not lining up".
--
-- THE PROBLEM. refund-mismatch (0089) can tell a manager an order is reversed on
-- one marketplace and not the other, but it cannot be TOLD anything back. The
-- first week proved why that matters: OVL refunded an eBay order, filed a
-- Shopify insurance claim for the damage instead of refunding Shopify, won the
-- claim — and the order is completely fine. The detector will call it a
-- mismatch forever, because by the only rule it knows, it is one. Only a person
-- knows it is settled, so a person has to be able to say so, and say why.
--
-- The same is true of everything else that holds our money: eBay return /
-- item-not-received / not-as-described cases, eBay payment disputes, Shopify
-- chargebacks. Each is open on a marketplace until it isn't, and each needs a
-- manager to keep saying "still being worked" or "done, here's why".
--
-- WHY THE MANAGER'S WORD LIVES IN ITS OWN TABLE. refund_mismatch_state is
-- written by the detector on every run — it upserts the row and sets
-- resolved_at when both sites agree. If the manager's decision were a column on
-- that row, the next 8:20 run would be one careless upsert away from wiping it.
-- So the detector owns what the MARKETPLACES say (refund_mismatch_state,
-- ebay_cases) and the managers own what a PERSON says (hold_reviews). Neither
-- ever writes the other's table.
--
-- TWO WORDS FOR "RESOLVED", DELIBERATELY KEPT APART.
--   refund_mismatch_state.resolved_at  the detector saw both sites agree
--   hold_reviews.status = 'resolved'   a manager says it is settled, with a reason
-- The tool shows both, and never lets one stand in for the other: "the numbers
-- now match" and "a manager signed off on it not matching" are different facts,
-- and leadership needs to be able to tell which one closed a given order.
--
-- IDENTITY. by_name is the free-text display name from sessionStorage, like
-- every other attribution in this schema (see CLAUDE.md, "Identity"). It is a
-- record of who clicked, not proof.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- eBay cases, as eBay reports them. Filled by claims-disputes ?action=sync from
-- the Post-Order API: returns, item-not-received inquiries, and escalated cases.
-- One row per eBay object; `kind` + its eBay id is the key, because a return
-- and an inquiry can share a numeric id.
-- ----------------------------------------------------------------------------
create table if not exists public.ebay_cases (
  case_key       text primary key,            -- '<kind>:<ebay id>'
  store_code     text        not null,
  -- 'return'   Post-Order return (incl. not-as-described returns)
  -- 'inquiry'  item-not-received inquiry
  -- 'case'     escalated to eBay (casemanagement)
  -- 'dispute'  eBay payment dispute   (needs sell.payment.dispute — phase 2)
  kind           text        not null
    check (kind in ('return', 'inquiry', 'case', 'dispute')),
  ebay_id        text        not null,
  order_id       text,
  item_id        text,
  item_title     text,
  buyer          text,
  reason         text,                         -- eBay's reason code, as sent
  ebay_status    text,                         -- eBay's state, as sent
  -- Our reading of ebay_status: is money still in question? Kept as its own
  -- column so the rule is applied once, in the sync, not re-derived by every
  -- reader from a status vocabulary that differs per endpoint.
  is_open        boolean     not null default true,
  amount         numeric,
  currency       text,
  opened_at      timestamptz,
  respond_by     timestamptz,                  -- seller deadline, when eBay gives one
  closed_at      timestamptz,                  -- first sync that saw it closed
  first_seen     timestamptz not null default now(),
  last_synced    timestamptz not null default now(),
  raw            jsonb                          -- the summary eBay sent, for debugging
);

create index if not exists ebay_cases_store_open_idx
  on public.ebay_cases (store_code, opened_at) where is_open;

comment on table public.ebay_cases is
  'eBay returns / INR inquiries / escalated cases per store, as last read from the '
  'Post-Order API by claims-disputes. Read-only mirror; nothing here acts on eBay.';

-- When each store was last swept, so the tool can say how fresh the list is
-- and skip a sweep that ran minutes ago.
create table if not exists public.ebay_case_sync (
  store_code   text primary key,
  synced_at    timestamptz not null,
  ok           boolean     not null,
  detail       text
);

-- ----------------------------------------------------------------------------
-- What a manager last said about an item. One row per item, any type.
--
-- item_key is the owning table's own key — refund_mismatch_state.issue_key for
-- a mismatch, ebay_cases.case_key for a case — so a review joins to its item
-- without a surrogate id.
--
-- next_checkin_at is the check-in timer: "Still open" pushes it forward by the
-- type's interval, and an item past it is "check-in due". It is stored rather
-- than computed so the interval in force WHEN THE MANAGER CLICKED is what
-- counts — changing the interval later must not silently make a hundred
-- reviewed items overdue at once.
-- ----------------------------------------------------------------------------
create table if not exists public.hold_reviews (
  item_type        text        not null
    check (item_type in ('mismatch', 'ebay_case', 'chargeback')),
  item_key         text        not null,
  store_code       text        not null,
  status           text        not null
    check (status in ('still_open', 'resolved')),
  note             text,
  by_name          text,
  updated_at       timestamptz not null default now(),
  next_checkin_at  timestamptz,                -- null once resolved
  primary key (item_type, item_key),
  -- A resolution is a claim that money which looks wrong is actually fine, so
  -- it has to say why. Enforced here as well as in the tool and the function:
  -- this is the one rule the business asked for by name, and a check the
  -- database holds cannot be skipped by a future caller that forgets it.
  -- "Still open" needs no note — the click itself is the check-in.
  constraint hold_reviews_resolved_needs_reason
    check (status <> 'resolved' or length(btrim(coalesce(note, ''))) >= 10)
);

-- Every click, kept. The current row above answers "where does it stand"; this
-- answers "who said what, when" — the part leadership reviews.
create table if not exists public.hold_review_events (
  id          bigserial   primary key,
  item_type   text        not null,
  item_key    text        not null,
  store_code  text        not null,
  action      text        not null
    check (action in ('still_open', 'resolved', 'reopened')),
  note        text,
  by_name     text,
  at          timestamptz not null default now()
);

create index if not exists hold_review_events_item_idx
  on public.hold_review_events (item_type, item_key, at desc);

-- Service-role only, like refund_mismatch_state: RLS on, no policy. Everything
-- reaches these tables through the claims-disputes edge function.
alter table public.ebay_cases          enable row level security;
alter table public.ebay_case_sync      enable row level security;
alter table public.hold_reviews        enable row level security;
alter table public.hold_review_events  enable row level security;
