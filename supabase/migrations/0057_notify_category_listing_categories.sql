-- ============================================================================
-- 0057 — an eighth email toggle: Listing Categories.
--
-- The Categories queue in SPEEKS Connect (listings with no category, or on a
-- shelf their own title disagrees with) now has a feed card for managers and,
-- with this, an entry in Settings → Notifications like every other alert.
--
-- Default TRUE, matching the other seven: `enabled` is the master switch and is
-- off until somebody turns email on deliberately, so a category defaulting true
-- cannot mail anybody who has not asked. What it means is "if you turn email on,
-- you get this too", which is the sensible full subscription.
--
-- The notify function is the authority on WHO sees the toggle (CATEGORY_ROLES)
-- and WHO gets the mail (the due entry's `for` predicate: the tool's default
-- roles — manager and owner-manager — so a Feature Access grant shows the site
-- card without signing somebody up for email). This column is only the on/off
-- bit; see 0033 for the shape and why prefs live here rather than on `users`.
-- ============================================================================

alter table public.user_notify_prefs
  add column if not exists cat_categories boolean not null default true;

comment on column public.user_notify_prefs.cat_categories is
  'Listing Categories — online-store listings with no category, or on a shelf that looks wrong (weekly, per store).';
