-- ============================================================================
-- 0163  Email notifications: a "Call Backs" category  (2026-11-03)
-- ----------------------------------------------------------------------------
-- callback-match now queues `callback_match` (category `callbacks`) when a sweep
-- finds a NEW pair: a customer on the call back list wants something a store has
-- in stock. One mail per holding store per sweep, to that store's people — the
-- same direction as the feed card. Employees are in, which no other store
-- category reaches: anyone on the floor can ring the customer.
--
-- Same reason as 0066 for the column: notify's save walks CATEGORIES and writes
-- cat_<name> for each, so without it the popout save would fail outright, and
-- with no row the default of true is what an absent column already meant.
--
-- The other three alerts added the same day need no column — they live as subs
-- inside existing categories (muted_kinds):
--   claim_review_reminder  -> claims      "Review Reminders From The DM"
--   title_sent_back        -> categories  "Titles Sent Back" (now "Listing Health")
--   purchase_verdict       -> requests    "Verdicts And Replies"
-- ============================================================================

alter table public.user_notify_prefs
  add column if not exists cat_callbacks boolean not null default true;

comment on column public.user_notify_prefs.cat_callbacks is
  'Call Backs — a customer on the call back list wants something this store has in stock (per sweep, per holding store).';
