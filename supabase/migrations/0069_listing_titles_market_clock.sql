-- ============================================================================
-- 0069 — the market pass needs its own clock, or it never covers the estate.
--
-- The sweep walks least-recently-swept first, which is right for the rules pass
-- and useless for the market one: the twice-daily rules-only cron (0068) stamps
-- `swept_at` on EVERY row, so it says nothing about when eBay was last asked.
--
-- Measured, not predicted: with market=1 ordering by `swept_at`, three
-- successive runs re-examined the SAME 120 rows and would have kept re-examining
-- them forever, while the other ~680 products at OVL were never asked about at
-- all. The open queue rows happened to carry a marginally earlier `swept_at`
-- than the clean ones — because the sweep stamped each row with its own
-- `new Date()` and wrote the findings batch first — so the queue kept putting
-- itself back at the head of the list. "Run it again to walk further" would have
-- been a false claim in the tool's own output.
--
-- Two fixes, and both were needed: this column, and one stamp per sweep RUN
-- instead of one per row (in the function).
--
-- Only the market pass may move `market_at`. A rules-only run that stamped it
-- would make eBay look freshly asked when nobody had asked.
-- ============================================================================

alter table public.listing_title_reviews
  add column if not exists market_at timestamptz;

-- nulls first, so anything never asked about is asked about first.
create index if not exists listing_title_reviews_market_idx
  on public.listing_title_reviews (store_code, market_at nulls first);
