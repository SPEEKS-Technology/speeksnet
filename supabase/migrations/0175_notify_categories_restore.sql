-- 0175 — let the Listing Health and Call Backs emails into notify_queue again.
--
-- Found 2026-11-05 while sending title rows back to the stores: every
-- "A title was sent back" email since listing-titles started queueing them
-- (31fcc20, deployed 2026-11-03) was refused by notify_queue_category_check.
-- The insert is best-effort, so the send-back landed and the mail silently didn't.
--
-- Why: 0148 (b2b_notification_rework, applied 2026-10-16 as "0141_...") rebuilt
-- this constraint from a list that predates 0057 ('categories') and 0066
-- ('listing_photos'), quietly dropping both. 0163 then added the Call Backs
-- switch (cat_callbacks) but never the 'callbacks' category, so callback-match's
-- mail has been refused the same way.
--
-- ⚠️ WHEN YOU ADD A CATEGORY, ADD IT HERE TOO, AND REBUILD FROM THE LIVE LIST
-- (pg_get_constraintdef), never from an older migration's copy.

alter table public.notify_queue drop constraint if exists notify_queue_category_check;
alter table public.notify_queue add constraint notify_queue_category_check
  check (category = any (array[
    'announcements', 'store_messages', 'requests', 'claims',
    'variance_aging', 'deadlines', 'scores', 'b2b',
    'categories', 'listing_photos', 'callbacks'
  ]));
