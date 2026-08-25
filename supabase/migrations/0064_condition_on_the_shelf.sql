-- ============================================================================
-- 0064 — carry the CONDITION of a unit as far as the call back panel.
--
-- WHY IT WAS MISSING. Nothing in our own tables knew it. The matcher's only
-- notion of condition was `_broken`, a regex over the title, which is why a
-- MacBook Air titled "Bad LCD" was offered as healthy stock until 2026-08-24.
-- The real grade is in the product's description spec table — every PayMore
-- listing has a `Condition` row — and in a `condition` metafield beside it.
--
-- WHY THE DESCRIPTION TABLE AND NOT THE METAFIELD. `descriptionHtml` is a plain
-- scalar on Product, so it costs ZERO extra query points in the catalogue sweep;
-- only bytes, at PAGE=50 a page. Reading metafields means a connection per
-- product, which is the thing the sweep header warns about — the cost bucket
-- restores at 100/s and a full sweep already spends most of it. ebay-sync's
-- parseSpecs() already reads this table for eBay item specifics, so the parsing
-- is proven, not new.
--
-- TWO COLUMNS, ON PURPOSE. ebay_catalog.condition is the shelf's answer, and it
-- moves when the sweep re-reads the product. callback_matches.condition is what
-- was true when the match was made, so the panel can render a match without
-- joining the catalogue on every read — the same reasoning as `title` and
-- `price`, which are already copied onto the match row.
--
-- Nullable because it has to be: a product whose table has no Condition row
-- gives us nothing, and the panel says "Unknown Condition" rather than guessing.
-- ============================================================================

alter table ebay_catalog     add column if not exists condition text;
alter table callback_matches add column if not exists condition text;

comment on column ebay_catalog.condition is
  'Grade read from the Condition row of the product description spec table (New / Good / Fair / Broken / …). NULL when the listing has no such row.';
comment on column callback_matches.condition is
  'ebay_catalog.condition as it stood when this match was scored. Display only.';
