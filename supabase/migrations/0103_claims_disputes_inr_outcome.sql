-- ============================================================================
-- claims-disputes, round 2 — an item-not-received that we refunded needs a claim.
--
-- THE RULE (Ethan, 2026-09-22). An INR sits with the returns and cases, not in
-- the claims tool — it arrives from eBay on its own now. But if the buyer was
-- refunded, the money is only coming back through a carrier / Shopify claim, so
-- a refunded INR is not finished until a claim exists for it.
--
-- HOW "REFUNDED" IS KNOWN. Not from the search summaries, and not from the
-- refundAmounts block in the detail either — that read $0.00 on every OVL case
-- checked 2026-09-22, including ones where money plainly moved. Two signals
-- held up against all 34 OVL inquiries and cases:
--   inquiry  history action "Voluntary refund completed"  (seller refunded)
--   case     sellerOutcome = 'LOSE'                        (eBay ruled for the buyer)
-- claims-disputes reads each INR's detail until it closes, applies those, and
-- stores the answer here so it is decided once rather than re-derived per read.
--
-- WHY THE LINK IS ITS OWN TABLE and not a column on shopify_claims: that table
-- belongs to the shopify-claims function, which is live and whose deployed copy
-- is not verified against the repo. Adding a column there would mean changing
-- a function nobody asked to change. The link lives on this side instead, and
-- claims-disputes writes the claim row itself in the exact shape
-- shopify-claims' submit_claim does.
-- ============================================================================

alter table public.ebay_cases
  -- casemanagement mixes two things: an escalated RETURN and an escalated
  -- ITEM_NOT_RECEIVED. Only the second belongs with the INRs.
  add column if not exists case_type          text,
  -- 'refunded' | 'no_refund' once known; null while it can still change.
  add column if not exists outcome            text
    check (outcome is null or outcome in ('refunded', 'no_refund')),
  add column if not exists outcome_detail     text,
  add column if not exists detail_checked_at  timestamptz;

-- A claim opened (or picked) for an INR. Keyed by the eBay item, not the claim:
-- one refunded sale is one claim, but the same sale can appear twice — as the
-- inquiry and, after escalation, as the case — and a claim linked to either
-- covers both (matched on order_id in the function).
create table if not exists public.hold_claim_links (
  case_key    text        primary key,          -- ebay_cases.case_key
  store_code  text        not null,
  claim_id    uuid        not null,             -- shopify_claims.id
  linked_by   text,
  linked_at   timestamptz not null default now()
);

alter table public.hold_claim_links enable row level security;

-- Linking a claim is its own kind of history entry, not a "still open".
alter table public.hold_review_events drop constraint if exists hold_review_events_action_check;
alter table public.hold_review_events add constraint hold_review_events_action_check
  check (action in ('still_open', 'resolved', 'reopened', 'claim_linked'));
