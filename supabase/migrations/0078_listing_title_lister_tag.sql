-- ============================================================================
-- 0078 — Listing Titles: who listed it.
--
-- Shopify product tags carry the lister's initials beside the channel tags:
-- `eBay`, `CMeadows`. Ethan, 2026-09-04: "we have tags to show employee names.
-- Can we show next to the Shopify listing link that tag, so we know who made
-- the mistake."
--
-- ⚠️ THE RAW TAG, NOT A RESOLVED NAME. The tag is the fact Shopify holds; the
-- person it belongs to is a lookup that can change (someone is renamed, someone
-- leaves) and would be frozen wrong the moment it was written down. The panel
-- resolves it against `users` at read time and falls back to showing the tag
-- verbatim, which is still useful for a leaver nobody can match any more.
--
-- ⚠️ IT IS NOT A BLAME COLUMN, whatever the request that produced it. A title
-- written badly is usually a training gap, and the same name will appear beside
-- rows the tool got WRONG too — the denial notes prove that. It is here so a
-- pattern is visible, not so a row has a culprit.
--
-- Written by the sweep from the product's own tags. Null means either no sweep
-- has seen this row since this column existed, or no tag matched anybody — the
-- two are deliberately indistinguishable, because neither is an accusation.
--
-- See [[listing-titles-tool]] for the tool, and 0067 for the table.
-- ============================================================================

alter table public.listing_title_reviews
  add column if not exists lister_tag text;

comment on column public.listing_title_reviews.lister_tag is
  'The Shopify product tag that matched an employee (e.g. ''CMeadows''), verbatim. Resolved to a name at read time; never resolved on write.';
