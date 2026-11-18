-- 0177 — re-check delivered refunded INRs that were accepted on Shopify alone
-- (2026-11-06, data only).
--
-- From today a refunded INR the carrier says was DELIVERED is backed only by
-- eBay's payouts (claims-disputes verifyRefundedInr): the device is in the
-- buyer's hands, so a Shopify "restocked" is the refund checkbox or — at BAL —
-- another product on a shared SKU. Before this, two BAL resolutions were
-- accepted on that restock alone while eBay's payouts still showed the money
-- out, and an "agrees" verdict is never re-read, so if eBay never paid nothing
-- would have said so:
--   case:5388587198      $27.99  "eBay gave us our money back. Said it will
--                                 take 24-48 hours to confirm"
--   inquiry:5388460438   $49.99  "delivered back to the store and resold it"
-- Clearing the verdict puts them back in recheckResolutions' queue, which reads
-- them again under the new rule on the next sweep. Nothing else changes: the
-- resolution, its note and who wrote it stay as they are.
update hold_reviews r
set fact_verdict = null, fact_why = null, fact_checked_at = null
from ebay_cases c
where r.item_type = 'ebay_case'
  and r.item_key = c.case_key
  and r.status = 'resolved'
  and r.dm_status is null
  and r.fact_verdict = 'agrees'
  and c.outcome = 'refunded'
  and c.tracking_status ilike '%DELIVERED%'
  and c.tracking_status not ilike '%RETURN%'
  and coalesce(r.fact_evidence->'ebay'->>'ok', '') <> 'true';
