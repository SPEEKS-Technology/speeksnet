-- ============================================================================
-- ebay_fee_month — what eBay charged each store, by KIND of fee, per month.
--
-- WHY (2026-10-02). Net Profit takes eBay fees off GP, and the fee is not one
-- rate. September, SALE lines only (ebay-fee-probe):
--     final value fee as % of eBay sales   OVL 7.59  WSP 7.85  LEE 8.14  MPL 9.17  BAL 9.15
--     "very high item not as described"    LEE $571  MPL $2,258  BAL $2,440
-- About 3 points of BAL's and MPL's gap is the INAD fee alone — eBay's surcharge
-- for a category whose not-as-described rate is very high against peers — and
-- the rest is category mix plus no Top Rated discount. Ethan wants that cost in
-- front of the stores, tied to the service metrics that drive it. The NP tab only
-- carries ONE eBay fee number, so the breakdown is collected here.
--
-- Filled by the ebay-fee-mix edge function (read-only Finances API, the same
-- GET-only guard as ebay-fee-probe) once a day at 3pm Central, after the 2pm NP
-- pass — it takes no Apps Script lock and touches nothing the NP chain reads.
-- One row per store-month, rewritten whole each run.
--
-- Fees are NET: a fee credited back on a refund (bookingEntry CREDIT) comes off
-- the kind it was charged as. ebay_sales is the fee basis of the month's SALE
-- lines — what eBay charges its percentage on, so fvf / ebay_sales is the store's
-- real final-value-fee rate, comparable between stores whatever their in-store
-- share. RLS on, no policy.
-- ============================================================================

create table if not exists public.ebay_fee_month (
  store        text        not null,
  ym           text        not null,          -- YYYY-MM (Central month, see ebay-fee-mix)
  ebay_sales   numeric,                       -- fee basis of SALE lines
  sale_lines   integer,
  fvf          numeric,                       -- FINAL_VALUE_FEE
  fvf_fixed    numeric,                       -- FINAL_VALUE_FEE_FIXED_PER_ORDER
  inad         numeric,                       -- HIGH_ITEM_NOT_AS_DESCRIBED_FEE
  inad_lines   integer,
  intl         numeric,                       -- INTERNATIONAL_FEE
  other        numeric,                       -- every other line fee kind
  by_type      jsonb,                         -- { feeType: net amount } — nothing is lost
  total        numeric,                       -- sum of the above, net
  synced_at    timestamptz not null default now(),
  primary key (store, ym)
);
alter table public.ebay_fee_month enable row level security;

comment on table public.ebay_fee_month is
  'eBay fees per store per month by fee type (net of refund credits), from the Finances API via ebay-fee-mix.';
