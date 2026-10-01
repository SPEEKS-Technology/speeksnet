-- 0119 — the Payments tab: Shopify orders we have not been paid for yet.
--
-- Ethan, 2026-09-28, after checking the CFO's month-end list against the tool:
-- "I would call the tab Payments and then store those two things there." The two
-- things were LEE #MO01-9799 ("CC expiring") and #MO01-8907 ("partially
-- fulfilled") — the only two lines on that list with no eBay side at all, so
-- nothing in 0102-0118 could ever have seen them. Neither is a refund, a return
-- or a dispute. Both are the same simpler fact: Shopify says money is still owed
-- on the order.
--
-- WHAT SHOPIFY ACTUALLY SAYS, read 2026-09-28 across all five stores:
--   - A web order is AUTHORIZED when placed and CAPTURED when fulfilled. The
--     card authorization lasts 7 days (authorizationExpiresAt). 17 orders were
--     sitting authorized that morning, all under a week old — that is the
--     normal flow, not a problem, which is why stateOf holds these back until
--     the authorization is close to running out.
--   - #MO01-9799 ($16.26) was one of them, on its LAST day: authorized 9/21,
--     expiring 9/28 21:57Z, unfulfilled.
--   - #MO01-8907 ($244.03) is PARTIALLY_PAID: two of three items shipped and
--     were captured ($147.50); the third (an Acer Chromebook) is on hold, and
--     its $28.20 re-authorization expired 9/17. Shopify can no longer charge it.
--   - Two more the CFO's list did NOT have: WSP #MO02-6808 ($452.93, EXPIRED
--     9/1, never fulfilled) and LEE #MO01-9243 ($32.99, a draft order, EXPIRED
--     9/14).
--
-- ⚠️ totalOutstanding IS NOT "MONEY WE HAVEN'T GOT". On an authorized order it
-- reads $0.00 — Shopify counts the authorization as covering it. #MO01-9799 read
-- outstanding 0.0 with capturable 16.26. So what is owed is outstanding PLUS
-- capturable, and both are stored; reading outstanding alone would have missed
-- the one order on the CFO's list that was about to be lost that afternoon.
--
-- Read-only against Shopify, like every other table in this feature: a manager
-- charges, cancels or refunds on Shopify by hand, and the next read clears it.
create table if not exists public.unpaid_orders (
  order_key          text        primary key,        -- '<store>:<Shopify legacy order id>'
  store_code         text        not null,
  order_id           text        not null,           -- Shopify legacy id, for the admin link
  order_name         text,                           -- #MO01-9799 — what the CFO and the manager search for
  source_name        text,                           -- web / pos / shopify_draft_order
  item_title         text,                           -- the first item still waiting to ship, or the first item
  unfulfilled_items  integer,

  total              numeric,
  outstanding        numeric,                        -- Shopify's totalOutstanding (0 while merely authorized)
  capturable         boolean     not null default false,
  capturable_amount  numeric,
  received           numeric,
  amount             numeric,                        -- what is owed: outstanding + capturable_amount
  currency           text,

  financial_status   text,                           -- AUTHORIZED / PARTIALLY_PAID / PENDING / EXPIRED
  fulfillment_status text,                           -- UNFULFILLED / ON_HOLD / PARTIALLY_FULFILLED …
  ordered_at         timestamptz,
  -- The latest successful authorization's expiry. The deadline for a card that
  -- can still be charged; history for one that cannot.
  auth_expires_at    timestamptz,

  is_open            boolean     not null default true,
  closed_at          timestamptz,
  -- Why it left: paid / cancelled / refunded / voided — whatever Shopify said
  -- when the order stopped matching the sweep.
  outcome            text,

  raw                jsonb,
  first_seen         timestamptz not null default now(),
  last_synced        timestamptz not null default now()
);

create index if not exists unpaid_orders_store_idx
  on public.unpaid_orders (store_code, is_open, auth_expires_at);

-- Per store, like ebay_case_sync. Its own table rather than a row in
-- dispute_sync, because the front end words a failed dispute read as "Couldn't
-- read disputes" and a failed payments read must not say that.
create table if not exists public.unpaid_order_sync (
  store_code  text        primary key,
  synced_at   timestamptz not null default now(),
  ok          boolean     not null default true,
  detail      text
);

-- hold_reviews IS constrained on item_type (0102's check, widened by 0113), and
-- 0112 shipped without widening it — "Mark resolved" on every dispute threw a
-- constraint error for a day. So 'payment' goes in here, now, and is checked
-- before the function that writes it is deployed.
--
-- hold_claim_links is deliberately NOT widened: a claim recovers money a
-- carrier or Shopify insurance owes us, and nobody owes us an uncharged card.
-- claims-disputes refuses open_claim/link_claim for anything but an INR or a
-- mismatch, so the constraint and the function agree.
alter table public.hold_reviews drop constraint if exists hold_reviews_item_type_check;
alter table public.hold_reviews add constraint hold_reviews_item_type_check
  check (item_type = any (array['mismatch', 'ebay_case', 'dispute', 'payment']));

-- Service-role only: RLS on, no policy. Everything reaches these through the
-- claims-disputes edge function.
alter table public.unpaid_orders     enable row level security;
alter table public.unpaid_order_sync enable row level security;
