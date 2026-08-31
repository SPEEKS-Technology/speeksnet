-- Listing Titles: the name check's own clock.
--
-- The only model-backed finding in the tool asks a question that costs money, so
-- unlike every other pass it must never re-ask something it has already asked.
-- `asked_title` stores ASK_RECIPE plus the EXACT title the model was shown; a
-- listing needs asking when that stamp does not match the title it has now.
--
-- Two consequences, both deliberate:
--   * a new listing has no stamp and sorts first; an edited title stops matching
--     and comes back round; an untouched listing is never paid for twice
--   * bumping ASK_RECIPE in the edge function re-asks the whole estate on its
--     own, which is what makes adding metafields later a backfill rather than a
--     wiped table
--
-- Deliberately NOT a hash: the value is readable in the table, so when a verdict
-- looks wrong you can see exactly what it was given.
--
-- ⚠️ `asked_at` is an observability clock only. Nothing decides on it — a
-- timestamp cannot tell you the title changed underneath it, which is the whole
-- question here.

alter table public.listing_title_reviews
  add column if not exists asked_title text,
  add column if not exists asked_at    timestamptz;

comment on column public.listing_title_reviews.asked_title is
  'ASK_RECIPE || ''|'' || the exact title shown to the name check. Mismatch with current_title means this listing has never been asked about under its present title.';
comment on column public.listing_title_reviews.asked_at is
  'When the name check last answered for this listing. Observability only; asked_title is what decides.';

-- The queue view is unchanged: these columns feed the sweep's ordering, not the
-- panel. Redefining it here would risk the ebay-scope rule in 0070 for nothing.
