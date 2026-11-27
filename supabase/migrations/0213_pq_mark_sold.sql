-- ============================================================================
-- 0213 — Picture check: Mark Sold (Ethan, 2026-11-27)
-- ============================================================================
-- "give an option for users to mark sold if the pictures got flagged but the
-- item has sold. This should still count against the lister, but should be able
-- to be removed from the list if sold and if ever brought back into stock
-- overnight (example a return), it should get regraded just not re-flagged."
--
-- Why it is needed: the 5-minute picture check grades IN-STOCK listings only, so
-- a flagged listing that sold was never graded again and its open row sat on the
-- store's list (and the lister's) for good, with nothing anyone could fix.
--
--   status 'sold'  off every list (they all read status = 'open'). The morning
--                  flag ledger (listing-review daily) reads every flagging
--                  verdict whatever its status and counts anything not
--                  'dismissed' — so a sold row STILL COUNTS against the lister.
--   sold_at/by     who said it sold, and when. ⚠️ Never cleared: picture-quality's
--                  saveRows does not send these columns, so after a return
--                  re-grade (status back to 'open') sold_at stays — that is how
--                  recordFlags knows not to flag the listing a second time, and
--                  how the lister pop-up feed (pq-news) knows to stay quiet.
--
-- The re-grade after a return: picture-quality's quick check reads every
-- status = 'sold' row (last 60 days — a 30-day return period, doubled) back from Shopify by id each run, and a
-- live, in-stock one is graded again whatever its age or photo stamp.
-- ============================================================================

alter table public.picture_quality_reviews drop constraint if exists picture_quality_reviews_status_check;
alter table public.picture_quality_reviews add constraint picture_quality_reviews_status_check
  check (status in ('open', 'dismissed', 'applied', 'sold'));

alter table public.picture_quality_reviews add column if not exists sold_at timestamptz;
alter table public.picture_quality_reviews add column if not exists sold_by text;

create index if not exists picture_quality_reviews_sold_idx
  on public.picture_quality_reviews (store_code, sold_at) where sold_at is not null;
