-- 0174: a return settled for less than a full refund can be checked against
-- Shopify (Ethan, 2026-11-05: "as long as the eBay partial refund and Shopify
-- show the same partial refund, that should be resolved and marked as good").
--
-- claims-disputes' checkPartialRefund writes the answer to the return's own
-- outcome / outcome_detail, which a return never used before (readOutcome
-- leaves returns alone). The old check allowed only the two INR/case outcomes,
-- so the first deploy's writes were refused — and the function, not checking
-- the update's error, reported "1/1 match Shopify" for a row it never saved.
--   partial_matched    eBay's seller refund = Shopify's total refunded (to the cent)
--   partial_unmatched  they differ, or the Shopify order couldn't be found
alter table public.ebay_cases drop constraint if exists ebay_cases_outcome_check;
alter table public.ebay_cases add constraint ebay_cases_outcome_check
  check (outcome is null or outcome = any (array['refunded', 'no_refund', 'partial_matched', 'partial_unmatched']));
