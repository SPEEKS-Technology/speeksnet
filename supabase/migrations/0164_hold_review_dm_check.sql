-- 0164 — every manager "resolved" is fact-checked; the DM settles the ones the
-- system disagrees with (Ethan, 2026-11-03: "make sure anytime a manager
-- resolves something, it gets fact checked and if the system disagrees, then DM
-- gets notified to confirm and take a deeper look and confirming then gets rid
-- of it from the sheet and denying needs a reason and goes back to manager with
-- the reason").
--
-- WHAT IS STORED AND WHAT IS NOT. Most of the fact check is worked out live by
-- claims-disputes (stateOf) from what the sites say today, so it can never go
-- stale: a dispute still needing a response, a card Shopify can still charge,
-- a mismatch the two sites still disagree on. Those columns are NOT here.
-- Only the two checks that cost an outside read are stored, because the tool
-- lists hundreds of items per open and cannot ask eBay and Shopify about each:
--   * eBay's payout records for the order (was the refund credited back?)
--   * Shopify's order (was the device restocked / is its variant in stock?)
-- Those land in fact_* when the resolution is saved and are re-read by the
-- sweep while the item waits on the DM, so a payback that lands later clears
-- it from the DM's list by itself.
--
-- THE DM'S WORD. dm_status is the DM's answer to a resolution the system
-- disagreed with: 'confirmed' (it stands — off the list for good) or 'denied'
-- (sent back: the item is due for the manager again with dm_note as the
-- reason). Any new manager write on the item clears all of these, because it is
-- a new resolution and gets checked afresh.
alter table public.hold_reviews
  add column if not exists fact_verdict    text,
  add column if not exists fact_why        text,
  add column if not exists fact_evidence   jsonb,
  add column if not exists fact_checked_at timestamptz,
  add column if not exists dm_status       text,
  add column if not exists dm_by           text,
  add column if not exists dm_note         text,
  add column if not exists dm_at           timestamptz;

alter table public.hold_reviews drop constraint if exists hold_reviews_fact_verdict_check;
alter table public.hold_reviews add constraint hold_reviews_fact_verdict_check
  check (fact_verdict is null or fact_verdict in ('agrees', 'disagrees'));
alter table public.hold_reviews drop constraint if exists hold_reviews_dm_status_check;
alter table public.hold_reviews add constraint hold_reviews_dm_status_check
  check (dm_status is null or dm_status in ('confirmed', 'denied'));
-- Sending one back needs a reason, the same 10 characters a resolution needs —
-- the manager has to be told what is wrong with it, not just that it is.
alter table public.hold_reviews drop constraint if exists hold_reviews_dm_denied_needs_reason;
alter table public.hold_reviews add constraint hold_reviews_dm_denied_needs_reason
  check (dm_status is distinct from 'denied' or length(btrim(coalesce(dm_note, ''))) >= 10);

-- The history line for each DM answer. (0112's lesson: the event table has its
-- OWN action check — widen it in the same migration or the first DM click throws.)
alter table public.hold_review_events drop constraint if exists hold_review_events_action_check;
alter table public.hold_review_events add constraint hold_review_events_action_check
  check (action in ('still_open', 'resolved', 'reopened', 'claim_linked', 'dm_confirmed', 'dm_sent_back'));
