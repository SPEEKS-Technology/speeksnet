-- 0112 — payment disputes and chargebacks, and whether we answered them.
--
-- Ethan, 2026-09-22: "Payment disputes on eBay / Chargeback actively open on
-- shopify / Can you see if we have responded to cases and payment disputes on
-- eBay and shopify chargebacks? This would be another layer of checks and
-- balances that would get the managers to do things properly."
--
-- ONE TABLE FOR BOTH SITES, because to a manager they are the same object: a
-- buyer went to their bank or to eBay, our money is held, there is a HARD
-- deadline, and either we have answered it or we have not. Only the place you
-- go to answer differs, and that is a link, not a schema. The alternative —
-- ebay_payment_disputes plus shopify_disputes — would have meant writing the
-- "have we responded" rule twice, which is the exact mistake 0107 made with
-- author/actor and paid for.
--
-- WHY THIS EXISTS AT ALL, from the first read on 2026-09-23: seven open
-- disputes worth $2,168.36 across four stores, and NOT ONE had evidence
-- submitted. Two were due that same afternoon. OVL #KS01-13765 ($102) had
-- already been lost outright the day before with no response ever sent — the
-- only LOST dispute of twelve with no evidenceSentOn. Meanwhile all ten WON
-- disputes had evidence sent. Answering is the whole game.
--
-- "HAVE WE ANSWERED" IS THE PLATFORM'S WORD, NOT OURS. Same principle as 0108:
-- the tool never asks a human to certify that they responded. Both sites say it
-- themselves, though not in the same place:
--   Shopify  status NEEDS_RESPONSE, and evidenceSentOn once evidence is in
--   eBay     sellerResponse on the dispute DETAIL — SELLER_CONTEST /
--            SELLER_ACCEPT once answered, SELLER_RESPONSE_OVERDUE if the window
--            shut first, absent while it is still our move. (The documented
--            ACTION_NEEDED status does not appear on live data: all six open
--            disputes on 2026-09-23 read plain OPEN, so the status alone tells
--            you nothing and only the detail answers the question.)
-- Both are read, never written. There is deliberately no "I answered it" button
-- — 0107 built one of those and 0108 removed it the same afternoon.
create table if not exists public.payment_disputes (
  dispute_key   text        primary key,          -- 'ebay:<id>' / 'shopify:<legacy id>'
  source        text        not null check (source in ('ebay', 'shopify')),
  external_id   text        not null,
  store_code    text        not null,

  -- What sale, in the words the manager will search the site for.
  order_no      text,                             -- Shopify order name / eBay order id
  order_id      text,                             -- the raw id the API uses
  item_title    text,
  buyer         text,

  amount        numeric,
  currency      text,
  -- CHARGEBACK vs INQUIRY on Shopify; eBay's disputes are all chargeback-like.
  -- An inquiry is the bank asking before it pulls the money, and it is the
  -- cheapest one to win, so it is shown, not filtered out.
  dispute_type  text,
  reason        text,
  reason_code   text,                             -- the card network's own code

  status_raw    text,                             -- exactly what the site said
  is_open       boolean     not null default true,
  -- THE GATE. true = the site is waiting on evidence from us.
  needs_response boolean    not null default false,
  -- When the site says we answered. NULL while needs_response is true, always.
  responded_at  timestamptz,

  opened_at     timestamptz,
  respond_by    timestamptz,                      -- the deadline, and it is real
  closed_at     timestamptz,
  outcome       text,                             -- won / lost / accepted / prevented

  raw           jsonb,
  first_seen    timestamptz not null default now(),
  last_synced   timestamptz not null default now()
);

create index if not exists payment_disputes_store_idx
  on public.payment_disputes (store_code, is_open, respond_by);
create index if not exists payment_disputes_open_idx
  on public.payment_disputes (needs_response) where needs_response;

-- Per store AND per source: eBay can be failing while Shopify is fine, and a
-- single row per store would hide that. Mirrors ebay_case_sync otherwise.
create table if not exists public.dispute_sync (
  store_code  text        not null,
  source      text        not null,
  synced_at   timestamptz not null default now(),
  ok          boolean     not null default true,
  detail      text,
  primary key (store_code, source)
);

-- hold_reviews / hold_review_events need NO change to take 'dispute': item_type
-- has never been constrained (only `action` is), and both tables are keyed on
-- (item_type, item_key), so a dispute review slots in beside a mismatch and an
-- ebay_case with nothing to migrate.

-- Service-role only, like every other table in this feature: RLS on, no policy.
-- Everything reaches these through the claims-disputes edge function.
alter table public.payment_disputes enable row level security;
alter table public.dispute_sync     enable row level security;

-- Applied as 0112b. eBay's payment_dispute_summary is far too thin to answer
-- the only question that matters: it gives status OPEN and nothing else — no
-- deadline, no sign of whether we replied. The per-dispute detail carries
-- `sellerResponse` and `availableChoices`, so disputes get a detail pass of
-- their own, exactly like inquiries and cases do.
--
-- SELLER_RESPONSE_OVERDUE is its own outcome and the reason response_overdue
-- exists. MPL dispute 5010444789 ($459.99) reads it: nobody answered, the
-- window shut, and availableChoices is empty because it is now too late. That
-- is NOT "answered", and it must not be shown as though it were — but it also
-- cannot be fixed by responding, so the card and the refusal message have to
-- say something different from the ones that are merely waiting.
alter table public.payment_disputes add column if not exists seller_response text;
alter table public.payment_disputes add column if not exists response_overdue boolean not null default false;
alter table public.payment_disputes add column if not exists detail_checked_at timestamptz;
