-- ============================================================================
-- How many labels have been printed for a line, not merely whether any have.
--
-- 0047 recorded a timestamp, which answers "has this been printed" and nothing
-- else. That is not enough for what Ethan actually reported: raise a quantity-3
-- line to 6 and the line HAS been printed, so a timestamp says it is fine while
-- three units on the pallet carry no tag. It also left the print dialog
-- guessing -- he asked to "re-work print structure" for exactly this, because
-- printing more labels after adding quantity reprinted the whole line instead of
-- the shortfall, so you either wasted a sheet or hand-counted the difference.
--
-- With a count, all three fall out of one number: the shortfall is
-- quantity - label_printed_qty, the submit warning lists every line that has
-- one, and the print dialog defaults to it. The timestamp stays as the audit
-- half -- who printed last, and when.
--
-- ORDERING: additive, NOT NULL DEFAULT 0, no narrowing of anything that already
-- exists. Safe ahead of the code that reads it, unlike 0046.
-- ============================================================================

alter table public.b2b_deal_items
  add column if not exists label_printed_qty int not null default 0;

alter table public.b2b_deal_items
  drop constraint if exists b2b_deal_items_label_qty_sane;
alter table public.b2b_deal_items
  add constraint b2b_deal_items_label_qty_sane
  check (label_printed_qty >= 0);

-- Deliberately NOT `label_printed_qty <= quantity`. Reprinting a torn or lost
-- label is normal and must never be refused by the database, and a line whose
-- quantity is later revised DOWN would retroactively violate a constraint it
-- satisfied when it was written. The shortfall is clamped at zero where it is
-- computed, which is where a display rule belongs.
