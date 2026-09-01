-- ============================================================================
-- LISTING TITLES — WHAT A DENIAL ACTUALLY MEANT
--
-- Deny was one button carrying two opposite meanings, and stored neither.
--
-- On a name or spec finding, Deny means "the rule is wrong — this title is
-- fine". That is feedback about US, and a rule collecting denials is a rule to
-- go and fix.
--
-- On a title-drift finding it means nothing of the sort. That row is not a
-- claim the title is wrong; it is a claim that Shopify and eBay disagree, and
-- the reviewer's answer is usually "our title is right, the eBay copy is the
-- stale one" — which is not the rule being wrong, it is the rule being RIGHT
-- and the fix living somewhere this tool cannot reach. Counting those two
-- together would make every rule look broken in proportion to how often
-- Marketplace Connect failed to sync.
--
-- So the answer is recorded, not just the fact of a denial:
--   'not-a-problem' — the finding was wrong, the title is fine as it is
--   'ebay-stale'    — the title here is right; the eBay copy needs correcting
--
-- Older rows keep NULL, which reads as "denied before we asked the question".
-- ============================================================================

alter table public.listing_title_reviews
  add column if not exists decided_as text;

alter table public.listing_title_reviews
  drop constraint if exists listing_title_reviews_decided_as_ck;

alter table public.listing_title_reviews
  add constraint listing_title_reviews_decided_as_ck
  check (decided_as is null or decided_as in ('not-a-problem', 'ebay-stale'));

comment on column public.listing_title_reviews.decided_as is
  'Which answer a Deny was: not-a-problem (the finding was wrong) or ebay-stale '
  '(our title is right, the eBay copy needs correcting). NULL on rows denied '
  'before 2026-09-01, when Deny was one undifferentiated button.';

-- The queue view is status='open' only, so denied rows are invisible to it by
-- design. The Denied drawer reads the table directly through the edge function,
-- which is why nothing here needs a second view: one index makes that read cheap.
create index if not exists listing_title_reviews_denied_idx
  on public.listing_title_reviews (store_code, decided_at desc)
  where status = 'denied';
