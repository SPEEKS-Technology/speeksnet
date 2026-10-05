-- 0106 — what the carrier says, and the order number Seller Hub shows.
--
-- TRACKING. Ethan, 2026-09-22: "for the INR, we should throw in here as well to
-- see if it has since been delivered ... because we can get our money back from
-- eBay without a claim if it ends up getting delivered." An inquiry's (and an
-- escalated case's) detail carries the seller's shipment tracking, including a
-- currentStatus that reads DELIVERED / IN_TRANSIT / MANIFEST. A refunded INR
-- whose parcel later shows DELIVERED is money eBay itself may give back, so it
-- is worth saying so before anyone files a carrier claim. Re-read while it
-- matters: an INR is only finished once it is delivered or paid for.
--
-- ORDER NUMBER. Inquiries and cases name only "<itemId>-<transactionId>", which
-- is not what Seller Hub calls the order. ebay_orders cannot answer (it is
-- frozen at 2026-08-25), so the number is read once from the Fulfillment API's
-- getOrder, which accepts the legacy id, and kept here. '' means "asked, eBay
-- had no answer" so it is not asked again every sweep.
alter table public.ebay_cases add column if not exists tracking_number text;
alter table public.ebay_cases add column if not exists tracking_carrier text;
alter table public.ebay_cases add column if not exists tracking_status text;
alter table public.ebay_cases add column if not exists tracking_at timestamptz;
alter table public.ebay_cases add column if not exists order_no text;
