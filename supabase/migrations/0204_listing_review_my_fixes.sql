-- 0204 — My Fixes: a full-review send-back goes to the person who listed it
-- (Ethan, 2026-11-23).
--
-- "it should not only go to the manager to fix, but it should also go to that
-- respective team member … when a team member submits it saying, hey, I fixed
-- it, it should also remove from the manager side." One card, two viewers: the
-- store's list (manager / ASM) and the lister's My Fixes. Either one's I Fixed It
-- closes it for both.
--
-- assigned_to is the lister's SPEEKSNET name, set when the card is sent back,
-- from the Shopify tag (listing_listers) — only when that name is a real user at
-- the store. No tag, or a tag that is nobody's account (a temp such as SBuggs),
-- leaves it null and the card is the manager's alone. Notes Only is never
-- assigned: notes are for management.
--
-- assignee_seen_at is the first time the lister opened it, so the manager can
-- see "Seen 9:12am" while coaching.

alter table public.listing_review_cards      add column if not exists assigned_to text;
alter table public.listing_review_cards      add column if not exists assignee_seen_at timestamptz;
alter table public.listing_review_cards_test add column if not exists assigned_to text;
alter table public.listing_review_cards_test add column if not exists assignee_seen_at timestamptz;
