-- ============================================================================
-- 0066 — a ninth email toggle: Listings With No Pictures.
--
-- The no-pictures alarm from 0065 now has a feed card and an email, so it needs
-- its own switch in Settings → Notifications. Same shape as 0057; read that one
-- first for why prefs live here and why the default is true.
--
-- ⚠️ WHY THIS IS NOT FOLDED INTO cat_categories, even though both queues live on
-- the same Listing Health page:
--
--   · Different audience. `categories` is manager-and-above; this one includes
--     Assistant Managers, who already hold the tool (the ec-view-categories
--     override grants Listing Health to assistant manager) and who are usually
--     the ones holding the camera.
--   · Different urgency. A miscategorised listing is untidy; a listing with no
--     photo cannot be bought. Sharing one switch would mean muting the
--     tidiness nag also silences the one that costs a sale — the sort of
--     coupling nobody discovers until the revenue is already gone.
--
-- Default TRUE like the other eight. `enabled` is still the master switch and is
-- off until somebody deliberately turns email on, so defaulting true cannot mail
-- anyone who has not asked; it means "if you turn email on, you get this too".
--
-- ⚠️ wants() reads `p['cat_' + cat] === false`, so an ABSENT column already
-- behaves as "wanted" and the mail was going out before this migration existed.
-- The column is what lets somebody turn it OFF: the save handler in notify walks
-- CATEGORIES and writes cat_<name> for each, so without the column the popout
-- would draw a switch that silently refuses to stay off.
-- ============================================================================

alter table public.user_notify_prefs
  add column if not exists cat_listing_photos boolean not null default true;

comment on column public.user_notify_prefs.cat_listing_photos is
  'Listings With No Pictures — live on the online store with no photo at all (daily, per store). Should always be none.';
