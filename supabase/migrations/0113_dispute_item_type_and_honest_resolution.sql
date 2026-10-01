-- 0113 — let a dispute actually BE reviewed, and stop a resolution outranking
-- the site that holds the money.
--
-- ============================================================================
-- THE BUG. 0102 wrote these constraints as (mismatch, ebay_case, chargeback).
-- 0112 named the new item type `dispute` instead — one table for eBay payment
-- disputes AND Shopify chargebacks, because to a manager they are the same
-- object — and did not migrate the constraints. So from 0112 until now, a
-- manager pressing "Mark resolved" on any dispute got a raw check-constraint
-- error. The tool could SHOW eight unanswered disputes and accept nothing a
-- manager did about them.
--
-- Worse, 0112's own comment asserted the opposite in writing: "hold_reviews /
-- hold_review_events need NO change to take 'dispute': item_type has never been
-- constrained (only `action` is)". That was checked for hold_review_events,
-- which is true, and then assumed for hold_reviews, which is not. The assumption
-- was written down as though it were a finding.
--
-- It survived testing because every POST that was tried came back refused for a
-- DIFFERENT reason and never reached the insert: `still_open` was stopped by the
-- answer-first gate, and `resolved` was stopped by the ten-character minimum.
-- Two green ticks on two paths that both fail early is not coverage of the path
-- that writes. (2026-09-23)
--
-- 'chargeback' is dropped rather than kept alongside: no row has ever used it,
-- and leaving a dead alias in a CHECK is how the next person ends up writing
-- the wrong one.
alter table public.hold_reviews drop constraint if exists hold_reviews_item_type_check;
alter table public.hold_reviews add constraint hold_reviews_item_type_check
  check (item_type in ('mismatch', 'ebay_case', 'dispute'));

alter table public.hold_claim_links drop constraint if exists hold_claim_links_item_type_check;
alter table public.hold_claim_links add constraint hold_claim_links_item_type_check
  check (item_type in ('mismatch', 'ebay_case', 'dispute'));

-- ============================================================================
-- A RESOLUTION NO LONGER OUTRANKS THE SITE (Ethan, 2026-09-23: "I don't want
-- them to be able to resolve something that isn't actually resolved and then
-- that money could just get lost in the wind").
--
-- No schema is needed for it — the rule lives in stateOf, where every other
-- visibility rule lives — but the reasoning belongs in the record:
--
--   While the site still wants a response AND will still accept one, a
--   manager's "resolved" is RECORDED and SHOWN but does not silence the item.
--   The card names who said it and what they said, next to the site's own
--   status. Two days later (RESOLUTION_GRACE_DAYS) it goes to the DM.
--
-- The honest uses are unaffected and correct themselves within a day: refunding
-- the buyer or accepting a dispute moves it off NEEDS_RESPONSE by itself, and
-- the item then settles. What is no longer possible is typing ten characters at
-- a live $899 chargeback and never hearing about it again.
--
-- The exception is a reply window that has already SHUT, where a resolution
-- does stand — there is nothing left to do but record the outcome, and holding
-- the item open would only nag about money that is already gone.
